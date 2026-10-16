import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('text-only MCP model receives exact dispatch and unlaunched reservations cannot enter either wait API', {skip:process.platform==='win32'}, async t=>{
  const root=await mkdtemp(join(tmpdir(),'model-router-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const binary=join(root,'host.mjs');
  await writeFile(binary,`#!${process.execPath}\nimport readline from 'node:readline';for await(const line of readline.createInterface({input:process.stdin})){const q=JSON.parse(line);if(q.id===undefined)continue;let result;if(q.method==='initialize')result={userAgent:'controlled-host'};else if(q.method==='model/list')result={data:[{model:'controlled-host-model',displayName:'Controlled Host Model',supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low'}],nextCursor:null};else if(q.method==='thread/read')result={thread:{id:q.params.threadId,cwd:${JSON.stringify(root)},turns:[]}};else{process.stdout.write(JSON.stringify({id:q.id,error:{code:-1,message:'Unexpected RPC '+q.method}})+'\\n');continue;}process.stdout.write(JSON.stringify({id:q.id,result})+'\\n');}`);
  await chmod(binary,0o755);await writeFile(join(root,'work.py'),'# unimplemented\n');
  const client=new Client({name:'text-only-model-protocol-fixture',version:'1'},{capabilities:{}});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('plugins/team-workspace-probe/dist/server.cjs')],cwd:root,env:{...process.env,TEAM_WORKSPACE_CODEX_BINARY:binary,TEAM_WORKSPACE_DATA_ROOT:join(root,'records')},stderr:'pipe'});
  try{
    await client.connect(transport);
    const call=async(operation,args)=>{
      const wire=await client.callTool({name:'team_leader',arguments:{operation,arguments:args},_meta:{threadId:'controlled-leader'}});
      assert.equal(wire.isError,undefined,JSON.stringify(wire.content));
      const model=JSON.parse(wire.content.find(c=>c.type==='text').text);
      assert.deepEqual(model,wire.structuredContent,'Text-only and structured consumers must receive the same business projection');
      return model;
    };
    const input={requestId:randomUUID(),approvalMode:'immediate',executionAuthorization:'User requested this controlled protocol test',goal:'Implement scoped behavior with independent review',members:[{id:'dev',role:'Developer',responsibility:'Implement',reason:'Work',writeScopes:['work.py']},{id:'qa',role:'Reviewer',responsibility:'Independently audit',reason:'Review',writeScopes:[]}],reviewerId:'qa',batch:{id:'batch',title:'Business goal',goal:'Implement scoped behavior'},units:[{id:'work',title:'Implement',goal:'Implement scoped behavior',memberId:'dev',criteria:[{id:'AC',description:'Required behavior is correct'}],writePaths:['work.py'],readPaths:['work.py'],verifyCommands:['python3 -m unittest']}]};
    const first=await call('start_team_goal',input);
    assert.equal(first.dispatches.length,1);
    const dispatch=first.dispatches[0];
    assert.ok(dispatch.nativeAction.arguments.message.includes(dispatch.marker));
    assert.match(dispatch.nativeAction.arguments.message,/start_member_team_task/);
    assert.match(dispatch.dispatchReference.sha256,/^[a-f0-9]{64}$/);
    assert.equal(first.nextAction,'dispatch-native');
    assert.equal(first.continuationArgs,undefined);
    assert.equal(first.waitInvocation,undefined,'A reservation is not a native launch');
    assert.equal(first.team,undefined,'Model projection must not copy full history into the response');
    const replay=await call('start_team_goal',input);
    assert.deepEqual(replay.dispatches??[],[],'An uncertain response cannot cause duplicate native dispatch');
    assert.equal(replay.teamId,first.teamId);
    const refreshed=await call('read_team',{teamId:first.teamId,view:'coordination'});
    assert.equal(refreshed.teamId,first.teamId);assert.equal(refreshed.revision,replay.revision);
    const next=await call('next_team_step',{teamId:replay.teamId,revision:replay.revision,dispatchView:'reference',finishReady:true});
    assert.equal(next.requiresLeaderAction,true);assert.equal(next.waitInvocation,undefined);assert.equal(next.waitProgram,undefined);assert.deepEqual(next.dispatches??[],[],'Unknown launch state cannot authorize redispatch');
    const staleArgs={teamId:replay.teamId,revision:Math.max(1,next.revision-1),dispatchView:'reference'};
    const stale=await client.callTool({name:'team_leader',arguments:{operation:'next_team_step',arguments:staleArgs},_meta:{threadId:'controlled-leader'}});
    assert.equal(stale.isError,true);assert.match(stale.content[0].text,/Team changed/);
    const refreshedStep=await call('next_team_step',{...staleArgs,refreshRevision:true});assert.equal(refreshedStep.teamId,replay.teamId);assert.deepEqual(refreshedStep.dispatches??[],[],'Refresh cannot duplicate an already reserved native execution');
    const wait=await call('next_team_step',{teamId:next.teamId,revision:refreshedStep.revision,wait:true,timeoutMs:55000,finishReady:true});
    assert.equal(wait.requiresLeaderAction,true);assert.equal(wait.waitInvocation,undefined);assert.equal(wait.continuationArgs,undefined);assert.deepEqual(wait.dispatches??[],[]);
    const eventWire=await client.callTool({name:'wait_team_event',arguments:{teamId:wait.teamId,revision:wait.revision,timeoutMs:55000},_meta:{threadId:'controlled-leader'}});
    assert.equal(eventWire.isError,undefined);const event=JSON.parse(eventWire.content.find(c=>c.type==='text').text);assert.equal(event.status,'action-required');assert.equal(event.coordination.requiresLeaderAction,true);assert.equal(event.continuationArgs,undefined);assert.equal(event.chatMessages,false);
    const rejected=await client.callTool({name:'team_member',arguments:{operation:'start_team_goal',arguments:input},_meta:{threadId:'controlled-leader'}});
    assert.equal(rejected.isError,true);
  }finally{await client.close();}
});
