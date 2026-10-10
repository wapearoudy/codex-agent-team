import {parseReview,assertReviewPass} from './quality-gates.mjs';
import {assertContractPass,recordFindings,planRepair} from './team-quality.mjs';
import {reviewTask} from './team.mjs';
import {assertPlanExecutable} from './team-plan-review.mjs';
import {requireTeamVersion} from './team-version.mjs';
import {assertEvidenceSnapshot,evidenceHash,acceptedEvidenceHash} from './evidence-snapshot.mjs';
import {verificationRecords,verificationCommandMatches} from './verification-command.mjs';
import {futureReviewChecks,scopeAudit,validateReviewScope} from './review-scope.mjs';

const now=()=>new Date().toISOString();
export function reviewInputHash(team,review){
  const a=review.attempts.at(-1),target=team.tasks.find(t=>t.id===review.reviewOfTaskId),b=target?.attempts.at(-1);
  // A corrected format gate must retry an old cached rejection once. The
  // discriminator stays stable across unchanged reads and process restarts.
  return evidenceHash(['review-contract-scope-and-registration-v5',a?.marker,a?.id,a?.turnId,a?.observation?.commands,review.evidence.findLast(e=>e.attemptId===a?.id)?.summary,a?.dependencyAttempts,target?.status,b?.id,b?.turnId,target?.contractRevision??1,target?.contract,target?.acceptanceCriteria,b?.delivery,b?.evidenceSnapshot,b?.verificationReconciliations,(team.findings??[]).filter(f=>f.rootTaskId===(target?.repairRootTaskId??target?.id)),team.tasks.map(t=>[t.id,t.kind,t.status==='cancelled',t.contractRevision??1,t.acceptanceCriteria,t.dependencies,t.contract])]);
}
export async function applyReviewDecision(engine,team,reviewId,attemptId,decision,note,nonValidationFailures=[],deferredChecks=[],{automatic=false}={}){
  const review=team.tasks.find(t=>t.id===reviewId),a=review?.attempts.at(-1),target=team.tasks.find(t=>t.id===review?.reviewOfTaskId),b=target?.attempts.at(-1);
  if((team.executionControl&&team.executionControl.status!=='active'||['stopping','halted','archived','superseded','delivered'].includes(team.state))&&!(automatic&&team.executionControl?.status==='stopping'))throw new Error('Resume the original team before registering review decisions');
  if(!a||a.id!==attemptId||review.kind!=='review')throw new Error('Current independent review required');
  if(deferredChecks.length&&decision!=='accept')throw new Error('Deferred checks may only annotate an accepted phase review');
  let verdict;try{verdict=parseReview(review.evidence.findLast(e=>e.attemptId===a.id)?.summary,a.marker);}catch(error){if(decision==='accept'||team.policy?.autoRepair)throw error;}
  if(verdict&&team.policy?.autoRepair&&verdict.decision!==decision)throw new Error('Leader decision must match the structured review before automatic repair');
  if(verdict&&decision==='accept'&&verdict.decision!=='accept')throw new Error('Independent reviewer did not accept this candidate');
  if(team.policy?.autoRepair&&(!verdict?.summary?.trim()||!verdict.reason?.trim()||!Array.isArray(verdict.findings)))throw new Error('Automatic repair requires a structured review summary, reason and explicit findings array');
  if(decision==='accept'){
    if(automatic){
      assertPlanExecutable(team);
      const member=team.members.find(m=>m.id===review.memberId);
      if(!target||review.memberId===target.memberId||member?.writeScopes?.length||!a.agentThreadId||a.agentThreadId===b?.agentThreadId||a.observation?.threadId!==a.agentThreadId||b?.observation?.threadId!==b.agentThreadId||a.observation?.status!=='completed'||b.observation?.status!=='completed')throw new Error('Acceptance requires distinct read-only reviewer and host-verified completed deliveries');
    }
    const member=team.members.find(m=>m.id===target?.memberId);
    if(member?.workspace?.mode==='git-worktree'){
      const candidate=await engine.worktrees.inspect(team,member.id),submitted=b?.candidate;
      if(candidate.dirty||!submitted||candidate.head!==submitted.head||candidate.workspace.path!==submitted.path)throw new Error('Isolated candidate changed after submission; rework and independently review the new commit');
    }
    const futureChecks=futureReviewChecks(team,review,verdict),scope={validationMode:target.validationMode,deferredChecks,futureChecks,verificationCommands:target.contract?.verify??[],workspace:b.evidenceSnapshot?.workspace};
    assertReviewPass(verdict,a.observation?.commands??[],target?.acceptanceCriteria??[],nonValidationFailures,scope);
    if(automatic){
      // The contract gate checks the latest required verification outcomes.
      // Incidental work commands are trace evidence, not a second review gate.
      a.nonContractCommandObservations=verificationRecords(b).flatMap((c,commandIndex)=>(c.status==='failed'||c.exitCode!=null&&c.exitCode!==0)&&!(target.contract?.verify??[]).some(required=>verificationCommandMatches(c.command,required,{cwd:c.cwd,workspace:b.evidenceSnapshot?.workspace}))?[{commandIndex,commandId:c.commandId??null,status:c.status,exitCode:c.exitCode??null}]:[]);
    }
    const verification=assertContractPass(target);if(verification)Object.assign(b.delivery,verification);
    if(automatic||b?.evidenceSnapshot?.fingerprint)await assertEvidenceSnapshot(team,target);
    if(futureChecks.length){a.futureCheckAssociations=scopeAudit(team,review,verdict,futureChecks);requireTeamVersion(team,'0.31.0');}
    if(nonValidationFailures.length)a.commandExplanations={source:'main-conversation-leader',note,items:structuredClone(nonValidationFailures),verificationCommands:structuredClone(target.contract?.verify??[]),workspace:b.evidenceSnapshot?.workspace,at:now()};
    if(deferredChecks.length){a.deferredCheckExplanations={source:'main-conversation-leader',note,validationMode:target.validationMode,targetTaskId:target.id,targetAttemptId:b.id,contractRevision:target.contractRevision??1,items:structuredClone(deferredChecks),at:now()};requireTeamVersion(team,'0.21.0');}
  }
  if(verdict?.findings)recordFindings(team,review,target,verdict,{accept:decision==='accept'});
  reviewTask(team,reviewId,{attemptId,decision,note});
  if(a.acceptanceException){a.acceptanceExceptionHistory??=[];a.acceptanceExceptionHistory.push(structuredClone(a.acceptanceException));delete a.acceptanceException;requireTeamVersion(team,'0.31.0');}
  if(b.acceptance){b.acceptanceHistory??=[];b.acceptanceHistory.push(structuredClone(b.acceptance));delete b.acceptance;}
  if(automatic){
    requireTeamVersion(team,'0.24.0');
    const receipt={source:'independent-reviewer',gate:'plugin-quality-checks',reviewTaskId:review.id,reviewAttemptId:a.id,targetTaskId:target.id,targetAttemptId:b.id,reviewThreadId:a.agentThreadId,reviewTurnId:a.turnId,targetTurnId:b.turnId,contractRevision:target.contractRevision??1,evidenceHash:acceptedEvidenceHash(team,review,target),candidateFingerprint:b.evidenceSnapshot.fingerprint,at:now()};
    a.acceptance=receipt;
    b.acceptance=structuredClone(receipt);
    team.events.push({at:receipt.at,type:'reviewer-acceptance-registered',taskId:target.id,attemptId:b.id,reviewTaskId:review.id,reviewAttemptId:a.id});
  }
  if(!team.dispatchPaused&&(!team.executionControl||team.executionControl.status==='active')&&!['stopping','halted','archived','superseded','delivered'].includes(team.state))team.state=team.tasks.every(t=>['accepted','cancelled'].includes(t.status))?'awaiting-leader-acceptance':'active';
  if(decision==='rework'&&team.policy?.autoRepair)planRepair(team,review,target,note);
}
// Ordinary acceptance is a deterministic part of the same settlement commit.
// A failed gate retains the submitted verdict and emits one actionable exception.
export async function acceptCompletedReview(engine,team,review){
  review=team.tasks.find(t=>t.id===review.id);
  if(review.kind!=='review'||review.status!=='submitted'||team.executionControl?.status==='halted'||['halted','archived','superseded','delivered'].includes(team.state))return false;
  const a=review.attempts.at(-1),key=reviewInputHash(team,review);
  if(a.acceptanceException?.inputHash===key)return false;
  const draft=structuredClone(team);
  try{
    const v=parseReview(review.evidence.findLast(e=>e.attemptId===a.id)?.summary,a.marker);
    if(v.decision!=='accept')throw new Error(v.reason?.trim()||'Independent review requires rework');
    await applyReviewDecision(engine,draft,review.id,a.id,'accept',v.reason,[],[],{automatic:true});
    Object.assign(team,draft);return true;
  }catch(error){
    requireTeamVersion(team,'0.24.0');
    if(a.acceptanceException){a.acceptanceExceptionHistory??=[];a.acceptanceExceptionHistory.push(structuredClone(a.acceptanceException));requireTeamVersion(team,'0.31.0');}
    a.acceptanceException={source:'plugin-quality-checks',inputHash:key,reason:error.message,taskId:review.id,attemptId:a.id,at:now(),requiresLeader:true};
    team.events.push({at:now(),type:'review-acceptance-exception',taskId:review.id,attemptId:a.id,reason:error.message});return false;
  }
}
export function validateReviewerAcceptance(team){
  for(const task of team.tasks)for(const a of task.attempts){
    validateReviewScope(team,task,a);
    if(a.futureCheckAssociations)assertReviewPass(parseReview(task.evidence.findLast(e=>e.attemptId===a.id)?.summary,a.marker),a.observation?.commands??[],a.futureCheckAssociations.acceptanceCriteria,a.commandExplanations?.items??[],{validationMode:a.deferredCheckExplanations?.validationMode??'execute',deferredChecks:a.deferredCheckExplanations?.items??[],futureChecks:a.futureCheckAssociations.items,verificationCommands:a.futureCheckAssociations.verificationCommands??[],workspace:a.futureCheckAssociations.workspace});
    if(a.acceptanceException&&(!['0.24.0','0.29.0','0.30.0','0.31.0'].includes(team.requiresTeamWorkspaceVersion)||a.acceptanceException.attemptId!==a.id||task.kind!=='review'||!a.acceptanceException.reason||!a.acceptanceException.inputHash))throw new Error('Invalid reviewer exception audit');
    for(const r of [a.acceptance,...(a.acceptanceHistory??[])].filter(Boolean)){
      const review=team.tasks.find(t=>t.id===r.reviewTaskId),target=team.tasks.find(t=>t.id===r.targetTaskId),ra=review?.attempts.find(x=>x.id===r.reviewAttemptId),ta=target?.attempts.find(x=>x.id===r.targetAttemptId);
      const paired=[ta?.acceptance,...(ta?.acceptanceHistory??[])].some(p=>JSON.stringify(p)===JSON.stringify(r));
      if(!['0.24.0','0.29.0','0.30.0','0.31.0'].includes(team.requiresTeamWorkspaceVersion)||r.source!=='independent-reviewer'||r.gate!=='plugin-quality-checks'||!ra||!ta||review.reviewOfTaskId!==target.id||review.memberId===target.memberId||!ra.agentThreadId||ra.agentThreadId===ta.agentThreadId||ra.review?.decision!=='accept'||r.reviewThreadId!==ra.agentThreadId||r.reviewTurnId!==ra.turnId||r.targetTurnId!==ta.turnId||!Number.isFinite(Date.parse(r.at))||! /^[a-f0-9]{64}$/.test(r.evidenceHash)||r.candidateFingerprint!==ta.evidenceSnapshot?.fingerprint||![ra.id,ta.id].includes(a.id)||JSON.stringify(ra.acceptance)!==JSON.stringify(r)||!paired)throw new Error('Invalid independent reviewer acceptance audit');
    }
  }
}
