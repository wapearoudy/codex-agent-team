import {createHash} from 'node:crypto';
import {resolveDeliveryReceipt} from './delivery-preflight.mjs';
import {acceptedEvidenceHash} from './evidence-snapshot.mjs';
import {parseReview} from './quality-gates.mjs';
import {reviewTargetIds} from './quality-policy.mjs';
// Expose only the requested delivery's registered independent verdict. This is
// historical provenance, never a claim that today's workspace is unchanged.
export function acceptanceEvidence(team,task,a){
  const receipt=a.acceptance;
  if(!receipt)return {recorded:false,taskId:task.id,attemptId:a.id};
  const review=team.tasks.find(t=>t.id===receipt.reviewTaskId),ra=review?.attempts.find(x=>x.id===receipt.reviewAttemptId);
  if(task.kind==='review'||receipt.source!=='independent-reviewer'||receipt.gate!=='plugin-quality-checks'||receipt.targetTaskId!==task.id||receipt.targetAttemptId!==a.id||receipt.targetTurnId!==a.turnId||!ra||receipt.reviewThreadId!==ra.agentThreadId||receipt.reviewTurnId!==ra.turnId||review.kind!=='review'||!reviewTargetIds(review).includes(task.id)||!ra.dependencyAttempts?.some(d=>d.taskId===task.id&&d.attemptId===a.id))throw new Error('Acceptance evidence does not bind this delivery to its independent review');
  const saved=review.evidence?.findLast(e=>e.attemptId===ra.id)?.summary;
  const verdict=parseReview(saved,ra.marker),batch=reviewTargetIds(review).length>1;
  const selected=batch?verdict.targets?.find(v=>v.taskId===task.id&&v.attemptId===a.id):verdict;
  if(!selected||selected.decision!=='accept')throw new Error('Saved acceptance has no matching independent verdict');
  const intact=(task.contractRevision??1)===receipt.contractRevision&&receipt.candidateFingerprint===a.evidenceSnapshot?.fingerprint&&acceptedEvidenceHash(team,{...review,attempts:[ra]},{...task,attempts:[a]})===receipt.evidenceHash;
  return {recorded:true,receipt:structuredClone(receipt),savedEvidenceMatchesReceipt:intact,currentCandidateVerified:false,currentCandidateVerificationStatus:'not-checked-by-this-historical-read',candidateInputReference:{tool:'verify_team_candidate',teamId:team.id,taskId:task.id,attemptId:a.id,roots:a.evidenceSnapshot?.roots??null,fileCount:a.evidenceSnapshot?.fileCount??null},scope:'requested-target-only',verdict:{taskId:task.id,attemptId:a.id,summary:selected.summary,decision:selected.decision,reason:selected.reason,checks:selected.checks,findings:selected.findings},reviewCommandCount:ra.observation?.commands?.length??0,instruction:'Registered historical independent review. currentCandidateVerified=false means this read did not check current files, not that they changed. Use verify_team_candidate to compare this attempt against its own saved complete input scope. Different scopes have different fingerprints; do not require cross-task hash equality. Altered contracts/evidence are not current PASS.'};
}
const hash=value=>createHash('sha256').update(value).digest('hex');
// Transport recipes are data, never authority to run work. Keep byte/character
// limits and list offsets explicit so readers need not rediscover page schemas.
export function evidenceRead(teamId,args){return {operation:'read_team_context',arguments:{teamId,view:'evidence',...args,limit:4000}};}
// Page exact saved public evidence. Truncation is explicit and reversible; the
// persisted observation and validation gates always retain the original bytes.
export function evidencePage(team,{taskId,attemptId,section='delivery',commandIndex,offset=0,limit=4000,cursor}={}){
  if(!['delivery','commands','command','command-output','checkpoint','verification','review-registration','acceptance'].includes(section)||!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<512||limit>8000)throw new Error('Invalid evidence page');
  if(offset>0&&!cursor)throw new Error('A saved evidence cursor is required for subsequent pages');
  const task=team.tasks.find(t=>t.id===taskId),a=attemptId?task?.attempts.find(a=>a.id===attemptId):task?.attempts.at(-1);
  if(!a)throw new Error('Task evidence attempt not found');
  const commands=a.observation?.commands??[];
  if(['command','command-output'].includes(section)&&(!Number.isInteger(commandIndex)||commandIndex<0||!commands[commandIndex]))throw new Error('Evidence command index not found');
  const checkpoint=section==='checkpoint'?team.checkpoints?.find(c=>c.id===a.phaseHandoff?.checkpointId):null;if(section==='checkpoint'&&!checkpoint)throw new Error('Phase checkpoint not found');
  const nativeDelivery=a.observation?.outputs?.at(-1)?.text;
  const resolvedDelivery=section==='delivery'&&nativeDelivery!==undefined?resolveDeliveryReceipt({...task,contractRevision:a.memberSubmission?.contractRevision??task.contractRevision,attempts:[a]},{turnId:a.turnId},nativeDelivery):null;
  const body=section==='acceptance'?JSON.stringify(acceptanceEvidence(team,task,a)):section==='review-registration'?JSON.stringify({futureCheckAssociations:a.futureCheckAssociations,reviewReconciliations:a.reviewReconciliations,acceptanceException:a.acceptanceException,acceptanceExceptionHistory:a.acceptanceExceptionHistory,settlementException:a.settlementException,settlementExceptionHistory:a.settlementExceptionHistory}):section==='verification'?JSON.stringify(a.verificationReconciliations??[]):section==='checkpoint'?JSON.stringify(checkpoint):section==='commands'?'':section==='command'?commands[commandIndex].command??'':section==='command-output'?commands[commandIndex].output??'':resolvedDelivery??task.evidence?.find(e=>e.attemptId===a.id)?.summary??'';
  let bodyHash;
  if(section==='commands'){
    const digest=createHash('sha256').update(String(commands.length));
    for(const c of commands)digest.update(JSON.stringify([c.commandId,c.turnId,c.cwd,c.command,c.status,c.exitCode,hash(String(c.output??''))]));
    bodyHash=digest.digest('hex');
  }else bodyHash=hash(body);
  const token=hash(JSON.stringify([team.id,task.id,a.id,a.turnId,task.contractRevision??1,section,commandIndex??null,bodyHash]));
  if(cursor&&cursor!==token)throw new Error('Evidence changed; do not combine pages from different native results');
  const metadata={kind:'team-evidence',teamId:team.id,revision:team.revision,taskId:task.id,attemptId:a.id,turnId:a.turnId,taskStatus:task.status,attemptState:a.state,nativeStatus:a.observation?.status,requiresNativeSettlement:task.status==='running',section,...(section==='delivery'&&resolvedDelivery!==null&&resolvedDelivery!==nativeDelivery?{deliverySource:'authenticated-saved-draft',nativeReceiptRetained:true}:{}),cursor:token,source:'saved-public-native-evidence',historical:task.attempts.at(-1).id!==a.id,contractRevision:task.contractRevision??1,...(section==='delivery'&&a.memberSubmission?{savedContractRevision:a.memberSubmission.contractRevision}:{}),offset};
  const continuation=nextOffset=>({nextRead:evidenceRead(team.id,{taskId:task.id,attemptId:a.id,section,...(commandIndex!==undefined?{commandIndex}:{}),offset:nextOffset,cursor:token}),offsetUnit:section==='commands'?'command-index':'characters',limitUnit:section==='commands'?'metadata-bytes':'characters'});
  if(section==='commands'){
    if(offset>commands.length)throw new Error('Evidence offset is out of range');
    const rows=[];let bytes=0;
    for(let i=offset;i<commands.length&&rows.length<30;i++){
      const c=commands[i],command=String(c.command??''),row={index:i,...(c.commandId?{commandId:c.commandId}:{}),...(c.cwd?{cwd:c.cwd}:{}),turnId:c.turnId??a.turnId,command:command.slice(0,300),commandTruncated:command.length>300,status:c.status,exitCode:c.exitCode,outputChars:String(c.output??'').length,fullTextAccess:{tool:'read_team_context',view:'evidence',taskId:task.id,attemptId:a.id,commandIndex:i,sections:['command','command-output']},fullTextReads:['command','command-output'].map(section=>evidenceRead(team.id,{taskId:task.id,attemptId:a.id,section,commandIndex:i}))};
      const size=Buffer.byteLength(JSON.stringify(row));if(rows.length&&bytes+size>limit)break;rows.push(row);bytes+=size;
    }
    const nextOffset=offset+rows.length,hasMore=nextOffset<commands.length;
    return {...metadata,commands:rows,nextOffset,hasMore,totalCommands:commands.length,outputLimitChars:limit,...(hasMore?continuation(nextOffset):{offsetUnit:'command-index',limitUnit:'metadata-bytes'})};
  }
  if(offset>body.length)throw new Error('Evidence offset is out of range');
  const text=body.slice(offset,offset+limit),nextOffset=offset+text.length;
  const hasMore=nextOffset<body.length;
  return {...metadata,...(commandIndex!==undefined?{commandIndex}:{}),text,nextOffset,hasMore,totalChars:body.length,outputLimitChars:limit,...(hasMore?continuation(nextOffset):{offsetUnit:'characters',limitUnit:'characters'})};
}
