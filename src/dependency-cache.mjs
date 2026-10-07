import {readdir,lstat,realpath,readFile,mkdir,cp} from 'node:fs/promises';
import {join,dirname,resolve,relative,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const within=(root,path)=>path===root||path.startsWith(root+sep);
// Private physical copies only. No installation, scripts, symlinks or writable shared dependencies.
export async function prepareDependencyCache(project,snapshot,cacheRoot){
  const issues=[],sources=new Map();project=await realpath(project);
  for(const pkg of snapshot.preparation.packages.filter(p=>p.dependencyCount>0)){
    const manifest=JSON.parse(Buffer.from(snapshot.files[pkg.manifest].body,'base64').toString('utf8'));
    let directory=dirname(join(project,pkg.manifest)),source;
    for(;;){const candidate=join(directory,'node_modules');try{if((await lstat(candidate)).isDirectory()){source=candidate;break;}}catch(e){if(e.code!=='ENOENT')issues.push({path:pkg.manifest,kind:'dependency-unreadable',message:e.code});}if(directory===project)break;directory=dirname(directory);if(!within(project,directory))break;}
    if(!source){issues.push({path:pkg.manifest,kind:'dependencies-not-materialized',message:'项目范围内没有可复用的已安装依赖；未执行安装。'});continue;}
    if(await realpath(source)!==source){issues.push({path:pkg.manifest,kind:'linked-dependencies',message:'依赖目录是链接，无法保证副本隔离。'});continue;}
    for(const name of Object.keys({...manifest.dependencies,...manifest.devDependencies})){
      if(!/^(@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name)||name==='.'||name==='..'){issues.push({path:pkg.manifest,kind:'invalid-dependency-name',message:'不安全的依赖名称'});continue;}
      try{await readFile(join(source,name,'package.json'),'utf8');}catch{issues.push({path:pkg.manifest,kind:'dependency-missing',message:`缺少已安装包 ${name}`});}
    }
    sources.set(source,relative(project,source).split(sep).join('/'));
  }
  let bytes=0,count=0;const trees=[];
  async function scan(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name),info=await lstat(path);if(info.isSymbolicLink())throw new Error(`依赖含链接：${relative(project,path)}`);if(info.isDirectory())await scan(path);else if(info.isFile()){bytes+=info.size;count++;if(bytes>2*1024**3||count>100000)throw new Error('已安装依赖超过 2 GiB / 100000 文件的复制预算');}}}
  if(!issues.length)for(const [source,path] of sources){try{await scan(source);trees.push({source,path});}catch(e){issues.push({path,kind:'dependency-copy-blocked',message:e.message});}}
  if(issues.length)return{issues,trees:[],bytes,count};
  const copied=[];
  for(const tree of trees){const destination=join(cacheRoot,randomUUID());await mkdir(dirname(destination),{recursive:true});
    // Filter is also a race check: a dependency replaced with a link after inventory is rejected.
    await cp(tree.source,destination,{recursive:true,errorOnExist:true,force:false,filter:async path=>{const info=await lstat(path);if(info.isSymbolicLink())throw new Error('Dependency changed to a link during preparation');const name=path.slice(path.lastIndexOf(sep)+1);if(/^\.env(?:\.|$)|^\.npmrc$|^\.netrc$|\.(pem|p12|pfx)$/.test(name))return false;return true;}});
    copied.push({path:tree.path,cache:destination});
  }
  return{issues,trees:copied,bytes,count};
}
export async function materializeDependencies(plan,cwd){
  for(const tree of plan?.trees??[]){const destination=resolve(cwd,tree.path);if(!within(resolve(cwd),destination))throw new Error('Dependency destination escaped workspace');await cp(tree.cache,destination,{recursive:true,errorOnExist:true,force:false,filter:async path=>{if((await lstat(path)).isSymbolicLink())throw new Error('Linked cached dependency refused');return true;}});}
}
