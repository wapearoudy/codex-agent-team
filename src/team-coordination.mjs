import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {DurableStore} from './durable-store.mjs';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now=()=>new Date().toISOString();
// Native completions/messages carry coordination. Saved panel actions are read
// by the existing Leader; they never become synthetic user chat messages.
export function coordinationSignal(data){
  const {team,workflow}=data;
  if(['superseded','archived'].includes(team.state)||team.finalAcceptance||team.dispatchPaused||team.executionControl&&team.executionControl.status!=='active'||team.planReview?.scope==='initial'&&team.planReview.status!=='approved')return null;
  const actions=(workflow?.actions??[]).filter(a=>['plan-tasks','settle','review-decision','claim-batch','final-validation'].includes(a.type));
  if(!actions.length)return null;
  const identity=[team.planReview?.hash??null,team.executionControl?.resumedAt??null,actions.map(a=>[a.type,a.taskId??null,a.attemptId??null,a.observedStatus??null,a.taskIds?.map(id=>{const t=team.tasks?.find(t=>t.id===id);return [id,t?.memberId??null,t?.attempts?.at(-1)?.id??null,t?.contractRevision??1];})??null])];
  return {fingerprint:digest(identity),actions,requiresLeader:true,automaticAcceptance:false};
}
export class TeamCoordination {
  constructor(root){this.store=new DurableStore(join(root,'coordination.json'),{teams:{}});}
  key(owner,id){return digest([owner,id]);}
  async read(owner,data){const saved=(await this.store.read()).teams[this.key(owner,data.team.id)];return {enabled:false,signal:coordinationSignal(data),notifications:(saved?.notifications??[]).slice(-10).map(n=>({...n,retryable:false,legacy:true})),execution:'existing-native-Leader',delivery:'native-agent-messages',chatMessages:false,requiresOpenPanel:false,panelWakeWithoutWaiter:false,waitTool:'wait_team_event'};}
  async enable(owner,data,enabled){if(data.team.state==='archived')throw new Error('Archived team is read-only');return {enabled:false,reason:'native-internal-only',chatMessages:false};}
  // Retain the old operation so already-loaded panels cannot obtain another
  // outgoing message. Old saved offers remain historical evidence only.
  async reserve(owner,data){return {firstOffer:false,reason:data.team.state==='archived'?'archived':'native-internal-only',delivery:'native-agent-messages',chatMessages:false};}
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
    n.status='superseded';return {stale:true,reason:'chat-bridge-disabled',actions:[],automaticAcceptance:false};
  });}
}
