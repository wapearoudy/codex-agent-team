import test from 'node:test';
import assert from 'node:assert/strict';
import {coordinationWaitProgram,coordinationWaitInvocation,coordinationWaitTransport} from '../src/coordination-transport.mjs';
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
test('cached and newly observed exhausted usage stop transport without a further timeout loop',async()=>{
 for(const usage of [{exhausted:true},{unverifiable:true}]){
  const args={teamId:'current',revision:1,wait:true},cached={teamId:'current',revision:2,usage,continuationArgs:{...args,revision:2}};let calls=0;const out=[];
  await new AsyncFunction('tools','ALL_TOOLS','text','store','load','notify','exit',coordinationWaitProgram(args))({mcp__team_leader:async()=>{calls++;} },[{name:'mcp__team_leader'}],v=>out.push(v),()=>{},()=>cached,()=>{},()=>{throw Error('stop');}).catch(e=>assert.equal(e.message,'stop'));
  assert.equal(calls,0);assert.equal(out[0].usage,usage);
  calls=0;const outputs=[];await new AsyncFunction('tools','ALL_TOOLS','text','store','load','notify','exit',coordinationWaitProgram(args))({mcp__team_leader:async()=>{calls++;return {structuredContent:{...cached,status:'timeout',unchanged:true}};}},[{name:'mcp__team_leader'}],v=>outputs.push(v),()=>{},()=>undefined,()=>{throw Error('must not continue');},()=>{});
  assert.equal(calls,1);assert.equal(outputs[0].transportReceipt.timeoutsCoalesced,0);
 }
});
test('wire invocation coalesces waits with an empty store and ignores another team cache',async()=>{
 for(const foreign of [undefined,{teamId:'other',terminal:true},{teamId:'other',continuationArgs:{teamId:'other',revision:99}},{teamId:'current',revision:0,requiresLeaderAction:true},{teamId:'current',continuationArgs:{teamId:'current',revision:0}}]){
  const cache=new Map(foreign?[['teamStep',foreign]]:[]),calls=[],out=[];
  const args={teamId:'current',revision:1,wait:true,finishReady:true};
  const transport=coordinationWaitTransport(args,{includeProgram:false});assert.equal(transport.waitProgram,undefined);
  await new AsyncFunction('tools','ALL_TOOLS','text','store','load','notify','exit',transport.waitInvocation)(
   {mcp__team_leader:async p=>{calls.push(p);return {structuredContent:calls.length===1?{teamId:'current',status:'timeout',unchanged:true,continuationArgs:{...args,revision:2,waitCursor:'exact'}}:{teamId:'current',terminal:true}};}},
   [{name:'mcp__team_leader'}],v=>out.push(v),(k,v)=>cache.set(k,v),k=>cache.get(k),()=>{},()=>{throw Error('unexpected exit');});
  assert.equal(calls.length,2);assert.deepEqual(calls[0].arguments,{...args,refreshRevision:true});assert.equal(calls[1].arguments.waitCursor,'exact');assert.equal(out.length,1);assert.equal(out[0].terminal,true);assert.equal(out[0].transportReceipt.timeoutsCoalesced,1);assert.equal(cache.get('teamStep').terminal,true);
 }
});
test('returned invocation runs the exact saved program in one exec, with no separate discovery or load',async()=>{
 const cache=new Map([['teamWaitProgram',coordinationWaitProgram({revision:1})]]),out=[];let calls=0;
 await new AsyncFunction('tools','ALL_TOOLS','text','store','load','notify','exit',coordinationWaitInvocation)({mcp__team_leader:async()=>({structuredContent:++calls===1?{status:'timeout',unchanged:true,continuationArgs:{revision:2}}:{terminal:true}})},[{name:'mcp__team_leader'}],v=>out.push(v),(k,v)=>cache.set(k,v),k=>cache.get(k),()=>{},()=>{throw new Error('unexpected exit');});
 assert.equal(calls,2);assert.equal(out.length,1);assert.equal(cache.get('teamStep').terminal,true);
});
test('wait transport forwards exact cursors without waking the model for unchanged timeouts',async()=>{
 const start={teamId:'team',revision:1,wait:true,finishReady:true},calls=[],outputs=[],updates=[],saved=[];
 const receipts=[{status:'timeout',unchanged:true,continuationArgs:{...start,revision:2,waitCursor:'new'}},{terminal:true,completion:{accepted:2}}];
 await new AsyncFunction('tools','ALL_TOOLS','text','store','notify','exit','load',coordinationWaitProgram(start))({mcp__team_leader:async p=>{calls.push(p);return {structuredContent:receipts.shift()};}},[{name:'mcp__team_leader'}],v=>outputs.push(v),(...v)=>saved.push(v),v=>updates.push(v),()=>{throw new Error('exit');},()=>undefined);
 assert.equal(calls.length,2);assert.deepEqual(calls[0].arguments,{...start,refreshRevision:true});assert.equal(calls[1].arguments.waitCursor,'new');assert.equal(calls[1].arguments.finishReady,true);assert.equal(outputs.length,1);assert.equal(outputs[0].terminal,true);assert.equal(updates.length,1);assert.equal(saved.length,2);
});
test('transport stops on exceptions, controls, dispatches, missing continuation and bounded timeout budget',async()=>{
 for(const payload of [{requiresLeaderAction:true},{requiresUserDecision:true,status:'timeout',unchanged:true,continuationArgs:{revision:2}},{waitBlocked:true},{status:'cancelled'},{dispatches:[{taskId:'existing'}]},{status:'timeout',unchanged:true}]){
  let calls=0;const output=[];
  await new AsyncFunction('tools','ALL_TOOLS','text','store','notify','exit','load',coordinationWaitProgram({revision:1}))({mcp__team_leader:async()=>{calls++;return {content:[{type:'text',text:JSON.stringify(payload)}]};}},[{name:'mcp__team_leader'}],v=>output.push(v),()=>{},()=>{},()=>{},()=>undefined);
  assert.equal(calls,1);assert.equal(output.length,1);
 }
 let calls=0;
 await new AsyncFunction('tools','ALL_TOOLS','text','store','notify','exit','load',coordinationWaitProgram({revision:1}))({mcp__team_leader:async()=>{calls++;return {structuredContent:{status:'timeout',unchanged:true,continuationArgs:{revision:calls+1}}};}},[{name:'mcp__team_leader'}],()=>{},()=>{},()=>{},()=>{},()=>undefined);
 assert.equal(calls,4);
 assert.throws(()=>coordinationWaitProgram({}, {maxWaits:5}),/bounded/);
});
