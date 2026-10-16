import {assertDispatchAllowed} from './team-plan-review.mjs';
import {assertFreshBinding} from './task-context.mjs';

// A reservation capability is not native identity. Both are mandatory; the
// caller's thread, parent, workspace, public marker and planned path are checked.
export function bootstrapStartInput(team,context,input){
  if((input.taskId===undefined)!==(input.attemptId===undefined))throw new Error('Provide both taskId/attemptId, or omit both using the exact compact bootstrap arguments');
  if(input.taskId!==undefined)return input;
  const matches=team.tasks.filter(task=>task.status==='running'&&task.attempts.at(-1)?.bootstrap?.token===input.bootstrapToken);
  if(matches.length!==1)throw new Error('Stale or invalid reserved bootstrap capability');
  const task=matches[0],resolved={...input,taskId:task.id,attemptId:task.attempts.at(-1).id};
  bootstrapReservation(team,context,resolved);
  return resolved;
}
export function bootstrapReportInput(team,context,input){
  if((input.taskId===undefined)!==(input.attemptId===undefined))throw new Error('Provide both taskId/attemptId, or omit both and use the supplied compact reportArguments');
  if(input.taskId!==undefined)return input; // Never silently repair explicit IDs.
  const matches=team.tasks.filter(task=>{
    const a=task.attempts.at(-1);
    return task.status==='running'&&a?.bootstrap?.token===input.bootstrapToken&&a.agentThreadId===context.threadId&&a.turnId&&a.bootstrapSource==='authenticated-member-native-observation';
  });
  if(matches.length!==1)throw new Error('No unique self-bound current attempt for this report capability; preserve the original native turn');
  const task=matches[0],resolved={...input,taskId:task.id,attemptId:task.attempts.at(-1).id};
  bootstrapReservation(team,context,resolved,{requireDispatch:false});
  return resolved;
}
export function bootstrapReservation(team,context,input,{requireDispatch=true}={}){
  if(requireDispatch){assertDispatchAllowed(team);if(team.dispatchPaused||team.executionControl&&team.executionControl.status!=='active'||['stopping','halted','archived','delivered'].includes(team.state))throw new Error('Bootstrap dispatch is paused; preserve the existing reservation');}
  const task=team.tasks.find(t=>t.id===input.taskId),attempt=task?.attempts.at(-1),member=team.members.find(m=>m.id===task?.memberId&&!m.removedAt);
  if(context.threadId===team.leaderThreadId||context.parentThreadId!==team.leaderThreadId||context.cwd!==team.projectPath||team.state==='superseded')throw new Error('Bootstrap requires the authenticated native child of this project Leader');
  if(!member||task.status!=='running'||attempt?.id!==input.attemptId||!attempt.bootstrap||attempt.bootstrap.attemptId&&attempt.bootstrap.attemptId!==attempt.id||attempt.bootstrap.token!==input.bootstrapToken||attempt.bootstrap.contractRevision!==(task.contractRevision??1))throw new Error('Stale or invalid reserved bootstrap capability');
  if(member.agentThreadId&&member.agentThreadId!==context.threadId||attempt.agentThreadId&&attempt.agentThreadId!==context.threadId)throw new Error('Bootstrap cannot replace an existing native member');
  assertFreshBinding(team,member,context.threadId);
  return {task,attempt,member};
}

export function assertBootstrapObservation(team,context,input,run){
  const {attempt,member}=bootstrapReservation(team,context,input);
  if(run.threadId!==context.threadId||!run.turnId||run.status!=='inProgress'||run.latestTurnId&&run.latestTurnId!==run.turnId)throw new Error('Bootstrap requires this exact public marker in the current active native turn; keep the same turn and retry');
  const expected=member.agentPath??attempt.bootstrap.agentPath;
  if(expected?run.agentPath!==expected:!run.agentPath?.endsWith('/'+attempt.bootstrap.taskName))throw new Error('Bootstrap native path does not match the reserved member');
  if(attempt.turnId&&attempt.turnId!==run.turnId)throw new Error('Bootstrap cannot replace a bound native turn; reconcile its interruption first');
}
