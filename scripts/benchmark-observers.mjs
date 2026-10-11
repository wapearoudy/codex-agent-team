import {performance} from 'node:perf_hooks';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createDshAccumulator,normalizeDshSession} from '../src/host-normalize.mjs';
const session={id:'benchmark',header:{cwd:process.cwd(),createdAt:1},inheritedEventCount:0,isOwnSeq:()=>true,requestHeader:()=>({config:{}})},events=[];
for(let turn=0;turn<400;turn++)events.push({seq:events.length,type:'turn/start',data:{turn}},{seq:events.length+1,type:'assistant/message',data:{turn,message:{id:'m'+turn,content:'Public work observation'},usage:{inputTokens:3,outputTokens:2}}},{seq:events.length+2,type:'turn/end',data:{turn,reason:{kind:'completed'}}});
// Compare event processing at identical publish boundaries, without file I/O or models.
const sample=()=>{let before;const start=performance.now();for(let i=20;i<=events.length;i+=20)before=normalizeDshSession(session,events.slice(0,i));const fullMs=performance.now()-start,acc=createDshAccumulator(session),next=performance.now();let after;for(let i=0;i<events.length;i++){acc.append(events[i]);if((i+1)%20===0)after=acc.snapshot();}const incrementalMs=performance.now()-next;assert.deepEqual(after,before);return {fullMs,incrementalMs};};
sample();const samples=Array.from({length:5},sample),median=key=>samples.map(s=>s[key]).sort((a,b)=>a-b)[2],result={kind:'observer-local-benchmark',version:JSON.parse(await (await import('node:fs/promises')).readFile('package.json','utf8')).version,events:events.length,turns:400,publishes:60,samples,medianFullMs:median('fullMs'),medianIncrementalMs:median('incrementalMs'),identicalFinalEvidence:true,modelStarted:false,scope:'local-normalization-only; excludes host UI, model latency, bridge disk writes and token billing'};
await mkdir('evidence',{recursive:true});await writeFile('evidence/observer-benchmark-'+result.version+'.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
