import {createHash} from 'node:crypto';
import {registrationGap} from './registration-gap.mjs';
import {coordinationSignature} from './team-efficiency.mjs';
import {completionReceipt} from './team-completion.mjs';

const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));
export const COORDINATION_MAX_BYTES=6000;
export const requiresLeaderAction=actions=>actions.some(a=>['execute-in-leader','startup-failed','settlement-exception','review-exception','reconcile-review','plan-repair','review-round-limit','accept-light-delivery','dispatch-paused'].includes(a.type)||a.type==='verify-before-binding'&&a.requiresLeaderValidation);
export function coordinationResponse(data,{cursor}={}){
  const t=data.team,currentRuns=(data.runs??[]).filter(r=>t.tasks.some(task=>task.id===r.taskId&&task.attempts.at(-1)?.id===r.attemptId));
  const pending=(t.peerMessages??[]).filter(m=>m.recipientThreadId===t.leaderThreadId&&m.status!=='acknowledged'&&m.kind!=='progress'),gapCandidate=registrationGap(data.usage),gap=gapCandidate?.count?gapCandidate:null;
  const actions=(data.workflow?.actions??[]).map(a=>({...pick(a,['type','batchId','taskId','attemptId','taskIds','observedStatus','proposedDecision','requiresLeaderValidation','requiresUserConfirmation','requiresNativeInterrupt','requiresLeaderEvidence','version','hash','tool','recoveryArguments']),...(a.reason?{reason:a.reason.slice(0,1000)}:{}),...(a.instruction?{instruction:a.instruction.slice(0,1000)}:{}),...(a.type==='final-validation'&&a.finalizationArguments?{finalizationArguments:pick(a.finalizationArguments,['teamId','revision','batchId','note','reuseEvidence'])}:{}),...(a.reusableEvidence?{reusableEvidence:a.reusableEvidence.slice(0,8),hasMoreEvidence:a.reusableEvidence.length>8}:{})}));
  // Public progress, usage ticks, timestamps and logs do not invalidate this
  // coordination cursor. Business signatures catch controls, contracts and inbox.
  const budgetBlocked=data.usage?.exhausted===true||data.usage?.unverifiable===true;
  const nextCursor=createHash('sha256').update(JSON.stringify([coordinationSignature(t),actions,currentRuns.map(r=>[r.taskId,r.attemptId,r.turnId,['completed','failed','interrupted'].includes(r.status)?r.status:'active-or-unconfirmed',r.observationIssue?.kind==='verification-failed'?'verification-failed':null]),pending.map(m=>[m.id,m.status]),data.usage?.exhausted,data.usage?.unverifiable,data.workflow?.startupBlockers,gap&&[gap.count,gap.threadIds]])).digest('hex');
  if(cursor===nextCursor&&!data.workflow?.waitBlocked&&!budgetBlocked&&!requiresLeaderAction(actions))return {kind:'team-unchanged',teamId:t.id,revision:t.revision,cursor:nextCursor,unchanged:true,nextTool:'team_leader',nextOperation:'next_team_step',wait:true,readInbox:false};
  const counts={};for(const task of t.tasks.filter(task=>!t.activeBatchId||task.batchId===t.activeBatchId))counts[task.status]=(counts[task.status]??0)+1;
  const result={kind:'team-coordination-state',teamId:t.id,revision:t.revision,cursor:nextCursor,state:t.state,...(t.activeBatchId?{activeBatchId:t.activeBatchId}:{}),control:t.executionControl?.status??'active',stage:data.workflow?.stage,...(data.workflow?.startupBlockers?.length?{startupBlockers:data.workflow.startupBlockers}:{}),counts,actions:actions.slice(0,8),hasMoreActions:actions.length>8,briefAccess:{tool:'manage_team',operation:'leader-brief',teamId:t.id},
    running:currentRuns.filter(r=>t.tasks.find(task=>task.id===r.taskId)?.status==='running').slice(0,8).map(r=>pick(r,['taskId','attemptId','threadId','turnId','status'])),inbox:{pending:pending.length,readRequired:pending.length>0,tool:'consume_team_inbox'},
    usage:pick(data.usage,['totalTokens','leaderTokens','unregisteredNativeCount','cachedInputTokens','uncachedInputTokens','outputTokens','cacheRatio','complete','limit','remaining','exhausted','unverifiable','scope']),...(gap?{registrationGap:gap}:{}),automaticAcceptance:true,evidenceAccess:{tool:'read_team_context',note:'Ordinary independent reviews are registered by plugin gates. Read selected evidence only for an exception or final closure; reuse valid evidence without repeating review or tests'},nextTool:'team_leader'};
  if(Buffer.byteLength(JSON.stringify(result))>COORDINATION_MAX_BYTES){result.actions=result.actions.slice(0,4).map(a=>({...a,...(a.reason?{reason:a.reason.slice(0,400)}:{}),...(a.reusableEvidence?{reusableEvidence:a.reusableEvidence.slice(0,2),hasMoreEvidence:a.hasMoreEvidence||a.reusableEvidence.length>2}:{})}));result.running=result.running.slice(0,4);result.hasMoreActions=true;result.truncated=true;}
  // Keep executable closure arguments when bounding new instructions. Full
  // evidence remains saved, and hasMoreActions signals omitted actions.
  if(Buffer.byteLength(JSON.stringify(result))>COORDINATION_MAX_BYTES){
    result.actions=result.actions.map(a=>{const {reusableEvidence,...rest}=a;return {...rest,...(reusableEvidence?{hasMoreEvidence:reusableEvidence.length>0||a.hasMoreEvidence}: {})};});
    while(result.actions.length>1&&Buffer.byteLength(JSON.stringify(result))>COORDINATION_MAX_BYTES)result.actions.pop();
  }
  if(requiresLeaderAction(actions)){result.requiresLeaderAction=true;result.nextTool='team_leader';result.nextAction='resolve-exception';result.instruction='Handle the explicit saved action once using its task/attempt and existing evidence. Do not repeat next_team_step waits on unchanged rejected evidence or redo successful work.';}
  if(data.workflow?.waitBlocked){result.waitBlocked=true;result.nextTool=null;result.nextAction='resolve-startup';result.instruction='Resolve the explicit startup blocker once; do not poll, spawn replacement members or close unfinished tasks.';}
  if(data.workflow?.idleBlockers?.length){result.waitBlocked=true;result.nextTool=null;result.nextAction='resolve-workflow-blocker';result.workflowBlockers=data.workflow.idleBlockers.slice(0,4);result.hasMoreWorkflowBlockers=data.workflow.idleBlockers.length>4;result.instruction='No native work or ready transition can advance this goal. Resolve the explicit saved blockers once and end this Leader turn; do not wait, recreate members, infer completion or rerun valid tests for registration. Existing deliveries and history are retained.';}
  if(result.workflowBlockers&&Buffer.byteLength(JSON.stringify(result))>COORDINATION_MAX_BYTES){result.workflowBlockers=result.workflowBlockers.slice(0,2).map(b=>({...b,reasons:b.reasons.slice(0,4).map(r=>({...r,message:r.message.slice(0,240)})),message:b.message.slice(0,240)}));result.hasMoreWorkflowBlockers=true;}
  if(actions.some(a=>a.type==='review-round-limit')){result.waitBlocked=true;result.requiresUserDecision=true;result.nextTool=null;result.nextAction='review-round-limit';result.instruction='The saved independent review is registered; the authorized repair-round budget is exhausted. Present the exact task and limit once for a policy/budget decision, preserving unfinished state and all evidence. Do not wait, call plan_team_repair, look for a different owner or rerun work at this unchanged limit.';}
  if(budgetBlocked){
    result.waitBlocked=true;result.nextTool=null;result.nextAction='token-budget-limit';
    const activeNativeWork=currentRuns.filter(r=>r.threadId!==t.leaderThreadId&&t.tasks.find(task=>task.id===r.taskId)?.status==='running'&&!['completed','failed','interrupted'].includes(r.status));
    result.budgetBlocker={reason:data.usage.exhausted?'exhausted':'unverifiable',...pick(data.usage,['limit','totalTokens','complete']),activeNativeWork:activeNativeWork.slice(0,4).map(r=>pick(r,['taskId','attemptId','threadId','turnId','status'])),hasMoreActiveNativeWork:activeNativeWork.length>4};
    result.instruction='The saved token budget blocks further dispatch. End the current Leader turn with this exact blocker and unfinished state; never retry waits, raise limits, start replacements or claim acceptance. Already active native members retain their work and evidence; this receipt does not interrupt them or invent terminal status. Process a real terminal event or an explicitly authorized budget change separately.';
  }
  if(['delivered','archived','superseded'].includes(t.state)||data.workflow?.stage==='completed'){
    result.terminal=true;result.nextTool=null;result.nextAction='return-result';
    const completion=completionReceipt(t);
    if(completion){
      // Final user reporting needs this exact bounded receipt, not another full
      // model-visible state/history export. Detailed evidence stays on disk.
      return {kind:result.kind,teamId:t.id,revision:t.revision,state:t.state,stage:result.stage,terminal:true,nextTool:null,nextAction:'return-result',counts,completion};
    }
  }
  if(budgetBlocked&&Buffer.byteLength(JSON.stringify(result))>COORDINATION_MAX_BYTES){result.actions=[];result.hasMoreActions=actions.length>0;result.truncated=true;}
  if(!result.terminal&&!result.waitBlocked&&!result.requiresLeaderAction&&!actions.length){result.nextAction='wait';result.waitCall={tool:'team_leader',arguments:{operation:'next_team_step',arguments:{teamId:t.id,revision:t.revision,waitCursor:coordinationSignature(t),wait:true,timeoutMs:55000,dispatchReady:true,dispatchView:'reference'}}};}
  return result;
}
