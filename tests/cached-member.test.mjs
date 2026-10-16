import test from 'node:test';
import assert from 'node:assert/strict';
import {runCachedMemberReport,memberBootstrapProgram} from '../src/cached-member.mjs';
function fixture(){
 const cache=new Map([['teamMemberBootstrap',{readyForWork:true,reportArguments:{teamId:'team',bootstrapToken:'exact-original-capability'},nextReportRequestId:'original-request'}],['teamMemberDelivery',{summary:'Factual report',attemptMarker:'original-marker',verificationInputs:['source.py']}]]),calls=[],output=[];
 const f={cache,calls,output,response:{structuredContent:{deliveryPreflight:{valid:true},finalReceipt:{kind:'team-saved-delivery'}}}};
 f.run=()=>runCachedMemberReport({tools:{mcp__test__team_member:async a=>{calls.push(structuredClone(a));if(f.throw)throw Error('unknown transport');return f.response;}},ALL_TOOLS:[{name:'mcp__test__team_member'}],store:(k,v)=>cache.set(k,v),load:k=>cache.get(k),text:v=>output.push(v)});return f;
}
test('member reporting uses retained exact binding and server request once, without tool discovery, UUID copies or commands',async()=>{
 const f=fixture();await f.run();await f.run();assert.equal(f.calls.length,1);assert.equal(f.calls[0].arguments.bootstrapToken,'exact-original-capability');assert.equal(f.calls[0].arguments.requestId,'original-request');assert.deepEqual(JSON.parse(f.calls[0].arguments.delivery),f.cache.get('teamMemberDelivery'));assert.equal(f.cache.get('teamMemberPendingReport'),null);
 f.cache.get('teamMemberDelivery').summary='changed after accepted preflight';await assert.rejects(f.run,/already saved/);assert.equal(f.calls.length,1);
});
test('format corrections retain the same attempt and factual results but take the next server-issued request',async()=>{
 const f=fixture();f.response={structuredContent:{deliveryPreflight:{valid:false,errors:[{path:'summary'}]},nextReportRequestId:'next-original-request'}};await f.run();f.cache.get('teamMemberDelivery').summary='Corrected format only';f.response={structuredContent:{deliveryPreflight:{valid:true},finalReceipt:{kind:'team-saved-delivery'}}};await f.run();assert.equal(f.calls.length,2);assert.equal(f.calls[1].arguments.requestId,'next-original-request');assert.equal(f.calls[0].arguments.bootstrapToken,f.calls[1].arguments.bootstrapToken);
});
test('unknown transport preserves the exact request; changed content cannot replace it or start validation',async()=>{
 const f=fixture();f.throw=true;await assert.rejects(f.run,/unknown/);const old=structuredClone(f.cache.get('teamMemberPendingReport'));f.cache.get('teamMemberDelivery').summary='different';await assert.rejects(f.run,/outcome is unknown/);assert.deepEqual(f.cache.get('teamMemberPendingReport'),old);assert.equal(f.calls.length,1);f.cache.get('teamMemberDelivery').summary='Factual report';f.throw=false;await f.run();assert.deepEqual(f.calls[1],f.calls[0]);
});
test('known server rejection offers only an explicit original-proposal recovery receipt, never PASS or a new execution',async()=>{
 const f=fixture();f.response={isError:true,content:[{type:'text',text:'No unique self-bound current attempt'}]};await f.run();assert.deepEqual(f.cache.get('teamMemberRecoveryReceipt'),{kind:'team-report-recovery',requestId:'original-request'});assert.equal(f.cache.get('teamMemberFinishedReport'),undefined);assert.equal(f.cache.get('teamMemberPendingReport').bootstrapToken,'exact-original-capability');assert.equal(f.calls.length,1);
});
test('malformed local report and missing binding never issue a report or command',async()=>{
 for(const bad of ['missing','summary','large','inputs']){const f=fixture();if(bad==='missing')f.cache.delete('teamMemberBootstrap');if(bad==='summary')f.cache.get('teamMemberDelivery').summary='';if(bad==='large')f.cache.get('teamMemberDelivery').body='x'.repeat(25000);if(bad==='inputs')f.cache.get('teamMemberDelivery').verificationInputs=[null];await assert.rejects(f.run);assert.equal(f.calls.length,0);}
});
test('bootstrap retains full identity and executable report transport internally but exposes factual data once',async()=>{
 const p={readyForWork:true,reportArguments:{teamId:'team',bootstrapToken:'DO-NOT-RECOPY'},nextReportRequestId:'request',reportProgram:'INTERNAL EXECUTABLE',memberReportInvocation:'invocation',deliveryTemplate:{summary:''}},cache=new Map(),output=[];
 await new Function('tools','ALL_TOOLS','text','store','exit','return(async()=>{'+memberBootstrapProgram({teamId:'team',bootstrapToken:'initial'})+'})()')({mcp__test__team_member:async()=>({structuredContent:p})},[{name:'mcp__test__team_member'}],v=>output.push(v),(k,v)=>cache.set(k,v),()=>{throw Error('exit')});assert.equal(cache.get('teamMemberBootstrap'),p);assert.equal(output[0].reportArguments,undefined);assert.equal(output[0].reportProgram,undefined);assert.deepEqual(output[0].deliveryTemplate,p.deliveryTemplate);assert.doesNotMatch(JSON.stringify(output),/DO-NOT-RECOPY|INTERNAL EXECUTABLE/);
});

test('bootstrap recipe is lexically isolated inside an existing orchestration exec',async()=>{
 const output=[],cache=new Map();const code='const n=1,payload=2,r=3; '+memberBootstrapProgram({teamId:'team',bootstrapToken:'exact'});await new Function('tools','ALL_TOOLS','text','store','exit','return(async()=>{'+code+'})()')({mcp__test__team_member:async()=>({structuredContent:{readyForWork:true,reportArguments:{teamId:'team',bootstrapToken:'exact'}}})},[{name:'mcp__test__team_member'}],v=>output.push(v),(k,v)=>cache.set(k,v),()=>{throw Error('exit')});assert.equal(cache.get('teamMemberBootstrap').readyForWork,true);assert.equal(output.length,1);
});
