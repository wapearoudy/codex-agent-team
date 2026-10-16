import {readFile,writeFile,mkdir,cp,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DurableStore} from '../src/durable-store.mjs';
import {resolveCodexBinary} from '../src/codex-binary.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {NativeMembers} from '../src/native-members.mjs';
import {assertUpgradeQuiescent} from '../src/upgrade-guard.mjs';

const root=resolve('plugins/team-workspace-probe'),manifest=JSON.parse(await readFile(join(root,'plugin.json'),'utf8'));
await readFile(join(root,'dist/server.cjs'));await readFile(join(root,'dist/host.html'));await readFile(join(root,'dist/leader-entry.js'));
const target=join(homedir(),'.agents/plugins/team-workspace-probe'),catalogPath=join(homedir(),'.agents/plugins/marketplace.json');
const config=join(homedir(),'.codex/config.toml'),configDigest=async()=>{try{return createHash('sha256').update(await readFile(config)).digest('hex');}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const sourceConfigBefore=await configDigest();
// Opt in only after the human explicitly confirms this historical Leader is
// not running team work. All native children must still be terminal twice.
let leaderHostSnapshot=null;
const idleTeamLeaderConfirmations=[];
for(const arg of process.argv.slice(2)){
 const host=/^--verified-host-leader-status-file=(.+)$/.exec(arg);
 if(host){if(leaderHostSnapshot)throw new Error('Only one captured host snapshot may be supplied');const bytes=await readFile(host[1]);if(bytes.length>32768)throw new Error('Captured host snapshot is too large');leaderHostSnapshot=JSON.parse(bytes);continue;}
 const match=/^--user-confirmed-idle-team-leader=([a-f0-9-]{36})$/i.exec(arg);
 if(!match)throw new Error('Unknown installer argument; use an exact user-confirmed idle team Leader ID');
 idleTeamLeaderConfirmations.push(match[1]);
}
const observer=new NativeMembers();let upgradeGuard;
try{upgradeGuard=await assertUpgradeQuiescent({teamsRoot:join(process.env.TEAM_WORKSPACE_DATA_ROOT??join(process.env.CODEX_HOME??join(homedir(),'.codex'),'team-workspace'),'teams'),observer,idleTeamLeaderConfirmations,leaderHostSnapshot});}finally{await observer.close();}
const catalog=new DurableStore(catalogPath,{name:'fusion-local',plugins:[]});
const existing=await catalog.read(),entry=existing.plugins?.find(p=>p.name===manifest.name);
if(entry&&(entry.source?.source!=='local'||entry.source?.path!=='./.agents/plugins/team-workspace-probe'))throw new Error('Another source owns this plugin; no files were changed');
const cache=join(process.env.CODEX_HOME??join(homedir(),'.codex'),'plugins/cache',existing.name??'fusion-local',manifest.name,manifest.version);
let cached=false;try{await readFile(join(cache,'plugin.json'));cached=true;}catch(error){if(error.code!=='ENOENT')throw error;}
if(cached){for(const file of ['plugin.json','mcp.json','README.md','skills/team-workspace/SKILL.md','dist/server.cjs','dist/host.html','dist/leader-entry.js']){
  if(!(await readFile(join(root,file))).equals(await readFile(join(cache,file))))throw new Error('This version is already installed with different contents. Bump the version before upgrading; no files were changed.');
}}
try{const old=JSON.parse(await readFile(join(target,'plugin.json'),'utf8'));if(old.name!==manifest.name)throw new Error('Another plugin owns the destination; no files were changed');}catch(error){if(error.code!=='ENOENT')throw error;}
const staged=target+'.staged-'+manifest.version+'-'+randomUUID(),backup=target+'.backup-'+Date.now();await mkdir(join(homedir(),'.agents/plugins'),{recursive:true});
await cp(root,staged,{recursive:true,errorOnExist:true,force:false});
// Staging can take time. Recheck live native state immediately before replacing
// registered source; preserve the staging directory if another workflow started.
const recheckObserver=new NativeMembers();try{upgradeGuard=await assertUpgradeQuiescent({teamsRoot:join(process.env.TEAM_WORKSPACE_DATA_ROOT??join(process.env.CODEX_HOME??join(homedir(),'.codex'),'team-workspace'),'teams'),observer:recheckObserver,idleTeamLeaderConfirmations,leaderHostSnapshot});}finally{await recheckObserver.close();}
let moved=false;try {try{await rename(target,backup);moved=true;}catch(error){if(error.code!=='ENOENT')throw error;}await rename(staged,target);}catch(error){if(moved)await rename(backup,target);throw error;}
await catalog.transaction(c=>{c.plugins??=[];if(!c.plugins.some(p=>p.name===manifest.name))c.plugins.push({name:manifest.name,source:{source:'local',path:'./.agents/plugins/team-workspace-probe'},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category:'Developer Tools'});});
const sourceConfigAfter=await configDigest();if(sourceConfigBefore!==sourceConfigAfter)throw new Error('Host config changed while staging; source backup was preserved');
const binary=await resolveCodexBinary(process.env.TEAM_WORKSPACE_CODEX_BINARY),run=promisify(execFile);
// Official registration is idempotent and also supports a fresh clone/user.
await run(binary,['plugin','marketplace','add',homedir()],{windowsHide:true,maxBuffer:1024*1024});
let result;try{result=cached?{stdout:'Identical immutable version already cached; no cache replacement requested.'}:await run(binary,['plugin','add',manifest.name+'@'+(existing.name??'fusion-local'),'--json'],{windowsHide:true,maxBuffer:1024*1024});}catch(error){const failed={version:manifest.version,status:'SOURCE_STAGED_INSTALL_FAILED',backup:moved?backup:null,sourceConfigBefore,sourceConfigAfter,reason:error.stderr?.trim()??error.message};await mkdir('evidence',{recursive:true});await writeFile('evidence/installation-'+manifest.version+'.json',JSON.stringify(failed,null,2));throw new Error('Official installation failed; staged source and backup were preserved. '+failed.reason);}
const record={version:manifest.version,sourceUpdated:true,officialInstall:!cached,identicalCache:cached,upgradeGuard,output:result.stdout.trim(),backup:moved?backup:null,sourceConfigBefore,sourceConfigAfter,installationConfigAfter:await configDigest(),residentConnection:'verify-in-current-chat; no host restart was forced'};
await mkdir('evidence',{recursive:true});await writeFile('evidence/installation-'+manifest.version+'.json',JSON.stringify(record,null,2));console.log(JSON.stringify(record));
