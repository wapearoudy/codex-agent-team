import {evidenceHash} from './evidence-snapshot.mjs';
import {applyReviewDecision} from './reviewer-acceptance.mjs';
import {recoverableReview} from './review-recovery.mjs';
import {requireTeamVersion} from './team-version.mjs';
import {futureReviewChecks} from './review-scope.mjs';
import {parseReview} from './quality-gates.mjs';

const uuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/i.test(v);
const assertActive=t=>{if(['stopping','halted','archived','superseded','delivered'].includes(t.state)||t.executionControl&&t.executionControl.status!=='active')throw new Error('Resume the original team before registering a saved review');};
const failed=c=>c.status==='failed'||c.exitCode!=null&&c.exitCode!==0;
const publicReceipt=r=>({kind:'review-reconciliation',requestId:r.requestId,taskId:r.taskId,attemptId:r.attemptId,targetTaskId:r.targetTaskId,targetAttemptId:r.targetAttemptId,registeredAtRecording:true,futureChecks:r.futureChecks,preservedOriginals:true,startsModel:false,runsCommands:false});

export async function reconcileReview(engine,owner,id,revision,input){
  if(!uuid(input.requestId)||typeof input.note!=='string'||!input.note.trim()||input.note.length>3000)throw new Error('Stable review reconciliation request and note required');
  const team=await engine.native(owner,id),review=team.tasks.find(t=>t.id===input.taskId),a=review?.attempts.find(x=>x.id===input.attemptId),requestHash=evidenceHash({taskId:input.taskId,attemptId:input.attemptId,note:input.note,nonValidationFailures:input.nonValidationFailures??[]});
  const prior=a?.reviewReconciliations?.find(r=>r.requestId===input.requestId);
  if(prior){if(prior.requestHash!==requestHash)throw new Error('Review request ID has different contents');return {...publicReceipt(prior),replayed:true,dryRun:input.dryRun!==false};}
  assertActive(team);
  if(team.revision!==revision)throw new Error('Team changed; refresh before reconciling the saved review');
  if(a!==review?.attempts.at(-1)||!recoverableReview(team,review))throw new Error('Current saved accepted verdict with a plugin registration exception required; stale, running and genuine rework reviews cannot be reconciled');
  if((a.reviewReconciliations?.length??0)>=10)throw new Error('Review reconciliation limit reached');
  const draft=structuredClone(team),r=draft.tasks.find(t=>t.id===review.id),originalEvidenceHash=evidenceHash(r.evidence.findLast(e=>e.attemptId===a.id)?.summary),exception=structuredClone(a.acceptanceException),futureChecks=futureReviewChecks(team,review,parseReview(review.evidence.findLast(e=>e.attemptId===a.id)?.summary,a.marker));
  // This provisional status exists only inside the draft. A failed gate never
  // alters the live status, report, observations or historical attempts.
  r.status='submitted';
  let blocker=null;
  try{await applyReviewDecision(engine,draft,r.id,a.id,'accept',input.note,input.nonValidationFailures??[],[],{automatic:true});}catch(error){blocker=error.message;}
  const unresolvedCommands=(a.observation.commands??[]).flatMap((c,commandIndex)=>failed(c)&&!(input.nonValidationFailures??[]).some(x=>x.commandIndex===commandIndex)?[{commandIndex,commandId:c.commandId??null,exitCode:c.exitCode??null,status:c.status,command:String(c.command??'').slice(0,160)}]:[]);
  if(input.dryRun!==false)return {kind:'review-reconciliation-preview',taskId:review.id,attemptId:a.id,canRegister:!blocker,blockers:blocker?[blocker.slice(0,1200)]:[],unresolvedCommands:unresolvedCommands.slice(0,8),unresolvedCommandCount:unresolvedCommands.length,hasMoreCommands:unresolvedCommands.length>8,evidenceAccess:{tool:'read_team_context',view:'evidence',taskId:review.id,attemptId:a.id,section:'commands'},futureCheckCount:futureChecks.length,hasMoreFutureChecks:futureChecks.length>8,futureChecks:futureChecks.slice(0,8).map(x=>({checkIndex:x.checkIndex,criterionId:x.criterionId,taskId:x.taskId})),preservedOriginals:true,startsModel:false,runsCommands:false,dryRun:true};
  if(blocker)throw new Error(blocker);
  const result=await engine.store.update(id,owner,revision,async t=>{
    assertActive(t);
    const current=t.tasks.find(x=>x.id===review.id),attempt=current.attempts.at(-1);
    if(attempt.id!==a.id||!recoverableReview(t,current))throw new Error('Saved review changed during reconciliation');
    const beforeStatus=current.status;current.status='submitted';
    await applyReviewDecision(engine,t,current.id,attempt.id,'accept',input.note,input.nonValidationFailures??[],[],{automatic:true});
    current.blockReason=null;
    const receipt={source:'plugin-saved-review-registration',requestId:input.requestId,requestHash,taskId:current.id,attemptId:attempt.id,targetTaskId:current.reviewOfTaskId,targetAttemptId:attempt.acceptance.targetAttemptId,originalStatus:beforeStatus,originalEvidenceHash,originalException:exception,futureChecks:attempt.futureCheckAssociations?.items.map(x=>({checkIndex:x.checkIndex,criterionId:x.criterionId,taskId:x.taskId}))??[],note:input.note,at:new Date().toISOString()};
    receipt.integrityHash=evidenceHash(receipt);attempt.reviewReconciliations??=[];attempt.reviewReconciliations.push(receipt);requireTeamVersion(t,'0.31.0');
    current.history??=[];current.history.push({type:'saved-review-registered',attemptId:attempt.id,fromStatus:beforeStatus,requestId:receipt.requestId,at:receipt.at});
    t.events.push({type:'saved-review-registered',taskId:current.id,attemptId:attempt.id,requestId:receipt.requestId,at:receipt.at});return receipt;
  });
  return {...publicReceipt(result.result),dryRun:false,replayed:false,revision:result.team.revision};
}
export function validateReviewReconciliations(team){
  for(const task of team.tasks)for(const a of task.attempts??[]){
    if(a.reviewReconciliations===undefined)continue;
    const records=a.reviewReconciliations;
    if(team.requiresTeamWorkspaceVersion!=='0.31.0'||task.kind!=='review'||!Array.isArray(records)||records.length>10||new Set(records.map(r=>r.requestId)).size!==records.length)throw new Error('Invalid saved review reconciliation audit');
    for(const r of records){
      const {integrityHash,...body}=r,dependency=a.dependencyAttempts?.find(d=>d.taskId===task.reviewOfTaskId);
      if(integrityHash!==evidenceHash(body)||r.source!=='plugin-saved-review-registration'||!uuid(r.requestId)||! /^[a-f0-9]{64}$/.test(r.requestHash)||r.taskId!==task.id||r.attemptId!==a.id||r.targetTaskId!==task.reviewOfTaskId||r.targetAttemptId!==dependency?.attemptId||!['waiting','submitted'].includes(r.originalStatus)||r.originalEvidenceHash!==evidenceHash(task.evidence.findLast(e=>e.attemptId===a.id)?.summary)||r.originalException?.source!=='plugin-quality-checks'||r.originalException.attemptId!==a.id||!r.note?.trim()||!Number.isFinite(Date.parse(r.at)))throw new Error('Invalid saved review registration receipt');
    }
  }
}
