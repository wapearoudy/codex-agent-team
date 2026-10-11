import {join,isAbsolute,basename,dirname,relative} from 'node:path';
import {homedir} from 'node:os';
import {mkdir,realpath,readFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {DurableStore} from './durable-store.mjs';
import {sanitizeThread,textBlocks,normalizeUsage} from './host-normalize.mjs';
import {TranscriptCache} from './transcript-cache.mjs';
const hosts=new Set(['deepseek-harness','claude-code','opencode']);
const hash=value=>createHash('sha256').update(value).digest('hex');
function claudeTaskReceipt(row,parentId){
  if(row.type==='system'&&['task_started','task_notification','task_updated'].includes(row.subtype)){
    if(row.session_id&&row.session_id!==parentId||row.sessionId&&row.sessionId!==parentId)return null;
    return row;
  }
  if(row.type!=='user'||row.message?.role!=='user'||row.origin?.kind!=='task-notification'||row.origin?.producer!=='session-task'||row.promptSource!=='system'||row.turnOrigin!=='task_notification'||row.sessionId!==parentId||typeof row.cwd!=='string'||!row.cwd)return null;
  const content=row.message.content;
  if(typeof content!=='string'||!/^\s*<task-notification>[\s\S]*<\/task-notification>\s*$/.test(content))return null;
  const field=tag=>{const matches=[...content.matchAll(new RegExp('<'+tag+'>([^<>]*)</'+tag+'>','g'))];return matches.length===1?matches[0][1].trim():null;};
  const taskId=field('task-id'),toolUseId=field('tool-use-id'),status=field('status');
  if(!taskId||!toolUseId||!status||!/^[-a-zA-Z0-9_]{1,200}$/.test(taskId)||!/^[-a-zA-Z0-9_]{1,200}$/.test(toolUseId))return null;
  return {subtype:'task_notification',task_id:taskId,tool_use_id:toolUseId,status,cwd:row.cwd,sessionId:parentId};
}
function preserveClaudeTurn(turn,observed,{active=false,terminal=true}={}){
  const commands=new Set(turn.items.filter(i=>i.type==='commandExecution').map(i=>i.commandId??i.id));
  turn.items.push(...observed.items.filter(i=>i.type==='commandExecution'&&!commands.has(i.commandId??i.id)));
  const trusted=['native-task-receipt','persisted-native-task-stop'].includes(observed.statusEvidence?.source)&&observed.statusEvidence?.status===observed.status&&['completed','failed','interrupted'].includes(observed.status);
  if(terminal&&trusted){turn.status=observed.status;turn.statusEvidence=observed.statusEvidence;}
  else if(active&&observed.status==='inProgress'){turn.status='inProgress';if(observed.statusEvidence?.status==='inProgress')turn.statusEvidence=observed.statusEvidence;}
  const texts=new Set(turn.items.filter(i=>i.type==='agentMessage').map(i=>i.text));
  turn.items.push(...observed.items.filter(i=>i.type==='agentMessage'&&i.phase==='final_answer'&&!texts.has(i.text)));
}
export class HostBridge{
  constructor({host,root=process.env.TEAM_WORKSPACE_BRIDGE_ROOT??join(homedir(),'.agent-team','bridge',host),ticketTtlMs=30000,now=Date.now}={}){
    if(!hosts.has(host))throw new Error('Unsupported native host');this.host=host;this.root=root;this.file=join(root,'registry.json');this.now=now;this.ticketTtlMs=ticketTtlMs;this.transcriptCache=new TranscriptCache();
    this.store=new DurableStore(this.file,{version:1,host,threads:{},models:[],tickets:{},transcripts:{}},d=>{if(d.version!==1||d.host!==host||!d.threads||!d.tickets)throw new Error('Bridge registry identity mismatch');});
  }
  async ensure(){await mkdir(this.root,{recursive:true});}
  async putThread(thread){const clean=sanitizeThread(thread);if(!isAbsolute(clean.cwd))throw new Error('Native cwd must be absolute');clean.cwd=await realpath(clean.cwd);const before=await this.store.read();if(JSON.stringify(before.threads[clean.id])===JSON.stringify(clean))return clean;await this.store.transaction(d=>{const old=d.threads[clean.id];if(old&&(old.cwd!==clean.cwd||old.parentThreadId!==clean.parentThreadId))throw new Error('Native session identity cannot be changed');d.threads[clean.id]=clean;});return clean;}
  async readThread(id){let d=await this.store.read();if(this.host==='claude-code'&&d.threads[id]?.parentThreadId){await this.refreshClaudeTaskReceipts(d.threads[id].parentThreadId);d=await this.store.read();}const thread=Object.hasOwn(d.threads,id)?d.threads[id]:null;if(!thread){const error=new Error('Native session is unavailable');error.code='HOST_SESSION_UNAVAILABLE';throw error;}if(this.host==='claude-code'&&d.transcripts[id])return this.refreshClaude(thread,d.transcripts[id]);return structuredClone(thread);}
  async refreshClaudeTaskReceipts(parentId){
    const registry=await this.store.read(),path=registry.transcripts[parentId]?.path;if(!path)return;
    let parsed;try{if(await realpath(path)!==path)throw new Error('Claude registered transcript path changed');parsed=await this.transcriptCache.rows(path);}catch(e){if(e.code==='ENOENT')return;throw e;}
    const rows=[];for(const value of parsed){const row=claudeTaskReceipt(value,parentId);if(row){if(row.cwd&&await realpath(row.cwd)!==registry.threads[parentId]?.cwd)throw new Error('Claude task receipt project mismatch');rows.push(row);}}
    if(!rows.length)return;
    await this.store.transaction(d=>{d.claudeTasks??={};for(const row of rows){
      const launch=row.tool_use_id?d.claudeLaunches?.[row.tool_use_id]:null;
      const binding=launch??d.claudeTasks[row.task_id];
      if(!row.task_id||!binding||binding.parentId!==parentId||row.tool_use_id&&!launch)continue;
      const state=d.claudeHookTurns?.[binding.agentId],child=d.threads[binding.agentId];
      if(!state||binding.hookTurnId!==state.hookTurnId||child?.parentThreadId!==parentId||child.cwd!==d.threads[parentId]?.cwd)continue;
      const last=child.turns.at(-1);if(last?.id!==state.hookTurnId&&last?.id!==state.linkedTranscriptTurnId)continue;
      d.claudeTasks[row.task_id]={...binding};
      const terminal={completed:'completed',failed:'failed',stopped:'interrupted',killed:'interrupted'}[row.status??row.patch?.status];if(!terminal)continue;
      last.status=terminal;last.statusEvidence={status:terminal,source:terminal==='interrupted'?'persisted-native-task-stop':'native-task-receipt'};state.receiptTurnId=state.hookTurnId;
    }});
  }
  async setModels(rows){const clean=[];for(const r of rows??[]){const model=r.model??r.id;if(typeof model!=='string'||!model)continue;clean.push({id:r.id??model,model,...(r.provider?{provider:r.provider}:{}),...(r.displayName?{displayName:r.displayName}:{}),source:r.source??'observed-host-model',childModelSelectable:r.childModelSelectable===true,...(Array.isArray(r.supportedReasoningEfforts)?{supportedReasoningEfforts:r.supportedReasoningEfforts.filter(v=>typeof v==='string')}:{} )});}if(JSON.stringify((await this.store.read()).models)===JSON.stringify(clean))return;await this.store.transaction(d=>{d.models=clean;});}
  async readModels(){return (await this.store.read()).models;}
  async issueContext(threadId,toolName){if(typeof toolName!=='string'||!toolName)throw new Error('Exact tool is required');const ticket=randomBytes(32).toString('base64url');await this.store.transaction(d=>{if(!Object.hasOwn(d.threads,threadId))throw new Error('Native session is unavailable');for(const[k,t]of Object.entries(d.tickets))if(t.expires<=this.now())delete d.tickets[k];d.tickets[hash(ticket)]={threadId,toolName,expires:this.now()+this.ticketTtlMs};});return ticket;}
  async authenticate(ticket,toolName){if(typeof ticket!=='string'||!ticket)throw new Error('Native host context ticket is required');return this.store.transaction(d=>{const key=hash(ticket),t=d.tickets[key];if(!t||t.expires<=this.now()||t.toolName!==toolName||!Object.hasOwn(d.threads,t.threadId))throw new Error('Native context ticket expired, replayed or mismatched');delete d.tickets[key];return {threadId:t.threadId};});}
  async registerClaudeTranscript(id,path){if(this.host!=='claude-code')throw new Error('Transcript refresh is Claude-only');let p;try{p=await realpath(path);}catch(e){if(e.code!=='ENOENT'||!isAbsolute(path))throw e;p=join(await realpath(dirname(path)),basename(path));}const d=await this.store.read();if(!Object.hasOwn(d.threads,id))throw new Error('Register native identity first');const expected=join(process.env.CLAUDE_CONFIG_DIR??join(homedir(),'.claude'),'projects'),base=await realpath(expected);if(relative(base,p).startsWith('..')||isAbsolute(relative(base,p)))throw new Error('Transcript is outside Claude project storage');if(![`${id}.jsonl`,`agent-${id}.jsonl`].includes(basename(p)))throw new Error('Transcript native identity mismatch');if(d.transcripts[id]?.path===p)return;await this.store.transaction(s=>{s.transcripts[id]={path:p};});}
  async refreshClaude(thread,record){
    let rows;try{if(await realpath(record.path)!==record.path)throw new Error('Claude registered transcript path changed');rows=await this.transcriptCache.rows(record.path);}catch(e){if(e.code==='ENOENT')return thread;throw e;}
    const turns=[];let current;
    for(const r of rows){if(r.agentId&&r.agentId!==thread.id)continue;if(r.sessionId&&r.sessionId!==thread.id&&r.sessionId!==thread.parentThreadId)continue;if(r.cwd&&await realpath(r.cwd)!==thread.cwd)throw new Error('Claude transcript project mismatch');const m=r.message;
      if(r.type==='user'&&m?.role==='user'&&(typeof m.content==='string'||m.content?.some(b=>b.type==='text'))){current={id:r.uuid,status:'unknown',items:[{type:'userMessage',content:m.content}]};turns.push(current);}
      if(r.type==='assistant'&&m){current??={id:r.uuid,status:'unknown',items:[]};if(!turns.includes(current))turns.push(current);current.items.push({type:'agentMessage',id:r.uuid,text:textBlocks(m.content),phase:m.stop_reason==='end_turn'?'final_answer':'commentary'});if(m.usage){current.usage??={};for(const[k,v]of Object.entries(normalizeUsage(m.usage)??{}))current.usage[k]=(current.usage[k]??0)+v;}if(m.model)thread.model=m.model;}
    }
    // Hook-recorded lifecycle and commands have stronger authority than a late transcript.
    if(turns.length){
      const observed=thread.turns.at(-1),last=turns.at(-1),state=(await this.store.read()).claudeHookTurns?.[thread.id];
      for(const turn of turns){if(turn===last&&turn.id===observed?.id)continue;const previous=thread.turns.find(t=>t.id===turn.id);if(previous)preserveClaudeTurn(turn,previous);}
      const sameTurn=observed?.id===last.id||state&&observed?.id===state.hookTurnId&&last.id!==state.baselineTranscriptTurnId&&(!state.linkedTranscriptTurnId||state.linkedTranscriptTurnId===last.id)||state&&observed?.id===state.linkedTranscriptTurnId&&last.id===state.linkedTranscriptTurnId;
      if(sameTurn&&observed){
        preserveClaudeTurn(last,observed,{active:Boolean(state&&state.receiptTurnId!==state.hookTurnId&&(observed.id===state.hookTurnId||observed.id===state.linkedTranscriptTurnId)),terminal:!state||state.receiptTurnId===state.hookTurnId});
        if(state&&!state.linkedTranscriptTurnId)await this.store.transaction(d=>{if(d.claudeHookTurns?.[thread.id]?.hookTurnId===state.hookTurnId)d.claudeHookTurns[thread.id].linkedTranscriptTurnId=last.id;});
      }else if(state&&observed?.id===state.hookTurnId&&last.id===state.baselineTranscriptTurnId)turns.push(observed);
      thread={...thread,turns};await this.putThread(thread);
    }
    if(thread.model)await this.setModels([{id:thread.model,model:thread.model,source:'observed-native-assistant',childModelSelectable:false}]);
    return thread;
  }
}
