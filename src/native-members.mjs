import {realpath} from 'node:fs/promises';
import {watch} from 'node:fs';
import {dirname,basename,relative,isAbsolute,join} from 'node:path';
import {homedir} from 'node:os';
import {AgentRpc} from './runtime.mjs';
import {persistedActivity} from './native-lifecycle.mjs';
import {NativePublicFeed} from './native-public.mjs';
import {sumTurnUsage} from './turn-association.mjs';
import {observeTeamUsage,usageKey} from './native-usage.mjs';
import {parseStructuredReport} from './report-format.mjs';
import {nativeIdentityCandidates} from './native-identity-index.mjs';
import {assertNativeLaunch,isBootstrapPrelude,isPendingBootstrapPrelude,failedBootstrapCall,isBootstrapTool,isBootstrapDiscovery,isPendingBootstrapDiscovery,hasStartupDelivery} from './native-launch.mjs';
import {nativeLaunchIntent} from './native-launch-intent.mjs';
const confirmedInterrupted=e=>e?.status==='interrupted'&&['persisted-turn-aborted','persisted-native-task-stop'].includes(e.source);

// Observation only. Never start/resume/fork a model session in the plugin.
export class NativeMembers {
  constructor({rpcFactory,lifecycleReader=persistedActivity,publicFeed=new NativePublicFeed(),identityLookup=nativeIdentityCandidates}={}){this.rpcFactory=rpcFactory??(()=>new AgentRpc(process.env.TEAM_WORKSPACE_CODEX_BINARY,{snapshotOnly:true}));this.lifecycleReader=lifecycleReader;this.publicFeed=publicFeed;this.identityLookup=identityLookup;this.inflight=new Map();this.usageCache=new Map();this.usageSequence=0;}
  async connect(){if(!this.ready){this.rpc=this.rpcFactory();this.rpc.on?.('disconnected',()=>{this.ready=null;});this.ready=this.rpc.connect().catch(async error=>{await this.rpc.close();this.ready=null;throw error;});}await this.ready;return this.rpc;}
  async close(){await this.rpc?.close();this.ready=null;}
  get supportsTeamUsage(){return typeof this.publicFeed.usageWindow==='function';}
  cachedTeamUsage(team){return this.usageCache.get(usageKey(team))?.data??null;}
  async teamUsage(team,{fresh=false}={}){
    const key=usageKey(team),cached=this.usageCache.get(key);
    if(!fresh&&cached&&Date.now()-cached.at<10000)return cached.data;
    // Only simultaneous exact requests share work; dispatch always verifies a
    // fresh accounting window and never relies on a timed display cache.
    const inflightKey='usage:'+key+':'+(fresh?'fresh':'display');if(this.inflight.has(inflightKey))return this.inflight.get(inflightKey);
    const sequence=++this.usageSequence;
    const pending=observeTeamUsage(this,team).then(data=>{if(sequence>=(this.usageCache.get(key)?.sequence??0))this.usageCache.set(key,{at:Date.now(),sequence,data});if(this.usageCache.size>20)this.usageCache.delete(this.usageCache.keys().next().value);return data;}).finally(()=>this.inflight.delete(inflightKey));
    this.inflight.set(inflightKey,pending);return pending;
  }
  async historicalUsage(leaderThreadId,cwd,threadId,turnIds){
    const rpc=await this.connect(),{thread}=await rpc.call('thread/read',{threadId,includeTurns:false});
    const parent=thread?.parentThreadId??thread?.source?.subAgent?.thread_spawn?.parent_thread_id;
    if(thread.id!==threadId||(threadId!==leaderThreadId&&parent!==leaderThreadId)||await realpath(thread.cwd)!==await realpath(cwd))throw new Error('Historical usage identity mismatch');
    return Promise.all(turnIds.map(async turnId=>({turnId,usage:(await this.publicFeed.read(thread,turnId)).usage})));
  }
  async inspectIdle(leaderThreadId,cwd,threadId){return this.inspect(leaderThreadId,cwd,threadId,null,{requireIdle:true});}
  async inspectLeader(leaderThreadId,cwd,boundTurnId,{allowStopped=false,allowHistoricalStop=false,allowHistoricalResume=false}={}){
    const rpc=await this.connect(),{thread}=await rpc.call('thread/read',{threadId:leaderThreadId,includeTurns:true});
    if(thread?.id!==leaderThreadId||await realpath(thread.cwd)!==await realpath(cwd))throw new Error('Leader execution identity mismatch');
    const latest=thread.turns?.at(-1),historical=!!boundTurnId&&latest?.id!==boundTurnId;
    // A new controller turn may explicitly stop an abandoned old binding.
    // This reads the exact terminal old turn only for cooperative task stop;
    // it does not bind, resume, submit, accept or fabricate current activity.
    const turn=historical&&(allowStopped&&allowHistoricalStop||allowHistoricalResume)?thread.turns?.find(t=>t.id===boundTurnId):latest;
    if(!turn?.id||boundTurnId&&turn.id!==boundTurnId)throw Object.assign(new Error('Leader execution must remain in its exact bound native turn'),{code:'LEADER_TURN_CHANGED'});
    const evidence=turn.status==='interrupted'?await this.lifecycleReader(thread,turn.id):null,status=evidence?.status??turn.status;
    if(!['inProgress','completed'].includes(status)&&!((allowStopped||allowHistoricalResume)&&(status==='failed'||confirmedInterrupted(evidence)))){
      const error=new Error('Leader execution is interrupted or unknown; preserve the original checkpoint');
      // A long native wait may outlast the public activity window before its
      // own completion is persisted. Return the reserved work intact; a NEW
      // authenticated tool request can verify fresh activity. Never renew the
      // timestamp here or treat a genuinely unknown/aborted turn as active.
      if(status==='unknown'&&evidence?.source==='persisted-native-activity-stale')error.code='LEADER_ACTIVITY_STALE';
      throw error;
    }
    const commands=(turn.items??[]).filter(i=>i.type==='commandExecution').map(i=>({turnId:turn.id,commandId:i.id,cwd:i.cwd,command:i.command,exitCode:i.exitCode,status:i.status,output:typeof i.aggregatedOutput==='string'?i.aggregatedOutput.slice(-16000):''}));
    if(historical&&(!['completed','failed','interrupted'].includes(status)||status==='interrupted'&&!confirmedInterrupted(evidence)||[...commands,...(latest.items??[]).filter(i=>i.type==='commandExecution')].some(c=>!['completed','failed'].includes(c.status)||!Number.isInteger(c.exitCode))))throw new Error('Historical Leader stop requires exact terminal evidence and no pending native commands');
    return {threadId:leaderThreadId,turnId:turn.id,latestTurnId:latest.id,status,statusEvidence:evidence,commands,outputs:[],source:'native-leader-checkpoint',connection:'snapshot',...(historical?{...(allowHistoricalResume?{historicalResumeOnly:true}:{historicalStopOnly:true}),latestNativeStatus:latest.status}:{}),observedAt:new Date().toISOString(),model:thread.model??null,provider:thread.modelProvider??null,reasoningEffort:thread.reasoningEffort??null};
  }
  async inspectHistoricalLeader(leaderThreadId,cwd,turnId){return this.inspectLeader(leaderThreadId,cwd,turnId,{allowHistoricalResume:true});}
  async inspectStartup(team,task){
    const a=task.attempts.at(-1),member=team.members.find(m=>m.id===task.memberId);
    if(a?.state!=='reserved'||a.agentThreadId||!a.bootstrap)throw new Error('Only an unbound current startup can be observed');
    let path=member?.agentPath??a.bootstrap.agentPath;
    if(!path){const rpc=await this.connect(),{thread}=await rpc.call('thread/read',{threadId:team.leaderThreadId,includeTurns:false});path=(thread.source?.subAgent?.thread_spawn?.agent_path??'/root')+'/'+a.bootstrap.taskName;}
    try{
      const run=await this.inspect(team.leaderThreadId,team.projectPath,path,a.marker,{allowPending:true,startupOnly:true});
      return {...run,startupOnly:true,executionAuthority:false};
    }catch(error){
      if(member?.agentThreadId||a.bootstrap.agentPath)throw error; // Legacy warm-member followups are not new spawns.
      const index=await this.identityLookup({leaderThreadId:team.leaderThreadId,cwd:team.projectPath,agentPath:path});
      if(!index.complete||index.ids.length)throw error;
      const {thread}=await(await this.connect()).call('thread/read',{threadId:team.leaderThreadId,includeTurns:false});
      if(thread?.id!==team.leaderThreadId||await realpath(thread.cwd)!==await realpath(team.projectPath))throw error;
      const launchIntent=await nativeLaunchIntent(thread,{sessionsRoot:this.publicFeed.sessionsRoot,taskName:a.bootstrap.taskName,since:a.startedAt});
      const checked=await this.identityLookup({leaderThreadId:team.leaderThreadId,cwd:team.projectPath,agentPath:path});
      if(!launchIntent.verified||!checked.complete||checked.ids.length)throw error;
      if(launchIntent.launchCallObserved){
        if(launchIntent.calls.length!==1||!launchIntent.calls[0].callId||!Number.isFinite(Date.parse(launchIntent.calls[0].at)))throw error;
        return {status:'starting',startupOnly:true,executionAuthority:false,launchIntent,noIndexedChild:true,agentPath:path,parentThreadId:team.leaderThreadId,source:'native-observed-launch',observedAt:new Date().toISOString(),startupReason:'Original native spawn was observed; child metadata is still being indexed. Preserve this exact reservation, never resend or infer authority'};
      }
      return {status:'not-started',startupOnly:true,executionAuthority:false,launchIntent,agentPath:path,source:'native-unissued-launch',observedAt:new Date().toISOString()};
    }
  }
  inspect(leaderThreadId,cwd,threadId,marker,options={}){
    const key=JSON.stringify([leaderThreadId,cwd,threadId,marker,options]);
    if(this.inflight.has(key))return this.inflight.get(key);
    const pending=this.inspectOnce(leaderThreadId,cwd,threadId,marker,options).finally(()=>{if(this.inflight.get(key)===pending)this.inflight.delete(key);});
    this.inflight.set(key,pending);return pending;
  }
  async subscribe(team,onChange){
    const rpc=await this.connect(),root=await realpath(this.publicFeed.sessionsRoot??join(process.env.CODEX_HOME??join(homedir(),'.codex'),'sessions')),watchers=[];
    try{for(const task of team.tasks.filter(t=>t.status==='running'&&t.executionMode!=='leader')){
      const attempt=task.attempts.at(-1);let threadId=attempt?.agentThreadId;
      if(!threadId&&attempt?.state==='reserved'&&attempt.bootstrap){try{threadId=(await this.inspectStartup(team,task)).threadId;}catch{continue;}}
      if(!threadId)continue;
      const {thread}=await rpc.call('thread/read',{threadId,includeTurns:false}),parent=thread?.parentThreadId??thread?.source?.subAgent?.thread_spawn?.parent_thread_id;
      if(thread?.id!==threadId||parent!==team.leaderThreadId||await realpath(thread.cwd)!==await realpath(team.projectPath))throw new Error('Native event subscription identity mismatch');
      if(!thread.path)continue;const path=await realpath(thread.path),rel=relative(root,path);if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('../')||rel.startsWith('..\\'))throw new Error('Native event subscription is outside the host session directory');
      await this.publicFeed.read(thread,attempt.turnId??'pending-verified-child');
      const name=basename(path),watcher=watch(dirname(path),(_,file)=>{if(!file||String(file)===name)onChange();});watcher.on('error',onChange);watchers.push(watcher);
    }}catch(error){for(const watcher of watchers)watcher.close();throw error;}
    return ()=>{for(const watcher of watchers)watcher.close();};
  }
  async inspectOnce(leaderThreadId,cwd,threadId,marker,{allowPending=false,requireIdle=false,requireFresh=false,boundTurnId=null,registration=null,startupOnly=false,launchMember=null,authenticatedSelfBootstrap=false,beforeFirstBootstrap=false,bootstrapTurnId=null}={}){
    const rpc=await this.connect();
      let agentPath=null;
      if(threadId.startsWith('/')){
        agentPath=threadId;
        const {thread:leader}=await rpc.call('thread/read',{threadId:leaderThreadId,includeTurns:true});
        const ids=[...new Set((leader?.turns??[]).flatMap(t=>t.items??[]).filter(i=>i.type==='subAgentActivity'&&i.agentPath===agentPath&&i.agentThreadId).map(i=>i.agentThreadId))];
        if(!ids.length){const index=await this.identityLookup({leaderThreadId,cwd,agentPath});if(index.complete)ids.push(...index.ids);}
        if(ids.length!==1)throw new Error('Native member path is not uniquely visible in this Leader history; retry without respawning');
        threadId=ids[0];
      }
      const {thread}=await rpc.call('thread/read',{threadId,includeTurns:false});
      const parent=thread?.parentThreadId??thread?.source?.subAgent?.thread_spawn?.parent_thread_id;
      if(thread?.id!==threadId||parent!==leaderThreadId)throw new Error('Member is not a native child of the current Leader');
      if(await realpath(thread.cwd)!==await realpath(cwd))throw new Error('Member workspace does not match the current project');
      const recordedPath=thread?.source?.subAgent?.thread_spawn?.agent_path;
      if(agentPath&&recordedPath!==agentPath)throw new Error('Native member path does not match the host thread');
      agentPath??=recordedPath??null;
      const response=await rpc.call('thread/read',{threadId,includeTurns:true});
      const turns=response.thread?.turns??[];
      let launchIdentity;
      if(launchMember){
        launchIdentity=(await this.publicFeed.read(thread,'launch-identity-only')).contextIsolation;
        assertNativeLaunch({leaderThreadId},launchMember,{launchIdentity,model:thread.model??null,provider:thread.modelProvider??null,reasoningEffort:thread.reasoningEffort??null});
      }
      const selfCapability=authenticatedSelfBootstrap&&!!launchIdentity&&turns.length===1&&(!boundTurnId||boundTurnId===turns[0].id);
      if(beforeFirstBootstrap&&turns.some(t=>(t.items??[]).some(i=>i.type==='commandExecution'&&!isBootstrapPrelude(i)||i.type==='fileChange'||i.type==='mcpToolCall'&&(!isBootstrapTool(i)&&!isBootstrapDiscovery(i)||i.result?.structuredContent?.readyForWork===true))))throw Object.assign(Error('native-launch-before-bootstrap: business execution or an unknown tool preceded authorization; retain its original work and evidence'),{code:'NATIVE_LAUNCH_REJECTED'});
      if(requireFresh&&!selfCapability&&turns.some(t=>t.items?.some(i=>i.type==='agentMessage'&&typeof i.text==='string'&&(()=>{const first=i.text.split(/\r?\n/)[0].trim();if(/^TEAM_WORKSPACE_ATTEMPT:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(first))return first!==marker;try{const other=JSON.parse(i.text).attemptMarker;return typeof other==='string'&&other.startsWith('TEAM_WORKSPACE_ATTEMPT:')&&other!==marker;}catch{return false;}})())))throw new Error('Native context contains a different task attempt; use the clean reserved spawn with fork_turns=none');
      const lifecycle=new Map();
      const statusOf=async turn=>{if(!lifecycle.has(turn.id))lifecycle.set(turn.id,turn.status==='interrupted'?await this.lifecycleReader(thread,turn.id):null);const evidence=lifecycle.get(turn.id);return {status:turn.status==='interrupted'?evidence?.status??'unknown':turn.status,statusEvidence:evidence};};
      let quiescence;
      if(requireIdle){
        const latest=turns.at(-1);
        const status=latest?(await statusOf(latest)).status:null;
        if(!latest||!['completed','failed','interrupted'].includes(status))throw new Error('Native member is not confirmed idle; stop and settle the latest host turn before changing ownership');
        quiescence={turnId:latest.id,status,source:'native-latest-turn'};
      }
      // Stopping verifies the latest host turn independently of task association.
      // Ambiguous task history can block acceptance, but cannot keep an idle team
      // stuck in stopping. This receipt never selects or settles a task turn.
      if(marker===null&&!registration)return {threadId,agentPath,quiescence,turnId:null,status:'unknown',source:'native-child-metadata',connection:'snapshot',parentThreadId:parent,observedAt:new Date().toISOString()};
      // A reused member must have received THIS attempt, not merely finished an old task.
      // Some hosts encrypt collaboration input and omit it from thread/read. A public
      // acknowledgement ties the opaque prompt to this attempt without decrypting it.
      const ack=i=>i.type==='agentMessage'&&typeof i.text==='string'&&(i.text.trim()===marker||i.text.split(/\r?\n/)[0].trim()===marker||(()=>{try{return parseStructuredReport(i.text,{expectedMarker:marker}).attemptMarker===marker;}catch{return false;}})());
      const prompt=t=>t.items?.some(i=>i.type==='userMessage'&&i.content?.some(c=>c.type==='text'&&c.text?.includes(marker)));
      let matching=turns.filter(t=>prompt(t)||t.items?.some(ack));
      // An authenticated child's capability plus exact reserved native path is
      // stronger than asking a model to retype a UUID. Only the initial active
      // clean launch may use this identity; continuations/legacy binds still
      // need their original exact marker and bound-turn association.
      const capabilityIdentity=selfCapability&&!matching.length;
      if(capabilityIdentity)matching=[turns[0]];
      if(bootstrapTurnId&&boundTurnId&&!registration){
        const original=turns.find(t=>t.id===bootstrapTurnId);
        if(!original)throw Error('Authenticated bootstrap native turn is missing; preserve original evidence');
        if(!matching.includes(original))matching=[original,...matching].sort((a,b)=>turns.indexOf(a)-turns.indexOf(b));
      }
      // A format-only resend cannot replace the bound execution or its commands.
      // Retain the original exact turn only when every later completed report is
      // equivalent and contains no native tool execution. Real continuations
      // still require the interrupted-predecessor identity chain below.
      let duplicateReportTurnIds;
      if(!registration&&boundTurnId&&matching.length>1&&matching[0].id===boundTurnId&&matching.at(-1)===turns.at(-1)&&matching.every((t,i)=>!i||turns.indexOf(t)===turns.indexOf(matching[i-1])+1)){
        const report=t=>{const outputs=t.items.filter(i=>i.type==='agentMessage'&&(!i.phase||i.phase==='final_answer'));if(outputs.length!==1)return null;
          try{const value=parseStructuredReport(outputs[0].text,{expectedMarker:marker});for(const key of ['acceptanceResults','checks'])if(Array.isArray(value[key]))value[key]=value[key].map(c=>c&&Array.isArray(c.evidence)&&c.evidence.length&&c.evidence.every(v=>typeof v==='string'&&v.trim())?{...c,evidence:c.evidence.join('\n')}:c);return JSON.stringify(value);}catch{return null;}};
        const original=report(matching[0]);
        if(original&&(await statusOf(matching[0])).status==='completed'&&matching.slice(1).every(t=>t.items.every(i=>['userMessage','agentMessage'].includes(i.type))&&report(t)===original)&& (await Promise.all(matching.slice(1).map(statusOf))).every(s=>s.status==='completed')){
          duplicateReportTurnIds=matching.slice(1).map(t=>t.id);matching=matching.slice(0,1);
        }
      }
      if(registration){
        // Import is an explicit Leader association, never a name/time heuristic.
        // The exact native turns are checked against host identity and durable
        // lifecycle evidence. Unrelated later work cannot replace this result.
        const ids=registration.turnIds;
        if(registration.source!=='explicit-native-registration'||registration.threadId!==threadId||registration.agentPath!==agentPath||registration.marker!==marker||!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length)throw new Error('Invalid explicit native registration');
        matching=ids.map(id=>turns.find(t=>t.id===id));
        if(matching.some(t=>!t)||matching.some((t,i)=>i&&turns.indexOf(t)!==turns.indexOf(matching[i-1])+1))throw new Error('Registered native turns are missing or non-consecutive');
        const reportedMarkers=t=>(t.items??[]).filter(i=>i.type==='agentMessage').flatMap(i=>{try{const v=JSON.parse(i.text?.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i,'$1'));return [v.attemptMarker,v.taskMarker].filter(x=>typeof x==='string');}catch{return [...(i.text??'').matchAll(/(?:TEAM_WORKSPACE_ATTEMPT:[0-9a-f-]{36}|NATIVE_TEAM_TASK:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+)/g)].map(m=>m[0]);}});
        for(const t of matching)if(reportedMarkers(t).some(m=>m!==marker))throw new Error('Registered turn contains another task marker');
        // Only a marker-confirmed continuation after durable interruption may
        // extend a saved link. An unacknowledged new turn remains unassociated.
        let next=turns[turns.indexOf(matching.at(-1))+1];
        while(next&&reportedMarkers(next).includes(marker)&&reportedMarkers(next).every(m=>m===marker)){
          const prior=await statusOf(matching.at(-1));
          if(prior.status!=='interrupted'||!confirmedInterrupted(prior.statusEvidence))break;
          matching.push(next);next=turns[turns.indexOf(next)+1];
        }
      }
      if(startupOnly){
        const latest=turns.at(-1),s=latest?await statusOf(latest):null;
        const noPublicDelivery=!hasStartupDelivery(turns),prohibited=turns.some(t=>(t.items??[]).some(i=>i.type==='commandExecution'&&!isBootstrapPrelude(i)||i.type==='fileChange'||i.type==='mcpToolCall'&&!failedBootstrapCall(i)&&!isBootstrapDiscovery(i)));
        const startupErrors=turns.flatMap(t=>(t.items??[]).filter(i=>i.type==='mcpToolCall'&&(i.status==='failed'||i.result?.isError)).flatMap(i=>(i.result?.content??[]).filter(c=>c.type==='text').map(c=>String(c.text).slice(0,600)))).slice(-2);
        const startupActivity={source:'native-latest-turn',turnId:latest?.id??null,status:s?.status??'unknown',turnCount:turns.length,...(Number.isFinite(thread.createdAt)?{createdAt:new Date(thread.createdAt*1000).toISOString()}:{}),...(Number.isFinite(latest?.startedAt)?{startedAt:new Date(latest.startedAt*1000).toISOString()}:{}),safePrelude:turns.every(t=>(t.items??[]).every(i=>['userMessage','agentMessage','reasoning'].includes(i.type)||isBootstrapPrelude(i)||isPendingBootstrapPrelude(i)||isBootstrapTool(i)||isBootstrapDiscovery(i)||isPendingBootstrapDiscovery(i))),noPublicDelivery};
        return {threadId,agentPath,startupActivity,turnId:matching.length?latest?.id??null:null,status:matching.length?s?.status??'starting':'starting',...(!matching.length&&['completed','failed','interrupted'].includes(s?.status)?{startupTerminal:{turnId:latest.id,status:s.status,statusEvidence:s.statusEvidence}}:{}),latestTurnId:latest?.id??null,parentThreadId:parent,source:'native-child-metadata',connection:'snapshot',observedAt:new Date().toISOString(),startupOnly:true,executionAuthority:false,startupReason:startupErrors.join('; ')||(latest?.items??[]).filter(i=>i.type==='agentMessage'&&(!i.phase||i.phase==='final_answer')).at(-1)?.text?.slice(0,600)||(s?.status==='inProgress'?'Verified native child is running its self-bootstrap; wait without granting execution authority or redispatching':['completed','failed','interrupted'].includes(s?.status)?'Native child ended before authenticated task binding; inspect original startup evidence':'Native child exists; startup progress is not yet confirmed. Preserve the original reservation; never redispatch or infer completion'),startupRecovery:{source:'native-startup-history',allTurnsTerminal:turns.length>0&&(await Promise.all(turns.map(statusOf))).every(s=>['completed','failed'].includes(s.status)||s.status==='interrupted'&&confirmedInterrupted(s.statusEvidence)),noExecutionItems:!prohibited,noPublicDelivery,turnIds:turns.map(t=>t.id),readOnlyPreludeTools:turns.flatMap(t=>(t.items??[]).filter(isBootstrapDiscovery).map(i=>({callId:i.id??null,tool:i.tool,operation:i.arguments.operation,status:i.status}))),readOnlyPreludeCommands:turns.flatMap(t=>(t.items??[]).filter(isBootstrapPrelude).map(i=>({commandId:i.id??null,command:i.command,status:i.status,exitCode:i.exitCode})))},outputs:[],commands:[]};
      }
      if(!matching.length&&allowPending&&!boundTurnId)return {threadId,agentPath,quiescence,turnId:null,status:'starting',outputs:[],commands:[],messageAcknowledgements:[],attemptIdentitySource:'awaiting-public-member-acknowledgement',observedAt:new Date().toISOString(),source:'native-child-metadata',connection:'snapshot',parentThreadId:parent};
      const ambiguous=()=>{throw new Error('Attempt identity is not uniquely visible in the native member history; require consecutive matching continuation turns with confirmed interrupted predecessors. Retry observation without respawning');};
      if(!matching.length)throw new Error('Attempt identity is not uniquely visible: emit this exact standalone public marker in the SAME active native turn before reporting: '+marker+'. Do not shorten it or respawn.');
      if(new Set(matching.map(t=>t.id)).size!==matching.length)ambiguous();
      if(boundTurnId&&!matching.some(t=>t.id===boundTurnId))throw new Error('Attempt/turn mismatch: the bound turn is missing from native history');
      if(matching.length>1){
        if(!registration&&!/^TEAM_WORKSPACE_ATTEMPT:/.test(marker))ambiguous();
        for(const [i,t] of matching.entries()){
          const texts=t.items.flatMap(item=>item.type==='agentMessage'?[item.text]:item.type==='userMessage'?(item.content??[]).filter(c=>c.type==='text').map(c=>c.text):[]);
          if(t.id!==bootstrapTurnId&&texts.some(text=>(text?.match(/TEAM_WORKSPACE_ATTEMPT:[0-9a-f-]{36}/gi)??[]).some(other=>other!==marker)))ambiguous();
          if(i<matching.length-1){const s=await statusOf(t);if(s.status!=='interrupted'||!confirmedInterrupted(s.statusEvidence)||turns.indexOf(matching[i+1])!==turns.indexOf(t)+1)ambiguous();}
        }
      }
      const readTurn=async turn=>{
      const {status,statusEvidence}=await statusOf(turn);
      const outputs=turn.items.filter(i=>i.type==='agentMessage'&&(!i.phase||i.phase==='final_answer')).map(i=>({text:i.text,turnId:turn.id}));
      const commands=turn.items.filter(i=>i.type==='commandExecution').map(i=>({turnId:turn.id,...(typeof i.id==='string'?{commandId:i.id}:{}),...(typeof i.cwd==='string'?{cwd:i.cwd}:{}),command:i.command,exitCode:i.exitCode,status:i.status,...(typeof i.aggregatedOutput==='string'?{output:i.aggregatedOutput.slice(-16000)}:{})}));
      const reportAttempts=turn.items.filter(i=>i.type==='mcpToolCall'&&i.server==='team-workspace-probe'&&(i.tool==='report_member_team_task'||i.tool==='team_member'&&i.arguments?.operation==='report_member_team_task')).map(i=>{
        const a=i.tool==='team_member'?i.arguments?.arguments:i.arguments;
        return {callId:i.id??null,turnId:turn.id,status:i.status,isError:i.result?.isError===true,preflightValid:i.result?.structuredContent?.deliveryPreflight?.valid,identity:{teamId:a?.teamId,...(a?.taskId!==undefined?{taskId:a.taskId}:{}),...(a?.attemptId!==undefined?{attemptId:a.attemptId}:{})},requestId:a?.requestId??null,summary:typeof a?.summary==='string'?a.summary.slice(0,3000):null,delivery:typeof a?.delivery==='string'&&a.delivery.length<=24000?a.delivery:null,verificationInputs:a?.verificationInputs??null};
      });
      let activity;try{activity=await this.publicFeed.read(thread,turn.id);}catch(error){activity={events:[],cursor:0,usage:null,source:'unavailable',error:error.message};}
      const progress=turn.items.filter(i=>i.type==='agentMessage'&&i.phase==='commentary'&&typeof i.text==='string'&&!i.text.trim().startsWith('TEAM_WORKSPACE_')).slice(-5).map(i=>({text:i.text.slice(-4000),turnId:turn.id}));
      const messageAcknowledgements=[...new Set(turn.items.filter(i=>i.type==='agentMessage'&&typeof i.text==='string').flatMap(i=>i.text.split(/\r?\n/).map(s=>s.trim()).filter(s=>/^TEAM_WORKSPACE_MESSAGE:[0-9a-f-]{36}$/i.test(s))))];
      const startupErrors=startupOnly?turn.items.filter(i=>i.type==='mcpToolCall'&&i.result?.isError).flatMap(i=>(i.result.content??[]).filter(c=>c.type==='text').map(c=>String(c.text).slice(0,600))).slice(-2):[];
      return {threadId,turnId:turn.id,status,statusEvidence,outputs,commands,progress,activity,usage:activity.usage??null,...(startupOnly?{startupReason:startupErrors.join('; ')||outputs.at(-1)?.text?.slice(0,600)||'Native child ended before authenticated task binding'}:{}),...(Number.isFinite(turn.startedAt)?{startedAt:new Date(turn.startedAt*1000).toISOString()}:{}),
        messageAcknowledgements,...(reportAttempts.length?{reportAttempts}:{}),
        attemptIdentitySource:registration?'explicit-native-registration':capabilityIdentity?'authenticated-child-bootstrap':prompt(turn)?'native-user-message':'public-member-acknowledgement',
        observedAt:new Date().toISOString(),source:'native-thread-persisted-snapshot',connection:'snapshot',
        parentThreadId:parent};
      };
      const history=await Promise.all(matching.map(readTurn)),current=history.at(-1);
      if(duplicateReportTurnIds)current.duplicateReportTurnIds=duplicateReportTurnIds;
      const continuation=history.length>1?{turnHistory:history,turnAssociation:{type:'interrupted-continuation',threadId,marker,turnIds:history.map(r=>r.turnId),links:history.slice(1).map((r,i)=>({fromTurnId:history[i].turnId,toTurnId:r.turnId,source:'native-interrupted-continuation'}))},usage:sumTurnUsage(history)}:{};
      return {...current,...(launchIdentity?{launchIdentity}:{}),latestTurnId:turns.at(-1)?.id??null,agentPath,quiescence,model:thread.model??null,provider:thread.modelProvider??null,reasoningEffort:thread.reasoningEffort??null,...continuation};
  }
}
