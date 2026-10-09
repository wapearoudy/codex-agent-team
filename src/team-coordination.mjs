import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {DurableStore} from './durable-store.mjs';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now=()=>new Date().toISOString();
const enabledByPlan=data=>['0.13.0','0.14.0','0.15.0','0.16.0','0.17.0'].includes(data.team.requiresTeamWorkspaceVersion)&&data.team.planReview?.status==='approved'&&!data.team.dispatchPaused&&!['superseded','archived'].includes(data.team.state);
// Mechanical observations may wake the existing Leader. They never approve a
// review, launch a model, or convert a saved request into a native-tool receipt.
export function coordinationSignal(data){
  const {team,workflow}=data;
  if(['superseded','archived'].includes(team.state)||team.finalAcceptance||team.dispatchPaused||team.executionControl&&team.executionControl.status!=='active'||team.planReview?.scope==='initial'&&team.planReview.status!=='approved')return null;
  const actions=(workflow?.actions??[]).filter(a=>['settle','review-decision','claim-batch','final-validation'].includes(a.type));
  if(!actions.length)return null;
  const identity=[team.executionControl?.resumedAt??null,actions.map(a=>[a.type,a.taskId??null,a.attemptId??null,a.observedStatus??null,a.taskIds?.map(id=>{const t=team.tasks?.find(t=>t.id===id);return [id,t?.memberId??null,t?.attempts?.at(-1)?.id??null,t?.contractRevision??1];})??null])];
  return {fingerprint:digest(identity),actions,requiresLeader:true,automaticAcceptance:false};
}
export class TeamCoordination {
  constructor(root,{clock=Date.now,staleMs=60000}={}){this.store=new DurableStore(join(root,'coordination.json'),{teams:{}});this.clock=clock;this.staleMs=staleMs;}
  key(owner,id){return digest([owner,id]);}
  retryable(n){return ['failed','unknown'].includes(n.status)||n.status==='reserved'&&this.clock()-Date.parse(n.createdAt)>=this.staleMs;}
  async read(owner,data){const saved=(await this.store.read()).teams[this.key(owner,data.team.id)];return {enabled:data.team.state==='archived'?false:saved?.enabled??enabledByPlan(data),signal:coordinationSignal(data),notifications:(saved?.notifications??[]).slice(-10).map(n=>({...n,retryable:this.retryable(n)})),execution:'existing-native-Leader',delivery:'panel-message-bridge',requiresOpenPanel:true};}
  async enable(owner,data,enabled){if(data.team.state==='archived')throw new Error('Archived team is read-only');return this.store.transaction(d=>{const row=d.teams[this.key(owner,data.team.id)]??={notifications:[]};row.enabled=enabled;return {enabled};});}
  async reserve(owner,data,{retryId}={}){if(data.team.state==='archived')return {firstOffer:false,reason:'archived'};return this.store.transaction(d=>{
    const key=this.key(owner,data.team.id),row=d.teams[key]??={notifications:[]};
    if(row.enabled===undefined)row.enabled=enabledByPlan(data);
    if(!row.enabled)return {firstOffer:false,reason:'disabled'};
    const signal=coordinationSignal(data);if(!signal)return {firstOffer:false,reason:'no-action'};
    const prior=row.notifications.findLast(n=>n.fingerprint===signal.fingerprint);
    if(prior){
      if(!retryId)return {firstOffer:false,notification:prior};
      if(retryId!==prior.id||!this.retryable(prior))throw new Error('Only an explicitly selected failed/unknown or expired notification can be retried');
      prior.status='superseded';
    }else if(retryId)throw new Error('Workflow changed; refresh before retrying');
    const notification={id:randomUUID(),fingerprint:signal.fingerprint,status:'reserved',createdAt:new Date(this.clock()).toISOString(),actions:signal.actions.map(a=>({type:a.type,taskId:a.taskId,attemptId:a.attemptId,taskIds:a.taskIds}))};
    row.notifications.push(notification);row.notifications=row.notifications.slice(-100);
    return {firstOffer:true,notification,message:`TEAM_WORKSPACE_WORKFLOW:${notification.id}\nteamId=${data.team.id}. Read coordinate_team(operation=consume, notificationId=${notification.id}) before acting. Advance the current authorized workflow in one bounded batch, settle observed terminal attempts, dispatch ready work through native tools, and then yield. Independently validate review decisions; never auto-accept results, recreate members or busy-poll.`};
  });}
  async receipt(owner,id,{notificationId,status,note=''}){return this.store.transaction(d=>{
    const n=d.teams[this.key(owner,id)]?.notifications.find(n=>n.id===notificationId);
    if(!n||!['host-accepted','failed','unknown'].includes(status))throw new Error('Invalid workflow notification receipt');
    if(['consumed','superseded'].includes(n.status))return {notification:n};
    if(n.status!=='reserved'&&n.status!==status)throw new Error('Notification receipt already recorded');
    n.status=status;n.note=String(note).slice(0,1000);n.updatedAt=now();return {notification:n};
  });}
  async consume(owner,data,notificationId){return this.store.transaction(d=>{
    const n=d.teams[this.key(owner,data.team.id)]?.notifications.find(n=>n.id===notificationId);
    if(!n)throw new Error('Workflow notification not found');
    if(n.status==='consumed')return {replayed:true,actions:[],automaticAcceptance:false};
    const signal=coordinationSignal(data);
    if(n.status==='superseded'||!signal||signal.fingerprint!==n.fingerprint){n.status='superseded';return {stale:true,actions:[],automaticAcceptance:false};}
    n.status='consumed';n.consumedAt=now();return {actions:signal.actions,revision:data.team.revision,automaticAcceptance:false};
  });}
}
