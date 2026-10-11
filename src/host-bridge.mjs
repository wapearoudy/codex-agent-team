import {join,isAbsolute,basename,dirname,relative} from 'node:path';
import {homedir} from 'node:os';
import {mkdir,realpath,readFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {DurableStore} from './durable-store.mjs';
import {sanitizeThread,textBlocks,normalizeUsage} from './host-normalize.mjs';
const hosts=new Set(['deepseek-harness','claude-code','opencode']);
const hash=value=>createHash('sha256').update(value).digest('hex');
export class HostBridge{
  constructor({host,root=process.env.TEAM_WORKSPACE_BRIDGE_ROOT??join(homedir(),'.agent-team','bridge',host),ticketTtlMs=30000,now=Date.now}={}){
    if(!hosts.has(host))throw new Error('Unsupported native host');this.host=host;this.root=root;this.file=join(root,'registry.json');this.now=now;this.ticketTtlMs=ticketTtlMs;
    this.store=new DurableStore(this.file,{version:1,host,threads:{},models:[],tickets:{},transcripts:{}},d=>{if(d.version!==1||d.host!==host||!d.threads||!d.tickets)throw new Error('Bridge registry identity mismatch');});
  }
  async ensure(){await mkdir(this.root,{recursive:true});}
  async putThread(thread){const clean=sanitizeThread(thread);if(!isAbsolute(clean.cwd))throw new Error('Native cwd must be absolute');clean.cwd=await realpath(clean.cwd);const before=await this.store.read();if(JSON.stringify(before.threads[clean.id])===JSON.stringify(clean))return clean;await this.store.transaction(d=>{const old=d.threads[clean.id];if(old&&(old.cwd!==clean.cwd||old.parentThreadId!==clean.parentThreadId))throw new Error('Native session identity cannot be changed');d.threads[clean.id]=clean;});return clean;}
  async readThread(id){const d=await this.store.read(),thread=Object.hasOwn(d.threads,id)?d.threads[id]:null;if(!thread){const error=new Error('Native session is unavailable');error.code='HOST_SESSION_UNAVAILABLE';throw error;}if(this.host==='claude-code'&&d.transcripts[id])return this.refreshClaude(thread,d.transcripts[id]);return structuredClone(thread);}
  async setModels(rows){const clean=[];for(const r of rows??[]){const model=r.model??r.id;if(typeof model!=='string'||!model)continue;clean.push({id:r.id??model,model,...(r.provider?{provider:r.provider}:{}),...(r.displayName?{displayName:r.displayName}:{}),source:r.source??'observed-host-model',childModelSelectable:r.childModelSelectable===true,...(Array.isArray(r.supportedReasoningEfforts)?{supportedReasoningEfforts:r.supportedReasoningEfforts.filter(v=>typeof v==='string')}:{} )});}if(JSON.stringify((await this.store.read()).models)===JSON.stringify(clean))return;await this.store.transaction(d=>{d.models=clean;});}
  async readModels(){return (await this.store.read()).models;}
  async issueContext(threadId,toolName){if(typeof toolName!=='string'||!toolName)throw new Error('Exact tool is required');const ticket=randomBytes(32).toString('base64url');await this.store.transaction(d=>{if(!Object.hasOwn(d.threads,threadId))throw new Error('Native session is unavailable');for(const[k,t]of Object.entries(d.tickets))if(t.expires<=this.now())delete d.tickets[k];d.tickets[hash(ticket)]={threadId,toolName,expires:this.now()+this.ticketTtlMs};});return ticket;}
  async authenticate(ticket,toolName){if(typeof ticket!=='string'||!ticket)throw new Error('Native host context ticket is required');return this.store.transaction(d=>{const key=hash(ticket),t=d.tickets[key];if(!t||t.expires<=this.now()||t.toolName!==toolName||!Object.hasOwn(d.threads,t.threadId))throw new Error('Native context ticket expired, replayed or mismatched');delete d.tickets[key];return {threadId:t.threadId};});}
  async registerClaudeTranscript(id,path){if(this.host!=='claude-code')throw new Error('Transcript refresh is Claude-only');let p;try{p=await realpath(path);}catch(e){if(e.code!=='ENOENT'||!isAbsolute(path))throw e;p=join(await realpath(dirname(path)),basename(path));}const d=await this.store.read();if(!Object.hasOwn(d.threads,id))throw new Error('Register native identity first');const expected=join(process.env.CLAUDE_CONFIG_DIR??join(homedir(),'.claude'),'projects'),base=await realpath(expected);if(relative(base,p).startsWith('..')||isAbsolute(relative(base,p)))throw new Error('Transcript is outside Claude project storage');if(![`${id}.jsonl`,`agent-${id}.jsonl`].includes(basename(p)))throw new Error('Transcript native identity mismatch');if(d.transcripts[id]?.path===p)return;await this.store.transaction(s=>{s.transcripts[id]={path:p};});}
  async refreshClaude(thread,record){
    let body;try{if(await realpath(record.path)!==record.path)throw new Error('Claude registered transcript path changed');body=await readFile(record.path,'utf8');}catch(e){if(e.code==='ENOENT')return thread;throw e;}
    const rows=[];for(const line of body.split('\n')){if(!line.trim())continue;try{rows.push(JSON.parse(line));}catch{/* asynchronously appended tail */}}
    const turns=[];let current;
    for(const r of rows){if(r.agentId&&r.agentId!==thread.id)continue;if(r.sessionId&&r.sessionId!==thread.id&&r.sessionId!==thread.parentThreadId)continue;if(r.cwd&&await realpath(r.cwd)!==thread.cwd)throw new Error('Claude transcript project mismatch');const m=r.message;
      if(r.type==='user'&&m?.role==='user'&&(typeof m.content==='string'||m.content?.some(b=>b.type==='text'))){current={id:r.uuid,status:'unknown',items:[{type:'userMessage',content:m.content}]};turns.push(current);}
      if(r.type==='assistant'&&m){current??={id:r.uuid,status:'unknown',items:[]};if(!turns.includes(current))turns.push(current);current.items.push({type:'agentMessage',id:r.uuid,text:textBlocks(m.content),phase:m.stop_reason==='end_turn'?'final_answer':'commentary'});if(m.usage){current.usage??={};for(const[k,v]of Object.entries(normalizeUsage(m.usage)??{}))current.usage[k]=(current.usage[k]??0)+v;}if(m.model)thread.model=m.model;}
    }
    // Hook-recorded lifecycle and commands have stronger authority than a late transcript.
    if(turns.length){
      const observed=thread.turns.at(-1),last=turns.at(-1),state=(await this.store.read()).claudeHookTurns?.[thread.id];
      const sameTurn=observed?.id===last.id||state&&observed?.id===state.hookTurnId&&last.id!==state.baselineTranscriptTurnId&&(!state.linkedTranscriptTurnId||state.linkedTranscriptTurnId===last.id)||state&&observed?.id===state.linkedTranscriptTurnId&&last.id===state.linkedTranscriptTurnId;
      if(sameTurn&&observed){
        last.items.push(...observed.items.filter(i=>i.type==='commandExecution'));if(observed.statusEvidence?.source==='native-task-receipt'&&(!state||state.receiptTurnId===state.hookTurnId)){last.status=observed.status;last.statusEvidence=observed.statusEvidence;}
        const ids=new Set(last.items.filter(i=>i.type==='agentMessage').map(i=>i.text));last.items.push(...observed.items.filter(i=>i.type==='agentMessage'&&i.phase==='final_answer'&&!ids.has(i.text)));
        if(state&&!state.linkedTranscriptTurnId)await this.store.transaction(d=>{if(d.claudeHookTurns?.[thread.id]?.hookTurnId===state.hookTurnId)d.claudeHookTurns[thread.id].linkedTranscriptTurnId=last.id;});
      }else if(state&&observed?.id===state.hookTurnId&&last.id===state.baselineTranscriptTurnId)turns.push(observed);
      thread={...thread,turns};await this.putThread(thread);
    }
    if(thread.model)await this.setModels([{id:thread.model,model:thread.model,source:'observed-native-assistant',childModelSelectable:false}]);
    return thread;
  }
}
