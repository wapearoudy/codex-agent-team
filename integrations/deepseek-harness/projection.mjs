import {z} from 'zod';
import {publicText} from '../../src/host-normalize.mjs';

export const projectionEvent='team-workspace/state';
const identity=z.string().min(1).max(200);
const status=z.string().min(1).max(80).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
export const teamWorkspaceSchema=z.object({
  schemaVersion:z.literal(1),source:z.literal('team-workspace-engine'),
  observedAt:z.string().datetime(),sessionId:identity,host:z.literal('deepseek-harness'),
  team:z.object({id:identity,revision:z.number().int().nonnegative().safe(),goal:z.string().max(12000),state:status,
    members:z.array(z.object({id:identity,name:identity,role:z.string().max(500),nativeSessionId:identity.nullable(),bindingVerified:z.boolean(),status:status.optional()}).strict()).max(100),
    tasks:z.array(z.object({id:identity,number:z.number().int().positive().optional(),title:z.string().max(3000),status,ownerMemberId:identity.nullable(),blockedBy:z.array(identity).max(1000)}).strict()).max(5000)
  }).strict().nullable()
}).strict();
const stateSchema=teamWorkspaceSchema.nullable();
export function registerTeamProjection(ctx){
  return ctx.sessionProjections.register({key:'teamWorkspace',stateSchema,
    init:()=>null,apply:(state,event)=>event.type===projectionEvent?teamWorkspaceSchema.parse(event.data):state,
    wire:{viewSchema:stateSchema,view:state=>state},stateVersion:1});
}
// The read happens through the same authenticated native ticket as model tools.
// This loop contributes durable non-surface events; it cannot create model turns.
export function startTeamProjectionSync({ctx,engine,bridge,publish,intervalMs=2000}){
  let stopped=false;const signatures=new Map();
  const update=async session=>{
    await publish(session);
    const result=await engine.call(bridge,session.id,'open_team_workspace',{});
    const value=teamWorkspaceSchema.parse(result.nativeProjection);
    if(value.sessionId!==session.id)throw new Error('Team Workspace projection native identity mismatch');
    if(stopped||ctx.sessions.get(session.id)!==session)return;
    const signature=JSON.stringify({...value,observedAt:undefined});
    const previous=signatures.get(session.id);
    // Renew successful observation at least every ten seconds. Failed reads do
    // not append anything and never extend a stale binding's evidence clock.
    if(previous?.signature===signature&&Date.now()-previous.at<10000)return;
    session.append(projectionEvent,value);signatures.set(session.id,{signature,at:Date.now()});
  };
  const loop=async()=>{for(const session of ctx.sessions.list()){if(stopped)break;
    // Only materialized live root agents can own a current native Leader.
    // Restored, detached and child sessions cannot drive the fixed-team view.
    const agent=ctx.agents.get(session.id);if(!agent||agent.session!==session||session.header.parentSession)continue;
    try{await update(session);}catch(error){ctx.logger?.warn?.(`Team Workspace projection unavailable: ${publicText(error.message)}`);}}
    if(!stopped)timer=setTimeout(loop,intervalMs);};
  let timer=setTimeout(loop,0);
  return ()=>{stopped=true;clearTimeout(timer);signatures.clear();};
}
