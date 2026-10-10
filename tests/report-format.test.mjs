import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDelivery,assertContractDelivery,assertContractPass} from '../src/team-quality.mjs';
import {parseReview,assertReviewPass} from '../src/quality-gates.mjs';
import {parseStructuredReport} from '../src/report-format.mjs';
import {normalizeNativeReport} from '../src/native-registration.mjs';

const marker='TEAM_WORKSPACE_ATTEMPT:12345678-1234-1234-1234-123456789abc';
const other='TEAM_WORKSPACE_ATTEMPT:87654321-4321-4321-4321-cba987654321';
const report={attemptMarker:marker,summary:'Actual delivery',changedPaths:['src/a.mjs'],acceptanceResults:[{criterionId:'AC',status:'PASS',evidence:'Saved command log'}]};
const fence=body=>'```json\n'+body+'\n```';
const parsers=[parseDelivery,parseReview,(text,expectedMarker)=>parseStructuredReport(text,{expectedMarker}),normalizeNativeReport];

test('all report receivers accept documented marker envelopes and preserve the original object',()=>{
  for(const parse of parsers)for(const wrapper of [body=>body,fence,body=>marker+'\n'+body,body=>marker+'\r\n'+fence(body).replaceAll('\n','\r\n')]){
    const input=' \n'+wrapper(JSON.stringify(report))+'\n ';
    assert.deepEqual(parse(input,marker),report);
  }
  for(const parse of parsers){assert.deepEqual(parse(JSON.stringify({summary:'Legacy bound turn'}),marker),{summary:'Legacy bound turn'});assert.deepEqual(parse(fence(JSON.stringify({summary:'Legacy bound turn'})),marker),{summary:'Legacy bound turn'});}
});
test('markers must agree with the body and exact bound attempt in every receiver',()=>{
  for(const parse of parsers)for(const input of [
    marker+'\n'+JSON.stringify({...report,attemptMarker:other}),
    other+'\n'+fence(JSON.stringify({...report,attemptMarker:other})),
    marker+'\n'+JSON.stringify({summary:'Missing body marker'}),
    JSON.stringify({...report,attemptMarker:other}),
    JSON.stringify({...report,taskMarker:other}),
    JSON.stringify({...report,attemptMarker:null})
  ])assert.throws(()=>parse(input,marker),/another task marker/);
});
test('ordinary receivers reject prose, multiple markers or JSON documents and non-object bodies',()=>{
  for(const parse of parsers.slice(0,3))for(const input of [
    marker+'\n'+marker+'\n'+JSON.stringify(report),
    marker+'\n'+fence(JSON.stringify(report))+'\nIt passed',
    'It passed\n'+JSON.stringify(report),
    marker+'\n'+JSON.stringify(report)+'\n'+JSON.stringify(report),
    marker+'\n```json\n'+JSON.stringify(report),
    'TEAM_WORKSPACE_ATTEMPT:invalid\n'+fence(JSON.stringify(report)),
    ...['null','[]','42','"PASS"','true'].map(body=>marker+'\n'+body),undefined
  ])assert.throws(()=>parse(input,marker),/structured/);
  assert.equal(normalizeNativeReport(marker+'\n'+marker+'\n'+fence(JSON.stringify(report)),marker),null);
});
test('format compatibility never substitutes for scope, criterion, host-command or independent review evidence',()=>{
  const task={kind:'work',acceptanceCriteria:[{id:'AC'}],attempts:[{marker}],contract:{stage:'implementation',inScope:['src'],outOfScope:[],verify:['npm test']}},member={writeScopes:['src']};
  const output=marker+'\n'+fence(JSON.stringify(report));
  task.attempts[0].delivery=assertContractDelivery(task,member,output,[]);
  assert.throws(()=>assertContractPass(task),/host-observed/);
  task.attempts[0].observation={commands:[{command:'npm test',status:'completed',exitCode:0}]};assertContractPass(task);
  assert.throws(()=>assertContractDelivery(task,member,marker+'\n'+JSON.stringify({...report,changedPaths:['outside/a']})),/outside/);
  assert.throws(()=>assertContractDelivery(task,member,marker+'\n'+JSON.stringify({...report,acceptanceResults:[]})),/every acceptance/);
  task.attempts[0].delivery.acceptanceResults[0].status='FAIL';assert.throws(()=>assertContractPass(task),/every criterion PASS/);
  const verdict=parseReview(marker+'\n'+JSON.stringify({attemptMarker:marker,decision:'accept',summary:'Done',reason:'Checked',checks:[{name:'AC',status:'PASS',criterionId:'AC',evidence:'Saved'}],findings:[{id:'F',severity:'high',status:'open',description:'Still broken'}]}),marker);
  assert.throws(()=>assertReviewPass(verdict),/Unresolved/);
});
