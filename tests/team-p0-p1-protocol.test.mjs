import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
test('public MCP tools validate real catalog routes, stage roster-only profiles, and stop/resume with authenticated project metadata',{skip:process.platform==='win32'?'Controlled host fixture uses a POSIX executable script':false},async()=>{
 const root=await mkdtemp(join(tmpdir(),'p0-p1-protocol-')),binary=join(root,'host.mjs'),project=root;
 await writeFile(binary,`#!${process.execPath}\nimport readline from 'node:readline';for await(const line of readline.createInterface({input:process.stdin})){const q=JSON.parse(line);if(q.id===undefined)continue;let result;if(q.method==='initialize')result={userAgent:'controlled-host'};else if(q.method==='model/list')result={data:[{model:'controlled-host-model',displayName:'Controlled Host Model',supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low'}],nextCursor:null};else if(q.method==='thread/read')result={thread:{id:q.params.threadId,cwd:${JSON.stringify(project)},turns:[]}};else{process.stdout.write(JSON.stringify({id:q.id,error:{code:-1,message:'Unexpected RPC '+q.method}})+'\\n');continue;}process.stdout.write(JSON.stringify({id:q.id,result})+'\\n');}`);await chmod(binary,0o755);
 const client=new Client({name:'controlled-protocol-not-desktop',version:'1'}, {capabilities:{}}),transport=new StdioClientTransport({command:process.execPath,args:[resolve('plugins/team-workspace-probe/dist/server.cjs')],cwd:root,env:{...process.env,TEAM_WORKSPACE_CODEX_BINARY:binary,TEAM_WORKSPACE_DATA_ROOT:join(root,'records')},stderr:'pipe'});
 try{await client.connect(transport);const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args,_meta:{threadId:'controlled-leader'}});if(r.isError)throw new Error(r.content[0].text);return r.structuredContent;};
 const catalog=await call('read_team_model_catalog');assert.deepEqual(catalog.models[0].supportedReasoningEfforts,['low']);
 const members=[{id:'dev',role:'Dev',responsibility:'Implement',reason:'Delivery',writeScopes:['src'],route:{model:'controlled-host-model'}},{id:'qa',role:'QA',responsibility:'Review',reason:'Independence',writeScopes:[]}];
 const tasks=[{id:'work',title:'Implement',goal:'Implement scoped behavior',acceptance:'Checks pass',memberId:'dev',priority:3,kind:'work',dependencies:[]},{id:'review',title:'Review',goal:'Verify',acceptance:'Independent checks pass',memberId:'qa',priority:3,kind:'review',reviewOfTaskId:'work',dependencies:[{taskId:'work',when:'submitted'}]}];
 await call('save_team_profile',{name:'dynamic',taskPlanning:'leader',constraints:'保持独立审查',plan:{members},policy:{tokenLimit:10000}});const draft=await call('plan_team_from_profile',{name:'dynamic',goal:'实现当前项目明确范围的需求',execute:true});assert.equal(draft.kind,'team-planning-request');assert.equal(draft.constraints,'保持独立审查');assert.equal((await readdir(join(root,'records'))).includes('teams'),false);
 await assert.rejects(()=>call('plan_team',{goal:'拒绝不存在的宿主模型配置',execute:true,plan:{members:[{...members[0],route:{model:'invented'}},members[1]],tasks}}),/not offered/);
 const created=await call('plan_team_from_profile',{name:'dynamic',goal:'实现当前项目明确范围的需求',execute:true,tasks});assert.equal(created.team.memberStartup,'on-demand');assert.equal(created.team.requiresTeamWorkspaceVersion,undefined);assert.equal(created.team.dispatchPaused,false);
 const id=created.team.id,read=async()=>call('read_team',{teamId:id,view:'full'});let t=(await read()).team;assert.equal(t.requiresTeamWorkspaceVersion,'0.12.0');assert.equal(t.policy.tokenLimit,10000);assert.equal(t.members[0].route.reasoningEffort,'low');assert.ok(t.tasks.every(task=>task.context.includes('保持独立审查')));assert.deepEqual((await read()).initializations,[]);
 await assert.rejects(()=>call('claim_member_team_task',{teamId:id,revision:t.revision,taskId:'work',requestId:randomUUID()}),/authenticated/);
 const stopInput={teamId:id,revision:t.revision,requestId:randomUUID(),reason:'在执行前核查配置'};await call('stop_team',stopInput);const stopped=await call('stop_team',stopInput);assert.equal(stopped.team.executionControl.status,'stopping');t=(await read()).team;await assert.rejects(()=>call('start_team',{teamId:id,revision:t.revision}),/halted/);
 await call('reconcile_team_stop',{teamId:id,revision:t.revision});t=(await read()).team;assert.equal(t.state,'halted');await call('resume_team',{teamId:id,revision:t.revision,reason:'配置已核实，明确恢复',requestId:randomUUID()});t=(await read()).team;assert.equal(t.executionControl.status,'active');assert.ok(t.members.every(m=>m.agentThreadId===null));assert.ok(t.tasks.every(task=>task.attempts.length===0));
 }finally{await client.close();}
});
