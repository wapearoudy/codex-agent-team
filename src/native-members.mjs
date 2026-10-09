import {realpath} from 'node:fs/promises';
import {AgentRpc} from './runtime.mjs';
import {persistedActivity} from './native-lifecycle.mjs';
import {NativePublicFeed} from './native-public.mjs';
import {sumTurnUsage} from './turn-association.mjs';

// Observation only. Never start/resume/fork a model session in the plugin.
export class NativeMembers {
  constructor({rpcFactory,lifecycleReader=persistedActivity,publicFeed=new NativePublicFeed()}={}){this.rpcFactory=rpcFactory??(()=>new AgentRpc(process.env.TEAM_WORKSPACE_CODEX_BINARY,{snapshotOnly:true}));this.lifecycleReader=lifecycleReader;this.publicFeed=publicFeed;}
  async connect(){if(!this.ready){this.rpc=this.rpcFactory();this.rpc.on?.('disconnected',()=>{this.ready=null;});this.ready=this.rpc.connect().catch(async error=>{await this.rpc.close();this.ready=null;throw error;});}await this.ready;return this.rpc;}
  async close(){await this.rpc?.close();this.ready=null;}
  async historicalUsage(leaderThreadId,cwd,threadId,turnIds){
    const rpc=await this.connect(),{thread}=await rpc.call('thread/read',{threadId,includeTurns:false});
    const parent=thread?.parentThreadId??thread?.source?.subAgent?.thread_spawn?.parent_thread_id;
    if(thread.id!==threadId||parent!==leaderThreadId||await realpath(thread.cwd)!==await realpath(cwd))throw new Error('Historical usage identity mismatch');
    return Promise.all(turnIds.map(async turnId=>({turnId,usage:(await this.publicFeed.read(thread,turnId)).usage})));
  }
  async inspectIdle(leaderThreadId,cwd,threadId){return this.inspect(leaderThreadId,cwd,threadId,null,{requireIdle:true});}
  async inspect(leaderThreadId,cwd,threadId,marker,{allowPending=false,requireIdle=false,requireFresh=false,boundTurnId=null}={}){
    const rpc=await this.connect();
      let agentPath=null;
      if(threadId.startsWith('/')){
        agentPath=threadId;
        const {thread:leader}=await rpc.call('thread/read',{threadId:leaderThreadId,includeTurns:true});
        const ids=[...new Set((leader?.turns??[]).flatMap(t=>t.items??[]).filter(i=>i.type==='subAgentActivity'&&i.agentPath===agentPath&&i.agentThreadId).map(i=>i.agentThreadId))];
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
      if(requireFresh&&turns.some(t=>t.items?.some(i=>i.type==='agentMessage'&&typeof i.text==='string'&&(()=>{const first=i.text.split(/\r?\n/)[0].trim();if(/^TEAM_WORKSPACE_ATTEMPT:[0-9a-f-]{36}$/i.test(first))return first!==marker;try{const other=JSON.parse(i.text).attemptMarker;return typeof other==='string'&&other.startsWith('TEAM_WORKSPACE_ATTEMPT:')&&other!==marker;}catch{return false;}})())))throw new Error('Native context contains a different task attempt; use the clean reserved spawn with fork_turns=none');
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
      if(marker===null)return {threadId,agentPath,quiescence,turnId:null,status:'unknown',source:'native-child-metadata',connection:'snapshot',parentThreadId:parent,observedAt:new Date().toISOString()};
      // A reused member must have received THIS attempt, not merely finished an old task.
      // Some hosts encrypt collaboration input and omit it from thread/read. A public
      // acknowledgement ties the opaque prompt to this attempt without decrypting it.
      const ack=i=>i.type==='agentMessage'&&typeof i.text==='string'&&(i.text.trim()===marker||i.text.split(/\r?\n/)[0].trim()===marker||(()=>{try{return JSON.parse(i.text).attemptMarker===marker;}catch{return false;}})());
      const prompt=t=>t.items?.some(i=>i.type==='userMessage'&&i.content?.some(c=>c.type==='text'&&c.text?.includes(marker)));
      const matching=turns.filter(t=>prompt(t)||t.items?.some(ack));
      if(!matching.length&&allowPending&&!boundTurnId)return {threadId,agentPath,quiescence,turnId:null,status:'starting',outputs:[],commands:[],messageAcknowledgements:[],attemptIdentitySource:'awaiting-public-member-acknowledgement',observedAt:new Date().toISOString(),source:'native-child-metadata',connection:'snapshot',parentThreadId:parent};
      const ambiguous=()=>{throw new Error('Attempt identity is not uniquely visible in the native member history; require consecutive matching continuation turns with confirmed interrupted predecessors. Retry observation without respawning');};
      if(!matching.length||new Set(matching.map(t=>t.id)).size!==matching.length)ambiguous();
      if(boundTurnId&&!matching.some(t=>t.id===boundTurnId))throw new Error('Attempt/turn mismatch: the bound turn is missing from native history');
      if(matching.length>1){
        if(!/^TEAM_WORKSPACE_ATTEMPT:/.test(marker))ambiguous();
        for(const [i,t] of matching.entries()){
          const texts=t.items.flatMap(item=>item.type==='agentMessage'?[item.text]:item.type==='userMessage'?(item.content??[]).filter(c=>c.type==='text').map(c=>c.text):[]);
          if(texts.some(text=>(text?.match(/TEAM_WORKSPACE_ATTEMPT:[0-9a-f-]{36}/gi)??[]).some(other=>other!==marker)))ambiguous();
          if(i<matching.length-1){const s=await statusOf(t);if(s.status!=='interrupted'||s.statusEvidence?.source!=='persisted-turn-aborted'||turns.indexOf(matching[i+1])!==turns.indexOf(t)+1)ambiguous();}
        }
      }
      const readTurn=async turn=>{
      const {status,statusEvidence}=await statusOf(turn);
      const outputs=turn.items.filter(i=>i.type==='agentMessage'&&(!i.phase||i.phase==='final_answer')).map(i=>({text:i.text,turnId:turn.id}));
      const commands=turn.items.filter(i=>i.type==='commandExecution').map(i=>({turnId:turn.id,command:i.command,exitCode:i.exitCode,status:i.status,...(typeof i.aggregatedOutput==='string'?{output:i.aggregatedOutput.slice(-16000)}:{})}));
      let activity;try{activity=await this.publicFeed.read(thread,turn.id);}catch(error){activity={events:[],cursor:0,usage:null,source:'unavailable',error:error.message};}
      const progress=turn.items.filter(i=>i.type==='agentMessage'&&i.phase==='commentary'&&typeof i.text==='string'&&!i.text.trim().startsWith('TEAM_WORKSPACE_')).slice(-5).map(i=>({text:i.text.slice(-4000),turnId:turn.id}));
      const messageAcknowledgements=[...new Set(turn.items.filter(i=>i.type==='agentMessage'&&typeof i.text==='string').flatMap(i=>i.text.split(/\r?\n/).map(s=>s.trim()).filter(s=>/^TEAM_WORKSPACE_MESSAGE:[0-9a-f-]{36}$/i.test(s))))];
      return {threadId,turnId:turn.id,status,statusEvidence,outputs,commands,progress,activity,usage:activity.usage??null,
        messageAcknowledgements,
        attemptIdentitySource:prompt(turn)?'native-user-message':'public-member-acknowledgement',
        observedAt:new Date().toISOString(),source:'native-thread-persisted-snapshot',connection:'snapshot',
        parentThreadId:parent};
      };
      const history=await Promise.all(matching.map(readTurn)),current=history.at(-1);
      const continuation=history.length>1?{turnHistory:history,turnAssociation:{type:'interrupted-continuation',threadId,marker,turnIds:history.map(r=>r.turnId),links:history.slice(1).map((r,i)=>({fromTurnId:history[i].turnId,toTurnId:r.turnId,source:'native-interrupted-continuation'}))},usage:sumTurnUsage(history)}:{};
      return {...current,agentPath,quiescence,model:thread.model??null,provider:thread.modelProvider??null,reasoningEffort:thread.reasoningEffort??null,...continuation};
  }
}
