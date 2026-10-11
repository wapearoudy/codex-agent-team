import {join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {realpath} from 'node:fs/promises';
import {watch} from 'node:fs';
import {HostContext} from './host-context.mjs';
import {NativeMembers} from './native-members.mjs';
import {HostBridge} from './host-bridge.mjs';

const aliases={codex:'codex',dsh:'deepseek-harness',deepseekharness:'deepseek-harness','deepseek-harness':'deepseek-harness',claude:'claude-code',claudecode:'claude-code','claude-code':'claude-code',opencode:'opencode'};
// The installed native tool advertises this mode; control tool presence alone
// does not distinguish a one-shot job from a reusable member session.
const dshContinuable=tools=>['subagent','send_message','interrupt_agent'].every(name=>tools?.some(t=>t.name===name))&&/returns a subagent id you can continue with `send_message`/.test(tools?.find(t=>t.name==='subagent')?.description??'');
const dshProfileRequired='DSH fixed team members require a continuable profile whose native subagent tool advertises reusable subagent IDs, plus send_message and interrupt_agent. One-shot job IDs cannot identify reusable member sessions; unknown tool wording requires profile verification.';
export function hostId(value=process.env.TEAM_WORKSPACE_HOST??'codex'){
  const id=aliases[String(value).toLowerCase()];
  if(!id)throw new Error(`Unsupported Team Workspace host: ${value}`);
  return id;
}
export function hostDataRoot(id,root=process.env.TEAM_WORKSPACE_DATA_ROOT){
  id=hostId(id);
  return id==='codex'?(root??join(homedir(),'.codex','team-workspace')):root?join(root,'hosts',id):join(homedir(),'.agent-team',id,'team-workspace');
}
export const hostCapabilities=id=>{
  id=hostId(id);
  return {host:id,leader:'current-host-conversation',execution:'native-subagents',projectSelection:'verified-host-context',
    panel:id==='codex'?'mcp-app':'native-tools',nativeMessages:id==='codex'||id==='deepseek-harness',
    navigation:id==='codex'?'codex-link':id==='opencode'||id==='deepseek-harness'?'native-session-reference':'host-agent-task-output',
    modelCatalog:id==='codex'?'host-catalog':'observed-host-models',childModelSelection:id==='codex'||id==='claude-code',coordinatorModel:false};
};
export function nativeMessageAction(id,{threadId,target,text,relationship='child'}){
  id=hostId(id);
  if(id==='codex')return {tool:'send_message',target,threadId,text};
  if(id==='deepseek-harness'&&relationship!=='sibling')return {tool:'send_message',arguments:{agent_id:threadId,message:text}};
  return null;
}

// The bridge has no model credentials or execution API. Native hosts publish
// verified session snapshots; NativeMembers keeps the existing identity and
// attempt gates instead of replacing them with member-reported status.
class BridgeRpc{
  constructor(bridge){this.bridge=bridge;}
  async connect(){}
  async close(){}
  async call(method,args){
    if(method==='thread/read'){
      const thread=await this.bridge.readThread(args.threadId);
      if(!thread||thread.id!==args.threadId)throw new Error('Native host session is unavailable; do not respawn');
      return {thread:args.includeTurns?thread:{...thread,turns:[]}};
    }
    if(method==='model/list')return {data:await this.bridge.readModels(),nextCursor:null};
    throw new Error(`Unsupported read-only host method: ${method}`);
  }
}
class BridgeMembers extends NativeMembers{
  constructor(bridge){
    const rpc=new BridgeRpc(bridge);
    super({rpcFactory:()=>rpc,publicFeed:{read:async(thread,turnId)=>{
      const turn=(await bridge.readThread(thread.id)).turns?.find(t=>t.id===turnId);
      return {events:turn?.activity??[],cursor:turn?.activity?.length??0,usage:turn?.usage??null,source:'native-host-events'};
    }},lifecycleReader:async(thread,turnId)=>(await bridge.readThread(thread.id)).turns?.find(t=>t.id===turnId)?.statusEvidence??null});
    this.bridge=bridge;
  }
  async subscribe(team,onChange){
    for(const task of team.tasks.filter(t=>t.status==='running')){
      const id=task.attempts.at(-1)?.agentThreadId;if(!id)continue;
      const thread=await this.bridge.readThread(id);
      if(thread.parentThreadId!==team.leaderThreadId||await realpath(thread.cwd)!==await realpath(team.projectPath))throw new Error('Native event subscription identity mismatch');
    }
    await this.bridge.ensure();
    const watcher=watch(dirname(this.bridge.file),()=>onChange());watcher.on('error',onChange);
    return ()=>watcher.close();
  }
}
class BridgeContext{
  constructor(bridge){this.bridge=bridge;this.rpc=new BridgeRpc(bridge);}
  async close(){}
  async call(method,args){return this.rpc.call(method,args);}
  async resolve(meta){
    if(!meta?.hostVerified||meta.host!==this.bridge.host)throw new Error('Native host context ticket is required; arbitrary session IDs are not authorized');
    const thread=await this.bridge.readThread(meta.threadId);
    const cwd=await realpath(thread.cwd);
    return {hostId:this.bridge.host,threadId:thread.id,parentThreadId:thread.parentThreadId??null,cwd,nativeTools:thread.nativeTools??[],source:'native-host-context',observedAt:new Date().toISOString(),
      modelRoute:{model:thread.model??null,provider:thread.modelProvider??null,reasoningEffort:thread.reasoningEffort??null,source:'native-host-context'}};
  }
}
export function createHostAdapter({host=hostId(),bridge}={}){
  const id=hostId(host),root=hostDataRoot(id),capabilities=hostCapabilities(id);
  if(id==='codex')return {id,root,capabilities,context:new HostContext(),observer:new NativeMembers(),authenticate:async(_name,args,extra)=>({args,extra}),dispatch:p=>p};
  bridge??=new HostBridge({host:id});
  return {id,root,bridge,capabilities,context:new BridgeContext(bridge),observer:new BridgeMembers(bridge),
    async authenticate(name,args,extra){
      const {_hostTicket,...clean}=args;
      const context=await bridge.authenticate(_hostTicket,name);
      return {args:clean,extra:{...extra,_meta:{threadId:context.threadId,host:id,hostVerified:true}}};
    },async freezeRoutes(members,context,catalog){
      if(!members?.length)return;
      if(id!=='claude-code'&&members.some(m=>m.route?.model||m.route?.reasoningEffort||m.fallbackRoute))throw new Error('This native delegation tool inherits its host preset; per-member model overrides are unavailable');
      if(id==='deepseek-harness'&&!dshContinuable(context.nativeTools))throw new Error(dshProfileRequired);
      if(members.some(m=>m.route?.reasoningEffort||m.fallbackRoute?.reasoningEffort))throw new Error('This native delegation tool has no per-member effort argument');
      await catalog.validate(members,{includeFrozen:false});
      for(const m of members){
        m.routeSnapshot={model:m.route?.model??null,provider:null,reasoningEffort:null,source:m.route?.model?'explicit-observed-host-model':'native-preset-inheritance'};
        if(m.fallbackRoute)await catalog.validate([{route:m.fallbackRoute}]);
      }
    },dispatch:p=>dispatchForHost(id,p)};
}

export function dispatchForHost(id,packet){
  id=hostId(id);if(id==='codex')return packet;
  const clean={...packet,host:id,titleAction:null};
  const model=packet.spawnOptions?.model;
  const prompt=packet.prompt.replaceAll('native send_message tool',id==='deepseek-harness'?'send_message tool':'saved team mailbox (no native peer steering capability)').replaceAll('existing native send_message tool',id==='deepseek-harness'?'send_message tool':'saved team mailbox');
  if(id==='claude-code')return {...clean,prompt,spawnOptions:{...(model?{model}:{}),run_in_background:true},nativeAction:{tool:'Agent',arguments:{description:packet.displayName,prompt,subagent_type:'general-purpose',run_in_background:true,...(model?{model}:{}),...(packet.existingThreadId?{resume:packet.existingThreadId}:{})}},control:{interruptTool:'TaskStop',lookupTool:'TaskOutput',identity:'use actual task_id from native launch receipt; agent ID alone is insufficient'},limitations:['Claude Code titles use Agent descriptions; there is no Codex conversation deep link.','Native peer steering is unavailable; retain mailbox records and report actionable blockers to Leader.']};
  if(id==='opencode')return {...clean,prompt,spawnOptions:{},nativeAction:{tool:'task',arguments:{description:packet.displayName,prompt,subagent_type:'general',...(packet.existingThreadId?{task_id:packet.existingThreadId}:{})}},control:{tool:'team_workspace_control',arguments:{action:'abort',sessionId:packet.existingThreadId??null},identity:'Use the verified native child sessionId returned by task.'},limitations:['Use the native task tool; never create an unrelated top-level session.','Native task uses its configured general preset; there is no per-task model override.']};
  const delegation=packet.nativeTools?.find(t=>t.name==='subagent');
  if(!dshContinuable(packet.nativeTools))return {...clean,prompt,spawnOptions:{},nativeAction:{tool:null,reason:dshProfileRequired,prompt},control:{tool:null}};
  const parameters=delegation?.parameters?.properties??delegation?.parameters??{};
  const canMessage=packet.nativeTools?.some(t=>t.name==='send_message');
  return {...clean,prompt,spawnOptions:{},nativeAction:packet.existingThreadId?canMessage?{tool:'send_message',arguments:{agent_id:packet.existingThreadId,message:prompt}}:{tool:null,reason:'This native DSH profile has no verified send_message control for reusing a member.',prompt}:delegation?{tool:'subagent',arguments:{description:packet.displayName,prompt,...('run_in_background' in parameters?{run_in_background:true}:{})}}:{tool:null,reason:'No verified default subagent tool in this DSH profile; inspect its native delegation schema before dispatch',prompt},control:{tool:packet.nativeTools?.some(t=>t.name==='interrupt_agent')?'interrupt_agent':null,identityArgument:'agent_id'},limitations:['Configured DSH profiles may use different delegation and control tools. Dispatch uses only parameters present in the native catalog; synchronous profiles remain synchronous.']};
}
