import {captureEvidenceSnapshot} from './evidence-snapshot.mjs';
import {acceptanceEvidence} from './team-evidence.mjs';

// Hash each saved scope against itself. Different tasks' aggregate hashes are
// not comparable; no command, acceptance, contract or report is changed here.
export async function verifyCandidateInputs(team,{taskId,attemptId}={}){
  const task=team.tasks.find(t=>t.id===taskId),a=attemptId?task?.attempts.find(a=>a.id===attemptId):task?.attempts.at(-1);
  if(!a)throw new Error('Task evidence attempt not found');
  const saved=a.evidenceSnapshot,base={kind:'team-candidate-verification',teamId:team.id,taskId,attemptId:a.id,historical:task.attempts.at(-1)!==a,observedAt:new Date().toISOString(),executesCommands:false,changesAcceptance:false,scope:'exact-saved-input-roots',comparisonRule:'Compare this attempt with its own saved workspace and roots, never another scope fingerprint.'};
  if(!saved||saved.error)return {...base,verified:false,matchesSavedInputs:null,acceptedCandidateVerified:false,reason:saved?.error??'No saved input snapshot; absence is unknown, not changed or PASS.'};
  let current;
  try{current=await captureEvidenceSnapshot(team,{...task,attempts:[a]},saved.roots);}catch(error){return {...base,verified:false,matchesSavedInputs:null,acceptedCandidateVerified:false,reason:error.message};}
  let integrity=null,integrityIssue;
  if(a.acceptance&&task.kind!=='review')try{integrity=acceptanceEvidence(team,task,a).savedEvidenceMatchesReceipt;}catch(error){integrity=false;integrityIssue=error.message;}
  const matchesSavedInputs=current.workspace===saved.workspace&&current.fingerprint===saved.fingerprint;
  const historicalInputs=[];
  for(const r of a.verificationReconciliations??[]){
    const snapshot=r.inputSnapshot;
    try{
      if(!snapshot?.roots||!snapshot.fingerprint)throw new Error('Historical verification input snapshot is unavailable');
      const now=await captureEvidenceSnapshot(team,{...task,attempts:[a]},snapshot.roots);
      historicalInputs.push({requestId:r.requestId,matches:now.workspace===snapshot.workspace&&now.fingerprint===snapshot.fingerprint});
    }catch(error){historicalInputs.push({requestId:r.requestId,matches:null,reason:error.message});}
  }
  const matchesCompleteSavedInputs=!matchesSavedInputs?false:historicalInputs.some(r=>r.matches===false)?false:historicalInputs.some(r=>r.matches===null)?null:true;
  // The task schema's initial revision is 1 even when legacy records omit it.
  // Compare that canonical revision, never report an absent default as changed.
  // A revised contract still fails against an unversioned initial attempt.
  const contractMatches=a.acceptance?a.acceptance.contractRevision===(task.contractRevision??1):(a.contractRevision??1)===(task.contractRevision??1);
  const review=a.acceptance?team.tasks.find(t=>t.id===a.acceptance.reviewTaskId):null;
  const currentAcceptanceActive=task.status==='accepted'&&review?.status==='accepted'&&review.attempts.at(-1)?.id===a.acceptance?.reviewAttemptId&&!base.historical;
  return {...base,verified:true,workspace:current.workspace,roots:current.roots,fileCount:current.fileCount,savedFingerprint:saved.fingerprint,currentFingerprint:current.fingerprint,matchesSavedInputs,matchesCompleteSavedInputs,historicalInputChecks:{count:historicalInputs.length,comparisons:historicalInputs.slice(0,8),hasMore:historicalInputs.length>8,allChecked:true},registeredAcceptanceIntegrity:integrity,currentContractMatches:contractMatches,currentAcceptanceActive,acceptedCandidateVerified:matchesCompleteSavedInputs===true&&integrity===true&&contractMatches&&currentAcceptanceActive,...(integrityIssue?{integrityIssue}:{}),instruction:'Point-in-time declared input comparison only; environment outside declared inputs is not certified. Complete saved inputs include historical verification reconciliations. Changed/unknown inputs, inactive or invalid acceptance cannot certify current acceptance. Different scopes may legitimately have different fingerprints. Independent business review remains mandatory.'};
}

export function assertCandidateReadScope(team,member,taskId){
  if(!member)return;
  const own=team.tasks.find(t=>t.memberId===member.id&&t.status==='running'),allowed=new Set();
  function include(id){if(allowed.has(id))return;allowed.add(id);for(const d of team.tasks.find(t=>t.id===id)?.dependencies??[])include(d.taskId);}
  if(own)include(own.id);
  if(!allowed.has(taskId))throw new Error('Only the current task and its dependency contexts may be read');
}
