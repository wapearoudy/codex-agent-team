import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { executionEnvironment } from './network.mjs';
import { DurableStore } from './durable-store.mjs';
import {resolveCodexBinary} from './codex-binary.mjs';

export class AgentRpc extends EventEmitter {
  constructor(binary,{snapshotOnly=false}={}) { super(); this.binary = binary; this.pending = new Map(); this.next = 1; this.snapshotOnly=snapshotOnly; }
  async connect() {
    if (this.child) return;
    this.binary=await resolveCodexBinary(this.binary);
    const args=['--disable','apps','--disable','plugins','--disable','multi_agent','-c','web_search="disabled"'];
    if(this.snapshotOnly)args.push('--disable','shell_tool');
    this.child = spawn(this.binary, [...args,'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe','pipe','pipe'], windowsHide: true, env: await executionEnvironment()
    });
    this.child.stderr.on('data', () => {}); // Never persist auth diagnostics or hidden reasoning.
    this.child.on('error', () => this.fail('Execution process unavailable'));
    this.child.on('exit', () => this.fail('Execution connection closed'));
    createInterface({ input: this.child.stdout }).on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.id != null && msg.method) {
        this.child.stdin.write(JSON.stringify({id:msg.id,error:{code:-32603,message:'Prototype does not grant approval or execute requested tools'}})+'\n');
        this.emit('approval-unavailable', {method:msg.method});
      } else if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(p.timer);
        msg.error ? p.reject(new Error(`RPC ${p.method} failed (${msg.error.code})`)) : p.resolve(msg.result);
      } else if (msg.method) this.emit('notification', msg);
    });
    await this.call('initialize', {clientInfo:{name:'team_workspace_probe',title:'Team Workspace Prototype',version:'0.9.3'}});
    this.child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  }
  call(method, params) {
    return new Promise((resolvePromise,reject) => {
      if (!this.child || this.child.exitCode != null) return reject(new Error('Execution process is not connected'));
      const id = this.next++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC timeout: ${method}; outcome unknown`)); }, 15000);
      this.pending.set(id,{resolve:resolvePromise,reject,timer,method});
      this.child.stdin.write(JSON.stringify({id,method,params})+'\n', err => {
        if (err) { clearTimeout(timer); this.pending.delete(id); reject(new Error('Execution transport write failed')); }
      });
    });
  }
  fail(message) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
    this.pending.clear(); this.emit('disconnected');
  }
  async close() {
    if (!this.child) return;
    const child = this.child;
    if (child.exitCode == null) {
      const stopped = new Promise(r => child.once('exit',r));
      child.stdin.end();
      await Promise.race([stopped,new Promise(r=>setTimeout(r,2500))]);
      if (child.exitCode == null) child.kill(); // Only this owned app-server process, never system-wide.
    }
  }
}

const timestamp = () => new Date().toISOString();
const terminal = status => ['completed','failed','interrupted'].includes(status);
export class PrototypeRuntime extends EventEmitter {
  constructor({binary,dataRoot,snapshotOnly=false}={}) {
    super();this.snapshotOnly=snapshotOnly;
    this.binary = binary ?? process.env.TEAM_WORKSPACE_CODEX_BINARY;
    this.root = resolve(dataRoot ?? join(homedir(),'.codex','team-workspace-probe-data'));
    this.records = new Map(); this.lock = Promise.resolve(); this.disk = Promise.resolve(); this.watchdogs = new Map();
  }
  async acquire(){if(this.releaseLease)return;this.releaseLease=await new DurableStore(join(this.root,'execution-owner'),{}).lock();this.loaded=false;this.records.clear();try{await this.load();}catch(error){await this.releaseLease();this.releaseLease=null;throw error;}}
  scope(meta) {
    const id = meta?.threadId ?? meta?.thread_id;
    if (typeof id !== 'string' || !id || (meta?.threadId && meta?.thread_id && meta.threadId !== meta.thread_id)) throw new Error('Missing or conflicting host conversation identity');
    return createHash('sha256').update(id).digest('hex');
  }
  exclusive(action) {
    const result = this.lock.then(action); this.lock = result.catch(()=>{}); return result;
  }
  async load() {
    if (this.loaded) return;
    try {
      const records = JSON.parse(await readFile(join(this.root,'runs.json'),'utf8'));
      if(!Array.isArray(records)||records.some(r=>!r||typeof r.runId!=='string'||typeof r.scope!=='string'||typeof r.status!=='string'))throw new Error('shape');
      for (const r of records) {
        r.retiredTurns??=[];
        r.connection = 'not-reconciled';
        if (!terminal(r.status)) r.status = 'unknown';
        this.records.set(r.runId,r);
      }
      this.loaded=true;
    } catch (e) { if (e.code !== 'ENOENT') {this.loaded=false;throw new Error('Saved execution records unreadable; refusing to overwrite');} this.loaded=true; }
  }
  save() {
    if(!this.releaseLease)return Promise.reject(new Error('No execution ownership; refusing concurrent write'));
    const body = JSON.stringify([...this.records.values()],null,2);
    this.disk = this.disk.catch(()=>{}).then(async()=>{
      const tmp=join(this.root,`runs-${randomUUID()}.tmp`);
      await writeFile(tmp,body); await rename(tmp,join(this.root,'runs.json'));
    });
    return this.disk;
  }
  event(r,type,details={}) {
    r.lastObservedAt=timestamp(); r.events.push({at:r.lastObservedAt,source:'app-server',type,...details});
    r.events=r.events.slice(-100); void this.save().then(()=>this.emit('observation',structuredClone(r))).catch(()=>{r.persistence='failed';});
  }
  async ensureRpc() {
    if (this.rpc) return this.rpc;
    const rpc=new AgentRpc(this.binary,{snapshotOnly:this.snapshotOnly});
    rpc.on('notification',msg=>this.onEvent(msg));
    rpc.on('disconnected',()=>{
      for(const r of this.records.values()) if(r.connection==='connected') {
        r.connection='disconnected'; if(!terminal(r.status)) r.status='unknown';
        this.event(r,'connection/lost');
      }
      this.rpc=null;
    });
    rpc.on('approval-unavailable',msg=>{
      for(const r of this.records.values()) if(r.status==='inProgress') this.event(r,'approval/unsupported',msg);
    });
    try {
      await rpc.connect();
      const auth=await rpc.call('account/read',{refreshToken:false});
      // Do not access tokens. API-key/third-party execution needs separate cost authorization.
      if(auth.account?.type!=='chatgpt') throw new Error('A managed ChatGPT account is required; API-key execution is not authorized');
      this.rpc=rpc; return rpc;
    } catch(e) { await rpc.close(); throw e; }
  }
  onEvent({method,params:p}) {
    if(!p) return;
    const r=[...this.records.values()].find(x=>x.threadId===(p.threadId??p.thread?.id));
    if(!r) return;
    const eventTurn=p.turnId??p.turn?.id;
    if(eventTurn && (r.retiredTurns??[]).includes(eventTurn)) return;
    if(eventTurn && r.turnId && eventTurn!==r.turnId) return;
    if(method==='turn/started') {
      if(r.turnId===p.turn.id && terminal(r.status)) return;
      if(r.turnId && r.turnId!==p.turn.id) return;
      r.turnId=p.turn.id; r.startedTurnId=p.turn.id; r.status=p.turn.status; this.event(r,method,{turnId:r.turnId,status:r.status});
      if(r.stopState==='requested' && !r.stopDispatched) void this.stop(r.scope,r.runId).catch(()=>{});
    } else if(method==='turn/completed') {
      if(r.turnId && r.turnId!==p.turn.id) return;
      if(r.turnId===p.turn.id && terminal(r.status)) return;
      r.turnId=p.turn.id; r.status=p.turn.status;
      r.stopState=r.status==='interrupted'?'confirmed-interrupted':r.stopState;
      clearTimeout(this.watchdogs.get(r.runId));
      this.event(r,method,{turnId:r.turnId,status:r.status,errorCode:p.turn.error?.codexErrorInfo??null});
    } else if(method==='item/completed' && p.item?.type==='commandExecution' && r.teamId) {
      r.commands??=[];if(r.commands.some(c=>c.itemId===p.item.id))return;
      r.commands.push({itemId:p.item.id,turnId:p.turnId,command:String(p.item.command??'').slice(0,3000),exitCode:p.item.exitCode??null,status:p.item.status,output:String(p.item.aggregatedOutput??'').slice(0,8000),observedAt:timestamp()});r.commands=r.commands.slice(-30);this.event(r,'command/completed',{turnId:p.turnId,itemId:p.item.id,exitCode:p.item.exitCode??null});
    } else if(method==='item/completed' && p.item?.type==='agentMessage') {
      // Public final output only. Never read reasoning items, transcripts or chain of thought.
      if(r.outputs.some(o=>o.itemId===p.item.id&&o.turnId===p.turnId))return;
      r.outputs.push({itemId:p.item.id,turnId:p.turnId,text:String(p.item.text??''),observedAt:timestamp()});
      r.outputs=r.outputs.slice(-8); this.event(r,'public-output',{turnId:p.turnId});
    }
  }
  find(scope,runId) {
    const r=this.records.get(runId);
    if(!r || r.scope!==scope) throw new Error('Run not found in this host conversation');
    return r;
  }
  public(r) {
    const {scope,...safe}=r;
    return {...safe,source:'app-server-events-and-rpc',productReady:false,
      stopLimitation:'仅确认模型轮次中断，不代表所有外部进程或副作用已终止。',
      projectScope:r.teamId?'用户选择项目的隔离工作副本；原项目写回须由用户确认':'插件自建隔离 fixture；未验证继承业务项目权限'};
  }
  async list(scope) { if(!this.releaseLease){this.loaded=false;this.records.clear();}await this.load(); return [...this.records.values()].filter(r=>r.scope===scope).map(r=>this.public(r)); }
  async start(scope) { return this.exclusive(async()=>{
    await this.acquire();
    if([...this.records.values()].some(r=>!terminal(r.status))) throw new Error('A running or unknown probe must be reconciled before another run');
    if(this.records.size>=3) throw new Error('Prototype limit reached (3 runs total); no automatic reset or retry');
    const rpc=await this.ensureRpc();
    const runId=randomUUID(); const cwd=join(this.root,'sandboxes',runId);
    await mkdir(cwd,{recursive:true});
    const fixture={numbers:[2,3,5],expectedSum:10};
    await writeFile(join(cwd,'fixture.json'),JSON.stringify(fixture,null,2));
    const r={runId,scope,cwd,threadId:null,turnId:null,status:'creating',connection:'connected',
      createdAt:timestamp(),lastObservedAt:timestamp(),turnCount:0,retiredTurns:[],stopState:'not-requested',events:[],outputs:[],model:null};
    this.records.set(runId,r); await this.save();
    try {
      const created=await rpc.call('thread/start',{
        cwd,sandbox:'read-only',approvalPolicy:'on-request',ephemeral:false,
        developerInstructions:'This is a bounded Team Workspace execution probe. Work only on the fixture supplied by this plugin. Do not use tools, browse, inspect other directories, delegate, modify files, or request elevated access. Return only public answers. Follow the latest operator instruction. Never change host configuration.',
        config:{'plugins."team-workspace-probe@fusion-local".enabled':false}
      });
      r.threadId=created.thread.id;r.model=created.model??null;
      this.event(r,'thread/created',{threadId:r.threadId});
      await this.turn(r,`Verify this isolated fixture, read by the plugin from fixture.json: ${JSON.stringify(fixture)}. Check the sum yourself and reply with PROBE_SUM=<sum>. No tools.`);
      return this.public(r);
    } catch(e) {r.status='unknown';this.event(r,'start/error',{message:e.message});throw e;}
  }); }
  async startMember({scope,teamId,taskId,attemptId,memberId,cwd,sandbox,developerInstructions,prompt,timeoutSeconds=1800}) {return this.exclusive(async()=>{
    await this.acquire();
    if([...this.records.values()].some(r=>r.scope===scope&&r.teamId===teamId&&r.taskId===taskId&&!terminal(r.status)))throw new Error('This task attempt already has a running or unknown agent');
    let rpc;try{rpc=await this.ensureRpc();}catch(error){error.executionStarted=false;throw error;}const runId=randomUUID(),r={runId,scope,teamId,taskId,attemptId,memberId,cwd,timeoutSeconds,threadId:null,turnId:null,startedTurnId:null,status:'creating',connection:'connected',createdAt:timestamp(),lastObservedAt:timestamp(),turnCount:0,retiredTurns:[],stopState:'not-requested',events:[],outputs:[],model:null};
    this.records.set(runId,r);await this.save();
    try{
      const created=await rpc.call('thread/start',{cwd,sandbox,approvalPolicy:'on-request',ephemeral:false,developerInstructions});
      r.threadId=created.thread.id;r.model=created.model??null;this.event(r,'thread/created',{threadId:r.threadId});
      await this.turn(r,prompt);return this.public(r);
    }catch(e){r.status='unknown';this.event(r,'start/error',{message:e.message});throw e;}
  });}
  async turn(r,text) {
    const maxTurns=r.teamId?8:3;
    if(r.turnCount>=maxTurns) throw new Error(`Execution turn limit reached (${maxTurns} turns per agent)`);
    const rpc=await this.ensureRpc();
    if(r.turnId)r.retiredTurns.push(r.turnId);
    r.turnId=null;r.startedTurnId=null;r.stopDispatched=false;r.turnCount++;r.stopState='not-requested';r.status='starting';await this.save();
    this.watchdogs.set(r.runId,setTimeout(()=>{
      r.stopReason='time-budget-exhausted';this.event(r,'budget/time-exhausted',{timeoutSeconds:r.timeoutSeconds??60});void this.stop(r.scope,r.runId).catch(error=>{this.event(r,'budget/stop-unconfirmed',{message:error.message});});
    },r.teamId?(r.timeoutSeconds??1800)*1000:60000));
    let result;
    try {result=await rpc.call('turn/start',{threadId:r.threadId,input:[{type:'text',text}]});}
    catch(e){r.status='unknown';this.event(r,'turn/start-unconfirmed');throw e;}
    // Completion may arrive before the RPC response; never overwrite a newer terminal event.
    if(!r.turnId) {r.turnId=result.turn.id;r.status=result.turn.status;}
    this.event(r,'turn/start-ack',{turnId:r.turnId,status:result.turn.status});
    if(terminal(r.status))clearTimeout(this.watchdogs.get(r.runId));
  }
  async message(scope,runId) { return this.exclusive(async()=>{
    await this.load();const r=this.find(scope,runId);
    if(r.connection!=='connected') throw new Error('Execution connection must be reconciled; no automatic resume');
    const nonce=randomUUID(); const text=`Operator supervision probe: reply exactly PROBE_ACK=${nonce}. No tools, no further work.`;
    const rpc=await this.ensureRpc();
    if(r.status==='inProgress') {
      await rpc.call('turn/steer',{threadId:r.threadId,expectedTurnId:r.turnId,input:[{type:'text',text}]});
      this.event(r,'turn/steer-ack',{turnId:r.turnId,nonce});
    } else if(terminal(r.status)) {await this.turn(r,text);this.event(r,'operator/followup',{turnId:r.turnId,nonce});}
    else throw new Error('Run is not ready for a supervision message');
    r.messageNonce=nonce;await this.save();return this.public(r);
  }); }
  async stopTrial(scope,runId) { return this.exclusive(async()=>{
    await this.load();const r=this.find(scope,runId);
    if(!terminal(r.status) || r.connection!=='connected') throw new Error('Complete and reconcile the current turn first');
    await this.turn(r,'Bounded cancellation test: write a numbered list from 1 to 300, each with its square and one short sentence explaining it. No tools. Stop immediately if interrupted. This deliberately gives the operator time to test interruption.');
    return this.public(r);
  }); }
  async sendMemberMessage(scope,runId,text){return this.exclusive(async()=>{
    await this.load();const r=this.find(scope,runId);
    if(typeof text!=='string'||!text.trim()||text.length>3000)throw new Error('A bounded operator message is required');
    if(!r.teamId||r.status!=='inProgress'||r.connection!=='connected'||!this.rpc)throw new Error('Member is not running on this connection; do not silently start a new attempt');
    const message={id:randomUUID(),attemptId:r.attemptId,threadId:r.threadId,turnId:r.turnId,text,createdAt:timestamp(),delivery:'pending',consumption:'unknown'};
    r.messages??=[];r.messages.push(message);await this.save();
    try{
      await this.rpc.call('turn/steer',{threadId:r.threadId,expectedTurnId:r.turnId,input:[{type:'text',text}]});
      message.delivery='accepted-by-runtime';message.acknowledgedAt=timestamp();
      this.event(r,'operator/message-ack',{messageId:message.id,turnId:r.turnId});
    }catch(error){
      message.delivery='unconfirmed';message.error=error.message;
      this.event(r,'operator/message-unconfirmed',{messageId:message.id,turnId:r.turnId});
      await this.save();throw error;
    }
    await this.save();return this.public(r);
  });}
  async reconcile(scope){return this.exclusive(async()=>{
    await this.acquire();const rpc=await this.ensureRpc();
    for(const r of this.records.values())if(r.scope===scope&&r.threadId){
      try{
        const response=await rpc.call('thread/read',{threadId:r.threadId,includeTurns:true});
        const turn=response.thread?.turns?.find(t=>t.id===r.turnId);
        if(!turn||!terminal(turn.status)){r.status='unknown';r.connection='not-reconciled';this.event(r,'reconcile/active-or-unavailable');continue;}
        // Only public messages and command results are inspected. Reasoning items are ignored.
        for(const item of turn.items??[])if(['agentMessage','commandExecution'].includes(item.type))this.onEvent({method:'item/completed',params:{threadId:r.threadId,turnId:turn.id,item}});
        r.status=turn.status;r.connection='reconciled-terminal';if(turn.status==='interrupted')r.stopState='confirmed-interrupted';this.event(r,'reconcile/terminal',{status:turn.status,turnId:turn.id});
      }catch(error){r.status='unknown';r.connection='not-reconciled';this.event(r,'reconcile/unavailable',{message:error.message});}
    }await this.save();return[...this.records.values()].filter(r=>r.scope===scope).map(r=>this.public(r));
  });}
  async stop(scope,runId) { return this.exclusive(async()=>{
    await this.load();const r=this.find(scope,runId);
    if(terminal(r.status)) return this.public(r);
    if(!this.rpc || r.connection!=='connected' || !r.turnId) throw new Error('Execution state unknown; cannot confirm a stop');
    if(r.stopState==='requested' && r.stopDispatched) return this.public(r);
    if(r.stopState!=='requested') {r.stopState='requested';this.event(r,'stop/requested',{turnId:r.turnId});}
    // turn/start can acknowledge before the engine registers an active turn.
    if(r.startedTurnId!==r.turnId) {this.event(r,'stop/queued-until-started',{turnId:r.turnId});return this.public(r);}
    r.stopDispatched=true;
    try {await this.rpc.call('turn/interrupt',{threadId:r.threadId,turnId:r.turnId});
      this.event(r,'turn/interrupt-ack',{turnId:r.turnId});
    } catch(e) {if(r.stopState!=='confirmed-interrupted')r.stopState='unknown';this.event(r,'stop/unconfirmed');throw e;}
    // Only turn/completed(status=interrupted) can change stopState to confirmed.
    return this.public(r);
  }); }
  async close() {
    for(const t of this.watchdogs.values())clearTimeout(t);
    for(const r of this.records.values()) if(!terminal(r.status)) await this.stop(r.scope,r.runId).catch(()=>{});
    try{await this.rpc?.close();await this.disk;}finally{await this.releaseLease?.();this.releaseLease=null;}
  }
}
