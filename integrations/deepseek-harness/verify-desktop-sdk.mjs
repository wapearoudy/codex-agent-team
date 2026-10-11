// Read-only inspection of the actual installed desktop archive. No credentials,
// profile mutation, runtime launch, ASAR extraction, or model requests.
import {open,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const archive=process.env.DSH_DESKTOP_ASAR??'D:/Soft/dsh-desktop/resources/app.asar';
const file=await open(archive,'r');
try{
  const prefix=Buffer.alloc(16);await file.read(prefix,0,16,0);
  const headerSize=prefix.readUInt32LE(4),jsonSize=prefix.readUInt32LE(12);
  if(jsonSize<2||jsonSize>20_000_000)throw new Error('Unexpected ASAR header');
  const buffer=Buffer.alloc(jsonSize);await file.read(buffer,0,jsonSize,16);
  const header=JSON.parse(buffer.toString('utf8')),paths=[];
  const walk=(node,path='')=>{for(const [name,entry] of Object.entries(node.files??{})){const target=path?`${path}/${name}`:name;if(entry.files)walk(entry,target);else paths.push(target);}};walk(header);
  const read=async path=>{let entry=header;for(const part of path.split('/'))entry=entry.files[part];if(entry.unpacked)return null;const data=Buffer.alloc(entry.size);await file.read(data,0,data.length,8+headerSize+Number(entry.offset));return data.toString('utf8');};
  const manifests=paths.filter(path=>path==='package.json'||/dsh\/(?:package.json|node_modules\/@deepseek-ai\/[^/]+\/package.json)$/.test(path));
  const packages=[];for(const path of manifests){const text=await read(path);if(!text)continue;const pkg=JSON.parse(text);packages.push({path,name:pkg.name,version:pkg.version,...(path==='package.json'?{main:pkg.main}:{}),...(pkg.name==='@deepseek-ai/dsh'?{exports:pkg.exports}:{} )});}
  const relevant=paths.filter(path=>/dsh\/(?:lib\/(?:profile|index)|profiles\/|node_modules\/@deepseek-ai\/(?:dsh-agent|dsh-session-projection|dsh-client-ui-workspace|dsh-desktop-host)\/)/.test(path));
  const publicSources={};for(const path of ['dsh/node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts','dsh/node_modules/@deepseek-ai/dsh-agent/lib/types/index.d.ts','dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js','dsh/node_modules/@deepseek-ai/dsh-session-projection/lib/types/index.d.ts'])if(paths.includes(path))publicSources[path]=await read(path);
  const source=key=>publicSources[`dsh/node_modules/@deepseek-ai/${key}`]??'';
  const match=(key,pattern)=>source(key)?pattern.test(source(key)):null;
  const publicApi={agentCreatedPayloadAgent:match('dsh-agent/lib/types/runtime-types.d.ts',/'agent\/created'[\s\S]{0,100}agent: Agent/),agentRegistryCreate:match('dsh-agent/lib/types/index.d.ts',/create\(options: CreateAgentOptions\)/),uiWorkspaceOpenSession:match('dsh-client-ui-workspace/lib/client.js',/openSession\(target\)/),blankSessionHiddenUnlessSelected:match('dsh-client-ui-workspace/lib/client.js',/session\.blank && session\.id !== current/),sessionProjectionRegistry:match('dsh-session-projection/lib/types/index.d.ts',/class SessionProjectionRegistry/)};
  if(process.argv[2]){
    const selected=process.argv[2];if(!(selected==='lib/main.js'||/^dsh\/node_modules\/@deepseek-ai\/(?:dsh-plugin-manager|dsh-client-ui-plugin-manager|dsh-desktop-host|dsh-profile|dsh-app-boot)\//.test(selected))||!paths.includes(selected))throw new Error('Not an allowlisted installed source');
    const text=await read(selected),lines=text.split('\n');
    const range=/^(\d+):(\d+)$/.exec(process.argv[3]??'');
    if(range){const start=Number(range[1])-1,count=Math.min(25,Number(range[2]));console.log(lines.slice(start,start+count).map((line,index)=>({line:start+index+1,text:line.slice(0,230)})));}
    else{const query=new RegExp(process.argv[3]??'install|DSH_HOME|profile|reload|bundle','i');console.log(lines.flatMap((line,index)=>query.test(line)?[{line:index+1,text:line.slice(0,230)}]:[]).slice(0,18));}
  }
  const evidence={kind:'actual-installed-desktop-asar-readonly',archive,packages,publicApi,relevantPaths:relevant.slice(0,70),pluginRelatedPaths:paths.filter(path=>/^lib\/.*(?:plugin|profile)|dsh\/.*(?:bundle|plugin-manager|plugin-profile)/i.test(path)).slice(0,40)};
  await mkdir(resolve('evidence'),{recursive:true});await writeFile(resolve('evidence/dsh-desktop-sdk-039.json'),JSON.stringify(evidence,null,2));
  if(!process.argv[2])console.log(JSON.stringify({archive,packages:packages.filter(pkg=>['package.json','dsh/package.json'].includes(pkg.path)||/dsh-(agent|session-projection|client-ui-workspace|desktop-host)$/.test(pkg.name??'')),publicApi,relevantPaths:relevant.slice(0,8)},null,2));
}finally{await file.close();}
