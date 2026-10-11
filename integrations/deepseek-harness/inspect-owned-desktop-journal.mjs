// Exact authorized Desktop proof session only. Never emit non-public events/blocks.
import {readFile,writeFile} from 'node:fs/promises';
import {zstdDecompressSync} from 'node:zlib';
import {publicText} from '../../src/host-normalize.mjs';
const path='C:/Users/Administrator/.dsh/sessions/--E-AI-ai-plugin-agent-team-evidence-dsh-desktop-039-proof--/session-84471000-e8a4-45ec-b370-4a2d4226248a/session.v4.jsonl.zstd';
// Match the public persistence SDK frame scanner: only complete independent
// checksummed frames are decompressed. No private runtime/profile mutation.
const bytes=await readFile(path),frames=[];let offset=0;
while(offset<bytes.length){
  const start=offset;if(bytes.length-offset<5)break;
  if(bytes.readUInt32LE(offset)!==4247762216)throw Error(`Invalid frame at ${offset}`);
  offset+=4;const descriptor=bytes[offset++];if(descriptor&24)throw Error('Reserved frame bit');
  const sizeFlag=descriptor>>>6,single=Boolean(descriptor&32),dict=descriptor&3;
  offset+=(single?0:1)+(dict===3?4:dict)+(sizeFlag===0?(single?1:0):1<<sizeFlag);
  if(offset>bytes.length)break;let complete=false;
  while(offset+3<=bytes.length){const block=bytes.readUIntLE(offset,3);offset+=3;const type=(block>>>1)&3;if(type===3)throw Error('Reserved block type');offset+=type===1?1:block>>>3;if(offset>bytes.length)break;if(block&1){complete=true;break;}}
  if(!complete)break;if(descriptor&4)offset+=4;if(offset>bytes.length)break;
  frames.push({start,end:offset});
}
const decoded=frames.map(frame=>zstdDecompressSync(bytes.subarray(frame.start,frame.end)).toString()).join('');
const counts={},rows=[],commands=new Set(),fixtureEvents=[];let lines=0;
for(const line of decoded.split('\n').filter(Boolean)){
  lines++;const row=JSON.parse(line),type=row.type;if(['assistant/message','tool/result','tool/call','user/message','turn/end'].includes(type))counts[type]=(counts[type]??0)+1;
  if(!['turn/start','assistant/message','tool/result','tool/call','user/message','turn/end'].includes(type))continue;
  const d=row.data??{},message=d.message??{};
  const blocks=Array.isArray(message.content)?message.content:Array.isArray(d.content)?d.content:[];
  if(type==='turn/start'&&d.turn===1)fixtureEvents.push({seq:row.seq,type,data:{turn:d.turn}});
  if(type==='assistant/message'&&d.turn===1&&!fixtureEvents.some(event=>event.type===type&&Boolean(event.data.message.content.length)===Boolean(blocks.some(block=>block.type==='text'))))fixtureEvents.push({seq:row.seq,type,data:{turn:d.turn,message:{id:message.id,content:blocks.filter(block=>block.type==='text').map(block=>({type:'text',text:publicText(block.text).slice(0,500)}))}}});
  if(type==='tool/call'&&d.name==='pwsh'&&!commands.size)fixtureEvents.push({seq:row.seq,type,data:{turn:d.turn,callId:d.callId,name:d.name,arguments:d.arguments}});
  if(type==='tool/result'&&fixtureEvents.some(event=>event.type==='tool/call'&&event.data.callId===message.source?.callId))fixtureEvents.push({seq:row.seq,type,data:{turn:d.turn,message:{id:message.id,source:{callId:message.source.callId},isError:message.isError,content:blocks.filter(block=>block.type==='text').map(block=>({type:'text',text:publicText(block.text)}))},...(d.meta?{meta:d.meta}:{})}});
  if(type==='turn/end'&&d.turn===1)fixtureEvents.push({seq:row.seq,type,data:{turn:d.turn,reason:{kind:d.reason?.kind}}});
  if(type==='tool/call'&&['pwsh','bash','run_command'].includes(d.name))commands.add(d.callId);
  rows.push({seq:row.seq,type,dataKeys:Object.keys(d),turn:d.turn,messageKeys:Object.keys(message),name:d.name,callId:d.callId,source:message.source?.callId?{callId:message.source.callId}:undefined,isError:message.isError,meta:d.meta,reason:d.reason?{kind:d.reason.kind}:undefined,blocks:blocks.filter(block=>block.type==='text').map(block=>({type:block.type,keys:Object.keys(block),text:block.text?.slice(0,500),content:typeof block.content==='string'?block.content.slice(0,500):undefined}))});
}
const assistants=rows.filter(row=>row.type==='assistant/message');
const summary={frames:frames.length,completeBytes:frames.at(-1)?.end,lines,counts,assistantPublicTexts:assistants.filter(row=>row.blocks.length).length};
if(process.argv.includes('--save-fixture'))await writeFile(new URL('./fixtures/desktop-0.2.0-rc.2-public-events.json',import.meta.url),JSON.stringify({source:{host:'DSH Desktop 0.2.0-rc.2',sessionId:'session-84471000-e8a4-45ec-b370-4a2d4226248a',scope:'exact authorized proof session; public event allowlist; public assistant text truncated to 500 characters; reasoning/stream/request/profile fields excluded'},snapshot:summary,events:fixtureEvents.sort((a,b)=>a.seq-b.seq)},null,2)+'\n');
console.log(JSON.stringify({...summary,fixtureEvents:fixtureEvents.length,examples:assistants.filter(row=>row.blocks.length).slice(0,1).map(row=>({seq:row.seq,text:row.blocks[0].text.slice(0,100)})),commands:rows.filter(row=>row.type==='tool/result'&&commands.has(row.source?.callId)).map(row=>({seq:row.seq,isError:row.isError,meta:row.meta,text:row.blocks[0]?.text}))},null,2));
