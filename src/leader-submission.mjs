// Mechanical native-command transport only. The model supplies the factual
// source assessment; this program never invents PASS or an independent verdict.
import {cachedStepProjection} from './cached-step.mjs';
export async function runLeaderSubmission({tools,ALL_TOOLS,text,store,load,notify,project=cachedStepProjection},config){
 const supplied=load('teamDelivery'),identity=load('teamDeliveryIdentity'),key='leaderSubmission:'+config.reportArguments.attemptId;
 const bound=identity&&['teamId','taskId','attemptId'].every(k=>identity[k]===config.reportArguments[k]);
 const delivery=supplied&&typeof supplied==='object'&&!Array.isArray(supplied)?{...supplied,...(supplied.attemptMarker===undefined&&bound?{attemptMarker:config.attemptMarker}:{})}:supplied;
 const stop=(reason,extra={})=>text({kind:'leader-submission-blocked',reason,...extra,rerunsTests:false,startsReview:false});
 if(!delivery||typeof delivery!=='object'||Array.isArray(delivery)||delivery.attemptMarker!==config.attemptMarker||typeof delivery.summary!=='string'||!delivery.summary.trim()||!Array.isArray(delivery.changedPaths)||!Array.isArray(delivery.acceptanceResults))return stop('Supply a factual teamDelivery matching this task before running submission.');
 const nonempty=v=>typeof v==='string'&&!!v.trim();
 for(const id of config.criterionIds){const rows=delivery.acceptanceResults.filter(r=>r?.criterionId===id),row=rows[0];if(rows.length!==1||row?.status!=='PASS'||!(nonempty(row.evidence)||Array.isArray(row.evidence)&&row.evidence.length&&row.evidence.every(nonempty)))return stop('Required source assessment is incomplete; preserve actual FAIL/BLOCKED/NOT_RUN and resolve it before QA.',{criterionId:id});}
 const name=ALL_TOOLS.find(t=>t.name.endsWith('__team_leader'))?.name;if(!name)return stop('Leader tool unavailable; retain this attempt.');
 const call=async(operation,args)=>{const r=await tools[name]({operation,arguments:args});if(r.isError)throw Error(JSON.stringify(r.content));return r.structuredContent??JSON.parse(r.content.find(c=>c.type==='text').text);};
 let state=load(key);if(config.turnId&&load('leaderSubmissionEpoch:'+config.reportArguments.attemptId)&&load('leaderSubmissionEpoch:'+config.reportArguments.attemptId)!==config.turnId)return stop('Submission belongs to an older native Leader turn; use the current authenticated execution bundle.');if(state?.receipt){store('teamStep',state.receipt);if(state.receipt.waitProgram)store('teamWaitProgram',state.receipt.waitProgram);return text(project(state.receipt,{load,store}));}
 // A lost command/report reply is not permission to repeat work. The running
 // exec cell may be resumed normally; a second invocation needs reconciliation.
 if(state&&!['correction-needed','verification-failed','verification-stale'].includes(state.phase))return stop('This submission was already started. Reuse its saved sessions, commands and report; do not run this program again.',{savedProgress:state});
 const correcting=state?.phase==='correction-needed';
 const retrying=['verification-failed','verification-stale'].includes(state?.phase);
 if(!correcting&&!retrying)state={phase:'preparing',commands:[],commandHistory:[],commandBindings:{}};store(key,state);
 try{
  for(const preparation of config.verificationPreparation){
   state.phase=retrying?'verification-failed':correcting?'correction-needed':'preparing';state.commandBindings??={};store(key,state);const requested={...preparation.arguments,requestId:state.commandBindings[preparation.arguments.command]??preparation.arguments.requestId};const prepared=await call(preparation.operation,{...requested,...((retrying||config.resumedFromTurnId)?{refreshChangedInputs:true}:{})});
   if(prepared.mustReuse===true&&prepared.reuseEvidence?.canReuse===true){
    const r=prepared.reuseEvidence;state.commandBindings[preparation.arguments.command]=prepared.requestId??requested.requestId;state.commands=state.commands.filter(c=>c.command!==preparation.arguments.command);state.commands.push({command:preparation.arguments.command,requestId:r.requestId,commandId:r.commandId,turnId:r.turnId,exitCode:r.exitCode,logPath:r.logPath,reused:true});state.phase='verified';store(key,state);continue;
   }
   if(prepared.inputProof?.reusable!==true||prepared.inputProof.currentMatchesSavedInputs!==true){state.phase='verification-stale';store(key,state);return stop('Current inputs do not match the prepared command. Preserve old logs and resolve changed/missing inputs.',{inputProof:prepared.inputProof});}
   if(!prepared.executionArguments){state.phase=['completed','failed'].includes(prepared.reuseEvidence?.status)&&Number.isInteger(prepared.reuseEvidence?.exitCode)?'verification-failed':'unknown-reply';store(key,state);return stop('This prepared command already has an observed execution or requires reconciliation; preserve its original outcome and log.');}
   if(correcting)return stop('Report-only correction has no authenticated unchanged verification; preserve the original result and resolve the input proof, never rerun here.',{reuseEvidence:prepared.reuseEvidence});
   if(retrying&&prepared.refreshedFrom?.source!=='known-native-terminal-on-changed-inputs')return stop('Known failure requires corrected inputs and an authenticated fresh command binding. Unchanged/unknown evidence is not permission to rerun.',{reuseEvidence:prepared.reuseEvidence});
   const actualArguments={...requested,requestId:prepared.requestId??requested.requestId};state.commandBindings[preparation.arguments.command]=actualArguments.requestId;
   state.phase='executing';state.pending={...actualArguments};store(key,state);
   let result=await tools.exec_command(prepared.executionArguments);
   if(result.session_id){state.pending.sessionId=result.session_id;store(key,state);notify('Verification is running; retaining the same native session.');}
   while(result.session_id&&result.exit_code===undefined)result=await tools.write_stdin({session_id:result.session_id,chars:'',...prepared.waitOptions});
   const row={command:preparation.arguments.command,requestId:actualArguments.requestId,exitCode:result.exit_code,logPath:prepared.logPath};(state.commandHistory??=[]).push({...row,inputFingerprint:prepared.inputProof.fingerprint,...(prepared.refreshedFrom?{refreshedFrom:prepared.refreshedFrom}:{})});state.commands=state.commands.filter(c=>c.command!==row.command);state.commands.push(row);delete state.pending;state.phase='verified';store(key,state);
   if(result.exit_code!==0){state.phase=Number.isInteger(result.exit_code)?'verification-failed':'unknown-exit';store(key,state);return stop('Verification failed or its native exit is unknown; no PASS or review was submitted. Correct actual inputs after a known failure, then invoke the same submission program; original logs remain preserved.',{command:row});}
   // Check the complete declared inputs again after the real native command.
   const checked=await call(preparation.operation,actualArguments);
   if(checked.inputProof?.currentMatchesSavedInputs!==true){state.phase='verification-stale';store(key,state);return stop('Source or verification inputs changed during validation; old results remain historical evidence. Fresh validation needs a known terminal native outcome and authenticated changed-input binding.',{inputProof:checked.inputProof});}
  }
  state.phase='reporting';store(key,state);
  const report={...delivery,commandsRun:state.commands.map(c=>({command:c.command,exitCode:c.exitCode,evidence:c.logPath}))};
  const receipt=await call('report_leader_team_task',{...config.reportArguments,requestId:state.correctionRequestId??config.requestId,delivery:JSON.stringify(report),requireReviewReady:true,finishReady:true});
  if(receipt.deliveryPreflight?.valid===false){state.phase='correction-needed';state.correctionRequestId=receipt.correctionRequestId;store(key,state);text(receipt);return;}
  state.receipt=receipt;state.phase='reported';store(key,state);store('teamStep',receipt);if(receipt.waitProgram)store('teamWaitProgram',receipt.waitProgram);text(project(receipt,{load,store}));
 }catch(error){state.phase='unknown-reply';state.error=error.message;store(key,state);stop(error.message,{savedProgress:state});}
}
export function leaderSubmissionProgram(execution,requestId){
 const config={turnId:execution.turnId,resumedFromTurnId:execution.resumedFromTurnId,attemptMarker:execution.deliveryTemplate.attemptMarker,criterionIds:execution.acceptanceCriteria.map(c=>c.id),reportArguments:execution.reportArguments,verificationPreparation:execution.verificationPreparation,requestId};
 return `await (${runLeaderSubmission.toString()})({tools,ALL_TOOLS,text,store,load,notify,project:${cachedStepProjection.toString()}},${JSON.stringify(config)});`;
}
