import {cp,mkdir,readFile,writeFile,realpath,access,readdir} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {hostId} from '../src/host-adapters.mjs';
import {replaceFile} from '../src/durable-store.mjs';

async function checkTarget(project,target){
  let existing=target;
  while(true){try{const actual=await realpath(existing),rel=relative(project,actual);if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+(process.platform==='win32'?'\\':'/')))throw new Error('Host installation target escaped the project');return;}catch(e){if(e.code!=='ENOENT')throw e;const parent=dirname(existing);if(parent===existing)throw e;existing=parent;}}
}
async function packageFiles(root,prefix=''){
  const out=[];for(const entry of await readdir(join(root,prefix),{withFileTypes:true})){const path=join(prefix,entry.name);if(entry.isSymbolicLink())throw new Error('Host package contains a symbolic link');if(entry.isDirectory())out.push(...await packageFiles(root,path));else if(entry.isFile())out.push(path);else throw new Error('Unsupported host package file');}return out.sort();
}
async function expectedFile(source,host,destination,file){
  const bytes=await readFile(join(source,file));
  if(host==='deepseek-harness'&&file==='cordis.patch.yml')return Buffer.from(bytes.toString('utf8').replace("'./dist/index.mjs'",JSON.stringify(join(destination,'dist/index.mjs').replaceAll('\\','/'))));
  return bytes;
}

// Project-local host packages. No shell-built install strings, global settings
// replacement, dependency installation or running model sessions.
export async function installHost(host,{project=process.cwd(),artifacts=resolve('artifacts/hosts')}={}){
  host=hostId(host);if(host==='codex')throw new Error('Use scripts/install-plugin.mjs for the official Codex installation');
  project=await realpath(project);
  const source=join(artifacts,host),info=JSON.parse(await readFile(resolve('package.json'),'utf8'));
  await access(join(source,'dist/server.cjs'));
  const root=join(project,'.team-workspace-hosts'),destination=join(root,host,info.version);
  const rel=relative(project,destination);
  if(isAbsolute(rel)||rel.startsWith('..'))throw new Error('Host installation target escaped the project');
  await checkTarget(project,destination);
  let existing=false;try{await access(destination);existing=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(existing){
    const files=await packageFiles(source);if(JSON.stringify(files)!==JSON.stringify(await packageFiles(destination)))throw new Error('Immutable host package file set changed; bump the release version');
    for(const file of files){
      if(!(await expectedFile(source,host,destination,file)).equals(await readFile(join(destination,file))))throw new Error('Immutable host package has different contents; bump the release version');
    }
  }else{await mkdir(join(root,host),{recursive:true});const staged=destination+'.staged-'+randomUUID();await cp(source,staged,{recursive:true});if(host==='deepseek-harness')await writeFile(join(staged,'cordis.patch.yml'),await expectedFile(source,host,destination,'cordis.patch.yml'));await replaceFile(staged,destination);}
  const record={host,version:info.version,project,path:destination,status:'STAGED',modelsStarted:0};
  if(host==='opencode'){
    const pluginDir=join(project,'.opencode/plugins'),wrapper=join(pluginDir,'team-workspace.mjs');
    await checkTarget(project,wrapper);
    const marker='// Managed by Team Workspace native installer';
    try{if(!(await readFile(wrapper,'utf8')).startsWith(marker))throw new Error('Another plugin owns team-workspace.mjs; no registration changed');}catch(e){if(e.code!=='ENOENT')throw e;}
    await mkdir(pluginDir,{recursive:true});
    const temp=wrapper+'.tmp-'+randomUUID();
    await writeFile(temp,marker+'\nexport {default} from '+JSON.stringify(pathToFileURL(join(destination,'dist/index.mjs')).href)+';\n');await replaceFile(temp,wrapper);
    record.status='PROJECT_REGISTERED';record.registration=wrapper;
    record.activate={command:'opencode',args:[project]};
  }else if(host==='claude-code'){
    record.activate={command:'claude',args:['--plugin-dir',destination]};
    record.note='Native --plugin-dir loads this complete local plugin; no global marketplace or settings were changed.';
  }else{
    record.activate={command:'dsh',args:['--profile','<existing-profile>','--patch',join(destination,'cordis.patch.yml')],entry:join(destination,'dist/index.mjs')};
    record.note='Select the intended profile explicitly; the staged overlay resolves this exact native plugin.';
  }
  return record;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const args=process.argv.slice(2),host=args[args.indexOf('--host')+1],p=args.indexOf('--project');
  if(!args.includes('--host')||!host)throw new Error('Usage: node scripts/install-host.mjs --host claude-code|opencode|deepseek-harness [--project PATH]');
  console.log(JSON.stringify(await installHost(host,{...(p>=0?{project:args[p+1]}:{})}),null,2));
}
