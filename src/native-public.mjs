import {open, realpath, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute, join, relative} from 'node:path';
import {UsageWindow} from './usage-window.mjs';

const count = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
const envelopeType=bytes=>{const prefix=bytes.subarray(0,4096).toString('utf8'),at=prefix.indexOf('"payload"');return at<0?null:prefix.slice(0,at).match(/"type"\s*:\s*"([a-z_]+)"/)?.[1];};
const nonPublic=new Set(['response_item','turn_context','compacted']);
const nonAccountingEvents=new Set(['item_completed','exec_command_begin','exec_command_end','exec_command_output_delta','agent_message','agent_message_delta','user_message','task_started','task_complete','turn_aborted']);
function usage(info) {
  if (!info) return null;
  const inputTokens=count(info.input_tokens??info.inputTokens), outputTokens=count(info.output_tokens??info.outputTokens);
  const totalTokens=count(info.total_tokens??info.totalTokens);
  return totalTokens===null ? null : {inputTokens, outputTokens, totalTokens, cachedInputTokens:count(info.cached_input_tokens??info.cachedInputTokens)};
}
const publicText = item => typeof item.text==='string' ? item.text : Array.isArray(item.content) ? item.content.filter(c=>c&&['text','output_text'].includes(c.type)).map(c=>c.text??'').join('') : '';

// Tail only the already-authorized child's rollout. No resume, model request,
// prompt, tool arguments, credentials or reasoning is exposed through this feed.
export class NativePublicFeed {
  constructor({sessionsRoot=join(process.env.CODEX_HOME??join(homedir(),'.codex'),'sessions'),maxEvents=200,maxText=16000}={}) {
    this.sessionsRoot=sessionsRoot; this.maxEvents=maxEvents; this.maxText=maxText; this.files=new Map();
  }
  async read(thread, turnId, {cursor=0}={}) {
    if (!thread.path || !turnId) return {events:[],cursor:0,usage:null,source:'unavailable'};
    const root=await realpath(this.sessionsRoot), path=await realpath(thread.path), rel=relative(root,path);
    if (!rel || isAbsolute(rel) || rel==='..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Public feed is outside the host session directory');
    const key=thread.id+':'+path;
    let f=this.files.get(key);
    if (!f) { f={offset:0,pending:Buffer.alloc(0),discardingRow:false,skippedNonPublicRows:0,skippedPublicRows:0,identity:false,turn:null,totals:null,turns:new Map(),accounting:new UsageWindow(),tail:Promise.resolve()}; this.files.set(key,f); }
    const next=f.tail.catch(()=>{}).then(()=>this.tail(f,path,thread.id)); f.tail=next; await next;
    const t=f.turns.get(turnId);
    return {events:(t?.events??[]).filter(e=>e.sequence>cursor),cursor:t?.sequence??0,reset:cursor>(t?.sequence??0),truncated:f.skippedPublicRows>0||(cursor>0&&cursor<(t?.events[0]?.sequence??1)-1),skippedPublicRows:f.skippedPublicRows,
      usage:t?.usage??null,source:'native-public-rollout',lastActivity:t?.events.at(-1)??null};
  }
  async usageWindow(thread,window){
    if(!thread.path)return {source:'unavailable',usage:null,complete:false,reason:'Native session file unavailable'};
    await this.read(thread,'public-accounting-only');
    const path=await realpath(thread.path),f=this.files.get(thread.id+':'+path);
    return {...f.accounting.read(window),skippedNonPublicRows:f.skippedNonPublicRows,skippedPublicRows:f.skippedPublicRows};
  }
  emit(f,turnId,event) {
    if (!turnId) return;
    let t=f.turns.get(turnId); if (!t) {t={sequence:0,events:[],usage:null,baseline:f.totals};f.turns.set(turnId,t);}
    t.events.push({...event,sequence:++t.sequence});
    if (t.events.length>this.maxEvents) t.events.splice(0,t.events.length-this.maxEvents);
    if (f.turns.size>64) {const oldest=[...f.turns.keys()].find(k=>k!==f.turn);if(oldest) f.turns.delete(oldest);}
  }
  async tail(f,path,id) {
    const s=await stat(path);
    if (s.size<f.offset) { f.offset=0;f.pending=Buffer.alloc(0);f.discardingRow=false;f.skippedNonPublicRows=0;f.skippedPublicRows=0;f.identity=false;f.turn=null;f.totals=null;f.turns.clear();f.accounting=new UsageWindow(); }
    if (s.size===f.offset) return;
    const fd=await open(path,'r');
    try {
      while (f.offset<s.size) {
        const bytes=Buffer.alloc(Math.min(256*1024,s.size-f.offset)); const {bytesRead}=await fd.read(bytes,0,bytes.length,f.offset); if (!bytesRead) break;
        f.offset+=bytesRead;let incoming=bytes.subarray(0,bytesRead);
        if(f.discardingRow){const end=incoming.indexOf(10);if(end===-1)continue;incoming=incoming.subarray(end+1);f.discardingRow=false;}
        const body=Buffer.concat([f.pending,incoming]); let start=0,at;
        while ((at=body.indexOf(10,start))!==-1) {const row=body.subarray(start,at);if(at-start>8*1024*1024)this.skipLargeRow(f,row);else if(!nonPublic.has(envelopeType(row)))this.row(f,row.toString('utf8'),id);start=at+1;}
        f.pending=body.subarray(start);
        // A corrupt/unbounded row is not a reason to retain arbitrary private data.
        if (f.pending.length>8*1024*1024){this.skipLargeRow(f,f.pending);f.pending=Buffer.alloc(0);f.discardingRow=true;}
      }
    } catch(error){
      // A failed row cannot leave the byte offset beyond unparsed records.
      // Identity failures must also remain failures on the next read.
      f.offset=0;f.pending=Buffer.alloc(0);f.discardingRow=false;f.skippedNonPublicRows=0;f.skippedPublicRows=0;f.identity=false;f.turn=null;f.totals=null;f.turns.clear();f.accounting=new UsageWindow();throw error;
    } finally {await fd.close();}
  }
  skipLargeRow(f,bytes){
    // Native envelopes place the top-level type before payload. Do not parse
    // megabytes of private response items just to reach the following counters.
    const type=envelopeType(bytes);
    if(nonPublic.has(type))f.skippedNonPublicRows++;
    else {
      f.skippedPublicRows++;
      const eventType=bytes.subarray(0,4096).toString('utf8').match(/"payload"\s*:\s*\{\s*"type"\s*:\s*"([a-z_]+)"/)?.[1];
      // Large command/output events can truncate the activity preview, but
      // cannot contain token accounting. Unknown envelopes remain incomplete.
      if(type!=='event_msg'||!nonAccountingEvents.has(eventType))f.accounting.unlocated=true;
    }
  }
  row(f,line,id) {
    let row;try {row=JSON.parse(line);}catch {return;}
    if(!row||typeof row!=='object'||Array.isArray(row))return;
    const p=row.payload??{};
    if (row.type==='session_meta') {if(p.id!==id) throw new Error('Public feed session identity mismatch'); f.identity=true;return;}
    if (!f.identity || row.type!=='event_msg' || (p.thread_id&&p.thread_id!==id)) return;
    if(p.type==='token_count')f.accounting.record(row.timestamp,usage(p.info?.total_token_usage??p.tokenUsage?.total),usage(p.info?.last_token_usage));
    if (p.type==='task_started' && typeof p.turn_id==='string') {f.turn=p.turn_id;if(!f.turns.has(f.turn)) f.turns.set(f.turn,{sequence:0,events:[],usage:null,baseline:f.totals});}
    const turnId=p.turn_id??(p.type==='token_count'?f.turn:null);
    if (!turnId) return;
    const event={at:row.timestamp??null,type:p.type};
    if (p.type==='token_count') {
      const totals=usage(p.info?.total_token_usage??p.tokenUsage?.total),t=f.turns.get(turnId);
      if (totals && t) {
        const last=usage(p.info?.last_token_usage);
        if(!t.baseline&&!t.firstTokenSeen&&last?.totalTokens===totals.totalTokens)t.baseline={totalTokens:0,inputTokens:0,outputTokens:0,cachedInputTokens:0};
        t.firstTokenSeen=true;
        const base=t.baseline;
        // Only a verified first sample establishes zero. A restored log with
        // accumulated totals but no baseline remains unknown for that turn.
        if(base) {
          const totalTokens=totals.totalTokens-(base?.totalTokens??0);
          if(totalTokens>=0) t.usage={source:'host-cumulative-delta',totalTokens,inputTokens:totals.inputTokens===null?null:Math.max(0,totals.inputTokens-(base?.inputTokens??0)),outputTokens:totals.outputTokens===null?null:Math.max(0,totals.outputTokens-(base?.outputTokens??0)),cachedInputTokens:totals.cachedInputTokens===null?null:Math.max(0,totals.cachedInputTokens-(base?.cachedInputTokens??0)),modelContextWindow:count(p.info?.model_context_window),currentInputTokens:last?.inputTokens??null};
        }
        f.totals=totals;
      }
      return;
    }
    if (['agent_message','agent_message_delta'].includes(p.type)) {event.text=String(p.message??p.delta??'').slice(-this.maxText);}
    else if (['exec_command_begin','exec_command_end','exec_command_output_delta'].includes(p.type)) {
      event.callId=p.call_id??p.callId??null;event.command=typeof p.command==='string'?p.command:Array.isArray(p.command)?p.command.join(' '):null;
      event.text=String(p.output??p.delta??p.aggregated_output??'').slice(-this.maxText);event.exitCode=p.exit_code??null;
    } else if (p.type==='item_completed' && p.thread_id===id) {
      const item=p.item??{};
      if (['AgentMessage','agentMessage'].includes(item.type)) {event.type='agent_message';event.text=publicText(item).slice(-this.maxText);}
      else if (['CommandExecution','commandExecution'].includes(item.type)) {event.type='exec_command_end';event.command=typeof item.command==='string'?item.command:null;event.text=String(item.aggregatedOutput??item.aggregated_output??'').slice(-this.maxText);event.exitCode=item.exitCode??item.exit_code??null;}
      else if (['FileChange','fileChange'].includes(item.type)) {event.type='file_change';event.paths=(Array.isArray(item.changes)?item.changes.map(c=>c?.path):item.changes&&typeof item.changes==='object'?Object.keys(item.changes):[]).filter(p=>typeof p==='string').slice(0,100);}
      else return;
    } else if (!['task_started','task_complete','turn_aborted'].includes(p.type)) return;
    if (event.text?.startsWith('TEAM_WORKSPACE_')) return;
    this.emit(f,turnId,event);
  }
}
