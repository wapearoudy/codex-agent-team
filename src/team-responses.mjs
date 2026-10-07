import {createHash} from 'node:crypto';

const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));
const runKeys=['taskId','memberId','attemptId','threadId','turnId','status','statusEvidence','observedAt','connection','source','attemptIdentitySource','model'];
const currentRuns=data=>data.runs.filter(r=>data.team.tasks.some(t=>t.id===r.taskId&&t.attempts.at(-1)?.id===r.attemptId));
function runState(run){return {...pick(run,runKeys),observationError:run.observationError??null};}
export function detailToken(data){
  // Revision covers saved history. Only current public delivery/command changes need another full snapshot.
  return createHash('sha256').update(JSON.stringify([data.team.id,data.team.revision,currentRuns(data).map(r=>[r.taskId,r.attemptId,r.turnId,r.model,r.outputs,r.commands])])).digest('hex');
}
export function teamResponse(data,view='summary',kind='team-summary'){
  const token=detailToken(data);
  if(view==='full')return {...data,kind:'team-detail',detailToken:token};
  const team=pick(data.team,['id','revision','mode','state','projectPath','leaderThreadId','dispatchPaused','totalDispatches','maxParallel','fixedRoster']);
  const runs=currentRuns(data).map(runState);
  team.members=data.team.members.map(m=>pick(m,['id','role','displayName','threadTitle','taskName','status','agentThreadId','agentPath','rosterVerified']));
  team.tasks=data.team.tasks.map(t=>({...pick(t,['id','title','kind','memberId','status','blockReason','dependencies','reviewOfTaskId']),attempt:t.attempts.at(-1)?pick(t.attempts.at(-1),['id','number','state','agentThreadId','turnId','runtimeStatus','startedAt','endedAt']):null}));
  if(view==='state')return {kind:'team-state',team,runs,readiness:data.readiness,detailToken:token,observedAt:data.observedAt,observationMode:data.observationMode};
  const {team:unusedTeam,runs:unusedRuns,messages,checkpoints,...rest}=data;
  return {...rest,kind,team,runs,detailToken:token,
    ...(data.checkpoint?{checkpoint:pick(data.checkpoint,['id','taskId','attemptId','requestId','source','createdAt'])}:{}),
    messages:(messages??[]).map(m=>pick(m,['id','taskId','attemptId','memberId','threadId','status','stale'])),
    checkpoints:(checkpoints??[]).map(c=>pick(c,['id','taskId','attemptId','stale','createdAt'])),
    evidenceAccess:{tool:'read_team',arguments:{teamId:team.id,view:'full'},handoffTool:'read_team_handoff'}};
}
