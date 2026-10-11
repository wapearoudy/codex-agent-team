// Host-owned data only. Model arguments must never enter these normalizers.
export const publicText=value=>typeof value==='string'?value.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi,'Bearer [redacted]').replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]&]+)/gi,(_match,prefix,credential)=>prefix+(credential.startsWith('"')?'"[redacted]"':credential.startsWith("'")?"'[redacted]'":prefix.startsWith('"')?'"[redacted]"':'[redacted]')):'';
export const textBlocks=blocks=>typeof blocks==='string'?publicText(blocks):(blocks??[]).filter(b=>b.type==='text'&&typeof b.text==='string').map(b=>publicText(b.text)).join('\n');
export function normalizeUsage(value){
  if(!value)return undefined;
  const out={};
  for(const [key,aliases] of Object.entries({inputTokens:['inputTokens','input_tokens','input'],outputTokens:['outputTokens','output_tokens','output'],cachedInputTokens:['cachedInputTokens','cache_read_input_tokens','cacheRead','cacheReadTokens'],totalTokens:['totalTokens','total_tokens']})){
    const v=aliases.map(k=>value[k]).find(n=>Number.isFinite(n)&&n>=0);if(v!==undefined)out[key]=v;
  }
  if(Number.isFinite(value.cache?.read)&&value.cache.read>=0)out.cachedInputTokens=value.cache.read;
  if(out.totalTokens===undefined&&out.inputTokens!==undefined&&out.outputTokens!==undefined)out.totalTokens=out.inputTokens+out.outputTokens;
  return Object.keys(out).length?out:undefined;
}
export function sanitizeThread(thread){
  if(!thread||typeof thread.id!=='string'||!thread.id||['__proto__','constructor','prototype'].includes(thread.id)||typeof thread.cwd!=='string')throw new Error('Native session identity and cwd are required');
  const out={id:thread.id,cwd:thread.cwd,parentThreadId:thread.parentThreadId??null,turns:[]};
  for(const key of ['model','modelProvider','reasoningEffort','createdAt'])if(thread[key]!==undefined)out[key]=thread[key];
  if(Array.isArray(thread.nativeTools))out.nativeTools=thread.nativeTools.filter(t=>typeof t.name==='string').map(t=>({name:t.name,description:publicText(t.description).slice(0,8000),parameters:structuredClone(t.parameters??{})}));
  if(Array.isArray(thread.nativeMembers)){out.nativeMembers=thread.nativeMembers.filter(m=>typeof m.id==='string'&&m.id&&typeof m.target==='string'&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(m.target)).map(m=>({id:m.id,target:m.target}));if(new Set(out.nativeMembers.map(m=>m.id)).size!==out.nativeMembers.length||new Set(out.nativeMembers.map(m=>m.target)).size!==out.nativeMembers.length)throw new Error('Ambiguous native teammate roster');}
  for(const t of thread.turns??[]){
    if(typeof t.id!=='string')throw new Error('Native turn identity is required');
    const turn={id:t.id,status:['inProgress','completed','failed','interrupted','unknown'].includes(t.status)?t.status:'unknown',items:[]};
    if(turn.status==='interrupted'&&!['persisted-turn-aborted','persisted-native-task-stop'].includes(t.statusEvidence?.source))turn.status='unknown';
    if(t.statusEvidence)turn.statusEvidence={status:turn.status,source:t.statusEvidence.source};
    if(t.usage)turn.usage=normalizeUsage(t.usage);
    for(const i of t.items??[]){
      if(i.type==='agentMessage')turn.items.push({type:i.type,...(i.id?{id:i.id}:{}),text:publicText(i.text),phase:i.phase==='final_answer'?'final_answer':'commentary'});
      if(i.type==='userMessage')turn.items.push({type:i.type,...(i.id?{id:i.id}:{}),content:[{type:'text',text:textBlocks(i.content)}]});
      if(i.type==='subAgentActivity'&&i.agentThreadId)turn.items.push({type:i.type,agentThreadId:i.agentThreadId});
      if(i.type==='commandExecution')turn.items.push({type:i.type,commandId:i.commandId,cwd:i.cwd??thread.cwd,command:publicText(i.command),exitCode:Number.isInteger(i.exitCode)?i.exitCode:null,status:i.status??'unknown',aggregatedOutput:publicText(i.aggregatedOutput)});
    }
    // Only the observer's public activity vocabulary; never opaque host events.
    turn.activity=(t.activity??[]).filter(e=>['message','command','usage'].includes(e.type)).map(e=>({type:e.type,...(e.text?{text:publicText(e.text)}:{}),...(e.at?{at:e.at}:{})}));
    out.turns.push(turn);
  }
  return out;
}
export function normalizeDshSession(session,events){
  const h=session.header,route=session.requestContext?.()??{},config=session.requestHeader?.()?.config??{};
  const thread={id:session.id,cwd:h.cwd,parentThreadId:h.parentSession??null,createdAt:new Date(h.createdAt).toISOString(),model:route.model??config.model,modelProvider:route.provider??config.provider,reasoningEffort:config.reasoningEffort,nativeTools:session.requestHeader?.()?.tools??[],turns:[]};
  const turns=new Map(),calls=new Map();
  const turn=n=>{const id=String(n);if(!turns.has(id)){const t={id,status:'unknown',items:[]};turns.set(id,t);thread.turns.push(t);}return turns.get(id);};
  for(const e of events??[]){
    if(!session.isOwnSeq?.(e.seq)&&e.seq<session.inheritedEventCount)continue;
    const d=e.data??{};
    if(e.type==='turn/start')turn(d.turn).status='inProgress';
    if(e.type==='turn/end'){
      const t=turn(d.turn),kind=d.reason?.kind;t.status=kind==='completed'?'completed':kind==='aborted'?'interrupted':kind==='error'?'failed':'unknown';
      t.statusEvidence={status:t.status,source:kind==='aborted'?'persisted-turn-aborted':'native-turn-end'};
      if(t.status==='completed'){const last=t.items.findLast(i=>i.type==='agentMessage');if(last)last.phase='final_answer';}
    }
    if(e.type==='user/message'){const active=thread.turns.at(-1);if(active)active.items.push({type:'userMessage',id:d.id,content:d.content});}
    if(e.type==='assistant/message'){const t=turn(d.turn);t.items.push({type:'agentMessage',id:d.message?.id,text:textBlocks(d.message?.content),phase:'commentary'});if(d.usage){const u=normalizeUsage(d.usage);t.usage??={};for(const [k,v]of Object.entries(u??{}))t.usage[k]=(t.usage[k]??0)+v;}}
    if(e.type==='tool/call'&&['bash','pwsh','run_command'].includes(d.name)){let args;try{args=JSON.parse(d.arguments);}catch{continue;}const item={type:'commandExecution',commandId:d.callId,cwd:h.cwd,command:args.command??args.cmd??'',status:'inProgress',aggregatedOutput:''};turn(d.turn).items.push(item);calls.set(d.callId,item);}
    if(e.type==='tool/result'){const item=calls.get(d.message?.source?.callId);if(item){item.status=d.message.isError?'failed':'completed';item.aggregatedOutput=textBlocks(d.message.content);item.exitCode=d.meta?.exitCode??d.meta?.exit_code??null;}}
  }
  return sanitizeThread(thread);
}
export function normalizeOpenCodeSession(info,messages,status){
  const thread={id:info.id,cwd:info.directory,parentThreadId:info.parentID??null,createdAt:new Date(info.time.created).toISOString(),turns:[]};let current;const byUser=new Map();
  for(const row of messages??[]){const m=row.info??{},parts=row.parts??[];
    if(m.role==='user'){current={id:m.id,status:'unknown',items:[{type:'userMessage',id:m.id,content:textBlocks(parts)}]};thread.turns.push(current);byUser.set(m.id,current);if(m.model){thread.model=m.model.modelID;thread.modelProvider=m.model.providerID;}}
    if(m.role!=='assistant')continue;
    current=byUser.get(m.parentID);if(!current){current={id:m.parentID??m.id,status:'unknown',items:[]};byUser.set(current.id,current);thread.turns.push(current);}
    // A subsequent assistant step invalidates the preceding step's terminal
    // status. Native busy/retry state always wins over a historical finish.
    current.status='unknown';delete current.statusEvidence;
    thread.model=m.modelID??thread.model;thread.modelProvider=m.providerID??thread.modelProvider;
    const text=textBlocks(parts);if(text)current.items.push({type:'agentMessage',id:m.id,text,phase:m.finish&&m.finish!=='tool-calls'?'final_answer':'commentary'});
    if(m.tokens){current.usage??={};for(const[k,v]of Object.entries(normalizeUsage(m.tokens)??{}))current.usage[k]=(current.usage[k]??0)+v;}
    for(const p of parts)if(p.type==='tool'&&p.tool==='bash'){const s=p.state??{};current.items.push({type:'commandExecution',commandId:p.callID,cwd:info.directory,command:s.input?.command??'',status:s.status==='completed'?'completed':s.status==='error'?'failed':'inProgress',exitCode:s.metadata?.exit??null,aggregatedOutput:s.output??s.error??''});}
    if(m.error){current.status=m.error.name==='MessageAbortedError'?'interrupted':'failed';current.statusEvidence={status:current.status,source:current.status==='interrupted'?'persisted-turn-aborted':'native-message-error'};if(current.status==='failed'){const message=m.error.data?.message??m.error.message??m.error.name;current.items.push({type:'agentMessage',id:m.id,text:publicText(String(message)).slice(0,4000),phase:'final_answer'});}}
    else if(m.time?.completed&&m.finish&&m.finish!=='tool-calls'){current.status='completed';current.statusEvidence={status:'completed',source:'native-message-completed'};}
  }
  const last=thread.turns.at(-1);if(last&&['busy','retry'].includes(status?.type)){last.status='inProgress';delete last.statusEvidence;}
  return sanitizeThread(thread);
}
