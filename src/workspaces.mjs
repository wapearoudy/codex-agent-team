import {readdir,readFile,writeFile,mkdir,lstat,realpath,rename,unlink} from 'node:fs/promises';
import {join,resolve,relative,dirname,sep,isAbsolute,win32} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {generatedLogReason,generatedArchiveReason} from './workspace-policy.mjs';
const excluded=new Set(['.git','.docker','.docker-tmp','.codex','.agents','node_modules','.venv','venv','dist','build','.next','coverage','target','.cache','.npm-cache','.pytest_cache','__pycache__','.idea']);
const secrets=/^(\.env($|\.)|.*(credential|secret|private[_-]?key).*|id_rsa|id_ed25519|auth\.json|\.npmrc|\.pypirc|\.netrc|.*\.(pem|key|p12|pfx))$/i;
export function isSensitiveName(name){if(/^\.env\.(example|sample|template)$/i.test(name)||/\.(?:[cm]?[jt]sx?|java|py|rs|go|cs|cpp|hpp|c|h|md)$/i.test(name))return false;return secrets.test(name);}
const generatedDirectories=new Set(['dist','build','.next','coverage','target','.cache','.npm-cache','.pytest_cache','__pycache__','test-results','playwright-report']);
export const digest=body=>createHash('sha256').update(body).digest('hex');
export const snapshotHash=s=>digest(JSON.stringify(Object.entries(s.files).map(([p,f])=>[p,f.hash]).sort()));
export async function fileBytes(file){
  const body=file.body!==undefined?Buffer.from(file.body,'base64'):await readFile(file.blob);
  if(digest(body)!==file.hash)throw new Error('Snapshot object integrity check failed');
  return body;
}
export async function persistSnapshot(snapshot,root){
  await mkdir(root,{recursive:true});
  const files={};
  for(const [name,file] of Object.entries(snapshot.files)){
    if(file.blob&&file.body===undefined){files[name]=file;continue;}
    const data=await fileBytes(file),blob=join(root,file.hash);
    try{await writeFile(blob,data,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;if(digest(await readFile(blob))!==file.hash)throw new Error('Stored snapshot object is corrupt');}
    files[name]={hash:file.hash,blob,size:data.length,mode:file.mode};
  }
  return {...snapshot,files,hash:snapshotHash({files})};
}
export function safeRelative(name){if(typeof name!=='string'||!name||isAbsolute(name)||win32.isAbsolute(name)||/[:\0]/.test(name)||name.split(/[\\/]/).some(s=>s==='..'||s==='.'||!s||excluded.has(s)||isSensitiveName(s)))throw new Error(`Unsafe or excluded project path: ${name}`);return name.replaceAll('\\','/');}
async function guardedPath(root,name){const path=resolve(root,safeRelative(name));if(!path.startsWith(resolve(root)+sep))throw new Error('Path escaped selected workspace');let cursor=root;for(const part of name.split(/[\\/]/)){cursor=join(cursor,part);try{if((await lstat(cursor)).isSymbolicLink())throw new Error('Linked paths are not supported');}catch(e){if(e.code!=='ENOENT')throw e;}}return path;}
export async function capture(root,{strict=false,allowGenerated=false,dependencyPaths=[],includePaths,requiredPaths=[],inventoryPaths,trackedPaths=[],maxFileBytes=16*1024*1024,maxTotalBytes=128*1024*1024,maxFiles=20000}={}){
  root=await realpath(root);const files={},skipped=[],omissions=[],tracked=new Set(trackedPaths),inputs=[],issues=[];let bytes=0;
  if(includePaths!==undefined&&(!Array.isArray(includePaths)||!includePaths.length||includePaths.length>20000))throw new Error('Snapshot input roots exceed the bounded inventory limit');
  const selected=includePaths?.map(safeRelative);
  const inventory=inventoryPaths?new Set(inventoryPaths):null;
  const directories=new Set();for(const name of inventory??[]) {const parts=name.split('/');parts.pop();while(parts.length){directories.add(parts.join('/'));parts.pop();}}
  // Validate requested inputs explicitly. Missing input is never a silently empty snapshot.
  for(const name of selected??[]){const path=await guardedPath(root,name);try{await lstat(path);}catch(error){throw new Error(`Snapshot input unavailable: ${name} [${error.code??'IO_ERROR'}]`,{cause:error});}}
  async function visit(dir){let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch(e){issues.push({path:relative(root,dir),kind:'unreadable-directory',code:e.code});return;}for(const entry of entries){
    const path=join(dir,entry.name),name=relative(root,path).split(sep).join('/');
    if(inventory&&!inventory.has(name)&&!directories.has(name)){skipped.push(name);continue;}
    if(selected&&!selected.some(p=>name===p||name.startsWith(p+'/')||p.startsWith(name+'/'))){skipped.push(name);continue;}
    if(dependencyPaths.includes(name)){if(entry.isSymbolicLink()||!entry.isDirectory())throw new Error('Dependency directory was replaced: '+name);skipped.push(name);continue;}
    if(allowGenerated&&entry.isDirectory()&&!entry.isSymbolicLink()&&generatedDirectories.has(entry.name)){skipped.push(name);omissions.push({path:name,reason:'generated-validation-output'});continue;}
    if(excluded.has(entry.name)||isSensitiveName(entry.name)){if(strict)throw new Error(`Candidate contains excluded path: ${name}`);skipped.push(name);continue;}
    if(entry.isSymbolicLink()){if(strict)throw new Error(`Symlink in candidate: ${name}`);skipped.push(name);continue;}
    if(entry.isDirectory()){await visit(path);continue;}
    if(!entry.isFile())continue;
    let info;try{info=await lstat(path);}catch(e){issues.push({path:name,kind:'unreadable-file',code:e.code});continue;}
    const required=requiredPaths.some(p=>p!=='.'&&(name===p||name.startsWith(p.replace(/\/$/,'')+'/')));
    const reason=strict||required?null:(generatedLogReason(name,{tracked:tracked.has(name)})??generatedArchiveReason(name,{tracked:tracked.has(name)}));
    if(reason){skipped.push(name);omissions.push({path:name,reason,bytes:info.size});continue;}
    if(info.size>maxFileBytes)issues.push({path:name,kind:'file-budget',bytes:info.size,limit:maxFileBytes});
    inputs.push({path,name,info});bytes+=info.size;
  }}
  const fail=()=>{if(!issues.length)return;const error=new Error('Workspace preflight blocked; no member was started. '+issues.map(i=>`${i.path||'.'}: ${i.kind} ${i.code??''} ${i.bytes??i.count??''}/${i.limit??''}`).join('; '));error.issues=issues;error.omissions=omissions;throw error;};
  await visit(root);
  if(bytes>maxTotalBytes)issues.push({path:'.',kind:'total-byte-budget',bytes,limit:maxTotalBytes});
  if(inputs.length>maxFiles)issues.push({path:'.',kind:'file-count-budget',count:inputs.length,limit:maxFiles});
  fail();bytes=0;
  for(const {path,name,info} of inputs){
    let data;try{data=await readFile(path);}catch(e){issues.push({path:name,kind:'unreadable-file',code:e.code??'IO_ERROR'});continue;}
    bytes+=data.length;if(data.length>maxFileBytes){issues.push({path:name,kind:'file-grew-over-budget',bytes:data.length,limit:maxFileBytes});continue;}
    if(bytes>maxTotalBytes){issues.push({path:name,kind:'inputs-grew-over-budget',bytes,limit:maxTotalBytes});break;}
    files[name]={hash:digest(data),body:data.toString('base64'),size:data.length,mode:info.mode&0o777};
  }
  fail();return{files,skipped,omissions,hash:snapshotHash({files})};
}
export async function materialize(snapshot,root){await mkdir(root,{recursive:true});for(const [name,file]of Object.entries(snapshot.files)){const path=await guardedPath(root,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,await fileBytes(file),{flag:'wx',mode:file.mode});}return root;}
export function changes(before,after,scopes){
  const changes=[];const permitted=name=>scopes.some(scope=>scope==='.'||name===scope.replaceAll('\\','/').replace(/\/$/,'')||name.startsWith(scope.replaceAll('\\','/').replace(/\/$/,'')+'/'));
  for(const name of new Set([...Object.keys(before.files),...Object.keys(after.files)])){
    const a=before.files[name],b=after.files[name];if(a?.hash===b?.hash)continue;
    safeRelative(name);if(!permitted(name))throw new Error(`Candidate changed a file outside assigned scope: ${name}`);
    changes.push({path:name,before:a??null,after:b??null});
  }return changes;
}
// Compare every original before writing any file. Journal survives failures; never overwrite a conflict.
export async function applyChanges(root,delta,journalRoot,{afterWrite}={}){
  root=await realpath(root);const paths=[];
  for(const item of delta){const path=await guardedPath(root,item.path);let actual=null;try{actual=digest(await readFile(path));}catch(e){if(e.code!=='ENOENT')throw e;}if(actual!==(item.before?.hash??null))throw new Error(`Project changed since task started; manual integration required: ${item.path}`);paths.push(path);}
  await mkdir(journalRoot,{recursive:true});const journal=join(journalRoot,`${randomUUID()}.json`),record={root,state:'prepared',delta,applied:[]};await writeFile(journal,JSON.stringify(record),{flag:'wx'});
  try{for(let i=0;i<delta.length;i++){const item=delta[i],path=paths[i];await mkdir(dirname(path),{recursive:true});
    // Re-check immediately before each write; external writers are not locked by this plugin.
    let actual=null;try{actual=digest(await readFile(path));}catch(e){if(e.code!=='ENOENT')throw e;}if(actual!==(item.before?.hash??null))throw new Error(`Concurrent project edit: ${item.path}`);
    if(item.after){const tmp=`${path}.team-${randomUUID()}.tmp`;await writeFile(tmp,await fileBytes(item.after),{flag:'wx',mode:item.after.mode});await rename(tmp,path);}else await unlink(path);
    record.applied.push(item.path);await writeFile(journal,JSON.stringify(record));await afterWrite?.(item.path);
  }record.state='applied';await writeFile(journal,JSON.stringify(record));return {journal,paths:record.applied};}
  catch(error){record.state='needs-recovery';record.error=error.message;await writeFile(journal,JSON.stringify(record));const failure=new Error(`Integration incomplete; do not retry automatically. Recovery journal: ${journal}. ${error.message}`);failure.journal=journal;throw failure;}
}

export async function rollbackIntegration(root,journal){
  root=await realpath(root);const record=JSON.parse(await readFile(journal,'utf8'));
  if(record.root!==root||!['needs-recovery','rolling-back','rolled-back'].includes(record.state))throw new Error('Recovery journal does not describe this interrupted integration');
  const entries=[];
  async function actual(path){try{return digest(await readFile(path));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  for(const item of record.delta){const path=await guardedPath(root,item.path),hash=await actual(path);if(hash!==(item.before?.hash??null)&&hash!==(item.after?.hash??null))throw new Error('Recovery refused: user changed '+item.path);entries.push({item,path});}
  record.state='rolling-back';await writeFile(journal,JSON.stringify(record));
  for(const {item,path} of entries.reverse()){
    const hash=await actual(path);if(hash===(item.before?.hash??null))continue;
    if(hash!==(item.after?.hash??null))throw new Error('Recovery refused concurrent edit: '+item.path);
    if(item.before){await mkdir(dirname(path),{recursive:true});const tmp=path+'.rollback-'+randomUUID();await writeFile(tmp,await fileBytes(item.before),{flag:'wx',mode:item.before.mode});await rename(tmp,path);}else await unlink(path);
  }
  record.state='rolled-back';record.recoveredAt=new Date().toISOString();await writeFile(journal,JSON.stringify(record));return{journal,status:'rolled-back'};
}
