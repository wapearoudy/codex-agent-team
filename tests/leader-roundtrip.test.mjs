import test from 'node:test';
import assert from 'node:assert/strict';
import {cachedStepProjection,runCachedLeaderStep} from '../src/cached-step.mjs';
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
function fixture(){
 const cache=new Map(),calls=[],shown=[];
 const api={tools:{exact__team_leader:async call=>{calls.push(call);return {structuredContent:{teamId:'team',revision:7}};}},ALL_TOOLS:[{name:'exact__team_leader'}],store:(k,v)=>cache.set(k,structuredClone(v)),load:k=>cache.get(k),text:v=>shown.push(v),notify:()=>{},exit:()=>{}};
 const project=v=>cachedStepProjection(v,api);
 const page={path:'README.md',taskId:'work',startLine:1,endLine:2,totalLines:2,cursor:'original',hasMore:false,text:'complete actual source\n'.repeat(80)};
 const payload={teamId:'team',revision:1,leaderExecution:{teamId:'team',sourceInputs:{pages:[page],complete:true},contract:{verify:['required test']},acceptanceCriteria:[{id:'AC',description:'Full criterion'}],workContext:{openFindings:[{id:'real',status:'open'}]}}};
 return {api,cache,calls,shown,payload,page,project,invoke:source=>new AsyncFunction(...Object.keys(api),source)(...Object.values(api))};
}
test('identical complete source is referenced locally while changed bytes, gates and current cursors remain exact',async()=>{
 const f=fixture(),before=structuredClone(f.payload),first=f.project(f.payload);assert.equal(first.leaderExecution.sourceInputs.pages[0].text,f.page.text);
 const next=structuredClone(f.payload);next.revision=2;next.leaderExecution.sourceInputs.pages[0].taskId='repair';next.leaderExecution.sourceInputs.pages[0].cursor='current-authorized-cursor';
 const view=f.project(next),page=view.leaderExecution.sourceInputs.pages[0];assert.equal(page.text,undefined);assert.equal(page.textAlreadyShown,true);assert.equal(page.cursor,'current-authorized-cursor');assert.deepEqual(view.leaderExecution.contract,f.payload.leaderExecution.contract);assert.deepEqual(view.leaderExecution.workContext,f.payload.leaderExecution.workContext);
 assert.ok(JSON.stringify(view).length<JSON.stringify(next).length);await f.invoke(page.textReference.invocation);assert.equal(f.shown.at(-1),f.page.text);assert.deepEqual(f.payload,before);assert.equal(f.calls.length,0);
 next.leaderExecution.sourceInputs.pages[0].text='changed source';assert.equal(f.project(next).leaderExecution.sourceInputs.pages[0].text,'changed source');
});
test('new conversation, different team, incomplete/error pages and unknown cursor never suppress evidence',()=>{
 const f=fixture();f.project(f.payload);
 for(const patch of [{hasMore:true},{error:'cannot read'},{cursor:null}]){const p=structuredClone(f.payload);Object.assign(p.leaderExecution.sourceInputs.pages[0],patch);assert.equal(f.project(p).leaderExecution.sourceInputs.pages[0].text,f.page.text);}
 const foreign={...f.payload,teamId:'different'};assert.equal(f.project(foreign).leaderExecution.sourceInputs.pages[0].text,f.page.text);
 const fresh=fixture();assert.equal(fresh.project(f.payload).leaderExecution.sourceInputs.pages[0].text,f.page.text);
 assert.equal(cachedStepProjection(f.payload).leaderExecution.sourceInputs.pages[0].text,f.page.text);
});
test('evicted source references fail explicitly rather than reading a reused index',async()=>{
 const f=fixture();f.project(f.payload);const ref=f.project(f.payload).leaderExecution.sourceInputs.pages[0].textReference;
 for(let i=0;i<25;i++){const p=structuredClone(f.payload);p.leaderExecution.sourceInputs.pages[0].text='new '+i;f.project(p);}
 await assert.rejects(()=>f.invoke(ref.invocation),/cache missing/);assert.equal(f.calls.length,0);
});
test('only identical static recipes are deduplicated; quality decisions, original evidence and dispatch are always shown',()=>{
 const f=fixture(),payload={teamId:'team',evidenceAccess:{tool:'read_team_context'},briefAccess:{tool:'manage_team'},nativeDispatchInstruction:'exact launch instruction',actions:[{type:'review-exception',reason:'Real gap'}],dispatches:[{nativeAction:{tool:'spawn_agent',arguments:{message:'full exact original prompt'}}}],originalEvidence:{failed:'preserved'},usage:{exhausted:true}};
 f.project(payload);const view=f.project(payload);assert.deepEqual(view.retainedProtocol.fields,['briefAccess','evidenceAccess','nativeDispatchInstruction']);
 for(const key of ['actions','dispatches','originalEvidence','usage'])assert.deepEqual(view[key],payload[key]);assert.deepEqual(f.cache.get('teamProjection:team').protocol.evidenceAccess,payload.evidenceAccess);
 payload.evidenceAccess={tool:'changed'};assert.deepEqual(f.project(payload).evidenceAccess,payload.evidenceAccess);
});
test('repair transport never advances past blocked decisions, pending launch, budget or changed identity',async()=>{
 for(const patch of [{requiresLeaderAction:true},{requiresUserDecision:true},{waitBlocked:true},{terminal:true},{dispatches:[{nativeAction:'exact'}]},{leaderExecution:{readyForWork:true}},{usage:{exhausted:true}},{usage:{unverifiable:true}},{teamId:'foreign'}]){
  const f=fixture();f.api.tools.exact__team_leader=async call=>{f.calls.push(call);return {structuredContent:{teamId:'team',revision:7,...patch}};};
  await runCachedLeaderStep(f.api,'plan_team_repair',{teamId:'team',revision:6});assert.equal(f.calls.length,1);
 }
 const f=fixture();await runCachedLeaderStep(f.api,'rework_team_task',{teamId:'team',revision:6});assert.equal(f.calls.length,1);
});
test('lost/failed advancement preserves the successful repair mutation and never repeats it within the transport',async()=>{
 const f=fixture();f.api.tools.exact__team_leader=async call=>{f.calls.push(call);return call.operation==='plan_team_repair'?{structuredContent:{teamId:'team',revision:7,originalEvidence:{interruption:'kept'}}}:{isError:true,content:[{type:'text',text:'Real host error'}]};};
 await runCachedLeaderStep(f.api,'plan_team_repair',{teamId:'team',revision:6});assert.deepEqual(f.calls.map(c=>c.operation),['plan_team_repair','next_team_step']);assert.equal(f.calls[1].arguments.wait,undefined);assert.equal(f.calls[1].arguments.finishReady,false);assert.equal(f.cache.get('teamStep').revision,7);assert.equal(f.cache.get('teamRepairReceipt').originalEvidence.interruption,'kept');assert.equal(f.shown.at(-1).repairSaved,true);
});
test('recovering the same active identity retains factual assessment; a different attempt clears it',async()=>{
 const f=fixture(),identity={teamId:'team',taskId:'work',attemptId:'original'},draft={summary:'Current source assessment',limitations:['Original interruption preserved']};
 f.api.store('teamDeliveryIdentity',identity);f.api.store('teamDelivery',draft);
 let execution={readyForWork:true,reportArguments:identity};
 f.api.tools.exact__team_leader=async()=>({structuredContent:{teamId:'team',revision:7,leaderExecution:execution}});
 await runCachedLeaderStep(f.api,'next_team_step',{teamId:'team',revision:6});assert.deepEqual(f.api.load('teamDelivery'),draft);
 execution={readyForWork:true,reportArguments:{...identity,attemptId:'new'}};
 await runCachedLeaderStep(f.api,'next_team_step',{teamId:'team',revision:7});assert.equal(f.api.load('teamDelivery'),null);
});
