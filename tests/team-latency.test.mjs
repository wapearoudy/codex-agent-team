import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LeaderEngine} from '../src/leader-engine.mjs';

async function fixture(t,maxParallel=2,writeScopes=[]){
  const root=await mkdtemp(join(tmpdir(),'team-latency-')),cwd=join(root,'project');await mkdir(cwd);
  const observer={calls:[],async inspect(leader,project,thread,marker){this.calls.push(thread);return {threadId:thread,turnId:marker,status:'inProgress',outputs:[],commands:[],source:'test-native-snapshot'};}};
  const engine=new LeaderEngine({root:join(root,'records'),observer});
  t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
  const members=['a','b'].map(id=>({id,role:id,responsibility:'Read assigned source',reason:'Independent responsibility',writeScopes}));
  if(writeScopes.length)members.push({id:'qa',role:'Reviewer',responsibility:'Verify independently',reason:'Independent responsibility',writeScopes:[]});
  const tasks=['a','b'].flatMap(id=>[{id,title:id,goal:'Read assigned source',context:'Preserve every requirement',acceptance:'Report evidence',memberId:id,kind:'work',dependencies:[]},{id:'review_'+id,title:'Review '+id,goal:'Review independently',acceptance:'Verify evidence',memberId:writeScopes.length?'qa':id==='a'?'b':'a',kind:'review',reviewOfTaskId:id,dependencies:[{taskId:id,when:'submitted'}]}]);
  const team=await engine.planOnce('owner',{cwd,threadId:'leader'},{goal:'Measure safe task dispatch',plan:{members,tasks},execute:true,maxParallel});
  return {engine,observer,team};
}

test('a control receipt does not wait for or reread an unrelated running member',async t=>{
  const {engine,observer,team}=await fixture(t);
  const claimed=await engine.claim('owner',team.id,team.revision,'a');
  const bound=await engine.bind('owner',team.id,claimed.team.revision,'a',claimed.dispatch.attemptId,'child-a');
  assert.equal(observer.calls.length,1,'bind must inspect its target once, not again for the receipt');
  let release;const gate=new Promise(resolve=>{release=resolve;});
  observer.calls=[];observer.inspect=async()=>{observer.calls.push('unrelated-member');await gate;return {};};
  try{
    const checkpoint=engine.checkpoint('owner',team.id,bound.team.revision,{taskId:'a',attemptId:claimed.dispatch.attemptId,requestId:'dc5c7144-29eb-43e3-aa61-68b5e92d9f9f',summary:'Read first source',decisions:[],remainingWork:['Read next source'],validation:[],evidence:[]});
    const outcome=await Promise.race([checkpoint.then(()=> 'returned'),new Promise(resolve=>setTimeout(()=>resolve('waiting-for-peer'),150))]);
    assert.equal(outcome,'returned','a durable control update must not wait for an unrelated observation');
    assert.deepEqual(observer.calls,[]);
  }finally{release();}
});

test('batch reservation and binding preserve gates and commit each batch atomically',async t=>{
  const {engine,observer,team}=await fixture(t);
  const c=await engine.claimMany('owner',team.id,team.revision,['a','b']);
  assert.equal(c.team.revision,team.revision+1);assert.equal(c.dispatches.length,2);
  assert.ok(c.dispatches.every(d=>d.prompt.includes('Preserve every requirement')));
  const assignments=c.dispatches.map(d=>({taskId:d.taskId,attemptId:d.attemptId,threadId:'child-'+d.memberId}));
  const before=await engine.store.get(team.id,'owner');
  await assert.rejects(()=>engine.bindMany('owner',team.id,before.revision,assignments.map(a=>({...a,threadId:'same-child'}))),/distinct|another/);
  assert.deepEqual(await engine.store.get(team.id,'owner'),before,'a failed batch may not partially bind members');
  observer.calls=[];
  const b=await engine.bindMany('owner',team.id,before.revision,assignments);
  assert.deepEqual(observer.calls.sort(),['child-a','child-b']);
  assert.equal(b.team.revision,before.revision+1);assert.equal(b.team.totalDispatches,2);assert.equal(b.titleActions.length,2);
  await assert.rejects(()=>engine.claimMany('owner',team.id,before.revision,['a']),/changed/);
});

test('a batch exceeding the parallel limit leaves no partial reservations',async t=>{
  const {engine,team}=await fixture(t,1);
  await assert.rejects(()=>engine.claimMany('owner',team.id,team.revision,['a','b']),/not ready/);
  assert.deepEqual(await engine.store.get(team.id,'owner'),team);
  await assert.rejects(()=>engine.claimMany('owner',team.id,team.revision,['a','a']),/unique/);
});

test('batch initialization preserves fixed member identity and verifies every child once',async t=>{
  const {engine,observer,team}=await fixture(t);
  const fixed=(await engine.store.update(team.id,'owner',team.revision,t=>{t.fixedRoster=true;for(const m of t.members){m.rosterMarker='TEAM_WORKSPACE_MEMBER:'+randomUUID();m.rosterVerified=false;}})).team;
  const assignments=fixed.members.map(m=>({memberId:m.id,threadId:'child-'+m.id}));
  const before=await engine.store.get(team.id,'owner');
  await assert.rejects(()=>engine.bindRosterMany('owner',team.id,before.revision,assignments.map(m=>({...m,threadId:'duplicate-child'}))),/distinct/);
  assert.deepEqual(await engine.store.get(team.id,'owner'),before);
  observer.calls=[];observer.inspect=async(leader,cwd,thread,marker)=>{observer.calls.push(thread);return {threadId:thread,agentPath:'/root/'+thread,turnId:marker,status:'completed',outputs:[],commands:[]};};
  const bound=await engine.bindRosterMany('owner',team.id,before.revision,assignments);
  assert.deepEqual(observer.calls.sort(),['child-a','child-b']);assert.equal(bound.team.revision,before.revision+1);
  assert.ok(bound.team.members.every(m=>m.rosterVerified));assert.equal(bound.initializations.length,0);assert.equal(bound.titleActions.length,2);
  const current=await engine.store.get(team.id,'owner');
  await assert.rejects(()=>engine.bindRosterMany('owner',team.id,current.revision,[{memberId:'a',threadId:'replacement-child'}]),/existing/);
  assert.deepEqual(await engine.store.get(team.id,'owner'),current);
});

test('batch dispatch still rejects overlapping source writes and leaves the whole batch unreserved',async t=>{
  const {engine,team}=await fixture(t,2,['src']);
  await assert.rejects(()=>engine.claimMany('owner',team.id,team.revision,['a','b']),/not ready/);
  assert.deepEqual(await engine.store.get(team.id,'owner'),team);
});
