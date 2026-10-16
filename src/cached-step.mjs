// Full authenticated replies stay in functions.store. Only executable program
// source is omitted from the model's copy; contracts, evidence and decisions
// are never summarized here. Direct MCP replies retain their cold-cache entry.
export function cachedStepProjection(value,{load,store}={}){
 if(!value||typeof value!=='object'||Array.isArray(value))return value;
 // Only identical complete source bytes already emitted in THIS conversation
 // may use a local text reference. Current metadata/authority is still shown;
 // this is neither candidate verification nor an independent review verdict.
 const canCache=typeof load==='function'&&typeof store==='function'&&typeof value.teamId==='string';
 const cacheKey='teamProjection:'+value.teamId;
 const previous=canCache?load(cacheKey):null;
 const memory={protocol:{},sources:previous?.sources??[],nextSourceId:previous?.nextSourceId??1};
 const sourceBundle=bundle=>{
  if(!canCache||!bundle?.pages)return bundle;
  return {...bundle,pages:bundle.pages.map(page=>{
   if(page.error||page.hasMore!==false||typeof page.text!=='string'||!page.cursor)return page;
   const prior=memory.sources.find(p=>p.path===page.path&&p.startLine===page.startLine&&p.endLine===page.endLine&&p.totalLines===page.totalLines&&p.text===page.text);
   if(!prior){memory.sources=[...memory.sources,{id:memory.nextSourceId++,path:page.path,startLine:page.startLine,endLine:page.endLine,totalLines:page.totalLines,text:page.text}].slice(-24);return page;}
   const {text,...metadata}=page;
   return {...metadata,textAlreadyShown:true,textReference:{storeKey:cacheKey,referenceId:prior.id,path:page.path,instruction:'Identical complete source bytes were previously supplied in this conversation; retain their assessment. Current cursor belongs to this page. If context was compacted, recover exact text with the invocation. Missing/evicted cache requires the current source read; it is never evidence.',invocation:`await (async()=>{const p=load(${JSON.stringify(cacheKey)})?.sources.find(p=>p.id===${prior.id});if(!p||p.path!==${JSON.stringify(page.path)})throw Error('Source text cache missing; use current page read');text(p.text);})();`}};
  })};
 };
 const invoke=(path,field,identity)=>{
  const fence=Object.fromEntries(['teamId','revision','taskId','attemptId'].filter(k=>identity[k]!==undefined).map(k=>[k,identity[k]]));
  return `await (async function(){const s=${path}, f=${JSON.stringify(fence)}, p=${JSON.stringify(field)}.split('.').reduce((x,k)=>x?.[k],s); if(!s||Object.entries(f).some(([k,v])=>s[k]!==v)||typeof p!=='string')throw Error('Cached Team entry is missing or superseded; preserve the original attempt and evidence'); await new (Object.getPrototypeOf(async function(){}).constructor)('tools','ALL_TOOLS','text','store','load','notify','exit',p)(tools,ALL_TOOLS,text,store,load,notify,exit);})();`;
 };
 const execution=(v)=>{
  const out={...v};
  if(v.sourceInputs)out.sourceInputs=sourceBundle(v.sourceInputs);
  if(typeof v.submissionProgram==='string'){
   delete out.submissionProgram;
   out.nextAction='implement-assess-submit';
   out.submissionOwnsVerification=true;
   // Full executable preparation remains authenticated in store. Show required
   // commands once, without forcing the model to recopy routing UUIDs.
   out.verificationPreparation=v.verificationPreparation?.map(p=>({command:p.arguments.command,transport:'submissionInvocation'}));
   out.submissionInvocation=invoke("load('teamStep')?.leaderExecution",'submissionProgram',v);
  }
  if(v.nextRead?.program){
   out.nextRead={...v.nextRead};delete out.nextRead.program;
   out.startInvocation=invoke("load('teamStep')?.leaderExecution",'nextRead.program',v);
   out.nextRead.invocation=out.startInvocation;
  }
  return out;
 };
 const out=value.kind==='leader-execution'?execution(value):{...value};
 if(value.leaderExecution)out.leaderExecution=execution(value.leaderExecution);
 if(typeof value.nextStepProgram==='string'){
  delete out.nextStepProgram;
  out.nextStepInvocation=invoke("load('teamStep')",'nextStepProgram',value);
 }
 // Projection is only valid after its caller stored the complete reply.
 if(typeof value.waitInvocation==='string'){
  delete out.waitProgram;
  out.waitInvocation=invoke("load('teamStep')",'waitInvocation',value);
  out.waitInvocation='// @exec: {"yield_time_ms":55000,"max_output_tokens":2500}\n'+out.waitInvocation;
 }
 if(canCache){
  // Deduplicate static access/instruction recipes only. Decisions, exceptions,
  // contracts, source changes, findings and exact native dispatches stay intact.
  const retained=[];
  for(const key of ['briefAccess','evidenceAccess','nativeDispatchInstruction']){
   if(out[key]===undefined)continue;
   memory.protocol[key]=out[key];
   if(previous?.protocol?.[key]!==undefined&&JSON.stringify(previous.protocol[key])===JSON.stringify(out[key])){delete out[key];retained.push(key);}
  }
  if(retained.length)out.retainedProtocol={storeKey:cacheKey,fields:retained};
  store(cacheKey,memory);
 }
 return out;
}

// Use for a known Leader operation in ONE exec. Discovery, call, full cache and
// projection happen together; no extra model round trip or server-side model.
export async function runCachedLeaderStep({tools,ALL_TOOLS,text,store,load=()=>undefined,project=cachedStepProjection,expectedPluginVersion=null},operation,args){
 const allowed=['start_team_goal','next_team_step','start_team','compile_team_tasks','report_leader_team_task','plan_team_repair','recover_team_startup','reconcile_team_delivery','rework_team_task','finish_team','continue-team'];
 if(!allowed.includes(operation))throw Error('This cache entry accepts advancement/mutation receipts only; read evidence/schema/commands without replacing teamStep');
 const name=ALL_TOOLS.find(t=>t.name.endsWith('__team_leader'))?.name;
 if(!name)throw Error('Team Leader tool unavailable; retain existing attempts');
 if(expectedPluginVersion&&load('teamRuntimeVersion')!==expectedPluginVersion){
  const check=await tools[name]({operation:'manage_team',arguments:{operation:'capabilities'}});
  if(check.isError){text(check);return;}
  const runtime=check.structuredContent??JSON.parse(check.content.find(c=>c.type==='text').text);
  if(runtime.pluginVersion!==expectedPluginVersion){
   text({kind:'team-runtime-version-blocked',expectedPluginVersion,actualPluginVersion:runtime.pluginVersion??null,startsModel:false,runsCommands:false,changesTeam:false,instruction:'Installed package and this conversation tool connection differ. Refresh the plugin connection or use a fresh conversation before starting; preserve existing work and history. Do not poll or start a partial team with the old connection.'});return;
  }
  store('teamRuntimeVersion',runtime.pluginVersion);
 }
 if(operation==='continue-team'){
  if(!args.teamId||Object.keys(args).some(k=>!['teamId','finishReady'].includes(k)))throw Error('continue-team takes only exact teamId and optional finishReady; never supply guessed revision/cursor');
  const saved=load('teamStep');
  if(saved?.continuationArgs?.teamId===args.teamId){args={...saved.continuationArgs,refreshRevision:true,...(args.finishReady===undefined?{}:{finishReady:args.finishReady})};}
  else{
   let current=saved?.teamId===args.teamId&&Number.isInteger(saved.revision)?saved:null;
   if(!current){
   const read=await tools[name]({operation:'read_team',arguments:{teamId:args.teamId,view:'coordination'}});
   if(read.isError){text(read);return;}
   current=read.structuredContent??JSON.parse(read.content.find(c=>c.type==='text').text);
   }
   if(current.teamId!==args.teamId||!Number.isInteger(current.revision)||current.revision<1)throw Error('Authenticated current team/revision unavailable; preserve original attempts');
   // Refresh only routine advancement of this already approved goal. Plan,
   // contract/control edits still require their exact saved revision.
   args={teamId:args.teamId,revision:current.revision,refreshRevision:true,dispatchReady:true,dispatchView:'reference',finishReady:args.finishReady??false};
  }
  operation='next_team_step';
 }
 const result=await tools[name]({operation,arguments:args});
 if(result.isError){text(result);return;}
 let payload=result.structuredContent??JSON.parse(result.content.find(c=>c.type==='text').text);
 const closeKey='teamFinishReady:'+payload.teamId;
 if(args.finishReady!==undefined)store(closeKey,args.finishReady);
 // After a successful authorized repair mutation, advance once in this SAME
 // transport. Never combine a quality decision, wait, failed/unknown mutation,
 // native launch or user-requested rework with this mechanical continuation.
 if((['plan_team_repair','recover_team_startup'].includes(operation)||operation==='reconcile_team_delivery'&&args.dryRun===false&&payload.deliveryReconciliation)&&payload.teamId===args.teamId&&Number.isInteger(payload.revision)&&!payload.dispatches?.length&&!payload.leaderExecution&&!payload.terminal&&!payload.requiresLeaderAction&&!payload.requiresUserDecision&&!payload.waitBlocked&&!payload.usage?.exhausted&&!payload.usage?.unverifiable){
  store('teamRepairReceipt',payload);store('teamStep',payload);
  const advanced=await tools[name]({operation:'next_team_step',arguments:{teamId:payload.teamId,revision:payload.revision,refreshRevision:true,dispatchReady:true,dispatchView:'reference',finishReady:load(closeKey)===true}});
  if(advanced.isError){text({kind:'repair-advancement-blocked',repairSaved:true,rerunsTests:false,startsModel:false,originalReceiptKey:'teamRepairReceipt',error:advanced});return;}
  const next=advanced.structuredContent??JSON.parse(advanced.content.find(c=>c.type==='text').text);
  if(next.teamId!==payload.teamId)throw Error('Repair advancement returned a different team; preserve original mutation and reservations');
  payload={...next,repairAdvancement:{source:'same-exec-authorized-repair',originalRevision:payload.revision,originalReceiptKey:'teamRepairReceipt'}};
 }
 if(payload.kind!=='delivery-reconciliation-preview'&&payload.teamId&&Number.isInteger(payload.revision)&&!payload.dispatches?.length&&!payload.waitInvocation&&!payload.leaderExecution&&!payload.terminal&&!payload.requiresLeaderAction&&!payload.requiresUserDecision&&!payload.waitBlocked){
  const nextArgs={teamId:payload.teamId,finishReady:load(closeKey)===true};
  payload.nextStepProgram=`await (${runCachedLeaderStep.toString()})({tools,ALL_TOOLS,text,store,load,project:${project.toString()}},'continue-team',${JSON.stringify(nextArgs)});`;
 }
 store('teamStep',payload);
  if(payload.leaderExecution?.readyForWork&&payload.leaderExecution.turnId){
   const ex=payload.leaderExecution,k='leaderSubmission:'+ex.attemptId,epoch='leaderSubmissionEpoch:'+ex.attemptId;
   if(ex.resumedFromTurnId&&load(epoch)!==ex.turnId){const old=load(k);if(old!=null)store('leaderSubmissionHistory:'+ex.attemptId,[...(load('leaderSubmissionHistory:'+ex.attemptId)??[]),{turnId:load(epoch)??ex.resumedFromTurnId,state:old}]);store(k,null);store('teamDelivery',null);}
   store(epoch,ex.turnId);
  }
 if(payload.leaderExecution?.readyForWork){
  const identity=payload.leaderExecution.reportArguments;
  if(JSON.stringify(load('teamDeliveryIdentity'))!==JSON.stringify(identity))store('teamDelivery',null);
  store('teamDeliveryIdentity',identity);
 }
 if(payload.waitProgram)store('teamWaitProgram',payload.waitProgram);
 text(project(payload,{load,store}));
}

export function cachedLeaderStepProgram(operation,args){
 return `await (${runCachedLeaderStep.toString()})({tools,ALL_TOOLS,text,store,load,project:${cachedStepProjection.toString()}},${JSON.stringify(operation)},${JSON.stringify(args)});`;
}

export function cachedLeaderEntryProgram({pluginVersion=null}={}){
 return `const call=load('teamCall'); if(!call||typeof call.operation!=='string'||!call.arguments||typeof call.arguments!=='object')throw Error('Store the exact authorized operation/arguments as teamCall before this entry'); await (${runCachedLeaderStep.toString()})({tools,ALL_TOOLS,text,store,load,project:${cachedStepProjection.toString()},expectedPluginVersion:${JSON.stringify(pluginVersion)}},call.operation,call.arguments);`;
}
