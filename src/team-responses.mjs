import {controlSummary} from './team-control.mjs';
import {planReviewSummary} from './team-plan-review.mjs';
import {createHash} from 'node:crypto';
import {panelResponse,panelTasks,stateRuns} from './panel-response.mjs';

const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));
const currentRuns=data=>data.runs.filter(r=>data.team.tasks.some(t=>t.id===r.taskId&&t.attempts.at(-1)?.id===r.attemptId));
export function detailToken(data){
  // Revision covers saved history. Only current public delivery/command changes need another full snapshot.
  return createHash('sha256').update(JSON.stringify([data.team.id,data.team.revision,currentRuns(data).map(r=>[r.taskId,r.attemptId,r.turnId,r.model,r.outputs,r.commands])])).digest('hex');
}
export function teamResponse(data,view='summary',kind='team-summary'){
  const token=detailToken(data);
  if(view==='full')return {...data,kind:'team-detail',detailToken:token};
  if(view==='panel')return panelResponse(data,token);
  const team=pick(data.team,['id','revision','mode','state','projectPath','leaderThreadId','dispatchPaused','totalDispatches','maxParallel','memberStartup','fixedRoster','archival','policy','profile']);
  team.coordinationSupported=['0.13.0','0.14.0','0.15.0','0.16.0','0.17.0'].includes(data.team.requiresTeamWorkspaceVersion);
  const taskRows=view==='summary'?data.team.tasks.filter(t=>!['accepted','cancelled'].includes(t.status)).concat(data.team.tasks.filter(t=>['accepted','cancelled'].includes(t.status)).slice(-20)):panelTasks(data.team.tasks);
  const numbers=new Map(data.team.tasks.map((t,i)=>[t.id,t.number??i+1]));
  const runs=stateRuns(currentRuns(data).filter(r=>taskRows.some(t=>t.id===r.taskId)));
  if(data.team.executionControl)team.executionControl=controlSummary(data.team);
  if(data.team.planReview)team.planReview=planReviewSummary(data.team);
  team.members=data.team.members.map(m=>pick(m,['id','role','responsibility','goalRevision','goalUpdatedAt','displayName','threadTitle','taskName','status','agentThreadId','agentPath','contextGeneration','rosterVerified','route','routeSnapshot','fallbackRoute','activeRoute','workspace','recoveryControl','removedAt']));
  team.tasks=taskRows.map(t=>({...pick(t,['id','title','kind','memberId','status','blockReason','dependencies','reviewOfTaskId','supersededBy','repairRootTaskId','repairRound','contractRevision']),stage:t.contract?.stage,number:numbers.get(t.id),attempt:t.attempts.at(-1)?pick(t.attempts.at(-1),['id','memberId','number','state','contextGeneration','contextBudget','agentThreadId','turnId','runtimeStatus','startedAt','endedAt']):null}));
  if(view==='state')return {kind:'team-state',team,runs,readiness:data.readiness?.filter(r=>taskRows.some(t=>t.id===r.taskId)),usage:data.usage?pick(data.usage,['totalTokens','knownAttempts','unknownAttempts','complete','members','limit','remaining','exhausted','unverifiable']):undefined,workflow:data.workflow,detailToken:token,observedAt:data.observedAt,observationMode:data.observationMode};
  const {team:unusedTeam,runs:unusedRuns,messages,checkpoints,...rest}=data;
  return {...rest,kind,team,runs,detailToken:token,
    ...(data.quality?{quality:{...pick(data.quality,['source','resolvedFindingCount','repairCount','scopeIsSandbox']),coverage:data.quality.coverage,openFindingCount:data.quality.openFindings.length,openFindings:data.quality.openFindings.slice(0,20).map(f=>pick(f,['id','rootTaskId','severity','status','description']))}}:{}),
    taskHistory:{total:data.team.tasks.length,included:taskRows.length,queryTool:'query_team_tasks'},
    readiness:(data.readiness??[]).filter(r=>taskRows.some(t=>t.id===r.taskId)),
    usage:data.usage?pick(data.usage,['source','totalTokens','knownAttempts','unknownAttempts','complete','members','limit','remaining','exhausted','unverifiable']):undefined,
    diagnostics:data.diagnostics?{source:data.diagnostics.source,stageCount:data.diagnostics.stages.length,unknown:data.diagnostics.unknown}:undefined,
    ...(data.checkpoint?{checkpoint:pick(data.checkpoint,['id','taskId','attemptId','requestId','source','createdAt'])}:{}),
    messages:(messages??[]).slice(-20).map(m=>pick(m,['id','taskId','attemptId','memberId','threadId','status','stale'])),
    checkpoints:(checkpoints??[]).slice(-20).map(c=>pick(c,['id','taskId','attemptId','stale','createdAt'])),
    evidenceAccess:{tool:'read_team',arguments:{teamId:team.id,view:'full'},handoffTool:'read_team_handoff'}};
}
