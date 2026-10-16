import {resolutionEvidenceText} from './quality-gates.mjs';
import {assertReviewOwnership} from './review-ownership.mjs';

export const REVIEW_EVIDENCE_POLICY='contract-linked-v1';
const bases=new Set(['source','saved-command','reproduction','missing-evidence']);
const text=v=>typeof v==='string'&&!!v.trim();

// New compiled reviews carry an explicit policy. Historical reports retain
// their original gates; no old verdict is rewritten to fit this schema.
export function assertReviewAssurance(review,target,verdict,team){
  if(team)assertReviewOwnership(team,review,target,verdict);
  if(review.reviewEvidencePolicy!==REVIEW_EVIDENCE_POLICY)return;
  const criteria=target.acceptanceCriteria??[],checks=verdict.checks;
  if(!Array.isArray(checks)||criteria.some(c=>{const rows=checks.filter(x=>x?.criterionId===c.id),r=rows[0];return rows.length!==1||!text(r?.name)||!['PASS','FAIL','BLOCKED','NOT_RUN'].includes(r?.status)||!text(r?.evidence);}))throw Error('Review must cover every exact contract criterion once with independently inspected evidence');
  if(!Array.isArray(verdict.findings))throw Error('Review needs an explicit findings array');
  const blockers=verdict.findings.filter(f=>f?.status==='open'&&f.scope!=='advisory');
  for(const f of verdict.findings.filter(f=>f?.status==='open')){
    const evidence=resolutionEvidenceText(f.evidence);
    if(!bases.has(f.basis)||!evidence||evidence.length>6000||!text(f.expected)||f.expected.length>2000||!text(f.actual)||f.actual.length>2000)throw Error(`Finding ${f.id??'(missing ID)'} needs basis, concrete evidence (at most 6000 characters), expected and actual behavior (at most 2000 each); reuse source or saved logs without rerunning valid tests`);
    if(f.scope==='advisory'){
      if(['blocker','high'].includes(f.severity))throw Error('A blocker/high defect cannot be advisory');
    }else{
      if(!criteria.some(c=>c.id===f.criterionId))throw Error(`Finding ${f.id} must identify a current contract criterion; a later task or optional enhancement cannot block this delivery`);
      if(checks.find(c=>c.criterionId===f.criterionId)?.status==='PASS')throw Error(`Finding ${f.id} contradicts a PASS check; report the actual unmet criterion without fabricating a failure or PASS`);
    }
  }
  if(verdict.decision==='rework'&&!blockers.length)throw Error('Rework requires a contract-linked blocking finding; optional advisory improvements do not route repair');
  for(const c of criteria){const check=checks.find(x=>x.criterionId===c.id);
    if(check.status!=='PASS'&&!blockers.some(f=>f.criterionId===c.id))throw Error(`Unmet criterion ${c.id} needs one concrete contract-linked finding, including an explicit missing-evidence blocker where applicable`);
  }
  if(verdict.decision==='accept'&&blockers.length)throw Error('An open contract-linked finding prevents acceptance regardless of severity');
}

export function reviewAssuranceInstructions(review){
  return review.reviewEvidencePolicy===REVIEW_EVIDENCE_POLICY?
    'Review every supplied contract criterion in one pass, including normal behavior, invalid inputs, dependency/lease/resource boundaries, concurrency, persistence and failure recovery where the contract requires them. For applicable stateful contracts inspect sequential operations across separate calls/connections (not only one batch), fresh-start races, partial initialization failures, mutation ordering on rejected persistent state, and shutdown while a handler is active. Derive checks from the actual contract, not a blanket extra test suite. Batch all independently supported findings in one report. Every open finding uses {id,severity,status:"open",criterionId:CURRENT_CRITERION,basis:"source"|"saved-command"|"reproduction"|"missing-evidence",evidence:CONCRETE_SOURCE_OR_ORIGINAL_LOG,expected:CONTRACT_BEHAVIOR,actual:OBSERVED_OR_SOURCE_DERIVED_BEHAVIOR,description}. A source-derived path is sufficient; do not rerun valid tests for proof formatting. State uncertainty as missing-evidence, never invent a reproduced failure. Optional improvements use scope:"advisory" with medium/low severity and do not trigger rework. Fix reviews focus on existing IDs, changed paths and affected contract behavior; unchanged complete evidence is reusable, but every criterion still needs an independent factual check. Retain all history; never infer whole-project correctness from public test counts.':null;
}
