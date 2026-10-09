import {requireTeamVersion} from './team-version.mjs';

const terminal=new Set(['completed','failed','interrupted']);
export function lastMemberExecution(team,member){
  return team.tasks.flatMap(t=>(t.attempts??[]).filter(a=>(a.memberId??t.memberId)===member.id&&a.agentThreadId===member.agentThreadId&&a.state!=='released').map(a=>({taskId:t.id,attempt:a})))
    .sort((a,b)=>Date.parse(a.attempt.startedAt)-Date.parse(b.attempt.startedAt)).at(-1);
}
export function ownsNativeThread(team,memberId,threadId){
  return !!threadId&&(team.members.some(m=>m.id===memberId&&m.agentThreadId===threadId)||(team.contextHistory??[]).some(c=>c.memberId===memberId&&c.threadId===threadId));
}
export function retireTaskContext(team,member,observed){
  const last=lastMemberExecution(team,member);
  if(!last)return;
  if(team.tasks.some(t=>t.memberId===member.id&&t.status==='running')||!last.attempt.endedAt||!terminal.has(observed.status)||observed.threadId!==member.agentThreadId||observed.turnId!==last.attempt.turnId)
    throw new Error('Task context is not confirmed settled; preserve the original native attempt');
  const at=new Date().toISOString(),generation=member.contextGeneration??1;
  (team.contextHistory??=[]).push({memberId:member.id,generation,threadId:member.agentThreadId,agentPath:member.agentPath??null,taskId:last.taskId,attemptId:last.attempt.id,turnId:observed.turnId,status:observed.status,retiredAt:at,source:'host-observed-terminal',route:last.attempt.executedRoute??null});
  team.events.push({at,type:'task-context-retired',memberId:member.id,threadId:member.agentThreadId,attemptId:last.attempt.id,generation});
  member.contextGeneration=generation+1;member.agentThreadId=null;member.agentPath=null;member.rosterVerified=true;member.initializationTurnId=null;
  delete member.recoveryControl;delete member.stopObservation;delete member.initializationNeedsRetry;
  requireTeamVersion(team,'0.14.0');
}
export function assertFreshBinding(team,member,threadId){
  if((team.contextHistory??[]).some(c=>c.threadId===threadId))throw new Error('Retired task context cannot be reused; spawn the reserved clean native session with fork_turns=none');
  if(team.members.some(m=>m.id!==member.id&&m.agentThreadId===threadId))throw new Error('Different roles require distinct native members');
}
export function validateTaskContexts(team){
  if(team.contextHistory===undefined&&!team.tasks.some(t=>t.attempts?.some(a=>a.contextGeneration)))return;
  if(!['0.14.0','0.15.0','0.16.0','0.17.0'].includes(team.requiresTeamWorkspaceVersion))throw new Error('Task context isolation requires Team Workspace 0.14.0');
  const seen=new Set(team.members.filter(m=>m.agentThreadId).map(m=>m.agentThreadId));
  if(team.contextHistory!==undefined&&!Array.isArray(team.contextHistory))throw new Error('Invalid task context history');
  for(const c of team.contextHistory??[]){
    const member=team.members.find(m=>m.id===c.memberId),task=team.tasks.find(t=>t.id===c.taskId),a=task?.attempts.find(a=>a.id===c.attemptId);
    if(!member||!a||(a.memberId??task.memberId)!==member.id||a.agentThreadId!==c.threadId||a.turnId!==c.turnId||!a.endedAt||seen.has(c.threadId)||!Number.isInteger(c.generation)||c.generation<1||c.generation>=(member.contextGeneration??1)||!terminal.has(c.status)||!Number.isFinite(Date.parse(c.retiredAt))||c.source!=='host-observed-terminal')throw new Error('Invalid task context ownership history');
    seen.add(c.threadId);
  }
  for(const member of team.members){
    const generations=(team.contextHistory??[]).filter(c=>c.memberId===member.id).map(c=>c.generation).sort((a,b)=>a-b);
    if((member.contextGeneration??1)!==generations.length+1||generations.some((g,i)=>g!==i+1))throw new Error('Task context generations must retain a continuous ownership history');
  }
  for(const task of team.tasks)for(const a of task.attempts??[]){
    if(a.contextGeneration!==undefined&&(!Number.isInteger(a.contextGeneration)||a.contextGeneration<1))throw new Error('Invalid execution context generation');
    if(a.agentThreadId&&!ownsNativeThread(team,a.memberId??task.memberId,a.agentThreadId))throw new Error('Task attempt lost its native context ownership');
    if(a.agentThreadId&&a.contextGeneration){const m=team.members.find(m=>m.id===(a.memberId??task.memberId)),historical=team.contextHistory?.find(c=>c.threadId===a.agentThreadId);if(a.contextGeneration!==(historical?.generation??m?.contextGeneration??1))throw new Error('Attempt context generation does not match its native session');}
  }
}

// Full prompts, including fixed instructions and safety/quality contracts, are
// measured before committing a reservation. Only retrievable history is reduced.
export function boundedDispatchPrompt(render,handoff,limitChars){
  for(const [summaryChars,count,checkpointChars] of [[1600,3,1600],[500,1,500],[160,1,160],[0,0,0]]){
    const selected=structuredClone(handoff);
    selected.dependencies=selected.dependencies.map(d=>({...d,evidenceCount:d.evidence.length,evidence:(count?d.evidence.slice(-count):[]).map(e=>({source:e.source,attemptId:e.attemptId,summary:String(e.summary??'').slice(0,summaryChars)})),reference:{tool:'read_team_context',taskId:d.taskId,view:'full'},condensed:true}));
    if(selected.checkpoint){const c=selected.checkpoint;selected.checkpoint={id:c.id,taskId:c.taskId,attemptId:c.attemptId,stale:c.stale,source:c.source,summary:String(c.summary??'').slice(0,checkpointChars),reference:{tool:'read_team_context',taskId:handoff.taskId,view:'full'}};}
    const prompt=render(selected),chars=prompt.length;
    if(chars<=limitChars)return {prompt,contextBudget:{limitChars,chars,overBudget:false,source:'complete-dispatch-prompt',requiredFieldsPreserved:true,historyOnDemand:true}};
  }
  throw new Error(`Complete dispatch prompt exceeds the ${limitChars} character context budget. Required goal, acceptance and quality contracts were preserved. Simplify the task or explicitly raise its reviewed context budget; no task was dispatched.`);
}
