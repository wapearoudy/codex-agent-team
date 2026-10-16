import test from 'node:test';
import assert from 'node:assert/strict';
import {projectContextAssociations} from '../src/context-association.mjs';
import {usageReport} from '../src/team-policy.mjs';
import {registrationGap} from '../src/registration-gap.mjs';
const at=Date.parse('2026-10-13T00:00:00Z');
const fixture=()=>({id:'team',state:'active',members:[{id:'dev'}],tasks:[{id:'work',memberId:'dev',status:'running',attempts:[{id:'attempt',state:'reserved',startedAt:new Date(at).toISOString(),bootstrap:{taskName:'dev_ctx_1_exact_attempt'}}]}]});
const child={threadId:'child',kind:'unregistered-native',agentPath:'/root/dev_ctx_1_exact_attempt',createdAt:at,usage:{totalTokens:100},complete:true};

test('unique reserved launch is pending before bootstrap, with no inferred authority or mutation',()=>{
 const team=fixture(),saved=structuredClone(team),contexts=projectContextAssociations(team,[child],{nowMs:at+1000});
 assert.equal(contexts[0].association.status,'starting');assert.equal(contexts[0].association.taskId,'work');assert.equal(contexts[0].association.executionAuthority,false);
 const gap=registrationGap({unregisteredNativeCount:1,contexts});assert.equal(gap.count,0);assert.equal(gap.pendingCount,1);assert.deepEqual(gap.threadIds,[]);assert.deepEqual(team,saved);
});
test('startup grace is bounded; paused, unrelated, reused and ambiguous paths remain actionable',()=>{
 const team=fixture(),classify=(contexts,nowMs=at+1000)=>projectContextAssociations(team,contexts,{nowMs}).map(c=>c.association.status);
 assert.deepEqual(classify([child],at+120000),['startup-overdue']);
 team.dispatchPaused=true;assert.deepEqual(classify([child]),['startup-paused']);team.dispatchPaused=false;
 assert.deepEqual(classify([{...child,agentPath:'/other/dev_ctx_1_exact_attempt'}]),['unmapped']);
 assert.deepEqual(classify([{...child,createdAt:at-2000}]),['unmapped']);
 assert.deepEqual(classify([child,{...child,threadId:'duplicate'}]),['ambiguous','ambiguous']);
 team.tasks[0].status='waiting';assert.deepEqual(classify([child]),['unmapped']);
});
test('completed binding immediately reprojects a stale accounting snapshot without dropping token cost or history',()=>{
 const team=fixture();team.tasks[0].attempts[0].agentThreadId='child';
 const accounting={contexts:[child],complete:true,discoveryComplete:true},copy=structuredClone(accounting),usage=usageReport(team,[],accounting);
 assert.equal(usage.totalTokens,100);assert.equal(usage.memberTokens,100);assert.equal(usage.unregisteredNativeCount,0);assert.equal(registrationGap(usage),null);assert.deepEqual(accounting,copy);
 delete team.tasks[0].attempts[0].agentThreadId;team.contextHistory=[{threadId:'child'}];assert.equal(usageReport(team,[],accounting).unregisteredNativeCount,0);
});
