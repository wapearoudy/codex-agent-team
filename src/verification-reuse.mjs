import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {latestVerificationCommands,registeredCommandMatches} from './verification-command.mjs';
import {captureEvidenceSnapshot} from './evidence-snapshot.mjs';
import {within} from './team-quality.mjs';

// Only native outcomes plus an immutable BEFORE-command complete input proof
// authorize reuse. A filename, caller exit claim or current hash alone cannot.
export async function currentVerificationEvidence(root,team,task,commands,required=task.contract?.verify??[],requestedRoots,{authenticatedTurnIds}={}){
  const a=task.attempts.at(-1),workspace=team.members.find(m=>m.id===task.memberId).workspace?.path??team.projectPath;
  let files=[];const directory=join(root,'command-logs',team.id,a.id);
  try{files=(await readdir(directory)).filter(f=>/^[0-9a-f-]{36}\.json$/i.test(f)).slice(0,100);}catch(e){if(e.code!=='ENOENT')throw e;}
  const records=await Promise.all(files.map(async f=>{const r=JSON.parse(await readFile(join(directory,f),'utf8'));return r.teamId===team.id&&r.taskId===task.id&&r.attemptId===a.id&&r.requestId+'.json'===f&&r.logPath===join(directory,r.requestId+'.log')&&r.workspace===workspace?r:null;}));
  const latest=latestVerificationCommands(required,commands,{workspace});
  return Promise.all(required.map(async(command,i)=>{
    const c=latest[i],base={command,source:'native-outcome-and-original-input-proof',isVerdict:false,executesCommands:false};
    if(!c?.commandId||!(authenticatedTurnIds??(a.executionMode==='leader'?[...(a.leaderResumptions??[]).map(r=>r.fromTurnId),a.turnId]:[a.turnId])).includes(c.turnId)||c.cwd!==workspace)return {...base,canReuse:false,reason:'No exact authenticated native command with verified workspace.'};
    const matches=records.filter(r=>r&&registeredCommandMatches(c.command,r.nativeCommand));
    if(matches.length!==1)return {...base,canReuse:false,reason:'No unique original prepared-command input proof.',turnId:c.turnId,commandId:c.commandId,status:c.status,exitCode:c.exitCode};
    const r=matches[0],saved=r.inputSnapshot;let unchanged=false;
    if(saved?.fingerprint&&!saved.error&&saved.workspace===workspace)try{const current=await captureEvidenceSnapshot(team,task,saved.roots);unchanged=current.workspace===saved.workspace&&current.fingerprint===saved.fingerprint;}catch{}
    const needed=requestedRoots??[...(task.contract?.inScope??[]),...(task.contract?.readPaths??[])],complete=!!saved?.roots?.length&&needed.every(p=>saved.roots.some(scope=>within(p,scope)));
    return {...base,commandId:c.commandId,turnId:c.turnId,status:c.status,exitCode:c.exitCode,requestId:r.requestId,logPath:r.logPath,inputFingerprint:saved?.fingerprint,inputRoots:saved?.roots,currentInputsUnchanged:unchanged,completeRequestedInputs:complete,canReuse:c.status==='completed'&&c.exitCode===0&&unchanged&&complete,reason:!unchanged?'Complete original inputs changed or are unknown.':!complete?'Original input proof does not cover all current verification inputs.':c.status!=='completed'||c.exitCode!==0?'Latest native result failed, is pending or has unknown exit.':null};
  }));
}
