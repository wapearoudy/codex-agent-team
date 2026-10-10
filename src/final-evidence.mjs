import {assertEvidenceSnapshot,acceptedEvidenceHash} from './evidence-snapshot.mjs';
import {parseReview} from './quality-gates.mjs';
import {assertContractPass} from './team-quality.mjs';

// Only an explicit project integration contract can replace final project checks.
// A passing unit test or source-only review is not an integration certificate.
export function finalEvidenceCandidates(team){
  return team.tasks.filter(t=>t.kind!=='review'&&t.status==='accepted'&&t.contract?.stage==='integration'&&(t.validationMode??'execute')==='execute'&&t.attempts.at(-1)?.acceptance).map(t=>({taskId:t.id,attemptId:t.attempts.at(-1).id,reviewTaskId:t.attempts.at(-1).acceptance.reviewTaskId,contractRevision:t.contractRevision??1,source:'accepted-integration-contract'}));
}
export async function reuseFinalEvidence(team){
  const checks=[],references=[];
  for(const ref of finalEvidenceCandidates(team)){
    const task=team.tasks.find(t=>t.id===ref.taskId),a=task.attempts.at(-1),r=a.acceptance,review=team.tasks.find(t=>t.id===r.reviewTaskId),ra=review?.attempts.at(-1);
    if(review?.status!=='accepted'||ra?.id!==r.reviewAttemptId||r.contractRevision!==(task.contractRevision??1)||ra.dependencyAttempts?.find(d=>d.taskId===task.id)?.attemptId!==a.id)throw new Error('Final integration evidence targets an outdated accepted candidate');
    if(acceptedEvidenceHash(team,review,task)!==r.evidenceHash)throw new Error('Saved integration evidence changed after acceptance; retain original proof and resolve the exception');
    assertContractPass(task);await assertEvidenceSnapshot(team,task);
    const verdict=parseReview(review.evidence.findLast(e=>e.attemptId===ra.id)?.summary,ra.marker);
    for(const c of verdict.checks.filter(c=>c.status==='PASS'))checks.push({name:`${task.id}: ${c.name}`,status:'PASS',evidence:`${c.evidence}\nSaved task ${task.id}, attempt ${a.id}; review ${review.id}, attempt ${ra.id}; candidate ${r.candidateFingerprint}`});
    references.push({...ref,reviewAttemptId:ra.id,candidateFingerprint:r.candidateFingerprint});
  }
  return {checks,references};
}
