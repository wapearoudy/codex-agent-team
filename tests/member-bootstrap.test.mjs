import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {dispatchReference} from '../src/dispatch-reference.mjs';
import {coordinationSignature} from '../src/team-efficiency.mjs';
import {waitTeamEvent} from '../src/team-events.mjs';
import {memberReport,memberWork} from '../src/member-work.mjs';

async function fixture(t,{contextChars}={}){
 const root=await mkdtemp(join(tmpdir(),'bootstrap-'));t.after(()=>rm(root,{recursive:true,force:true}));const cwd=join(root,'project');await mkdir(cwd);
 const runs=new Map(),engine=new LeaderEngine({root:join(root,'records'),observer:{async inspect(parent,project,thread,marker){assert.equal(parent,'leader');assert.equal(project,cwd);const run=runs.get(marker);if(!run||run.threadId!==thread)throw new Error('No exact native marker');return structuredClone(run);}}});t.after(()=>engine.close());
 const team=await engine.planOnce('owner',{cwd,threadId:'leader'},{execute:true,...(contextChars?{policy:{contextChars}}:{}),goal:'Implement requested behavior',maxParallel:2,plan:{members:[{id:'dev',role:'Developer',responsibility:'Implement source',reason:'Business',writeScopes:['src']},{id:'qa',role:'Reviewer',responsibility:'Review independently',reason:'Quality',writeScopes:[]}],tasks:[{id:'work',title:'Implementation',goal:'Implement the requested behavior',acceptance:'Independent verification',memberId:'dev',kind:'work',dependencies:[]},{id:'review',title:'Independent review',goal:'Review actual implementation',acceptance:'Proof of correct behavior',memberId:'qa',kind:'review',reviewOfTaskId:'work',dependencies:[{taskId:'work',when:'submitted'}]}]}});
 const claimed=await engine.claim('owner',team.id,team.revision,'work'),packet=claimed.dispatch,context={threadId:'child',parentThreadId:'leader',cwd},input=packet.memberBootstrap.arguments;
 const run={threadId:'child',agentPath:'/root/'+packet.taskName,turnId:'turn',status:'inProgress',outputs:[],commands:[]};runs.set(packet.marker,run);
 return {engine,team,claimed,packet,input,context,runs,run,saved:()=>engine.native('owner',team.id)};
}
test('valid saved delivery explicitly ends the current native turn; status reads do not offer more execution work',async t=>{
 const f=await fixture(t);await f.engine.memberBootstrap('owner',f.team.id,f.context,f.input);const team=await f.saved(),task=team.tasks[0],a=task.attempts.at(-1);
 const r=memberReport(team,f.context,{taskId:task.id,attemptId:a.id,requestId:randomUUID(),summary:'Factual final report',delivery:JSON.stringify({attemptMarker:a.marker,summary:'Original factual delivery'}),preflight:{valid:true,errors:[]}});
 assert.equal(r.nextAction,'end-native-turn');assert.deepEqual(r.finalReceipt,{kind:'team-saved-delivery'});assert.equal(task.status,'running');assert.equal(a.observation.status,'inProgress');assert.match(r.instruction,/requires no command/);assert.equal(a.acceptance,undefined);
 const before=structuredClone(team),work=memberWork(team,f.context);assert.equal(work.kind,'member-finish-required');assert.equal(work.nextAction,'end-native-turn');assert.deepEqual(work.finalReceipt,r.finalReceipt);assert.equal(work.tasks,undefined);assert.deepEqual(team,before);
 team.executionControl={status:'stopping'};assert.equal(memberWork(team,f.context).kind,'member-work','Control remains visible, never converted to acceptance or completion');
});
test('self bootstrap preserves native identity, is idempotent and reports across unrelated team revisions',async t=>{
 const f=await fixture(t),signature=coordinationSignature(f.claimed.team),started=await f.engine.memberBootstrap('owner',f.team.id,f.context,f.input);assert.equal(started.readyForWork,true);assert.equal(started.turnId,'turn');
 let saved=await f.saved();assert.equal(saved.totalDispatches,1);assert.equal(saved.tasks[0].attempts[0].bootstrapSource,'authenticated-member-native-observation');assert.equal(coordinationSignature(saved),signature);
 const again=await f.engine.memberBootstrap('owner',f.team.id,f.context,f.input);assert.equal(again.revision,saved.revision);assert.equal((await f.saved()).totalDispatches,1);
 await f.engine.store.update(saved.id,'owner',saved.revision,t=>{t.members[1].progress='Unrelated progress';});
 const report=await f.engine.memberReport('owner',f.team.id,undefined,f.context,{...started.reportArguments,requestId:randomUUID(),summary:'Implementation completed',delivery:f.packet.marker+'\nOriginal complete report'});
 assert.equal(report.submissionStatus,'awaiting-native-terminal');saved=await f.saved();assert.equal(saved.tasks[0].status,'running');assert.equal(saved.checkpoints.length,1);assert.equal(coordinationSignature(saved),signature);
 f.run.status='completed';f.run.outputs=[{text:f.packet.marker+'\nOriginal complete report'}];const settled=await f.engine.settle('owner',saved.id,saved.revision,'work',f.packet.attemptId);assert.equal(settled.team.tasks[0].status,'submitted');assert.equal(settled.team.tasks[1].status,'waiting');assert.notEqual(coordinationSignature(settled.team),signature);
});
test('bootstrap rejects wrong parent/workspace/path/capability, stale contract, pending or completed native turn without mutation',async t=>{
 const f=await fixture(t),original=await f.saved();
 for(const context of [{...f.context,parentThreadId:'foreign'},{...f.context,cwd:'/foreign'},{...f.context,threadId:'leader'}])await assert.rejects(()=>f.engine.memberBootstrap('owner',f.team.id,context,f.input),/authenticated/);
 await assert.rejects(()=>f.engine.memberBootstrap('owner',f.team.id,f.context,{...f.input,bootstrapToken:randomUUID()}),/capability/);
 for(const bad of [{agentPath:'/root/another_role'},{status:'completed'},{turnId:null},{latestTurnId:'another-turn'}]){Object.assign(f.run,bad);await assert.rejects(()=>f.engine.memberBootstrap('owner',f.team.id,f.context,f.input),/Bootstrap requires|native path/);Object.assign(f.run,{agentPath:'/root/'+f.packet.taskName,turnId:'turn',status:'inProgress',latestTurnId:undefined});}
 assert.deepEqual(await f.saved(),original);
 await f.engine.store.update(original.id,'owner',original.revision,t=>{t.tasks[0].contractRevision=2;});await assert.rejects(()=>f.engine.memberBootstrap('owner',f.team.id,f.context,f.input),/capability/);
});
test('bound member cannot be replaced; stale capability cannot bypass report contract fencing or stop controls',async t=>{
 const f=await fixture(t),started=await f.engine.memberBootstrap('owner',f.team.id,f.context,f.input);await assert.rejects(()=>f.engine.memberBootstrap('owner',f.team.id,{...f.context,threadId:'other-child'},f.input),/replace/);
 let saved=await f.saved();await f.engine.store.update(saved.id,'owner',saved.revision,t=>{t.tasks[0].contractRevision=2;});await assert.rejects(()=>f.engine.memberReport('owner',saved.id,undefined,f.context,{...started.reportArguments,requestId:randomUUID(),summary:'Stale delivery'}),/capability/);assert.equal((await f.saved()).checkpoints?.length??0,0);
 const g=await fixture(t);saved=await g.saved();await g.engine.store.update(saved.id,'owner',saved.revision,t=>{t.dispatchPaused=true;});await assert.rejects(()=>g.engine.memberBootstrap('owner',saved.id,g.context,g.input),/paused|dispatch/i);
});
test('immutable dispatch has an isolated marker, self-bootstrap arguments and no parent handshake',async t=>{
 const f=await fixture(t),ref=await dispatchReference(f.engine.root,f.packet),body=JSON.parse(await readFile(ref.dispatchReference.path,'utf8'));
 assert.equal(ref.prompt.split('\n')[1],f.packet.marker);assert.ok(ref.prompt.includes(JSON.stringify({...f.input,includeTaskContext:true})));assert.doesNotMatch(ref.prompt,/awaiting BIND_READY|send_message to the parent/);assert.deepEqual(body.memberBootstrap.arguments,f.input);assert.equal(body.deliveryTemplate.attemptMarker,f.packet.marker);
 assert.equal(f.packet.nativeAction.arguments.task_name,f.packet.taskName);assert.equal(f.packet.nativeAction.arguments.message,f.packet.prompt);assert.equal(ref.nativeAction.arguments.message,ref.prompt);assert.equal(body.nativeAction,undefined);
 assert.match(f.packet.prompt,/only when readyForWork=true/);assert.match(f.packet.prompt,/Quality contract/);assert.doesNotMatch(f.packet.prompt,/uses memberBootstrap.arguments in the dispatch file/);
});
test('full and referenced dispatch both carry bootstrap authority requirements; transport hashes never create a second immutable context',async t=>{
 const f=await fixture(t),ref=await dispatchReference(f.engine.root,f.packet);
 const match=f.packet.prompt.match(/operation:"start_member_team_task",arguments:(\{[^\n]+?\})/);assert.ok(match,'The full native prompt must not assume a receipt the child never received');const args=JSON.parse(match[1]);assert.deepEqual(args,{...f.input,includeTaskContext:true});
 assert.match(f.packet.prompt,/skip startup and use that receipt/);const started=await f.engine.memberBootstrap('owner',f.team.id,f.context,args);assert.equal(started.readyForWork,true);assert.equal(started.taskContext.prompt,f.packet.prompt);assert.deepEqual(started.reportArguments,f.input);assert.equal((await f.saved()).totalDispatches,1);
 const again=await dispatchReference(f.engine.root,{...f.packet,dispatchHash:'different-transport-metadata',revision:f.packet.revision+50});assert.equal(again.dispatchReference.sha256,ref.dispatchReference.sha256);assert.deepEqual((await readdir(join(f.engine.root,'dispatches',f.team.id,f.packet.attemptId))).filter(f=>f.endsWith('.json')),[ref.dispatchReference.sha256+'.json']);
});
test('actual bootstrap transport selects one payload from structured or text-only MCP and stops errors',async t=>{
 const f=await fixture(t),ref=await dispatchReference(f.engine.root,f.packet),code=ref.prompt.split('SAME functions.exec: ')[1].split(' Do not print the directory')[0],payload={readyForWork:true,taskContext:{prompt:'真实源码\ncontract'}};
 for(const response of [{structuredContent:payload,content:[{type:'text',text:'never print this duplicate'}]},{content:[{type:'text',text:JSON.stringify(payload)}]}]){const output=[],calls=[];await new Function('tools','ALL_TOOLS','text','exit','store','return (async()=>{'+code+'})()')({'mcp__test__team_member':async input=>{calls.push(input);return response;}},[{name:'mcp__test__team_member'}],v=>output.push(v),()=>{throw Error('exit');},()=>{});assert.equal(calls.length,1);assert.deepEqual(output,[payload]);}
 const error={isError:true,content:[{type:'text',text:'native tool unavailable'}]},output=[];await assert.rejects(()=>new Function('tools','ALL_TOOLS','text','exit','store','return (async()=>{'+code+'})()')({'mcp__test__team_member':async()=>error},[{name:'mcp__test__team_member'}],v=>output.push(v),()=>{throw Error('exit');},()=>{}),/exit/);assert.deepEqual(output,[error]);
});
test('parallel self-bootstrap and capability report replay remain idempotent, and active reports survive dispatch pause',async t=>{
 const f=await fixture(t),results=await Promise.all([f.engine.memberBootstrap('owner',f.team.id,f.context,f.input),f.engine.memberBootstrap('owner',f.team.id,f.context,f.input)]);
 assert.ok(results.every(r=>r.readyForWork));let saved=await f.saved();assert.equal(saved.totalDispatches,1);await f.engine.store.update(saved.id,'owner',saved.revision,t=>{t.dispatchPaused=true;});
 const input={...results[0].reportArguments,requestId:randomUUID(),summary:'Real stopped-progress checkpoint'};
 const first=await f.engine.memberReport('owner',saved.id,undefined,f.context,input),second=await f.engine.memberReport('owner',saved.id,undefined,f.context,input);assert.equal(first.checkpoint.id,second.checkpoint.id);assert.equal((await f.saved()).checkpoints.length,1);
});
test('wait coalesces self-binding and installs native subscription after late binding without waking Leader',async t=>{
 const f=await fixture(t);let notify,installed;const subscribed=new Promise(r=>{installed=r;});let reads=0,closed=0;
 const waiting=waitTeamEvent(f.engine.store,'owner',f.team.id,{revision:f.claimed.team.revision,waitCursor:coordinationSignature(f.claimed.team),timeoutMs:4000,subscribe:async(n,saved)=>{if(saved.tasks[0].attempts.at(-1).agentThreadId){notify=n;installed();}return ()=>{closed++;};},observe:async()=>{reads++;const saved=await f.saved();return {team:saved,workflow:{actions:f.run.status==='completed'?[{type:'settle',taskId:'work',attemptId:f.packet.attemptId,observedStatus:'completed'}]:[]}};}});
 await f.engine.memberBootstrap('owner',f.team.id,f.context,f.input);await subscribed;f.run.status='completed';notify();const event=await waiting;assert.equal(event.status,'member-terminal');assert.equal(event.attempts[0].attemptId,f.packet.attemptId);assert.ok(reads<=4);assert.equal(closed,2);
});
test('compact report identity is resolved only from the exact self-bound current native attempt',async t=>{
 const f=await fixture(t),before=await f.saved();
 await assert.rejects(()=>f.engine.memberReport('owner',f.team.id,undefined,f.context,{teamId:f.team.id,bootstrapToken:f.input.bootstrapToken,requestId:randomUUID(),summary:'Premature report'}),/self-bound/);assert.deepEqual(await f.saved(),before);
 const started=await f.engine.memberBootstrap('owner',f.team.id,f.context,f.input);assert.deepEqual(started.reportArguments,{teamId:f.team.id,bootstrapToken:f.input.bootstrapToken});const saved=await f.saved();
 for(const [change,context,error] of [
  [{bootstrapToken:randomUUID()},f.context,/self-bound/],
  [{}, {...f.context,threadId:'foreign-child'},/self-bound/],
  [{}, {...f.context,parentThreadId:'foreign-parent'},/authenticated native child/],
  [{}, {...f.context,cwd:'/foreign-project'},/authenticated native child/],
  [{taskId:'work'},f.context,/omit both/],
  [{taskId:'review',attemptId:f.packet.attemptId},f.context,/capability/],
  [{taskId:'work',attemptId:randomUUID()},f.context,/capability/]
 ]){await assert.rejects(()=>f.engine.memberReport('owner',f.team.id,undefined,context,{...started.reportArguments,...change,requestId:randomUUID(),summary:'Invalid report'}),error);assert.deepEqual(await f.saved(),saved);}
 const id=randomUUID(),payload={...started.reportArguments,requestId:id,summary:'Exact native report'};
 const first=await f.engine.memberReport('owner',f.team.id,undefined,f.context,payload),replay=await f.engine.memberReport('owner',f.team.id,undefined,f.context,payload);
 assert.equal(first.checkpoint.taskId,'work');assert.equal(first.checkpoint.attemptId,f.packet.attemptId);assert.equal(first.checkpoint.id,replay.checkpoint.id);assert.equal((await f.saved()).checkpoints.length,1);
});
test('compact capability cannot select an old, unbound, completed or ambiguous execution',async t=>{
 const f=await fixture(t),started=await f.engine.memberBootstrap('owner',f.team.id,f.context,f.input),original=await f.saved(),payload={...started.reportArguments,requestId:randomUUID(),summary:'Real progress'};
 const {bootstrapReportInput}=await import('../src/member-bootstrap.mjs');
 for(const alter of [t=>{t.tasks[0].status='submitted';},t=>{t.tasks[0].attempts[0].agentThreadId=null;},t=>{t.tasks[0].attempts[0].bootstrapSource=null;},t=>{t.tasks[0].attempts.push({...t.tasks[0].attempts[0],id:randomUUID(),bootstrap:{...t.tasks[0].attempts[0].bootstrap,token:randomUUID()}});},t=>{t.tasks.push({...structuredClone(t.tasks[0]),id:'ambiguous'});}]){const clone=structuredClone(original);alter(clone);assert.throws(()=>bootstrapReportInput(clone,f.context,payload),/self-bound/);}
 assert.deepEqual(await f.saved(),original);
});

test('compact bootstrap refuses partial, wrong explicit or ambiguous reservation identity without changing any attempt',async t=>{
 const f=await fixture(t),original=await f.saved();
 for(const change of [{taskId:'work'},{attemptId:f.packet.attemptId},{taskId:'review',attemptId:f.packet.attemptId},{taskId:'work',attemptId:randomUUID()}]){await assert.rejects(()=>f.engine.memberBootstrap('owner',f.team.id,f.context,{...f.input,...change}),/both|capability/);assert.deepEqual(await f.saved(),original);}
 const {bootstrapStartInput}=await import('../src/member-bootstrap.mjs'),ambiguous=structuredClone(original);ambiguous.tasks.push({...structuredClone(ambiguous.tasks[0]),id:'ambiguous'});assert.throws(()=>bootstrapStartInput(ambiguous,f.context,f.input),/capability/);
 const explicit=await f.engine.memberBootstrap('owner',f.team.id,f.context,{...f.input,taskId:'work',attemptId:f.packet.attemptId});assert.equal(explicit.readyForWork,true);assert.deepEqual(explicit.reportArguments,{teamId:f.team.id,bootstrapToken:f.input.bootstrapToken});
});

test('authenticated bootstrap returns exact immutable context in one call and keeps legacy receipts compact',async t=>{
 const f=await fixture(t),ref=await dispatchReference(f.engine.root,f.packet),input={...f.input,dispatchHash:ref.dispatchReference.sha256};
 const started=await f.engine.memberBootstrap('owner',f.team.id,f.context,input);
 assert.equal(started.taskContext.prompt,f.packet.prompt);assert.equal(started.taskContext.complete,true);assert.equal(started.taskContext.sha256,f.packet.promptHash);
 const replay=await f.engine.memberBootstrap('owner',f.team.id,f.context,input);assert.deepEqual(replay.taskContext,started.taskContext);assert.equal((await f.saved()).totalDispatches,1);
 assert.equal((await f.engine.memberBootstrap('owner',f.team.id,f.context,f.input)).taskContext,undefined);
 assert.match(ref.prompt,/SAME functions.exec/);assert.doesNotMatch(ref.prompt,/Read the complete exact task prompt at/);
});
test('review bootstrap delivers original selected evidence only after exact native authentication',async t=>{
 const f=await fixture(t);await f.engine.memberBootstrap('owner',f.team.id,f.context,f.input);f.run.status='completed';f.run.outputs=[{text:f.packet.marker+'\nOriginal complete report'}];let saved=await f.saved();await f.engine.settle('owner',saved.id,saved.revision,'work',f.packet.attemptId);saved=await f.saved();
 const claimed=await f.engine.claim('owner',saved.id,saved.revision,'review'),packet=claimed.dispatch,ref=await dispatchReference(f.engine.root,packet),context={...f.context,threadId:'reviewer'},input={...packet.memberBootstrap.arguments,dispatchHash:ref.dispatchReference.sha256};
 f.runs.set(packet.marker,{threadId:'reviewer',agentPath:'/root/'+packet.taskName,turnId:'review-turn',status:'inProgress',outputs:[],commands:[]});
 const before=await f.saved();await assert.rejects(()=>f.engine.memberBootstrap('owner',saved.id,{...context,parentThreadId:'foreign'},input));assert.deepEqual(await f.saved(),before);
 const started=await f.engine.memberBootstrap('owner',saved.id,context,input);assert.equal(started.readyForWork,true);assert.equal(started.reviewInputs.targets[0].delivery.text,f.packet.marker+'\nOriginal complete report');assert.equal(started.reviewInputs.targets[0].attemptId,f.packet.attemptId);assert.equal(started.reviewInputs.changesAcceptance,false);assert.equal((await f.saved()).tasks[0].status,'submitted');
});
test('context delivery rejects malformed, missing, tampered or cross-task packets before binding',async t=>{
 for(const kind of ['invalid','missing','tampered','foreign','wrong-parent','paused'])await t.test(kind,async t=>{
  const f=await fixture(t);let packet=f.packet;
  if(kind==='foreign')packet={...packet,taskId:'review'};
  const ref=await dispatchReference(f.engine.root,packet),input={...f.input,dispatchHash:ref.dispatchReference.sha256};let context=f.context;
  if(kind==='invalid')input.dispatchHash='../escape';
  if(kind==='missing')input.dispatchHash='0'.repeat(64);
  if(kind==='tampered')await writeFile(ref.dispatchReference.path,'{}');
  if(kind==='wrong-parent')context={...context,parentThreadId:'foreign'};
  if(kind==='paused'){const team=await f.saved();await f.engine.store.update(team.id,'owner',team.revision,t=>{t.dispatchPaused=true;});}
  const before=await f.saved();await assert.rejects(()=>f.engine.memberBootstrap('owner',f.team.id,context,input));assert.deepEqual(await f.saved(),before);
 });
});

test('every launch view withholds work until authenticated binding, including legacy single and batch claims',async t=>{
 const f=await fixture(t),before=await f.saved();
 assert.ok(f.packet.taskName.endsWith(f.packet.attemptId.replaceAll('-','')));
 assert.equal(before.tasks[0].attempts[0].bootstrap.taskName,f.packet.taskName);
 for(const payload of [{dispatch:f.packet},{dispatches:[f.packet]}]){
  const guarded=await f.engine.guardDispatches(payload),p=guarded.dispatch??guarded.dispatches[0];
  assert.match(p.prompt,/Only readyForWork=true/);assert.doesNotMatch(p.prompt,/Allowed source writes|deliveryTemplate:/);assert.equal(p.deliveryTemplate,undefined);
  assert.equal(p.nativeAction.arguments.message,p.prompt);assert.equal(p.taskName,f.packet.taskName);
  assert.deepEqual(await f.engine.guardDispatches(guarded),guarded,'repeated formatting cannot create another envelope');
  const bound=await f.engine.memberBootstrap('owner',f.team.id,f.context,{...f.input,dispatchHash:p.dispatchReference.sha256});
  assert.equal(bound.readyForWork,true);assert.match(bound.taskContext.prompt,/Allowed source writes/);
 }
 const saved=await f.saved();assert.equal(saved.totalDispatches,1);assert.equal(saved.tasks[0].attempts.length,1);
});


test('canonical context bootstrap removes hash copying but never guesses missing, ambiguous, tampered or explicit wrong identity',async t=>{
 const f=await fixture(t),before=await f.saved(),input={...f.input,includeTaskContext:true};
 await assert.rejects(()=>f.engine.memberBootstrap('owner',f.team.id,f.context,input));assert.deepEqual(await f.saved(),before);
 const ref=await dispatchReference(f.engine.root,f.packet);
 await assert.rejects(()=>f.engine.memberBootstrap('owner',f.team.id,f.context,{...input,dispatchHash:'0'.repeat(63)}),/Invalid immutable/);assert.deepEqual(await f.saved(),before);
 const started=await f.engine.memberBootstrap('owner',f.team.id,f.context,input);assert.equal(started.taskContext.prompt,f.packet.prompt);assert.equal((await f.saved()).totalDispatches,1);
 await dispatchReference(f.engine.root,{...f.packet,prompt:f.packet.prompt+'\nAnother competing dispatch'});
 const saved=await f.saved();await assert.rejects(()=>f.engine.memberBootstrap('owner',f.team.id,f.context,input),/unique immutable/);assert.deepEqual(await f.saved(),saved);
 const explicit=await f.engine.memberBootstrap('owner',f.team.id,f.context,{...input,dispatchHash:ref.dispatchReference.sha256});assert.equal(explicit.taskContext.prompt,f.packet.prompt);
});

 test('reserving a native bootstrap measures its compact contract, never renders a legacy business packet merely to name the child',async t=>{
  const f=await fixture(t),saved=await f.saved(),legacy=structuredClone(saved);delete legacy.tasks[0].attempts[0].bootstrap;const full=f.engine.packet(legacy,legacy.tasks[0]).prompt;assert.ok(full.length>f.packet.prompt.length+200);const bounded=await fixture(t,{contextChars:f.packet.prompt.length+100});assert.ok(bounded.packet.prompt.length<full.length);assert.equal(bounded.packet.taskName,bounded.claimed.team.tasks[0].attempts[0].bootstrap.taskName);
 });

test('every initial and replay bootstrap response supplies executable reporting transport without another bind',async t=>{
 const f=await fixture(t);await dispatchReference(f.engine.root,f.packet);for(const includeTaskContext of [true,false,true]){const r=await f.engine.memberBootstrap('owner',f.team.id,f.context,{...f.input,includeTaskContext});assert.equal(r.readyForWork,true);assert.equal(r.deliveryTemplate.attemptMarker,f.packet.marker);assert.ok(r.reportProgram.includes('runCachedMemberReport'));assert.ok(r.memberReportInvocation.includes('teamMemberBootstrap'));assert.match(r.nextReportRequestId,/^[a-f0-9-]{36}$/);assert.deepEqual(r.reportArguments,f.input);}assert.equal((await f.saved()).totalDispatches,1);
});
