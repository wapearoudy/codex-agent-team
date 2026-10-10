import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {NativeMembers} from '../src/native-members.mjs';
import {normalizeNativeReport} from '../src/native-registration.mjs';
import {assertReviewPass} from '../src/quality-gates.mjs';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'team-native-import-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const runs=new Map(),calls=[],observer={inspect:async(l,c,id,marker,options)=>{calls.push({id,options});const run=structuredClone(runs.get(id));if(!run)throw new Error('Unknown native child');return run;}};
 const engine=new LeaderEngine({root,observer}),owner=engine.store.ownerId('leader');
 const members=[{id:'dev',role:'Developer',responsibility:'Implementation',reason:'Deliver original goal',writeScopes:['src']},{id:'reviewer',role:'Reviewer',responsibility:'Independent review',reason:'Check original goal',writeScopes:[]}];
 const tasks=[{id:'work',kind:'work',memberId:'dev',title:'Work',goal:'Original work',acceptance:'Independent checks pass',dependencies:[]},{id:'review',kind:'review',memberId:'reviewer',title:'Review',goal:'Review exact work',acceptance:'Independent checks pass',dependencies:[{taskId:'work',when:'submitted'}],reviewOfTaskId:'work'}];
 const team=await engine.planOnce(owner,{threadId:'leader',cwd:root},{goal:'Register already executed native work',plan:{members,tasks},execute:true,initializeMembers:true,memberStartup:'on-demand'});
 const entries=[],add=(key,taskId,report,status='completed')=>{
  const threadId=randomUUID(),turnId=randomUUID(),marker='NATIVE_TEAM_TASK:'+key+':date',agentPath='/root/'+key;
  const run={threadId,agentPath,turnId,latestTurnId:turnId,status,outputs:report?[{text:JSON.stringify({taskMarker:marker,...report}),turnId}]:[],commands:[],source:'native-thread-persisted-snapshot',attemptIdentitySource:'explicit-native-registration',observedAt:new Date().toISOString(),connection:'snapshot',parentThreadId:'leader',model:'model'};
  runs.set(threadId,run);const entry={key,taskId,threadId,agentPath,marker,turnIds:[turnId]};entries.push(entry);return entry;
 };
 return {engine,owner,team,entries,add,runs,calls,input:()=>({entries,requestId:randomUUID(),note:'Human authorized restoration; no work rerun'})};
}
test('dry-run verifies exact existing native work without mutating the team; apply and retries count once',async t=>{
 const f=await fixture(t);f.add('delivery','work',{summary:'Actual finished delivery'});const input=f.input(),before=await f.engine.native(f.owner,f.team.id);
 const preview=await f.engine.registerNative(f.owner,f.team.id,before.revision,{...input,dryRun:true});
 assert.equal(preview.team.tasks[0].status,'submitted');assert.deepEqual(await f.engine.native(f.owner,f.team.id),before);
 const saved=await f.engine.registerNative(f.owner,f.team.id,before.revision,input),again=await f.engine.registerNative(f.owner,f.team.id,before.revision,input);
 assert.equal(saved.team.tasks[0].attempts.length,1);assert.equal(again.replayed,true);assert.equal(saved.team.totalDispatches,1);assert.equal(saved.team.ownerId,before.ownerId);assert.equal(saved.team.leaderThreadId,before.leaderThreadId);
 await assert.rejects(f.engine.registerNative(f.owner,f.team.id,before.revision,{...input,note:'Different request contents'}),/different contents/);
 assert.ok(f.calls.every(c=>c.options.registration));
});
test('repair and independent review rounds append to original tasks and preserve exact reviewed attempts',async t=>{
 const f=await fixture(t);const first=f.add('first','work',{summary:'First result'}),review=f.add('review-first','review',{decision:'rework',reason:'Actual defect',findings:[{id:'F1',severity:'HIGH',status:'open',title:'Actual defect',evidence:['Proof']}],checks:[]});
 review.targetKey=first.key;review.reviewDecision={decision:'rework',note:'Existing Leader requested repair'};
 const repaired=f.add('repair','work',{summary:'Repaired, independently unaccepted'}),review2=f.add('review-second','review',null,'inProgress');review2.targetKey=repaired.key;
 const saved=await f.engine.registerNative(f.owner,f.team.id,f.team.revision,f.input()),[work,checks]=saved.team.tasks;
 assert.equal(saved.team.tasks.length,2);assert.equal(work.status,'submitted');assert.equal(work.attempts.length,2);assert.equal(checks.status,'running');assert.equal(checks.attempts[1].dependencyAttempts[0].attemptId,work.attempts[1].id);
 assert.equal(checks.attempts[0].dependencyAttempts[0].attemptId,work.attempts[0].id);assert.equal(work.attempts[0].review.decision,'rework');assert.equal(saved.team.findings[0].severity,'high');assert.equal(saved.team.contextHistory.length,3);
 assert.match(checks.evidence[0].references[0].rawDelivery,/"severity":"HIGH"/);
});
test('a completed execution is never automatically accepted and custom check statuses are not promoted',async t=>{
 const f=await fixture(t);const work=f.add('first','work',{summary:'Done'}),review=f.add('review','review',{decision:'accept',summary:'Source-only conclusion',reason:'Actual narrow boundary',checks:[{name:'Source coverage',status:'PASS_SOURCE',evidence:['Source only']}],findings:[]});review.targetKey=work.key;
 const input=f.input(),preview=await f.engine.registerNative(f.owner,f.team.id,f.team.revision,{...input,dryRun:true});assert.equal(preview.team.tasks[0].status,'submitted');assert.equal(preview.team.tasks[1].status,'submitted');
 review.reviewDecision={decision:'accept',note:'Restore original decision',proofReference:'Saved Leader evidence'};
 await assert.rejects(f.engine.registerNative(f.owner,f.team.id,f.team.revision,{...input,dryRun:true}),/unverified checks/);
 assert.equal((await f.engine.native(f.owner,f.team.id)).tasks[0].attempts.length,0);
});
test('a stale review target or stale revision rolls back the entire batch',async t=>{
 const f=await fixture(t);f.add('first','work',{summary:'Done'});const review=f.add('review','review',{decision:'rework',reason:'Defect',findings:[]});review.targetKey='nonexistent';
 await assert.rejects(f.engine.registerNative(f.owner,f.team.id,f.team.revision,f.input()),/exact submitted/);assert.equal((await f.engine.native(f.owner,f.team.id)).tasks[0].attempts.length,0);
 await assert.rejects(f.engine.registerNative(f.owner,f.team.id,f.team.revision-1,f.input()),/Team changed/);
});
test('lossless format adaptation retains concrete evidence and NOT_RUN statuses',()=>{
 const raw='Prefix\n```json\n'+JSON.stringify({checks:[{status:'NOT_RUN',evidence:['Future browser','Future publish']}],findings:[{id:'F',severity:'HIGH',status:'resolved',resolutionEvidence:['Actual independent proof']}]})+'\n```';
 const v=normalizeNativeReport(raw);assert.equal(v.checks[0].status,'NOT_RUN');assert.equal(v.checks[0].evidence,'Future browser\nFuture publish');assert.equal(v.findings[0].resolutionEvidence,'Actual independent proof');
});
test('explicit native import accepts prefixed delivery while retaining the exact raw report and original task',async t=>{
 const f=await fixture(t),entry=f.add('delivery','work',{summary:'Already completed'}),marker='TEAM_WORKSPACE_ATTEMPT:12345678-1234-1234-1234-123456789abc',run=f.runs.get(entry.threadId);
 entry.marker=marker;const raw=marker+'\n'+JSON.stringify({attemptMarker:marker,summary:'Already completed'});run.outputs[0].text=raw;
 const saved=await f.engine.registerNative(f.owner,f.team.id,f.team.revision,f.input());assert.equal(saved.team.tasks[0].status,'submitted');assert.equal(saved.team.tasks[0].attempts.length,1);assert.equal(saved.team.tasks[0].evidence[0].references[0].rawDelivery,raw);assert.equal(saved.team.tasks[0].evidence[0].summary,raw);assert.equal(saved.team.tasks[1].status,'waiting');
});

test('native import never turns invalid resolution proof into accepted text',()=>{
 for(const resolutionEvidence of [[],['valid',null],['valid',' '],[{claim:'resolved'}],{claim:'resolved'},42]){
  const report={summary:'Checked',decision:'accept',reason:'Review concluded',checks:[{name:'rule',status:'PASS',evidence:'Exact source checked'}],findings:[{id:'F',severity:'high',status:'resolved',description:'Rule',resolutionEvidence}]};
  const normalized=normalizeNativeReport(JSON.stringify(report));assert.deepEqual(normalized.findings[0].resolutionEvidence,resolutionEvidence);assert.throws(()=>assertReviewPass(normalized),/resolution evidence/);
 }
});

async function nativeFixture(t,{parent='leader',predecessor='interrupted',otherMarker=false}={}){
 const cwd=await mkdtemp(join(tmpdir(),'native-link-'));t.after(()=>rm(cwd,{recursive:true,force:true}));const calls=[];
 const marker='NATIVE_TEAM_TASK:work:date',threadId='child',agentPath='/root/work',turns=[{id:'old',status:predecessor,items:[]},{id:'new',status:'completed',items:[{type:'agentMessage',phase:'final_answer',text:JSON.stringify({taskMarker:otherMarker?'NATIVE_TEAM_TASK:other:date':marker,summary:'Finished without rerun'})}]}];
 const meta={id:threadId,cwd,parentThreadId:parent,source:{subAgent:{thread_spawn:{agent_path:agentPath}}}};
 const rpc={connect:async()=>{},close:async()=>{},call:async(method,params)=>{calls.push({method,params});assert.equal(method,'thread/read');return {thread:params.includeTurns?{...meta,turns}:meta};}};
 const observer=new NativeMembers({rpcFactory:()=>rpc,lifecycleReader:async()=>({status:'interrupted',source:'persisted-turn-aborted',at:new Date().toISOString()}),publicFeed:{read:async()=>({events:[],cursor:0})}});
 return {observer,cwd,threadId,marker,calls,registration:{source:'explicit-native-registration',threadId,agentPath,marker,turnIds:['old','new']}};
}
test('explicit native association retains interrupted predecessor and current final delivery without marker in old prompt',async t=>{
 const f=await nativeFixture(t),run=await f.observer.inspect('leader',f.cwd,f.threadId,f.marker,{registration:f.registration});assert.equal(run.turnId,'new');assert.equal(run.turnHistory.length,2);assert.equal(run.turnHistory[0].status,'interrupted');assert.equal(run.turnAssociation.marker,f.marker);assert.equal(run.attemptIdentitySource,'explicit-native-registration');assert.deepEqual(f.calls.map(c=>c.method),['thread/read','thread/read']);
});
test('native association refuses completed predecessors, another marker and missing turns',async t=>{
 for(const options of [{predecessor:'completed'},{otherMarker:true}]){const f=await nativeFixture(t,options);await assert.rejects(f.observer.inspect('leader',f.cwd,f.threadId,f.marker,{registration:f.registration}),/identity|another task/);}
 const f=await nativeFixture(t);await assert.rejects(f.observer.inspect('leader',f.cwd,f.threadId,f.marker,{registration:{...f.registration,turnIds:['missing']}}),/missing/);
});
test('foreign child metadata is rejected before reading its public turns',async t=>{
 const f=await nativeFixture(t,{parent:'someone-else'});await assert.rejects(f.observer.inspect('leader',f.cwd,f.threadId,f.marker,{registration:f.registration}),/not a native child/);assert.equal(f.calls.length,1);assert.equal(f.calls[0].params.includeTurns,false);
});

test('historical native import uses the same downstream review scope without altering the saved report or accepting future work',async t=>{
 const f=await fixture(t);await f.engine.store.update(f.team.id,f.owner,f.team.revision,t=>{
  t.tasks[0].validationMode='source-only';t.tasks[0].acceptanceCriteria=[{id:'AC',description:'Source behavior'}];t.tasks[0].contract={stage:'implementation',inScope:['src'],outOfScope:[],verify:[],coverageOf:[]};
  const future=structuredClone(t.tasks[0]);Object.assign(future,{id:'integration',title:'Joint integration',dependencies:[{taskId:'work',when:'accepted'}],acceptanceCriteria:[{id:'G6',description:'Future real execution'}]});const review=structuredClone(t.tasks[1]);Object.assign(review,{id:'integration-review',reviewOfTaskId:future.id,dependencies:[{taskId:future.id,when:'submitted'}]});t.tasks.push(future,review);
 });
 const work=f.add('original-delivery','work',{summary:'Completed source phase',changedPaths:[],acceptanceResults:[{criterionId:'AC',status:'PASS',evidence:'Saved source verification'}]}),entry=f.add('original-review','review',{summary:'Source phase passed',decision:'accept',reason:'Actual source verified; integration belongs downstream',checks:[{name:'Current',criterionId:'AC',status:'PASS',evidence:'Saved exact source review'},{name:'Integration',criterionId:'G6',status:'NOT_RUN',evidence:'Future task owns actual execution'}],findings:[]});entry.targetKey=work.key;entry.reviewDecision={decision:'accept',note:'Restore the original independent conclusion',proofReference:'Saved original Leader decision receipt'};
 const team=await f.engine.native(f.owner,f.team.id),raw=f.runs.get(entry.threadId).outputs[0].text,saved=await f.engine.registerNative(f.owner,f.team.id,team.revision,f.input());
 assert.equal(saved.team.tasks[0].status,'accepted');assert.equal(saved.team.tasks[1].status,'accepted');assert.equal(saved.team.tasks[2].status,'waiting');assert.equal(saved.team.tasks[1].attempts[0].futureCheckAssociations.items[0].taskId,'integration');assert.equal(saved.team.tasks[1].evidence[0].references[0].rawDelivery,raw);
 const cold=await f.engine.native(f.owner,f.team.id);assert.equal(cold.tasks[0].status,'accepted');
});
