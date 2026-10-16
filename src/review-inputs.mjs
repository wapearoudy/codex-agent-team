import {evidencePage,evidenceRead} from './team-evidence.mjs';
import {verifyCandidateInputs} from './candidate-verification.mjs';
import {reviewTargetIds} from './quality-policy.mjs';
import {verificationRecords,latestVerificationCommands} from './verification-command.mjs';
import {assertContractPass} from './team-quality.mjs';
import {reviewCommandLog} from './review-command-log.mjs';
export const REVIEW_INPUT_MAX_BYTES=14000;
const pick=(v,keys)=>Object.fromEntries(keys.filter(k=>v?.[k]!==undefined).map(k=>[k,v[k]]));

// Selected original evidence, never a generated review conclusion. Returned
// only after member authentication; the immutable dispatch remains unchanged.
export async function reviewInputs(team,task,{root,context}={}){
  if(task?.kind!=='review')return null;
  const a=task.attempts.at(-1),ids=reviewTargetIds(task),selected=ids.slice(0,4);
  const targets=await Promise.all(selected.map(async taskId=>{
    const target=team.tasks.find(t=>t.id===taskId),dep=a.dependencyAttempts?.find(d=>d.taskId===taskId),attempt=target?.attempts.at(-1);
    const base={taskId,attemptId:dep?.attemptId??null};
    if(!attempt||dep?.attemptId!==attempt.id||(dep.contractRevision??1)!==(target.contractRevision??1))return {...base,error:'Review dependency no longer identifies the current exact attempt/contract. Resolve the original reservation; no evidence reuse or replacement dispatch.'};
    try{
      const delivery=evidencePage(team,{taskId,attemptId:attempt.id,section:'delivery',limit:Math.max(512,Math.floor(4000/selected.length))}),commands=evidencePage(team,{taskId,attemptId:attempt.id,section:'commands',limit:Math.max(512,Math.floor(5000/selected.length))}),proof=await verifyCandidateInputs(team,{taskId,attemptId:attempt.id});
      const candidate={...pick(proof,['kind','taskId','attemptId','observedAt','verified','matchesSavedInputs','matchesCompleteSavedInputs','currentContractMatches','savedFingerprint','currentFingerprint','fileCount','historicalInputChecks']),...(proof.reason?{reason:proof.reason.slice(0,600)}:{}),fullProofAccess:{tool:'verify_team_candidate',teamId:team.id,taskId,attemptId:attempt.id}};
      const required=target.contract?.verify??[],selectedCommands=latestVerificationCommands(required,verificationRecords(attempt),{workspace:attempt.evidenceSnapshot?.workspace??team.projectPath});
      // The first chronological page can contain an obsolete failure. Give QA
      // the same latest-outcome identities used by acceptance, never a verdict.
      // A later FAIL/unknown remains authoritative; don't select the last PASS.
      const requiredCommandOutcomes=await Promise.all(required.map(async(command,i)=>{
        const observed=selectedCommands[i],indices=(attempt.observation?.commands??[]).flatMap((c,index)=>observed&&(c===observed||observed.commandId&&c.commandId===observed.commandId&&(c.turnId??attempt.turnId)===(observed.turnId??attempt.turnId))?[index]:[]);
        let savedLog;try{savedLog=await reviewCommandLog(root,team,context,taskId,attempt.id,observed);}catch(error){savedLog={error:error.message.slice(0,300),isVerdict:false};}
        return {command,...(observed?pick(observed,['commandId','turnId','cwd','status','exitCode']):{status:'not-observed'}),source:'latest-contract-command-outcome',...(savedLog?{savedLog}:{}),...(observed?.commandId?{nativeCommandAccess:{tool:'read_team_context',view:'evidence',taskId,attemptId:attempt.id,section:indices.length===1?'commands':'verification'}}:{}),...(indices.length===1?{nativeCommandReads:['command','command-output'].map(section=>evidenceRead(team.id,{taskId,attemptId:attempt.id,section,commandIndex:indices[0]}))}:{})};
      }));
      // A negative deterministic gate is useful before a reviewer ends its
      // native turn. A clear gate is not source correctness or a review PASS.
      let contractGate={clear:true,source:'current-saved-contract-gate',isReviewVerdict:false};try{assertContractPass(target);}catch(error){contractGate={...contractGate,clear:false,reason:error.message,unpassedCriteria:(attempt.delivery?.acceptanceResults??[]).filter(c=>c.status!=='PASS').map(c=>({criterionId:c.criterionId,status:c.status}))};}
      return {...base,delivery,commands,requiredCommandOutcomes,candidate,contractGate};
    }catch(error){return {...base,error:error.message.slice(0,600)};}
  }));
  const result={kind:'team-review-inputs',source:'selected-saved-original-evidence',teamId:team.id,reviewTaskId:task.id,reviewAttemptId:a.id,targets,totalTargets:ids.length,remainingTargets:ids.slice(4),completeTargetSet:ids.length<=4,changesAcceptance:false,executesCommands:false,instruction:'Read every supplied original delivery page and command metadata once; follow hasMore/cursor for needed missing pages, never treat truncated evidence as complete. requiredCommandOutcomes identifies the latest actual matching result for each contract command, including later failure/unknown; the chronological first commands page can contain earlier failures superseded by a recorded correction. Preserve those failures without treating them as the current outcome. Independently inspect actual source against every criterion. Candidate comparisons are point-in-time declared-input proofs, not a review PASS or a reason to rerun successful tests. Changed/unknown inputs prevent reuse; acceptance rechecks all existing gates. Do not reread already complete pages for bookkeeping.'};
  // Keep useful smaller exact pages before omitting a whole target. Chinese
  // text, escaped strings and command recipes all count toward the wire budget.
  while(Buffer.byteLength(JSON.stringify(result))>REVIEW_INPUT_MAX_BYTES&&result.targets.length){
    const logs=result.targets.flatMap(t=>t.requiredCommandOutcomes??[]).filter(c=>c.savedLog?.text);
    if(logs.length){for(const c of logs){const {text,...metadata}=c.savedLog;c.savedLog={...metadata,textOmitted:true,hasMore:true,nextRead:{operation:'read_team_command_log',arguments:{teamId:team.id,taskId:metadata.taskId,attemptId:metadata.attemptId,requestId:metadata.requestId,offset:0,maxChars:6000,cursor:metadata.cursor}}};}continue;}
    const shrinkable=result.targets.flatMap(t=>['delivery','commands'].flatMap(section=>t[section]?.outputLimitChars>512?[{target:t,section,page:t[section]}]:[])).sort((a,b)=>Buffer.byteLength(JSON.stringify(b.page))-Buffer.byteLength(JSON.stringify(a.page)));
    if(shrinkable.length){const {target,section,page}=shrinkable[0];target[section]=evidencePage(team,{taskId:target.taskId,attemptId:target.attemptId,section,limit:Math.max(512,Math.floor(page.outputLimitChars/2))});continue;}
    const omitted=result.targets.pop();result.remainingTargets.unshift(omitted.taskId);result.completeTargetSet=false;
  }
  return result;
}
