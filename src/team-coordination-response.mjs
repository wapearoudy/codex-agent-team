import {createHash} from 'node:crypto';
import {registrationGap} from './registration-gap.mjs';
import {coordinationSignature} from './team-efficiency.mjs';

const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));
export const COORDINATION_MAX_BYTES=6000;
export function coordinationResponse(data,{cursor}={}){
  const t=data.team,currentRuns=(data.runs??[]).filter(r=>t.tasks.some(task=>task.id===r.taskId&&task.attempts.at(-1)?.id===r.attemptId));
  const pending=(t.peerMessages??[]).filter(m=>m.recipientThreadId===t.leaderThreadId&&m.status!=='acknowledged'&&m.kind!=='progress'),gap=registrationGap(data.usage);
  const actions=(data.workflow?.actions??[]).map(a=>({...pick(a,['type','taskId','attemptId','taskIds','observedStatus','proposedDecision','requiresLeaderValidation','requiresUserConfirmation','requiresNativeInterrupt','requiresLeaderEvidence','version','hash','tool']),...(a.reason?{reason:a.reason.slice(0,1000)}:{}),...(a.reusableEvidence?{reusableEvidence:a.reusableEvidence.slice(0,8),hasMoreEvidence:a.reusableEvidence.length>8}:{})}));
  // Public progress, usage ticks, timestamps and logs do not invalidate this
  // coordination cursor. Business signatures catch controls, contracts and inbox.
  const nextCursor=createHash('sha256').update(JSON.stringify([coordinationSignature(t),actions,currentRuns.map(r=>[r.taskId,r.attemptId,r.turnId,['completed','failed','interrupted'].includes(r.status)?r.status:'active-or-unconfirmed',r.observationIssue?.kind==='verification-failed'?'verification-failed':null]),pending.map(m=>[m.id,m.status]),data.usage?.exhausted,data.usage?.unverifiable,gap&&[gap.count,gap.threadIds]])).digest('hex');
  if(cursor===nextCursor)return {kind:'team-unchanged',teamId:t.id,revision:t.revision,cursor:nextCursor,unchanged:true,nextTool:'wait_team_event',readInbox:false};
  const counts={};for(const task of t.tasks)counts[task.status]=(counts[task.status]??0)+1;
  const result={kind:'team-coordination-state',teamId:t.id,revision:t.revision,cursor:nextCursor,state:t.state,control:t.executionControl?.status??'active',stage:data.workflow?.stage,counts,actions:actions.slice(0,8),hasMoreActions:actions.length>8,
    running:currentRuns.filter(r=>t.tasks.find(task=>task.id===r.taskId)?.status==='running').slice(0,8).map(r=>pick(r,['taskId','attemptId','threadId','turnId','status'])),inbox:{pending:pending.length,readRequired:pending.length>0,tool:'consume_team_inbox'},
    usage:pick(data.usage,['totalTokens','leaderTokens','unregisteredNativeCount','cachedInputTokens','uncachedInputTokens','outputTokens','cacheRatio','complete','limit','remaining','exhausted','unverifiable','scope']),...(gap?{registrationGap:gap}:{}),automaticAcceptance:true,evidenceAccess:{tool:'read_team_context',note:'Ordinary independent reviews are registered by plugin gates. Read selected evidence only for an exception or final closure; reuse valid evidence without repeating review or tests'},nextTool:actions.length?'team_leader':'wait_team_event'};
  if(Buffer.byteLength(JSON.stringify(result))>COORDINATION_MAX_BYTES){result.actions=result.actions.slice(0,4).map(a=>({...a,...(a.reason?{reason:a.reason.slice(0,400)}:{}),...(a.reusableEvidence?{reusableEvidence:a.reusableEvidence.slice(0,2),hasMoreEvidence:a.hasMoreEvidence||a.reusableEvidence.length>2}:{})}));result.running=result.running.slice(0,4);result.hasMoreActions=true;result.truncated=true;}
  return result;
}
