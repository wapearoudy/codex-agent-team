import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {verifyCandidateInputs,assertCandidateReadScope} from '../src/candidate-verification.mjs';import {captureEvidenceSnapshot} from '../src/evidence-snapshot.mjs';
test('different unchanged task scopes have different legitimate fingerprints; changed inputs and missing evidence never become PASS',async t=>{
 const root=await mkdtemp(join(tmpdir(),'candidate-scopes-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,'a.py'),'a=1');await writeFile(join(root,'b.py'),'b=1');
 const team={id:'team',projectPath:root,members:[{id:'dev',writeScopes:[]}],tasks:['a','b','joint'].map(id=>({id,memberId:'dev',kind:'work',contractRevision:1,contract:{verify:['python3 -m unittest']},attempts:[{id:id+'-attempt',contractRevision:1}]}))};
 for(const task of team.tasks)task.attempts[0].evidenceSnapshot=await captureEvidenceSnapshot(team,task,task.id==='joint'?['a.py','b.py']:[task.id+'.py']);
 const original=structuredClone(team),results=await Promise.all(team.tasks.map(task=>verifyCandidateInputs(team,{taskId:task.id})));assert.ok(results.every(r=>r.verified&&r.matchesSavedInputs));assert.equal(new Set(results.map(r=>r.currentFingerprint)).size,3);assert.ok(results.every(r=>r.acceptedCandidateVerified===false&&r.registeredAcceptanceIntegrity===null));assert.deepEqual(team,original);
 await writeFile(join(root,'b.py'),'b=2');assert.equal((await verifyCandidateInputs(team,{taskId:'a'})).matchesSavedInputs,true);assert.equal((await verifyCandidateInputs(team,{taskId:'b'})).matchesSavedInputs,false);assert.equal((await verifyCandidateInputs(team,{taskId:'joint'})).matchesSavedInputs,false);assert.deepEqual(team,original);
 delete team.tasks[0].attempts[0].evidenceSnapshot;const missing=await verifyCandidateInputs(team,{taskId:'a'});assert.equal(missing.verified,false);assert.equal(missing.matchesSavedInputs,null);assert.equal(missing.acceptedCandidateVerified,false);
 await rm(join(root,'b.py'));await symlink(join(root,'a.py'),join(root,'b.py'));const linked=await verifyCandidateInputs(team,{taskId:'b'});assert.equal(linked.verified,false);assert.equal(linked.matchesSavedInputs,null);
});
test('candidate proof member reads stay within the running own task and its transitive dependencies',()=>{
 const team={tasks:[{id:'own',memberId:'qa',status:'running',dependencies:[{taskId:'api'}]},{id:'api',memberId:'dev',dependencies:[{taskId:'store'}]},{id:'store',memberId:'dev',dependencies:[]},{id:'foreign',memberId:'other',dependencies:[]}]};
 for(const id of ['own','api','store'])assert.doesNotThrow(()=>assertCandidateReadScope(team,{id:'qa'},id));assert.throws(()=>assertCandidateReadScope(team,{id:'qa'},'foreign'),/current task/);assert.throws(()=>assertCandidateReadScope(team,{id:'idle'},'store'),/current task/);assert.doesNotThrow(()=>assertCandidateReadScope(team,null,'foreign'));
});
test('canonical initial contract revision is unchanged; a revised contract still invalidates the same legacy candidate',async t=>{
 const root=await mkdtemp(join(tmpdir(),'candidate-default-revision-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,'source.py'),'value=1');const a={id:'a'},task={id:'work',memberId:'dev',kind:'work',attempts:[a]},team={id:'t',projectPath:root,members:[{id:'dev',writeScopes:[]}],tasks:[task]};a.evidenceSnapshot=await captureEvidenceSnapshot(team,task,['source.py']);
 let r=await verifyCandidateInputs(team,{taskId:'work'});assert.equal(r.currentContractMatches,true);assert.equal(r.acceptedCandidateVerified,false);task.contractRevision=2;r=await verifyCandidateInputs(team,{taskId:'work'});assert.equal(r.matchesSavedInputs,true);assert.equal(r.currentContractMatches,false);assert.equal(r.acceptedCandidateVerified,false);
});

test('historical reconciled verification inputs are checked even outside the delivery snapshot',async t=>{
 const root=await mkdtemp(join(tmpdir(),'candidate-history-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,'src.py'),'value=1');await writeFile(join(root,'fixture.json'),'[]');const a={id:'a',contractRevision:1},task={id:'work',memberId:'dev',kind:'work',contractRevision:1,attempts:[a]},team={id:'team',projectPath:root,members:[{id:'dev',writeScopes:[]}],tasks:[task]};
 a.evidenceSnapshot=await captureEvidenceSnapshot(team,task,['src.py']);a.verificationReconciliations=[{requestId:'saved-command',inputSnapshot:await captureEvidenceSnapshot(team,task,['fixture.json'])}];
 assert.equal((await verifyCandidateInputs(team,{taskId:'work'})).matchesCompleteSavedInputs,true);
 await writeFile(join(root,'fixture.json'),'[1]');const changed=await verifyCandidateInputs(team,{taskId:'work'});assert.equal(changed.matchesSavedInputs,true);assert.equal(changed.matchesCompleteSavedInputs,false);assert.equal(changed.acceptedCandidateVerified,false);assert.equal(changed.historicalInputChecks.comparisons[0].matches,false);
 delete a.verificationReconciliations[0].inputSnapshot;assert.equal((await verifyCandidateInputs(team,{taskId:'work'})).matchesCompleteSavedInputs,null);
});
