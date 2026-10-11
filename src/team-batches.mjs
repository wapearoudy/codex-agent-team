import {applyQualityDefaults,batchTasks,qualityMode,QUALITY_MODES} from './quality-policy.mjs';
import {requireTeamVersion} from './team-version.mjs';

const now=()=>new Date().toISOString();
export function attachBatch(team,tasks,input){
  if(!input){
    const active=team.batches?.find(b=>b.id===team.activeBatchId);
    if(active?.state==='delivered')throw new Error('The current goal is complete; provide a new batch before adding tasks');
    for(const task of tasks){if(task.batchId&&task.batchId!==active?.id)throw new Error('Provide the matching explicit batch before assigning a task to another goal');if(active)task.batchId=active.id;applyQualityDefaults(task,active?.qualityMode??team.policy?.qualityMode??'standard');}
    if(tasks.length)requireTeamVersion(team,'0.37.0');return;
  }
  if(!/^[a-zA-Z0-9_-]{1,64}$/.test(input.id)||!input.goal?.trim()||!input.title?.trim()||!QUALITY_MODES.includes(input.qualityMode??'standard'))throw new Error('Batch requires a stable ID, title, goal and quality mode');
  team.batches??=[];
  let batch=team.batches.find(b=>b.id===input.id);
  if(batch){if(batch.state==='delivered'||batch.goal!==input.goal||batch.qualityMode!==(input.qualityMode??'standard')||JSON.stringify(batch.goalCriteria??[])!==JSON.stringify(input.goalCriteria??[])||batch.integrationRequired!==!!input.integrationRequired)throw new Error('Batch policy is frozen; use a new batch for a new goal');}
  else {batch={...structuredClone(input),qualityMode:input.qualityMode??'standard',goalCriteria:structuredClone(input.goalCriteria??[]),integrationRequired:!!input.integrationRequired,state:'active',createdAt:now(),policyVersion:1};team.batches.push(batch);}
  for(const task of tasks){if(task.batchId&&task.batchId!==batch.id)throw new Error('Task belongs to a different batch');task.batchId=batch.id;applyQualityDefaults(task,batch.qualityMode);}
  team.activeBatchId=batch.id;requireTeamVersion(team,'0.37.0');
}
export function validateBatches(team){
  if(!team.batches){if(team.tasks.some(t=>t.batchId))throw new Error('Task references a missing goal batch');return;}
  if(!Array.isArray(team.batches)||new Set(team.batches.map(b=>b.id)).size!==team.batches.length||!team.batches.some(b=>b.id===team.activeBatchId))throw new Error('Invalid goal batch identity');
  for(const batch of team.batches){
    if(!QUALITY_MODES.includes(batch.qualityMode)||!['active','delivered'].includes(batch.state)||batch.policyVersion!==1)throw new Error('Invalid frozen batch policy');
    if(!Array.isArray(batch.goalCriteria)||new Set(batch.goalCriteria.map(c=>c.id)).size!==batch.goalCriteria.length||batch.goalCriteria.some(c=>!c.id||!c.description))throw new Error('Invalid batch goal criteria');
    for(const task of batchTasks(team,batch.id))if(task.contract?.coverageOf?.some(id=>!batch.goalCriteria.some(c=>c.id===id)))throw new Error('Task coverage references an undeclared batch criterion');
    if(batch.state==='delivered'&&!batch.finalAcceptance)throw new Error('Delivered batch needs an acceptance receipt');
  }
  if(team.tasks.some(t=>t.batchId&&!team.batches.some(b=>b.id===t.batchId)))throw new Error('Task references a missing goal batch');
}
export function finishScope(team,batchId){
  if(!batchId&&team.activeBatchId)batchId=team.activeBatchId;
  const batch=batchId?team.batches?.find(b=>b.id===batchId):null;
  if(batchId&&!batch)throw new Error('Unknown goal batch');
  const tasks=batch?batchTasks(team,batchId):team.tasks;
  const ids=new Set(tasks.map(t=>t.repairRootTaskId??t.id));
  return {batch,tasks,team:{...team,tasks,goalCriteria:batch?.goalCriteria??team.goalCriteria,findings:(team.findings??[]).filter(f=>!batch||ids.has(f.rootTaskId))},integrationRequired:!batch||batch.integrationRequired||tasks.some(t=>qualityMode(t)==='strict'&&t.kind!=='review')};
}
