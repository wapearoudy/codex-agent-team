import {qualityRoot,parseDelivery} from './team-quality.mjs';

export const REPAIR_BUDGET_POLICY='code-rework-v1';
// Charge repair dispatches, never PASS verdicts, transport retries or drafts.
// The source is the immutable independent verdict, including cross-task routing.
export function repairClass(review,target){
  const a=review?.attempts?.at(-1);let verdict=a?.batchReview?.targets?.find(v=>v.taskId===target.id);
  if(!verdict)try{verdict=parseDelivery(review.evidence?.findLast(e=>e.attemptId===a?.id)?.summary,a?.marker);}catch{}
  const findings=verdict?.findings?.filter(f=>f.status==='open'&&f.scope!=='advisory');
  return verdict?.decision==='rework'&&findings?.length&&findings.every(f=>f.basis==='missing-evidence')?'registration':'code';
}
export function repairBudget(team,target,{kind='code'}={}){
  const limit=team.policy?.maxReviewRounds??3;
  if(target.repairBudgetPolicy!==REPAIR_BUDGET_POLICY){const used=(target.repairRound??1)-1;return {policy:'legacy-review-rounds',kind:'code',used,limit:limit-1,canRepair:used<limit-1};}
  const events=(team.events??[]).filter(e=>e.type==='repair-planned'&&e.rootTaskId===qualityRoot(target)&&e.budgetPolicy===REPAIR_BUDGET_POLICY);
  const codeUsed=events.filter(e=>e.budgetClass==='code').length,registrationUsed=events.filter(e=>e.budgetClass==='registration').length;
  const allowed=kind==='registration'?(team.policy?.maxAttempts??3):limit-1,used=kind==='registration'?registrationUsed:codeUsed;
  return {policy:REPAIR_BUDGET_POLICY,kind,used,limit:allowed,codeUsed,registrationUsed,canRepair:used<allowed,initialReviewIncluded:true,passAndDraftsCharged:false};
}
