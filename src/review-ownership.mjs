import {reviewTargetIds} from './quality-policy.mjs';

export const REVIEW_SCOPE_POLICY='task-owned-v1';
function follows(team,task,ids,seen=new Set()){
 if(seen.has(task.id))return false;seen.add(task.id);
 return (task.dependencies??[]).some(d=>d.when==='accepted'&&(ids.includes(d.taskId)||(()=>{const parent=team.tasks.find(t=>t.id===d.taskId&&t.status!=='cancelled');return parent&&follows(team,parent,ids,seen);})()));
}
export function reviewOwnership(team,review){
 const ids=reviewTargetIds(review),current=ids.map(id=>team.tasks.find(t=>t.id===id)).filter(Boolean);
 return {policy:REVIEW_SCOPE_POLICY,current:current.map(t=>({taskId:t.id,contractRevision:t.contractRevision??1,criteria:t.acceptanceCriteria??[],writePaths:t.contract?.inScope??[],verify:t.contract?.verify??[]})),downstream:team.tasks.filter(t=>t.kind==='work'&&!ids.includes(t.id)&&t.status!=='cancelled'&&follows(team,t,[...ids,review.id])).map(t=>({taskId:t.id,criteria:t.acceptanceCriteria??[]})),instruction:'Only current task criteria decide this verdict. Shared files and the overall README are not ownership of downstream behavior. Identify checks and blocking findings by the exact current criterionId; the reserved target supplies their owner unless targetTaskId is explicit. Names and expected behavior are factual explanatory text, not copies of the frozen criterion description. Future missing implementations belong to their named downstream contract, never a current failure or repair. If recorded, use futureFindings with targetTaskId/criterionId/expected; they do not decide current acceptance. Current unresolved defects remain blocking; all downstream contracts and integration still need their own independent acceptance.'};
}
// A model must not introduce new acceptance obligations while registering QA.
// Semantic correctness is still the independent reviewer's responsibility;
// this gate checks explicit ownership against frozen contracts, not keywords.
export function assertReviewOwnership(team,review,target,verdict){
 if(review.reviewScopePolicy!==REVIEW_SCOPE_POLICY)return;
 const criteria=target.acceptanceCriteria??[];
 for(const check of verdict.checks??[]){
  const c=criteria.find(c=>c.id===check.criterionId);
  if(!c&&check.scope!=='advisory')throw Error('Review scope: checks must belong to this exact target contract; record downstream observations in futureFindings');
  if(check.targetTaskId!==undefined&&check.targetTaskId!==target.id)throw Error('Review scope: a check cannot claim a different target task');
 }
 for(const f of verdict.findings??[]){
  if(f.status!=='open'||f.scope==='advisory')continue;
  const c=criteria.find(c=>c.id===f.criterionId);
  if(!c||f.targetTaskId!==undefined&&f.targetTaskId!==target.id)throw Error(`Review scope: finding ${f.id} must identify the exact current criterionId and its current owner. A future requirement cannot consume current repair budget`);
 }
 if(verdict.futureFindings!==undefined){
  if(!Array.isArray(verdict.futureFindings)||verdict.futureFindings.length>30)throw Error('Review scope: futureFindings must be a bounded array');
  const owners=reviewOwnership(team,review).downstream;
  for(const f of verdict.futureFindings){const owner=owners.find(t=>t.taskId===f?.targetTaskId),c=owner?.criteria.find(c=>c.id===f.criterionId);
   if(!c||typeof f.expected!=='string'||!f.expected.trim()||f.expected.length>2000||typeof f.id!=='string'||!f.id.trim()||typeof f.description!=='string'||!f.description.trim())throw Error('Review scope: future finding needs an exact downstream accepted-dependency owner and criterion plus factual expected behavior; current or unknown obligations cannot be deferred');
  }
 }
}
