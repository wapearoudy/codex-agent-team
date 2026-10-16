import {registeredCommandMatches} from './verification-command.mjs';
import {currentVerificationEvidence} from './verification-reuse.mjs';
import {readFile,mkdir,open,realpath,lstat} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {safeQualityPath} from './team-quality.mjs';
import {captureEvidenceSnapshot} from './evidence-snapshot.mjs';

const hash=s=>createHash('sha256').update(s).digest('hex');
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
export function assertTaskAccess(team,context,taskId,{active=false,attemptId}={}){
  const task=team.tasks.find(t=>t.id===taskId);if(!task)throw new Error('Task not found');
  if(context.cwd!==team.projectPath)throw new Error('Project identity mismatch');
  const leader=context.threadId===team.leaderThreadId;
  if(!leader){
    const member=team.members.find(m=>!m.removedAt&&m.agentThreadId===context.threadId);
    if(!member||context.parentThreadId!==team.leaderThreadId||context.cwd!==team.projectPath)throw new Error('Authenticated current participant required');
    const own=team.tasks.find(t=>t.memberId===member.id&&t.status==='running'),allowed=new Set();
    const include=id=>{if(allowed.has(id))return;allowed.add(id);for(const d of team.tasks.find(t=>t.id===id)?.dependencies??[])include(d.taskId);};if(own)include(own.id);
    if(!allowed.has(taskId)||active&&own?.id!==taskId)throw new Error('Only current own work and dependency evidence may be read');
  }
  const attempt=attemptId?task.attempts.find(a=>a.id===attemptId):task.attempts.at(-1);
  if(active&&(task.status!=='running'||attempt?.id!==task.attempts.at(-1)?.id||!attempt?.agentThreadId||!attempt.turnId))throw new Error('A current bound native attempt is required');
  if(attemptId&&!attempt)throw new Error('Attempt not found');
  return {task,attempt};
}
async function boundedFile(path,base){
  const root=await realpath(base),actual=await realpath(path),rel=relative(root,actual);
  if(isAbsolute(rel)||rel==='..'||rel.startsWith('../')||rel.startsWith('..\\'))throw new Error('File escapes the authorized workspace');
  const before=await lstat(actual);if(!before.isFile()||before.size>4*1024*1024)throw new Error('Select a text file no larger than 4 MiB');
  const bytes=await readFile(actual),after=await lstat(actual);if(before.ino!==after.ino||before.mtimeMs!==after.mtimeMs||before.size!==after.size)throw new Error('File changed while reading');
  if(bytes.includes(0))throw new Error('Only text files are supported');return bytes.toString('utf8');
}
export async function readTeamSource(team,context,{taskId,path,startLine=1,maxChars=4000,cursor}){
  const {task}=assertTaskAccess(team,context,taskId);
  if(!safeQualityPath(path)||!Number.isInteger(startLine)||startLine<1||!Number.isInteger(maxChars)||maxChars<256||maxChars>6000)throw new Error('Invalid source page');
  const member=team.members.find(m=>m.id===task.memberId),base=member.workspace?.path??team.projectPath;
  const body=await boundedFile(resolve(base,path),base),digest=hash(body),token=hash(JSON.stringify([team.id,taskId,path,digest]));if(cursor&&cursor!==token)throw new Error('Source changed; restart the selected page');
  const lines=body.split('\n');let text='',line=startLine-1;
  if(line>=lines.length)throw new Error('Source line is outside the file');
  while(line<lines.length){const value=lines[line]+(line<lines.length-1?'\n':'');if(text.length+value.length>maxChars)break;text+=value;line++;}
  if(!text&&lines[line].length>maxChars)throw new Error('Selected line exceeds page budget; use a focused native search with max_output_tokens=1200');
  return {kind:'team-source-page',path,taskId,startLine,endLine:line,totalLines:lines.length,text,cursor:token,hasMore:line<lines.length,nextLine:line<lines.length?line+1:null,...(line<lines.length?{nextRead:{operation:'read_team_source',arguments:{teamId:team.id,taskId,path,startLine:line+1,maxChars:6000,cursor:token}}}:{})};
}
const requestPath=(root,teamId,attemptId,requestId)=>{
  for(const id of [teamId,attemptId,requestId])if(!/^[0-9a-f-]{36}$/i.test(id??''))throw new Error('Stable team, attempt and request UUIDs required');
  return join(root,'command-logs',teamId,attemptId,requestId);
};
export async function prepareTeamCommand(root,team,context,input,{commands=[]}={}){
  const {task,attempt}=assertTaskAccess(team,context,input.taskId,{active:true,attemptId:input.attemptId});
  if(typeof input.command!=='string'||!input.command.trim()||input.command.length>4000||input.command.includes('\0')||/[\r\n]/.test(input.command))throw new Error('Use one explicit native command of at most 4000 characters');
  if(process.platform==='win32')throw new Error('POSIX log preparation is unavailable; use native max_output_tokens=1200 and save logs with the command’s own log option');
  const stem=requestPath(root,team.id,attempt.id,input.requestId),command=input.command.trim(),workspace=team.members.find(m=>m.id===task.memberId).workspace?.path??team.projectPath;
  await mkdir(join(root,'command-logs',team.id,attempt.id),{recursive:true});
  const inputs=input.verificationInputs??[];
  if(!Array.isArray(inputs)||inputs.length>6000||inputs.some(p=>!safeQualityPath(p)))throw new Error('Verification inputs must be bounded workspace-relative paths');
  const identity={teamId:team.id,taskId:task.id,attemptId:attempt.id,requestId:input.requestId,command,workspace,logPath:stem+'.log'};
  // A literal trailing redirect keeps the native shell exit code and the exact
  // verification command visible. No helper, tee pipeline or synthetic PASS.
  const shell=['/bin/sh','/bin/bash','/bin/zsh'].includes(process.env.SHELL)?process.env.SHELL:'/bin/sh';
  const requestHash=hash(JSON.stringify([identity,inputs]));let record,replayed=false;
  try{record=JSON.parse(await readFile(stem+'.json','utf8'));replayed=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(record){if(Object.entries(identity).some(([k,v])=>record[k]!==v)||record.requestHash&&record.requestHash!==requestHash||!record.requestHash&&inputs.length)throw new Error('Command request ID has different contents');}
  else{
    let inputSnapshot;try{inputSnapshot=await captureEvidenceSnapshot(team,task,[...new Set([...(task.contract?.inScope??team.members.find(m=>m.id===task.memberId).writeScopes??[]),...(task.contract?.readPaths??[]),...inputs])]);}catch(error){inputSnapshot={error:error.message};}
    record={...identity,requestHash,nativeCommand:shell+' -c '+quote(command)+' > '+quote(identity.logPath)+' 2>&1',inputSnapshot,preparedAt:new Date().toISOString()};
    let fd;try{fd=await open(stem+'.json','wx');await fd.writeFile(JSON.stringify(record));await fd.sync();}catch(e){if(e.code!=='EEXIST')throw e;record=JSON.parse(await readFile(stem+'.json','utf8'));replayed=true;if(record.requestHash!==requestHash)throw new Error('Command request ID has different contents');}finally{await fd?.close();}
  }
  const snapshot=record.inputSnapshot;
  let currentSnapshot=snapshot,currentMatchesSavedInputs=!!snapshot&&!snapshot.error;
  if(replayed){try{currentSnapshot=await captureEvidenceSnapshot(team,task,[...new Set([...(task.contract?.inScope??team.members.find(m=>m.id===task.memberId).writeScopes??[]),...(task.contract?.readPaths??[]),...inputs])]);currentMatchesSavedInputs=!!snapshot&&!snapshot.error&&currentSnapshot.fingerprint===snapshot.fingerprint;}catch{currentMatchesSavedInputs=false;}}
  const reuseEvidence=(await currentVerificationEvidence(root,team,task,commands,[command],[...new Set([...(task.contract?.inScope??[]),...(task.contract?.readPaths??[]),...inputs])]))[0];
  const mustReuse=reuseEvidence.canReuse===true,executionObserved=commands.some(c=>c.cwd===workspace&&registeredCommandMatches(c.command,record.nativeCommand));
  const refreshProof=input.refreshChangedInputs===true&&!!currentSnapshot?.fingerprint&&!!reuseEvidence.requestId&&!!reuseEvidence.inputFingerprint&&reuseEvidence.completeRequestedInputs===true&&reuseEvidence.currentInputsUnchanged===false&&['completed','failed'].includes(reuseEvidence.status)&&Number.isInteger(reuseEvidence.exitCode);
  const refreshedFrom=refreshProof?{requestId:reuseEvidence.requestId,commandId:reuseEvidence.commandId,turnId:reuseEvidence.turnId,exitCode:reuseEvidence.exitCode,inputFingerprint:reuseEvidence.inputFingerprint,source:'known-native-terminal-on-changed-inputs',originalEvidencePreserved:true}:null;
  if(refreshProof&&(!currentMatchesSavedInputs||executionObserved)){
    const digest=hash(JSON.stringify(['known-terminal-refresh-v1',team.id,task.id,attempt.id,command,workspace,inputs,task.contractRevision??1,reuseEvidence.requestId,reuseEvidence.inputFingerprint,currentSnapshot.fingerprint])).slice(0,32).split('');digest[12]='5';digest[16]=((parseInt(digest[16],16)&3)|8).toString(16);const token=digest.join(''),freshRequestId=[token.slice(0,8),token.slice(8,12),token.slice(12,16),token.slice(16,20),token.slice(20)].join('-');
    const fresh=await prepareTeamCommand(root,team,context,{...input,requestId:freshRequestId,refreshChangedInputs:false},{commands});
    return {...fresh,refreshedFrom};
  }
  return {kind:'prepared-native-command',...identity,reuseEvidence,mustReuse,executionObserved,...(refreshedFrom?{refreshedFrom}:{}),nativeCommand:record.nativeCommand??shell+' -c '+quote(command)+' > '+quote(record.logPath)+' 2>&1',executionArguments:mustReuse||executionObserved?null:{cmd:record.nativeCommand??shell+' -c '+quote(command)+' > '+quote(record.logPath)+' 2>&1',workdir:workspace,max_output_tokens:1200,yield_time_ms:10000},logReadArguments:{teamId:team.id,taskId:task.id,attemptId:attempt.id,requestId:input.requestId,offset:0,maxChars:2000},...(snapshot?{inputProof:snapshot.error?{reusable:false,reason:snapshot.error}:{reusable:true,currentMatchesSavedInputs,fingerprint:snapshot.fingerprint,fileCount:snapshot.fileCount,source:'plugin-before-command-inputs'}}:{inputProof:{reusable:false,reason:'Legacy preparation has no before-command input fingerprint; use the original report manifest for historical reconciliation'}}),max_output_tokens:1200,yield_time_ms:30000,waitOptions:{max_output_tokens:1200,yield_time_ms:55000},startsCommand:false,instruction:executionObserved&&!mustReuse?'This exact prepared request already has an observed native execution. Preserve its original outcome/log; refresh only a known terminal on changed complete inputs. Never replay it to fix registration.':mustReuse?'This exact successful native verification already exists on unchanged complete inputs. Reuse reuseEvidence and its original log; executionArguments is null. Correct/register the report in the same attempt, do not run tests again.':'Execute nativeCommand through the native command tool in workspace. Record its real exit code/session ID; if still running, use waitOptions for the same session rather than frequent short polls. Read the saved log only on failure or for a selected summary; this preparation is not verification. The saved input fingerprint may support later reconciliation only while those inputs remain unchanged. Prefer a separate verification command after source edits. A supported literal interpreter edit && final contract check retains the full native command and terminal exit; its post-command candidate is not a before-command fingerprint.'};
}
export async function readTeamCommandLog(root,team,context,{taskId,attemptId,requestId,offset=0,maxChars=2000,cursor}){
  assertTaskAccess(team,context,taskId,{attemptId});if(!Number.isInteger(offset)||offset<0||!Number.isInteger(maxChars)||maxChars<256||maxChars>6000)throw new Error('Invalid log page');
  const stem=requestPath(root,team.id,attemptId,requestId),record=JSON.parse(await readFile(stem+'.json','utf8'));
  if(record.teamId!==team.id||record.taskId!==taskId||record.attemptId!==attemptId||record.requestId!==requestId||record.logPath!==stem+'.log')throw new Error('Command log identity mismatch');
  const path=await realpath(record.logPath),base=await realpath(join(root,'command-logs',team.id,attemptId));if(relative(base,path)!==requestId+'.log')throw new Error('Command log escapes its registered attempt');
  const fd=await open(path,'r');try{
    const before=await fd.stat(),digest=createHash('sha256'),chunk=Buffer.alloc(65536);let position=0;
    while(position<before.size){const {bytesRead}=await fd.read(chunk,0,Math.min(chunk.length,before.size-position),position);if(!bytesRead)throw new Error('Log changed while reading');digest.update(chunk.subarray(0,bytesRead));position+=bytesRead;}
    const token=hash(JSON.stringify([team.id,taskId,attemptId,requestId,digest.digest('hex')]));if(cursor&&cursor!==token)throw new Error('Log changed; do not combine different command results');
    if(offset>before.size)throw new Error('Log offset is outside the file');
    const bytes=Buffer.alloc(maxChars*4+4),{bytesRead}=await fd.read(bytes,0,bytes.length,offset);let end=bytesRead;
    if(end){let lead=end-1;while(lead>=0&&(bytes[lead]&0xc0)===0x80)lead--;const byte=bytes[lead],width=byte<0x80?1:byte<0xe0?2:byte<0xf0?3:4;if(end-lead<width)end=lead;}
    let text=bytes.subarray(0,end).toString('utf8').slice(0,maxChars);if(/[\uD800-\uDBFF]$/.test(text))text=text.slice(0,-1);
    const consumed=Buffer.byteLength(text),after=await fd.stat();if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error('Log changed while reading');const hasMore=offset+consumed<after.size;
    return {kind:'team-command-log',taskId,attemptId,requestId,logPath:path,offset,text,nextOffset:offset+consumed,hasMore,cursor:token,exitCodeSource:'native-command-record-only',...(hasMore?{nextRead:{operation:'read_team_command_log',arguments:{teamId:team.id,taskId,attemptId,requestId,offset:offset+consumed,maxChars:6000,cursor:token}}}:{})};}finally{await fd.close();}
}
