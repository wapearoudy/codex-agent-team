import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {recordCheckpoint,checkpointProjection,buildHandoff,validateCheckpoints} from '../src/team-checkpoints.mjs';

const fixture=()=>({mode:'host-leader',state:'active',goal:'Improve handoff',members:[{id:'m',role:'developer',responsibility:'Implement checkpoints',writeScopes:['src/checkpoints.mjs']}],tasks:[{id:'t',title:'Checkpoint',goal:'Persist progress',context:'Current leader remains in control',acceptance:'Validated',acceptanceCriteria:[{id:'AC1',description:'Evidence is explicit'}],memberId:'m',status:'running',attempts:[{id:'a',agentThreadId:'child',turnId:'turn'}],dependencies:[],evidence:[]}]});
const input=(extra={})=>({taskId:'t',attemptId:'a',requestId:randomUUID(),summary:' API complete ',decisions:[' Keep native members '],remainingWork:['Review'],validation:[{name:'Unit tests',status:'PASS',evidence:'node --test: pass'}],evidence:['src/checkpoints.mjs'],...extra});

test('checkpoints roundtrip with identity and explicit Leader attribution without aliasing',()=>{
  const team=fixture(),data=input(),c=recordCheckpoint(team,data);
  assert.equal(c.source,'leader-recorded');assert.equal(c.summary,'API complete');assert.equal(c.threadId,'child');assert.equal(c.turnId,'turn');
  data.decisions[0]='mutated input';c.decisions[0]='mutated result';
  assert.deepEqual(team.checkpoints[0].decisions,['Keep native members']);
  const restored=JSON.parse(JSON.stringify(team));validateCheckpoints(restored);
  assert.deepEqual(checkpointProjection(restored),checkpointProjection(team));
});

test('normalized request replay is idempotent after completion, conflicting reuse is rejected',()=>{
  const team=fixture(),data=input(),c=recordCheckpoint(team,data);team.state='delivered';team.tasks[0].status='accepted';
  assert.deepEqual(recordCheckpoint(team,{...data,summary:'API complete'}),c);assert.equal(team.checkpoints.length,1);
  assert.throws(()=>recordCheckpoint(team,{...data,summary:'Different'}),/different contents/);
  assert.throws(()=>recordCheckpoint(team,input()),/active native/);
});

test('new writes reject stale, unbound, inactive and non-native attempts without mutation',()=>{
  for(const mutate of [t=>t.mode='legacy',t=>t.tasks[0].status='waiting',t=>t.tasks[0].attempts[0].agentThreadId=null,t=>t.tasks[0].attempts[0].turnId=null,t=>t.state='delivered']){
    const team=fixture();mutate(team);const before=JSON.stringify(team);assert.throws(()=>recordCheckpoint(team,input()),/active native/);assert.equal(JSON.stringify(team),before);
  }
  const team=fixture();assert.throws(()=>recordCheckpoint(team,input({attemptId:'old'})),/Stale/);
  team.tasks[0].status='submitted';assert.ok(recordCheckpoint(team,input()));
});

test('payload validation bounds every field and keeps evidence status explicit',()=>{
  for(const extra of [{requestId:'not-uuid'},{summary:''},{summary:'x'.repeat(3001)},{decisions:['']},{remainingWork:Array(31).fill('x')},{evidence:['x'.repeat(2001)]},{validation:[{name:'Test',status:'unknown',evidence:'x'}]},{validation:[{name:'Test',status:'PASS',evidence:''}]},{validation:Array(31).fill({name:'Test',status:'PASS',evidence:'x'})}])assert.throws(()=>recordCheckpoint(fixture(),input(extra)),/checkpoint|Checkpoint/);
  const team=fixture();for(const status of ['PASS','FAIL','BLOCKED','NOT_RUN'])recordCheckpoint(team,input({validation:[{name:'Test',status,evidence:'Explicit result'}]}));
  validateCheckpoints(team);
});

test('validator rejects corrupted identities, duplicate history and normalized payload changes',()=>{
  const original=fixture();recordCheckpoint(original,input());
  for(const mutate of [c=>c.threadId='other',c=>c.turnId='other',c=>c.attemptId='other',c=>c.memberId='other',c=>c.source='native-verified',c=>c.createdAt='invalid',c=>c.id='invalid',c=>c.summary=' padded ',c=>c.decisions=null]){
    const team=structuredClone(original);mutate(team.checkpoints[0]);assert.throws(()=>validateCheckpoints(team));
  }
  const duplicate=structuredClone(original);duplicate.checkpoints.push(structuredClone(duplicate.checkpoints[0]));assert.throws(()=>validateCheckpoints(duplicate));
  const requestDuplicate=structuredClone(original);requestDuplicate.checkpoints.push({...structuredClone(requestDuplicate.checkpoints[0]),id:randomUUID()});assert.throws(()=>validateCheckpoints(requestDuplicate));
  validateCheckpoints(fixture());assert.throws(()=>validateCheckpoints({...fixture(),checkpoints:{}}));
});

test('handoff marks historical checkpoints stale and includes only current dependency evidence',()=>{
  const team=fixture();recordCheckpoint(team,input());team.tasks[0].attempts.push({id:'b',agentThreadId:'child',turnId:'new-turn'});
  team.tasks.push({id:'upstream',status:'submitted',attempts:[{id:'u1'},{id:'u2'}],evidence:[{attemptId:'u1',summary:'obsolete'},{attemptId:'u2',summary:'current'}]});team.tasks[0].dependencies=[{taskId:'upstream',when:'submitted'}];
  const before=JSON.stringify(team),handoff=buildHandoff(team,'t');
  assert.equal(handoff.checkpoint.stale,true);assert.equal(handoff.checkpoint.attemptId,'a');assert.equal(handoff.attemptId,'b');assert.equal(handoff.requiresLeaderDispatch,true);
  assert.deepEqual(handoff.dependencies[0].evidence,[{attemptId:'u2',summary:'current'}]);assert.equal(handoff.member.responsibility,'Implement checkpoints');assert.equal(handoff.acceptanceCriteria[0].id,'AC1');
  handoff.member.writeScopes.push('other');handoff.checkpoint.decisions.push('other');assert.equal(JSON.stringify(team),before);validateCheckpoints(team);
  assert.throws(()=>buildHandoff(team,'missing'),/not found/);
});

test('history cap refuses truncation and remains replayable',()=>{
  const team=fixture(),data=input();recordCheckpoint(team,data);
  for(let n=1;n<1000;n++)team.checkpoints.push({...structuredClone(team.checkpoints[0]),id:randomUUID(),requestId:randomUUID()});
  assert.throws(()=>recordCheckpoint(team,input()),/history limit/);assert.equal(team.checkpoints.length,1000);assert.equal(recordCheckpoint(team,data).requestId,data.requestId);
});
