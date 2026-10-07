import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReview,assertReviewPass} from '../src/quality-gates.mjs';
const verdict=()=>({summary:'Checked behavior',decision:'accept',reason:'Both criteria verified',checks:[{name:'negative request',criterionId:'AC-1',status:'PASS',evidence:'HTTP 403 observed'}],findings:[]});
test('review parser accepts a single JSON fence and rejects ambiguous prose',()=>{
  assert.deepEqual(parseReview('```json\n'+JSON.stringify(verdict())+'\n```'),verdict());
  assert.throws(()=>parseReview('It passes '+JSON.stringify(verdict())),/structured/);
  assert.throws(()=>parseReview('null'),/structured/);
});
test('incidental command failures require explicit Leader explanation and never override failed checks',()=>{
  const commands=[{command:'rg missing',status:'completed',exitCode:1}];
  assert.throws(()=>assertReviewPass(verdict(),commands),/failed/);
  const explanations=[{commandIndex:0,reason:'Optional source discovery had no matches; no acceptance check depends on it.'}];
  assert.equal(assertReviewPass(verdict(),commands,[],explanations),true);
  const v=verdict();v.checks[0].status='FAIL';assert.throws(()=>assertReviewPass(v,commands,[],explanations),/unverified/);
  assert.throws(()=>assertReviewPass(verdict(),commands,[],[{commandIndex:4,reason:'wrong command'}]),/Invalid/);
});
test('review gates reject unevidenced checks and missing criterion coverage',()=>{
  assert.equal(assertReviewPass(verdict(),[],[{id:'AC-1'}]),true);
  assert.throws(()=>assertReviewPass(verdict(),[],[{id:'AC-2'}]),/cover/);
  for(const status of ['FAIL','NOT_RUN','BLOCKED']){const v=verdict();v.checks[0].status=status;assert.throws(()=>assertReviewPass(v),/unverified/);}
  const v=verdict();delete v.checks[0].evidence;assert.throws(()=>assertReviewPass(v),/evidence/);
});
test('severe unresolved findings and failed command evidence block acceptance',()=>{
  const v=verdict();v.findings=[{severity:'high',status:'open',description:'Missing authorization'}];assert.throws(()=>assertReviewPass(v),/Unresolved/);
  v.findings[0].status='resolved';assert.equal(assertReviewPass(v),true);
  delete v.findings;assert.throws(()=>assertReviewPass(v),/findings/);
  assert.throws(()=>assertReviewPass(verdict(),[{status:'completed',exitCode:1}]),/failed/);
});
