import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeMembers} from '../src/native-members.mjs';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {workflowActions} from '../src/team-workflow.mjs';
import {advancementResponse} from '../src/team-responses.mjs';
import {waitTeamEvent} from '../src/team-events.mjs';
import {usageReport} from '../src/team-policy.mjs';
import {registrationGap} from '../src/registration-gap.mjs';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'startup-terminal-'));t.after(()=>rm(root,{recursive:true,force:true}));const cwd=join(root,'project');await mkdir(cwd);
 const threads=new Map(),observer=new NativeMembers({identityLookup:async()=>({complete:true,ids:['child']}),rpcFactory:()=>({async connect(){},async close(){},async call(_method,{threadId}){return {thread:structuredClone(threads.get(threadId))};}}),publicFeed:{async read(){return {events:[],cursor:0,usage:{totalTokens:99}};}}}),engine=new LeaderEngine({root:join(root,'records'),observer});t.after(()=>engine.close());
 const team=await engine.planOnce('owner',{cwd,threadId:'leader'},{execute:true,goal:'Implement and independently review the requested behavior',plan:{members:[{id:'dev',role:'Developer',responsibility:'Implementation',reason:'Work',writeScopes:[]},{id:'qa',role:'Reviewer',responsibility:'Independent review',reason:'Quality',writeScopes:[]}],tasks:[{id:'work',title:'Work',goal:'Requested behavior',acceptance:'Verify behavior',kind:'work',memberId:'dev',dependencies:[]},{id:'review',title:'Review',goal:'Independent inspection',acceptance:'Proof',kind:'review',memberId:'qa',reviewOfTaskId:'work',dependencies:[{taskId:'work',when:'submitted'}]}]}});
 const claimed=await engine.claim('owner',team.id,team.revision,'work'),packet=claimed.dispatch;
 threads.set('leader',{id:'leader',cwd,turns:[]});
 const child={id:'child',parentThreadId:'leader',cwd,source:{subAgent:{thread_spawn:{agent_path:'/root/'+packet.taskName,parent_thread_id:'leader'}}},turns:[{id:'startup-turn',status:'completed',items:[{type:'agentMessage',phase:'commentary',text:packet.marker},{type:'mcpToolCall',result:{isError:true,content:[{type:'text',text:'dispatchHash must have exactly 64 hex characters'}]}}]}]};threads.set('child',child);
 return {engine,observer,team,claimed,packet,threads,child,cwd};
}

test('ended unbound startup wakes a bounded wait and blocks further dispatch without binding or accepting work',async t=>{
 const f=await fixture(t),before=await f.engine.native('owner',f.team.id),snapshot=await f.engine.terminalSnapshot('owner',f.team.id);
 assert.equal(snapshot.workflow.actions[0].type,'startup-failed');assert.match(snapshot.workflow.actions[0].reason,/64 hex/);
 const event=await waitTeamEvent(f.engine.store,'owner',f.team.id,{revision:before.revision,timeoutMs:100,observe:()=>f.engine.terminalSnapshot('owner',f.team.id)});
 assert.equal(event.status,'startup-blocked');assert.equal(event.waitBlocked,true);assert.equal(event.automaticAcceptance,false);
 const data=await f.engine.read('owner',f.team.id),reply=advancementResponse(data);
 assert.equal(data.workflow.waitBlocked,true);assert.equal(reply.nextAction,'resolve-startup');assert.equal(reply.continuationArgs,undefined);assert.match(reply.startupBlockers[0].message,/64 hex/);
 assert.equal(data.runs[0].executionAuthority,false);assert.equal(data.runs[0].threadId,'child');assert.equal(data.team.totalDispatches,0);assert.equal(data.team.tasks[0].attempts[0].agentThreadId,null);
 await assert.rejects(()=>f.engine.settle('owner',f.team.id,before.revision,'work',f.packet.attemptId),/bound current/);
 assert.deepEqual(await f.engine.native('owner',f.team.id),before);
 const context={threadId:'child',kind:'unregistered-native',agentPath:f.child.source.subAgent.thread_spawn.agent_path,createdAt:Date.parse(before.tasks[0].attempts[0].startedAt),usage:{totalTokens:99},complete:true},usage=usageReport(before,data.runs,{contexts:[context],complete:true,discoveryComplete:true});
 assert.equal(usage.totalTokens,99);assert.equal(registrationGap(usage).records[0].status,'startup-failed');assert.match(registrationGap(usage).records[0].reason,/64 hex/);
});

test('unacknowledged idle startup is a blocker, while active startup and unverified identity are not completion evidence',async t=>{
 const f=await fixture(t);f.child.turns[0].items=[];
 let run=await f.observer.inspectStartup(f.claimed.team,f.claimed.team.tasks[0]);assert.equal(run.turnId,null);assert.equal(run.startupTerminal.turnId,'startup-turn');assert.equal(run.executionAuthority,false);
 let data=await f.engine.read('owner',f.team.id);assert.equal(data.workflow.waitBlocked,true);
 f.child.turns[0].status='inProgress';data=await f.engine.read('owner',f.team.id);assert.equal(data.workflow.waitBlocked,undefined);assert.equal(data.workflow.actions[0].type,'verify-before-binding');
 f.child.parentThreadId='foreign';data=await f.engine.read('owner',f.team.id);assert.equal(data.runs[0].status,'unknown');assert.equal(data.workflow.waitBlocked,undefined);
 f.child.parentThreadId='leader';f.child.turns[0].status='interrupted';data=await f.engine.read('owner',f.team.id);assert.equal(data.workflow.waitBlocked,undefined,'Unconfirmed interruption is not a terminal receipt');
});

test('startup block cannot be hidden by unrelated ready work and does not affect bound delivery settlement',async t=>{
 const f=await fixture(t),team=structuredClone(f.claimed.team);team.tasks.push({...structuredClone(team.tasks[0]),id:'other',status:'waiting',attempts:[],memberId:'qa'});
 let flow=workflowActions(team,[{taskId:'work',attemptId:f.packet.attemptId,threadId:'child',startupOnly:true,status:'completed',startupReason:'Startup failed'}]);assert.equal(flow.waitBlocked,true);assert.equal(flow.actions.some(a=>a.type==='claim-batch'),false);
 team.tasks[0].attempts[0].state='running';team.tasks[0].attempts[0].agentThreadId='child';flow=workflowActions(team,[{attemptId:f.packet.attemptId,status:'completed'}]);assert.equal(flow.actions[0].type,'settle');assert.equal(flow.waitBlocked,undefined);
});

test('verified active native startup without a task marker is waitable but remains unbound and has no execution authority',async t=>{
 const f=await fixture(t);f.child.turns[0].items=[];f.child.turns[0].status='inProgress';const before=await f.engine.native('owner',f.team.id),data=await f.engine.read('owner',f.team.id),run=data.runs[0],reply=advancementResponse(data,'coordination',{includeWaitProgram:true});
 assert.equal(run.turnId,null);assert.equal(run.startupActivity.status,'inProgress');assert.equal(run.executionAuthority,false);assert.equal(reply.requiresLeaderAction,undefined);assert.ok(reply.waitInvocation);assert.equal(data.workflow.actions[0].requiresLeaderValidation,undefined);assert.deepEqual(await f.engine.native('owner',f.team.id),before);
 const event=await waitTeamEvent(f.engine.store,'owner',f.team.id,{revision:before.revision,timeoutMs:20,observe:()=>f.engine.terminalSnapshot('owner',f.team.id)});assert.equal(event.status,'timeout');assert.equal(event.readRequired,false);
 f.child.turns[0].status='completed';const ended=await f.engine.read('owner',f.team.id);assert.equal(ended.workflow.actions[0].type,'startup-failed');assert.equal(advancementResponse(ended).waitInvocation,undefined);assert.deepEqual(await f.engine.native('owner',f.team.id),before);
});
test('pending startup cannot turn foreign, stale, unsafe, rejected or unknown observations into a wait or binding',async t=>{
 const f=await fixture(t);f.child.turns[0].items=[];f.child.turns[0].status='inProgress';const data=await f.engine.read('owner',f.team.id),original=data.runs[0];
 for(const mutate of [r=>r.parentThreadId='foreign',r=>r.agentPath='/root/foreign',r=>r.startupActivity.status='unknown',r=>r.startupActivity.turnId=null,r=>r.startupActivity.turnCount=2,r=>r.startupActivity.safePrelude=false,r=>r.startupActivity.noPublicDelivery=false,r=>r.executionAuthority=true,r=>delete r.startupActivity]){const run=structuredClone(original);mutate(run);const flow=workflowActions(data.team,[run]);assert.equal(flow.actions[0].requiresLeaderValidation,true);assert.equal(advancementResponse({...data,runs:[run],workflow:flow},'coordination',{includeWaitProgram:true}).waitInvocation,undefined);}
 const team=structuredClone(data.team);team.tasks[0].attempts.at(-1).startupRejections=[{threadId:original.threadId,reason:'Wrong model'}];assert.equal(workflowActions(team,[original]).actions[0].requiresLeaderValidation,true);
 for(const item of [{type:'fileChange'},{type:'commandExecution',command:'python3 test.py',status:'completed',exitCode:0},{type:'mcpToolCall',tool:'foreign',status:'completed'},{type:'webSearch'}]){f.child.turns[0].items=[item];const run=await f.observer.inspectStartup(f.claimed.team,f.claimed.team.tasks[0]);assert.equal(run.startupActivity.safePrelude,false);}
});
test('fresh known native child may wait through missing first-turn/public-progress metadata without gaining authority',async t=>{
 const f=await fixture(t);f.child.createdAt=Date.now()/1000;f.child.turns=[];const before=await f.engine.native('owner',f.team.id);
 for(const firstTurn of [false,true]){
  if(firstTurn)f.child.turns=[{id:'first-native-turn',startedAt:f.child.createdAt,status:'interrupted',items:[]}];
  const data=await f.engine.read('owner',f.team.id),run=data.runs[0],reply=advancementResponse(data,'coordination',{includeWaitProgram:true});
  assert.equal(run.startupActivity.status,'unknown');assert.equal(run.executionAuthority,false);assert.equal(run.turnId,null);assert.equal(data.workflow.actions[0].requiresLeaderValidation,undefined);assert.ok(reply.waitInvocation);assert.equal(run.startupRecovery.allTurnsTerminal,false);assert.deepEqual(await f.engine.native('owner',f.team.id),before);
  const original=structuredClone(run);for(const mutate of [r=>r.observedAt=new Date(Date.parse(r.startupActivity.createdAt)+120000).toISOString(),r=>r.startupActivity.createdAt=new Date(Date.parse(before.tasks[0].attempts[0].startedAt)-6000).toISOString(),r=>r.startupActivity.createdAt='missing',r=>r.startupActivity.safePrelude=false,r=>r.startupActivity.noPublicDelivery=false,r=>r.startupActivity.turnCount=2,r=>r.parentThreadId='foreign',r=>r.agentPath='/root/foreign',r=>r.executionAuthority=true]){const bad=structuredClone(original);mutate(bad);const flow=workflowActions(data.team,[bad]);assert.equal(flow.actions[0].requiresLeaderValidation,true);}
 }
});
test('a pending exact read-only prelude or schema read may wait but cannot prove completed startup or safe replacement',async t=>{
 const f=await fixture(t);f.child.createdAt=Date.now()/1000;f.child.turns[0].startedAt=f.child.createdAt;f.child.turns[0].status='interrupted';
 const pending=[{type:'commandExecution',command:"/bin/zsh -lc 'cat AGENTS.md'",status:'inProgress',exitCode:null},{type:'mcpToolCall',server:'team-workspace-probe',tool:'team_member',arguments:{operation:'describe',toolName:'start_member_team_task'},status:'inProgress'}];
 for(const item of pending){f.child.turns[0].items=[item];const data=await f.engine.read('owner',f.team.id),run=data.runs[0];assert.equal(run.startupActivity.safePrelude,true);assert.equal(run.executionAuthority,false);assert.equal(run.startupRecovery.noExecutionItems,false);assert.equal(run.startupRecovery.allTurnsTerminal,false);assert.equal(data.workflow.actions[0].requiresLeaderValidation,undefined);assert.ok(advancementResponse(data,'coordination',{includeWaitProgram:true}).waitInvocation);}
 for(const item of [{...pending[0],command:'cat AGENTS.md > source.py'},{...pending[0],command:'python3 test.py'},{...pending[0],exitCode:0},{...pending[1],arguments:{operation:'report_member_team_task'}},{...pending[1],result:{structuredContent:{readyForWork:true}}}]){f.child.turns[0].items=[item];const data=await f.engine.read('owner',f.team.id);assert.equal(data.runs[0].startupActivity.safePrelude,false);assert.equal(data.workflow.actions[0].requiresLeaderValidation,true);}
});
