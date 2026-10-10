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

test('legacy coordination clients never obtain a chat offer, including enabled and changed workflows',async()=>{
 const root=await mkdtemp(join(tmpdir(),'coordination-')),a=new TeamCoordination(root),b=new TeamCoordination(root),data=packet();
 await a.store.transaction(d=>{d.teams[a.key('owner',data.team.id)]={enabled:true,notifications:[]};});
 for(const changed of [data,{...data,workflow:{actions:[...data.workflow.actions,{type:'claim-batch',taskIds:['new-task']}]}}]){
   const offers=await Promise.all([a.reserve('owner',changed),b.reserve('owner',changed,{retryId:randomUUID()})]);for(const offer of offers){assert.equal(offer.firstOffer,false);assert.equal(offer.message,undefined);assert.equal(offer.chatMessages,false);}
 }
 assert.equal((await a.enable('owner',data,true)).enabled,false);const state=await new TeamCoordination(root).read('owner',data);assert.equal(state.enabled,false);assert.equal(state.delivery,'native-agent-messages');assert.equal(state.requiresOpenPanel,false);assert.equal(state.panelWakeWithoutWaiter,false);assert.equal(state.waitTool,'wait_team_event');assert.deepEqual(state.notifications,[]);assert.equal(state.signal.actions.length,1);
});
test('native signals do not unlock unapproved, paused, halted, delivered or stale work',async()=>{
 const data=packet();for(const change of [{dispatchPaused:true},{executionControl:{status:'stopping'}},{finalAcceptance:{}},{state:'superseded'},{planReview:{scope:'initial',status:'pending'}}])assert.equal(coordinationSignal({...data,team:{...data.team,...change}}),null);
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


test('legacy notifications remain bounded historical evidence; retries and consumes cannot reissue work',async()=>{
 const root=await mkdtemp(join(tmpdir(),'coordination-history-')),c=new TeamCoordination(root),data=packet(),notifications=Array.from({length:12},()=>({id:randomUUID(),status:'reserved',fingerprint:coordinationSignal(data).fingerprint,createdAt:new Date(0).toISOString()}));
 await c.store.transaction(d=>{d.teams[c.key('owner',data.team.id)]={enabled:true,notifications};});const state=await c.read('owner',data);assert.equal(state.notifications.length,10);assert.ok(state.notifications.every(n=>n.legacy&&!n.retryable));assert.equal((await c.read('foreign',data)).notifications.length,0);assert.equal((await c.reserve('owner',data,{retryId:notifications[0].id})).firstOffer,false);
 const result=await c.consume('owner',data,notifications[0].id);assert.equal(result.stale,true);assert.deepEqual(result.actions,[]);assert.equal((await c.store.read()).teams[c.key('owner',data.team.id)].notifications[0].status,'superseded');assert.equal((await c.store.read()).teams[c.key('owner',data.team.id)].notifications.length,12);
});
