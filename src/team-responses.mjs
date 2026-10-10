import {controlSummary} from './team-control.mjs';
import {planReviewSummary} from './team-plan-review.mjs';
import {createHash} from 'node:crypto';
import {panelResponse,panelTasks,stateRuns} from './panel-response.mjs';
import {coordinationResponse} from './team-coordination-response.mjs';
import {registrationGap} from './registration-gap.mjs';

const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));
const currentRuns=data=>data.runs.filter(r=>data.team.tasks.some(t=>t.id===r.taskId&&t.attempts.at(-1)?.id===r.attemptId));
export function detailToken(data){
  // Revision covers saved history. Only current public delivery/command changes need another full snapshot.
  // Hash each public row separately instead of allocating one copy of all logs
  // on every panel tick. Activity/usage alone still does not fetch history.
  const hash=createHash('sha256').update(JSON.stringify([data.team.id,data.team.revision]));
  for(const r of currentRuns(data)){
    hash.update(JSON.stringify([r.taskId,r.attemptId,r.turnId,r.model,r.outputs?.length??0,r.commands?.length??0]));
    for(const output of r.outputs??[])hash.update(JSON.stringify(output));
    for(const command of r.commands??[])hash.update(JSON.stringify(command));
  }
  return hash.digest('hex');
}
export function teamResponse(data,view='summary',kind='team-summary',options={}){
  if(view==='coordination')return coordinationResponse(data,options);
  const token=detailToken(data),gap=registrationGap(data.usage);
  if(view==='full')return {...data,kind:'team-detail',detailToken:token};
  if(view==='panel')return panelResponse(data,token);
  const team=pick(data.team,['id','revision','mode','state','projectPath','leaderThreadId','dispatchPaused','totalDispatches','maxParallel','memberStartup','taskPlanning','fixedRoster','archival','policy','profile']);
  team.coordinationSupported=['0.13.0','0.14.0','0.15.0','0.16.0','0.17.0','0.18.0','0.21.0','0.24.0','0.29.0','0.30.0','0.31.0'].includes(data.team.requiresTeamWorkspaceVersion);
  const taskRows=view==='summary'?data.team.tasks.filter(t=>!['accepted','cancelled'].includes(t.status)).concat(data.team.tasks.filter(t=>['accepted','cancelled'].includes(t.status)).slice(-20)):panelTasks(data.team.tasks);
  const numbers=new Map(data.team.tasks.map((t,i)=>[t.id,t.number??i+1]));
  const runs=stateRuns(currentRuns(data).filter(r=>taskRows.some(t=>t.id===r.taskId)));
  if(data.team.executionControl)team.executionControl=controlSummary(data.team);
  if(data.team.planReview)team.planReview=planReviewSummary(data.team);
  team.members=data.team.members.map(m=>pick(m,['id','role','responsibility','goalRevision','goalUpdatedAt','displayName','threadTitle','taskName','status','agentThreadId','agentPath','contextGeneration','rosterVerified','route','routeSnapshot','fallbackRoute','activeRoute','workspace','recoveryControl','removedAt']));
  team.tasks=taskRows.map(t=>({...pick(t,['id','title','kind','memberId','status','blockReason','dependencies','reviewOfTaskId','supersededBy','repairRootTaskId','repairRound','contractRevision']),stage:t.contract?.stage,number:numbers.get(t.id),attempt:t.attempts.at(-1)?pick(t.attempts.at(-1),['id','memberId','number','state','contextGeneration','contextBudget','agentThreadId','turnId','runtimeStatus','startedAt','endedAt','acceptance','acceptanceException']):null}));
  if(view==='state')return {kind:'team-state',team,runs,registrationGap:gap,readiness:data.readiness?.filter(r=>taskRows.some(t=>t.id===r.taskId)),usage:data.usage?pick(data.usage,['totalTokens','leaderTokens','unregisteredNativeTokens','unregisteredNativeCount','inputTokens','cachedInputTokens','uncachedInputTokens','cacheRatio','outputTokens','scope','accountingComplete','observedAt','knownAttempts','unknownAttempts','complete','members','limit','remaining','exhausted','unverifiable']):undefined,workflow:data.workflow,detailToken:token,observedAt:data.observedAt,observationMode:data.observationMode};
  const {team:unusedTeam,runs:unusedRuns,messages,checkpoints,...rest}=data;
  return {...rest,kind,team,runs,detailToken:token,
    ...(data.quality?{quality:{...pick(data.quality,['source','resolvedFindingCount','repairCount','scopeIsSandbox']),coverage:data.quality.coverage,openFindingCount:data.quality.openFindings.length,openFindings:data.quality.openFindings.slice(0,20).map(f=>pick(f,['id','rootTaskId','severity','status','description']))}}:{}),
    taskHistory:{total:data.team.tasks.length,included:taskRows.length,queryTool:'query_team_tasks'},
    readiness:(data.readiness??[]).filter(r=>taskRows.some(t=>t.id===r.taskId)),
    registrationGap:gap,usage:data.usage?pick(data.usage,['source','totalTokens','leaderTokens','unregisteredNativeTokens','unregisteredNativeCount','inputTokens','cachedInputTokens','uncachedInputTokens','cacheRatio','outputTokens','scope','accountingComplete','observedAt','knownAttempts','unknownAttempts','complete','members','limit','remaining','exhausted','unverifiable']):undefined,
    diagnostics:data.diagnostics?{source:data.diagnostics.source,stageCount:data.diagnostics.stages.length,unknown:data.diagnostics.unknown}:undefined,
    ...(data.checkpoint?{checkpoint:pick(data.checkpoint,['id','taskId','attemptId','requestId','source','createdAt'])}:{}),
    messages:(messages??[]).slice(-20).map(m=>pick(m,['id','taskId','attemptId','memberId','threadId','status','stale'])),
    checkpoints:(checkpoints??[]).slice(-20).map(c=>pick(c,['id','taskId','attemptId','stale','createdAt'])),
    evidenceAccess:{tool:'read_team_context',arguments:{teamId:team.id,view:'evidence'},required:['taskId'],handoffTool:'read_team_handoff',fullHistory:{tool:'read_team',view:'full',explicitOnly:true}}};
}

export function advancementResponse(data,view='coordination'){
  if(view==='summary')return teamResponse(data,'summary','team-update');
  return {...coordinationResponse(data),kind:'team-advancement',advancement:data.advancement,
    // Dispatch prompts contain the complete authorized task and must stay verbatim.
    ...(data.dispatches?.length?{dispatches:data.dispatches}:{}),
    ...(data.titleActions?.length?{titleActions:data.titleActions}:{})};
}

// Model-facing mutation receipts carry controls and the operation's own result.
// Desktop controls keep their display projection; complete prompts stay exact.
export function operationResponse(data,{operation,taskIds=[]}={}){
  const {team,runs,readiness,recovery,quality,usage,workflow,diagnostics,peerDelivery,initializations,messages,checkpoints,observedAt,observationMode,runtimeSource,limitations,kind,checkpoint,...operationData}=data;
  const selected=new Set(taskIds);
  for(const task of team.tasks)if(selected.has(task.id)&&task.reviewOfTaskId)selected.add(task.reviewOfTaskId);
  const affected=team.tasks.filter(task=>selected.has(task.id));
  return {...coordinationResponse(data),...operationData,kind:'team-operation',operation,
    affectedTasks:affected.slice(0,8).map(task=>{const attempt=task.attempts.at(-1);return {taskId:task.id,status:task.status,attemptId:attempt?.id??null,turnId:attempt?.turnId??null,...(attempt?.acceptance?{acceptedBy:attempt.acceptance.source,reviewTaskId:attempt.acceptance.reviewTaskId}:{}),...(attempt?.acceptanceException?{exception:attempt.acceptanceException.reason.slice(0,512),requiresLeader:true}:{})};}),hasMoreAffectedTasks:affected.length>8,
    ...(checkpoint?{checkpoint:pick(checkpoint,['id','taskId','attemptId','requestId','source','createdAt'])}:{}),
    ...(initializations?.length?{initializations}:{}),...(peerDelivery?.length?{peerDelivery}:{}),
    evidenceAccess:{tool:'read_team_context',arguments:{teamId:team.id,view:'evidence'},required:['taskId'],fullHistory:{tool:'read_team',view:'full',explicitOnly:true}}};
}
