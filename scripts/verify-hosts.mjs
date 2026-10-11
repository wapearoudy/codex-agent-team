import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdtemp,mkdir,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
const run=promisify(execFile),npmRoot=join(process.env.APPDATA??join(homedir(),'.local/lib'),'npm/node_modules');
const results={at:new Date().toISOString(),modelStarts:0,kind:'native-host-protocol-smoke',hosts:{}};
async function binary(name,windowsPath){
  const override=process.env['TEAM_WORKSPACE_'+name.toUpperCase()+'_BINARY'];if(override)return override;
  if(process.platform==='win32'){await access(windowsPath);return windowsPath;}
  return name;
}
async function check(host,fn){try{results.hosts[host]={status:'PASS',...await fn()};}catch(e){results.hosts[host]={status:'FAIL',reason:String(e.stderr??e.message).slice(0,1200)};}}
await check('claude-code',async()=>{
  const exe=await binary('claude',join(npmRoot,'@anthropic-ai/claude-code/bin/claude.exe'));
  const version=(await run(exe,['--version'],{windowsHide:true,timeout:15000})).stdout.trim();
  await run(exe,['plugin','validate',resolve('artifacts/hosts/claude-code')],{windowsHide:true,timeout:20000});
  return {version,manifest:'native-cli-validated',hooks:'protocol-regression-suite; no model turn',modelExecution:'NOT_RUN'};
});
await check('deepseek-harness',async()=>{
  const cli=join(npmRoot,'@deepseek-ai/dsh/lib/bin.js');
  const version=(await run(process.execPath,[cli,'--version'],{windowsHide:true,timeout:15000})).stdout.trim();
  const entry=await import(pathToFileURL(resolve('artifacts/hosts/deepseek-harness/dist/index.mjs')).href);
  if(typeof entry.apply!=='function'||!entry.inject?.includes('tools'))throw new Error('Native Cordis plugin entrypoint is invalid');
  const sdkRoot=join(npmRoot,'@deepseek-ai/dsh/node_modules/@deepseek-ai');
  const load=name=>import(pathToFileURL(join(sdkRoot,name,'lib/index.js')).href);
  const [{Context},{SystemPrompt},{ToolRuntime},{SessionStore},{AgentRegistry}]=await Promise.all(['cordis','dsh-system-prompt','dsh-tools','dsh-session','dsh-agent'].map(load));
  const ctx=new Context(),fibers=[];let names;
  try{for(const service of [SystemPrompt,SessionStore,AgentRegistry,ToolRuntime]){const fiber=ctx.plugin(service);fibers.push(fiber);await fiber.await();}const fiber=ctx.plugin(entry.default,{bridgeRoot:await mkdtemp(join(tmpdir(),'team-workspace-dsh-native-'))});fibers.push(fiber);await fiber.await();names=ctx.tools.schemas().map(t=>t.name).sort();if(!names.includes('team_member')||names.length!==6)throw new Error('Actual DSH ToolRuntime did not register six compact tools');}
  finally{for(const fiber of fibers.reverse())await fiber.dispose();}
  const {installHost}=await import('./install-host.mjs');
  const project=await mkdtemp(join(tmpdir(),'team-workspace-dsh-overlay-')),staged=await installHost('deepseek-harness',{project});
  const dumped=await run(process.execPath,[cli,'--profile','headless','--patch',staged.activate.args.at(-1),'--dump-config'],{env:{...process.env,DSH_HOME:join(project,'dsh-home')},windowsHide:true,timeout:30000,maxBuffer:4*1024*1024});
  if(!dumped.stdout.replaceAll('\\','/').includes(staged.activate.entry.replaceAll('\\','/')))throw new Error('DSH CLI did not compose the staged native overlay');
  return {version,nativeModule:'loaded-without-host-SDK-resolution-error',pluginTools:names,registration:'actual-Cordis-ToolRuntime-and-isolated-CLI-overlay',modelExecution:'NOT_RUN',fixture:project};
});
await check('opencode',async()=>{
  const exe=await binary('opencode',join(npmRoot,'opencode-ai/bin/opencode.exe'));
  const version=(await run(exe,['--version'],{windowsHide:true,timeout:15000})).stdout.trim();
  const project=await mkdtemp(join(tmpdir(),'team-workspace-opencode-smoke-')),bridge=join(project,'bridge');
  const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const config={plugin:[pathToFileURL(resolve('artifacts/hosts/opencode/dist/index.mjs')).href]};
  const child=spawn(exe,['serve','--hostname','127.0.0.1','--port',String(port)],{cwd:project,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,OPENCODE_CONFIG_CONTENT:JSON.stringify(config),OPENCODE_CONFIG_DIR:join(project,'config'),XDG_CONFIG_HOME:join(project,'xdg-config'),XDG_DATA_HOME:join(project,'xdg-data'),TEAM_WORKSPACE_BRIDGE_ROOT:bridge,TEAM_WORKSPACE_NODE_BINARY:process.execPath}});
  let output='';child.stdout.on('data',c=>output=(output+c).slice(-6000));child.stderr.on('data',c=>output=(output+c).slice(-6000));let childError;child.on('error',e=>childError=e);
  const url=`http://127.0.0.1:${port}`;
  async function api(path,body){try{const r=await fetch(url+path,{method:body?'POST':'GET',...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(path==='/experimental/tool/ids'?45000:10000)});if(!r.ok)throw new Error(`Native API ${path} returned ${r.status}`);return r.json();}catch(e){throw new Error(`Native API ${path}: ${e.message}`);}}
  try{
    let ready=false;for(let i=0;i<80;i++){if(childError)throw childError;if(child.exitCode!==null)throw new Error('Native server exited: '+output.slice(-1000));try{await api('/global/health');ready=true;break;}catch{await new Promise(r=>setTimeout(r,250));}}
    if(!ready)throw new Error('Native server failed to become ready: '+output.slice(-1000));
    const toolIds=await api('/experimental/tool/ids');if(!Array.isArray(toolIds)||!toolIds.includes('team_leader'))throw new Error('Native plugin tools were not registered');
    const leader=await api('/session',{title:'Team Workspace protocol smoke '+randomUUID()});
    const member=await api('/session',{title:'protocol-readonly-member',parentID:leader.id});
    const observed=await api('/session/'+member.id);if(observed.parentID!==leader.id)throw new Error('Native child lineage was not preserved');
    const {HostBridge}=await import('../src/host-bridge.mjs');const registry=new HostBridge({host:'opencode',root:bridge});
    let snapshot;for(let i=0;i<30;i++){try{snapshot=await registry.readThread(member.id);break;}catch{await new Promise(r=>setTimeout(r,100));}}
    if(snapshot?.parentThreadId!==leader.id)throw new Error('Native session event did not reach the plugin bridge');
    return {version,nativeServer:'started-and-closed',pluginTools:toolIds.filter(id=>['get_current_project','team_leader','team_member','read_team','team_workspace_control'].includes(id)),nativeParentChild:'API-and-bridge-confirmed',modelExecution:'NOT_RUN',fixture:project};
  }catch(e){throw new Error(e.message+'; native log: '+output.slice(-1200).replace(/Bearer\s+\S+/gi,'Bearer [redacted]'));}
  finally{await writeFile(join(project,'native-server.log'),output);child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,5000))]);}
});
await mkdir('evidence',{recursive:true});const report=JSON.stringify(results,null,2);await writeFile(`evidence/cross-host-native-smoke-${Date.now()}.json`,report);await writeFile('evidence/cross-host-native-smoke.json',report);
console.log(JSON.stringify(results,null,2));
if(Object.values(results.hosts).some(h=>h.status!=='PASS'))process.exitCode=1;
