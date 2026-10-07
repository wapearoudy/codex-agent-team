import test from 'node:test';
import assert from 'node:assert/strict';
import {realpath} from 'node:fs/promises';
import {HostContext} from '../src/host-context.mjs';

test('current project comes from host thread metadata, never a caller path or plugin cwd',async()=>{
  const cwd=await realpath('.'),calls=[];let closed=false;
  const host=new HostContext({binary:'test-only',rpcFactory:()=>({connect:async()=>{},call:async(method,args)=>{calls.push({method,args});return{thread:{id:args.threadId,cwd}};},close:async()=>{closed=true;}})});
  const result=await host.resolve({threadId:'host-current',cwd:'C:/untrusted-caller-path'});
  assert.equal(result.cwd,cwd);assert.equal(result.source,'host-thread-metadata');assert.deepEqual(calls,[{method:'thread/read',args:{threadId:'host-current',includeTurns:false}}]);assert.equal(closed,false);
  await assert.rejects(host.resolve({}),/会话标识/);await assert.rejects(host.resolve({threadId:'one',thread_id:'two'}),/会话标识/);
  await host.close();assert.equal(closed,true);
});
test('polling shares one helper but revalidates host metadata for every request',async()=>{
  let created=0,connected=0,reads=0,closed=0;let cwd=process.cwd();
  const host=new HostContext({rpcFactory:()=>{created++;return{async connect(){connected++;},async call(_,args){reads++;return{thread:{id:args.threadId,cwd}};},async close(){closed++;}};}});
  await Promise.all([host.resolve({threadId:'one'}),host.resolve({threadId:'two'})]);await host.resolve({threadId:'one'});
  assert.equal(created,1);assert.equal(connected,1);assert.equal(reads,3);
  cwd='relative/not-authorized';await assert.rejects(()=>host.resolve({threadId:'one'}),/宿主未返回/);assert.equal(closed,1);
  cwd=process.cwd();await host.resolve({threadId:'one'});assert.equal(created,2);await host.close();assert.equal(closed,2);
});
test('metadata mismatch blocks access and closes helper instead of falling back to a picker',async()=>{
  let closed=false;const host=new HostContext({binary:'test-only',rpcFactory:()=>({connect:async()=>{},call:async()=>({thread:{id:'unrelated',cwd:process.cwd()}}),close:async()=>{closed=true;}})});
  await assert.rejects(host.resolve({threadId:'current'}),/宿主未返回/);assert.equal(closed,true);
});
