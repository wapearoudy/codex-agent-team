import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {capture} from './workspaces.mjs';
import {lstat,readdir} from 'node:fs/promises';
import {join,dirname,relative,sep,resolve} from 'node:path';
import {safeRelative} from './workspaces.mjs';
const exec=promisify(execFile);

// Use Git's own ignore semantics, including tracked files that now match an ignore rule.
// Never run repository hooks, build scripts, package managers or dependency installation.
async function gitInputs(root){
  let top;
  try{top=(await exec('git',['-C',root,'rev-parse','--show-toplevel'],{windowsHide:true,timeout:5000,maxBuffer:1024*1024})).stdout.trim();}
  catch(error){if(error.code==='ENOENT'||error.code===128)return null;throw new Error('Cannot inspect repository inputs; workspace preparation stopped',{cause:error});}
  if(!top)return null;
  const [all,tracked]=await Promise.all([
    exec('git',['-C',root,'ls-files','--cached','--others','--exclude-standard','-z','--','.'],{windowsHide:true,timeout:15000,maxBuffer:8*1024*1024}),
    exec('git',['-C',root,'ls-files','--cached','-z','--','.'],{windowsHide:true,timeout:15000,maxBuffer:8*1024*1024})
  ]);
  return {paths:[...new Set(all.stdout.split('\0').filter(Boolean))],tracked:tracked.stdout.split('\0').filter(Boolean)};
}
export async function inferInputRoots(root,writeScopes=[]){
  if(!writeScopes.length||writeScopes.includes('.'))return undefined;
  root=resolve(root);const selected=new Set();
  for(const scope of writeScopes){safeRelative(scope);let cursor=resolve(root,scope),moduleRoot;
    while(cursor===root||cursor.startsWith(root+sep)){
      for(const manifest of ['package.json','pom.xml','pyproject.toml','Cargo.toml','go.mod','settings.gradle','settings.gradle.kts'])try{if((await lstat(join(cursor,manifest))).isFile()){moduleRoot=cursor;break;}}catch(e){if(!['ENOENT','ENOTDIR'].includes(e.code))throw e;}
      if(cursor===root)break;cursor=dirname(cursor);
    }
    if(!moduleRoot||moduleRoot===root)return undefined;
    selected.add(relative(root,moduleRoot).split(sep).join('/'));
    for(let parent=dirname(moduleRoot);parent===root||parent.startsWith(root+sep);parent=dirname(parent)){
      for(const entry of await readdir(parent,{withFileTypes:true}))if(entry.isFile()){const name=relative(root,join(parent,entry.name)).split(sep).join('/');try{safeRelative(name);selected.add(name);}catch{}}
      if(parent===root)break;
    }
  }
  return [...selected].filter(p=>![...selected].some(other=>other!==p&&p.startsWith(other+'/')));
}
export async function prepareWorkspace(root,{writeScopes=[]}={}){
  const gitPaths=await gitInputs(root);
  const includePaths=await inferInputRoots(root,writeScopes);
  const snapshot=await capture(root,{includePaths,requiredPaths:writeScopes,inventoryPaths:gitPaths?.paths,trackedPaths:gitPaths?.tracked});
  const packages=[],issues=[];
  for(const [name,file] of Object.entries(snapshot.files)){
    if(['pyproject.toml','requirements.txt','pom.xml','Cargo.toml','go.mod'].includes(name.split('/').at(-1))){
      packages.push({manifest:name,scripts:[],dependencyCount:null});
      issues.push({path:name,kind:'toolchain-not-verified',message:'构建工具链与依赖尚未核验，不代表相关测试已可执行。'});
    }
    if(name.split('/').at(-1)!=='package.json')continue;
    let manifest;try{manifest=JSON.parse(Buffer.from(file.body,'base64').toString('utf8'));}catch{issues.push({path:name,kind:'invalid-manifest',message:'package.json 无法解析'});continue;}
    const scripts=manifest.scripts&&typeof manifest.scripts==='object'?Object.keys(manifest.scripts):[];
    const dependencies=Object.keys({...manifest.dependencies,...manifest.devDependencies});
    packages.push({manifest:name,scripts,dependencyCount:dependencies.length});
    if(dependencies.length)issues.push({path:name,kind:'dependencies-not-materialized',message:'隔离副本未安装项目依赖，依赖这些包的构建、测试和浏览器检查尚不可执行。'});
  }
  return {...snapshot,preparation:{source:gitPaths?'git-tracked-and-unignored':'filesystem',inputRoots:includePaths??['.'],packages,issues,excludedGeneratedLogs:snapshot.omissions.filter(x=>x.reason==='generated-execution-log'),omissions:snapshot.omissions,
    files:Object.keys(snapshot.files).length,bytes:Object.values(snapshot.files).reduce((n,f)=>n+Buffer.from(f.body,'base64').length,0),
    validationReady:false,validationStatus:issues.length?'blocked-or-limited':'not-verified',dependencyPolicy:'no-install-no-shared-writable-links'}};
}
