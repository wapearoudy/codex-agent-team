import test from 'node:test';
import assert from 'node:assert/strict';
import { PrototypeRuntime } from '../src/runtime.mjs';

// Unit tests use explicit synthetic events. These are not host/Agent evidence.
function fixture() {
  const rt=new PrototypeRuntime();rt.loaded=true;rt.releaseLease=async()=>{};rt.save=async()=>{};
  const r={runId:'r',scope:'owner',threadId:'thread',turnId:'new',status:'inProgress',
    connection:'connected',stopState:'not-requested',startedTurnId:'new',retiredTurns:['old'],events:[],outputs:[],turnCount:1};
  rt.records.set('r',r);return {rt,r};
}

test('member messages retain attempt identity and never fabricate a read receipt',async()=>{
  const {rt,r}=fixture();r.teamId='team';r.attemptId='attempt';let calls=0;
  rt.rpc={call:async(method,p)=>{calls++;assert.equal(method,'turn/steer');assert.equal(p.expectedTurnId,'new');return{};}};
  await rt.sendMemberMessage('owner','r','检查边界条件');
  assert.equal(r.messages[0].attemptId,'attempt');assert.equal(r.messages[0].delivery,'accepted-by-runtime');assert.equal(r.messages[0].consumption,'unknown');
  rt.rpc.call=async()=>{throw new Error('timeout; outcome unknown');};
  await assert.rejects(rt.sendMemberMessage('owner','r','不要覆盖文件'),/timeout/);
  assert.equal(r.messages[1].delivery,'unconfirmed');assert.notEqual(r.messages[0].id,r.messages[1].id);
  r.status='completed';await assert.rejects(rt.sendMemberMessage('owner','r','another'),/not running/);assert.equal(calls,1);
});
test('host identity and run ownership are enforced',()=>{
  const {rt}=fixture();
  assert.throws(()=>rt.scope({}),/identity/);
  assert.throws(()=>rt.scope({threadId:'one',thread_id:'two'}),/identity/);
  assert.equal(rt.scope({threadId:'one'}),rt.scope({thread_id:'one'}));
  assert.throws(()=>rt.find('other','r'),/not found/);
});
test('late/duplicate events cannot revive a completed turn or expose reasoning',()=>{
  const {rt,r}=fixture();
  rt.onEvent({method:'turn/completed',params:{threadId:'thread',turn:{id:'old',status:'completed'}}});
  assert.equal(r.status,'inProgress');
  rt.onEvent({method:'item/completed',params:{threadId:'thread',turnId:'new',item:{id:'secret',type:'reasoning',text:'HIDDEN'}}});
  assert.deepEqual(r.outputs,[]);
  const output={method:'item/completed',params:{threadId:'thread',turnId:'new',item:{id:'public',type:'agentMessage',text:'VISIBLE'}}};
  rt.onEvent(output);rt.onEvent(output);assert.equal(r.outputs.length,1);
  rt.onEvent({method:'turn/completed',params:{threadId:'thread',turn:{id:'new',status:'interrupted'}}});
  rt.onEvent({method:'turn/started',params:{threadId:'thread',turn:{id:'new',status:'inProgress'}}});
  assert.equal(r.status,'interrupted');assert.equal(r.stopState,'confirmed-interrupted');
  r.retiredTurns.push('new');r.turnId=null;r.status='starting';
  rt.onEvent({method:'turn/completed',params:{threadId:'thread',turn:{id:'new',status:'completed'}}});
  assert.equal(r.status,'starting');
});
test('interrupt RPC acknowledgement is not confirmation of stopping',async()=>{
  const {rt,r}=fixture();let calls=0;
  rt.rpc={call:async(method)=>{assert.equal(method,'turn/interrupt');calls++;return{};}};
  await rt.stop('owner','r');await rt.stop('owner','r');
  assert.equal(calls,1);assert.equal(r.stopState,'requested');assert.equal(r.status,'inProgress');
});
test('unknown/reloaded execution cannot be resumed by read or supervision',async()=>{
  const {rt,r}=fixture();r.connection='not-reconciled';r.status='unknown';
  assert.equal((await rt.list('owner'))[0].status,'unknown');
  assert.equal(rt.rpc,undefined);
  await assert.rejects(rt.message('owner','r'),/no automatic resume/);
  r.turnCount=3;await assert.rejects(rt.turn(r,'anything'),/limit reached/);
});

test('stop between start acknowledgement and started event waits for actual execution registration',async()=>{
  const {rt,r}=fixture();r.startedTurnId=null;let calls=0;
  rt.rpc={call:async()=>{calls++;return{};}};
  await rt.stop('owner','r');
  assert.equal(calls,0);assert.equal(r.stopState,'requested');
  rt.onEvent({method:'turn/started',params:{threadId:'thread',turn:{id:'new',status:'inProgress'}}});
  await rt.lock;
  assert.equal(calls,1);assert.equal(r.stopState,'requested');
  rt.onEvent({method:'turn/completed',params:{threadId:'thread',turn:{id:'new',status:'interrupted'}}});
  assert.equal(r.stopState,'confirmed-interrupted');
});

test('team time budget is explicit and does not inherit the 60 second probe timeout',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});const {rt,r}=fixture();r.teamId='team';r.timeoutSeconds=120;let stops=0;
 rt.rpc={call:async()=>({turn:{id:'next',status:'inProgress'}})};rt.stop=async()=>{stops++;};
 await rt.turn(r,'bounded work');context.mock.timers.tick(60001);assert.equal(stops,0);context.mock.timers.tick(60000);assert.equal(stops,1);assert.equal(r.stopReason,'time-budget-exhausted');
});
