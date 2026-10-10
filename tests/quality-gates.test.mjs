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
  v.findings[0].status='resolved';assert.throws(()=>assertReviewPass(v),/resolution evidence/);v.findings[0].resolutionEvidence='Independent authorization regression passed';assert.equal(assertReviewPass(v),true);
  delete v.findings;assert.throws(()=>assertReviewPass(v),/findings/);
  assert.throws(()=>assertReviewPass(verdict(),[{status:'completed',exitCode:1}]),/failed/);
});

test('finding resolution accepts concrete text lists without altering the verdict and rejects incomplete or coerced proof',()=>{
  const v=verdict();v.findings=[{id:'F',severity:'high',status:'resolved',description:'Authorization repaired',resolutionEvidence:['Inspected the exact guarded endpoint','Saved regression log shows HTTP 403']}];
  const original=structuredClone(v);assert.equal(assertReviewPass(v),true);assert.deepEqual(v,original);
  for(const resolutionEvidence of [undefined,null,'','   ',[],[''],['valid',' '],['valid',null],['valid',42],[{path:'report.json'}],{}]){
    const invalid=structuredClone(v);invalid.findings[0].resolutionEvidence=resolutionEvidence;assert.throws(()=>assertReviewPass(invalid),/resolution evidence/);
  }
});

test('source-only phase reviews can explicitly retain future NOT_RUN checks with audited scope reasons',()=>{
 const v=verdict();v.checks.push({name:'Future browser acceptance',criterionId:'AC-1',status:'NOT_RUN',evidence:'Implementation phase has not started'});
 const before=structuredClone(v),scope={validationMode:'source-only',deferredChecks:[{checkIndex:1,reason:'Current accepted task only reviews the specification; browser execution belongs to implementation'}]};
 assert.throws(()=>assertReviewPass(v,[],[{id:'AC-1'}]),/unverified/);assert.equal(assertReviewPass(v,[],[{id:'AC-1'}],[],scope),true);assert.deepEqual(v,before);
 for(const deferredChecks of [[{checkIndex:1,reason:''}],[{checkIndex:9,reason:'Future'}],[{checkIndex:1,reason:'Future'},{checkIndex:1,reason:'Duplicate'}]])assert.throws(()=>assertReviewPass(v,[],[],[],{...scope,deferredChecks}),/deferred/);
 assert.throws(()=>assertReviewPass(v,[],[],[],{...scope,validationMode:'execute'}),/source-only/);
 for(const status of ['FAIL','BLOCKED','PASS']){const invalid=structuredClone(v);invalid.checks[1].status=status;assert.throws(()=>assertReviewPass(invalid,[],[],[],scope),/deferred/);}
 assert.throws(()=>assertReviewPass(v,[],[{id:'missing'}],[],scope),/cover/);assert.throws(()=>assertReviewPass(v,[{status:'failed',exitCode:1}],[],[],scope),/failed command/);
 const unrun=structuredClone(v);unrun.checks=[unrun.checks[1]];assert.throws(()=>assertReviewPass(unrun,[],[{id:'AC-1'}],[],{...scope,deferredChecks:[{checkIndex:0,reason:'Future'}]}),/PASS|cover/);
});

test('an explanation cannot waive a declared failing or unknown validation; a later exact PASS can close its earlier failure',()=>{
 const good={command:'npm test',cwd:'/project',status:'completed',exitCode:0},scope={verificationCommands:['npm test'],workspace:'/project'},reason=[{commandIndex:0,reason:'Claimed incidental failure'}];
 for(const c of [{...good,status:'failed',exitCode:1},{...good,exitCode:null}]){
  assert.throws(()=>assertReviewPass(verdict(),[c],[],reason,scope),/Declared review verification/);
  assert.equal(assertReviewPass(verdict(),[c,good],[],reason,scope),true);
 }
 const elsewhere={...good,cwd:'/other',exitCode:1};assert.equal(assertReviewPass(verdict(),[elsewhere],[],reason,scope),true);
});
