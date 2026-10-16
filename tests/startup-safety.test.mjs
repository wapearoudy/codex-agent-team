import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {NativeMembers} from '../src/native-members.mjs';
import {NativePublicFeed} from '../src/native-public.mjs';
import {consumedAttempts} from '../src/team.mjs';
import {workflowActions} from '../src/team-workflow.mjs';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'startup-safety-')),cwd=join(root,'project');await mkdir(cwd);await writeFile(join(cwd,'code.py'),'original\n');t.after(()=>rm(root,{recursive:true,force:true}));
 const threads=new Map(),observer=new NativeMembers({publicFeed:new NativePublicFeed({sessionsRoot:root}),identityLookup:async()=>({complete:true,ids:['child']}),rpcFactory:()=>({async connect(){},async close(){},async call(method,args){return {thread:structuredClone(threads.get(args.threadId))};}})}),engine=new LeaderEngine({root:join(root,'records'),observer});t.after(()=>engine.close());
 const team=await engine.planOnce('owner',{cwd,threadId:'leader'},{execute:true,goal:'Implement business behavior and independent review',plan:{members:[{id:'dev',role:'Developer',responsibility:'Implement',reason:'Business',writeScopes:['code.py'],route:{model:'gpt-6-luna',reasoningEffort:'medium'},routeSnapshot:{model:'gpt-6-luna',provider:'openai',reasoningEffort:'medium'}},{id:'qa',role:'Reviewer',responsibility:'Independent review',reason:'Quality',writeScopes:[]}],tasks:[{id:'work',title:'Work',goal:'Business behavior',acceptance:'Exact behavior',memberId:'dev',kind:'work',dependencies:[]},{id:'qa',title:'Review',goal:'Inspect exact behavior',acceptance:'Independent evidence',memberId:'qa',kind:'review',reviewOfTaskId:'work',dependencies:[{taskId:'work',when:'submitted'}]}]}});
 const claimed=await engine.claim('owner',team.id,team.revision,'work'),packet=claimed.dispatch,path=join(root,'child.jsonl'),header={type:'session_meta',payload:{id:'child',parent_thread_id:'leader'}};
 await writeFile(path,JSON.stringify(header)+'\n');
 threads.set('leader',{id:'leader',cwd,turns:[]});const child={id:'child',parentThreadId:'leader',cwd,path,model:'gpt-6-luna',modelProvider:'openai',reasoningEffort:'medium',source:{subAgent:{thread_spawn:{parent_thread_id:'leader',agent_path:'/root/'+packet.taskName}}},turns:[{id:'turn',status:'inProgress',items:[{type:'agentMessage',phase:'commentary',text:packet.marker}]}]};threads.set('child',child);
 return {root,cwd,path,header,threads,child,observer,engine,packet,team,context:{threadId:'child',parentThreadId:'leader',cwd},saved:()=>engine.native('owner',team.id),start:()=>engine.memberBootstrap('owner',team.id,{threadId:'child',parentThreadId:'leader',cwd},packet.memberBootstrap.arguments)};
}
test('actual clean native header and frozen route authorize work; Leader cannot bootstrap or mutate a child',async t=>{
 const f=await fixture(t),before=await f.saved();await assert.rejects(()=>f.engine.memberBootstrap('owner',f.team.id,{...f.context,threadId:'leader'},f.packet.memberBootstrap.arguments),/authenticated native child/);assert.deepEqual(await f.saved(),before);
 assert.equal((await f.start()).readyForWork,true);assert.equal((await f.saved()).totalDispatches,1);assert.equal((await f.start()).readyForWork,true);assert.equal((await f.saved()).totalDispatches,1);
});
test('inherited, unknown, wrong model/effort/provider launches are rejected before task authority, including legacy bind',async t=>{
 for(const bad of ['inherited','unverifiable','model','reasoningEffort','modelProvider'])await t.test(bad,async t=>{
  const f=await fixture(t);
  if(bad==='inherited'){f.header.payload.forked_from_id='leader';await writeFile(f.path,JSON.stringify(f.header)+'\n');}
  else if(bad==='unverifiable')await writeFile(f.path,'');
  else f.child[bad]='wrong';
  await assert.rejects(f.start,/native-launch-/);let saved=await f.saved();assert.equal(saved.totalDispatches,0);assert.equal(saved.tasks[0].attempts[0].agentThreadId,null);assert.match(saved.tasks[0].attempts[0].startupRejections[0].reason,/native-launch-/);
  const state=await f.engine.read('owner',f.team.id);assert.equal(state.workflow.waitBlocked,true);assert.ok(state.workflow.startupBlockers.some(b=>b.code==='native-launch-rejected'));
  // Provider is required when it is part of the frozen route.
  if(bad!=='modelProvider')await assert.rejects(()=>f.engine.bind('owner',f.team.id,saved.revision,'work',f.packet.attemptId,'child'),/native-launch-/);
 });
});
test('terminal bootstrap with malformed marker safely retires only empty startup; replay and stale callbacks cannot duplicate work',async t=>{
 const f=await fixture(t);f.child.turns[0].items[0].text='TEAM_WORKSPACE_ATTEMPT:8c044d39-cdef-428f9-ce2b-126e7f6fb31';f.child.turns[0].status='completed';let saved=await f.saved();
 const run=await f.observer.inspectStartup(saved,saved.tasks[0]);assert.equal(workflowActions(saved,[{...run,taskId:'work',attemptId:f.packet.attemptId}]).actions[0].tool,'recover_team_startup');
 const input={taskId:'work',attemptId:f.packet.attemptId,requestId:randomUUID()},result=await f.engine.recoverStartup('owner',f.team.id,saved.revision,input);assert.equal(result.startupRecovered.testsExecuted,false);saved=await f.saved();assert.equal(saved.tasks[0].status,'waiting');assert.equal(consumedAttempts(saved.tasks[0]),0);assert.equal(saved.contextHistory[0].threadId,'child');assert.equal(saved.tasks[0].attempts[0].startupRecovery.native.startupOnly,true);assert.equal(await readFile(join(f.cwd,'code.py'),'utf8'),'original\n');
 assert.equal((await f.engine.recoverStartup('owner',f.team.id,0,input)).startupRecovered.replayed,true);
 const next=await f.engine.claim('owner',f.team.id,saved.revision,'work');assert.notEqual(next.dispatch.attemptId,f.packet.attemptId);assert.equal(next.team.tasks[0].attempts.length,2);assert.equal(next.team.tasks[0].attempts[0].startupRecovery.reviewBudgetConsumed,false);
 await assert.rejects(f.start,/capability/);assert.equal((await f.saved()).totalDispatches,0);
});
test('startup recovery refuses live, unknown, executed, changed, authorized and racing histories without partial release',async t=>{
 for(const bad of ['live','unknown','command','file','tool','changed','authorized','race','missing-baseline'])await t.test(bad,async t=>{
  const f=await fixture(t);if(bad==='authorized')await f.start();f.child.turns[0].status='completed';
  if(bad==='live')f.child.turns[0].status='inProgress';if(bad==='unknown')f.child.turns[0].status='unknown';
  if(bad==='command')f.child.turns[0].items.push({type:'commandExecution',command:'python3 -m unittest',status:'completed',exitCode:0});
  if(bad==='file')f.child.turns[0].items.push({type:'fileChange'});if(bad==='tool')f.child.turns[0].items.push({type:'mcpToolCall',result:{isError:false}});
  if(bad==='changed')await writeFile(join(f.cwd,'code.py'),'changed');
  if(bad==='missing-baseline'){const saved=await f.saved();await f.engine.store.update(f.team.id,'owner',saved.revision,t=>{delete t.tasks[0].attempts[0].startupBaseline;});}
  if(bad==='race'){const inspect=f.observer.inspectStartup.bind(f.observer);let reads=0;f.observer.inspectStartup=async(...args)=>{const run=await inspect(...args);if(++reads===2)run.turnId='new-turn';return run;};}
  const before=await f.saved();await assert.rejects(()=>f.engine.recoverStartup('owner',f.team.id,before.revision,{taskId:'work',attemptId:f.packet.attemptId,requestId:randomUUID()}));assert.deepEqual(await f.saved(),before);
 });
});
test('fresh self-bootstrap trusts authenticated capability and path, never a model-copied audit marker',async t=>{
 const f=await fixture(t);f.child.turns[0].items[0].text='TEAM_WORKSPACE_ATTEMPT:8c044d39-cdef-428f9-ce2b-126e7f6fb31';assert.equal((await f.start()).readyForWork,true);f.child.turns[0].items.push({type:'agentMessage',phase:'commentary',text:f.packet.marker});assert.equal((await f.start()).readyForWork,true);
 const g=await fixture(t);g.child.turns[0].items.push({type:'agentMessage',text:'TEAM_WORKSPACE_ATTEMPT:'+randomUUID()});assert.equal((await g.start()).readyForWork,true);assert.equal((await g.saved()).tasks[0].attempts[0].marker,g.packet.marker);await assert.rejects(()=>g.observer.inspect('leader',g.cwd,'child',g.packet.marker,{requireFresh:true}),/different task attempt/);
});
test('authenticated initial turn remains observable and can save a checkpoint without a retyped public marker',async t=>{
 const f=await fixture(t);f.child.turns[0].items=[];assert.equal((await f.start()).readyForWork,true);let saved=await f.saved();assert.equal(saved.tasks[0].attempts[0].bootstrapTurnId,'turn');
 const report=await f.engine.memberReport('owner',f.team.id,undefined,f.context,{...f.packet.memberBootstrap.arguments,requestId:randomUUID(),summary:'Original factual checkpoint without running tests'});assert.equal(report.checkpoint.turnId,'turn');
 saved=await f.saved();assert.equal((await f.engine.read('owner',f.team.id)).runs[0].status,'inProgress');assert.equal(saved.tasks[0].attempts.length,1);
});
test('a completed exact read-only framework prelude can recover but a compound shell or unsuccessful read cannot',async t=>{
 for(const command of ['pwd',"/bin/zsh -lc 'cat /Users/test/.agents/skills/using-superpowers/SKILL.md'"]){const f=await fixture(t);f.child.turns[0].status='completed';f.child.turns[0].items.push({type:'commandExecution',id:'framework',command,status:'completed',exitCode:0});const saved=await f.saved();assert.equal((await f.engine.recoverStartup('owner',f.team.id,saved.revision,{taskId:'work',attemptId:f.packet.attemptId,requestId:randomUUID()})).startupRecovered.testsExecuted,false);}
 for(const command of ['pwd && python3 -m unittest','cat /Users/test/.agents/skills/using-superpowers/SKILL.md; touch code.py']){const f=await fixture(t);f.child.turns[0].status='completed';f.child.turns[0].items.push({type:'commandExecution',command,status:'completed',exitCode:0});const before=await f.saved();await assert.rejects(()=>f.engine.recoverStartup('owner',f.team.id,before.revision,{taskId:'work',attemptId:f.packet.attemptId,requestId:randomUUID()}));assert.deepEqual(await f.saved(),before);}
});

test('actual Desktop failed bootstrap status needs no isError field; success and unknown side effects cannot recover',async t=>{
 const f=await fixture(t);f.child.turns[0].status='completed';f.child.turns[0].items.push({type:'mcpToolCall',server:'team-workspace-probe',tool:'team_member',status:'failed',arguments:{operation:'start_member_team_task'},result:{content:[{type:'text',text:'Native context contains a different task attempt'}],structuredContent:null}});const saved=await f.saved();const run=await f.observer.inspectStartup(saved,saved.tasks[0]);assert.equal(run.startupRecovery.noExecutionItems,true);assert.match(run.startupReason,/different task/);assert.equal((await f.engine.recoverStartup('owner',f.team.id,saved.revision,{taskId:'work',attemptId:f.packet.attemptId,requestId:randomUUID()})).startupRecovered.testsExecuted,false);
 for(const change of [{status:'completed'},{status:'failed',tool:'unknown-side-effect'},{status:'failed',result:{structuredContent:{readyForWork:true}}}]){const g=await fixture(t);g.child.turns[0].status='completed';g.child.turns[0].items.push({type:'mcpToolCall',server:'team-workspace-probe',tool:'team_member',status:'failed',arguments:{operation:'start_member_team_task'},result:{content:[]},...change});const before=await g.saved();await assert.rejects(()=>g.engine.recoverStartup('owner',g.team.id,before.revision,{taskId:'work',attemptId:g.packet.attemptId,requestId:randomUUID()}));assert.deepEqual(await g.saved(),before);}
});
test('business commands before first bootstrap reject authority while commands after successful binding remain observable',async t=>{
 const f=await fixture(t);f.child.turns[0].items.push({type:'commandExecution',id:'premature',command:'python3 -m unittest',status:'completed',exitCode:0});await assert.rejects(f.start,/before-bootstrap/);assert.equal((await f.saved()).tasks[0].attempts[0].agentThreadId,null);
 const g=await fixture(t);g.child.turns[0].items.push({type:'mcpToolCall',server:'team-workspace-probe',tool:'team_member',status:'inProgress',arguments:{operation:'start_member_team_task'}});assert.equal((await g.start()).readyForWork,true);g.child.turns[0].items.at(-1).status='completed';g.child.turns[0].items.at(-1).result={structuredContent:{readyForWork:true}};g.child.turns[0].items.push({type:'commandExecution',command:'real validation',status:'completed',exitCode:0});assert.equal((await g.start()).readyForWork,true);
});

test('required read-only project instructions do not strand startup, but an existing public delivery forbids replacement',async t=>{
 for(const command of ["/bin/zsh -lc pwd","/bin/zsh -lc 'cat AGENTS.md README.md && pwd'","cat /Users/test/.agents/skills/using-superpowers/SKILL.md >/dev/null && pwd"]){const f=await fixture(t);f.child.turns[0].status='completed';f.child.turns[0].items.push({type:'commandExecution',id:'instructions',command,status:'completed',exitCode:0});const saved=await f.saved();assert.equal((await f.engine.recoverStartup('owner',f.team.id,saved.revision,{taskId:'work',attemptId:f.packet.attemptId,requestId:randomUUID()})).startupRecovered.testsExecuted,false);}
 const g=await fixture(t);g.child.turns[0].status='completed';g.child.turns[0].items.push({type:'agentMessage',phase:'final_answer',text:JSON.stringify({attemptMarker:g.packet.marker,summary:'Original full independent report',decision:'accept',checks:[],findings:[]})});const before=await g.saved(),run=await g.observer.inspectStartup(before,before.tasks[0]);assert.equal(run.startupRecovery.noPublicDelivery,false);await assert.rejects(()=>g.engine.recoverStartup('owner',g.team.id,before.revision,{taskId:'work',attemptId:g.packet.attemptId,requestId:randomUUID()}));assert.deepEqual(await g.saved(),before);
});

test('schema-only bootstrap discovery can bind or recover; arbitrary tools, in-flight discovery and authority-bearing results cannot',async t=>{
 for(const operation of ['directory','describe']){
  const f=await fixture(t);f.child.turns[0].items.push({type:'mcpToolCall',id:'schema',server:'team-workspace-probe',tool:'team_member',status:'completed',arguments:{operation,toolName:'read_team_materials'},result:{structuredContent:{kind:'team-tool-schema'}}});assert.equal((await f.start()).readyForWork,true);
  const g=await fixture(t);g.child.turns[0].items.push({type:'mcpToolCall',id:'schema',server:'team-workspace-probe',tool:'team_member',status:'completed',arguments:{operation},result:{structuredContent:{kind:'team-tool-schema'}}});g.child.turns[0].status='completed';const saved=await g.saved();const result=await g.engine.recoverStartup('owner',g.team.id,saved.revision,{taskId:'work',attemptId:g.packet.attemptId,requestId:randomUUID()});assert.equal(result.startupRecovered.testsExecuted,false);assert.equal((await g.saved()).tasks[0].attempts[0].startupRecovery.native.startupRecovery.readOnlyPreludeTools[0].operation,operation);
 }
 for(const patch of [{server:'foreign'},{arguments:{operation:'report_member_team_task'}},{status:'inProgress'},{result:{structuredContent:{readyForWork:true}}}]){const f=await fixture(t);f.child.turns[0].status='completed';f.child.turns[0].items.push({type:'mcpToolCall',server:'team-workspace-probe',tool:'team_member',status:'completed',arguments:{operation:'describe'},result:{structuredContent:{kind:'team-tool-schema'}},...patch});const before=await f.saved();await assert.rejects(()=>f.engine.recoverStartup('owner',f.team.id,before.revision,{taskId:'work',attemptId:f.packet.attemptId,requestId:randomUUID()}));assert.deepEqual(await f.saved(),before);}
});

test('native observation preserves rejected report data and identity without returning capabilities or private items',async t=>{
 const f=await fixture(t);await f.start();const original=JSON.stringify({attemptMarker:f.packet.marker,summary:'Original factual report',acceptanceResults:[]});f.child.turns[0].items.push({type:'reasoning',text:'PRIVATE NEVER RETURNED'},{type:'mcpToolCall',id:'original-native-call',server:'team-workspace-probe',tool:'team_member',status:'failed',arguments:{operation:'report_member_team_task',arguments:{teamId:f.team.id,bootstrapToken:'CAPABILITY NEVER RETURNED',requestId:randomUUID(),summary:'Original factual report',delivery:original}},result:{content:[{type:'text',text:'No unique self-bound current attempt'}]}});f.child.turns[0].status='completed';const saved=await f.saved(),a=saved.tasks[0].attempts[0],run=await f.observer.inspect('leader',f.cwd,'child',a.marker,{boundTurnId:a.turnId,bootstrapTurnId:a.bootstrapTurnId});assert.equal(run.reportAttempts[0].delivery,original);assert.equal(run.reportAttempts[0].callId,'original-native-call');assert.equal(run.reportAttempts[0].status,'failed');assert.doesNotMatch(JSON.stringify(run),/PRIVATE NEVER|CAPABILITY NEVER/);
});

test('review bootstrap recovery verifies exact submitted target inputs without rerunning validation or consuming review budget',async t=>{
 for(const bad of [null,'changed','missing-snapshot','changed-attempt','changed-contract'])await t.test(bad??'unchanged candidate',async t=>{
  const f=await fixture(t);await f.start();f.child.turns[0].status='completed';f.child.turns[0].items.push({type:'agentMessage',phase:'final_answer',text:'Original implementation delivery; no validation rerun.'});let saved=await f.saved();await f.engine.settle('owner',f.team.id,saved.revision,'work',f.packet.attemptId);saved=await f.saved();const claimed=await f.engine.claim('owner',f.team.id,saved.revision,'qa'),packet=claimed.dispatch,path=join(f.root,'qa-child.jsonl');
  await writeFile(path,JSON.stringify({type:'session_meta',payload:{id:'qa-child',parent_thread_id:'leader'}})+'\n');
  f.threads.set('qa-child',{...structuredClone(f.child),id:'qa-child',path,source:{subAgent:{thread_spawn:{parent_thread_id:'leader',agent_path:'/root/'+packet.taskName}}},turns:[{id:'qa-turn',status:'completed',items:[{type:'mcpToolCall',server:'team-workspace-probe',tool:'team_member',status:'failed',arguments:{operation:'start_member_team_task'},result:{content:[]}}]}]});f.observer.identityLookup=async()=>({complete:true,ids:['qa-child']});
  if(bad==='changed')await writeFile(join(f.cwd,'code.py'),'Changed after review reservation');
  if(['missing-snapshot','changed-attempt','changed-contract'].includes(bad)){saved=await f.saved();await f.engine.store.update(f.team.id,'owner',saved.revision,t=>{const work=t.tasks[0];if(bad==='missing-snapshot')delete work.attempts.at(-1).evidenceSnapshot;if(bad==='changed-attempt')work.attempts.at(-1).id=randomUUID();if(bad==='changed-contract')work.contractRevision=(work.contractRevision??1)+1;});}
  const before=await f.saved(),input={taskId:'qa',attemptId:packet.attemptId,requestId:randomUUID()};
  if(bad){await assert.rejects(()=>f.engine.recoverStartup('owner',f.team.id,before.revision,input),/candidate|snapshot/i);assert.deepEqual(await f.saved(),before);return;}
  const recovery=await f.engine.recoverStartup('owner',f.team.id,before.revision,input);assert.equal(recovery.startupRecovered.testsExecuted,false);const after=await f.saved();assert.deepEqual(after.tasks[0],before.tasks[0]);const old=after.tasks[1].attempts[0];assert.equal(old.startupRecovery.reviewCandidates[0].fingerprint,before.tasks[0].attempts[0].evidenceSnapshot.fingerprint);assert.equal(old.startupRecovery.reviewBudgetConsumed,false);assert.equal(consumedAttempts(after.tasks[1]),0);const fresh=await f.engine.claim('owner',f.team.id,after.revision,'qa');assert.notEqual(fresh.dispatch.attemptId,packet.attemptId);assert.equal(fresh.team.tasks[0].attempts.length,1);
 });
});
