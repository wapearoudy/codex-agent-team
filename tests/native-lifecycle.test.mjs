import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {persistedTerminal,persistedActivity} from '../src/native-lifecycle.mjs';
import {NativeMembers} from '../src/native-members.mjs';
test('live unloaded turns are not misreported as interrupted, explicit abort is required',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lifecycle-')),path=join(root,'session.jsonl');
  const meta={type:'session_meta',payload:{id:'child'}};
  await writeFile(path,JSON.stringify(meta)+'\n'+JSON.stringify({type:'event_msg',payload:{type:'task_started',turn_id:'turn'}})+'\n');
  const thread={id:'child',parentThreadId:'leader',cwd:root,path,turns:[{id:'turn',status:'interrupted',items:[{type:'agentMessage',phase:'commentary',text:'MARK'}]}]};
  const observer=new NativeMembers({rpcFactory:()=>({async connect(){},async close(){},async call(){return{thread};}}),lifecycleReader:(t,id)=>persistedTerminal(t,id,{sessionsRoot:root})});
  assert.equal((await observer.inspect('leader',root,'child','MARK')).status,'unknown');
  await appendFile(path,JSON.stringify({type:'event_msg',payload:{type:'turn_aborted',turn_id:'old'}})+'\n');
  assert.equal((await observer.inspect('leader',root,'child','MARK')).status,'unknown');
  await appendFile(path,JSON.stringify({timestamp:'now',type:'event_msg',payload:{type:'turn_aborted',turn_id:'turn'}})+'\n');
  assert.equal((await observer.inspect('leader',root,'child','MARK')).status,'interrupted');
  await assert.rejects(()=>persistedTerminal({...thread,id:'wrong'},'turn',{sessionsRoot:root}),/identity/);
  await observer.close();
});

test('inherited parent metadata does not replace the native child file identity',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lifecycle-inherited-')),path=join(root,'child.jsonl');
  const rows=[{type:'session_meta',payload:{id:'child'}},{type:'session_meta',payload:{id:'parent'}},{type:'event_msg',payload:{type:'turn_aborted',turn_id:'parent-turn'}}];
  await writeFile(path,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  assert.equal(await persistedTerminal({id:'child',path},'child-turn',{sessionsRoot:root}),null);
  await appendFile(path,JSON.stringify({type:'event_msg',payload:{type:'task_complete',turn_id:'child-turn'}})+'\n');
  assert.equal((await persistedTerminal({id:'child',path},'child-turn',{sessionsRoot:root})).status,'completed');
  await assert.rejects(()=>persistedTerminal({id:'parent',path},'parent-turn',{sessionsRoot:root}),/identity mismatch/);
});

const nowMs=Date.parse('2026-10-07T09:00:00.000Z');
const timestamp=offset=>new Date(nowMs+offset).toISOString();
const event=(type,offset,turn_id='turn',extra={})=>({timestamp:timestamp(offset),type:'event_msg',payload:{type,turn_id,...extra}});
async function activityFixture(rows){
  const root=await mkdtemp(join(tmpdir(),'native-activity-')),path=join(root,'child.jsonl');
  await writeFile(path,[{type:'session_meta',payload:{id:'child'}},...rows].map(r=>JSON.stringify(r)).join('\n')+'\n');
  return {root,path,thread:{id:'child',path},options:{sessionsRoot:root,nowMs}};
}

test('fresh exact-turn start proves activity before a final result exists',async()=>{
  const fixture=await activityFixture([event('task_started',-2000)]);
  assert.deepEqual(await persistedActivity(fixture.thread,'turn',fixture.options),{
    status:'inProgress',source:'persisted-native-activity',at:timestamp(-2000),startedAt:timestamp(-2000),freshUntil:timestamp(58000)
  });
  assert.equal(await persistedTerminal(fixture.thread,'turn',fixture.options),null);
});

test('public activity renews only its explicit current turn and returns no content',async()=>{
  const fixture=await activityFixture([
    event('task_started',-90000),
    event('agent_message',-2000,'turn',{message:'PUBLIC CONTENT MUST NOT BE RETURNED'}),
    event('exec_command_begin',-1000,'turn',{command:'COMMAND CONTENT MUST NOT BE RETURNED'}),
    event('agent_reasoning',-100,'turn',{text:'HIDDEN REASONING MUST NOT BE RETURNED'}),
    event('agent_message',0,'older-turn',{message:'WRONG TURN'}),
    {timestamp:timestamp(0),type:'event_msg',payload:{type:'agent_message',message:'UNBOUND MESSAGE'}},
    {timestamp:timestamp(0),type:'response_item',payload:{type:'message',text:'UNBOUND TRANSCRIPT'}}
  ]);
  const actual=await persistedActivity(fixture.thread,'turn',fixture.options);
  assert.deepEqual(actual,{status:'inProgress',source:'persisted-native-activity',at:timestamp(-1000),startedAt:timestamp(-90000),freshUntil:timestamp(59000)});
  assert.doesNotMatch(JSON.stringify(actual),/CONTENT|HIDDEN|WRONG|UNBOUND/);
  assert.equal(await persistedActivity(fixture.thread,'missing-turn',fixture.options),null);
});

test('actual Desktop public completed items renew freshness with exact child and turn identity',async()=>{
  for(const type of ['AgentMessage','CommandExecution','FileChange']){
    const fixture=await activityFixture([
      event('task_started',-90000),
      event('item_completed',-1000,'turn',{thread_id:'child',item:{type,content:'CONTENT MUST NOT BE RETURNED'},started_at_ms:nowMs-2000,completed_at_ms:nowMs-1000})
    ]);
    const actual=await persistedActivity(fixture.thread,'turn',fixture.options);
    assert.deepEqual(actual,{status:'inProgress',source:'persisted-native-activity',at:timestamp(-1000),startedAt:timestamp(-90000),freshUntil:timestamp(59000)});
    assert.doesNotMatch(JSON.stringify(actual),/CONTENT|item|started_at_ms|completed_at_ms/);
  }
});

test('tool and context-compaction completions prove host activity without exposing their bodies',async()=>{
 for(const type of ['McpToolCall','ContextCompaction']){
  const fixture=await activityFixture([event('task_started',-180000),event('item_completed',-1000,'turn',{thread_id:'child',item:{type,result:'PRIVATE TOOL RESULT',summary:'PRIVATE COMPACTION SUMMARY'}})]);
  const actual=await persistedActivity(fixture.thread,'turn',fixture.options);
  assert.equal(actual.status,'inProgress');assert.equal(actual.at,timestamp(-1000));assert.doesNotMatch(JSON.stringify(actual),/PRIVATE|summary|result/);
  const wrong=await activityFixture([event('task_started',-180000),event('item_completed',0,'other-turn',{thread_id:'child',item:{type}}),event('item_completed',0,'turn',{thread_id:'parent',item:{type}})]);
  assert.equal((await persistedActivity(wrong.thread,'turn',wrong.options)).status,'unknown');
 }
});

test('completed items for wrong child or turn, reasoning and subagent activity cannot renew freshness',async()=>{
  const fixture=await activityFixture([
    event('task_started',-90000),
    event('item_completed',0,'turn',{thread_id:'parent',item:{type:'CommandExecution'}}),
    event('item_completed',0,'other-turn',{thread_id:'child',item:{type:'CommandExecution'}}),
    event('item_completed',0,'turn',{item:{type:'CommandExecution'}}),
    event('item_completed',0,'turn',{thread_id:'child',item:{type:'Reasoning',content:'HIDDEN'}}),
    event('item_completed',0,'turn',{thread_id:'child',item:{type:'SubAgentActivity'}})
  ]);
  const actual=await persistedActivity(fixture.thread,'turn',fixture.options);
  assert.equal(actual.status,'unknown');
  assert.equal(actual.source,'persisted-native-activity-stale');
  assert.equal(actual.at,timestamp(-90000));
});

test('inherited parent metadata and unrelated fresh starts cannot activate a child turn',async()=>{
  const fixture=await activityFixture([
    event('task_started',-61000),{type:'session_meta',payload:{id:'parent'}},
    event('task_started',0,'parent-turn'),event('agent_message',0,'parent-turn')
  ]);
  const actual=await persistedActivity(fixture.thread,'turn',fixture.options);
  assert.equal(actual.status,'unknown');
  assert.equal(actual.source,'persisted-native-activity-stale');
  assert.equal(actual.at,timestamp(-61000));
  await assert.rejects(()=>persistedActivity({...fixture.thread,id:'parent'},'parent-turn',fixture.options),/identity mismatch/);
});

test('stale activity becomes unknown at expiry and overrides cannot extend sixty seconds',async()=>{
  const fixture=await activityFixture([event('task_started',-60000)]);
  const actual=await persistedActivity(fixture.thread,'turn',{...fixture.options,freshnessMs:120000});
  assert.deepEqual(actual,{status:'unknown',source:'persisted-native-activity-stale',at:timestamp(-60000),startedAt:timestamp(-60000),freshUntil:timestamp(0)});
  assert.equal((await persistedActivity(fixture.thread,'turn',{...fixture.options,nowMs:nowMs-1})).status,'inProgress');
  await assert.rejects(()=>persistedActivity(fixture.thread,'turn',{...fixture.options,freshnessMs:0}),/clock and freshness/);
});

test('explicit exact-turn terminals take priority over start or later activity',async()=>{
  for(const [type,status,source] of [['task_complete','completed','persisted-task-complete'],['turn_aborted','interrupted','persisted-turn-aborted']]){
    const fixture=await activityFixture([event('task_started',-4000),event(type,-2000),event('agent_message',-1000),event('turn_aborted',0,'old-turn')]);
    assert.deepEqual(await persistedActivity(fixture.thread,'turn',fixture.options),{status,source,at:timestamp(-2000)});
  }
});

test('future timestamps over clock tolerance and invalid timestamps cannot prove activity',async()=>{
  const allowed=await activityFixture([event('task_started',5000)]);
  assert.equal((await persistedActivity(allowed.thread,'turn',allowed.options)).status,'inProgress');
  for(const row of [event('task_started',5001),event('task_complete',5001),{type:'event_msg',timestamp:'not-a-date',payload:{type:'task_started',turn_id:'turn'}}]){
    const fixture=await activityFixture([row]);
    const actual=await persistedActivity(fixture.thread,'turn',fixture.options);
    assert.equal(actual.status,'unknown');
    assert.equal(actual.source,'persisted-native-activity-invalid-time');
  }
});

test('no matching safe timestamped activity yields null and session root boundary is enforced',async()=>{
  const fixture=await activityFixture([event('agent_reasoning',0),event('task_started',0,'other')]);
  assert.equal(await persistedActivity(fixture.thread,'turn',fixture.options),null);
  assert.equal(await persistedActivity({id:'child'},'turn',fixture.options),null);
  const otherRoot=await mkdtemp(join(tmpdir(),'native-activity-outside-'));
  await assert.rejects(()=>persistedActivity(fixture.thread,'turn',{...fixture.options,sessionsRoot:otherRoot}),/outside the host session directory/);
});
