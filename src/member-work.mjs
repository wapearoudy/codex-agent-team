import {planHash,assertDispatchAllowed} from './team-plan-review.mjs';
import {requireTeamVersion} from './team-version.mjs';
import {dispatchBlockers} from './team.mjs';
import {recordCheckpoint} from './team-checkpoints.mjs';
import {requestPhaseHandoff} from './task-phases.mjs';
export function assertMember(team,context){
  const member=team.members.find(m=>!m.removedAt&&m.agentThreadId===context.threadId);
  if(!member||context.cwd!==team.projectPath||context.parentThreadId!==team.leaderThreadId||team.state==='superseded')throw new Error('Only the authenticated active native member can access its own work');return member;
}
export function memberWork(team,context){
  const member=assertMember(team,context),hasTaskHistory=team.tasks.some(t=>t.attempts?.some(a=>(a.memberId??t.memberId)===member.id&&a.agentThreadId===context.threadId&&a.state!=='released'));
  return {kind:'member-work',teamId:team.id,revision:team.revision,memberId:member.id,dispatchPaused:team.dispatchPaused,executionStatus:team.executionControl?.status??'active',contextGeneration:member.contextGeneration??1,
    tasks:team.tasks.filter(t=>t.memberId===member.id&&!['accepted','cancelled'].includes(t.status)).slice(0,40).map(t=>{const blockers=dispatchBlockers(team,t);if(hasTaskHistory&&t.status!=='running')blockers.push({code:'task-context-isolation',message:'The Leader must dispatch new work in a clean task session'});return {taskId:t.id,title:t.title,status:t.status,attemptId:t.attempts.at(-1)?.id??null,ready:!blockers.length,blockers};}),
    nextAction:hasTaskHistory?'Report only your bound current attempt. After final delivery finish this turn; the Leader dispatches subsequent work in a clean task context. Final acceptance remains independent.':'Claim only your first assigned ready task, publicly emit its marker, then bind your current thread. Final acceptance remains independent.'};
}
export function memberClaimRequest(team,context,{taskId,requestId}){
  const member=assertMember(team,context);assertDispatchAllowed(team);
  if(!/^[0-9a-f-]{36}$/i.test(requestId??''))throw new Error('A stable UUID is required');
  const hash=planHash({taskId,memberId:member.id}),prior=team.memberClaims?.find(r=>r.requestId===requestId);
  if(prior&&prior.hash!==hash)throw new Error('Member claim request ID already has different contents');
  const task=team.tasks.find(t=>t.id===taskId);if(!task||task.memberId!==member.id)throw new Error('Members may claim only their own assigned tasks');
  if(task.status!=='running'&&team.tasks.some(t=>t.attempts?.some(a=>(a.memberId??t.memberId)===member.id&&a.agentThreadId===context.threadId&&a.state!=='released')))throw new Error('Task isolation requires the Leader to reserve a clean execution session; do not claim new work in a completed task context');
  if(prior&&task.attempts.at(-1)?.id!==prior.attemptId)throw new Error('Member claim refers to an old attempt');
  return {member,task,prior,hash};
}
export function memberReport(team,context,input){
  const member=assertMember(team,context),task=team.tasks.find(t=>t.id===input.taskId),a=task?.attempts.at(-1);
  if(!task||task.memberId!==member.id||task.status!=='running'||a?.id!==input.attemptId||a.agentThreadId!==context.threadId||!a.turnId)throw new Error('Only your bound current attempt may report progress');
  const reportHash=planHash({summary:input.summary,decisions:input.decisions??[],remainingWork:input.remainingWork??[],evidence:input.evidence??[],validation:input.validation??[],delivery:input.delivery??null,...(input.handoff?{handoff:true,verificationInputs:input.verificationInputs??[]}: {})});
  const existing=team.checkpoints?.find(c=>c.requestId===input.requestId?.toLowerCase());if(existing&&existing.source!=='authenticated-member')throw new Error('Checkpoint request belongs to another author');
  if(existing&&existing.reportHash!==reportHash)throw new Error('Member report request ID already has different contents');
  const checkpoint=recordCheckpoint(team,input,{source:'authenticated-member'});team.checkpoints.find(c=>c.id===checkpoint.id).reportHash=reportHash;
  requestPhaseHandoff(team,task,checkpoint,input);
  if(input.delivery!==undefined&&!existing){if(typeof input.delivery!=='string'||!input.delivery.trim()||input.delivery.length>24000)throw new Error('Delivery must contain 1–24000 characters');if(a.memberSubmission?.requestId===input.requestId&&a.memberSubmission.text!==input.delivery)throw new Error('Submission request ID has different contents');a.memberSubmission={requestId:input.requestId,text:input.delivery,at:new Date().toISOString(),source:'authenticated-member',status:'awaiting-native-terminal'};}
  requireTeamVersion(team,'0.12.0');return {kind:'member-report',checkpoint:{id:checkpoint.id,taskId:checkpoint.taskId,attemptId:checkpoint.attemptId,turnId:checkpoint.turnId,requestId:checkpoint.requestId,source:checkpoint.source},submissionStatus:a.memberSubmission?.status??null,...(input.handoff?{phaseHandoff:{status:'requested',finalReceipt:{kind:'phase-handoff',attemptMarker:a.marker,checkpointId:checkpoint.id},instruction:'Emit this exact JSON as your final public receipt and finish. The same task continues only after the Leader verifies the completed turn; this is not submission or acceptance.'}}:{}),acceptance:'Not accepted. Only a verified final delivery enters independent review.'};
}
