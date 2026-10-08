import {realpath} from 'node:fs/promises';
import {AgentRpc} from './runtime.mjs';
import {persistedActivity} from './native-lifecycle.mjs';
import {NativePublicFeed} from './native-public.mjs';

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
  async inspect(leaderThreadId,cwd,threadId,marker,{allowPending=false,requireIdle=false}={}){
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
      if(requireIdle){
        const latest=turns.at(-1);
        const status=latest?.status==='interrupted'?(await this.lifecycleReader(thread,latest.id))?.status:latest?.status;
        if(!latest||!['completed','failed','interrupted'].includes(status))throw new Error('Native member is not confirmed idle; stop and settle the latest host turn before changing ownership');
      }
      // A reused member must have received THIS attempt, not merely finished an old task.
      // Some hosts encrypt collaboration input and omit it from thread/read. A public
      // acknowledgement ties the opaque prompt to this attempt without decrypting it.
      const ack=i=>i.type==='agentMessage'&&typeof i.text==='string'&&(i.text.trim()===marker||i.text.split(/\r?\n/)[0].trim()===marker||(()=>{try{return JSON.parse(i.text).attemptMarker===marker;}catch{return false;}})());
      const prompt=t=>t.items?.some(i=>i.type==='userMessage'&&i.content?.some(c=>c.type==='text'&&c.text?.includes(marker)));
      const matching=turns.filter(t=>prompt(t)||t.items?.some(ack));
      if(!matching.length&&allowPending)return {threadId,agentPath,turnId:null,status:'starting',outputs:[],commands:[],messageAcknowledgements:[],attemptIdentitySource:'awaiting-public-member-acknowledgement',observedAt:new Date().toISOString(),source:'native-child-metadata',connection:'snapshot',parentThreadId:parent};
      if(matching.length!==1)throw new Error('Attempt identity is not uniquely visible in the native member history; member must publicly acknowledge the exact marker. Retry observation without respawning');
      const turn=matching[0];
      let status=turn.status,statusEvidence=null;
      if(status==='interrupted'){
        statusEvidence=await this.lifecycleReader(thread,turn.id);
        status=statusEvidence?.status??'unknown';
      }
      const outputs=turn.items.filter(i=>i.type==='agentMessage'&&(!i.phase||i.phase==='final_answer')).map(i=>({text:i.text,turnId:turn.id}));
      const commands=turn.items.filter(i=>i.type==='commandExecution').map(i=>({command:i.command,exitCode:i.exitCode,status:i.status,...(typeof i.aggregatedOutput==='string'?{output:i.aggregatedOutput.slice(-16000)}:{})}));
      let activity;try{activity=await this.publicFeed.read(thread,turn.id);}catch(error){activity={events:[],cursor:0,usage:null,source:'unavailable',error:error.message};}
      const progress=turn.items.filter(i=>i.type==='agentMessage'&&i.phase==='commentary'&&typeof i.text==='string'&&!i.text.trim().startsWith('TEAM_WORKSPACE_')).slice(-5).map(i=>({text:i.text.slice(-4000),turnId:turn.id}));
      const messageAcknowledgements=[...new Set(turn.items.filter(i=>i.type==='agentMessage'&&typeof i.text==='string').flatMap(i=>i.text.split(/\r?\n/).map(s=>s.trim()).filter(s=>/^TEAM_WORKSPACE_MESSAGE:[0-9a-f-]{36}$/i.test(s))))];
      return {threadId,agentPath,turnId:turn.id,status,statusEvidence,model:thread.model??null,outputs,commands,progress,activity,usage:activity.usage??null,
        messageAcknowledgements,
        attemptIdentitySource:prompt(turn)?'native-user-message':'public-member-acknowledgement',
        observedAt:new Date().toISOString(),source:'native-thread-persisted-snapshot',connection:'snapshot',
        parentThreadId:parent};
  }
}
