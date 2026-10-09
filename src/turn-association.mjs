import {requireTeamVersion} from './team-version.mjs';

const interrupted=row=>row.status==='interrupted'&&row.statusEvidence?.status==='interrupted'&&row.statusEvidence.source==='persisted-turn-aborted';
const ids=rows=>rows.map(row=>row.turnId);
function assertChain(run,marker,threadId){
  const rows=run.turnHistory,link=run.turnAssociation;
  if(!Array.isArray(rows)||rows.length<2||!link||link.type!=='interrupted-continuation'||link.marker!==marker||link.threadId!==threadId||run.threadId!==threadId||rows.at(-1).turnId!==run.turnId||new Set(ids(rows)).size!==rows.length||JSON.stringify(link.turnIds)!==JSON.stringify(ids(rows))||link.links?.length!==rows.length-1)throw new Error('Invalid native continuation association');
  for(const [i,row] of rows.entries()){
    if(!row.turnId||row.threadId!==threadId||row.source!=='native-thread-persisted-snapshot'||!Array.isArray(row.outputs)||!Array.isArray(row.commands)||!Number.isFinite(Date.parse(row.observedAt)))throw new Error('Invalid native continuation evidence');
    if(i<rows.length-1&&!interrupted(row))throw new Error('Continuation predecessor has no confirmed interruption');
    if(i&& (link.links[i-1].fromTurnId!==rows[i-1].turnId||link.links[i-1].toTurnId!==row.turnId||link.links[i-1].source!=='native-interrupted-continuation'))throw new Error('Invalid native continuation link');
  }
  return rows;
}
export function assertObservationTurn(attempt,run){
  if(attempt.agentThreadId&&attempt.agentThreadId!==run.threadId)throw new Error('Attempt/thread mismatch');
  const rows=run.turnHistory?assertChain(run,attempt.marker,run.threadId):null;
  if(attempt.turnId&&attempt.turnId!==run.turnId&&!rows?.some(row=>row.turnId===attempt.turnId))throw new Error('Attempt/turn mismatch');
  if(attempt.turnHistory){
    const before=ids(attempt.turnHistory),after=rows&&ids(rows);
    if(!after||before.some((id,i)=>id!==after[i]))throw new Error('Continuation history changed; preserve the original turn chain');
  }
}
// Mutation is explicit and revision fenced by TeamStore. Observing a chain alone
// never changes the current turn, accepts a delivery, or acknowledges messages.
export function associateTurn(team,task,run){
  const attempt=task.attempts.at(-1);assertObservationTurn(attempt,run);
  if(run.turnHistory){
    const previous=attempt.turnHistory??[],links=attempt.turnAssociation?.links??[],at=new Date().toISOString();
    attempt.turnHistory=run.turnHistory.map((row,i)=>i<previous.length-1?previous[i]:structuredClone(row));
    attempt.turnAssociation={...structuredClone(run.turnAssociation),links:run.turnAssociation.links.map((link,i)=>links[i]??{...link,linkedAt:at})};
    for(const link of attempt.turnAssociation.links.slice(links.length))team.events.push({at,type:'native-task-turn-continued',taskId:task.id,attemptId:attempt.id,threadId:run.threadId,...link});
    requireTeamVersion(team,'0.17.0');
  }
  attempt.turnId=run.turnId;attempt.observation=run;attempt.runtimeStatus=run.status;
}
export function validateTurnAssociations(team){
  for(const task of team.tasks)for(const attempt of task.attempts??[]){
    if(!attempt.turnHistory&&!attempt.turnAssociation)continue;
    if(team.requiresTeamWorkspaceVersion!=='0.17.0')throw new Error('Continuation history requires Team Workspace 0.17.0');
    assertChain({threadId:attempt.agentThreadId,turnId:attempt.turnId,turnHistory:attempt.turnHistory,turnAssociation:attempt.turnAssociation},attempt.marker,attempt.agentThreadId);
    if(attempt.turnAssociation.links.some(link=>!Number.isFinite(Date.parse(link.linkedAt))))throw new Error('Continuation link has no audit timestamp');
  }
}
export function attemptTurnIds(attempt){return attempt.turnHistory?ids(attempt.turnHistory):attempt.turnId?[attempt.turnId]:[];}
export function sumTurnUsage(rows){
  if(!rows.length||rows.some(row=>!Number.isSafeInteger(row.usage?.totalTokens)||row.usage.totalTokens<0))return null;
  return {totalTokens:rows.reduce((sum,row)=>sum+row.usage.totalTokens,0),source:'host-observed-continuation-turns',turnCount:rows.length};
}
