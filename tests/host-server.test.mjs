import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {HostBridge} from '../src/host-bridge.mjs';

for(const host of ['deepseek-harness','claude-code','opencode'])test(`${host}: real bundled MCP routes authenticate native caller and reserve host-specific work`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'team-native-protocol-')),project=join(root,'project');await mkdir(project);
  const bridge=new HostBridge({host,root:join(root,'bridge')});
  const leaderId='fixture-native-leader';
  await bridge.putThread({id:leaderId,cwd:project,parentThreadId:null,nativeTools:['subagent','send_message','interrupt_agent'].map(name=>({name,description:'returns a subagent id you can continue with `send_message`'})),turns:[]});
  const client=new Client({name:'controlled-native-adapter-fixture',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('plugins/team-workspace-probe/dist/server.cjs')],stderr:'pipe',env:{...process.env,TEAM_WORKSPACE_HOST:host,TEAM_WORKSPACE_DATA_ROOT:join(root,'data'),TEAM_WORKSPACE_BRIDGE_ROOT:bridge.root}});
  const call=async(name,args={},id=leaderId)=>client.callTool({name,arguments:{...args,_hostTicket:await bridge.issueContext(id,name)}});
  const unwrap=r=>{assert.notEqual(r.isError,true,r.content?.[0]?.text);return r.structuredContent;};
  try{
    await client.connect(transport);
    const tools=(await client.listTools()).tools;
    assert.deepEqual(tools.map(t=>t.name).sort(),['get_current_project','open_team_workspace','read_team','team_command','team_leader','team_member']);
    assert.equal(tools.some(t=>t.name.includes('probe')),false);
    assert.equal((await client.callTool({name:'get_current_project',arguments:{},_meta:{threadId:leaderId}})).isError,true);
    const context=unwrap(await call('get_current_project')).context;assert.equal(context.threadId,leaderId);assert.equal(context.hostId,host);
    const plan=unwrap(await call('team_leader',{operation:'plan_team',arguments:{goal:'Verify native host adapter fixture',plan:{members:[{id:'dev',role:'Developer',responsibility:'Controlled protocol work',reason:'Fixture',writeScopes:[]},{id:'qa',role:'Reviewer',responsibility:'Independent protocol review',reason:'Fixture',writeScopes:[]}],tasks:[]},execute:true,memberStartup:'on-demand',approvalMode:'immediate',executionAuthorization:'Controlled test user says directly execute this fixture',maxParallel:2,requestId:randomUUID()}}));
    const teamId=plan.teamId;assert.ok(teamId);
    const work={id:'work',title:'Fixture work',goal:'Return controlled evidence',acceptance:'Identity stays native',memberId:'dev',priority:1,kind:'work',validationMode:'source-only',resources:[],dependencies:[]};
    const review={...work,id:'review',title:'Fixture review',memberId:'qa',kind:'review',reviewOfTaskId:'work',dependencies:[{taskId:'work',when:'submitted'}]};
    const added=unwrap(await call('team_leader',{operation:'add_team_tasks',arguments:{teamId,revision:plan.revision,tasks:[work,review]}}));
    const claimed=unwrap(await call('team_leader',{operation:'claim_team_tasks',arguments:{teamId,revision:added.revision,taskIds:['work']}}));
    const packet=claimed.dispatches[0];assert.equal(packet.host,host);assert.equal(packet.nativeAction.tool,host==='claude-code'?'Agent':host==='opencode'?'task':'subagent');
    const marker=packet.marker;await bridge.putThread({id:'fixture-child',cwd:project,parentThreadId:leaderId,turns:[{id:'native-turn',status:'inProgress',items:[{type:'userMessage',content:[{type:'text',text:marker}]}]}]});
    const bound=unwrap(await call('team_leader',{operation:'bind_team_members',arguments:{teamId,revision:claimed.revision,assignments:[{taskId:'work',attemptId:packet.attemptId,threadId:'fixture-child'}]}}));
    assert.equal(bound.running[0].status,'inProgress');assert.equal(bound.titleActions[0],null);
    const misuse=await call('team_leader',{operation:'add_team_tasks',arguments:{teamId,revision:bound.revision,tasks:[{...work,id:'other'}]}},'fixture-child');assert.equal(misuse.isError,true);assert.match(misuse.content[0].text,/members cannot invoke Leader/i);
    const stopped=unwrap(await call('team_leader',{operation:'stop_team',arguments:{teamId,revision:bound.revision,requestId:randomUUID(),reason:'Controlled fixture stop'}}));
    assert.equal(stopped.control,'stopping');
    const reconciled=unwrap(await call('team_leader',{operation:'reconcile_team_stop',arguments:{teamId,revision:stopped.revision}}));assert.equal(reconciled.control,'stopping');
  }finally{await client.close();await rm(root,{recursive:true,force:true});}
});
