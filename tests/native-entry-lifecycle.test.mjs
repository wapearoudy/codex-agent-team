import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import OpenCodePlugin from '../integrations/opencode/index.mjs';
test('OpenCode controlled SDK fixture: deleted historical session does not block caller and disposal closes MCP', {timeout:15000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'native-lifecycle-')),keys=['TEAM_WORKSPACE_SERVER_PATH','TEAM_WORKSPACE_BRIDGE_ROOT','TEAM_WORKSPACE_DATA_ROOT'],before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  process.env.TEAM_WORKSPACE_SERVER_PATH=resolve('plugins/team-workspace-probe/dist/server.cjs');process.env.TEAM_WORKSPACE_BRIDGE_ROOT=join(root,'bridge');process.env.TEAM_WORKSPACE_DATA_ROOT=join(root,'data');
  let deleted=false,plugin;const reads=[];
  const client={session:{async get({path:{id}}){reads.push(id);if(id==='stale'&&deleted)return{error:{name:'NotFoundError'}};return{data:{id,directory:root,time:{created:1},...(id==='stale'?{parentID:'caller'}:{})}};},async messages(){return{data:[]};},async status(){return{data:{}};}}};
  try{plugin=await OpenCodePlugin({client,directory:root});await plugin.event({event:{type:'session.idle',properties:{sessionID:'stale'}}});deleted=true;await plugin.event({event:{type:'session.deleted',properties:{info:{id:'stale'}}}});const result=JSON.parse(await plugin.tool.get_current_project.execute({},{sessionID:'caller',abort:new AbortController().signal}));assert.equal(result.context.threadId,'caller');assert.deepEqual(reads,['stale','caller']);}
  finally{await plugin?.event({event:{type:'server.instance.disposed',properties:{}}});for(const k of keys){if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];}await rm(root,{recursive:true,force:true});}
});
