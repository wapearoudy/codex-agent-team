import {cachedStepProjection} from './cached-step.mjs';
// Coalesce only real bounded timeout receipts, never decisions or dispatch.
// Native launch tools remain a Leader action outside functions.exec.
export const coordinationWaitInvocation=`// @exec: {"yield_time_ms":55000,"max_output_tokens":2500}
await (new Function('tools','ALL_TOOLS','text','store','load','notify','exit','return (async()=>{'+load('teamWaitProgram')+'})()'))(tools,ALL_TOOLS,text,store,load,notify,exit);`;
// The wire entry is self-contained: a direct MCP call need not have initialized
// functions.store. Keep waitProgram only for older start/submission clients.
export function coordinationWaitTransport(arguments_,{includeProgram=true}={}){
 const program=coordinationWaitProgram(arguments_);
 return {...(includeProgram?{waitProgram:program}:{}),waitInvocation:program};
}
export function coordinationWaitProgram(arguments_,{maxWaits=4}={}){
  if(!Number.isInteger(maxWaits)||maxWaits<1||maxWaits>4)throw new Error('Wait transport allows 1–4 bounded waits');
  return `// @exec: {"yield_time_ms":55000,"max_output_tokens":2500}
const name=ALL_TOOLS.find(t=>t.name.endsWith('__team_leader'))?.name;
const project=${cachedStepProjection.toString()};
if(!name)throw new Error('Team Leader tool unavailable; retain existing executions');
const seed=${JSON.stringify(arguments_)}, cached=load('teamStep');
const latest=cached&&(cached.teamId??cached.continuationArgs?.teamId)===seed.teamId&&
 (cached.continuationArgs?.revision??cached.revision??-1)>=(seed.revision??0)?cached:null;
if(latest&&(latest.terminal||latest.requiresLeaderAction||latest.requiresUserDecision||latest.waitBlocked||latest.usage?.exhausted||latest.usage?.unverifiable)){text(project(latest,{load,store}));exit();}
let args={...(latest?.continuationArgs??seed),refreshRevision:true}, payload, timeouts=0;
for(let i=0;i<${maxWaits};i++){
 const r=await tools[name]({operation:'next_team_step',arguments:args});
 if(r.isError){text(r);exit();}
 payload=r.structuredContent??JSON.parse(r.content.find(c=>c.type==='text').text);
 store('teamStep',payload);
 if(payload.status!=='timeout'||!payload.unchanged||!payload.continuationArgs||payload.requiresLeaderAction||payload.requiresUserDecision||payload.waitBlocked||payload.terminal||payload.dispatches?.length||payload.usage?.exhausted||payload.usage?.unverifiable)break;
 timeouts++;
 if(i+1<${maxWaits}){args={...payload.continuationArgs,refreshRevision:true};notify('成员仍在执行；保留当前轮次与等待游标，程序继续等待真实结果。');}
}
text({...project(payload,{load,store}),transportReceipt:{timeoutsCoalesced:timeouts,maxWaits:${maxWaits}}});`;
}
