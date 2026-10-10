import {contractCommandEvidence} from './verification-command.mjs';
import {parseStructuredReport} from './report-format.mjs';
const nonempty=v=>typeof v==='string'&&v.trim().length>0;
// Preserve the original report; the finding ledger stores a canonical text
// representation. Do not discard invalid items or stringify claimed proof.
export function resolutionEvidenceText(value){
  if(nonempty(value))return value;
  if(Array.isArray(value)&&value.length){
    for(const item of value)if(!nonempty(item))return null;
    return value.join('\n');
  }
  return null;
}
export function parseReview(text,expectedMarker){return parseStructuredReport(text,{expectedMarker,errorMessage:'Reviewer must provide a structured verdict'});}
export function assertReviewPass(verdict,commands=[],requiredCriteria=[],nonValidationFailures=[],{validationMode='execute',deferredChecks=[],futureChecks=[],verificationCommands=[],workspace}={}){
  if(!Array.isArray(futureChecks)||futureChecks.length>30||new Set(futureChecks.map(x=>x?.checkIndex)).size!==futureChecks.length||futureChecks.some(x=>!Number.isInteger(x?.checkIndex)||x.checkIndex<0||!x.taskId||!x.criterionId||!requiredCriteria.length||requiredCriteria.some(c=>c.id===x.criterionId)||verdict?.checks?.[x.checkIndex]?.status!=='NOT_RUN'||verdict.checks[x.checkIndex].criterionId!==x.criterionId||verdict.checks[x.checkIndex].futureTaskId&&verdict.checks[x.checkIndex].futureTaskId!==x.taskId))throw new Error('Invalid future review scope; current criteria cannot be deferred');
  const future=new Set(futureChecks.map(x=>x.checkIndex));
  if(!Array.isArray(deferredChecks)||deferredChecks.length>30||new Set(deferredChecks.map(x=>x?.checkIndex)).size!==deferredChecks.length||deferredChecks.some(x=>!Number.isInteger(x?.checkIndex)||x.checkIndex<0||!nonempty(x.reason)||x.reason.length>2000||verdict?.checks?.[x.checkIndex]?.status!=='NOT_RUN'))throw new Error('Invalid deferred check explanation; only an explicit future NOT_RUN check may be classified');
  if(deferredChecks.length&&validationMode!=='source-only'&&deferredChecks.some(x=>!future.has(x.checkIndex)))throw new Error('Deferred checks require a source-only phase review or a mapped downstream contract; execution checks remain mandatory');
  const deferred=new Set([...future,...deferredChecks.map(x=>x.checkIndex)]);
  if(verdict.decision!=='accept'||!nonempty(verdict.summary)||!nonempty(verdict.reason)||!Array.isArray(verdict.checks)||!verdict.checks.length||!verdict.checks.some(c=>c?.status==='PASS')||verdict.checks.some((c,i)=>!c||!nonempty(c.name)||c.status!=='PASS'&&!deferred.has(i)||!nonempty(c.evidence))){
    const missing=Array.isArray(verdict?.checks)?verdict.checks.flatMap((c,i)=>c?.status!=='PASS'&&!deferred.has(i)?[`checks[${i}] ${c?.criterionId??c?.name??'unnamed'}=${c?.status??'missing'}`]:[]):[];
    throw new Error('Review contains failed, missing or unverified checks; current checks need named PASS evidence and a reason'+(missing.length?': '+missing.slice(0,8).join('; '):''));
  }
  if(new Set(verdict.checks.map(c=>c.name.trim())).size!==verdict.checks.length)throw new Error('Review contains duplicate checks');
  if(!Array.isArray(verdict.findings)||verdict.findings.some(f=>!f||!['blocker','high','medium','low'].includes(f.severity)||!nonempty(f.description)||!['open','resolved'].includes(f.status)))throw new Error('Review needs explicit findings (use [] when none)');
  if(verdict.findings.some(f=>f.status==='resolved'&&!resolutionEvidenceText(f.resolutionEvidence)))throw new Error('Resolved findings need independent resolution evidence: nonempty text or a nonempty array of nonempty text entries');
  if(verdict.findings.some(f=>['blocker','high'].includes(f.severity)&&f.status!=='resolved'))throw new Error('Unresolved blocker/high review findings prevent acceptance');
  if(!Array.isArray(nonValidationFailures)||new Set(nonValidationFailures.map(x=>x.commandIndex)).size!==nonValidationFailures.length||nonValidationFailures.some(x=>!Number.isInteger(x.commandIndex)||x.commandIndex<0||!commands[x.commandIndex]||!nonempty(x.reason)))throw new Error('Invalid non-validation command explanation');
  for(const [index,c] of commands.entries()){
    if(c.status==='inProgress')throw new Error('Review contains unverified command records');
    if((c.exitCode!=null&&c.exitCode!==0||c.status==='failed')&&!nonValidationFailures.some(x=>x.commandIndex===index))throw new Error(`Review contains failed command records; Leader must explicitly explain incidental non-validation failures: commandIndex=${index}, exitCode=${c.exitCode??'unknown'}`);
  }
  const attempted=contractCommandEvidence(verificationCommands,commands,{workspace}).filter(c=>c.hostCommand);
  if(attempted.some(c=>!c.observed))throw new Error('Declared review verification failed or has an unknown exit; an incidental-failure explanation cannot override its latest native outcome');
  const covered=new Set(verdict.checks.filter(c=>c.status==='PASS').map(c=>c.criterionId).filter(Boolean));
  if(requiredCriteria.some(c=>!covered.has(c.id)))throw new Error('Review does not cover every required acceptance criterion');
  return true;
}

export function validateDeferredReviews(team){
  for(const task of team.tasks)for(const a of task.attempts??[]){
    const record=a.deferredCheckExplanations;if(!record)continue;
    const dependency=a.dependencyAttempts?.find(d=>d.taskId===task.reviewOfTaskId),target=team.tasks.find(t=>t.id===task.reviewOfTaskId),evidence=task.evidence?.find(e=>e.attemptId===a.id);
    const future=a.futureCheckAssociations;
    if(!['0.21.0','0.24.0','0.29.0','0.30.0','0.31.0','0.32.0'].includes(team.requiresTeamWorkspaceVersion)||task.kind!=='review'||record.source!=='main-conversation-leader'||record.validationMode!=='source-only'&&!(record.validationMode==='execute'&&future)||!nonempty(record.note)||!Number.isFinite(Date.parse(record.at))||!record.items?.length||record.targetTaskId!==task.reviewOfTaskId||record.targetAttemptId!==dependency?.attemptId||(record.contractRevision??1)!==(dependency?.contractRevision??1)||!target?.attempts.some(x=>x.id===record.targetAttemptId)||!evidence)throw new Error('Deferred review scope audit is invalid; preserve data and upgrade');
    assertReviewPass(parseReview(evidence.summary,a.marker),a.observation?.commands??[],future?.acceptanceCriteria??[],a.commandExplanations?.items??[],{validationMode:record.validationMode,deferredChecks:record.items,futureChecks:future?.items??[],verificationCommands:future?.verificationCommands??a.commandExplanations?.verificationCommands??[],workspace:future?.workspace??a.commandExplanations?.workspace});
  }
}
