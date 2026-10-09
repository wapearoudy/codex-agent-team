import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {TeamCoordination,coordinationSignal} from '../src/team-coordination.mjs';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {ModelCatalog} from '../src/model-catalog.mjs';
import {nativeRoute,TeamProfiles} from '../src/team-policy.mjs';

const member=(id,writeScopes=[])=>({id,role:id,responsibility:'Scoped role',reason:'Independent delivery',writeScopes});
const plan=()=>({members:[member('dev',['src']),member('qa')],tasks:[{id:'work',title:'Implement',goal:'Implement scoped changes',acceptance:'Verified behavior',memberId:'dev',kind:'work',priority:3,dependencies:[]},{id:'review',title:'Review',goal:'Verify independently',acceptance:'Verified behavior',memberId:'qa',kind:'review',reviewOfTaskId:'work',priority:3,dependencies:[{taskId:'work',when:'submitted'}]}]});
const packet=()=>({team:{id:randomUUID(),state:'active',dispatchPaused:false},workflow:{actions:[{type:'settle',taskId:'work',attemptId:randomUUID(),observedStatus:'completed'}]}});

test('workflow notifications reserve once across writers, survive restart and require an explicit retry after unknown delivery',async()=>{
 const root=await mkdtemp(join(tmpdir(),'coordination-')),a=new TeamCoordination(root),b=new TeamCoordination(root),data=packet();await a.enable('owner',data,true);
 const offers=await Promise.all([a.reserve('owner',data),b.reserve('owner',data)]);assert.equal(offers.filter(o=>o.firstOffer).length,1);const first=offers.find(o=>o.firstOffer);
 await b.receipt('owner',data.team.id,{notificationId:first.notification.id,status:'unknown',note:'Timed out'});
 assert.equal((await new TeamCoordination(root).reserve('owner',data)).firstOffer,false);
 const retry=await a.reserve('owner',data,{retryId:first.notification.id});assert.equal(retry.firstOffer,true);assert.notEqual(retry.notification.id,first.notification.id);
 await b.receipt('owner',data.team.id,{notificationId:retry.notification.id,status:'host-accepted'});
 const consumed=await a.consume('owner',data,retry.notification.id);assert.equal(consumed.actions.length,1);assert.equal(consumed.automaticAcceptance,false);assert.deepEqual((await a.consume('owner',data,retry.notification.id)).actions,[]);
 assert.equal((await a.read('other-owner',data)).notifications.length,0);
});
test('workflow wakeups never unlock unapproved, paused, halted, delivered or stale work',async()=>{
 const root=await mkdtemp(join(tmpdir(),'coordination-stale-')),c=new TeamCoordination(root),data=packet();await c.enable('owner',data,true);const offer=await c.reserve('owner',data);
 for(const change of [{dispatchPaused:true},{executionControl:{status:'stopping'}},{finalAcceptance:{}},{state:'superseded'},{planReview:{scope:'initial',status:'pending'}}])assert.equal(coordinationSignal({...data,team:{...data.team,...change}}),null);
 const stale=await c.consume('owner',{...data,workflow:{actions:[{type:'claim-batch',taskIds:['different-task']}]}},offer.notification.id);assert.equal(stale.stale,true);assert.deepEqual(stale.actions,[]);
});
test('return-to-chat preserves the pending plan identity and does not approve, spawn or discard it',async()=>{
 const root=await mkdtemp(join(tmpdir(),'feedback-')),engine=new LeaderEngine({root}),team=await engine.planOnce('owner',{cwd:root,threadId:'leader'},{goal:'Implement the current scoped request',execute:true,initializeMembers:true,approvalMode:'required',plan:plan()});
 const input={requestId:randomUUID(),note:'Please revise the staffing',planVersion:team.planReview.version,planHash:team.planReview.hash};
 const result=await engine.requestPlanFeedback('owner',team.id,team.revision,input);assert.equal(result.review.status,'pending');assert.equal(result.review.feedback.status,'awaiting-user-feedback');assert.equal(result.review.hash,input.planHash);assert.equal((await engine.native('owner',team.id)).members.every(m=>!m.agentThreadId),true);
 const replay=await engine.requestPlanFeedback('owner',team.id,team.revision,input);assert.equal(replay.revision,result.revision);
 await assert.rejects(()=>engine.requestPlanFeedback('owner',team.id,result.revision,{...input,requestId:randomUUID(),planHash:'0'.repeat(64)}),/version changed/);
 const revised=await engine.revisePlan('owner',team.id,result.revision,{...result.configuration,goal:'Updated scoped request for this same team'});assert.equal(revised.teamId,team.id);assert.equal(revised.review.feedback,undefined);assert.equal(revised.review.version,2);
});
test('inherited routes snapshot the host model/provider/effort; native creation stays on that snapshot after host defaults change',async()=>{
 const calls=[],catalog=new ModelCatalog({async connect(){return {async call(method){calls.push(method);return {data:[{model:'host-a',defaultReasoningEffort:'medium',supportedReasoningEfforts:['low','medium']}]};}};}}),members=[member('dev'),{...member('qa'),route:{model:'host-a'},fallbackRoute:{model:'host-a',reasoningEffort:'low'}}];
 await catalog.freeze(members,{modelRoute:{model:'host-a',provider:'provider-a',reasoningEffort:'low'}});
 assert.deepEqual(nativeRoute(members[0]),{fork_turns:'none',model:'host-a',reasoning_effort:'low'});assert.equal(members[0].routeSnapshot.provider,'provider-a');assert.equal(members[1].route.reasoningEffort,'medium');assert.equal(members[1].fallbackRoute.reasoningEffort,'low');
 assert.deepEqual(calls,['model/list']);assert.equal(nativeRoute({...members[0],route:{}}).model,'host-a');
});
test('project history summaries are scoped and profile deletion rejects a changed record',async()=>{
 const root=await mkdtemp(join(tmpdir(),'library-')),engine=new LeaderEngine({root});await engine.planOnce('owner',{cwd:root,threadId:'leader'},{goal:'First project scoped implementation',execute:false,plan:plan()});await engine.planOnce('owner',{cwd:root+'-other',threadId:'leader'},{goal:'Another project scoped implementation',execute:false,plan:plan()});
 assert.equal((await engine.store.summaries('owner',root)).length,1);assert.equal((await engine.store.summaries('foreign',root)).length,0);
 const profiles=new TeamProfiles(root),saved=await profiles.save('dynamic',{members:plan().members},{},'Reusable',{taskPlanning:'leader'});
 await assert.rejects(()=>profiles.remove('dynamic','stale'),/changed/);assert.equal((await profiles.read()).length,1);await profiles.remove('dynamic',saved.updatedAt);assert.equal((await profiles.read()).length,0);
});


test('approved new plans enable notification automatically; a new attempt or resume produces a fresh signal',async()=>{
 const root=await mkdtemp(join(tmpdir(),'coordination-generations-')),c=new TeamCoordination(root),data=packet();data.team.requiresTeamWorkspaceVersion='0.13.0';data.team.planReview={status:'approved',scope:'initial'};data.team.tasks=[{id:'work',memberId:'dev',attempts:[]}];data.workflow.actions=[{type:'claim-batch',taskIds:['work']}];
 assert.equal((await c.read('owner',data)).enabled,true);const first=await c.reserve('owner',data);await c.consume('owner',data,first.notification.id);assert.equal((await c.reserve('owner',data)).firstOffer,false);
 data.team.tasks[0].attempts.push({id:randomUUID()});const retry=await c.reserve('owner',data);assert.equal(retry.firstOffer,true);await c.consume('owner',data,retry.notification.id);
 data.team.executionControl={status:'active',resumedAt:new Date().toISOString()};assert.equal((await c.reserve('owner',data)).firstOffer,true);await c.enable('owner',data,false);assert.equal((await c.reserve('owner',data)).firstOffer,false);
});

test('a crash between reserving and sending a notification exposes an expired offer for explicit recovery only',async()=>{
 const root=await mkdtemp(join(tmpdir(),'coordination-expiry-'));let time=Date.now();const c=new TeamCoordination(root,{clock:()=>time,staleMs:100}),data=packet();await c.enable('owner',data,true);const first=await c.reserve('owner',data);
 await assert.rejects(()=>c.reserve('owner',data,{retryId:first.notification.id}),/expired/);time+=101;
 assert.equal((await c.read('owner',data)).notifications[0].retryable,true);assert.equal((await c.reserve('owner',data)).firstOffer,false);
 const retry=await c.reserve('owner',data,{retryId:first.notification.id});assert.equal(retry.firstOffer,true);assert.equal((await c.consume('owner',data,first.notification.id)).stale,true);
});
