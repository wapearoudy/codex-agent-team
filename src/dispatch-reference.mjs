import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {memberBootstrapProgram} from './cached-member.mjs';
// Content-addressed immutable dispatch. The Leader receives mechanical identity
// and a reference; the worker reads the exact full contract without rewriting.
export async function dispatchReference(root,packet){
 if(packet.action==='execute-in-leader')return packet;
 if(!/^[a-f0-9-]{36}$/i.test(packet.teamId??'')||!/^[a-f0-9-]{36}$/i.test(packet.attemptId??'')||typeof packet.prompt!=='string')throw new Error('Full authenticated dispatch identity required');
 const {revision:transportRevision,nativeAction:transportAction,dispatchHash:transportHash,...stable}=packet,body=JSON.stringify(stable),hash=createHash('sha256').update(body).digest('hex'),folder=join(root,'dispatches',packet.teamId,packet.attemptId),path=join(folder,hash+'.json');
 await mkdir(folder,{recursive:true});try{await writeFile(path,body,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;if(await readFile(path,'utf8')!==body)throw new Error('Immutable dispatch file differs; retain reservation and original evidence');}
 const promptPath=join(folder,hash+'.txt'),promptHash=createHash('sha256').update(packet.prompt).digest('hex');
 try{await writeFile(promptPath,packet.prompt,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;if(await readFile(promptPath,'utf8')!==packet.prompt)throw new Error('Immutable dispatch prompt differs; retain reservation and original evidence');}
 return renderDispatchReference(packet,{path,sha256:hash,promptPath,promptSha256:promptHash,complete:true,immutable:true});
}
function renderDispatchReference(packet,reference){
 const {path,promptPath}=reference;
 const bootstrap=packet.memberBootstrap;
 const startArgs=bootstrap?{...bootstrap.arguments,includeTaskContext:true}:null;
 const message=bootstrap?`Emit this EXACT standalone public commentary line without punctuation:\n${packet.marker}\n\nDiscover and start once in the SAME functions.exec: ${memberBootstrapProgram(startArgs)} Do not print the directory, whole MCP wrapper or return discovery to the model before calling. Only readyForWork=true authorizes work. The response includes the COMPLETE immutable taskContext.prompt, contract and delivery template: read it fully and execute it; bootstrap is then already complete. Keep reportArguments for final submission. Do not separately read dispatch files or repeat startup. A delayed marker retries this SAME active turn, never respawn yourself. If the actual host reports the member tool unavailable, send one native blocker to the parent and end without writes/tests; no repeated probes or self-respawn. No parent handshake or full skill/directory reread. Audit reference: ${path}.`:
 `Read the complete exact task prompt at ${promptPath} (plain text, no JSON decoding). It contains the full contract, delivery template and API shapes. The immutable dispatch JSON at ${path} is retained for audit; do not also read it during normal work. Emit this EXACT standalone public commentary line without punctuation:\n${packet.marker}\n\nThen native send_message to the parent that you are ready; remain in this active turn awaiting BIND_READY:${packet.attemptId} before member APIs or writes. Follow the full file finish protocol; never spawn yourself. No full skill/directory reread. Describe only an unknown operation.`;
 return {teamId:packet.teamId,revision:packet.revision,taskId:packet.taskId,attemptId:packet.attemptId,memberId:packet.memberId,marker:packet.marker,taskName:packet.taskName,threadTitle:packet.threadTitle,spawnOptions:packet.spawnOptions,workspace:packet.workspace,action:packet.action,existingThreadId:packet.existingThreadId,existingAgentPath:packet.existingAgentPath,dispatchReference:reference,prompt:message,...(packet.nativeAction?{nativeAction:{...packet.nativeAction,arguments:{...packet.nativeAction.arguments,message}}}:{})};
}

// Called only after reservation authentication, before any binding mutation.
export async function readDispatchContext(root,team,input){
 if(input.dispatchHash===undefined){
  if(!input.includeTaskContext)return {};
  // The reservation capability already fences the exact task/contract. Avoid
  // asking the model to recopy a second long identity. Never guess a latest file
  // or repair an explicitly incorrect hash; ambiguity remains a hard blocker.
  const folder=join(root,'dispatches',team.id,input.attemptId),files=(await readdir(folder)).filter(f=>/^[a-f0-9]{64}\.json$/.test(f));
  if(files.length!==1)throw new Error('No unique immutable dispatch for this reservation; preserve the original attempt');
  return readDispatchContext(root,team,{...input,dispatchHash:files[0].slice(0,-5)});
 }
 if(!/^[a-f0-9]{64}$/.test(input.dispatchHash))throw new Error('Invalid immutable dispatch hash');
 const task=team.tasks.find(t=>t.id===input.taskId),attempt=task?.attempts.at(-1);
 const body=await readFile(join(root,'dispatches',team.id,input.attemptId,input.dispatchHash+'.json'),'utf8');
 if(createHash('sha256').update(body).digest('hex')!==input.dispatchHash)throw new Error('Immutable dispatch hash mismatch; preserve reservation');
 const packet=JSON.parse(body),hash=typeof packet.prompt==='string'?createHash('sha256').update(packet.prompt).digest('hex'):null;
 if(packet.teamId!==team.id||packet.leaderThreadId!==team.leaderThreadId||packet.taskId!==task.id||packet.attemptId!==attempt.id||packet.memberId!==task.memberId||packet.marker!==attempt.marker||packet.memberBootstrap?.arguments?.bootstrapToken!==input.bootstrapToken||!hash||packet.promptHash!==hash)throw new Error('Immutable dispatch identity or prompt mismatch; preserve reservation');
 return {taskContext:{prompt:packet.prompt,sha256:hash,complete:true,immutable:true}};
}

// Recover the original immutable packet, never render a new prompt/attempt.
// Called only after authenticated proof that no native launch was issued.
export async function reservedNativeDispatch(root,team,task){
 const a=task.attempts.at(-1),folder=join(root,'dispatches',team.id,a.id),files=(await readdir(folder)).filter(f=>/^[a-f0-9]{64}\.json$/.test(f));
 if(files.length!==1)throw Error('No unique original native dispatch; preserve this reservation');
 const hash=files[0].slice(0,-5);await readDispatchContext(root,team,{taskId:task.id,attemptId:a.id,bootstrapToken:a.bootstrap.token,dispatchHash:hash});
 const packet=JSON.parse(await readFile(join(folder,files[0]),'utf8'));
 if(packet.existingThreadId||packet.action!=='spawn-native-member'||packet.spawnOptions?.fork_turns!=='none'||packet.taskName!==a.bootstrap.taskName)throw Error('Original reserved dispatch is not a clean new launch');
 // Re-render the original reference without writing a second immutable file,
 // including older packets whose transport hash was saved in their body.
 return renderDispatchReference({...packet,revision:team.revision,nativeAction:{tool:'spawn_agent',arguments:{task_name:packet.taskName,message:packet.prompt,...packet.spawnOptions},instruction:'Use these exact native arguments, including task_name; do not reconstruct a role label or rewrite the prompt.'}},{path:join(folder,files[0]),sha256:hash,promptPath:join(folder,hash+'.txt'),promptSha256:createHash('sha256').update(packet.prompt).digest('hex'),complete:true,immutable:true});
}
