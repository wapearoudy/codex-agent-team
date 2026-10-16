import {createHash} from 'node:crypto';
import {registrationOptions} from './native-registration.mjs';
import {parseStructuredReport} from './report-format.mjs';
import {preflightDelivery} from './delivery-preflight.mjs';
import {currentVerificationEvidence} from './verification-reuse.mjs';
import {assertEvidenceSnapshot,captureEvidenceSnapshot} from './evidence-snapshot.mjs';
import {reviewTargetIds} from './quality-policy.mjs';
import {submitTask} from './team.mjs';
import {associateTurn,attemptTurnIds,assertObservationTurn} from './turn-association.mjs';
import {requireTeamVersion,teamVersionAtLeast} from './team-version.mjs';
import {assertContractDelivery} from './team-quality.mjs';
import {reusablePhaseCommands} from './task-phases.mjs';
import {latestVerificationCommands} from './verification-command.mjs';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const stamp=()=>new Date().toISOString();
function publicReceipt(r){
 const {originalProposal,earlierReportAttempts,originalFinalText,verificationCommands,requestHash,...rest}=r;
 return {...rest,commands:r.commands.map(({command,...metadata})=>metadata),verification:r.verification.map(({inputRoots,...v})=>({...v,inputRootCount:inputRoots?.length??0}))};
}
async function reusableVerification(engine,team,task,run){
 const history=run.turnHistory?.flatMap(r=>r.commands??[])??run.commands??[],turnIds=attemptTurnIds(run),required=task.contract.verify,workspace=team.members.find(m=>m.id===task.memberId).workspace?.path??team.projectPath;
 const direct=await currentVerificationEvidence(engine.root,team,task,history,required,undefined,{authenticatedTurnIds:turnIds});
 if(direct.every(v=>v.canReuse)||!task.attempts.at(-1).phaseContinuation)return {verification:direct,commands:history};
 const phase=await reusablePhaseCommands(team,task),combined=[...phase,...history],latest=latestVerificationCommands(required,combined,{workspace}),verification=[];
 for(const [i,command] of required.entries()){
  const c=latest[i];if(c?.source!=='verified-phase-evidence'){verification.push(direct[i]);continue;}
  const origin=task.attempts.find(a=>a.id===c.originAttemptId),member=team.members.find(m=>m.id===(origin.memberId??task.memberId));
  if((member.workspace?.path??team.projectPath)!==workspace){verification.push({...direct[i],canReuse:false});continue;}
  const pseudo={...task,memberId:member.id,attempts:[origin]},rows=await currentVerificationEvidence(engine.root,team,pseudo,origin.phaseHandoff.commands,[command],[...(task.contract.inScope??[]),...(task.contract.readPaths??[])],{authenticatedTurnIds:attemptTurnIds(origin)});
  verification.push({...rows[0],originAttemptId:origin.id});
 }
 return {verification,commands:combined};
}
// Explicit Leader selection restores an ORIGINAL native tool proposal, not a
// newly authored verdict. It never repairs a foreign ID, changes statuses or
// runs a command. Ordinary independent QA and final closure remain mandatory.
export async function reconcileDelivery(engine,owner,id,revision,input){
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.requestId??'')||typeof input.note!=='string'||!input.note.trim()||input.note.length>3000||typeof input.nativeReportCallId!=='string'||!input.nativeReportCallId||input.nativeReportCallId.length>200)throw Error('Stable request UUID, exact native report call ID and bounded reason are required');
 const team=await engine.native(owner,id),task=team.tasks.find(t=>t.id===input.taskId),a=task?.attempts.at(-1),digest=hash({taskId:input.taskId,attemptId:input.attemptId,nativeReportCallId:input.nativeReportCallId,note:input.note});
 const old=a?.deliveryReconciliations?.find(r=>r.requestId===input.requestId);
 if(old){if(old.requestHash!==digest)throw Error('Delivery reconciliation request already has different contents');return {...await engine.receipt(owner,id),deliveryReconciliation:{...publicReceipt(old),replayed:true}};}
 if(team.revision!==revision||task?.status!=='running'||a?.id!==input.attemptId||!a.agentThreadId||!a.turnId||a.bootstrapSource!=='authenticated-member-native-observation')throw Error('Only the original current self-bound incomplete registration can reconcile; preserve settled, stale or unrelated work');
 if(['archived','superseded','delivered','stopping','halted'].includes(team.state)||team.executionControl&&team.executionControl.status!=='active')throw Error('Resume the original team before delivery reconciliation');
 // Startup already checked routing and isolation before granting authority.
 // Restoring a completed receipt depends on that original binding and exact
 // native history, not a later GUI preference for the next model turn.
 const member=team.members.find(m=>m.id===task.memberId),run=await engine.observer.inspect(team.leaderThreadId,team.projectPath,a.agentThreadId,a.marker,{boundTurnId:a.turnId,...registrationOptions(a)});
 assertObservationTurn(a,run);
 if(run.status!=='completed'||run.turnId!==a.turnId||run.latestTurnId!==run.turnId||run.threadId!==a.agentThreadId)throw Error('Reconciliation requires the exact completed original native turn');
 const proposed=run.reportAttempts?.at(-1);
 if(!proposed?.callId||proposed.callId!==input.nativeReportCallId||proposed.turnId!==a.turnId||!(proposed.status==='failed'||proposed.isError||proposed.preflightValid===false)||!proposed.delivery)throw Error('Select the latest rejected native delivery proposal, never an older PASS, a successful report or a prose reconstruction');
 if(proposed.identity.teamId!==team.id||proposed.identity.taskId!==undefined&&proposed.identity.taskId!==task.id||proposed.identity.attemptId!==undefined&&proposed.identity.attemptId!==a.id)throw Error('Original report explicitly identifies a foreign task or attempt; it cannot be silently repaired');
 if(a.memberSubmission&&(a.memberSubmission.preflightVersion!==1||a.memberSubmission.requestId!==proposed.requestId||a.memberSubmission.turnId!==run.turnId||a.memberSubmission.text!==proposed.delivery))throw Error('A different authenticated report is already saved; never replace it with a rejected proposal');
 const report=parseStructuredReport(proposed.delivery,{expectedMarker:a.marker}),verification=[],targets=[];
 let commands=run.commands;
 if(task.kind==='review')for(const targetId of reviewTargetIds(task)){
  const target=team.tasks.find(t=>t.id===targetId),dep=a.dependencyAttempts?.find(d=>d.taskId===targetId),latest=target?.attempts.at(-1);
  if(!dep||latest?.id!==dep.attemptId||(target.contractRevision??1)!==(dep.contractRevision??1)||target.status!=='submitted')throw Error('Independent review no longer targets the exact submitted candidate');
  const snapshot=await assertEvidenceSnapshot(team,target);targets.push({taskId:targetId,attemptId:latest.id,contractRevision:target.contractRevision??1,fingerprint:snapshot.fingerprint,workspace:snapshot.workspace});
 }
 else{
  if(!task.contract?.verify?.length||(task.validationMode??'execute')!=='execute')throw Error('No original executable input proof; preserve the proposal rather than reconstruct a historical fingerprint');
  const proof=await reusableVerification(engine,team,task,run);commands=proof.commands;verification.push(...proof.verification);
  if(verification.some(v=>!v.canReuse))throw Error('Original complete prepared inputs or latest native success are missing or changed; never rerun tests for registration');
 }
 // Preserve every report value, including extra checks and command descriptions.
 // Separately verified native outcomes above are authoritative.
 const normalized=report;
 const delivery=JSON.stringify(normalized),preflight=preflightDelivery(team,task,member,delivery,commands,{requireReviewReady:task.kind!=='review'});
 if(!preflight.valid)throw Error('Original report still fails deterministic gates: '+preflight.errors.map(e=>e.path+': '+e.message).join('; ').slice(0,2000));
 const restoredCommands=verification.map(v=>{
  const c=commands.find(c=>c.commandId===v.commandId&&c.turnId===v.turnId);if(!c)throw Error('Original native command disappeared from the verified execution history');
  return {commandId:c.commandId,turnId:c.turnId,command:c.command,cwd:c.cwd,status:c.status,exitCode:c.exitCode,source:'reconciled-native-command',requestId:v.requestId,reconciliationRequestId:input.requestId};
 });
 const receipt={source:'original-native-rejected-report',requestId:input.requestId,requestHash:digest,taskId:task.id,attemptId:a.id,contractRevision:a.contractRevision??task.contractRevision??1,verificationCommands:structuredClone(task.contract?.verify??[]),commands:restoredCommands,threadId:run.threadId,turnId:run.turnId,nativeReportCallId:proposed.callId,originalProposalHash:hash(proposed),normalizedReportHash:hash(normalized),verification,targets,testsExecuted:false,reviewBudgetConsumed:false,note:input.note,at:stamp()};
 if(input.dryRun!==false)return {kind:'delivery-reconciliation-preview',teamId:id,revision,valid:true,proposalSummary:report.summary,receipt:publicReceipt(receipt),commitArguments:{...input,teamId:id,revision,dryRun:false},startsModel:false,runsCommands:false};
 await engine.store.update(id,owner,revision,async t=>{
  const current=t.tasks.find(t=>t.id===task.id),attempt=current.attempts.at(-1);
  if(attempt.id!==a.id||current.status!=='running'||hash(attempt.memberSubmission??null)!==hash(a.memberSubmission??null))throw Error('Original task registration changed during reconciliation');
  // Recheck files under the revision lock. No tests or independent verdict are
  // manufactured by this bookkeeping operation.
  if(current.kind==='review')for(const targetId of reviewTargetIds(current))await assertEvidenceSnapshot(t,t.tasks.find(x=>x.id===targetId));
  else if((await reusableVerification(engine,t,current,run)).verification.some(v=>!v.canReuse))throw Error('Candidate changed during delivery reconciliation');
  associateTurn(t,current,run);
  const record={...receipt,originalProposal:structuredClone(proposed),earlierReportAttempts:structuredClone(run.reportAttempts.slice(0,-1)),originalFinalText:run.outputs.at(-1)?.text??null};record.integrityHash=hash(record);
  (attempt.deliveryReconciliations??=[]).push(record);
  if(attempt.settlementException)(attempt.settlementExceptionHistory??=[]).push(structuredClone(attempt.settlementException));delete attempt.settlementException;
  if(task.kind!=='review'){
    attempt.delivery=assertContractDelivery(current,member,delivery,commands,{projectPath:t.projectPath});
    attempt.evidenceSnapshot=await captureEvidenceSnapshot(t,current,[...new Set([...(current.contract.inScope??[]),...(current.contract.readPaths??[]),...verification.flatMap(v=>v.inputRoots??[]),...(normalized.verificationInputs??[]),...(proposed.verificationInputs??[])])]);
  }
  if(attempt.memberSubmission)attempt.memberSubmission.status='native-verified';
  submitTask(t,current.id,{attemptId:attempt.id,summary:delivery,evidence:[{source:receipt.source,rawDelivery:proposed.delivery,nativeReportCallId:proposed.callId,threadId:run.threadId,turnId:run.turnId,commands}]});
  current.blockReason=null;requireTeamVersion(t,'0.40.51');t.events.push({type:'delivery-reconciled',taskId:current.id,attemptId:attempt.id,nativeReportCallId:proposed.callId,testsExecuted:false,reviewBudgetConsumed:false,at:receipt.at});
  await engine.validateSubmittedReview(t,current);
 });
 return {...await engine.receipt(owner,id),deliveryReconciliation:publicReceipt(receipt)};
}

export function validateDeliveryReconciliations(team){
 for(const task of team.tasks)for(const a of task.attempts??[])for(const r of a.deliveryReconciliations??[]){
  const {integrityHash,...body}=r;if(integrityHash!==hash(body))throw Error('Original native delivery audit changed; retain evidence and upgrade');
  const evidence=task.evidence.find(e=>e.attemptId===a.id&&e.references?.some(p=>p.source==='original-native-rejected-report'&&p.nativeReportCallId===r.nativeReportCallId));
  let normalized;try{normalized=JSON.parse(evidence?.summary);}catch{}
  if(!teamVersionAtLeast(team,'0.40.51')||r.source!=='original-native-rejected-report'||r.taskId!==task.id||r.attemptId!==a.id||r.threadId!==a.agentThreadId||!attemptTurnIds(a).includes(r.turnId)||r.contractRevision!==(a.contractRevision??1)||r.testsExecuted!==false||r.reviewBudgetConsumed!==false||!Number.isFinite(Date.parse(r.at))||!r.note?.trim()||!normalized||hash(normalized)!==r.normalizedReportHash||r.originalProposal?.callId!==r.nativeReportCallId||r.originalProposal.turnId!==r.turnId||hash(r.originalProposal)!==r.originalProposalHash||hash({taskId:r.taskId,attemptId:r.attemptId,nativeReportCallId:r.nativeReportCallId,note:r.note})!==r.requestHash)throw Error('Invalid original native delivery reconciliation; retain raw evidence and upgrade');
  if(task.kind==='review'){
   if(!r.targets?.length||r.targets.some(target=>!a.dependencyAttempts?.some(d=>d.taskId===target.taskId&&d.attemptId===target.attemptId&&(d.contractRevision??1)===target.contractRevision)||!target.fingerprint))throw Error('Invalid restored review candidate proof');
  }else if(!r.verification?.length||r.verification.length!==r.verificationCommands?.length||r.commands?.length!==r.verification.length||r.verification.some((v,i)=>v.command!==r.verificationCommands[i]||v.canReuse!==true||v.currentInputsUnchanged!==true||v.completeRequestedInputs!==true||v.status!=='completed'||v.exitCode!==0||!v.inputFingerprint||!v.inputRoots?.length)||r.commands.some(c=>c.source!=='reconciled-native-command'||!r.verification.some(v=>v.commandId===c.commandId&&v.turnId===c.turnId)||!evidence.references.some(ref=>ref.commands?.some(actual=>['commandId','turnId','command','cwd','status','exitCode'].every(k=>actual[k]===c[k])))))throw Error('Invalid original prepared verification proof');
 }
}
