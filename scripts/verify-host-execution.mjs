import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp,realpath} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import assert from 'node:assert/strict';
import {HostBridge} from '../src/host-bridge.mjs';
import {publicText} from '../src/host-normalize.mjs';

const hostNames=['deepseek-harness','claude-code','opencode'];
const args=process.argv.slice(2),live=args.includes('--live');
if(!live)throw new Error('Actual native model execution requires the explicit --live flag.');
const selected=args.includes('--all')?hostNames:hostNames.filter(h=>args.includes(h));
if(!selected.length)throw new Error('Use --all --live or --host <host> --live.');
const version=JSON.parse(await readFile('package.json','utf8')).version;
const evidence=resolve('evidence'),runId=randomUUID(),reportPath=join(evidence,'host-live-'+runId+'.json');
await mkdir(evidence,{recursive:true});
const report={kind:'actual-native-model-execution',runId,at:new Date().toISOString(),version,hosts:{}};
const save=async()=>{await writeFile(reportPath,JSON.stringify(report,null,2));await writeFile(join(evidence,'host-native-live.json'),JSON.stringify(report,null,2));};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function publicRecord(value){if(typeof value==='string')return publicText(value);if(Array.isArray(value))return value.map(publicRecord);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,/^(?:api[_-]?key|(?:access|refresh)[_-]?token|token|password|secret|authorization)$/i.test(key)?'[redacted]':publicRecord(item)]));return value;}
async function until(fn,{ms=90000,label='native condition'}={}){const end=Date.now()+ms;let last;while(Date.now()<end){try{const r=await fn();if(r)return r;}catch(e){if(e.fatal)throw e;last=e;}await pause(250);}throw new Error(label+' timed out'+(last?': '+last.message:''));}

async function openCodeLive({project,bridgeRoot,packageRoot,record}){
 const npmRoot=join(process.env.APPDATA,'npm/node_modules'),binary=join(npmRoot,'opencode-ai/bin/opencode.exe');
 const recent=JSON.parse(await readFile(join(homedir(),'.local/state/opencode/model.json'),'utf8')).recent?.[0];
 if(!recent?.providerID||!recent.modelID)throw new Error('OpenCode has no saved configured model route; refusing to invent a fallback.');
 const auth=JSON.parse(await readFile(join(homedir(),'.local/share/opencode/auth.json'),'utf8'));
 if(!auth[recent.providerID])throw new Error('Saved OpenCode provider has no native authentication record.');
 const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const configuration={plugin:[pathToFileURL(join(packageRoot,'dist/index.mjs')).href],model:recent.providerID+'/'+recent.modelID,permission:{edit:'deny',bash:{'*':'deny','node -e *':'allow'},external_directory:'deny'},agent:{'validation-reader':{mode:'subagent',description:'Read-only native lifecycle validation',prompt:'Follow only the short lifecycle validation task. Never write files or use other projects.',permission:{edit:'deny',bash:{'*':'deny','node -e *':'allow'}}}}};
 const child=spawn(binary,['serve','--hostname','127.0.0.1','--port',String(port)],{cwd:project,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,OPENCODE_CONFIG_CONTENT:JSON.stringify(configuration),TEAM_WORKSPACE_BRIDGE_ROOT:bridgeRoot,TEAM_WORKSPACE_NODE_BINARY:process.execPath}});
 let log='',failure;child.on('error',e=>failure=e);child.stdout.on('data',c=>log=publicText((log+c).slice(-24000)));child.stderr.on('data',c=>log=publicText((log+c).slice(-24000)));
 const url='http://127.0.0.1:'+port;
 const api=async(path,body,timeout=15000)=>{const r=await fetch(url+path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)}),signal:AbortSignal.timeout(timeout)});const text=await r.text();if(!r.ok)throw new Error('OpenCode '+path+' HTTP '+r.status+': '+publicText(text).slice(0,1500));return text?JSON.parse(text):null;};
 const bridge=new HostBridge({host:'opencode',root:bridgeRoot});
 let parentId,memberId;
 const marker='TEAM_WORKSPACE_ATTEMPT:'+randomUUID();
 const messages=id=>api('/session/'+id+'/message');
 const snapshot=()=>bridge.readThread(memberId);
 const texts=rows=>rows.flatMap(r=>r.parts??[]).filter(p=>p.type==='text').map(p=>p.text??'').join('\n');
 const checkEnd=async(token)=>until(async()=>{const t=await snapshot();const last=t.turns.at(-1);if(last?.status==='failed')throw new Error('Native model failed: '+publicText(JSON.stringify(await messages(memberId))).slice(0,1200));if(last?.status==='completed'&&last.items.some(i=>i.type==='agentMessage'&&i.text.includes(token)))return t;},{ms:180000,label:'OpenCode public output '+token});
 try{
  await until(async()=>{if(failure)throw failure;if(child.exitCode!==null)throw new Error('OpenCode server exited: '+log.slice(-1200));return api('/global/health');},{ms:30000,label:'OpenCode server readiness'});
  const nativeVersion=await api('/global/health'),toolIds=await api('/experimental/tool/ids');assert(toolIds.includes('team_leader'));
  record({phase:'registered',version:nativeVersion.version,route:recent,toolIds:toolIds.filter(t=>t.startsWith('team_')||t==='get_current_project')});
  const parent=await api('/session',{title:'native-live-parent-'+runId});parentId=parent.id;record({phase:'parent-created',parentId,nativeApi:url});
  const prompt=(text)=>api('/session/'+parentId+'/prompt_async',{model:recent,parts:[{type:'text',text}]});
  await prompt('This is an authorized read-only native lifecycle test. First call get_current_project once to prove the plugin caller. Then use task exactly once, subagent_type validation-reader, description lifecycle-check, prompt: "'+marker+' Reply exactly '+marker+' DISPATCH_OK. No other tools." Return only the task_id. Do not create other children or read files.');
  await until(async()=>{const rows=await messages(parentId);const error=rows.find(r=>r.info?.error)?.info.error;if(error){const clean={name:error.name,message:error.data?.message??error.message,statusCode:error.data?.statusCode,isRetryable:error.data?.isRetryable};record({phase:'native-parent-failed',parentId,error:clean});throw Object.assign(new Error('OpenCode configured native model failed: '+publicText(JSON.stringify(clean)).slice(0,1800)),{fatal:true,blocked:[401,403].includes(clean.statusCode)});}const task=rows.flatMap(r=>r.parts??[]).find(p=>p.type==='tool'&&p.tool==='task'&&(p.state?.metadata?.sessionId||p.state?.metadata?.sessionID));if(task){memberId=task.state.metadata.sessionId??task.state.metadata.sessionID;record({phase:'dispatch-receipt',parentId,memberId,marker,callId:task.callID,nativeInput:task.state.input});return true;}const children=await api('/session/'+parentId+'/children');if(children.length===1){memberId=children[0].id;record({phase:'dispatch-native-child',parentId,memberId,marker});return true;}return false;},{ms:90000,label:'OpenCode native task dispatch'});
  const dispatched=await checkEnd('DISPATCH_OK');assert.equal(dispatched.parentThreadId,parentId);assert.equal(dispatched.cwd.toLowerCase(),project.toLowerCase());const firstTurn=dispatched.turns.at(-1).id;record({phase:'dispatch-completed',thread:dispatched});
  await until(async()=>!(await api('/session/status'))[parentId],{ms:90000,label:'OpenCode parent dispatch idle'});
  await prompt('Resume your existing task only using task with task_id '+memberId+', subagent_type validation-reader, description lifecycle-resume, prompt "'+marker+' Reply exactly '+marker+' RESUME_OK. No other tools." Do not create another child.');
  const resumed=await checkEnd('RESUME_OK');assert.equal(resumed.id,memberId);assert.notEqual(resumed.turns.at(-1).id,firstTurn);assert.equal((await api('/session/'+parentId+'/children')).length,1);record({phase:'resume-completed',thread:resumed});
  await until(async()=>!(await api('/session/status'))[parentId],{ms:90000,label:'OpenCode parent resume idle'});
  await prompt('Resume your same task using task_id '+memberId+', subagent_type validation-reader, description lifecycle-stop, prompt "'+marker+' First use bash to execute node -e \"setTimeout(()=>{},30000)\". After that reply '+marker+' SHOULD_NOT_FINISH. No writes." Do not create another child.');
  const active=await until(async()=>{const t=await snapshot(),last=t.turns.at(-1);return last?.status==='inProgress'&&last.id!==resumed.turns.at(-1).id&&last.items.some(i=>i.type==='commandExecution'&&i.status==='inProgress')?t:false;},{ms:180000,label:'OpenCode same child active bash'});record({phase:'stop-active',thread:active});
  const member=await api('/session/'+memberId);assert.equal(member.parentID,parentId);assert.equal(member.directory.toLowerCase(),project.toLowerCase());
  const receipt=await api('/session/'+memberId+'/abort',{});record({phase:'stop-request',parentId,memberId,receipt,source:'native-session-abort'});
  const stopped=await until(async()=>{const t=await snapshot(),last=t.turns.at(-1);return last?.id===active.turns.at(-1).id&&last.status==='interrupted'&&last.statusEvidence?.source==='persisted-turn-aborted'?t:false;},{ms:30000,label:'OpenCode committed native abort'});record({phase:'stop-completed',thread:stopped});
  return {status:'PASS',runtimeVersion:nativeVersion.version,route:recent,parentId,memberId,marker,dispatchTurnId:firstTurn,resumeTurnId:resumed.turns.at(-1).id,stopTurnId:stopped.turns.at(-1).id,stopEvidence:stopped.turns.at(-1).statusEvidence,nativeModelExecution:true,pluginObserved:true};
 }finally{
  if(memberId)try{if((await api('/session/status'))[memberId])await api('/session/'+memberId+'/abort',{});}catch{}
  if(parentId)try{if((await api('/session/status'))[parentId])await api('/session/'+parentId+'/abort',{});}catch{}
  await writeFile(join(project,'native-server.log'),log);child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),pause(5000)]);
 }
}

for(const host of selected){
 const project=await realpath(await mkdtemp(join(tmpdir(),'team-native-live-'+host+'-'))),bridgeRoot=join(project,'bridge'),packageRoot=resolve('artifacts/hosts',host),events=[];
 let pending=Promise.resolve();
 const record=event=>{const clean=publicRecord({at:new Date().toISOString(),...event});events.push(clean);const snapshot=JSON.stringify(events,null,2);pending=pending.then(()=>writeFile(join(project,'native-public-evidence.json'),snapshot));};
 report.hosts[host]={status:'RUNNING',project,bridgeRoot,eventsPath:join(project,'native-public-evidence.json')};await save();
 try{
  const runner=host==='opencode'?openCodeLive:(await import(pathToFileURL(resolve('integrations',host,'verify-live.mjs')).href)).runLive;
  const result=await runner({project,bridgeRoot,packageRoot,evidence,record});
  report.hosts[host]={...report.hosts[host],...result};
 }catch(e){report.hosts[host]={...report.hosts[host],status:e.blocked?'BLOCKED':'FAIL',error:publicText(e.stack??e.message).slice(0,4000)};}
 await pending;await writeFile(join(project,'native-public-evidence.json'),JSON.stringify(events,null,2));await save();
 console.log(JSON.stringify({host,...report.hosts[host]}));
}
console.log(JSON.stringify({reportPath,version,status:Object.values(report.hosts).every(h=>h.status==='PASS')?'PASS':'FAIL'}));
if(Object.values(report.hosts).some(h=>h.status!=='PASS'))process.exitCode=1;
