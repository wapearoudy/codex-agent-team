import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,readdir,realpath} from 'node:fs/promises';
import {resolve,relative,join} from 'node:path';
import {safeQualityPath} from './team-quality.mjs';

const excluded=new Set(['.git','.codex','node_modules','dist','build','target','.next']);
export const evidenceHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function acceptedEvidenceHash(team,review,target){
  const a=review.attempts.at(-1),b=target.attempts.at(-1),delivery=b.delivery;
  // Verification caches and finding-ledger history are not original evidence.
  const original=delivery&&Object.fromEntries(Object.entries(delivery).filter(([k])=>!['verifiedCommands','commandVerificationVersion'].includes(k)));
  return evidenceHash([review.id,a.id,a.turnId,a.agentThreadId,a.dependencyAttempts,review.evidence.findLast(e=>e.attemptId===a.id)?.summary,a.observation?.commands,target.id,b.id,b.turnId,b.agentThreadId,target.contractRevision??1,target.contract,target.acceptanceCriteria,original,b.observation?.commands,...(b.reusedVerificationCommands?.length?[b.reusedVerificationCommands]:[]),...(b.verificationReconciliations?.length?[b.verificationReconciliations]:[]),...(a.futureCheckAssociations?[a.futureCheckAssociations]:[]),b.evidenceSnapshot?.fingerprint]);
}
// File identities are read by the plugin, not copied into model context. No
// commands are run. Bounds/links fail closed; an incomplete snapshot is not reusable.
export async function captureEvidenceSnapshot(team,task,roots,{fileHashes=false}={}){
  const member=team.members.find(m=>m.id===task.memberId),a=task.attempts.at(-1);
  const base=await realpath(member.workspace?.path??team.projectPath);
  roots??=[...new Set([...(a.delivery?.changedPaths?.length?a.delivery.changedPaths:task.contract?.inScope?.length?task.contract.inScope:member.writeScopes??[]),...(a.delivery?.verificationInputs??[]),...(a.reusedVerificationCommands??[]).flatMap(r=>task.attempts.find(x=>x.id===r.originAttemptId)?.phaseHandoff?.evidenceSnapshot?.roots??[])])];
  if(roots.some(p=>!safeQualityPath(p)))throw new Error('Evidence inputs must be safe project-relative paths');
  roots=[...roots].sort().filter((p,i,all)=>!all.some((parent,j)=>j!==i&&(parent==='.'||p.startsWith(parent+'/'))));
  if(!roots.length&&(task.validationMode??'execute')==='execute'&&task.contract?.verify?.length)throw new Error('Executable evidence requires declared verificationInputs or a scoped input path');
  const rows=[];let bytes=0;
  async function visit(p){
    if(rows.length>=6000||bytes>256*1024*1024)throw new Error('Evidence input snapshot exceeds bounds; select narrower verification inputs');
    const path=resolve(base,p),rel=relative(base,path);if(rel==='..'||rel.startsWith('../')||rel.startsWith('..\\'))throw new Error('Evidence input escapes the workspace');
    // Verify each ancestor as well: lstat on the leaf alone follows directory links.
    let ancestor=base;for(const part of rel.split(/[\\/]/).filter(Boolean)){ancestor=join(ancestor,part);let s;try{s=await lstat(ancestor);}catch(e){if(e.code==='ENOENT'){rows.push([p,'missing']);return;}throw e;}if(s.isSymbolicLink())throw new Error('Evidence inputs cannot traverse symbolic links');}
    const stat=await lstat(path);
    if(stat.isDirectory()){
      rows.push([p,'directory']);for(const name of (await readdir(path)).sort())if(!excluded.has(name))await visit(join(p,name).replaceAll('\\','/'));
    }else if(stat.isFile()){
      bytes+=stat.size;if(bytes>256*1024*1024)throw new Error('Evidence input snapshot exceeds bounds');
      const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);
      const after=await lstat(path);if(stat.size!==after.size||stat.mtimeMs!==after.mtimeMs||stat.ino!==after.ino)throw new Error('Evidence input changed during verification');
      rows.push([p,h.digest('hex')]);
    }else throw new Error('Unsupported evidence input file type');
  }
  for(const root of roots)await visit(root);
  return {source:'plugin-declared-input-content-hash',workspace:base,roots,fingerprint:evidenceHash(rows),fileCount:rows.filter(r=>!['missing','directory'].includes(r[1])).length,at:new Date().toISOString(),...(fileHashes?{files:Object.fromEntries(rows)}:{})};
}
export async function assertEvidenceSnapshot(team,task){
  const saved=task.attempts.at(-1)?.evidenceSnapshot;
  if(!saved||saved.error)throw new Error('Submitted candidate has no reusable input snapshot; resolve evidence without rerunning completed work');
  const current=await captureEvidenceSnapshot(team,task,saved.roots);
  if(current.workspace!==saved.workspace||current.fingerprint!==saved.fingerprint)throw new Error('Candidate inputs changed after submission; saved evidence does not validate the changed version');
  for(const r of task.attempts.at(-1).verificationReconciliations??[]){
    const snapshot=await captureEvidenceSnapshot(team,task,r.inputSnapshot.roots);
    if(snapshot.workspace!==r.inputSnapshot.workspace||snapshot.fingerprint!==r.inputSnapshot.fingerprint)throw new Error('Historical verification inputs changed; preserve the receipt and resolve the new candidate');
  }
  return current;
}
