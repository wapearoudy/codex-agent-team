import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const version=JSON.parse(await readFile('package.json','utf8')).version;
const pack=JSON.parse(await readFile('evidence/dsh-npm-package-'+version+'.json','utf8'));
assert.equal(pack.version,version);assert.equal(pack.name,'agent-team-deepseek-harness');
assert.equal(resolve(pack.archive),resolve('artifacts/npm/'+pack.name+'-'+version+'.tgz'));
const bytes=await readFile(pack.archive);assert.equal('sha512-'+createHash('sha512').update(bytes).digest('base64'),pack.integrity);
const runtime=process.env.TEAM_WORKSPACE_DSH_PACKAGE_ROOT??join(process.env.APPDATA??homedir(),'npm/node_modules/@deepseek-ai/dsh');
const fixture=await mkdtemp(join(tmpdir(),'team-dsh-npm-')),profile=join(fixture,'home/profiles/npm-check');
await mkdir(profile,{recursive:true});
await writeFile(join(profile,'package.json'),JSON.stringify({name:'dsh-profile-npm-check',private:true,type:'module',dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-headless']}}},null,2));
const env={...process.env,DSH_HOME:join(fixture,'home')};
await mkdir('evidence',{recursive:true});
function run(args,label){
  const result=spawnSync(process.execPath,[join(runtime,'lib/bin.js'),...args],{cwd:resolve('.'),env,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:8*1024*1024});
  return writeFile('evidence/dsh-npm-'+label+'-'+version+'.log',(result.stdout??'')+(result.stderr??'')).then(()=>{assert.equal(result.status,0,'Actual DSH '+label+' failed; full output saved');return result.stdout;});
}
try{
  await run(['plugin','--profile','npm-check','add',pack.archive,'--save-exact','--ignore-scripts'],'install');
  const manifest=JSON.parse(await readFile(join(profile,'package.json'),'utf8'));
  assert.equal(manifest.dsh.profile.bundles.filter(n=>n===pack.name).length,1,'DSH must register the npm bundle exactly once');
  const dumped=await run(['--profile','npm-check','--dump-config'],'dump');assert.ok(dumped.includes(pack.name),'Composed profile must resolve the native package name');
  const require=createRequire(join(profile,'package.json')),installed=JSON.parse(await readFile(require.resolve(pack.name+'/package.json'),'utf8'));assert.equal(installed.version,version);
  const native=await import(pathToFileURL(require.resolve(pack.name)).href);assert.equal(typeof native.apply,'function');
  const load=name=>import(pathToFileURL(join(runtime,'node_modules/@deepseek-ai',name,'lib/index.js')).href);
  const [{Context},{SystemPrompt},{ToolRuntime},{SessionStore},{AgentRegistry},{SessionProjectionRegistry}]=await Promise.all(['cordis','dsh-system-prompt','dsh-tools','dsh-session','dsh-agent','dsh-session-projection'].map(load));
  const ctx=new Context(),fibers=[];let tools;
  try{
    for(const service of [SystemPrompt,SessionStore,AgentRegistry,ToolRuntime,SessionProjectionRegistry]){const fiber=ctx.plugin(service);fibers.push(fiber);await fiber.await();}
    const fiber=ctx.plugin(native.default,{bridgeRoot:join(fixture,'bridge')});fibers.push(fiber);await fiber.await();
    tools=ctx.tools.schemas().map(t=>t.name).sort();assert.equal(tools.length,6);assert.ok(tools.includes('team_member'));assert.ok(tools.includes('team_leader'));
  }finally{for(const fiber of fibers.reverse())await fiber.dispose();}
  const result={kind:'actual-dsh-npm-tarball-installation',status:'PASS',name:pack.name,version,archive:pack.archive,integrity:pack.integrity,fixture,nativeInstallCommand:'dsh plugin --profile npm-check add <verified-local-tarball> --save-exact --ignore-scripts',bundleRegisteredOnce:true,profileCompositionPassed:true,packageExportsResolved:true,tools,modelsStarted:0,registryInstallation:'NOT_RUN; npm publication pending'};
  await writeFile('evidence/dsh-npm-install-'+version+'.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){await writeFile('evidence/dsh-npm-install-'+version+'.json',JSON.stringify({status:'FAIL',version,integrity:pack.integrity,fixture,modelsStarted:0,error:error.message},null,2));throw error;}
