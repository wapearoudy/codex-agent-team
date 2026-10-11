import {ObserverQueue} from '../../src/observer-queue.mjs';
import {HostBridge} from '../../src/host-bridge.mjs';
import {createDshAccumulator,textBlocks,publicText} from '../../src/host-normalize.mjs';
import {connectEngine} from '../common/client.mjs';
import {registerTeamProjection,startTeamProjectionSync,projectionEvent} from './projection.mjs';
export const name='team-workspace';
export const inject=['tools','sessions','agents','sessionProjections'];
export function observedNativeTools(ctx,session){
  const recorded=session.requestHeader?.()?.tools;if(Array.isArray(recorded)&&recorded.length)return recorded;
  const agent=ctx.agents.get(session.id);if(!agent||agent.id!==session.id||agent.session!==session)return [];
  try{return ctx.tools.wireSchemas(agent).schemas??[];}catch{return [];}
}
export function observedNativeMembers(ctx,session){
  const agent=ctx.agents.get(session.id);if(!agent||agent.id!==session.id||agent.session!==session)return [];
  try{const teams=typeof ctx.get==='function'?ctx.get('agentTeams',true):ctx.agentTeams;return (teams?.listMembers(agent)??[]).filter(row=>typeof row.id==='string'&&typeof row.name==='string'&&['running','inactive'].includes(row.status)).map(row=>({id:row.id,target:row.name}));}catch(error){ctx.logger?.warn?.(`Team Workspace native roster: ${publicText(error.message)}`);return [];}
}
export function publicEvent(event){
  const d=event.data??{},base={seq:event.seq,type:event.type};
  if(['turn/start','turn/end'].includes(event.type))return {...base,data:{turn:d.turn,...(d.reason?{reason:{kind:d.reason.kind}}:{})}};
  if(event.type==='user/message')return {...base,data:{id:d.id,content:[{type:'text',text:textBlocks(d.content)}]}};
  if(event.type==='assistant/message')return {...base,data:{turn:d.turn,message:{id:d.message?.id,content:[{type:'text',text:textBlocks(d.message?.content)}]},usage:d.usage}};
  if(event.type==='tool/call'&&['bash','pwsh','run_command'].includes(d.name)){let args;try{args=JSON.parse(d.arguments);}catch{return null;}return {...base,data:{turn:d.turn,callId:d.callId,name:d.name,arguments:JSON.stringify({command:publicText(args.command??args.cmd??'')})}};}
  if(event.type==='tool/result')return {...base,data:{turn:d.turn,message:{source:{callId:d.message?.source?.callId},isError:d.message?.isError,content:[{type:'text',text:textBlocks(d.message?.content)}]},meta:{exitCode:d.meta?.exitCode??d.meta?.exit_code??null}}};
  return null;
}
export async function apply(ctx,config={}){
  const bridge=new HostBridge({host:'deepseek-harness',root:config.bridgeRoot});await bridge.ensure();
  const engine=await connectEngine({host:bridge.host,entryUrl:import.meta.url,bridgeRoot:bridge.root});
  const sessions=new Map(),queue=new ObserverQueue(),timers=new Map();
  const state=session=>{let a=sessions.get(session.id);if(!a){a=createDshAccumulator(session);sessions.set(session.id,a);}return a;};
  const publish=session=>{clearTimeout(timers.get(session.id));timers.delete(session.id);const next=queue.publish(session.id,async()=>{const thread=state(session).snapshot();thread.nativeTools=observedNativeTools(ctx,session);thread.nativeMembers=observedNativeMembers(ctx,session);await bridge.putThread(thread);if(thread.model)await bridge.setModels([{id:thread.model,model:thread.model,provider:thread.modelProvider,source:'observed-native-session',childModelSelectable:false}]);});next.catch(error=>ctx.logger?.warn?.(`Team Workspace observer: ${publicText(error.message)}`));return next;};
  registerTeamProjection(ctx);
  ctx.on('session/event',(session,event)=>{if(event.type===projectionEvent)return;const visible=publicEvent(event);if(visible)state(session).append(visible);if(event.type==='turn/end')void publish(session);else if(!timers.has(session.id))timers.set(session.id,setTimeout(()=>void publish(session),100));});
  ctx.on('session/created',session=>{state(session);void publish(session);});
  // No history API promises: a late-mounted session is unknown until native events arrive.
  for(const session of ctx.sessions.list())await publish(session);
  const stopProjection=startTeamProjectionSync({ctx,engine,bridge,publish});
  // Cordis owns resources through fiber effects; a plain "dispose" listener
  // is not called when the plugin fiber unloads.
  ctx.effect(()=>async()=>{stopProjection();for(const timer of timers.values())clearTimeout(timer);await queue.drain();sessions.clear();await engine.close();});
  for(const spec of engine.tools)ctx.tools.register({name:spec.name,description:spec.description,parameters:spec.inputSchema,output:{schema:{},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},async execute(args,exec){
    const agent=exec.agent;if(!agent||ctx.agents.get(agent.id)!==agent)throw new Error('A real native calling agent is required');const session=ctx.sessions.get(agent.id);if(!session||agent.session!==session)throw new Error('Native session identity mismatch');
    await publish(session);return engine.call(bridge,session.id,spec.name,args,exec.signal);
  }});
}
export default {name,inject,apply};
