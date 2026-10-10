import {createReadStream} from 'node:fs';
import {realpath} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {homedir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';

// An observer app-server may synthesize "interrupted" for a live, unloaded turn.
// Only an explicit persisted lifecycle event confirms interruption. Never return
// prompts, reasoning, encrypted content or unrelated transcript rows.
export async function persistedTerminal(thread,turnId,{sessionsRoot=join(process.env.CODEX_HOME??join(homedir(),'.codex'),'sessions')}={}){
  if(!thread.path)return null;
  const root=await realpath(sessionsRoot),path=await realpath(thread.path),rel=relative(root,path);
  if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../'))throw new Error('Native lifecycle record is outside the host session directory');
  const stream=createReadStream(path,{encoding:'utf8'}),lines=createInterface({input:stream,crlfDelay:Infinity});
  let identity=false,result=null;
  try{for await(const line of lines){
    let row;try{row=JSON.parse(line);}catch{continue;}
    // The first metadata row identifies this file. Forked native members can
    // subsequently contain inherited parent metadata; it cannot redefine the
    // file owner. Events still require the exact globally unique child turn ID.
    if(row.type==='session_meta'&&!identity){identity=row.payload?.id===thread.id;if(!identity)throw new Error('Native lifecycle session identity mismatch');}
    if(!identity||row.type!=='event_msg'||row.payload?.turn_id!==turnId)continue;
    if(row.payload.type==='turn_aborted')result={status:'interrupted',source:'persisted-turn-aborted',at:row.timestamp};
    if(row.payload.type==='task_complete')result={status:'completed',source:'persisted-task-complete',at:row.timestamp};
  }}finally{lines.close();stream.destroy();}
  return result;
}

// Only timestamped, explicitly turn-bound public events can renew activity.
// In particular, reasoning and unbound transcript rows cannot prove progress.
const publicActivityTypes=new Set(['agent_message','exec_command_begin','exec_command_end','exec_command_output_delta']);
const publicCompletedItemTypes=new Set(['AgentMessage','CommandExecution','FileChange','McpToolCall','ContextCompaction']);
export async function persistedActivity(thread,turnId,{sessionsRoot=join(process.env.CODEX_HOME??join(homedir(),'.codex'),'sessions'),nowMs=Date.now(),freshnessMs=60000}={}){
  if(!thread.path)return null;
  if(!Number.isFinite(nowMs)||!Number.isFinite(freshnessMs)||freshnessMs<=0)throw new Error('Native activity clock and freshness must be valid');
  const freshness=Math.min(freshnessMs,60000);
  const root=await realpath(sessionsRoot),path=await realpath(thread.path),rel=relative(root,path);
  if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../'))throw new Error('Native lifecycle record is outside the host session directory');
  const stream=createReadStream(path,{encoding:'utf8'}),lines=createInterface({input:stream,crlfDelay:Infinity});
  let identity=false,terminal=null,lastActivity=null,startedAt=null,invalidTime=null;
  try{for await(const line of lines){
    let row;try{row=JSON.parse(line);}catch{continue;}
    if(row.type==='session_meta'&&!identity){identity=row.payload?.id===thread.id;if(!identity)throw new Error('Native lifecycle session identity mismatch');}
    if(!identity||row.type!=='event_msg'||row.payload?.turn_id!==turnId)continue;
    if(row.payload.thread_id&&row.payload.thread_id!==thread.id)continue;
    const type=row.payload.type,isTerminal=type==='turn_aborted'||type==='task_complete';
    // Current Desktop persists public command/message completions as items.
    // Their explicit child identity is required; the item body is never read.
    const publicCompletedItem=type==='item_completed'&&row.payload.thread_id===thread.id&&publicCompletedItemTypes.has(row.payload.item?.type);
    if(!isTerminal&&type!=='task_started'&&!publicActivityTypes.has(type)&&!publicCompletedItem)continue;
    const atMs=typeof row.timestamp==='string'?Date.parse(row.timestamp):NaN;
    if(!Number.isFinite(atMs)||atMs>nowMs+5000){invalidTime={at:typeof row.timestamp==='string'?row.timestamp:null};continue;}
    if(isTerminal){terminal={status:type==='turn_aborted'?'interrupted':'completed',source:type==='turn_aborted'?'persisted-turn-aborted':'persisted-task-complete',at:row.timestamp};continue;}
    if(type==='task_started'&&(!startedAt||atMs<startedAt.ms))startedAt={ms:atMs,at:row.timestamp};
    if(!lastActivity||atMs>lastActivity.ms)lastActivity={ms:atMs,at:row.timestamp};
  }}finally{lines.close();stream.destroy();}
  if(terminal)return terminal;
  if(invalidTime)return {status:'unknown',source:'persisted-native-activity-invalid-time',at:invalidTime.at,startedAt:startedAt?.at??null};
  if(!lastActivity)return null;
  const freshUntil=new Date(lastActivity.ms+freshness).toISOString();
  return {status:nowMs<lastActivity.ms+freshness?'inProgress':'unknown',source:nowMs<lastActivity.ms+freshness?'persisted-native-activity':'persisted-native-activity-stale',at:lastActivity.at,startedAt:startedAt?.at??null,freshUntil};
}
