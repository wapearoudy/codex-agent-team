import test from 'node:test';
import assert from 'node:assert/strict';
import {assertReviewOwnership,reviewOwnership,REVIEW_SCOPE_POLICY} from '../src/review-ownership.mjs';
import {preflightDelivery,deliveryTemplate} from '../src/delivery-preflight.mjs';
import {REVIEW_EVIDENCE_POLICY} from '../src/review-assurance.mjs';
import {repairBudget,REPAIR_BUDGET_POLICY} from '../src/review-budget.mjs';

function fixture(){
 const core={id:'core',kind:'work',memberId:'dev',status:'submitted',repairBudgetPolicy:REPAIR_BUDGET_POLICY,contract:{stage:'implementation',inScope:['pkg/core.py','pkg/__init__.py'],verify:[]},acceptanceCriteria:[{id:'core-atomic',description:'Core transactions are atomic and preserve lease fencing'}],attempts:[{id:'core-attempt',delivery:{acceptanceResults:[{criterionId:'core-atomic',status:'PASS',evidence:'saved original source'}]}}]},review={id:'qa-core',kind:'review',memberId:'qa',reviewOfTaskId:'core',reviewEvidencePolicy:REVIEW_EVIDENCE_POLICY,reviewScopePolicy:REVIEW_SCOPE_POLICY,attempts:[{id:'qa-attempt',marker:'TEAM_WORKSPACE_ATTEMPT:11111111-1111-4111-8111-111111111111'}],evidence:[]};
 const future={id:'platform',kind:'work',memberId:'platform',status:'waiting',contract:{stage:'implementation',inScope:['pkg/platform.py','pkg/__init__.py']},acceptanceCriteria:[{id:'platform-runs',description:'Platform run revisions and artifacts meet the full specification'}],dependencies:[{taskId:'core',when:'accepted'}]},team={id:'team',projectPath:'/project',members:[],tasks:[core,review,future],events:[],policy:{maxReviewRounds:4}};
 const report={...deliveryTemplate(team,review),summary:'Independently inspected current core source',reason:'Saved actual core behavior satisfies the current contract',decision:'accept',checks:[{criterionId:'core-atomic',name:core.acceptanceCriteria[0].description,status:'PASS',evidence:'Original core source and saved evidence'}],findings:[]};return {team,core,review,future,report,run:()=>preflightDelivery(team,review,{writeScopes:[]},JSON.stringify(report))};
}
test('current contract and downstream ownership remain distinct even with a shared export file',()=>{
 const f=fixture(),before=structuredClone(f.team),scope=reviewOwnership(f.team,f.review);assert.deepEqual(scope.current.map(t=>t.taskId),['core']);assert.deepEqual(scope.downstream.map(t=>t.taskId),['platform']);assert.equal(f.run().valid,true);
 f.report.futureFindings=[{id:'future-platform',targetTaskId:'platform',criterionId:'platform-runs',expected:f.future.acceptanceCriteria[0].description,description:'Not implemented yet in the dependent platform unit'}];assert.equal(f.run().valid,true);assert.deepEqual(f.team,before);assert.equal(repairBudget(f.team,f.core).codeUsed,0);
});
test('future requirements cannot masquerade as current criteria, checks or code repair',()=>{
 for(const wrong of ['owner','criterion','check-owner','extra-check','defer-current','unknown-future']){
  const f=fixture(),before=structuredClone(f.team);f.report.decision='rework';f.report.checks[0].status='FAIL';f.report.findings=[{id:'expanded-platform-and-service-entrypoints-unimplemented',severity:'high',status:'open',criterionId:'core-atomic',basis:'source',evidence:'Read README platform section and pkg/__init__.py',expected:f.core.acceptanceCriteria[0].description,actual:'Missing future platform/API',description:'Future platform not implemented'}];
  const finding=f.report.findings[0];
  if(wrong==='owner')finding.targetTaskId='platform';if(wrong==='criterion')finding.criterionId='platform-runs';
  if(wrong==='check-owner')f.report.checks[0].targetTaskId='platform';
  if(wrong==='extra-check')f.report.checks.push({name:'Future platform',criterionId:'platform-runs',status:'FAIL',evidence:'Future implementation missing'});
  if(wrong==='defer-current')f.report.futureFindings=[{id:'core-missing',targetTaskId:'core',criterionId:'core-atomic',expected:f.core.acceptanceCriteria[0].description,description:'Current criterion deferred'}];
  if(wrong==='unknown-future')f.report.futureFindings=[{id:'missing',targetTaskId:'unknown',criterionId:'unknown',expected:'unknown',description:'Unknown'}];
  assert.equal(f.run().valid,false,wrong);assert.deepEqual(f.team,before);assert.equal(repairBudget(f.team,f.core).codeUsed,0);
 }
});
test('explicit wrong single-target ID is rejected rather than silently attached to the reserved task',()=>{const f=fixture();f.report.taskId='platform';assert.equal(f.run().valid,false);delete f.report.taskId;assert.equal(f.run().valid,true);});

test('genuine current defects remain blocking; report correction stays on the same review without test execution',()=>{
 const f=fixture();f.report.decision='rework';f.report.checks[0].status='FAIL';f.report.findings=[{id:'core-rollback',severity:'high',status:'open',criterionId:'core-atomic',basis:'source',expected:f.core.acceptanceCriteria[0].description,actual:'finish commits artifacts before validating the current lease fence',evidence:'pkg/core.py finish transaction ordering',description:'Stale lease can mutate state'}];assert.equal(f.run().valid,true);
 f.report.decision='accept';assert.equal(f.run().valid,false);f.report.decision='rework';f.report.findings[0].expected='Validate the active lease before any durable artifact write';f.report.checks[0].name='Atomic rollback and lease fencing';assert.equal(f.run().valid,true);assert.equal(f.review.attempts.length,1);assert.equal(repairBudget(f.team,f.core).used,0);
});
test('factual check names and expected behavior need not repeat full frozen criterion text',()=>{
 const f=fixture(),before=structuredClone(f.team);f.report.checks[0].name='Source confirms atomic lease fencing';
 f.report.futureFindings=[{id:'future-platform',targetTaskId:'platform',criterionId:'platform-runs',expected:'A later platform task must persist immutable workflow revisions',description:'Deferred observation explicitly owned by the accepted downstream dependency'}];
 assert.equal(f.run().valid,true);assert.deepEqual(f.team,before);assert.equal(repairBudget(f.team,f.core).codeUsed,0);
 f.report.futureFindings[0].criterionId='core-atomic';assert.equal(f.run().valid,false);
});
test('current-task blockers retain evidence and ownership despite explanatory wording or Unicode punctuation',()=>{
 const f=fixture();f.report.decision='rework';f.report.checks[0]={criterionId:'core-atomic',targetTaskId:'core',name:'租约 fencing — 原子回滚',status:'FAIL',evidence:'Source: pkg/core.py transaction begins after the deadline read'};
 f.report.findings=[{id:'renew-race',targetTaskId:'core',criterionId:'core-atomic',severity:'high',status:'open',basis:'source',expected:'Read and renew the current lease inside one write transaction.',actual:'Two connections can overwrite a newer deadline.',evidence:'pkg/core.py renew reads before BEGIN IMMEDIATE',description:'Renewal race'}];
 assert.equal(f.run().valid,true);f.report.findings[0].targetTaskId='platform';assert.equal(f.run().valid,false);f.report.findings[0].targetTaskId='core';f.report.findings[0].criterionId='unknown';assert.equal(f.run().valid,false);
});
test('unknown or nonaccepted dependency cannot become a future scope owner; legacy reports retain original rules',()=>{
 const f=fixture();f.future.dependencies[0].when='submitted';assert.equal(reviewOwnership(f.team,f.review).downstream.length,0);delete f.review.reviewScopePolicy;assert.doesNotThrow(()=>assertReviewOwnership(f.team,f.review,f.core,{checks:[{name:'Legacy original'}]}));
});
