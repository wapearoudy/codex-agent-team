import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {workflowActions} from '../src/team-workflow.mjs';
import {coordinationResponse} from '../src/team-coordination-response.mjs';
import {captureEvidenceSnapshot} from '../src/evidence-snapshot.mjs';
import {reviewInputHash} from '../src/reviewer-acceptance.mjs';
import {evidenceHash} from '../src/evidence-snapshot.mjs';
import {randomUUID} from 'node:crypto';
import {dispatchBlockers} from '../src/team.mjs';

const passed=()=>({summary:'Independently verified saved candidate',decision:'accept',reason:'Exact candidate and required criteria verified',checks:[{name:'behavior',criterionId:'AC',status:'PASS',evidence:'Host npm test exited 0, saved log; inspected src/a.mjs'}],findings:[]});
async function fixture(t,{stage='implementation',next=false,sourceOnly=false,future=false}={}){
  const root=await mkdtemp(join(tmpdir(),'reviewer-acceptance-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const cwd=join(root,'project');await mkdir(join(cwd,'src'),{recursive:true});await writeFile(join(cwd,'src/a.mjs'),'export const value=1;');
  const runs=new Map(),observer={calls:0,async inspect(l,p,thread,marker){this.calls++;assert.equal(l,'leader');assert.equal(p,cwd);const run=runs.get(marker);assert.equal(run.threadId,thread);return structuredClone(run);}};
  const engine=new LeaderEngine({root:join(root,'records'),observer});t.after(()=>engine.close());
  const work={id:'work',title:'Deliver',goal:'Requested behavior',acceptance:'AC checked',acceptanceCriteria:[{id:'AC',description:'Required behavior'}],memberId:'dev',kind:'work',...(sourceOnly?{validationMode:'source-only'}:{}),dependencies:[],contract:{stage,inScope:['src'],outOfScope:[],verify:sourceOnly?[]:['npm test'],coverageOf:[]}};
  const review={id:'review',title:'Review',goal:'Check candidate',acceptance:'Independent proof',memberId:'qa',kind:'review',reviewOfTaskId:'work',dependencies:[{taskId:'work',when:'submitted'}]};
  const tasks=[work,review];if(next)tasks.push({id:'next',title:'Downstream',goal:'Follow approved result',acceptance:'Proof',memberId:'dev',kind:'work',dependencies:[{taskId:'work',when:'accepted'}]},{...review,id:'next_review',reviewOfTaskId:'next',dependencies:[{taskId:'next',when:'submitted'}]});
  if(future)tasks.push({id:'integration',title:'Joint acceptance',goal:'Real API and browser check',acceptance:'Future execution required',acceptanceCriteria:[{id:'G6',description:'Real API, browser and release checks'}],memberId:'dev',kind:'work',dependencies:[{taskId:'work',when:'accepted'}],contract:{stage:'integration',inScope:['src'],outOfScope:[],verify:['npm test'],coverageOf:[]}},{...review,id:'integration_review',reviewOfTaskId:'integration',dependencies:[{taskId:'integration',when:'submitted'}]});
  const team=await engine.planOnce('owner',{cwd,threadId:'leader'},{goal:'Validated delivery',execute:true,plan:{members:[{id:'dev',role:'Developer',responsibility:'Implement',reason:'Source work',writeScopes:['src']},{id:'qa',role:'Reviewer',responsibility:'Independent review',reason:'Verify',writeScopes:[]}],tasks}});
  async function execute(taskId,output,{commands,settle=true}={}){
    const latest=await engine.native('owner',team.id),c=await engine.claim('owner',team.id,latest.revision,taskId),d=c.dispatch,thread='child-'+taskId;
    if(typeof output==='function')output=output(d);
    const run={threadId:thread,turnId:d.attemptId,status:'completed',source:'native-thread-persisted-snapshot',outputs:[{text:typeof output==='string'?output:JSON.stringify(output)}],commands:commands??(taskId==='work'?[{command:'npm test',status:'completed',exitCode:0,output:'passed'}]:[])};
    runs.set(d.marker,run);const b=await engine.bind('owner',team.id,c.team.revision,taskId,d.attemptId,thread);
    return settle?engine.settle('owner',team.id,b.team.revision,taskId,d.attemptId):b;
  }
  const submitWork=options=>execute('work',{summary:'Delivered exact candidate',changedPaths:['src/a.mjs'],verificationInputs:['src'],acceptanceResults:[{criterionId:'AC',status:'PASS',evidence:'npm test passed'}],commandsRun:['npm test']},options);
  return {root,cwd,engine,team,runs,observer,execute,submitWork};
}
test('settlement atomically accepts independent PASS and unlocks the next task; replay/restart neither reviews nor observes again',async t=>{
  const f=await fixture(t,{next:true});await f.submitWork();const done=await f.execute('review',passed());
  assert.equal(done.team.tasks[0].status,'accepted');assert.equal(done.team.tasks[1].status,'accepted');assert.equal(done.readiness.find(r=>r.taskId==='next').ready,true);
  const a=done.team.tasks[1].attempts.at(-1),b=done.team.tasks[0].attempts.at(-1);assert.equal(a.acceptance.targetAttemptId,b.id);assert.equal(done.team.requiresTeamWorkspaceVersion,'0.24.0');
  assert.ok(!done.workflow.actions.some(a=>a.type==='review-decision'||a.type==='review-exception'));
  const restarted=new LeaderEngine({root:join(f.root,'records'),observer:f.observer});t.after(()=>restarted.close());const before=await restarted.native('owner',f.team.id),calls=f.observer.calls;
  await restarted.settle('owner',f.team.id,1,'review',a.id);await restarted.acceptReview('owner',f.team.id,1,'review',a.id,'accept','Legacy duplicate call');
  assert.equal(f.observer.calls,calls);assert.deepEqual(await restarted.native('owner',f.team.id),before);
});

const phaseVerdict=()=>({...passed(),checks:[...passed().checks,{name:'Future real API, browser and Docker',criterionId:'G6',status:'NOT_RUN',evidence:'Owned by the confirmed downstream integration contract; no real execution is claimed'}]});
test('execute work accepts its saved independent PASS with a downstream NOT_RUN note, preserving both phases and restart audit',async t=>{
  const f=await fixture(t,{future:true}),work=await f.submitWork(),original=phaseVerdict(),done=await f.execute('review',original),review=done.team.tasks[1],a=review.attempts.at(-1);
  assert.equal(done.team.tasks[0].status,'accepted');assert.equal(review.status,'accepted');assert.equal(done.team.tasks[2].status,'waiting');assert.equal(done.readiness.find(r=>r.taskId==='integration').ready,true);assert.notEqual(done.team.state,'delivered');
  assert.deepEqual(JSON.parse(review.evidence.at(-1).summary),original);assert.deepEqual(done.team.tasks[0].attempts.at(-1).observation,work.team.tasks[0].attempts.at(-1).observation);assert.equal(a.futureCheckAssociations.items[0].taskId,'integration');assert.equal(a.futureCheckAssociations.items[0].criterionId,'G6');assert.equal(done.team.requiresTeamWorkspaceVersion,'0.31.0');
  const calls=f.observer.calls,cold=new LeaderEngine({root:join(f.root,'records'),observer:f.observer});t.after(()=>cold.close());
  const saved=await cold.native('owner',f.team.id);assert.deepEqual(saved.tasks[1].attempts.at(-1).futureCheckAssociations,a.futureCheckAssociations);await cold.settle('owner',f.team.id,1,'review',a.id);assert.equal(f.observer.calls,calls);assert.equal(saved.tasks[1].attempts.length,1);
});
test('future scope cannot hide current NOT_RUN, failed checks, missing evidence, unknown owners or invalid dependency paths',async t=>{
  for(const kind of ['current','fail','blocked','unknown','empty-evidence','unrelated'])await t.test(kind,async t=>{
    const f=await fixture(t,{future:true});await f.submitWork();const v=phaseVerdict();
    if(kind==='current')v.checks[1].criterionId='AC';if(kind==='fail')v.checks[1].status='FAIL';if(kind==='blocked')v.checks[1].status='BLOCKED';if(kind==='unknown')v.checks[1].criterionId='unknown';if(kind==='empty-evidence')v.checks[1].evidence='';
    if(kind==='unrelated'){const team=await f.engine.native('owner',f.team.id);await f.engine.store.update(team.id,'owner',team.revision,t=>{t.tasks[2].dependencies=[];});}
    const done=await f.execute('review',v);assert.equal(done.team.tasks[0].status,'submitted');assert.equal(done.team.tasks[1].status,'submitted');assert.ok(done.team.tasks[1].attempts.at(-1).acceptanceException);assert.equal(done.team.tasks[1].attempts.at(-1).futureCheckAssociations,undefined);
  });
});
async function seedOldScopeRejection(f,{waiting=false,commands=[]}={}){
  await f.submitWork();const bound=await f.execute('review',phaseVerdict(),{settle:false,commands}),a=bound.team.tasks[1].attempts.at(-1);
  await f.engine.store.update(f.team.id,'owner',bound.team.revision,t=>{
    t.requiresTeamWorkspaceVersion='0.24.0';
    const r=t.tasks[1],attempt=r.attempts.at(-1);r.status=waiting?'waiting':'submitted';attempt.state='submitted';attempt.endedAt=new Date().toISOString();attempt.observation=structuredClone(f.runs.get(a.marker));r.evidence.push({attemptId:a.id,summary:JSON.stringify(phaseVerdict())});
    attempt.acceptanceException={source:'plugin-quality-checks',inputHash:'old-v3-scope-rejection',reason:'Review contains failed, missing or unverified checks',taskId:r.id,attemptId:a.id,at:new Date().toISOString(),requiresLeader:true};
  });
  return f.engine.native('owner',f.team.id);
}
test('advance retries an old scope rejection once without another observation, review, test or attempt',async t=>{
  const f=await fixture(t,{future:true}),saved=await seedOldScopeRejection(f),calls=f.observer.calls,done=await f.engine.advance('owner',f.team.id,saved.revision);
  assert.equal(done.team.tasks[0].status,'accepted');assert.equal(done.team.tasks[1].status,'accepted');assert.equal(done.team.tasks[1].attempts.length,1);assert.equal(done.team.tasks[1].attempts[0].acceptanceExceptionHistory.length,1);assert.equal(f.observer.calls,calls);
  const repeated=await f.engine.advance('owner',f.team.id,done.team.revision);assert.equal(repeated.team.revision,done.team.revision);assert.equal(repeated.team.events.filter(e=>e.type==='reviewer-acceptance-registered').length,1);assert.equal(f.observer.calls,calls);
});
test('waiting saved PASS is reconciled in place with explicit incidental failure evidence and cannot be dispatched again',async t=>{
  const f=await fixture(t,{future:true}),commands=[{command:'rg optional-symbol src',status:'failed',exitCode:1},{command:'read corrected evidence',status:'completed',exitCode:0}],saved=await seedOldScopeRejection(f,{waiting:true,commands}),review=saved.tasks[1],a=review.attempts.at(-1),calls=f.observer.calls;
  assert.ok(dispatchBlockers(saved,review).some(x=>x.code==='saved-review'));assert.equal(workflowActions(saved).actions.find(x=>x.taskId==='review').tool,'reconcile_team_review');
  const input={taskId:review.id,attemptId:a.id,requestId:randomUUID(),note:'Register the same independently reviewed candidate'},preview=await f.engine.reconcileReview('owner',saved.id,saved.revision,input);
  assert.equal(preview.canRegister,false);assert.deepEqual(preview.unresolvedCommands.map(x=>x.commandIndex),[0]);assert.deepEqual(preview.futureChecks,[{checkIndex:1,criterionId:'G6',taskId:'integration'}]);assert.deepEqual(await f.engine.native('owner',saved.id),saved);
  const explained={...input,nonValidationFailures:[{commandIndex:0,reason:'Optional symbol search had no matches; original source inspection and required checks passed independently'}]};
  const valid=await f.engine.reconcileReview('owner',saved.id,saved.revision,explained);assert.equal(valid.canRegister,true);assert.deepEqual(await f.engine.native('owner',saved.id),saved);
  const receipt=await f.engine.reconcileReview('owner',saved.id,saved.revision,{...explained,dryRun:false}),done=await f.engine.native('owner',saved.id);
  assert.equal(receipt.registeredAtRecording,true);assert.equal(done.tasks[0].status,'accepted');assert.equal(done.tasks[1].status,'accepted');assert.equal(done.tasks[1].attempts.length,1);assert.deepEqual(done.tasks[1].evidence,saved.tasks[1].evidence);assert.deepEqual(done.tasks[1].attempts[0].observation,saved.tasks[1].attempts[0].observation);assert.equal(done.tasks[1].attempts[0].acceptanceExceptionHistory.length,1);assert.equal(done.tasks[1].attempts[0].reviewReconciliations[0].originalStatus,'waiting');assert.equal(f.observer.calls,calls);
  const replay=await f.engine.reconcileReview('owner',saved.id,1,{...explained,dryRun:false});assert.equal(replay.replayed,true);assert.deepEqual(await f.engine.native('owner',saved.id),done);assert.equal(f.observer.calls,calls);
  await assert.rejects(()=>f.engine.reconcileReview('owner',saved.id,1,{...explained,note:'Different request contents',dryRun:false}),/different contents/);
});
test('saved review reconciliation rejects changed inputs, stale targets and genuine reviewer rework without changing the team',async t=>{
  for(const kind of ['changed','stale','rework','writable'])await t.test(kind,async t=>{
    const f=await fixture(t,{future:true}),saved=await seedOldScopeRejection(f,{waiting:true}),a=saved.tasks[1].attempts.at(-1);
    if(kind==='changed')await writeFile(join(f.cwd,'src/a.mjs'),'changed');
    if(['stale','rework'].includes(kind))await f.engine.store.update(saved.id,'owner',saved.revision,t=>{if(kind==='stale')t.tasks[0].contractRevision=2;if(kind==='rework')t.tasks[1].attempts[0].review={decision:'rework',note:'Real independent defect'};});
    const before=await f.engine.native('owner',saved.id),input={taskId:'review',attemptId:a.id,requestId:randomUUID(),note:'Reuse'};
    if(kind==='writable'){const actual=f.engine.native.bind(f.engine);f.engine.native=async(...args)=>{const t=await actual(...args);t.members[1].writeScopes=['src'];return t;};}
    if(['stale','rework'].includes(kind))await assert.rejects(()=>f.engine.reconcileReview('owner',saved.id,before.revision,input),/stale|rework/);
    else {const p=await f.engine.reconcileReview('owner',saved.id,before.revision,input);assert.equal(p.canRegister,false);assert.match(p.blockers[0],kind==='changed'?/changed after submission/:/read-only/);}
    assert.deepEqual((await f.engine.store.get(saved.id,'owner')),before);
  });
});
test('prefixed work and review reports accept once, retain exact public evidence and reuse final integration proof',async t=>{
  const f=await fixture(t,{stage:'integration'}),delivery={summary:'Exact candidate',changedPaths:['src/a.mjs'],acceptanceResults:[{criterionId:'AC',status:'PASS',evidence:'Original native test'}]};
  const submitted=await f.execute('work',d=>d.marker+'\n'+JSON.stringify({attemptMarker:d.marker,...delivery}));
  const original=submitted.team.tasks[0].evidence.at(-1).summary;assert.match(original,/^TEAM_WORKSPACE_ATTEMPT:/);
  const done=await f.execute('review',d=>d.marker+'\r\n```json\r\n'+JSON.stringify({attemptMarker:d.marker,...passed()})+'\r\n```');
  assert.equal(done.team.tasks[0].status,'accepted');assert.equal(done.team.tasks[1].status,'accepted');assert.equal(done.team.tasks[0].evidence.at(-1).summary,original);
  assert.match(done.team.tasks[1].evidence.at(-1).summary,/\r\n```json/);const calls=f.observer.calls;
  const cold=new LeaderEngine({root:join(f.root,'records'),observer:f.observer});t.after(()=>cold.close());
  const closed=await cold.finish('owner',f.team.id,done.team.revision,'Reuse verified prefixed report');assert.equal(closed.team.state,'delivered');assert.equal(f.observer.calls,calls);assert.equal(closed.team.tasks[0].attempts.length,1);assert.equal(closed.team.tasks[1].attempts.length,1);
});
test('foreign prefixed review is retained as an exception and cannot unlock downstream work',async t=>{
  const f=await fixture(t,{next:true});await f.submitWork();
  const marker='TEAM_WORKSPACE_ATTEMPT:12345678-1234-1234-1234-123456789abc',original=marker+'\n'+JSON.stringify({attemptMarker:marker,...passed()}),done=await f.execute('review',original);
  assert.equal(done.team.tasks[0].status,'submitted');assert.equal(done.team.tasks[1].status,'submitted');assert.equal(done.team.tasks[1].evidence.at(-1).summary,original);assert.match(done.team.tasks[1].attempts.at(-1).acceptanceException.reason,/another task marker/);assert.equal(done.readiness.find(r=>r.taskId==='next').ready,false);
});
test('old prefix-format rejection retries plugin gates once using saved evidence without native observation',async t=>{
  const f=await fixture(t);await f.submitWork();const bound=await f.execute('review',d=>d.marker+'\n'+JSON.stringify({attemptMarker:d.marker,...passed()}),{settle:false}),team=structuredClone(bound.team),review=team.tasks[1],a=review.attempts.at(-1),target=team.tasks[0],b=target.attempts.at(-1),raw=f.runs.get(a.marker).outputs[0].text;
  review.status='submitted';review.evidence.push({attemptId:a.id,summary:raw});a.observation=f.runs.get(a.marker);
  const oldHash=evidenceHash(['resolution-evidence-text-or-array-v1',a.id,a.turnId,a.observation.commands,raw,a.dependencyAttempts,target.status,b.id,b.turnId,target.contractRevision??1,target.contract,target.acceptanceCriteria,b.delivery,b.evidenceSnapshot,team.findings]);
  a.acceptanceException={inputHash:oldHash,reason:'Reviewer must provide a structured verdict'};assert.notEqual(reviewInputHash(team,review),oldHash);
  const calls=f.observer.calls;assert.equal(await f.engine.validateSubmittedReview(team,review),true);assert.equal(team.tasks[0].status,'accepted');assert.equal(team.tasks[1].evidence.at(-1).summary,raw);assert.equal(f.observer.calls,calls);
  assert.equal(await f.engine.validateSubmittedReview(team,team.tasks[1]),false);assert.equal(team.events.filter(e=>e.type==='reviewer-acceptance-registered').length,1);
});
test('advance accepts a completed review before claiming unlocked work in the same bounded batch',async t=>{
  const f=await fixture(t,{next:true});await f.submitWork();const b=await f.execute('review',passed(),{settle:false});
  const advanced=await f.engine.advance('owner',f.team.id,b.team.revision,{dispatchReady:true});
  assert.equal(advanced.team.tasks[0].status,'accepted');assert.equal(advanced.dispatches[0].taskId,'next');assert.equal(advanced.team.tasks[0].attempts.length,1);assert.deepEqual(advanced.advancement.changes.map(c=>[c.taskId,c.status]),[['work','accepted'],['review','accepted'],['next','running']]);
});
test('missing criteria, failed checks, severe findings and command failures retain evidence as one actionable exception',async t=>{
  for(const variant of ['missing','failed','high','command','target-command','malformed','future'])await t.test(variant,async t=>{
    const f=await fixture(t);await f.submitWork(variant==='target-command'?{commands:[{command:'npm test',status:'failed',exitCode:1}]}:undefined);
    const v=passed();if(variant==='missing')delete v.checks[0].criterionId;if(variant==='failed')v.checks[0].status='FAIL';if(variant==='high')v.findings=[{id:'F',severity:'high',status:'open',description:'Broken behavior'}];if(variant==='future')v.checks.push({name:'future',status:'NOT_RUN',evidence:'Not executed'});
    const done=await f.execute('review',variant==='malformed'?'unstructured result':v,variant==='command'?{commands:[{command:'npm test',status:'failed',exitCode:1}]}:undefined);
    assert.equal(done.team.tasks[0].status,'submitted');const a=done.team.tasks[1].attempts.at(-1);assert.ok(a.acceptanceException?.reason);
    assert.equal(done.workflow.actions.find(a=>a.type==='review-exception').requiresLeaderValidation,true);
    const before=await f.engine.native('owner',f.team.id);await f.engine.read('owner',f.team.id,{observe:false});assert.deepEqual(await f.engine.native('owner',f.team.id),before);
    await f.engine.validateSubmittedReview(done.team,done.team.tasks[1]);assert.equal(done.team.events.filter(e=>e.type==='review-acceptance-exception').length,1);
    const response=coordinationResponse(done);assert.equal(response.actions.find(a=>a.type==='review-exception').reason,a.acceptanceException.reason);assert.ok(Buffer.byteLength(JSON.stringify(response))<6000);
  });
});
test('source mutation after submission invalidates evidence and does not rerun the original test',async t=>{
  const f=await fixture(t);await f.submitWork();await writeFile(join(f.cwd,'src/a.mjs'),'export const value=2;');const done=await f.execute('review',passed());
  assert.equal(done.team.tasks[0].status,'submitted');assert.match(done.team.tasks[1].attempts.at(-1).acceptanceException.reason,/changed after submission/);
  assert.equal(done.team.tasks[0].attempts.length,1);assert.equal(done.team.tasks[0].attempts[0].observation.commands.length,1);
});
test('wrong review dependency and same native executor cannot certify acceptance',async t=>{
  for(const kind of ['old-target','same-thread','old-contract','writable-reviewer'])await t.test(kind,async t=>{
    const f=await fixture(t);await f.submitWork();const bound=await f.execute('review',passed(),{settle:false});
    const review=bound.team.tasks[1],a=review.attempts.at(-1);
    if(kind==='old-target')a.dependencyAttempts[0].attemptId='outdated';
    if(kind==='same-thread')a.agentThreadId=a.observation.threadId=bound.team.tasks[0].attempts.at(-1).agentThreadId;
    if(kind==='old-contract')bound.team.tasks[0].contractRevision=2;
    if(kind==='writable-reviewer')bound.team.members[1].writeScopes=['src'];
    // Use submitted in-memory observation to test the gate; persisted binding independently fences identities.
    review.status='submitted';review.evidence.push({attemptId:a.id,summary:JSON.stringify(passed())});a.observation.status='completed';
    assert.equal(await f.engine.validateSubmittedReview(bound.team,review),false);assert.ok(review.attempts.at(-1).acceptanceException);assert.equal(bound.team.tasks[0].status,'submitted');
  });
});
test('valid integration proof is reused for final closure without commands, review or state polling; changed inputs block reuse',async t=>{
  const f=await fixture(t,{stage:'integration'});await f.submitWork();const accepted=await f.execute('review',passed()),calls=f.observer.calls;
  assert.equal(accepted.workflow.actions.find(a=>a.type==='final-validation').reusableEvidence[0].taskId,'work');
  await writeFile(join(f.cwd,'src/a.mjs'),'export const value=3;');await assert.rejects(()=>f.engine.finish('owner',f.team.id,accepted.team.revision,'Close using integration evidence'),/changed after submission/);
  assert.equal((await f.engine.native('owner',f.team.id)).state,'awaiting-leader-acceptance');await writeFile(join(f.cwd,'src/a.mjs'),'export const value=1;');
  const done=await f.engine.finish('owner',f.team.id,accepted.team.revision,'Close using integration evidence');assert.equal(done.team.state,'delivered');assert.equal(done.team.finalAcceptance.reusedEvidence[0].attemptId,accepted.team.tasks[0].attempts[0].id);
  const replay=await f.engine.finish('owner',f.team.id,accepted.team.revision,'Close using integration evidence');assert.deepEqual(replay.team.finalAcceptance,done.team.finalAcceptance);assert.equal(f.observer.calls,calls);
});
test('individual implementation checks cannot substitute for a final integration check',async t=>{
  const f=await fixture(t);await f.submitWork();const accepted=await f.execute('review',passed());
  assert.deepEqual(workflowActions(accepted.team).actions.find(a=>a.type==='final-validation').reusableEvidence,[]);
  await assert.rejects(()=>f.engine.finish('owner',f.team.id,accepted.team.revision,'No integration proof yet'),/integration evidence/);
});
test('final reuse rejects changed saved review evidence and replay of supplied checks stays idempotent',async t=>{
  const f=await fixture(t,{stage:'integration'});await f.submitWork();const accepted=await f.execute('review',passed());
  const saved=await f.engine.native('owner',f.team.id);await f.engine.store.update(saved.id,'owner',saved.revision,t=>{t.tasks[1].evidence.at(-1).summary=JSON.stringify({...passed(),checks:[{name:'fabricated replacement',status:'PASS',evidence:'Unrelated'}]});});
  const modified=await f.engine.native('owner',f.team.id);await assert.rejects(()=>f.engine.finish('owner',f.team.id,modified.revision,'Original evidence required'),/evidence changed/);
  await f.engine.store.update(modified.id,'owner',modified.revision,t=>{t.tasks[1].evidence.at(-1).summary=JSON.stringify(passed());});
  const restored=await f.engine.native('owner',f.team.id),checks=[{name:'Additional existing final check',status:'PASS',evidence:'Saved project check log'}];
  const done=await f.engine.finish('owner',f.team.id,restored.revision,'Final accepted',checks);const replay=await f.engine.finish('owner',f.team.id,restored.revision,'Final accepted',checks);assert.equal(replay.team.revision,done.team.revision);
});
test('input snapshot rejects symlink traversal and includes generated verification inputs',async t=>{
  const f=await fixture(t);const task=f.team.tasks[0];task.attempts.push({delivery:{verificationInputs:['build/output']}});await mkdir(join(f.cwd,'build'),{recursive:true});await writeFile(join(f.cwd,'build/output'),'actual artifact');
  const first=await captureEvidenceSnapshot(f.team,task);await writeFile(join(f.cwd,'build/output'),'changed artifact');assert.notEqual((await captureEvidenceSnapshot(f.team,task)).fingerprint,first.fingerprint);
  await symlink(f.cwd,join(f.cwd,'src/link'));await assert.rejects(()=>captureEvidenceSnapshot(f.team,task),/symbolic links/);
});


test('advance does one native observation pass and reports the next action without settling when deferred',async t=>{
 const f=await fixture(t),bound=await f.submitWork({settle:false}),before=f.observer.calls;
 const data=await f.engine.advance('owner',f.team.id,bound.team.revision,{settleCompleted:false});
 assert.equal(f.observer.calls-before,1);assert.equal(data.team.revision,bound.team.revision);assert.equal(data.team.tasks[0].status,'running');assert.equal(data.workflow.actions.find(a=>a.type==='settle').observedStatus,'completed');assert.deepEqual(data.advancement.changes,[]);assert.equal(data.advancement.readAgainRequired,false);
});

async function seedOpenFinding(f){
  const t=await f.engine.native('owner',f.team.id),finding={id:'F',rootTaskId:'work',severity:'high',description:'Missing canonical rule',status:'open',history:[{at:new Date().toISOString(),status:'open',reviewTaskId:'review',evidence:null}]};
  await f.engine.store.update(t.id,'owner',t.revision,t=>{t.findings=[finding];});
}
const resolvedFinding=()=>({id:'F',severity:'high',status:'resolved',description:'Canonical rule is now explicit',resolutionEvidence:['Inspected the exact rule and original source','Verified the independent permission combinations','Saved report binds this unchanged candidate']});
test('independent resolution evidence arrays auto-accept once, retain the original review and append finding history',async t=>{
  const f=await fixture(t,{next:true});await seedOpenFinding(f);await f.submitWork();
  const original={...passed(),findings:[resolvedFinding()]},done=await f.execute('review',original),review=done.team.tasks[1],a=review.attempts.at(-1),ledger=done.team.findings[0];
  assert.equal(done.team.tasks[0].status,'accepted');assert.equal(review.status,'accepted');assert.equal(done.readiness.find(r=>r.taskId==='next').ready,true);
  assert.deepEqual(JSON.parse(review.evidence.at(-1).summary),original);assert.equal(ledger.resolutionEvidence,original.findings[0].resolutionEvidence.join('\n'));assert.deepEqual(ledger.history.map(h=>h.status),['open','resolved']);assert.equal(ledger.history.at(-1).reviewAttemptId,a.id);
  const calls=f.observer.calls,before=await f.engine.native('owner',f.team.id);await f.engine.settle('owner',f.team.id,1,'review',a.id);assert.equal(f.observer.calls,calls);assert.deepEqual(await f.engine.native('owner',f.team.id),before);
});
test('source-only review reuses original closure arrays and explicit future-check explanations without changing NOT_RUN or rerunning work',async t=>{
  const f=await fixture(t,{stage:'requirements',sourceOnly:true,next:true});await seedOpenFinding(f);await f.submitWork({commands:[]});
  const original={...passed(),checks:[...passed().checks,{name:'Future implementation and browser',status:'NOT_RUN',evidence:'Outside this confirmed contract phase'}],findings:[resolvedFinding()]},submitted=await f.execute('review',original),a=submitted.team.tasks[1].attempts.at(-1),calls=f.observer.calls;
  assert.equal(submitted.team.tasks[0].status,'submitted');assert.match(a.acceptanceException.reason,/unverified/);
  const deferred=[{checkIndex:1,reason:'Confirmed source-only contract scope; implementation and browser checks remain future work'}],done=await f.engine.acceptReview('owner',f.team.id,submitted.team.revision,'review',a.id,'accept','Reuse original independent contract review',[],deferred);
  assert.deepEqual(done.team.tasks[0].attempts.at(-1).observation,submitted.team.tasks[0].attempts.at(-1).observation);assert.deepEqual(done.team.tasks[1].evidence,submitted.team.tasks[1].evidence);assert.equal(done.team.tasks[1].status,'accepted');assert.equal(done.team.tasks[0].status,'accepted');assert.equal(done.team.findings[0].history.length,2);assert.deepEqual(done.team.tasks[1].attempts.at(-1).deferredCheckExplanations.items,deferred);assert.equal(done.team.tasks.find(t=>t.id==='next').status,'waiting');assert.notEqual(done.team.state,'delivered');assert.equal(f.observer.calls,calls);
});
test('upgrade invalidates the old format-error cache once without dispatching or reobserving completed work',async t=>{
  const f=await fixture(t);await seedOpenFinding(f);await f.submitWork();const bound=await f.execute('review',{...passed(),findings:[resolvedFinding()]},{settle:false}),team=structuredClone(bound.team),review=team.tasks[1],a=review.attempts.at(-1),target=team.tasks[0],b=target.attempts.at(-1);
  review.status='submitted';review.evidence.push({attemptId:a.id,summary:JSON.stringify({...passed(),findings:[resolvedFinding()]})});a.observation=f.runs.get(a.marker);
  const oldHash=evidenceHash([a.id,a.turnId,a.observation.commands,review.evidence.at(-1).summary,a.dependencyAttempts,target.status,b.id,b.turnId,target.contractRevision??1,target.contract,target.acceptanceCriteria,b.delivery,b.evidenceSnapshot,team.findings]);
  a.acceptanceException={inputHash:oldHash,reason:'Resolved findings need independent resolution evidence'};assert.notEqual(reviewInputHash(team,review),oldHash);
  const calls=f.observer.calls;assert.equal(await f.engine.validateSubmittedReview(team,review),true);assert.equal(team.tasks[0].status,'accepted');assert.equal(team.tasks[1].attempts.at(-1).acceptanceException,undefined);assert.equal(f.observer.calls,calls);
});

test('current verification failures cannot be hidden by earlier PASS; incidental implementation commands remain trace evidence',async t=>{
  for(const kind of ['later-failure','later-unknown','recovered','incidental'])await t.test(kind,async t=>{
    const f=await fixture(t),good={command:'npm test',status:'completed',exitCode:0},commands=[good];
    commands.push(kind==='incidental'?{command:'rg optional-symbol src',status:'failed',exitCode:1}:{command:'npm test',status:kind==='later-unknown'?'inProgress':'failed',exitCode:kind==='later-unknown'?null:1});if(kind==='recovered')commands.push(good);
    await f.submitWork({commands});const done=await f.execute('review',passed()),accepted=['recovered','incidental'].includes(kind);
    assert.equal(done.team.tasks[0].status,accepted?'accepted':'submitted');assert.equal(done.team.tasks[1].status,accepted?'accepted':'submitted');assert.deepEqual(done.team.tasks[0].attempts[0].observation.commands,commands);
    if(kind==='incidental')assert.equal(done.team.tasks[1].attempts[0].nonContractCommandObservations[0].commandIndex,1);
  });
});
test('stop settlement records completed evidence without reactivating control or dispatching more work',async t=>{
  const f=await fixture(t,{future:true});await f.submitWork();const b=await f.execute('review',phaseVerdict(),{settle:false});
  const stopping=await f.engine.stop('owner',f.team.id,b.team.revision,{requestId:randomUUID(),reason:'User stops the team'});
  const done=await f.engine.settle('owner',f.team.id,stopping.team.revision,'review',b.team.tasks[1].attempts[0].id);
  assert.equal(done.team.state,'stopping');assert.equal(done.team.executionControl.status,'stopping');assert.equal(done.team.dispatchPaused,true);assert.equal(done.team.tasks[0].status,'accepted');assert.equal(done.team.tasks[1].status,'accepted');
  const replay=await f.engine.acceptReview('owner',f.team.id,done.team.revision,'review',b.team.tasks[1].attempts[0].id,'accept','Register');assert.equal(replay.team.state,'stopping');assert.equal(replay.team.dispatchPaused,true);
  assert.equal((await f.engine.native('owner',f.team.id)).state,'stopping');
});
test('ambiguous future ownership requires an explicit contract task; current NOT_RUN can never be moved downstream',async t=>{
  for(const kind of ['ambiguous','explicit','unknown-owner','current'])await t.test(kind,async t=>{
    const f=await fixture(t,{future:true}),team=await f.engine.native('owner',f.team.id);
    await f.engine.store.update(team.id,'owner',team.revision,t=>{const owner=structuredClone(t.tasks[2]),review=structuredClone(t.tasks[3]);owner.id='other_integration';review.id='other_integration_review';review.reviewOfTaskId=owner.id;review.dependencies=[{taskId:owner.id,when:'submitted'}];t.tasks.push(owner,review);});
    await f.submitWork();const v=phaseVerdict();if(kind==='explicit')v.checks[1].futureTaskId='integration';if(kind==='unknown-owner')v.checks[1].futureTaskId='absent';if(kind==='current')v.checks[1].criterionId='AC';
    const done=await f.execute('review',v);assert.equal(done.team.tasks[0].status,kind==='explicit'?'accepted':'submitted');
    if(kind==='explicit')assert.equal(done.team.tasks[1].attempts[0].futureCheckAssociations.items[0].taskId,'integration');
  });
});
test('batch advancement reports partial commits and caches an unchanged malformed terminal without retrying work',async t=>{
  const f=await fixture(t);const bound=await f.execute('work','Malformed original delivery',{settle:false}),first=await f.engine.advance('owner',f.team.id,bound.team.revision,{dispatchReady:true});
  assert.equal(first.advancement.partial,true);assert.equal(first.advancement.errors[0].taskId,'work');assert.equal(first.team.tasks[0].status,'running');assert.equal(first.team.tasks[0].attempts[0].observation.outputs[0].text,'Malformed original delivery');assert.equal(first.team.events.filter(e=>e.type==='settlement-exception').length,1);assert.equal(first.workflow.actions.find(a=>a.taskId==='work').type,'settlement-exception');
  const next=await f.engine.advance('owner',f.team.id,first.team.revision,{dispatchReady:true});assert.equal(next.team.revision,first.team.revision);assert.equal(next.team.tasks[0].attempts.length,1);assert.equal(next.team.tasks[1].attempts.length,0);
  const a=next.team.tasks[0].attempts[0],run=f.runs.get(a.marker);run.outputs[0].text=JSON.stringify({summary:'Correct report from the same completed work',changedPaths:['src/a.mjs'],verificationInputs:['src'],acceptanceResults:[{criterionId:'AC',status:'PASS',evidence:'Original npm test'}]});
  const corrected=await f.engine.advance('owner',f.team.id,next.team.revision);assert.equal(corrected.team.tasks[0].status,'submitted');assert.equal(corrected.team.tasks[0].attempts[0].settlementException,undefined);assert.equal(corrected.team.tasks[0].attempts[0].settlementExceptionHistory[0].observation.outputs[0].text,'Malformed original delivery');assert.equal(corrected.team.tasks[0].attempts.length,1);
});

test('one malformed delivery does not erase a separate successful registration in the same advance batch',async t=>{
  const f=await fixture(t),team=await f.engine.native('owner',f.team.id);await mkdir(join(f.cwd,'docs'));
  await f.engine.store.update(team.id,'owner',team.revision,t=>{
    const member=structuredClone(t.members[0]);Object.assign(member,{id:'doc',role:'Writer',writeScopes:['docs'],agentThreadId:null});t.members.push(member);
    const work=structuredClone(t.tasks[0]);Object.assign(work,{id:'other',memberId:member.id,title:'Independent document'});delete work.contract;delete work.acceptanceCriteria;
    const review=structuredClone(t.tasks[1]);Object.assign(review,{id:'other-review',reviewOfTaskId:work.id,dependencies:[{taskId:work.id,when:'submitted'}]});t.tasks.push(work,review);
  });
  await f.execute('work','Malformed saved result',{settle:false});const bound=await f.execute('other','Independent document complete',{settle:false}),done=await f.engine.advance('owner',f.team.id,bound.team.revision,{dispatchReady:true});
  assert.equal(done.advancement.partial,true);assert.equal(done.advancement.errors.length,1);assert.equal(done.team.tasks.find(t=>t.id==='other').status,'submitted');assert.equal(done.advancement.changes.find(t=>t.taskId==='other').status,'submitted');assert.equal(done.team.tasks.find(t=>t.id==='work').attempts[0].settlementException.source,'plugin-settlement-gate');assert.equal(done.dispatches?.length??0,0);
});
test('saved review dry-run does not authorize a stale commit and unchanged reconciliation is blocked while stopped',async t=>{
  const f=await fixture(t,{future:true}),saved=await seedOldScopeRejection(f,{waiting:true}),input={taskId:'review',attemptId:saved.tasks[1].attempts[0].id,requestId:randomUUID(),note:'Use saved proof'};
  assert.equal((await f.engine.reconcileReview('owner',saved.id,saved.revision,input)).canRegister,true);
  const stopped=await f.engine.stop('owner',saved.id,saved.revision,{requestId:randomUUID(),reason:'User pause'});
  await assert.rejects(()=>f.engine.reconcileReview('owner',saved.id,saved.revision,{...input,dryRun:false}),/Resume|changed/);assert.equal((await f.engine.native('owner',saved.id)).revision,stopped.team.revision);assert.equal((await f.engine.native('owner',saved.id)).tasks[1].status,'waiting');
});

test('cold reload rejects changed scope/report ownership and retains the frozen scope after a downstream contract amendment',async t=>{
 const f=await fixture(t,{future:true});await f.submitWork();const done=await f.execute('review',phaseVerdict()),saved=await f.engine.native('owner',f.team.id);
 const {validateTeam}=await import('../src/team.mjs');
 for(const mutate of [t=>t.requiresTeamWorkspaceVersion='0.30.0',t=>t.tasks[1].attempts[0].futureCheckAssociations.items[0].taskId='work',t=>t.tasks[1].evidence.at(-1).summary=JSON.stringify({...phaseVerdict(),reason:'Different report'}),t=>t.tasks[1].attempts[0].futureCheckAssociations.items[0].dependencyPath[0].dependencies[0].when='submitted']){
  const changed=structuredClone(saved);mutate(changed);assert.throws(()=>validateTeam(changed),/scope|scope audit/);
 }
 const amended=structuredClone(saved);amended.tasks[2].contractRevision=2;amended.tasks[2].acceptanceCriteria=[{id:'G7',description:'Amended later scope'}];assert.doesNotThrow(()=>validateTeam(amended));assert.equal(amended.tasks[1].attempts[0].futureCheckAssociations.items[0].acceptanceCriteria[0].id,'G6');assert.deepEqual(await f.engine.native('owner',f.team.id),saved);
});

test('many incidental errors produce a bounded preview with access to all original command evidence',async t=>{
 const f=await fixture(t,{future:true}),commands=Array.from({length:40},(_,i)=>({command:'rg optional-'+i+' src',status:'failed',exitCode:1})),saved=await seedOldScopeRejection(f,{waiting:true,commands}),preview=await f.engine.reconcileReview('owner',saved.id,saved.revision,{taskId:'review',attemptId:saved.tasks[1].attempts[0].id,requestId:randomUUID(),note:'Read saved exceptions'});
 assert.equal(preview.unresolvedCommandCount,40);assert.equal(preview.unresolvedCommands.length,8);assert.equal(preview.hasMoreCommands,true);assert.equal(preview.evidenceAccess.section,'commands');assert.ok(Buffer.byteLength(JSON.stringify(preview))<6000);assert.equal((await f.engine.native('owner',saved.id)).tasks[1].attempts[0].observation.commands.length,40);
});
