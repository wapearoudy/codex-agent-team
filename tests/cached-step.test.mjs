import test from 'node:test';
import assert from 'node:assert/strict';
import {cachedStepProjection,cachedLeaderStepProgram,cachedLeaderEntryProgram} from '../src/cached-step.mjs';
import {coordinationWaitTransport} from '../src/coordination-transport.mjs';
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
function fixture(){
 const cache=new Map(),outputs=[],calls=[];
 const payload={kind:'team-advancement',teamId:'team',revision:3,requiresLeaderAction:false,openFindings:[{id:'defect',severity:'high',status:'open',description:'Real defect'}],leaderExecution:{kind:'leader-execution',teamId:'team',revision:3,taskId:'task',attemptId:'attempt',readyForWork:true,contract:{verify:['exact original check'],inScope:['source.py']},acceptanceCriteria:[{id:'AC',description:'Full business criterion'}],sourceInputs:{pages:[{text:'actual source\nactual invalid case'}]},workContext:{findings:['original finding']},submissionProgram:"text({submitted:'exact-original'});"},...coordinationWaitTransport({teamId:'team',revision:3,wait:true})};
 payload.leaderExecution.reportArguments={teamId:'team',taskId:'task',attemptId:'attempt'};
 const api={tools:{exact__team_leader:async call=>{calls.push(call);return {structuredContent:payload};}},ALL_TOOLS:[{name:'exact__team_leader'}],text:v=>outputs.push(v),store:(k,v)=>{assert.notEqual(v,undefined,'The real host rejects undefined stored values');assert.doesNotThrow(()=>JSON.stringify(v));return cache.set(k,v);},load:k=>cache.get(k),notify:()=>{},exit:()=>{}};
 const run=source=>new AsyncFunction(...Object.keys(api),source)(...Object.values(api));
 return {cache,outputs,calls,payload,api,run};
}
test('cache entry calls once, preserves full reply and removes only repeated executable sources',async()=>{
 const f=fixture();await f.run(cachedLeaderStepProgram('start_team_goal',{requestId:'exact'}));
 assert.deepEqual(f.calls,[{operation:'start_team_goal',arguments:{requestId:'exact'}}]);assert.equal(f.cache.get('teamStep'),f.payload);
 const visible=f.outputs.at(-1);assert.equal(visible.waitProgram,undefined);assert.equal(visible.leaderExecution.submissionProgram,undefined);
 for(const key of ['contract','acceptanceCriteria','sourceInputs','workContext'])assert.deepEqual(visible.leaderExecution[key],f.payload.leaderExecution[key]);
 assert.deepEqual(visible.openFindings,f.payload.openFindings);assert.ok(JSON.stringify(visible).length<JSON.stringify(f.payload).length);
 await f.run(visible.leaderExecution.submissionInvocation);assert.equal(f.outputs.at(-1).submitted,'exact-original');
});
test('cached invocation rejects missing, other-team, later revision and other-attempt stores without any tool call',async()=>{
 for(const change of [undefined,{teamId:'other'},{revision:4},{taskId:'other'},{attemptId:'other'}]){
  const f=fixture(),visible=cachedStepProjection(f.payload);f.cache.set('teamStep',change===undefined?undefined:{...f.payload,leaderExecution:{...f.payload.leaderExecution,...change}});
  await assert.rejects(()=>f.run(visible.leaderExecution.submissionInvocation),/missing or superseded/);assert.equal(f.calls.length,0);
 }
});
test('cached wait keeps exact cold-cache fallback, cursor, controls, independent dispatch and full evidence',async()=>{
 const f=fixture();await f.run(cachedLeaderStepProgram('next_team_step',{teamId:'team',revision:3}));const visible=f.outputs.at(-1);
 const next={teamId:'team',revision:4,requiresLeaderAction:true,dispatches:[{nativeAction:{tool:'spawn_agent',arguments:{message:'EXACT_QA',fork_turns:'none'}}}],originalEvidence:{failed:['keep original log'],interrupted:['keep interrupted turn']}};
 f.api.tools.exact__team_leader=async call=>{f.calls.push(call);return {structuredContent:next};};
 await f.run(visible.waitInvocation);assert.deepEqual(f.calls.at(-1).arguments,{teamId:'team',revision:3,wait:true,refreshRevision:true});assert.deepEqual(f.outputs.at(-1).dispatches,next.dispatches);assert.deepEqual(f.outputs.at(-1).originalEvidence,next.originalEvidence);assert.equal(f.cache.get('teamStep'),next);
});
test('stale binding cache refers to exact current identity before running the saved start',async()=>{
 const f=fixture(),execution={kind:'leader-execution',teamId:'team',taskId:'repair',attemptId:'repair-1',readyForWork:false,nextRead:{program:"text({bound:'repair-1'});",arguments:{teamId:'team',taskId:'repair',attemptId:'repair-1'}}};
 const visible=cachedStepProjection(execution);assert.equal(visible.nextRead.program,undefined);f.cache.set('teamStep',{leaderExecution:execution});await f.run(visible.startInvocation);assert.equal(f.outputs.at(-1).bound,'repair-1');
 f.cache.set('teamStep',{leaderExecution:{...execution,attemptId:'repair-2'}});await assert.rejects(()=>f.run(visible.startInvocation),/superseded/);
});
test('installed entry has no external import and blocks missing call before tool work',async()=>{
 const f=fixture();await assert.rejects(()=>f.run(cachedLeaderEntryProgram()),/exact authorized operation/);assert.equal(f.calls.length,0);f.cache.set('teamCall',{operation:'start_team_goal',arguments:{requestId:'approved'}});await f.run(cachedLeaderEntryProgram());assert.equal(f.calls.length,1);assert.equal(f.cache.get('teamStep'),f.payload);
 const failure=fixture();failure.api.tools.exact__team_leader=async()=>({isError:true,content:[{type:'text',text:'Actual blocker'}]});await failure.run(cachedLeaderStepProgram('start_team_goal',{}));assert.equal(failure.cache.has('teamStep'),false);assert.equal(failure.outputs.at(-1).isError,true);
});
test('scoped cached code does not collide with caller variables',async()=>{
 const f=fixture();await f.run(cachedLeaderStepProgram('start_team_goal',{}));const entry=f.outputs.at(-1).leaderExecution.submissionInvocation;
 await f.run('const s=1,f=2,p=3; '+entry);assert.equal(f.outputs.at(-1).submitted,'exact-original');
});
test('continue uses exact saved continuation without discovery, read or guessed input',async()=>{
 const f=fixture(),args={teamId:'team',revision:17,waitCursor:'EXACT',wait:true,timeoutMs:55000,finishReady:true};f.cache.set('teamStep',{continuationArgs:args});
 await f.run(cachedLeaderStepProgram('continue-team',{teamId:'team'}));assert.deepEqual(f.calls,[{operation:'next_team_step',arguments:{...args,refreshRevision:true}}]);
 await assert.rejects(()=>f.run(cachedLeaderStepProgram('continue-team',{teamId:'team',cursor:'guessed'})),/never supply guessed/);assert.equal(f.calls.length,1);
});
test('lost or foreign cache refreshes same authenticated team once and preserves errors',async()=>{
 for(const saved of [undefined,{continuationArgs:{teamId:'foreign',revision:99}}]){
  const f=fixture();f.cache.set('teamStep',saved);f.api.tools.exact__team_leader=async call=>{f.calls.push(call);return {structuredContent:call.operation==='read_team'?{teamId:'team',revision:21}:f.payload};};
  await f.run(cachedLeaderStepProgram('continue-team',{teamId:'team',finishReady:false}));assert.deepEqual(f.calls.map(c=>c.operation),['read_team','next_team_step']);assert.deepEqual(f.calls[1].arguments,{teamId:'team',revision:21,refreshRevision:true,dispatchReady:true,dispatchView:'reference',finishReady:false});
 }
 const f=fixture();f.api.tools.exact__team_leader=async call=>{f.calls.push(call);return {isError:true,content:[{type:'text',text:'Real host error'}]};};await f.run(cachedLeaderStepProgram('continue-team',{teamId:'team'}));assert.equal(f.calls.length,1);assert.equal(f.cache.has('teamStep'),false);
});
test('evidence reads and command preparation cannot overwrite an active execution cache',async()=>{
 for(const operation of ['describe','read_team','read_team_context','prepare_team_command']){const f=fixture();f.cache.set('teamStep',f.payload);await assert.rejects(()=>f.run(cachedLeaderStepProgram(operation,{})),/advancement\/mutation/);assert.equal(f.calls.length,0);assert.equal(f.cache.get('teamStep'),f.payload);}
});
test('each bound execution clears stale factual assessment and installs exact delivery identity',async()=>{
 const f=fixture();f.cache.set('teamDelivery',{summary:'OLD facts'});await f.run(cachedLeaderStepProgram('start_team_goal',{}));assert.equal(f.cache.get('teamDelivery'),null);assert.equal(f.cache.get('teamDeliveryIdentity'),f.payload.leaderExecution.reportArguments);
});
test('authorized repair advances in the same exec and retains mutation and closure authorization',async()=>{
 const f=fixture();f.cache.set('teamFinishReady:team',true);const receipt={kind:'team-operation',teamId:'team',revision:8,affectedTasks:[{taskId:'repair',status:'waiting'}],originalEvidence:{report:'unchanged',interruptedTurn:'keep'}};
 f.api.tools.exact__team_leader=async call=>{f.calls.push(call);return {structuredContent:call.operation==='plan_team_repair'?structuredClone(receipt):{...receipt,revision:9,terminal:true}};};
 await f.run(cachedLeaderStepProgram('plan_team_repair',{teamId:'team',revision:7,taskId:'failed',note:'real defect'}));
 const view=f.outputs.at(-1);assert.equal(view.nextStepProgram,undefined);assert.equal(view.nextStepInvocation,undefined);assert.deepEqual(view.originalEvidence,receipt.originalEvidence);
 assert.equal(view.terminal,true);assert.deepEqual(f.cache.get('teamRepairReceipt'),receipt);assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1].arguments,{teamId:'team',revision:8,refreshRevision:true,dispatchReady:true,dispatchView:'reference',finishReady:true});
});
test('unapproved closure stays false and blocked/user/quality decisions receive no auto-advance program',async()=>{
 for(const flag of ['requiresLeaderAction','requiresUserDecision','waitBlocked','terminal']){const f=fixture();f.api.tools.exact__team_leader=async()=>({structuredContent:{teamId:'team',revision:5,[flag]:true}});await f.run(cachedLeaderStepProgram('plan_team_repair',{teamId:'team'}));assert.equal(f.cache.get('teamStep').nextStepProgram,undefined);}
 const f=fixture();f.cache.set('teamStep',{teamId:'team',revision:3});await f.run(cachedLeaderStepProgram('continue-team',{teamId:'team'}));assert.equal(f.calls[0].arguments.finishReady,false);assert.equal(f.calls.length,1);
});

test('launch receipt cannot offer automatic advancement before its exact native dispatch',async()=>{
 const f=fixture(),payload={teamId:'team',revision:5,dispatches:[{nativeAction:{tool:'spawn_agent',arguments:{message:'EXACT',fork_turns:'none'}}}],originalEvidence:{report:'retained'}};
 f.api.tools.exact__team_leader=async call=>{f.calls.push(call);return {structuredContent:payload};};
 await f.run(cachedLeaderStepProgram('start_team_goal',{requestId:'once'}));assert.equal(f.calls.length,1);assert.equal(f.cache.get('teamStep').nextStepProgram,undefined);assert.equal(f.outputs.at(-1).nextStepInvocation,undefined);assert.deepEqual(f.outputs.at(-1).dispatches,payload.dispatches);assert.deepEqual(f.outputs.at(-1).originalEvidence,payload.originalEvidence);
});
test('installed entry verifies actual connection version before starting and reuses one matching runtime proof',async()=>{
 const f=fixture();f.cache.set('teamCall',{operation:'start_team_goal',arguments:{requestId:'approved'}});f.api.tools.exact__team_leader=async call=>{f.calls.push(call);return {structuredContent:call.operation==='manage_team'?{pluginVersion:'0.40.40'}:f.payload};};
 await f.run(cachedLeaderEntryProgram({pluginVersion:'0.40.40'}));assert.deepEqual(f.calls.map(c=>c.operation),['manage_team','start_team_goal']);assert.equal(f.cache.get('teamRuntimeVersion'),'0.40.40');
 await f.run(cachedLeaderEntryProgram({pluginVersion:'0.40.40'}));assert.equal(f.calls.filter(c=>c.operation==='manage_team').length,1);
});
test('old/unknown connection and capability read errors block before mutation and preserve existing evidence',async()=>{
 for(const mode of ['old','unknown','error']){
  const f=fixture();f.cache.set('teamStep',{original:'keep'});const before=f.cache.get('teamStep');f.cache.set('teamCall',{operation:'start_team_goal',arguments:{requestId:'approved'}});
  f.api.tools.exact__team_leader=async call=>{f.calls.push(call);return mode==='error'?{isError:true,content:[{type:'text',text:'Actual missing connection'}]}:{structuredContent:mode==='old'?{pluginVersion:'0.40.38'}:{}};};
  await f.run(cachedLeaderEntryProgram({pluginVersion:'0.40.40'}));assert.equal(f.calls.length,1);assert.equal(f.calls[0].operation,'manage_team');assert.equal(f.cache.get('teamStep'),before);assert.equal(f.cache.has('teamRuntimeVersion'),false);
  if(mode!=='error'){assert.equal(f.outputs.at(-1).changesTeam,false);assert.equal(f.outputs.at(-1).runsCommands,false);assert.equal(f.outputs.at(-1).startsModel,false);}
 }
});
test('authenticated new Leader binding archives stale local transport once and does not reset a current retry',async()=>{
 const f=fixture(),old={phase:'unknown-reply',commands:[{commandId:'original',exitCode:0}]};Object.assign(f.payload.leaderExecution,{turnId:'new-turn',resumedFromTurnId:'old-turn'});f.cache.set('leaderSubmission:attempt',old);f.cache.set('leaderSubmissionEpoch:attempt','old-turn');f.cache.set('teamDelivery',{summary:'old assessment'});await f.run(cachedLeaderStepProgram('next_team_step',{teamId:'team',revision:3}));assert.equal(f.cache.get('leaderSubmission:attempt'),null);assert.equal(f.cache.get('teamDelivery'),null);assert.deepEqual(f.cache.get('leaderSubmissionHistory:attempt'),[{turnId:'old-turn',state:old}]);assert.equal(f.cache.get('leaderSubmissionEpoch:attempt'),'new-turn');const retry={phase:'verification-failed'};f.cache.set('leaderSubmission:attempt',retry);await f.run(cachedLeaderStepProgram('next_team_step',{teamId:'team',revision:3}));assert.equal(f.cache.get('leaderSubmission:attempt'),retry);assert.equal(f.cache.get('leaderSubmissionHistory:attempt').length,1);
});
