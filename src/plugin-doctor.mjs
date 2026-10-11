import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {hostCapabilities,hostId} from './host-adapters.mjs';
const versions=(a,b)=>{const aa=a.split('.').map(Number),bb=b.split('.').map(Number);return bb[0]-aa[0]||bb[1]-aa[1]||bb[2]-aa[2];};
export async function pluginDoctor({version,host='codex',context=null,codexHome=process.env.CODEX_HOME??join(homedir(),'.codex'),registry=false}={}){
  host=hostId(host);const checks=[],add=(id,status,detail,action)=>checks.push({id,status,detail,...(action?{action}:{})});
  add('runtime-version','PASS',version);add('host-context',context?'PASS':'UNKNOWN',context?'Verified current native session and project':'No host context was supplied','Open this tool from the intended host project; arbitrary IDs cannot replace native context.');
  let installed=null;
  if(host==='codex'){
    const root=join(codexHome,'plugins/cache/fusion-local/team-workspace-probe');
    try{const names=(await readdir(root)).filter(n=>/^\d+\.\d+\.\d+$/.test(n)).sort(versions);for(const name of names){try{const p=JSON.parse(await readFile(join(root,name,'plugin.json'),'utf8'));if(p.version===name&&p.name==='team-workspace-probe'){installed=name;break;}}catch{}}
      add('installed-version',installed===version?'PASS':installed?'WARN':'UNKNOWN',installed??'No verified package found',installed!==version?'Open a new plugin connection after installing the intended version. Preserve running work; no forced restart.':undefined);
    }catch(e){add('installed-version','UNKNOWN',e.code==='ENOENT'?'No local cache':e.code??'Unavailable','Build and run the official installation script; no cache deletion is required.');}
  }else add('installed-version','UNKNOWN','The host owns package resolution; runtime version is known','Use the native plugin manager to inspect its resolved package version.');
  const names=new Set((context?.nativeTools??[]).map(t=>t.name)),required=host==='deepseek-harness'?[['spawn_teammate','subagent'],['send_message'],['interrupt_agent']]:host==='opencode'?[['task'],['task'],['team_workspace_control']]:host==='claude-code'?[['Agent','Task'],['SendMessage'],['TaskStop']]:[];
  for(const [index,alternatives]of required.entries())add(['dispatch','resume','stop'][index],names.size?(alternatives.some(n=>names.has(n))?'PASS':'WARN'):'UNKNOWN',alternatives.join(' or '),'Verify the native tool/profile before dispatch. Tool presence does not prove a model request will succeed.');
  if(host==='codex')add('execution-tools','UNKNOWN','Native execution remains controlled by the main session','Use the host-provided collaboration tools; this plugin does not launch a test model.');
  add('model-access','UNKNOWN','No model request or account lookup was performed','A verified dispatch is required to establish model availability; no automatic fallback.');
  if(registry){try{const r=await fetch('https://registry.npmjs.org/agent-team-deepseek-harness',{signal:AbortSignal.timeout(10000)});if(r.status===404)add('npm-package','WARN','Not published','Authenticate npm and publish the verified package.');else if(!r.ok)add('npm-package','UNKNOWN','Registry HTTP '+r.status);else {const d=await r.json(),published=!!d.versions?.[version];add('npm-package',published?'PASS':'WARN',published?version:'Requested version is not published','Publish the locally verified version; installation archives are not npm publication.');}}catch(e){add('npm-package','UNKNOWN',e.name??'Registry unavailable');}}
  return {kind:'plugin-diagnostics',version,installedVersion:installed,host,capabilities:hostCapabilities(host),installationEvidence:'local-cache-only; active-registration-not-verified',checks,modelStarted:false,readOnly:true,status:checks.some(c=>c.status==='WARN')?'WARN':checks.some(c=>c.status==='UNKNOWN')?'PARTIAL':'PASS'};
}
