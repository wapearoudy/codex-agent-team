import {verificationCommandMatches} from './verification-command.mjs';
import {deliveryQualityMetrics} from './delivery-quality-metrics.mjs';

export const QUALITY_MODES=['light','standard','strict'];
export const RISK_FLAGS=['security','data-migration','concurrency','execution-protocol','publication'];
export const reviewTargetIds=review=>review.reviewOfTaskIds??[review.reviewOfTaskId];
export const qualityMode=task=>task.qualityMode??'strict'; // Legacy receipts retain their original gate.
export function applyQualityDefaults(task,mode='standard'){
  task.qualityMode??=mode;
  if(!QUALITY_MODES.includes(task.qualityMode))throw new Error('Invalid quality mode');
  if(task.riskFlags!==undefined&&(!Array.isArray(task.riskFlags)||task.riskFlags.some(x=>!RISK_FLAGS.includes(x))))throw new Error('Invalid quality risk flags');
  if(task.riskFlags?.length)task.qualityMode='strict';
  return task;
}
export function assertReviewTopology(team){
  for(const task of team.tasks.filter(t=>t.kind!=='review'&&!t.supersededBy)){
    const reviews=team.tasks.filter(r=>r.kind==='review'&&!r.supersededBy&&reviewTargetIds(r).includes(task.id));
    if(qualityMode(task)!=='light'&&reviews.length!==1)throw new Error('Each work task requires one independent review; standard tasks may share a batch review');
    if(reviews.length>1)throw new Error('Duplicate independent reviews for one delivery');
    if(qualityMode(task)==='strict'&&reviews.some(r=>reviewTargetIds(r).length!==1))throw new Error('Strict deliveries require their own independent review');
  }
  for(const review of team.tasks.filter(t=>t.kind==='review'&&reviewTargetIds(t).length>1&&!t.supersededBy))for(const id of reviewTargetIds(review)){
    const task=team.tasks.find(t=>t.id===id);
    if(task?.dependencies.some(d=>d.when==='accepted'&&reviewTargetIds(review).includes(d.taskId)))throw new Error('Within one batch review use delivered dependencies, or split the review batches; accepted would deadlock the batch');
  }
}
export function validateQualityAttempts(team){
  for(const task of team.tasks)for(const a of task.attempts??[]){
    if(a.qualityPolicy&&(a.qualityPolicy.mode!==task.qualityMode||a.qualityPolicy.batchId!==(task.batchId??null)||JSON.stringify(a.qualityPolicy.riskFlags)!==JSON.stringify(task.riskFlags??[])))throw new Error('Dispatched quality policy is frozen; preserve the attempt and create a new task');
    const receipt=a.leaderAcceptance;if(!receipt)continue;
    if(receipt.source!=='main-conversation-leader'||receipt.qualityMode!=='light'||task.qualityMode!=='light'||receipt.taskId!==task.id||receipt.attemptId!==a.id||receipt.turnId!==a.turnId||a.observation?.status!=='completed'||a.observation.threadId!==a.agentThreadId||receipt.candidateFingerprint!==a.evidenceSnapshot?.fingerprint||!receipt.note?.trim())throw new Error('Invalid light acceptance receipt');
  }
}
export function batchTasks(team,batchId){return team.tasks.filter(t=>t.batchId===batchId);}
export function currentTasks(team){return team.activeBatchId?batchTasks(team,team.activeBatchId):team.tasks;}
export function diagnosticCommand(command){
  // Only unambiguous read-only discovery with a documented no-match exit.
  // Shell chains/wrappers and unknown errors remain actionable exceptions.
  if(typeof command!=='string'||/[;|&\r\n]/.test(command))return null;
  return /^\s*(?:rg|rg\.exe)\s+(?!.*(?:--replace|--pre)(?:\s|=))/.test(command)?{kind:'discovery',expectedExitCodes:[0,1]}:null;
}
export function commandClassification(record,required=[],workspace){
  if(required.some(command=>verificationCommandMatches(record.command,command,{cwd:record.cwd,workspace})))return {purpose:'validation',required:true};
  const diagnostic=diagnosticCommand(record.command);
  return diagnostic?{purpose:diagnostic.kind,required:false,expectedExitCodes:diagnostic.expectedExitCodes}:{purpose:'unknown',required:false};
}
export function qualityMetrics(team,batchId=team.activeBatchId){
  const tasks=batchId?batchTasks(team,batchId):team.tasks,ids=new Set(tasks.map(t=>t.id));
  const attempts=tasks.flatMap(t=>t.attempts??[]),bound=attempts.filter(a=>a.agentThreadId),elapsed=bound.flatMap(a=>{const start=Date.parse(a.boundAt),end=Date.parse(a.endedAt);return Number.isFinite(start)&&Number.isFinite(end)&&end>=start?[end-start]:[];});
  const checks=new Map();for(const task of tasks)for(const attempt of task.attempts??[])for(const c of attempt.observation?.commands??[])if(c.status==='completed'&&c.exitCode===0&&(task.contract?.verify??[]).some(command=>verificationCommandMatches(c.command,command,{cwd:c.cwd,workspace:attempt.evidenceSnapshot?.workspace}))){const key=JSON.stringify([c.command,c.cwd??attempt.evidenceSnapshot?.workspace,attempt.evidenceSnapshot?.fingerprint??attempt.id]);checks.set(key,(checks.get(key)??0)+1);}
  return {deliveryQuality:deliveryQualityMetrics(team,tasks),source:'recorded-attempts-and-events',taskCount:tasks.filter(t=>t.kind!=='review').length,reviewDispatches:tasks.filter(t=>t.kind==='review').reduce((n,t)=>n+(t.attempts??[]).filter(a=>a.agentThreadId).length,0),executionDispatches:bound.length,reservations:attempts.length,observedExecutionMs:elapsed.length?elapsed.reduce((a,b)=>a+b,0):null,timedAttempts:elapsed.length,repeatedVerificationCount:[...checks.values()].reduce((n,count)=>n+Math.max(0,count-1),0),registrationExceptions:(team.events??[]).filter(e=>ids.has(e.taskId)&&['settlement-exception','review-acceptance-exception'].includes(e.type)).length,diagnosticObservations:attempts.reduce((n,a)=>n+(a.commandObservations?.length??0),0),reusedVerificationCount:attempts.reduce((n,a)=>n+(a.reusedVerificationCommands?.length??0),0)};
}
