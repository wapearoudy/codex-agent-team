import {planHash,assertPlanMutable} from './team-plan-review.mjs';
import {requireTeamVersion} from './team-version.mjs';
const keys=['goal','acceptance','acceptanceCriteria','contract'];
const fields=t=>Object.fromEntries(keys.filter(k=>t[k]!==undefined).map(k=>[k,structuredClone(t[k])]));
export function amendContract(team,{taskId,patch,reason,requestId}){
  assertPlanMutable(team);
  if(!/^[0-9a-f-]{36}$/i.test(requestId??'')||!reason?.trim()||!patch||!Object.keys(patch).length||Object.keys(patch).some(k=>!keys.includes(k)))throw new Error('Contract amendment needs a UUID, reason and supported contract fields');
  const hash=planHash({taskId,patch,reason}),prior=team.contractAmendments?.find(r=>r.requestId===requestId);
  if(prior){if(prior.hash!==hash)throw new Error('Contract request ID already has different contents');return prior;}
  const task=team.tasks.find(t=>t.id===taskId);
  if(!task||!['waiting','blocked'].includes(task.status)||team.state==='delivered')throw new Error('Stop and settle running work; rework submitted work before amending its contract');
  if(task.attempts.some(a=>a.review?.decision==='accept')||team.tasks.some(t=>t.reviewOfTaskId===taskId&&t.attempts.some(a=>a.review?.decision==='accept')))throw new Error('A passed contract is frozen; propose a new delivery for expanded requirements');
  const affected=new Set(),queue=[taskId];while(queue.length){const id=queue.shift();for(const down of team.tasks.filter(t=>t.dependencies.some(d=>d.taskId===id))){if(affected.has(down.id))continue;if(['running','accepted'].includes(down.status))throw new Error('Stop downstream work before amending this contract');affected.add(down.id);queue.push(down.id);}}
  const before=fields(task),previousRevision=task.contractRevision??1,at=new Date().toISOString();Object.assign(task,structuredClone(patch));task.contractRevision=previousRevision+1;task.updatedAt=at;
  const entry={requestId,hash,taskId,reason:reason.trim(),previousRevision,revision:task.contractRevision,before,after:fields(task),at,source:'leader-recorded-contract-amendment',invalidatedTaskIds:[...affected]};
  (team.contractAmendments??=[]).push(entry);
  for(const id of affected){const down=team.tasks.find(t=>t.id===id);if(down.status!=='cancelled'){down.status='waiting';down.blockReason=`Contract ${taskId} revised; previous evidence retained but invalid`;down.updatedAt=at;}}
  team.dispatchPaused=true;requireTeamVersion(team,'0.12.0');team.events.push({at,type:'contract-amended',taskId,revision:task.contractRevision,reason:entry.reason});return entry;
}
