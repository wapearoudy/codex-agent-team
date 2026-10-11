import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {qualityBlockers} from '../src/team-quality.mjs';
import {assertReviewPass} from '../src/quality-gates.mjs';
import {workflowActions} from '../src/team-workflow.mjs';
import {assertReviewTopology,applyQualityDefaults,qualityMetrics} from '../src/quality-policy.mjs';
import {reviewInputHash} from '../src/reviewer-acceptance.mjs';
import {panelTasks,panelResponse} from '../src/panel-response.mjs';
import {teamResponse} from '../src/team-responses.mjs';
import {dependencySatisfied,taskRelationships} from '../src/team-projection.mjs';
import {buildHandoff} from '../src/team-checkpoints.mjs';
import {validatePlan,deliveryReady} from '../src/team.mjs';
import {stageExpansion,expansionCandidate,updateExpansionDraft} from '../src/team-plan-review.mjs';
import {attachBatch,validateBatches} from '../src/team-batches.mjs';

const good=id=>({summary:'Exact candidate checked',decision:'accept',reason:'Required behavior verified',checks:[{name:id,criterionId:id,status:'PASS',evidence:'Saved candidate and native result checked'}],findings:[]});
test('all shipping previews use backend delivery proof; omitted or failed evidence cannot unlock the UI',async t=>{
 const f=await fixture(t),original=await f.deliver('one');
 for(const mutate of [()=>{},task=>{task.attempts.at(-1).delivery.acceptanceResults[0].status='FAIL';},task=>{task.contractRevision++;},task=>{task.attempts.at(-1).observation.status='unknown';},task=>{task.contract.verify=['node required-check.mjs'];}]){
  const data=structuredClone(original),up=data.team.tasks.find(x=>x.id==='one');mutate(up);const expected=deliveryReady(up),frozen=structuredClone(data);
  for(const view of ['panel','state','summary']){
   const response=teamResponse(data,view),projected=response.team.tasks.find(x=>x.id==='one');assert.equal(projected.deliveryReady,expected,view);assert.equal(dependencySatisfied(projected,'delivered'),expected,view);assert.equal(taskRelationships(response.team,response.team.tasks.find(x=>x.id==='two')).waiting.length,expected?0:1,view);
   if(view==='panel')assert.equal(projected.attempts.at(-1).delivery,undefined,'proof is projected without copying raw evidence');
  }
  assert.equal(panelResponse(data,'fixture-token').team.tasks.find(x=>x.id==='one').deliveryReady,expected);assert.equal(teamResponse(data,'full').team,data.team,'explicit full evidence preserves the original object and every saved field');assert.deepEqual(data,frozen,'display projection never rewrites saved evidence');
 }
 assert.equal(dependencySatisfied({status:'submitted',attempts:[{runtimeStatus:'completed'}]},'delivered'),false,'old or missing proof remains waiting');
 const crowded=structuredClone(original);crowded.team.tasks.unshift(...Array.from({length:90},(_,i)=>({id:'historical-'+i,status:'waiting',attempts:[],dependencies:[]})));for(const view of ['panel','state'])assert.ok(teamResponse(crowded,view).team.tasks.some(x=>x.id==='one'&&x.deliveryReady),'light refresh preserves current goal priority beyond preview capacity');
});
async function fixture(t,{mode='standard',autoRepair=false,integrationRequired=false}={}){
 const root=await mkdtemp(join(tmpdir(),'quality-upgrade-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'src'));await writeFile(join(root,'src/a.mjs'),'export const a=1;');
 const runs=new Map(),engine=new LeaderEngine({root:join(root,'records'),observer:{async inspect(_l,_p,thread,marker){const r=runs.get(marker);assert.equal(r.threadId,thread);return structuredClone(r);}}});t.after(()=>engine.close());
 const members=[{id:'dev',role:'Developer',responsibility:'Implement',reason:'Deliver',writeScopes:['src']},{id:'qa',role:'Reviewer',responsibility:'Independent review',reason:'Verify',writeScopes:[]}];
 const old={id:'old',title:'Historical work',goal:'Old requested behavior',acceptance:'Old criteria',memberId:'dev',kind:'work',priority:3,dependencies:[]};
 const oldReview={id:'old-review',title:'Historical review',goal:'Old criteria',acceptance:'Old proof',memberId:'qa',kind:'review',reviewOfTaskId:'old',priority:3,dependencies:[{taskId:'old',when:'submitted'}]};
 let team=await engine.planOnce('owner',{cwd:root,threadId:'leader'},{goal:'Persistent project team',execute:true,policy:{autoRepair},plan:{members,tasks:[old,oldReview]}});
 team=(await engine.store.update(team.id,'owner',team.revision,t=>{t.tasks[0].status='blocked';t.tasks[0].blockReason='Old blocker preserved';})).team;
 const work=id=>({id,title:'Deliver '+id,goal:'Required current behavior '+id,acceptance:'Criterion '+id,acceptanceCriteria:[{id:'AC-'+id,description:'Current behavior '+id}],memberId:'dev',kind:'work',priority:3,validationMode:'source-only',dependencies:[],contract:{stage:'implementation',inScope:['src'],outOfScope:[],verify:[],coverageOf:['G-'+id]}});
 const tasks=mode==='light'?[work('one')]:[work('one'),{...work('two'),dependencies:[{taskId:'one',when:'delivered'}]},{id:'batch-review',title:'Review current feature',goal:'Review both exact deliveries',acceptance:'Both current criteria verified',memberId:'qa',kind:'review',reviewOfTaskId:'one',reviewOfTaskIds:['one','two'],priority:3,dependencies:[{taskId:'one',when:'submitted'},{taskId:'two',when:'submitted'}]}];
 const batch={id:'current',title:'Current feature',goal:'Complete the current feature',qualityMode:mode,goalCriteria:(mode==='light'?['one']:['one','two']).map(id=>({id:'G-'+id,description:'Current goal '+id})),integrationRequired};
 await engine.addTasks('owner',team.id,team.revision,tasks,{batch});
 async function execute(id,output){const latest=await engine.native('owner',team.id),claimed=await engine.claim('owner',team.id,latest.revision,id),d=claimed.dispatch,thread='child-'+id;
  const data=typeof output==='function'?output(d):output;
  runs.set(d.marker,{threadId:thread,turnId:d.attemptId,status:'completed',source:'unit-test-native-observer',outputs:[{text:JSON.stringify({attemptMarker:d.marker,...data})}],commands:[]});const bound=await engine.bind('owner',team.id,claimed.team.revision,id,d.attemptId,thread);return engine.settle('owner',team.id,bound.team.revision,id,d.attemptId);}
 const deliver=id=>execute(id,{summary:'Delivered '+id,changedPaths:['src/a.mjs'],verificationInputs:['src/a.mjs'],acceptanceResults:[{criterionId:'AC-'+id,status:'PASS',evidence:'Exact source inspected'}]});
 const review=async({rework=false,stale=false}={})=>{const t=await engine.native('owner',team.id);return execute('batch-review',{summary:'Reviewed current feature',decision:rework?'rework':'accept',targets:['one','two'].map(id=>({taskId:id,attemptId:stale&&id==='two'?'stale':t.tasks.find(x=>x.id===id).attempts.at(-1).id,...good('AC-'+id),...(rework&&id==='two'?{decision:'rework',reason:'Incorrect second behavior',findings:[{id:'Q1',severity:'high',status:'open',description:'Second behavior contradicts its criterion'}]}:{})}))});};
 return {engine,team,batch,root,deliver,review};
}
test('one standard batch review accepts two exact deliveries; new goal closes without changing historical blockers',async t=>{
 const f=await fixture(t);await f.deliver('one');await f.deliver('two');let result=await f.review();assert.equal(result.team.tasks.find(x=>x.id==='one').status,'accepted');assert.equal(result.team.tasks.find(x=>x.id==='two').status,'accepted');assert.equal(result.team.tasks.find(x=>x.id==='batch-review').attempts.length,1);
 const frozen=structuredClone(result.team.tasks.slice(0,2)),done=await f.engine.finish('owner',f.team.id,result.team.revision,'Current goal complete',[],true,'current');assert.equal(done.team.batches[0].state,'delivered');assert.equal(done.team.state,'active');assert.deepEqual(done.team.tasks.slice(0,2),frozen);assert.equal(workflowActions(done.team).stage,'completed');
 const cold=new LeaderEngine({root:join(f.root,'records')});t.after(()=>cold.close());assert.equal((await cold.native('owner',f.team.id)).tasks.find(x=>x.id==='two').attempts.at(-1).acceptance.batch,true);
 await f.engine.finish('owner',f.team.id,1,'Current goal complete',[],true,'current');
});
test('light delivery uses Leader acceptance with no reviewer dispatch or artificial integration check',async t=>{
 const f=await fixture(t,{mode:'light'}),submitted=await f.deliver('one'),task=submitted.team.tasks.find(x=>x.id==='one');assert.equal(workflowActions(submitted.team).actions[0].type,'accept-light-delivery');
 let accepted=await f.engine.acceptDelivery('owner',f.team.id,submitted.team.revision,task.id,task.attempts.at(-1).id,'Inspected exact source and required result');accepted=await f.engine.finish('owner',f.team.id,accepted.team.revision,'Light goal complete');assert.equal(accepted.team.batches[0].finalAcceptance.metrics.reviewDispatches,0);
});
test('Leader cannot bypass standard review or accept a changed light candidate',async t=>{
 const f=await fixture(t),s=await f.deliver('one'),task=s.team.tasks.find(x=>x.id==='one');await assert.rejects(f.engine.acceptDelivery('owner',f.team.id,s.team.revision,task.id,task.attempts.at(-1).id,'Bypass'),/Only unreviewed light/);
 const l=await fixture(t,{mode:'light'}),r=await l.deliver('one'),a=r.team.tasks.find(x=>x.id==='one').attempts.at(-1);await writeFile(join(l.root,'src/a.mjs'),'export const a=2;');await assert.rejects(l.engine.acceptDelivery('owner',l.team.id,r.team.revision,'one',a.id,'Changed'),/changed after submission/);
});
test('stale or missing per-target batch verdict cannot accept either delivery',async t=>{
 const f=await fixture(t);await f.deliver('one');await f.deliver('two');const r=await f.review({stale:true});assert.equal(r.team.tasks.find(x=>x.id==='one').status,'submitted');assert.equal(r.team.tasks.find(x=>x.id==='two').status,'submitted');assert.match(r.team.tasks.find(x=>x.id==='batch-review').attempts.at(-1).acceptanceException.reason,/exact current attempt/);
});
test('batch rework preserves passed branches and plans one bounded repair with one scoped review',async t=>{
 const f=await fixture(t,{autoRepair:true});await f.deliver('one');await f.deliver('two');const r=await f.review({rework:true});assert.equal(r.team.tasks.find(x=>x.id==='one').status,'accepted');assert.equal(r.team.tasks.find(x=>x.id==='batch-review').status,'accepted');assert.equal(r.team.dispatchPaused,false);const repairs=r.team.tasks.filter(x=>x.repairRootTaskId==='two');assert.equal(repairs.length,1);const next=r.team.tasks.find(x=>x.reviewOfTaskId===repairs[0].id);assert.equal(next.reviewOfTaskIds,undefined);assert.deepEqual(next.dependencies,[{taskId:repairs[0].id,when:'submitted'}]);assert.equal(r.team.findings[0].status,'open');
});
test('explicit batch integration requirement cannot be replaced by a free-form PASS claim',async t=>{
 const f=await fixture(t,{integrationRequired:true});await f.deliver('one');await f.deliver('two');const r=await f.review();await assert.rejects(f.engine.finish('owner',f.team.id,r.team.revision,'Claim',[{name:'Integration',status:'PASS',evidence:'Unbound assertion'}]),/valid integration evidence/);
});
test('batch policy is frozen and strict risks cannot use a shared review',async t=>{
 const f=await fixture(t),s=await f.engine.native('owner',f.team.id);await assert.rejects(f.engine.addTasks('owner',f.team.id,s.revision,[{id:'extra'}],{batch:{...f.batch,qualityMode:'light'}}),/frozen/);
 const task=applyQualityDefaults({id:'risk',kind:'work',qualityMode:'light',riskFlags:['security']});assert.equal(task.qualityMode,'strict');assert.throws(()=>assertReviewTopology({tasks:[task,{id:'review',kind:'review',reviewOfTaskId:'risk',reviewOfTaskIds:['risk','other']}]}),/own independent review/);
});
test('only required current checks block; advisory records remain unchanged and severe findings still block',()=>{
 const v=good('AC');v.checks.push({name:'Future browser',scope:'advisory',status:'BLOCKED',evidence:'Outside the current source contract'});const original=structuredClone(v);assert.equal(assertReviewPass(v,[],[{id:'AC'}],[],{scopedChecks:true}),true);assert.deepEqual(v,original);v.checks[0].scope='advisory';v.checks[0].status='FAIL';assert.throws(()=>assertReviewPass(v,[],[{id:'AC'}],[],{scopedChecks:true}),/unverified/);
 const high=good('AC');high.findings=[{severity:'high',status:'open',description:'Broken authentication'}];assert.throws(()=>assertReviewPass(high,[],[{id:'AC'}],[],{scopedChecks:true}),/Unresolved/);
});
test('known discovery no-match is neutral; required rg checks, unknown failures and rg errors stay blocking',()=>{
 const c={command:'rg optional src',status:'failed',exitCode:1},v=good('AC');assert.equal(assertReviewPass(v,[c]),true);assert.throws(()=>assertReviewPass(v,[c],[],[],{verificationCommands:[c.command]}),/failed command|Declared review/);for(const record of [{...c,exitCode:2},{...c,command:'node validate.mjs'},{...c,command:'rg optional src; npm test'}])assert.throws(()=>assertReviewPass(v,[record]),/failed command/);
});
test('cancelled or unrelated historical requirements do not block current work; actual declared requirements do',()=>{
 const task={id:'new',kind:'work',qualityMode:'standard',dependencies:[],contract:{stage:'implementation'}},old={id:'old',status:'blocked',contract:{stage:'requirements'},dependencies:[]};assert.deepEqual(qualityBlockers({tasks:[old,task]},task),[]);task.dependencies=[{taskId:'old',when:'accepted'}];assert.equal(qualityBlockers({tasks:[old,task]},task).length,1);old.status='cancelled';assert.deepEqual(qualityBlockers({tasks:[old,task]},task),[]);
});

test('batch retry fingerprint includes the second delivery and original verdict cannot be replaced',async t=>{
 const f=await fixture(t);await f.deliver('one');await f.deliver('two');const r=await f.review(),review=r.team.tasks.find(x=>x.id==='batch-review'),before=reviewInputHash(r.team,review),copy=structuredClone(r.team);copy.tasks.find(x=>x.id==='two').attempts.at(-1).delivery.summary='Updated second delivery';assert.notEqual(reviewInputHash(copy,copy.tasks.find(x=>x.id===review.id)),before);
 await assert.rejects(f.engine.store.update(f.team.id,'owner',r.team.revision,team=>{team.tasks.find(x=>x.id===review.id).attempts.at(-1).batchReview.targets[0].reason='Altered receipt';}),/original native verdict/);
});

test('current goal controls handoff and history cannot hide current panel tasks or consume its limit',async t=>{
 const f=await fixture(t),team=await f.engine.native('owner',f.team.id),old=team.tasks[0];team.tasks.push(...Array.from({length:36},(_,i)=>({...structuredClone(old),id:'history-'+i})));assert.equal(validatePlan(team),true);assert.equal(buildHandoff(team,'one').teamGoal,f.batch.goal);assert.deepEqual(buildHandoff(team,'one').goalCriteria,f.batch.goalCriteria);
 const tasks=[...Array.from({length:100},(_,i)=>({id:'old-'+i,status:'blocked'})),...team.tasks.filter(x=>x.batchId==='current')];assert.ok(panelTasks(tasks,'current').some(x=>x.id==='batch-review'));assert.equal(panelTasks(tasks,'current').length,80);
});

test('pending expansion retains its batch goal and mode through edits without changing the active goal',async t=>{
 const f=await fixture(t),team=await f.engine.native('owner',f.team.id),task={...structuredClone(team.tasks.find(x=>x.id==='one')),id:'later',batchId:undefined,qualityMode:'light',contract:{stage:'implementation',inScope:['src'],outOfScope:[],verify:[],coverageOf:['later-goal']}};const batch={id:'later',title:'Next goal',goal:'A distinct authorized goal',qualityMode:'light',goalCriteria:[{id:'later-goal',description:'Next behavior'}]};stageExpansion(team,{tasks:[task],batch});assert.equal(team.activeBatchId,'current');assert.equal(expansionCandidate(team).activeBatchId,'later');updateExpansionDraft(team,{members:[],tasks:[task]});assert.equal(expansionCandidate(team).batches.at(-1).goal,batch.goal);assert.equal(expansionCandidate(team).tasks.at(-1).qualityMode,'light');
});

test('metrics count actual dispatches separately from reservations and report observed duration only',()=>{
 const pending={id:'pending',startedAt:'2026-10-11T00:00:00Z'},done={id:'done',agentThreadId:'native',boundAt:'2026-10-11T00:00:01Z',endedAt:'2026-10-11T00:00:03Z'};const m=qualityMetrics({tasks:[{id:'review',kind:'review',attempts:[pending,done]}],events:[]});assert.equal(m.reviewDispatches,1);assert.equal(m.reservations,2);assert.equal(m.observedExecutionMs,2000);assert.equal(m.timedAttempts,1);
});

test('active historical turns remain visible for settlement but old pending reviews are not restarted',async t=>{
 const f=await fixture(t),team=await f.engine.native('owner',f.team.id),old=team.tasks.find(x=>x.id==='old');old.status='running';old.attempts=[{id:'old-running',state:'running',agentThreadId:'old-native',turnId:'old-turn'}];const actions=workflowActions(team,[{attemptId:'old-running',status:'completed'}]).actions;assert.ok(actions.some(a=>a.type==='settle'&&a.taskId==='old'));assert.ok(!actions.some(a=>a.type==='claim-batch'&&a.taskIds.includes('old-review')));
 const oldReview=team.tasks.find(x=>x.id==='old-review');old.status='blocked';oldReview.status='submitted';oldReview.attempts=[{id:'old-review-attempt'}];await f.engine.store.update(team.id,'owner',team.revision,t=>{t.tasks.find(x=>x.id==='old-review').status='submitted';t.tasks.find(x=>x.id==='old-review').attempts=[{id:'old-review-attempt'}];});const saved=await f.engine.native('owner',team.id),result=await f.engine.advance('owner',team.id,saved.revision,{settleCompleted:false});assert.equal(result.team.tasks.find(x=>x.id==='old-review').attempts[0].acceptanceException,undefined);
});

test('ordinary append inherits the active goal, while completed or unknown goals reject unbound tasks',async t=>{
 const f=await fixture(t,{mode:'light'}),team=await f.engine.native('owner',f.team.id),extra={...structuredClone(team.tasks.find(x=>x.id==='one')),id:'required-extra',batchId:undefined,qualityMode:undefined};const saved=await f.engine.addTasks('owner',team.id,team.revision,[extra]);assert.equal(saved.team.tasks.find(x=>x.id===extra.id).batchId,'current');assert.equal(saved.team.tasks.find(x=>x.id===extra.id).qualityMode,'light');assert.ok(workflowActions(saved.team).actions.some(a=>a.type==='claim-batch'&&a.taskIds.includes('one')));
 const oneComplete=structuredClone(saved.team);oneComplete.tasks.find(x=>x.id==='one').status='accepted';assert.ok(workflowActions(oneComplete).actions.some(a=>a.type==='claim-batch'&&a.taskIds.includes(extra.id)));
 const complete=structuredClone(saved.team);complete.batches[0].state='delivered';assert.throws(()=>attachBatch(complete,[{id:'hidden'}]),/provide a new batch/);assert.throws(()=>attachBatch(saved.team,[{id:'foreign',batchId:'missing'}]),/matching explicit batch/);assert.throws(()=>validateBatches({tasks:[{id:'foreign',batchId:'missing'}]}),/missing goal batch/);
});

test('goal completion cannot hide historical settlement, stopping or a pending scope decision',async t=>{
 const f=await fixture(t),team=await f.engine.native('owner',f.team.id),old=team.tasks.find(x=>x.id==='old');old.status='running';old.attempts=[{id:'history',state:'running',agentThreadId:'real-history',turnId:'history-turn'}];team.batches[0].state='delivered';team.batches[0].finalAcceptance={note:'Unit scenario only'};const runs=[{attemptId:'history',status:'completed'}];let workflow=workflowActions(team,runs);assert.ok(workflow.actions.some(a=>a.type==='settle'&&a.taskId==='old'));assert.ok(!workflow.actions.some(a=>['claim-batch','final-validation'].includes(a.type)));
 team.executionControl={status:'stopping'};assert.equal(workflowActions(team,runs).actions[0].type,'stop-members');team.executionControl={status:'halted'};assert.equal(workflowActions(team,runs).stage,'halted');team.executionControl={status:'active'};team.planReview={scope:'expansion',status:'pending',version:2,hash:'hash'};assert.ok(workflowActions(team,runs).actions.some(a=>a.type==='plan-review'));team.planReview=undefined;old.status='accepted';assert.equal(workflowActions(team,runs).stage,'completed');
});
