import {createReadStream} from 'node:fs';
import {realpath,stat} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {isAbsolute,relative} from 'node:path';

// Read public call *metadata* only. No prompt, encrypted message, reasoning or
// tool output is returned. Absence is evidence only with a complete canonical
// parent history and a second empty child-index observation by the caller.
export async function nativeLaunchIntent(thread,{sessionsRoot,taskName,since}){
 const unknown=reason=>({source:'native-spawn-intent-history',verified:false,reason});
 if(!thread?.path||!sessionsRoot||typeof taskName!=='string')return unknown('Native launch history unavailable');
 try{
  const root=await realpath(sessionsRoot),path=await realpath(thread.path),rel=relative(root,path);
  if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('../'))return unknown('Native parent history is outside the session directory');
  const before=await stat(path);if(before.size>64*1024*1024)return unknown('Native parent history exceeds bounded launch inspection');
  const rows=createInterface({input:createReadStream(path,{end:before.size-1}),crlfDelay:Infinity}),calls=[];let identity=false,complete=true;
  try{for await(const line of rows){
   const prefix=line.slice(0,512),type=prefix.match(/"type"\s*:\s*"([a-z_]+)"/)?.[1];
   if(!line.trim())continue;
   if(!['session_meta','response_item','compacted','turn_context','event_msg','world_state','token_usage_record'].includes(type)){complete=false;break;}
   if(['turn_context','event_msg','world_state','token_usage_record'].includes(type))continue;
   if(type==='response_item'){
    const payloadType=prefix.match(/"payload"\s*:\s*\{\s*"type"\s*:\s*"([a-z_]+)"/)?.[1];
    if(['message','reasoning','function_call_output','custom_tool_call_output'].includes(payloadType))continue;
    if(!['function_call','custom_tool_call'].includes(payloadType)){complete=false;break;}
   }
   if(line.length>8*1024*1024){complete=false;break;}
   let row;try{row=JSON.parse(line);}catch{complete=false;break;}const p=row.payload??{};
   if(type==='session_meta'){if(p.id!==thread.id){complete=false;break;}identity=true;}
   else if(type==='compacted'){if(!since||!row.timestamp||Date.parse(row.timestamp)>=Date.parse(since)){complete=false;break;}}
   else if(/(?:^|[._])spawn_agent$/.test(p.name??'')){
    let args;try{args=typeof p.arguments==='string'?JSON.parse(p.arguments):p.arguments;}catch{complete=false;break;}
    if(typeof args?.task_name!=='string'){complete=false;break;}
    if(args.task_name===taskName)calls.push({callId:p.call_id??null,taskName,at:row.timestamp??null});
   }
  }}finally{rows.close();}
  // An in-flight tool call, compaction or new parent activity invalidates a
  // negative result. A later request can inspect its stable original history.
  const after=await stat(path);if(before.size!==after.size||before.ino!==after.ino)return unknown('Native launch history changed during inspection');
  if(!identity||!complete)return unknown('Native launch history is incomplete or compacted');
  return {source:'native-spawn-intent-history',verified:true,parentThreadId:thread.id,taskName,launchCallObserved:calls.length>0,calls,observedAt:new Date().toISOString()};
 }catch{return unknown('Native launch intent could not be verified');}
}
