import {randomUUID} from 'node:crypto';
import {planHash} from './team-plan-review.mjs';
import {requireTeamVersion} from './team-version.mjs';
const now=()=>new Date().toISOString();
export function controlRequest(team,action,input){
  if(['superseded','archived'].includes(team.state))throw new Error('Historical team is read-only');
  if(!/^[0-9a-f-]{36}$/i.test(input.requestId??'')||!input.reason?.trim())throw new Error('A stable UUID and a non-empty reason are required');
  const hash=planHash({action,reason:input.reason,retryTaskIds:input.retryTaskIds??[]});
  const saved=team.controlHistory?.find(r=>r.requestId===input.requestId);
  if(saved&&saved.hash!==hash)throw new Error('Control request ID already has different contents');
  return {hash,saved};
}
function record(team,action,input,hash){team.controlHistory??=[];team.controlHistory.push({action,requestId:input.requestId,reason:input.reason,hash,at:now()});team.controlHistory=team.controlHistory.slice(-200);requireTeamVersion(team,'0.12.0');}
export function stopTargets(team){
  return [...team.members.filter(m=>!m.removedAt&&m.agentThreadId).map(m=>({memberId:m.id,threadId:m.agentThreadId,agentPath:m.agentPath??null,initialization:!m.rosterVerified,...(()=>{const t=team.tasks.find(t=>t.memberId===m.id&&t.status==='running');return t?{taskId:t.id,attemptId:t.attempts.at(-1)?.id}:{};})()})),...team.tasks.filter(t=>t.status==='running'&&!t.attempts.at(-1)?.agentThreadId).map(t=>({taskId:t.id,memberId:t.memberId,attemptId:t.attempts.at(-1).id,threadId:null,action:'verify-host-before-bind-or-release'}))];
}
export function requestStop(team,input={reason:'Leader requested a stop; verify all native turns',requestId:randomUUID()}){
  const {hash,saved}=controlRequest(team,'stop',input);if(saved)return;
  team.dispatchPaused=true;team.executionControl={status:'stopping',previousState:team.state,requestId:input.requestId,reason:input.reason,requestedAt:now()};team.state='stopping';record(team,'stop',input,hash);
}
export function resumeTeam(team,input){
  const {hash,saved}=controlRequest(team,'resume',input);if(saved)return;
  if(team.executionControl?.status!=='halted')throw new Error('Confirm every native turn stopped before resuming');
  if(team.planReview?.scope==='initial'&&team.planReview.status!=='approved')throw new Error('Approve the pending plan before resuming');
  if(team.executionControl.previousState==='delivered'&&team.tasks.every(t=>['accepted','cancelled'].includes(t.status)))throw new Error('Delivered team requires new work before resuming');
  for(const id of input.retryTaskIds??[]){const t=team.tasks.find(t=>t.id===id),a=t?.attempts.at(-1);if(!t||t.status!=='blocked'||!a||!['stopped','failed','interrupted'].includes(a.state))throw new Error('Only explicitly selected stopped/failed tasks can be retried');t.status='waiting';t.blockReason=null;t.updatedAt=now();}
  for(const m of team.members.filter(m=>!m.removedAt&&m.agentThreadId&&!m.rosterVerified&&m.stopObservation)){(m.initializationHistory??=[]).push({marker:m.rosterMarker,turnId:m.initializationTurnId??m.stopObservation.turnId,status:m.stopObservation.status,at:now()});m.rosterMarker=`TEAM_WORKSPACE_MEMBER:${randomUUID()}`;m.initializationNeedsRetry=true;m.initializationTurnId=null;}
  team.executionControl={...team.executionControl,status:'active',resumedAt:now(),resumeReason:input.reason};team.dispatchPaused=false;team.state='active';record(team,'resume',input,hash);
}
export function validateControl(team){
  if(team.memberStartup!==undefined&&!['on-demand','eager'].includes(team.memberStartup))throw new Error('Invalid member startup mode');
  if(team.executionControl&&(!['active','stopping','halted'].includes(team.executionControl.status)||!team.executionControl.reason||team.executionControl.status!=='active'&&!team.dispatchPaused))throw new Error('Invalid team stop state');
  if((team.executionControl||team.memberStartup||team.tasks.some(t=>t.contractRevision))&&!['0.12.0','0.13.0','0.14.0','0.15.0','0.16.0','0.17.0','0.18.0','0.21.0','0.24.0','0.29.0','0.30.0','0.31.0','0.32.0'].includes(team.requiresTeamWorkspaceVersion))throw new Error('New lifecycle records require Team Workspace 0.12.0');
}

export function controlSummary(team){const c=team.executionControl;if(!c)return undefined;return {...Object.fromEntries(['status','requestId','requestedAt','previousState','observedAt','stoppedAt','resumedAt'].filter(k=>c[k]!==undefined).map(k=>[k,c[k]])),reason:String(c.reason??'').slice(0,2000),...(c.resumeReason?{resumeReason:String(c.resumeReason).slice(0,2000)}:{}),pending:(c.pending??[]).slice(0,16).map(p=>({memberId:p.memberId,taskId:p.taskId,reason:String(p.reason??'').slice(0,240)}))};}
