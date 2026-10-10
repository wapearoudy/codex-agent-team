import {parseStructuredReport} from './report-format.mjs';
import {assertReviewPass,resolutionEvidenceText} from './quality-gates.mjs';
import {contractCommandEvidence} from './verification-command.mjs';
import {futureReviewChecks} from './review-scope.mjs';

// A saved PASS whose plugin registration failed is different from a reviewer
// asking for rework. Never claim a fresh attempt just to repeat registration.
export function recoverableReview(team,review){
  const a=review?.attempts?.at(-1),target=team.tasks.find(t=>t.id===review?.reviewOfTaskId),b=target?.attempts.at(-1),dependency=a?.dependencyAttempts?.find(d=>d.taskId===target?.id);
  if(review?.kind!=='review'||!['waiting','submitted'].includes(review.status)||a?.acceptanceException?.source!=='plugin-quality-checks'||a.review?.decision==='rework'||a.observation?.status!=='completed'||!a.agentThreadId||a.observation.threadId!==a.agentThreadId||a.turnId!==a.observation.turnId||!a.endedAt||target?.status!=='submitted'||dependency?.attemptId!==b?.id||(dependency?.contractRevision??1)!==(target?.contractRevision??1)||(a.contractRevision??1)!==(review.contractRevision??1))return false;
  try{
    const verdict=parseStructuredReport(review.evidence.findLast(e=>e.attemptId===a.id)?.summary,{expectedMarker:a.marker});
    assertReviewPass(verdict,[],target.acceptanceCriteria??[],[],{validationMode:target.validationMode,deferredChecks:a.deferredCheckExplanations?.items??[],futureChecks:futureReviewChecks(team,review,verdict)});
    if(contractCommandEvidence(target.contract?.verify??[],a.observation.commands??[],{workspace:b.evidenceSnapshot?.workspace}).some(c=>c.hostCommand&&!c.observed))return false;
    const root=target.repairRootTaskId??target.id;
    return !(team.findings??[]).some(f=>f.rootTaskId===root&&f.status==='open'&&['blocker','high'].includes(f.severity)&&!verdict.findings.some(x=>x.id===f.id&&x.severity===f.severity&&x.status==='resolved'&&resolutionEvidenceText(x.resolutionEvidence)));
  }catch{return false;}
}
