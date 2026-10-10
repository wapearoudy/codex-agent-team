import {requireTeamVersion} from './team-version.mjs';
import {captureEvidenceSnapshot,evidenceHash} from './evidence-snapshot.mjs';
import {verificationCommandMatches,latestVerificationCommands} from './verification-command.mjs';
import {OUTPUT_POLICY} from './team-efficiency.mjs';
import {safeQualityPath} from './team-quality.mjs';
import {parseStructuredReport} from './report-format.mjs';

export function requestPhaseHandoff(team,task,checkpoint,input){
  if(!input.handoff)return;
  const a=task.attempts.at(-1);
  if(task.kind==='review'||input.delivery!==undefined||!checkpoint.remainingWork.length)throw new Error('Phase handoff requires unfinished work, no final delivery, and a work task');
  if(task.attempts.filter(x=>x.phaseHandoff?.status==='completed').length>=OUTPUT_POLICY.maxPhaseHandoffs)throw new Error('Phase handoff limit reached; complete the current task or report a blocker');
  const roots=input.verificationInputs??[];if(!Array.isArray(roots)||roots.length>30||roots.some(p=>!safeQualityPath(p)))throw new Error('Invalid phase verification inputs');
  if(a.phaseHandoff&&a.phaseHandoff.requestId!==checkpoint.requestId)throw new Error('One phase handoff per attempt; reuse its stable request ID');
  a.phaseHandoff??={checkpointId:checkpoint.id,requestId:checkpoint.requestId,contractRevision:task.contractRevision??1,verificationInputs:roots,status:'requested',source:'authenticated-member-phase',at:new Date().toISOString()};
  requireTeamVersion(team,'0.29.0');
}
export async function settlePhaseHandoff(team,task,run){
  const a=task.attempts.at(-1),h=a.phaseHandoff;if(!h)return false;
  const checkpoint=team.checkpoints?.find(c=>c.id===h.checkpointId),output=run.outputs?.at(-1)?.text;
  let delivery;try{delivery=parseStructuredReport(output,{expectedMarker:a.marker});}catch{}
  if(run.status!=='completed'||run.threadId!==a.agentThreadId||run.turnId!==a.turnId||!checkpoint||checkpoint.attemptId!==a.id||checkpoint.turnId!==a.turnId||h.contractRevision!==(task.contractRevision??1)||delivery?.kind!=='phase-handoff'||delivery.attemptMarker!==a.marker||delivery.checkpointId!==checkpoint.id)throw new Error('Phase handoff needs its exact completed public checkpoint receipt; preserve the original attempt');
  // Only successful host commands with declared, content-hashed inputs can be
  // reused. A checkpoint's claimed PASS alone has no verification authority.
  const member=team.members.find(m=>m.id===task.memberId),roots=[...new Set([...(task.contract?.inScope?.length?task.contract.inScope:member.writeScopes),...h.verificationInputs])];
  try{h.evidenceSnapshot=await captureEvidenceSnapshot(team,task,roots);}catch(error){h.evidenceSnapshot={error:error.message};}
  h.commands=[...new Set(latestVerificationCommands(task.contract?.verify??[],run.commands??[],{workspace:h.evidenceSnapshot?.workspace}).filter(c=>c?.status==='completed'&&c.exitCode===0))].map(c=>({...c,output:undefined}));
  h.commandsHash=evidenceHash(h.commands);h.status='completed';h.completedAt=new Date().toISOString();
  a.state='handed-off';a.endedAt=h.completedAt;a.summary=checkpoint.summary;task.status='waiting';task.updatedAt=h.completedAt;task.blockReason=null;member.status='idle';member.lastActivityAt=h.completedAt;
  team.events.push({at:h.completedAt,type:'task-phase-handed-off',taskId:task.id,attemptId:a.id,checkpointId:checkpoint.id});return true;
}
export function linkPhaseContinuation(team,task){
  const a=task.attempts.at(-1),prior=task.attempts.at(-2);
  if(prior?.state!=='handed-off')return;
  if(prior.phaseHandoff?.status!=='completed')throw new Error('Phase handoff is not confirmed completed');
  const changed=prior.phaseHandoff.contractRevision!==(task.contractRevision??1),amendment=changed?team.contractAmendments?.findLast(r=>r.taskId===task.id&&r.revision===(task.contractRevision??1)):null;
  if(changed&&!amendment)throw new Error('Phase contract changed without an explicit amendment; preserve the handoff');
  a.phaseContinuation={fromAttemptId:prior.id,checkpointId:prior.phaseHandoff.checkpointId,contractRevision:task.contractRevision??1,source:'verified-phase-continuation',...(changed?{contractAmendmentId:amendment.requestId,priorContractRevision:prior.phaseHandoff.contractRevision}:{})};requireTeamVersion(team,'0.29.0');
}
export async function reusablePhaseCommands(team,task){
  const a=task.attempts.at(-1),records=[],visited=new Set();let current=a;
  while(current?.phaseContinuation){
    if(visited.has(current.id))throw new Error('Invalid phase continuation cycle');visited.add(current.id);
    const prior=task.attempts.find(x=>x.id===current.phaseContinuation.fromAttemptId),h=prior?.phaseHandoff;
    if(!h||h.status!=='completed'||h.contractRevision!==(task.contractRevision??1))break;
    if(h.evidenceSnapshot?.fingerprint&&h.commands?.length){
      let snapshot;try{snapshot=await captureEvidenceSnapshot(team,task,h.evidenceSnapshot.roots);}catch{current=prior;continue;}
      if(snapshot.workspace===h.evidenceSnapshot.workspace&&snapshot.fingerprint===h.evidenceSnapshot.fingerprint)
        for(const c of h.commands)if(!records.some(r=>verificationCommandMatches(r.command,c.command,{cwd:r.cwd,workspace:c.cwd})))records.push({...c,source:'verified-phase-evidence',originAttemptId:prior.id,originThreadId:prior.agentThreadId,originTurnId:prior.turnId,inputFingerprint:snapshot.fingerprint});
    }
    current=prior;
  }
  a.reusedVerificationCommands=records;return records;
}
export function validateTaskPhases(team){
  for(const task of team.tasks)for(const [i,a] of task.attempts.entries()){
    const h=a.phaseHandoff,c=a.phaseContinuation;
    if(a.state==='handed-off'&&h?.status!=='completed')throw new Error('Handed-off attempt has no completed phase evidence');
    if(!h&&!c&&!a.reusedVerificationCommands)continue;
    if(!['0.29.0','0.30.0','0.31.0'].includes(team.requiresTeamWorkspaceVersion))throw new Error('Task phase history requires Team Workspace 0.29.0');
    if(h){const checkpoint=team.checkpoints?.find(x=>x.id===h.checkpointId);if(task.kind==='review'||h.source!=='authenticated-member-phase'||!['requested','completed'].includes(h.status)||!checkpoint||checkpoint.source!=='authenticated-member'||checkpoint.attemptId!==a.id||checkpoint.requestId!==h.requestId||!checkpoint.remainingWork.length||h.contractRevision!==(a.contractRevision??1)||!Array.isArray(h.verificationInputs)||h.verificationInputs.some(p=>!safeQualityPath(p)))throw new Error('Invalid phase checkpoint ownership');
      if(h.evidenceSnapshot?.fingerprint&&(!/^[a-f0-9]{64}$/.test(h.evidenceSnapshot.fingerprint)||h.evidenceSnapshot.source!=='plugin-declared-input-content-hash'||!Array.isArray(h.evidenceSnapshot.roots)||h.evidenceSnapshot.roots.some(p=>!safeQualityPath(p))))throw new Error('Invalid phase input fingerprint');
      if(h.status==='completed'){
        let receipt;try{receipt=parseStructuredReport(a.observation?.outputs?.at(-1)?.text,{expectedMarker:a.marker});}catch{}
        if(a.state!=='handed-off'||!a.endedAt||checkpoint.turnId!==a.turnId||a.observation?.status!=='completed'||a.observation.threadId!==a.agentThreadId||a.observation.turnId!==a.turnId||h.commandsHash!==evidenceHash(h.commands)||receipt?.kind!=='phase-handoff'||receipt.attemptMarker!==a.marker||receipt.checkpointId!==checkpoint.id||h.commands.some(c=>c.status!=='completed'||c.exitCode!==0||!(a.observation.commands??[]).some(x=>evidenceHash({...x,output:undefined})===evidenceHash(c))))throw new Error('Invalid terminal phase evidence');
      }}
    if(c){const prior=task.attempts[i-1],changed=prior?.phaseHandoff?.contractRevision!==c.contractRevision,amendment=team.contractAmendments?.find(r=>r.requestId===c.contractAmendmentId&&r.taskId===task.id&&r.revision===c.contractRevision);if(c.source!=='verified-phase-continuation'||prior?.id!==c.fromAttemptId||prior.state!=='handed-off'||prior.phaseHandoff?.status!=='completed'||prior.phaseHandoff?.checkpointId!==c.checkpointId||c.contractRevision!==(a.contractRevision??1)||changed&&(!amendment||c.priorContractRevision!==prior.phaseHandoff.contractRevision)||!changed&&c.contractAmendmentId)throw new Error('Invalid phase continuation chain');}
    const ancestors=new Set();let parent=a;while(parent.phaseContinuation){const prior=task.attempts.find(x=>x.id===parent.phaseContinuation.fromAttemptId);if(!prior||ancestors.has(prior.id))throw new Error('Invalid phase continuation cycle');ancestors.add(prior.id);parent=prior;}
    for(const r of a.reusedVerificationCommands??[]){const prior=task.attempts.find(x=>x.id===r.originAttemptId),h=prior?.phaseHandoff;if(!c||!ancestors.has(prior?.id)||!h||h.status!=='completed'||h.contractRevision!==(a.contractRevision??1)||r.originThreadId!==prior.agentThreadId||r.originTurnId!==prior.turnId||r.inputFingerprint!==h.evidenceSnapshot?.fingerprint||r.source!=='verified-phase-evidence'||!h.commands.some(x=>evidenceHash({...x,output:undefined})===evidenceHash({...r,source:undefined,originAttemptId:undefined,originThreadId:undefined,originTurnId:undefined,inputFingerprint:undefined,output:undefined})))throw new Error('Invalid reused phase verification');}
  }
}
