import {isAbsolute} from 'node:path';
import {realpath} from 'node:fs/promises';
import {AgentRpc} from './runtime.mjs';

export async function authorizeTeam({owner,context,store,teamId}){
  const team=await store.get(teamId,owner);
  if(team.projectPath!==context.cwd)throw new Error('团队不属于当前触发会话的项目；拒绝跨项目操作。');
  return owner;
}

// The caller cannot provide a project path. Only the host's current thread identity is used.
export class HostContext {
  constructor({binary=process.env.TEAM_WORKSPACE_CODEX_BINARY,rpcFactory,idleMs=30000}={}){this.binary=binary;this.rpcFactory=rpcFactory??(()=>new AgentRpc(this.binary,{snapshotOnly:true}));this.idleMs=idleMs;this.active=0;}
  async connect(){
    clearTimeout(this.idleTimer);
    if(!this.ready){const rpc=this.rpcFactory();this.rpc=rpc;rpc.on?.('disconnected',()=>{if(this.rpc===rpc){this.ready=null;this.rpc=null;}});this.ready=rpc.connect().then(()=>rpc).catch(async error=>{if(this.rpc===rpc){this.rpc=null;this.ready=null;}await rpc.close();throw error;});}
    return this.ready;
  }
  async close(){clearTimeout(this.idleTimer);const rpc=this.rpc;this.rpc=null;this.ready=null;await rpc?.close();}
  async resolve(meta){
    const threadId=meta?.threadId??meta?.thread_id;
    if(typeof threadId!=='string'||!threadId||(meta?.threadId&&meta?.thread_id&&meta.threadId!==meta.thread_id))throw new Error('缺少当前 Codex 会话标识，无法绑定项目。');
    this.active++;let rpc;
    try{
      rpc=await this.connect();
      const {thread}=await rpc.call('thread/read',{threadId,includeTurns:false});
      if(thread?.id!==threadId||typeof thread.cwd!=='string'||!isAbsolute(thread.cwd))throw new Error('宿主未返回当前会话的有效项目目录，团队未启动。');
      const cwd=await realpath(thread.cwd);
      return{threadId,cwd,parentThreadId:thread.parentThreadId??thread.source?.subAgent?.thread_spawn?.parent_thread_id??null,source:'host-thread-metadata',observedAt:new Date().toISOString()};
    }catch(error){if(this.rpc===rpc)await this.close();throw error;}
    finally{this.active--;if(!this.active&&this.rpc){this.idleTimer=setTimeout(()=>void this.close(),this.idleMs);this.idleTimer.unref?.();}}
  }
}
