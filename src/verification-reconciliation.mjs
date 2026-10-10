import {readFile,lstat,realpath} from 'node:fs/promises';
import {join,relative,isAbsolute,posix} from 'node:path';
import {createHash} from 'node:crypto';
import {safeQualityPath,parseDelivery} from './team-quality.mjs';
import {captureEvidenceSnapshot,assertEvidenceSnapshot,evidenceHash} from './evidence-snapshot.mjs';
import {assertObservationTurn,attemptTurnIds} from './turn-association.mjs';
import {registrationOptions} from './native-registration.mjs';
import {requireTeamVersion} from './team-version.mjs';
import {contractCommandEvidence,verificationRecords,verificationCommandMatches,initializationBinding,verifiedInitializationBinding,declaredCommandMatches} from './verification-command.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const uuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/i.test(v);
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const inside=(base,path)=>{const r=relative(base,path);return !isAbsolute(r)&&r!=='..'&&!r.startsWith('../')&&!r.startsWith('..\\');};
function field(value,path){
  if(typeof path!=='string'||!path||path.length>200)throw new Error('Select an explicit original report field');
  for(const key of path.split('.')){
    if(!/^[a-zA-Z0-9_-]+$/.test(key)||['__proto__','prototype','constructor'].includes(key)||!value||!Object.hasOwn(value,key))throw new Error('Original report field not found');
    value=value[key];
  }
  return value;
}
function contains(value,wanted){
  // Only values in the already submitted report authorize a legacy manifest.
  // No caller-supplied hash can manufacture a historical input declaration.
  if(typeof value==='string')return value===wanted;
  return value&&typeof value==='object'&&Object.values(value).some(v=>contains(v,wanted));
}
async function safeRead(base,path){
  if(!safeQualityPath(path))throw new Error('Evidence file must be a safe workspace-relative path');
  let current=base;for(const part of path.split('/').filter(Boolean)){current=join(current,part);if((await lstat(current)).isSymbolicLink())throw new Error('Historical evidence cannot traverse symbolic links');}
  const before=await lstat(current);if(!before.isFile()||before.size>4*1024*1024)throw new Error('Historical evidence file exceeds bounds');
  const bytes=await readFile(current),after=await lstat(current);
  if(before.size!==after.size||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs)throw new Error('Historical evidence changed during reading');
  return bytes;
}
const publicSummary=(task,r)=>({kind:'verification-reconciliation',taskId:task.id,attemptId:r.attemptId,requestId:r.requestId,source:r.source,commands:r.commands.map(c=>({commandId:c.commandId,turnId:c.turnId,cwd:c.cwd,status:c.status,exitCode:c.exitCode})),candidateUnchangedAtRecording:true,inputFingerprint:r.inputSnapshot.fingerprint,inputFileCount:r.inputSnapshot.fileCount,verifiedChecks:r.verifiedChecks,nonPassCriteria:r.nonPassCriteria,outOfContractNotes:r.outOfContractNotes,preservedOriginals:true,startsCommand:false});

async function inputSnapshot(engine,team,task,proof,commands,original){
  const a=task.attempts.at(-1),base=await realpath(team.members.find(m=>m.id===task.memberId).workspace?.path??team.projectPath);
  if(!proof||!['submitted-candidate','report-file-map','report-manifest','prepared-command'].includes(proof.kind))throw new Error('Explicit input proof required');
  if(proof.kind==='submitted-candidate'){
    if(commands.some(c=>c.turnId!==a.turnId))throw new Error('Interrupted history requires an at-run input manifest or prepared command fingerprint');
    return {snapshot:await captureEvidenceSnapshot(team,task,a.evidenceSnapshot.roots),proof:{kind:proof.kind,source:'plugin-submitted-candidate'}};
  }
  if(proof.kind==='prepared-command'){
    if(!uuid(proof.requestId)||commands.length!==1)throw new Error('One prepared command request is required per receipt');
    const bytes=await safeRead(await realpath(engine.root),'command-logs/'+team.id+'/'+a.id+'/'+proof.requestId+'.json');
    const p=JSON.parse(bytes.toString('utf8'));
    if(p.teamId!==team.id||p.taskId!==task.id||p.attemptId!==a.id||p.requestId!==proof.requestId)throw new Error('Prepared command identity does not match this attempt');
    if(!p.inputSnapshot?.fingerprint||!p.nativeCommand)throw new Error('Legacy prepared command has no before-command input fingerprint; use the original report file map or declared manifest SHA256, never reconstruct a historical fingerprint');
    if(!verificationCommandMatches(commands[0].command,p.nativeCommand,{cwd:commands[0].cwd,workspace:p.workspace})||p.workspace!==commands[0].cwd)throw new Error('Native command does not match its original prepared input proof');
    const current=await captureEvidenceSnapshot(team,task,p.inputSnapshot.roots);
    if(current.workspace!==p.inputSnapshot.workspace||current.fingerprint!==p.inputSnapshot.fingerprint)throw new Error('Prepared verification inputs changed; do not reuse this result');
    return {snapshot:current,proof:{kind:proof.kind,requestId:proof.requestId,metadataHash:digest(bytes),source:'plugin-before-command-inputs'}};
  }
  let manifest=original,manifestHash;
  if(proof.kind==='report-manifest'){
    if(!sha(proof.sha256)||!contains(original,proof.path)||!contains(original,proof.sha256))throw new Error('Manifest path and SHA256 must be declared in the original submitted report');
    const bytes=await safeRead(base,proof.path);manifestHash=digest(bytes);
    if(manifestHash!==proof.sha256)throw new Error('Original historical input manifest changed');
    manifest=JSON.parse(bytes.toString('utf8'));
  }
  const map=field(manifest,proof.field);
  if(!map||Array.isArray(map)||typeof map!=='object'||!Object.keys(map).length||Object.keys(map).length>6000||Object.entries(map).some(([p,h])=>!safeQualityPath(p)||!sha(h)))throw new Error('Historical input map must contain bounded relative file paths and SHA256 values');
  const prefix=proof.basePath??'.';if(!safeQualityPath(prefix))throw new Error('Historical input base must be workspace-relative');
  const expected=Object.fromEntries(Object.entries(map).map(([p,h])=>[posix.normalize(prefix+'/'+p),h]));
  if(Object.keys(expected).length!==Object.keys(map).length)throw new Error('Historical input map contains duplicate normalized paths');
  if(!Array.isArray(proof.roots)||!proof.roots.length||proof.roots.length>1000||proof.roots.some(p=>!safeQualityPath(p)))throw new Error('Declare the complete verification input roots relative to the historical input base');
  const inputRoots=proof.roots.map(p=>posix.normalize(prefix+'/'+p));
  // The original candidate remains a gate. The legacy map expands its closure;
  // it cannot replace a changed submission or silently narrow its inputs.
  let checked;
  try{checked=await captureEvidenceSnapshot(team,task,[...Object.keys(expected),...inputRoots],{fileHashes:true});}
  catch(error){if(error.message==='Evidence input snapshot exceeds bounds')throw new Error('Historical input roots exceed snapshot bounds; select the source/configuration roots declared by the original manifest instead of the entire project. Every manifest file is still checked.');throw error;}
  if(Object.entries(expected).some(([p,h])=>checked.files[p]!==h)||Object.entries(checked.files).some(([p,h])=>h!=='directory'&&expected[p]!==h))throw new Error('Historical verification inputs changed, are missing, or the declared input closure is incomplete');
  const roots=[...new Set([...a.evidenceSnapshot.roots,...Object.keys(expected),...inputRoots,...(proof.kind==='report-manifest'?[proof.path]:[])])];
  return {snapshot:await captureEvidenceSnapshot(team,task,roots),proof:{kind:proof.kind,field:proof.field,basePath:prefix,roots:proof.roots,mapHash:evidenceHash(Object.entries(expected).sort(([a],[b])=>a.localeCompare(b))),fileCount:Object.keys(expected).length,...(manifestHash?{path:proof.path,sha256:manifestHash}:{}),source:'original-member-input-declaration-plugin-rechecked'}};
}

export async function reconcileVerification(engine,owner,id,revision,input){
  if(!uuid(input.requestId)||typeof input.note!=='string'||!input.note.trim()||input.note.length>3000||!Array.isArray(input.commands)||!input.commands.length||input.commands.length>30||input.commands.some(c=>!c.turnId||!c.commandId)||new Set(input.commands.map(c=>c.turnId+'\0'+c.commandId)).size!==input.commands.length)throw new Error('Stable request, note and unique native command identities required');
  const team=await engine.native(owner,id),task=team.tasks.find(t=>t.id===input.taskId),a=task?.attempts.at(-1);
  const requestHash=evidenceHash({taskId:input.taskId,attemptId:input.attemptId,note:input.note,inputProof:input.inputProof,commands:input.commands});
  const prior=a?.verificationReconciliations?.find(r=>r.requestId===input.requestId);
  if(prior){if(prior.requestHash!==requestHash)throw new Error('Verification request ID has different contents');return {...publicSummary(task,prior),replayed:true,dryRun:!!input.dryRun};}
  if(team.revision!==revision)throw new Error('Team changed; refresh before reconciling verification');
  if(!a||a.id!==input.attemptId||task.kind==='review'||task.status!=='submitted'||!task.contract||!a.agentThreadId||a.observation?.status!=='completed'||(a.contractRevision??1)!==(task.contractRevision??1))throw new Error('Current submitted contract delivery required; accepted history is immutable');
  if((a.verificationReconciliations?.length??0)>=30)throw new Error('Verification reconciliation limit reached');
  await assertEvidenceSnapshot(team,task);
  const run=await engine.observer.inspect(team.leaderThreadId,team.projectPath,a.agentThreadId,a.marker,{boundTurnId:a.turnId,...registrationOptions(a)});
  assertObservationTurn(a,run);
  if(run.source!=='native-thread-persisted-snapshot'||run.parentThreadId!==team.leaderThreadId||run.turnId!==a.turnId||run.status!=='completed')throw new Error('Exact saved native completion required; cannot rebind to another turn');
  const report=task.evidence.findLast(e=>e.attemptId===a.id);
  // Registration may adapt the summary's format. The saved native output is
  // still the immutable original, including whitespace and the raw envelope.
  const raw=a.observation.outputs?.at(-1)?.text??report?.references?.find(r=>typeof r.rawDelivery==='string')?.rawDelivery??report?.summary;
  if(run.outputs?.at(-1)?.text!==raw)throw new Error('Original native report changed; preserve it and resolve the exception');
  const original=parseDelivery(raw,a.marker),base=await realpath(team.members.find(m=>m.id===task.memberId).workspace?.path??team.projectPath);
  const rows=run.turnHistory??[run],saved=a.turnHistory??a.observation.turnHistory??[a.observation],commands=[];
  for(const wanted of input.commands){
    const row=rows.find(r=>r.turnId===wanted.turnId),old=saved.find(r=>r.turnId===wanted.turnId);
    if(!row||!old||!attemptTurnIds(a).includes(wanted.turnId))throw new Error('Native command is outside the saved attempt turn chain');
    const matches=row.commands.filter(c=>c.commandId===wanted.commandId),c=matches[0];
    if(matches.length!==1||c.turnId!==row.turnId||c.status!=='completed'||c.exitCode!==0||typeof c.command!=='string'||!c.command.trim()||c.command.length>32768||!isAbsolute(c.cwd??''))throw new Error('Successful terminal native command with verified absolute working directory required; unknown exits are not PASS');
    const before=old.commands.filter(x=>x.commandId?x.commandId===c.commandId:x.command===c.command);
    if(before.length!==1||before[0].command!==c.command||before[0].cwd&&before[0].cwd!==c.cwd||Number.isInteger(before[0].exitCode)&&before[0].exitCode!==0)throw new Error('Original native command identity or terminal result conflicts with fresh receipt');
    if(!inside(base,await realpath(c.cwd)))throw new Error('Native verification directory is outside the assigned workspace');
    const record={commandId:c.commandId,turnId:c.turnId,command:c.command,cwd:c.cwd,status:c.status,exitCode:c.exitCode,originThreadId:a.agentThreadId,source:'reconciled-native-command'};
    if(wanted.contractCommand!==undefined||wanted.initializationCommands!==undefined){
      if(typeof wanted.contractCommand!=='string'||!(task.contract.verify??[]).includes(wanted.contractCommand)||!Array.isArray(wanted.initializationCommands)||!wanted.initializationCommands.length||wanted.initializationCommands.length>11)throw new Error('Declare the exact contract command and every literal initialization clause');
      const binding=initializationBinding(c.command,wanted.contractCommand,{cwd:c.cwd,workspace:base,initializationCommands:wanted.initializationCommands});
      if(!binding)throw new Error('Initialization chain must end in the exact contract command, use only declared literal setup and preserve its failure exit');
      if(!(original.commandsRun??[]).some(d=>declaredCommandMatches(c.command,typeof d==='string'?d:d?.command,{cwd:c.cwd,workspace:d?.cwd??c.cwd})))throw new Error('The entire initialization chain must be declared in the original submitted report');
      record.verificationBinding=binding;
    }
    commands.push(record);
  }
  const proof=await inputSnapshot(engine,team,task,input.inputProof,commands,original);
  const receipt={requestId:input.requestId,requestHash,taskId:task.id,attemptId:a.id,marker:a.marker,threadId:a.agentThreadId,turnId:a.turnId,contractRevision:task.contractRevision??1,candidateFingerprint:a.evidenceSnapshot.fingerprint,originalReportHash:digest(raw),source:'plugin-reconciled-native-verification',commands,nonPassCriteria:original.acceptanceResults.filter(c=>c.status!=='PASS'&&task.acceptanceCriteria.some(x=>x.id===c.criterionId)).map(c=>({criterionId:c.criterionId,status:c.status})),outOfContractNotes:original.acceptanceResults.filter(c=>c.status==='NOT_RUN'&&!task.acceptanceCriteria.some(x=>x.id===c.criterionId)).map(c=>({criterionId:c.criterionId,status:c.status})),verifiedChecks:contractCommandEvidence(task.contract.verify??[],verificationRecords({...a,verificationReconciliations:[...(a.verificationReconciliations??[]),{commands}]}),{workspace:proof.snapshot.workspace}).map((c,index)=>({index,observed:c.observed})),inputProof:proof.proof,inputSnapshot:proof.snapshot,note:input.note,at:new Date().toISOString()};
  receipt.integrityHash=evidenceHash(receipt);
  if(input.dryRun!==false)return {...publicSummary(task,receipt),dryRun:true,replayed:false};
  const savedReceipt=await engine.store.update(id,owner,revision,async t=>{
    const current=t.tasks.find(x=>x.id===task.id),attempt=current.attempts.at(-1);
    if(attempt.id!==a.id||current.status!=='submitted')throw new Error('Current submitted attempt changed');
    await assertEvidenceSnapshot(t,current);
    const checked=await captureEvidenceSnapshot(t,current,receipt.inputSnapshot.roots);
    if(checked.workspace!==receipt.inputSnapshot.workspace||checked.fingerprint!==receipt.inputSnapshot.fingerprint)throw new Error('Verification inputs changed during reconciliation');
    attempt.verificationReconciliations??=[];attempt.verificationReconciliations.push(receipt);
    requireTeamVersion(t,'0.30.0');
    if(commands.some(c=>c.verificationBinding))requireTeamVersion(t,'0.32.0');
    // Only derived caches change. Raw delivery, interruption and review evidence
    // retain every byte and every original FAIL/BLOCKED/unknown declaration.
    attempt.delivery.verifiedCommands=contractCommandEvidence(current.contract.verify??[],verificationRecords(attempt),{workspace:checked.workspace});
    attempt.delivery.commandVerificationVersion=2;
    t.events.push({at:receipt.at,type:'verification-evidence-reconciled',taskId:current.id,attemptId:attempt.id,requestId:receipt.requestId,commandIds:commands.map(c=>c.commandId)});
    for(const r of t.tasks.filter(r=>r.kind==='review'&&r.reviewOfTaskId===current.id&&r.status==='submitted'))await engine.validateSubmittedReview(t,r);
    return receipt;
  });
  return {...publicSummary(savedReceipt.team.tasks.find(x=>x.id===task.id),receipt),dryRun:false,replayed:false,revision:savedReceipt.team.revision};
}
export function validateVerificationReconciliations(team){
  for(const task of team.tasks)for(const a of task.attempts??[]){
    const records=a.verificationReconciliations;if(records===undefined)continue;
    if(!['0.30.0','0.31.0','0.32.0'].includes(team.requiresTeamWorkspaceVersion)||!Array.isArray(records)||records.length>30||new Set(records.map(r=>r.requestId)).size!==records.length)throw new Error('Invalid historical verification audit version or requests');
    for(const r of records){
      const {integrityHash,...body}=r;
      if(integrityHash!==evidenceHash(body)||!uuid(r.requestId)||!sha(r.requestHash)||r.source!=='plugin-reconciled-native-verification'||r.taskId!==task.id||r.attemptId!==a.id||r.threadId!==a.agentThreadId||r.turnId!==a.turnId||r.marker!==a.marker||r.contractRevision!==(a.contractRevision??1)||r.candidateFingerprint!==a.evidenceSnapshot?.fingerprint||!sha(r.originalReportHash)||!Number.isFinite(Date.parse(r.at))||r.inputSnapshot?.source!=='plugin-declared-input-content-hash'||!sha(r.inputSnapshot.fingerprint)||r.inputSnapshot.workspace!==a.evidenceSnapshot.workspace||!Array.isArray(r.inputSnapshot.roots)||r.inputSnapshot.roots.some(p=>!safeQualityPath(p))||!r.commands?.length||r.commands.some(c=>c.originThreadId!==a.agentThreadId||!attemptTurnIds(a).includes(c.turnId)||!c.commandId||!isAbsolute(c.cwd??'')||c.source!=='reconciled-native-command'||c.status!=='completed'||c.exitCode!==0))throw new Error('Invalid historical native verification evidence');
      for(const c of r.commands.filter(c=>c.verificationBinding))if(team.requiresTeamWorkspaceVersion!=='0.32.0'||!verifiedInitializationBinding(c,c.verificationBinding.required,{workspace:r.inputSnapshot.workspace}))throw new Error('Invalid declared initialization binding; preserve evidence and upgrade');
    }
  }
}
