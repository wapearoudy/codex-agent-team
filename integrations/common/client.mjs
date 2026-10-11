import {fileURLToPath} from 'node:url';
import {basename,join,delimiter} from 'node:path';
import {appendFile,access} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {compactNames} from './names.mjs';
export {compactNames} from './names.mjs';
export async function connectEngine({host,entryUrl,bridgeRoot}){
  const server=process.env.TEAM_WORKSPACE_SERVER_PATH??fileURLToPath(new URL('./server.cjs',entryUrl));
  const env=Object.fromEntries(Object.entries(process.env).filter(([,v])=>typeof v==='string'));
  let command=process.env.TEAM_WORKSPACE_NODE_BINARY??(host==='opencode'||process.versions.bun||!/^node(?:\.exe)?$/i.test(basename(process.execPath))?'node':process.execPath);
  if(command==='node')for(const part of (process.env.PATH??process.env.Path??'').split(delimiter)){if(!part)continue;const candidate=join(part.replace(/^"|"$/g,''),process.platform==='win32'?'node.exe':'node');try{await access(candidate);command=candidate;break;}catch{/* continue verified runtime search */}}
  const trace=async event=>{if(process.env.TEAM_WORKSPACE_DEBUG_LOG)await appendFile(process.env.TEAM_WORKSPACE_DEBUG_LOG,JSON.stringify({event,host,command,server,execPath:process.execPath,bun:!!process.versions.bun})+'\n');};
  await trace('mcp-start');
  const transport=new StdioClientTransport({command,args:[server],env:{...env,TEAM_WORKSPACE_HOST:host,...(bridgeRoot?{TEAM_WORKSPACE_BRIDGE_ROOT:bridgeRoot}:{})},stderr:'inherit'});
  const client=new Client({name:`team-workspace-${host}`,version:'0.35.0'});await client.connect(transport);await trace('mcp-connected');
  const listed=await client.listTools();const tools=listed.tools.filter(t=>compactNames.has(t.name)).map(t=>{const inputSchema=structuredClone(t.inputSchema);delete inputSchema.properties?._hostTicket;if(Array.isArray(inputSchema.required))inputSchema.required=inputSchema.required.filter(k=>k!=='_hostTicket');else delete inputSchema.required;return {...t,inputSchema};});
  await trace('mcp-listed-tools');
  if(tools.length!==6){await client.close();throw new Error('The bundled engine did not expose all six compact tools');}
  return {tools,close:()=>client.close(),async call(bridge,sessionId,name,args,signal){if(!compactNames.has(name))throw new Error('Unsupported compact tool');const _hostTicket=await bridge.issueContext(sessionId,name);const result=await client.callTool({name,arguments:{...args,_hostTicket}},undefined,{signal});if(result.isError)throw new Error(result.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')??'Team tool failed');return result.structuredContent??result.content;}};
}
