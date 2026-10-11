import {parseReview,assertReviewPass} from './quality-gates.mjs';
import {assertContractPass,recordFindings,planRepair} from './team-quality.mjs';
import {assertEvidenceSnapshot,acceptedEvidenceHash} from './evidence-snapshot.mjs';
import {reviewTargetIds,commandClassification} from './quality-policy.mjs';
import {requireTeamVersion} from './team-version.mjs';

export async function applyBatchReview(engine,team,review,attemptId,note){
  const a=review.attempts.at(-1),ids=reviewTargetIds(review);
  if(a?.id!==attemptId||review.status!=='submitted'||!a.agentThreadId||a.observation?.status!=='completed'||a.observation.threadId!==a.agentThreadId)throw new Error('Batch review requires a host-verified current terminal attempt');
  const member=team.members.find(m=>m.id===review.memberId);
  if(member?.writeScopes.length)throw new Error('Batch reviewers must be read-only');
  const verdict=parseReview(review.evidence.findLast(e=>e.attemptId===a.id)?.summary,a.marker);
  if(!verdict.summary?.trim()||!Array.isArray(verdict.targets)||verdict.targets.length!==ids.length||new Set(verdict.targets.map(t=>t.taskId)).size!==ids.length||verdict.targets.some(v=>!ids.includes(v.taskId)))throw new Error('Batch review must report exactly one verdict for each target');
  if(verdict.decision!==(verdict.targets.every(v=>v.decision==='accept')?'accept':'rework'))throw new Error('Overall batch verdict must match its per-target decisions');
  const candidates=[];
  for(const id of ids){
    const target=team.tasks.find(t=>t.id===id),b=target?.attempts.at(-1),result=verdict.targets.find(v=>v.taskId===id),dependency=a.dependencyAttempts?.find(d=>d.taskId===id);
    if(target?.status!=='submitted'||review.memberId===target.memberId||!b?.agentThreadId||a.agentThreadId===b.agentThreadId||b.observation?.status!=='completed'||b.observation.threadId!==b.agentThreadId||dependency?.attemptId!==b.id||(dependency.contractRevision??1)!==(target.contractRevision??1)||result.attemptId!==b.id||!['accept','rework'].includes(result.decision)||!result.reason?.trim()||!Array.isArray(result.findings))throw new Error('Batch verdict must bind every distinct delivery and exact current attempt');
    if(result.decision==='accept'){
      assertReviewPass(result,a.observation.commands??[],target.acceptanceCriteria??[],[],{verificationCommands:target.contract?.verify??[],workspace:b.evidenceSnapshot?.workspace,scopedChecks:true});
      const verification=assertContractPass(target);if(verification)Object.assign(b.delivery,verification);
      await assertEvidenceSnapshot(team,target);
      const owner=team.members.find(m=>m.id===target.memberId);
      if(owner.workspace?.mode==='git-worktree'){const candidate=await engine.worktrees.inspect(team,owner.id);if(candidate.dirty||candidate.head!==b.candidate?.head||candidate.workspace.path!==b.candidate?.path)throw new Error('Batch candidate changed after submission');}
    }else if(!result.findings.length)throw new Error('Rework requires concrete findings');
    candidates.push({target,b,result});
  }
  const at=new Date().toISOString();
  a.batchReview=structuredClone(verdict);a.batchAcceptances=[];a.review={decision:'batch',note,at};
  for(const {target,b,result} of candidates){
    recordFindings(team,review,target,result,{accept:result.decision==='accept'});
    if(result.decision==='accept'){
      const receipt={source:'independent-reviewer',gate:'plugin-quality-checks',reviewTaskId:review.id,reviewAttemptId:a.id,targetTaskId:target.id,targetAttemptId:b.id,reviewThreadId:a.agentThreadId,reviewTurnId:a.turnId,targetTurnId:b.turnId,contractRevision:target.contractRevision??1,evidenceHash:acceptedEvidenceHash(team,review,target),candidateFingerprint:b.evidenceSnapshot.fingerprint,at,batch:true};
      b.acceptance=receipt;a.batchAcceptances.push(structuredClone(receipt));target.status='accepted';target.updatedAt=at;
      team.events.push({type:'reviewer-acceptance-registered',taskId:target.id,attemptId:b.id,reviewTaskId:review.id,reviewAttemptId:a.id,at});
    }else {target.status='blocked';target.blockReason=result.reason;target.updatedAt=at;}
  }
  a.commandObservations=(a.observation.commands??[]).flatMap((c,index)=>{const p=commandClassification(c,candidates.flatMap(x=>x.target.contract?.verify??[]),candidates[0]?.b.evidenceSnapshot?.workspace);return p.expectedExitCodes?.includes(c.exitCode)&&c.exitCode!==0?[{commandIndex:index,...p,status:c.status,exitCode:c.exitCode}]:[];});
  review.status='accepted';review.updatedAt=at;review.completedTargets=ids;
  delete a.acceptanceException;requireTeamVersion(team,'0.37.0');
  for(const {target,result} of candidates.filter(x=>x.result.decision==='rework'))if(team.policy?.autoRepair)planRepair(team,review,target,result.reason,{retainReview:true});
  team.events.push({type:'batch-review-registered',taskId:review.id,accepted:a.batchAcceptances.length,rework:candidates.length-a.batchAcceptances.length,at});
  return true;
}
