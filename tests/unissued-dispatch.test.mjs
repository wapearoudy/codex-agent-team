import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,readFile,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {NativeMembers} from '../src/native-members.mjs';
import {NativePublicFeed} from '../src/native-public.mjs';
import {nativeLaunchIntent} from '../src/native-launch-intent.mjs';
import {requestStop} from '../src/team-control.mjs';
import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import {dispatchReference} from '../src/dispatch-reference.mjs';
import {workflowActions} from '../src/team-workflow.mjs';
import {advancementResponse} from '../src/team-responses.mjs';
import {waitTeamEvent} from '../src/team-events.mjs';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'unissued-dispatch-')),cwd=join(root,'project');await mkdir(cwd);t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'leader.jsonl');await writeFile(path,JSON.stringify({type:'session_meta',payload:{id:'leader'}})+'\n');
 const threads=new Map([['leader',{id:'leader',cwd,path,turns:[]}]]),lookup={complete:true,ids:[]},observer=new NativeMembers({publicFeed:new NativePublicFeed({sessionsRoot:root}),identityLookup:async()=>structuredClone(lookup),rpcFactory:()=>({async connect(){},async close(){},async call(method,{threadId}){return {thread:structuredClone(threads.get(threadId))};}})}),engine=new LeaderEngine({root:join(root,'records'),observer});t.after(()=>engine.close());
 const team=await engine.planOnce('owner',{cwd,threadId:'leader'},{execute:true,goal:'Implement and independently review the goal',plan:{members:[{id:'dev',role:'Developer',responsibility:'Implement',reason:'Work',writeScopes:[]},{id:'qa',role:'QA',responsibility:'Independent audit',reason:'Review',writeScopes:[]}],tasks:[{id:'work',title:'Work',goal:'Business',acceptance:'Verified',kind:'work',memberId:'dev',dependencies:[]},{id:'qa',title:'QA',goal:'Independent inspection',acceptance:'Evidence',kind:'review',memberId:'qa',reviewOfTaskId:'work',dependencies:[{taskId:'work',when:'submitted'}]}]}}),claimed=await engine.claim('owner',team.id,team.revision,'work'),reference=await dispatchReference(engine.root,claimed.dispatch);
 return {root,cwd,path,threads,lookup,observer,engine,team,claimed,reference,saved:()=>engine.native('owner',team.id),append:r=>appendFile(path,JSON.stringify(r)+'\n')};
}
test('a proven unissued launch returns the exact immutable native action with no new attempt, tests or binding',async t=>{
 const f=await fixture(t),before=await f.saved(),run=await f.observer.inspectStartup(before,before.tasks[0]);assert.equal(run.status,'not-started');assert.equal(run.launchIntent.verified,true);assert.equal(run.executionAuthority,false);
 const result=await f.engine.advance('owner',f.team.id,before.revision,{dispatchReady:true}),packet=result.dispatches[0];assert.equal(packet.recoveredUnissuedLaunch,true);assert.deepEqual(packet.nativeAction,f.reference.nativeAction);assert.equal(packet.dispatchReference.sha256,f.reference.dispatchReference.sha256);assert.equal(packet.attemptId,f.claimed.dispatch.attemptId);assert.deepEqual(await f.saved(),before);
 const again=await f.engine.advance('owner',f.team.id,before.revision,{dispatchReady:true});assert.deepEqual(again.dispatches[0].nativeAction,packet.nativeAction);assert.equal(again.team.tasks[0].attempts.length,1);assert.equal(again.team.totalDispatches,0);
 await f.append({type:'response_item',payload:{type:'function_call',name:'collaboration.spawn_agent',call_id:'actual-launch',arguments:JSON.stringify({task_name:packet.taskName,message:'PRIVATE NEVER EXPORTED',fork_turns:'none'})}});
 const pending=await f.engine.advance('owner',f.team.id,before.revision,{dispatchReady:true});assert.equal(pending.dispatches?.length??0,0,'An issued/in-flight call with no indexed child is unknown, never permission to launch twice');
});
test('an original old-version transport hash remains uniquely addressable without rewriting its immutable reference',async t=>{
 const f=await fixture(t),folder=join(f.engine.root,'dispatches',f.team.id,f.claimed.dispatch.attemptId),original=JSON.parse(await readFile(f.reference.dispatchReference.path,'utf8'));original.dispatchHash='legacy-transport-hash';const body=JSON.stringify(original),hash=createHash('sha256').update(body).digest('hex');await rm(f.reference.dispatchReference.path);await rm(f.reference.dispatchReference.promptPath);await writeFile(join(folder,hash+'.json'),body);await writeFile(join(folder,hash+'.txt'),original.prompt);const before=await f.saved();
 const recovered=await f.engine.advance('owner',f.team.id,before.revision,{dispatchReady:true});assert.equal(recovered.dispatches[0].dispatchReference.sha256,hash);assert.equal(await readFile(join(folder,hash+'.json'),'utf8'),body);assert.deepEqual((await readdir(folder)).filter(f=>f.endsWith('.json')),[hash+'.json']);assert.deepEqual(await f.saved(),before);
});
test('incomplete history, existing children, changed immutable packets and controls never replay a launch',async t=>{
 for(const bad of ['issued','compacted','malformed','unknown-index','child-index','tampered','paused','stopping'])await t.test(bad,async t=>{
  const f=await fixture(t);
  if(bad==='issued')await f.append({type:'response_item',payload:{type:'function_call',name:'collaboration.spawn_agent',arguments:JSON.stringify({task_name:f.claimed.dispatch.taskName})}});
  if(bad==='compacted')await f.append({type:'compacted',timestamp:new Date().toISOString(),payload:{}});
  if(bad==='malformed')await appendFile(f.path,'{"type":"response_item","payload":{"type":"function_call"\n');
  if(bad==='unknown-index')f.lookup.complete=false;if(bad==='child-index')f.lookup.ids=['not-yet-visible-child'];
  if(bad==='tampered')await writeFile(f.reference.dispatchReference.path,'{}');
  let saved=await f.saved();if(['paused','stopping'].includes(bad)){await f.engine.store.update(f.team.id,'owner',saved.revision,t=>{if(bad==='paused')t.dispatchPaused=true;else requestStop(t,{requestId:randomUUID(),reason:'Pause exact native startup'});});saved=await f.saved();}
  const result=await f.engine.advance('owner',f.team.id,saved.revision,{dispatchReady:true});assert.equal(result.dispatches?.length??0,0,bad);assert.equal((await f.saved()).tasks[0].attempts.length,1);assert.equal((await f.saved()).totalDispatches,0);
 });
});
test('launch intent exports only call identity, excludes unrelated calls, and rejects ambiguous metadata layouts',async t=>{
 const f=await fixture(t),thread=f.threads.get('leader');await f.append({type:'response_item',payload:{type:'reasoning',summary:[{text:'PRIVATE REASONING MUST NEVER BE EXPORTED'}]}});await f.append({type:'response_item',payload:{type:'function_call',name:'collaboration.spawn_agent',call_id:'other',arguments:JSON.stringify({task_name:'other',message:'SECRET PROMPT'})}});
 await f.append({type:'world_state',payload:{private:'NEVER EXPORTED'}});await f.append({type:'token_usage_record',payload:{count:1}});
 const proof=await nativeLaunchIntent(thread,{sessionsRoot:f.root,taskName:f.claimed.dispatch.taskName});assert.equal(proof.verified,true);assert.equal(proof.launchCallObserved,false);assert.doesNotMatch(JSON.stringify(proof),/SECRET|PRIVATE/);
 await f.append({type:'response_item',payload:{name:'collaboration.spawn_agent',arguments:'x'.repeat(600),type:'function_call'}});assert.equal((await nativeLaunchIntent(thread,{sessionsRoot:f.root,taskName:f.claimed.dispatch.taskName})).verified,false);
 assert.equal((await nativeLaunchIntent({...thread,id:'foreign'},{sessionsRoot:f.root,taskName:'anything'})).verified,false);
});

test('a legacy warm-member followup cannot be inferred unissued from an absent spawn call',async t=>{
 const f=await fixture(t),team=await f.saved();team.members[0].agentThreadId='warm-existing-child';team.members[0].agentPath='/root/warm';
 await assert.rejects(()=>f.observer.inspectStartup(team,team.tasks[0]));
});
test('one authenticated recent spawn waits for its index without replay; fixed expiry and incomplete identity cannot extend it',async t=>{
 const f=await fixture(t),before=await f.saved();await f.append({type:'response_item',timestamp:new Date().toISOString(),payload:{type:'function_call',name:'collaboration.spawn_agent',call_id:'original-once',arguments:JSON.stringify({task_name:f.claimed.dispatch.taskName})}});
 const data=await f.engine.read('owner',f.team.id),run=data.runs[0];assert.equal(run.source,'native-observed-launch');assert.equal(run.threadId,undefined);assert.equal(run.executionAuthority,false);assert.equal(run.noIndexedChild,true);assert.equal(data.workflow.actions[0].requiresLeaderValidation,undefined);assert.ok(advancementResponse(data,'coordination',{includeWaitProgram:true}).waitInvocation);assert.deepEqual(await f.saved(),before);
 for(const mutate of [r=>r.observedAt=new Date(Date.parse(r.launchIntent.calls[0].at)+120000).toISOString(),r=>r.launchIntent.calls[0].at=null,r=>r.launchIntent.calls[0].callId=null,r=>r.launchIntent.calls.push({...r.launchIntent.calls[0]}),r=>r.launchIntent.verified=false,r=>r.launchIntent.parentThreadId='foreign',r=>r.agentPath='/root/foreign',r=>r.noIndexedChild=false]){const invalid=structuredClone(run);mutate(invalid);const flow=workflowActions(data.team,[invalid]);assert.equal(flow.actions[0].requiresLeaderValidation,true);assert.equal(advancementResponse({...data,runs:[invalid],workflow:flow}).waitInvocation,undefined);}
 const expired=structuredClone(run);expired.observedAt=new Date(Date.parse(run.launchIntent.calls[0].at)+120000).toISOString();const workflow=workflowActions(data.team,[expired]);
 const event=await waitTeamEvent(f.engine.store,'owner',f.team.id,{revision:before.revision,timeoutMs:20,observe:async()=>({...data,runs:[expired],workflow})});assert.equal(event.status,'startup-unconfirmed');assert.equal(event.waitBlocked,true);assert.equal(event.automaticAcceptance,false);assert.deepEqual(await f.saved(),before);
});
