import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {NativeMembers} from '../src/native-members.mjs';
import {NativePublicFeed} from '../src/native-public.mjs';
import {waitTeamEvent} from '../src/team-events.mjs';

async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'team-events-'));
  let nativeReads=0;
  const engine=new LeaderEngine({root,observer:{async inspect(){nativeReads++;throw new Error('Event waiting must not read native threads');}}});
  const team=await engine.planOnce('owner',{cwd:root,threadId:'leader'},{goal:'Implement the confirmed project goal',execute:true,taskPlanning:'leader',approvalMode:'required',memberStartup:'on-demand',plan:{members:[{id:'dev',role:'Dev',responsibility:'Implement',reason:'Delivery',writeScopes:['src']},{id:'qa',role:'QA',responsibility:'Review independently',reason:'Independent verification',writeScopes:[]}],tasks:[]}});
  return {engine,team,nativeReads:()=>nativeReads};
}

test('a pending Leader receives a persisted panel approval through an internal event wait',async()=>{
  const f=await fixture(),waiting=waitTeamEvent(f.engine.store,'owner',f.team.id,{revision:f.team.revision,timeoutMs:2000});
  // A separate store instance represents another panel/connection writer.
  const panel=new LeaderEngine({root:f.engine.root});
  const approved=await panel.decidePlan('owner',f.team.id,f.team.revision,{planVersion:f.team.planReview.version,planHash:f.team.planReview.hash,requestId:randomUUID(),note:'User approved the team',source:'panel-user-action'},'approve');
  const event=await waiting;assert.equal(event.status,'changed');assert.equal(event.revision,approved.team.revision);assert.equal(event.chatMessages,false);assert.equal(event.message,undefined);assert.equal(event.nextTool,'read_team');assert.equal(f.nativeReads(),0);
  const current=await f.engine.read('owner',f.team.id);assert.equal(current.workflow.stage,'task-planning');assert.equal(current.workflow.actions[0].requiresUserConfirmation,false);
});

test('stop and resume wake saved-state waits and stop takes priority over dispatch',async()=>{
  const f=await fixture();let t=(await f.engine.decidePlan('owner',f.team.id,f.team.revision,{planVersion:f.team.planReview.version,planHash:f.team.planReview.hash,requestId:randomUUID(),note:'Approve'},'approve')).team;
  const waiting=waitTeamEvent(f.engine.store,'owner',t.id,{revision:t.revision,timeoutMs:2000});
  t=(await f.engine.stop('owner',t.id,t.revision,{reason:'User requested stop',requestId:randomUUID()})).team;assert.equal((await waiting).revision,t.revision);
  const stopping=await f.engine.read('owner',t.id);assert.equal(stopping.workflow.stage,'stopping');assert.deepEqual(stopping.workflow.actions.map(a=>a.type),['stop-members']);
  t=(await f.engine.reconcileStop('owner',t.id,t.revision)).team;
  const resumeWait=waitTeamEvent(f.engine.store,'owner',t.id,{revision:t.revision,timeoutMs:2000});
  t=(await f.engine.resume('owner',t.id,t.revision,{reason:'User requested resume',requestId:randomUUID(),retryTaskIds:[]})).team;assert.equal((await resumeWait).revision,t.revision);assert.equal(f.nativeReads(),0);
});

test('event waits time out without mutating, approving or reading historical/native evidence',async()=>{
  const f=await fixture(),before=await f.engine.native('owner',f.team.id);
  const event=await waitTeamEvent(f.engine.store,'owner',f.team.id,{revision:before.revision,timeoutMs:20});assert.equal(event.status,'timeout');assert.equal(event.nextTool,'wait_team_event');assert.equal(event.readRequired,false);
  assert.equal((await waitTeamEvent(f.engine.store,'owner',f.team.id,{revision:before.revision,timeoutMs:0})).status,'timeout');
  assert.deepEqual(await f.engine.native('owner',f.team.id),before);assert.equal(f.nativeReads(),0);
});

test('event waits close on cancellation and reject foreign owners or invalid/future revisions',async()=>{
  const f=await fixture(),controller=new AbortController();
  const waiting=waitTeamEvent(f.engine.store,'owner',f.team.id,{revision:f.team.revision,timeoutMs:2000,signal:controller.signal});controller.abort();assert.equal((await waiting).status,'cancelled');
  await assert.rejects(()=>waitTeamEvent(f.engine.store,'foreign',f.team.id,{revision:f.team.revision,timeoutMs:20}),/not found/);
  await assert.rejects(()=>waitTeamEvent(f.engine.store,'owner',f.team.id,{revision:f.team.revision+1,timeoutMs:20}),/backwards/);
  assert.throws(()=>waitTeamEvent(f.engine.store,'owner',f.team.id,{revision:f.team.revision,timeoutMs:55001}),/timeout/);
});

test('all shipped panel source paths lack the chat transport and synthetic workflow prompts',async()=>{
  for(const file of ['src/team-view.mjs','src/view.mjs','src/team-coordination.mjs']){
    const source=await readFile(file,'utf8');assert.doesNotMatch(source,/\.sendMessage\s*\(|TEAM_WORKSPACE_WORKFLOW:/,file);
  }
});

test('a native terminal file event wakes the existing Leader without a team mutation or model/chat request',async()=>{
 const f=await fixture();let t=(await f.engine.decidePlan('owner',f.team.id,f.team.revision,{planVersion:f.team.planReview.version,planHash:f.team.planReview.hash,requestId:randomUUID(),note:'Approve'},'approve')).team;
 const root=await mkdtemp(join(tmpdir(),'native-event-wait-')),path=join(root,'child.jsonl');await writeFile(path,JSON.stringify({type:'session_meta',payload:{id:'child'}})+'\n');
 const observer=new NativeMembers({rpcFactory:()=>({async connect(){},async close(){},async call(method,args){assert.equal(method,'thread/read');return {thread:{id:'child',parentThreadId:'leader',cwd:t.projectPath,path}};}}),publicFeed:new NativePublicFeed({sessionsRoot:root})});
 const watched={...t,tasks:[{id:'work',status:'running',attempts:[{id:'attempt',agentThreadId:'child',turnId:'turn'}]}]};let status='inProgress',ready;const subscribed=new Promise(r=>{ready=r;});let checks=0;
 const waiting=waitTeamEvent(f.engine.store,'owner',t.id,{revision:t.revision,timeoutMs:3000,observe:async()=>{checks++;return {team:t,workflow:{actions:status==='completed'?[{type:'settle',taskId:'work',attemptId:'attempt',observedStatus:'completed'}]:[]}};},subscribe:async notify=>{const stop=await observer.subscribe(watched,notify);ready();return stop;}});
 await subscribed;status='completed';await appendFile(path,JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'task_complete',turn_id:'turn'}})+'\n');const event=await waiting;assert.equal(event.status,'member-terminal');assert.equal(event.automaticAcceptance,false);assert.equal(event.chatMessages,false);assert.equal(event.attempts[0].attemptId,'attempt');assert.equal((await f.engine.native('owner',t.id)).revision,t.revision);assert.ok(checks<=3);await observer.close();
});

test('native subscriptions reject a foreign parent and concurrent exact observations share one read',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-watch-')),path=join(root,'child.jsonl');await writeFile(path,JSON.stringify({type:'session_meta',payload:{id:'child'}})+'\n');let reads=0,parent='leader';const thread={id:'child',cwd:root,path,turns:[{id:'turn',status:'completed',items:[{type:'agentMessage',phase:'final_answer',text:'MARK'}]}]};
 const observer=new NativeMembers({rpcFactory:()=>({async connect(){},async close(){},async call(method){assert.equal(method,'thread/read');reads++;await new Promise(r=>setTimeout(r,10));return {thread:{...thread,parentThreadId:parent}};}}),publicFeed:new NativePublicFeed({sessionsRoot:root})});
 const result=await Promise.all([observer.inspect('leader',root,'child','MARK'),observer.inspect('leader',root,'child','MARK')]);assert.equal(reads,2);assert.ok(result.every(r=>r.status==='completed'));parent='foreign';await assert.rejects(()=>observer.subscribe({leaderThreadId:'leader',projectPath:root,tasks:[{status:'running',attempts:[{agentThreadId:'child',turnId:'turn'}]}]},()=>{}),/identity mismatch/);await observer.close();
});

test('semantic wait cursor survives progress between calls, while controls still wake immediately',async()=>{
 const f=await fixture(),first=await waitTeamEvent(f.engine.store,'owner',f.team.id,{revision:f.team.revision,timeoutMs:0});assert.match(first.waitCursor,/^[a-f0-9]{64}$/);
 const progressed=(await f.engine.store.update(f.team.id,'owner',f.team.revision,t=>{t.members[0].progress='Useful progress';t.events.push({type:'member-progress',at:new Date().toISOString()});})).team;
 const quiet=await waitTeamEvent(f.engine.store,'owner',f.team.id,{...first.continuationArgs,timeoutMs:0});assert.equal(quiet.status,'timeout');assert.equal(quiet.revision,progressed.revision);assert.equal(quiet.waitCursor,first.waitCursor);assert.equal(quiet.readRequired,false);
 const approved=(await f.engine.decidePlan('owner',f.team.id,progressed.revision,{planVersion:progressed.planReview.version,planHash:progressed.planReview.hash,requestId:randomUUID(),note:'Approve'},'approve')).team;
 const changed=await waitTeamEvent(f.engine.store,'owner',f.team.id,{...quiet.continuationArgs,timeoutMs:0});assert.equal(changed.status,'changed');assert.equal(changed.revision,approved.revision);assert.notEqual(changed.waitCursor,quiet.waitCursor);
 assert.throws(()=>waitTeamEvent(f.engine.store,'owner',f.team.id,{revision:approved.revision,waitCursor:'invalid'}),/semantic wait cursor/);
 const foreign=await waitTeamEvent(f.engine.store,'owner',f.team.id,{revision:approved.revision,waitCursor:'a'.repeat(64),timeoutMs:0});assert.equal(foreign.status,'changed');
});
