import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {DurableStore,replaceFile} from '../src/durable-store.mjs';
async function cleanup(root){const target=resolve(root);assert.equal(dirname(target),resolve(tmpdir()));assert.match(basename(target),/^team-(store|corrupt)-/);await rm(target,{recursive:true});}

test('Windows replacement retries only transient errors with a bounded delay',async()=>{
  const calls=[],delays=[];let n=0;
  await replaceFile('temp','target',{platform:'win32',wait:async ms=>delays.push(ms),renameFile:async(...args)=>{calls.push(args);if(n++<2)throw Object.assign(new Error('busy'),{code:'EPERM'});}});
  assert.deepEqual(delays,[20,50]);assert.deepEqual(calls,[['temp','target'],['temp','target'],['temp','target']]);
  for(const [platform,code,count] of [['win32','EBUSY',6],['win32','ENOSPC',1],['linux','EPERM',1]]){
    let attempts=0;await assert.rejects(replaceFile('temp','target',{platform,wait:async()=>{},renameFile:async()=>{attempts++;throw Object.assign(new Error(code),{code});}}),new RegExp(code));assert.equal(attempts,count);
  }
});

test('replacement failure preserves committed data and never replays the mutator',async()=>{
  const root=await mkdtemp(join(tmpdir(),'team-store-')),file=join(root,'state.json');
  try{
    await writeFile(file,JSON.stringify({count:4}));let mutated=0;
    const store=new DurableStore(file,{count:0},()=>{},{renameFile:async()=>{throw Object.assign(new Error('disk full'),{code:'ENOSPC'});}});
    await assert.rejects(store.transaction(d=>{mutated++;d.count++;}),/disk full/);
    assert.equal(mutated,1);assert.equal((await store.read()).count,4);
    await assert.rejects(readFile(file+'.lock'),{code:'ENOENT'});
    const next=new DurableStore(file,{});await next.transaction(d=>{d.count++;});assert.equal((await next.read()).count,5);
  }finally{await cleanup(root);}
});

test('transient Windows replacement retains lock and commits once',{skip:process.platform!=='win32'},async()=>{
  const root=await mkdtemp(join(tmpdir(),'team-store-')),file=join(root,'state.json');
  try{
    await writeFile(file,JSON.stringify({count:4}));let attempts=0,mutated=0;
    const store=new DurableStore(file,{},()=>{},{renameFile:async(from,to)=>{await readFile(file+'.lock');if(attempts++===0)throw Object.assign(new Error('scanner busy'),{code:'EPERM'});return rename(from,to);}});
    await store.transaction(d=>{mutated++;d.count++;});assert.equal(mutated,1);assert.equal(attempts,2);assert.equal((await store.read()).count,5);
  }finally{await cleanup(root);}
});

test('independent store instances serialize concurrent updates without lost increments',async()=>{
  const root=await mkdtemp(join(tmpdir(),'team-store-')),file=join(root,'state.json');
  try{
    const stores=Array.from({length:4},()=>new DurableStore(file,{count:0}));
    const outcomes=await Promise.allSettled(stores.map(s=>s.transaction(async d=>{await new Promise(r=>setTimeout(r,10));d.count++;})));
    for(const outcome of outcomes)assert.equal(outcome.status,'fulfilled',outcome.reason?.message);
    assert.equal((await stores[0].read()).count,4);
  }finally{await cleanup(root);}
});
test('lock timeout does not steal a held lock',async()=>{
  const root=await mkdtemp(join(tmpdir(),'team-store-')),store=new DurableStore(join(root,'state.json'),{});
  const release=await store.lock();
  try{await assert.rejects(store.lock({timeoutMs:40}),/locked/);await readFile(store.file+'.lock');}
  finally{await release();await cleanup(root);}
});
test('corruption blocks repeated reads and transactions without replacing the original',async()=>{
  const root=await mkdtemp(join(tmpdir(),'team-corrupt-')),file=join(root,'state.json');
  try{
    await writeFile(file,'{"unfinished":');const store=new DurableStore(file,{});
    for(let i=0;i<2;i++)await assert.rejects(store.read(),/unreadable/);
    await assert.rejects(store.transaction(d=>{d.changed=true;}),/unreadable/);
    assert.equal(await readFile(file,'utf8'),'{"unfinished":');
  }finally{await cleanup(root);}
});
