import {evidenceHash} from './evidence-snapshot.mjs';

// Only a named criterion owned by a downstream work contract is future work.
// Unknown checks and failures remain blockers; a reviewer cannot move a current
// obligation merely by calling it a later phase.
function downstreamPath(team,owner,targetId,reviewId){
  const queue=[{task:owner,path:[]}],seen=new Set();
  while(queue.length){
    const {task,path}=queue.shift();if(seen.has(task.id))continue;seen.add(task.id);
    const node={taskId:task.id,dependencies:structuredClone(task.dependencies??[])};
    for(const d of task.dependencies??[]){
      if(d.when!=='accepted')continue;
      if([targetId,reviewId].includes(d.taskId))return [...path,node];
      const parent=team.tasks.find(t=>t.id===d.taskId&&t.status!=='cancelled');
      if(parent)queue.push({task:parent,path:[...path,node]});
    }
  }
  return null;
}
export function futureReviewChecks(team,review,verdict){
  const target=team.tasks.find(t=>t.id===review.reviewOfTaskId),required=new Set((target?.acceptanceCriteria??[]).map(c=>c.id));
  if(!target?.contract||!required.size||!Array.isArray(verdict?.checks))return [];
  return verdict.checks.flatMap((c,checkIndex)=>{
    if(c?.status!=='NOT_RUN'||typeof c.criterionId!=='string'||!c.criterionId.trim()||required.has(c.criterionId))return [];
    const owners=team.tasks.filter(t=>t.kind==='work'&&t.id!==target.id&&t.status!=='cancelled'&&t.contract&&t.acceptanceCriteria?.some(x=>x.id===c.criterionId)).map(t=>({task:t,path:downstreamPath(team,t,target.id,review.id)})).filter(x=>x.path);
    const selected=c.futureTaskId?owners.filter(x=>x.task.id===c.futureTaskId):owners;
    if(selected.length!==1)return [];
    const {task,path}=selected[0];
    return [{checkIndex,criterionId:c.criterionId,taskId:task.id,contractRevision:task.contractRevision??1,acceptanceCriteria:structuredClone(task.acceptanceCriteria),dependencyPath:path}];
  });
}
export function scopeAudit(team,review,verdict,items){
  const a=review.attempts.at(-1),target=team.tasks.find(t=>t.id===review.reviewOfTaskId),b=target.attempts.at(-1);
  const record={source:'plugin-contract-scope',reviewAttemptId:a.id,reportHash:evidenceHash(review.evidence.findLast(e=>e.attemptId===a.id)?.summary),targetTaskId:target.id,targetAttemptId:b.id,contractRevision:target.contractRevision??1,acceptanceCriteria:structuredClone(target.acceptanceCriteria),verificationCommands:structuredClone(target.contract?.verify??[]),workspace:b.evidenceSnapshot?.workspace??team.projectPath,items:structuredClone(items),at:new Date().toISOString()};
  record.integrityHash=evidenceHash(record);return record;
}
export function validateReviewScope(team,review,a){
  const r=a.futureCheckAssociations;if(!r)return;
  const {integrityHash,...body}=r,dependency=a.dependencyAttempts?.find(d=>d.taskId===review.reviewOfTaskId),raw=review.evidence.findLast(e=>e.attemptId===a.id)?.summary;
  if(team.requiresTeamWorkspaceVersion!=='0.31.0'||review.kind!=='review'||r.source!=='plugin-contract-scope'||integrityHash!==evidenceHash(body)||r.reviewAttemptId!==a.id||r.targetTaskId!==review.reviewOfTaskId||r.targetAttemptId!==dependency?.attemptId||r.contractRevision!==(dependency?.contractRevision??1)||r.reportHash!==evidenceHash(raw)||!Number.isFinite(Date.parse(r.at))||!Array.isArray(r.acceptanceCriteria)||!r.acceptanceCriteria.length||!Array.isArray(r.items)||!r.items.length||r.items.length>30||new Set(r.items.map(x=>x.checkIndex)).size!==r.items.length)throw new Error('Invalid future review scope audit');
  // Validate the historical dependency snapshot, rather than replacing it with
  // a subsequently amended downstream contract.
  for(const item of r.items){
    if(!Number.isInteger(item.checkIndex)||item.checkIndex<0||!item.criterionId||r.acceptanceCriteria.some(c=>c.id===item.criterionId)||!Number.isInteger(item.contractRevision)||item.contractRevision<1||!item.acceptanceCriteria?.some(c=>c.id===item.criterionId)||!item.dependencyPath?.length||item.dependencyPath[0].taskId!==item.taskId||item.taskId===r.targetTaskId||!team.tasks.some(t=>t.id===item.taskId&&t.kind==='work'))throw new Error('Invalid future review criterion owner');
    const path=item.dependencyPath;
    if(new Set(path.map(p=>p.taskId)).size!==path.length||path.some((p,i)=>!team.tasks.some(t=>t.id===p.taskId)||!p.dependencies?.some(d=>d.when==='accepted'&&(i===path.length-1?[r.targetTaskId,review.id].includes(d.taskId):d.taskId===path[i+1].taskId))))throw new Error('Invalid future review dependency path');
  }
}
