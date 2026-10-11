import {memberName} from './team-naming.mjs';
// Transport-agnostic native UI projection. Authentication stays in the MCP
// entrypoint; caller-provided team/session IDs never select the source team.
export function nativeTeamProjection(context,host,team,runs=[]){
  const projection={schemaVersion:1,source:'team-workspace-engine',observedAt:new Date().toISOString(),sessionId:context.threadId,host,team:null};
  if(!team)return projection;
  if(team.leaderThreadId!==context.threadId)throw new Error('Native projection requires the actual current Leader session');
  const members=team.members.filter(m=>!m.removedAt).map(m=>{
    const task=team.tasks.find(t=>t.memberId===m.id&&t.attempts?.at(-1)?.agentThreadId===m.agentThreadId),attempt=task?.attempts?.at(-1),observed=runs.find(r=>r.attemptId===attempt?.id);
    const verified=!!m.agentThreadId&&m.rosterVerified===true&&observed?.threadId===m.agentThreadId&&observed?.parentThreadId===team.leaderThreadId&&!!observed.turnId&&observed.turnId===attempt?.turnId&&!observed.error&&!observed.observationIssue&&!observed.observationError;
    return {id:m.id,name:memberName(team,m),role:m.role,nativeSessionId:verified?m.agentThreadId:null,bindingVerified:verified,status:observed?.status??m.status??'unknown'};
  });
  const tasks=team.tasks.filter(t=>!team.activeBatchId||t.batchId===team.activeBatchId).map(t=>({id:t.id,number:t.number??team.tasks.indexOf(t)+1,title:t.title,status:t.status,ownerMemberId:members.some(m=>m.id===t.memberId)?t.memberId:null,blockedBy:(t.dependencies??[]).filter(d=>{const upstream=team.tasks.find(t=>t.id===d.taskId);return d.when==='accepted'?upstream?.status!=='accepted':!['submitted','accepted'].includes(upstream?.status);}).map(d=>d.taskId)}));
  projection.team={id:team.id,revision:team.revision,goal:(team.goalBatches??team.batches)?.find(b=>b.id===team.activeBatchId)?.goal??team.goal,state:team.state,members,tasks};
  return projection;
}
