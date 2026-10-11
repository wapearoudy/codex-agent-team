import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {join,relative,resolve,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {assertContractDelivery,assertContractPass} from '../src/team-quality.mjs';
async function fixture(t,{ignored=true,tracked=false}={}){
  const root=await mkdtemp(join(tmpdir(),'tw-validation-artifacts-'));
  t.after(async()=>{assert.ok(basename(root).startsWith('tw-validation-artifacts-'));assert.ok(!relative(resolve(tmpdir()),resolve(root)).startsWith('..'));await rm(root,{recursive:true,force:true});});
  execFileSync('git',['init','--quiet',root],{windowsHide:true});
  await mkdir(join(root,'evidence'));await writeFile(join(root,'evidence','native.json'),'{}');
  if(ignored)await writeFile(join(root,'.gitignore'),'evidence/\n');
  if(tracked)execFileSync('git',['add','--force','evidence/native.json'],{cwd:root,windowsHide:true});
  return root;
}
const task=()=>({kind:'work',acceptanceCriteria:[{id:'AC1',description:'real lifecycle'}],contract:{stage:'verification',inScope:[],outOfScope:[],verify:[],coverageOf:[]},attempts:[]});
const report=(paths=['evidence/'])=>JSON.stringify({summary:'Actual native lifecycle verified',changedPaths:paths,acceptanceResults:[{criterionId:'AC1',status:'PASS',evidence:'Original native session receipts'}]});
test('readonly validation classifies ignored evidence without rewriting the native report',async t=>{
  const root=await fixture(t),raw=report(),delivery=assertContractDelivery(task(),{writeScopes:[]},raw,[],{projectPath:root});
  assert.deepEqual(delivery.changedPaths,[]);assert.deepEqual(delivery.reportedChangedPaths,['evidence/']);assert.deepEqual(delivery.validationArtifactPaths,['evidence/']);assert.deepEqual(JSON.parse(raw).changedPaths,['evidence/']);
});
test('tracked, unignored, unknown-root and ordinary source edits remain denied',async t=>{
  for(const options of [{ignored:false},{tracked:true}]){const root=await fixture(t,options);assert.throws(()=>assertContractDelivery(task(),{writeScopes:[]},report(),[],{projectPath:root}),/write scope/);}
  const root=await fixture(t);assert.throws(()=>assertContractDelivery(task(),{writeScopes:[]},report()),/write scope/);
  assert.throws(()=>assertContractDelivery(task(),{writeScopes:[]},report(['src/host-bridge.mjs']),[],{projectPath:root}),/write scope/);
});
test('out-of-scope and nonvalidation changes cannot borrow artifact classification',async t=>{
  const root=await fixture(t),excluded=task();excluded.contract.outOfScope=['evidence'];
  assert.throws(()=>assertContractDelivery(excluded,{writeScopes:[]},report(),[],{projectPath:root}),/write scope/);
  const sourceOnly=task();sourceOnly.validationMode='source-only';assert.throws(()=>assertContractDelivery(sourceOnly,{writeScopes:[]},report(),[],{projectPath:root}),/write scope/);
  assert.throws(()=>assertContractDelivery(task(),{writeScopes:['src']},report(),[],{projectPath:root}),/write scope/);
});
test('artifact classification preserves failed acceptance and missing command gates',async t=>{
  const root=await fixture(t),work=task();work.contract.verify=['node verify.mjs'];
  const delivery=assertContractDelivery(work,{writeScopes:[]},report(),[],{projectPath:root});work.attempts=[{delivery,observation:{commands:[]}}];
  assert.throws(()=>assertContractPass(work),/command|verification|Missing/i);
  work.contract.verify=[];work.attempts[0].delivery.acceptanceResults[0].status='FAIL';assert.throws(()=>assertContractPass(work),/PASS|criterion/i);
});
test('ignored aliases inside evidence do not count as validation outputs',async t=>{
  const root=await fixture(t);await mkdir(join(root,'evidence','native'));
  await writeFile(join(root,'evidence','native','receipt.json'),'{}');
  await symlink(join(root,'evidence','native'),join(root,'evidence','alias'),process.platform==='win32'?'junction':'dir');
  for(const path of ['evidence/alias','evidence/alias/receipt.json'])assert.throws(()=>assertContractDelivery(task(),{writeScopes:[]},report([path]),[],{projectPath:root}),/write scope/);
});
