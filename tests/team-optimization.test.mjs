import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {validateTeam,consumedAttempts} from '../src/team.mjs';
import {readTeamSource,prepareTeamCommand,readTeamCommandLog} from '../src/team-output.mjs';
import {reusablePhaseCommands} from '../src/task-phases.mjs';
import {assertContractPass} from '../src/team-quality.mjs';
import {assertEvidenceSnapshot} from '../src/evidence-snapshot.mjs';
import {SchemaCatalog,efficiencyAdvice,coordinationSignature} from '../src/team-efficiency.mjs';
import {queuePeerMessage,pendingPeerInbox,peerMessagePage,acknowledgePeerMessage,peerActions} from '../src/team-peer-mailbox.mjs';
import {evidencePage} from '../src/team-evidence.mjs';
import {requestPhaseHandoff} from '../src/task-phases.mjs';
import {NativePublicFeed} from '../src/native-public.mjs';
import {waitTeamEvent} from '../src/team-events.mjs';
import {verificationCommandMatches} from '../src/verification-command.mjs';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'team-optimization-')),cwd=join(root,'project');await mkdir(join(cwd,'src'),{recursive:true});await writeFile(join(cwd,'src/a.txt'),'candidate\n');await writeFile(join(cwd,'checks.json'),'inputs');
 const runs=new Map(),observer={async inspect(l,p,thread,marker){assert.equal(l,'leader');assert.equal(p,cwd);const r=runs.get(marker);if(!r||r.threadId!==thread)throw new Error('Exact native run missing');return structuredClone(r);}};
 const engine=new LeaderEngine({root:join(root,'records'),observer});t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 const team=await engine.planOnce('owner',{threadId:'leader',cwd},{goal:'Deliver a scoped implementation with independent verification',execute:true,memberStartup:'on-demand',plan:{members:[{id:'dev',role:'Dev',responsibility:'Implement',reason:'Delivery',writeScopes:['src']},{id:'qa',role:'QA',responsibility:'Review',reason:'Independent',writeScopes:[]}],tasks:[{id:'work',title:'Implement',goal:'Complete behavior',acceptance:'Checks pass',acceptanceCriteria:[{id:'behavior',description:'Behavior works'}],contract:{stage:'implementation',inScope:['src'],outOfScope:[],verify:['node --test'],coverageOf:[]},memberId:'dev',kind:'work',dependencies:[]},{id:'review',title:'Review',goal:'Verify independently',acceptance:'Pass',memberId:'qa',kind:'review',reviewOfTaskId:'work',dependencies:[{taskId:'work',when:'submitted'}]}]}});
 const saved=()=>engine.native('owner',team.id),claim=async()=>{const s=await saved();return engine.claim('owner',s.id,s.revision,'work');};
 const c=await claim(),run={threadId:randomUUID(),turnId:randomUUID(),status:'inProgress',outputs:[],commands:[]};runs.set(c.dispatch.marker,run);const b=await engine.bind('owner',team.id,c.team.revision,'work',c.dispatch.attemptId,run.threadId);
 return {root,cwd,engine,team:b.team,saved,claim,runs,c,run,context:{cwd,threadId:run.threadId,parentThreadId:'leader'}};
}
async function handoff(f,{prefixed=false,fenced=false}={}){
 const s=await f.saved(),a=s.tasks[0].attempts.at(-1),input={taskId:'work',attemptId:a.id,requestId:randomUUID(),summary:'First phase verified',decisions:['Keep the agreed contract'],remainingWork:['Finish the documentation'],evidence:['src/a.txt'],validation:[{name:'native test',status:'PASS',evidence:'Exact host command'}],verificationInputs:['checks.json'],handoff:true};
 const report=await f.engine.memberReport('owner',s.id,s.revision,f.context,input);f.run.status='completed';let output=JSON.stringify(report.phaseHandoff.finalReceipt);if(fenced)output='```json\n'+output+'\n```';if(prefixed)output=a.marker+'\n'+output;f.run.outputs=[{text:output}];f.run.commands=[{command:'node --test',status:'completed',exitCode:0,output:'Long passed output'}];
 const result=await f.engine.settle('owner',s.id,report.revision,'work',a.id);return {result,report,input};
}
test('phase receipts use the same prefix/fence envelope after settlement and a cold history read',async t=>{
 for(const fenced of [false,true])await t.test(String(fenced),async t=>{
  const f=await fixture(t),{result}=await handoff(f,{prefixed:true,fenced}),raw=f.run.outputs[0].text;assert.equal(result.team.tasks[0].attempts[0].observation.outputs[0].text,raw);assert.equal(result.team.tasks[0].status,'waiting');assert.equal(result.team.tasks[1].status,'waiting');validateTeam(result.team);
  const cold=new LeaderEngine({root:f.engine.root,observer:f.engine.observer});t.after(()=>cold.close());validateTeam(await cold.native('owner',f.team.id));
 });
});
test('bounded source pages reconstruct unicode, fence edits and reject escape/binary/foreign task',async t=>{
 const f=await fixture(t),body='中文😀 source line\n'.repeat(100);await writeFile(join(f.cwd,'src/a.txt'),body);let startLine=1,cursor,actual='';
 while(true){const r=await readTeamSource(f.team,f.context,{taskId:'work',path:'src/a.txt',startLine,maxChars:256,cursor});assert.ok(r.text.length<=256);actual+=r.text;cursor=r.cursor;if(!r.hasMore)break;startLine=r.nextLine;}assert.equal(actual,body);
 await writeFile(join(f.cwd,'src/a.txt'),'changed');await assert.rejects(()=>readTeamSource(f.team,f.context,{taskId:'work',path:'src/a.txt',cursor}),/changed/);
 await writeFile(join(f.root,'secret'),'foreign');await symlink(join(f.root,'secret'),join(f.cwd,'escape'));await assert.rejects(()=>readTeamSource(f.team,f.context,{taskId:'work',path:'escape'}),/escapes/);
 await writeFile(join(f.cwd,'binary'),Buffer.from([1,0,2]));await assert.rejects(()=>readTeamSource(f.team,f.context,{taskId:'work',path:'binary'}),/text/);
 await assert.rejects(()=>readTeamSource(f.team,f.context,{taskId:'review',path:'src/a.txt'}),/Only current/);
 await writeFile(join(f.cwd,'huge-line'),'x'.repeat(7000));await assert.rejects(()=>readTeamSource(f.team,f.context,{taskId:'work',path:'huge-line'}),/budget/);
});
test('prepared commands do not execute, persist compound output, preserve exit and page exact unicode logs',{skip:process.platform==='win32'?'POSIX command preparation is explicitly unavailable on Windows':false},async t=>{
 const f=await fixture(t),input={taskId:'work',attemptId:f.c.dispatch.attemptId,requestId:randomUUID(),command:"printf 'first\\n'; node -e 'process.stdout.write(\"中文😀\".repeat(1000));process.exit(7)'"};
 const p=await prepareTeamCommand(join(f.root,"logs with ' quote"),f.team,f.context,input);assert.equal(p.startsCommand,false);assert.equal(p.max_output_tokens,1200);await assert.rejects(()=>readFile(p.logPath),/ENOENT/);assert.deepEqual(await prepareTeamCommand(join(f.root,"logs with ' quote"),f.team,f.context,input),p);
 await assert.rejects(()=>prepareTeamCommand(join(f.root,"logs with ' quote"),f.team,f.context,{...input,command:'true'}),/different contents/);
 await assert.rejects(()=>promisify(execFile)('/bin/sh',['-c',p.nativeCommand],{cwd:p.workspace}),e=>e.code===7);
 const body=await readFile(p.logPath,'utf8');assert.equal(body,'first\n'+'中文😀'.repeat(1000));let offset=0,text='';while(true){const page=await readTeamCommandLog(join(f.root,"logs with ' quote"),f.team,f.context,{...input,offset,maxChars:257});assert.ok(page.text.length<=257);text+=page.text;assert.ok(page.nextOffset>offset);offset=page.nextOffset;if(!page.hasMore)break;}assert.equal(text,body);
 assert.equal(verificationCommandMatches(p.nativeCommand,input.command),true);assert.equal(verificationCommandMatches("node --test > 'log' 2>&1",'node --test'),true);
 assert.equal(verificationCommandMatches('/bin/zsh -lc '+JSON.stringify(p.nativeCommand),input.command),true,'Host-added double-quoted shell wrappers without expansions remain literal');
 const quoted="'"+p.nativeCommand.replaceAll("'","'\\''")+"'";assert.equal(verificationCommandMatches('/bin/zsh -lc '+quoted,input.command),true,'Host-added literal shell wrappers preserve log verification identity');
 for(const bad of ["node --test | true > 'log' 2>&1","node --test; exit 0 > 'log' 2>&1",'node --test > "$(touch bad)" 2>&1',"echo 'node --test' > 'log' 2>&1"])assert.equal(verificationCommandMatches(bad,'node --test'),false,bad);
});
test('prepared request replay retains its pre-command source and fixture fingerprint after files change',{skip:process.platform==='win32'?'POSIX command preparation is explicitly unavailable on Windows':false},async t=>{
 const f=await fixture(t),input={taskId:'work',attemptId:f.c.dispatch.attemptId,requestId:randomUUID(),command:'node --test',verificationInputs:['checks.json']};
 const before=await prepareTeamCommand(f.engine.root,f.team,f.context,input);assert.equal(before.inputProof.reusable,true);assert.equal(before.inputProof.fileCount,2);
 const path=join(f.engine.root,'command-logs',f.team.id,input.attemptId,input.requestId+'.json'),bytes=await readFile(path);
 await writeFile(join(f.cwd,'checks.json'),'changed fixture');await writeFile(join(f.cwd,'src/a.txt'),'changed candidate');
 assert.deepEqual(await prepareTeamCommand(f.engine.root,f.team,f.context,input),before);assert.ok((await readFile(path)).equals(bytes));
 await assert.rejects(()=>prepareTeamCommand(f.engine.root,f.team,f.context,{...input,verificationInputs:[]}),/different contents/);
 const fresh=await prepareTeamCommand(f.engine.root,f.team,f.context,{...input,requestId:randomUUID()});assert.notEqual(fresh.inputProof.fingerprint,before.inputProof.fingerprint);await assert.rejects(()=>readFile(before.logPath),/ENOENT/);
});
test('Windows command preparation rejects POSIX wrappers before writing records and directs native logging',{skip:process.platform!=='win32'?'Windows native logging fallback':false},async t=>{
 const f=await fixture(t),input={taskId:'work',attemptId:f.c.dispatch.attemptId,requestId:randomUUID(),command:'node --test'};
 await assert.rejects(()=>prepareTeamCommand(f.engine.root,f.team,f.context,input),/POSIX log preparation is unavailable; use native max_output_tokens=1200/);
 await assert.rejects(()=>readFile(join(f.engine.root,'command-logs',f.team.id,input.attemptId,input.requestId+'.json')),/ENOENT/);
});
test('completed phase hands off the same task to a clean session, retaining all history and gates',async t=>{
 const f=await fixture(t),{result:r}=await handoff(f),task=r.team.tasks[0],a=task.attempts[0];assert.equal(task.status,'waiting');assert.equal(a.state,'handed-off');assert.equal(r.team.tasks[1].status,'waiting');assert.equal(consumedAttempts(task),0);validateTeam(r.team);
 assert.equal((await f.engine.settle('owner',r.team.id,r.team.revision,'work',a.id)).team.revision,r.team.revision);
 const c=await f.claim();assert.equal(c.dispatch.action,'spawn-native-member');assert.equal(c.dispatch.spawnOptions.fork_turns,'none');assert.match(c.dispatch.prompt,/complete phase checkpoint/);assert.equal(c.team.tasks[0].attempts.length,2);assert.equal(c.team.contextHistory[0].attemptId,a.id);assert.equal(c.team.tasks[0].attempts[1].phaseContinuation.fromAttemptId,a.id);assert.equal(c.team.tasks[0].goal,task.goal);assert.deepEqual(c.team.tasks[0].contract,task.contract);
 const cold=new LeaderEngine({root:f.engine.root,observer:f.engine.observer});validateTeam(await cold.native('owner',f.team.id));await cold.close();
 let text='',offset=0,cursor;while(true){const page=evidencePage(c.team,{taskId:'work',attemptId:a.id,section:'checkpoint',offset,limit:512,cursor});text+=page.text;offset=page.nextOffset;cursor=page.cursor;if(!page.hasMore)break;}assert.deepEqual(JSON.parse(text).remainingWork,['Finish the documentation']);
 const forged=structuredClone(c.team);forged.tasks[0].attempts[1].phaseContinuation.fromAttemptId=randomUUID();assert.throws(()=>validateTeam(forged),/continuation/);
});
test('phase handoffs have a bounded allowance and keep failure retry counts and review restrictions',async t=>{
 const f=await fixture(t),{result}=await handoff(f),task=result.team.tasks[0],checkpoint=result.team.checkpoints[0];
 const altered=structuredClone(result.team);altered.tasks[0].attempts[0].phaseHandoff.commands[0].exitCode=1;assert.throws(()=>validateTeam(altered),/phase evidence/);
 const capped=structuredClone(task);capped.attempts.push(...Array.from({length:2},()=>structuredClone(task.attempts[0])));assert.throws(()=>requestPhaseHandoff(result.team,capped,checkpoint,{handoff:true}),/limit/);
 assert.equal(consumedAttempts({attempts:[...capped.attempts,{state:'failed'},{state:'released'},{state:'interrupted'}]}),2);
 assert.throws(()=>requestPhaseHandoff(result.team,{...task,kind:'review'},checkpoint,{handoff:true}),/work task/);
 const old=structuredClone(result.team);old.requiresTeamWorkspaceVersion='0.24.0';assert.throws(()=>validateTeam(old),/0.29.0/);
});
test('phase verification reuses only unchanged native success; changed inputs invalidate it, final snapshot covers prior inputs',async t=>{
 const f=await fixture(t);await handoff(f);const c=await f.claim();let s=await f.saved(),task=s.tasks[0],reused=await reusablePhaseCommands(s,task);assert.equal(reused.length,1);assert.equal(reused[0].originTurnId,f.run.turnId);assert.equal(reused[0].output,undefined);
 await writeFile(join(f.cwd,'checks.json'),'changed config');assert.equal((await reusablePhaseCommands(s,task)).length,0);await writeFile(join(f.cwd,'checks.json'),'inputs');
 const run={threadId:randomUUID(),turnId:randomUUID(),status:'completed',commands:[],outputs:[{text:JSON.stringify({attemptMarker:c.dispatch.marker,summary:'Complete',changedPaths:['src/a.txt'],acceptanceResults:[{criterionId:'behavior',status:'PASS',evidence:'Verified unchanged native results'}],commandsRun:[]})}]};f.runs.set(c.dispatch.marker,run);let b=await f.engine.bind('owner',s.id,s.revision,'work',c.dispatch.attemptId,run.threadId);const submitted=await f.engine.settle('owner',s.id,b.team.revision,'work',c.dispatch.attemptId);assert.equal(submitted.team.tasks[0].status,'submitted');assertContractPass(submitted.team.tasks[0]);assert.ok(submitted.team.tasks[0].attempts[1].evidenceSnapshot.roots.includes('checks.json'));
 await writeFile(join(f.cwd,'checks.json'),'changed after submit');await assert.rejects(()=>assertEvidenceSnapshot(submitted.team,submitted.team.tasks[0]),/changed/);
});
test('an explicit contract amendment after phase completion continues without stale verification or a permanent dispatch block',async t=>{
 const f=await fixture(t),{result}=await handoff(f);const amended=await f.engine.amendContract('owner',f.team.id,result.team.revision,{taskId:'work',patch:{goal:'Complete amended behavior'},reason:'Explicit scope correction',requestId:randomUUID()});const started=await f.engine.start('owner',f.team.id,amended.team.revision);const c=await f.claim();const a=c.team.tasks[0].attempts.at(-1);assert.equal(a.phaseContinuation.contractAmendmentId,c.team.contractAmendments[0].requestId);assert.equal(a.reusedVerificationCommands.length,0);assert.match(c.dispatch.prompt,/Complete amended behavior/);validateTeam(c.team);
});
test('handoff does not reset a live/unknown attempt or accept an incorrect terminal receipt',async t=>{
 const f=await fixture(t),s=await f.saved(),input={taskId:'work',attemptId:f.c.dispatch.attemptId,requestId:randomUUID(),summary:'Checkpoint',remainingWork:['Finish'],handoff:true};const r=await f.engine.memberReport('owner',s.id,s.revision,f.context,input);
 await assert.rejects(()=>f.engine.settle('owner',s.id,r.revision,'work',input.attemptId),/no confirmed terminal/);f.run.status='completed';f.run.outputs=[{text:'Different final receipt'}];await assert.rejects(()=>f.engine.settle('owner',s.id,r.revision,'work',input.attemptId),/exact completed/);assert.equal((await f.saved()).tasks[0].status,'running');assert.equal((await f.saved()).contextHistory,undefined);
});
test('semantic waits keep progress inside one call while actionable controls wake immediately',async t=>{
 const f=await fixture(t);let ready;const subscribed=new Promise(r=>ready=r);const waiting=waitTeamEvent(f.engine.store,'owner',f.team.id,{revision:f.team.revision,timeoutMs:5000,subscribe:async()=>{ready();return ()=>{};}});await subscribed;await new Promise(r=>setTimeout(r,15));
 const updated=await f.engine.store.update(f.team.id,'owner',f.team.revision,s=>{s.checkpoints=[];s.events.push({type:'progress-only',at:new Date().toISOString()});});const event=await waiting;assert.equal(event.status,'timeout');assert.equal(event.revision,updated.team.revision);assert.equal(event.readRequired,false);
 const next=waitTeamEvent(f.engine.store,'owner',f.team.id,{revision:event.revision,timeoutMs:1000});await f.engine.stop('owner',f.team.id,event.revision,{requestId:randomUUID(),reason:'User stop'});assert.equal((await next).status,'changed');
});
test('progress messages remain durable but do not wake/deliver; bounded pending inbox skips acknowledged and foreign attempts',async t=>{
 const f=await fixture(t),s=await f.saved(),base={senderMemberId:'dev',senderThreadId:f.run.threadId,attemptId:f.c.dispatch.attemptId,toMemberId:'leader',text:'Progress',requestId:randomUUID(),kind:'progress'},signature=coordinationSignature(s);queuePeerMessage(s,base);assert.equal(peerActions(s).length,0);assert.equal(coordinationSignature(s),signature);assert.equal(pendingPeerInbox(s,'leader').messages.length,0);
 for(let i=0;i<3;i++)queuePeerMessage(s,{...base,kind:'blocker',text:'x'.repeat(3000),requestId:randomUUID()});let page=pendingPeerInbox(s,'leader');assert.equal(page.messages.length,1);assert.equal(page.hasMore,true);acknowledgePeerMessage(s,{messageId:page.messages[0].id,threadId:'leader'});assert.equal(pendingPeerInbox(s,'leader').messages[0].id,s.peerMessages[2].id);assert.equal(s.peerMessages.length,4);
 await assert.rejects(async()=>acknowledgePeerMessage(s,{messageId:s.peerMessages[2].id,threadId:'foreign'}),/original authenticated/);
});
test('oversized legacy messages page exact text without acknowledging a partial read or leaking to foreign recipients',async t=>{
 const f=await fixture(t),s=await f.saved(),m=queuePeerMessage(s,{senderMemberId:'dev',senderThreadId:f.run.threadId,attemptId:f.c.dispatch.attemptId,toMemberId:'leader',text:'\u0001'.repeat(3998)+'😀',requestId:randomUUID()});
 const page=pendingPeerInbox(s,'leader');assert.equal(page.messages.length,0);assert.equal(page.oversizedMessage.id,m.id);assert.equal(m.status,'queued');let offset=0,cursor,text='';while(true){const part=peerMessagePage(s,'leader',{messageId:m.id,offset,cursor});assert.ok(JSON.stringify(part).length<5000);text+=part.text;cursor=part.cursor;offset=part.nextOffset;if(!part.hasMore)break;}assert.equal(text,m.text);assert.equal(m.status,'queued');assert.throws(()=>peerMessagePage(s,'foreign',{messageId:m.id}),/authenticated recipient/);
});
test('schema reuse requires explicit matching version hash and current usage triggers advice without automatic resets',()=>{
 const a=new SchemaCatalog('0.29.0'),first=a.describe('op',{type:'object'},'Operation');assert.ok(first.inputSchema);assert.equal(a.describe('op',{type:'object'},'Operation',first.schemaHash).unchanged,true);assert.ok(a.describe('op',{type:'object'},'Operation').inputSchema);assert.ok(new SchemaCatalog('0.30.0').describe('op',{type:'object'},'Operation',first.schemaHash).inputSchema);
 assert.equal(efficiencyAdvice({usage:{currentInputTokens:95000}}).phaseHandoffRecommended,true);assert.equal(efficiencyAdvice({usage:{totalTokens:2000000,currentInputTokens:10000},commands:[]}).phaseHandoffRecommended,false);assert.equal(efficiencyAdvice({commands:Array(51)}).automaticReset,false);
});
test('public usage exposes current input size separately from cumulative processing',async t=>{
 const root=await mkdtemp(join(tmpdir(),'current-input-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'child.jsonl'),rows=[{type:'session_meta',payload:{id:'child'}},{type:'event_msg',payload:{type:'task_started',turn_id:'turn'}}];
 const sample=(total,input,cached,output,last)=>({type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'token_count',turn_id:'turn',info:{total_token_usage:{total_tokens:total,input_tokens:input,cached_input_tokens:cached,output_tokens:output},last_token_usage:last}}});
 rows.push(sample(100000,96000,90000,4000,{total_tokens:100000,input_tokens:96000,cached_input_tokens:90000,output_tokens:4000}),sample(220000,213000,200000,7000,{total_tokens:120000,input_tokens:117000,cached_input_tokens:110000,output_tokens:3000}));await writeFile(path,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');const feed=new NativePublicFeed({sessionsRoot:root}),run=await feed.read({id:'child',path},'turn');assert.equal(run.usage.inputTokens,213000);assert.equal(run.usage.currentInputTokens,117000);assert.equal(efficiencyAdvice(run).phaseHandoffRecommended,true);
});
