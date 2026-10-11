import test from 'node:test';
import packageInfo from '../package.json' with {type:'json'};
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdtemp, readdir, rmdir,mkdir,writeFile,rm } from 'node:fs/promises';
import {dirname,basename,join} from 'node:path';
import {ElicitRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = resolve('plugins/team-workspace-probe/dist/server.cjs');
// This is a protocol integration test client, never labelled as Desktop evidence.
test('real stdio process: discovery, nonce roundtrip, resource and safe output', async () => {
  const working = await mkdtemp(resolve(tmpdir(), 'team-workspace-probe-'));
  const client = new Client({name:'protocol-test-not-desktop', version:'1.0.0'}, {capabilities:{roots:{listChanged:false}}});
  const transport = new StdioClientTransport({command:process.execPath,args:[entry],cwd:working,stderr:'pipe'});
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t=>t.name).sort(), ['request_team_plan_start','record_team_plan_start','reconcile_team_review','reconcile_team_verification','consume_team_inbox','read_team_peer_message','read_team_source','prepare_team_command','read_team_command_log','register_team_native_attempts','wait_team_event','archive_team','update_team_member_goal','coordinate_team','manage_team','request_team_plan_feedback','team_leader','team_member','team_command','read_team_model_catalog','reconcile_team_stop','resume_team','amend_team_task_contract','read_member_team_work','claim_member_team_task','bind_member_team_task','report_member_team_task','read_team_plan','revise_team_plan','approve_team_plan','cancel_team_plan','propose_team_change','accept_team_review','add_team_members','add_team_tasks','begin_stop_trial','bind_team_member','bind_team_members','bind_team_roster_member','bind_team_roster_members','cancel_team_navigation','cancel_team_task','claim_team_task','claim_team_tasks','edit_team_task','finish_team','get_current_project','integrate_team','message_execution_probe','message_team_member','open_host_probe','open_team_workspace','pause_team_dispatch','plan_team','probe_roundtrip','read_execution_probe','read_team','read_team_handoff','read_team_navigation','rebuild_project_team','reconcile_team','reconcile_team_message','record_team_checkpoint','record_team_message_delivery','record_team_navigation','recover_team_integration','release_team_reservation','request_team_navigation','rework_team_task','settle_team_task','start_execution_probe','start_team','stop_execution_probe','stop_team','acknowledge_team_peer_message','advance_team_workflow','configure_team_policy','export_team_report','integrate_team_worktree','plan_team_from_profile','prepare_team_worktree','query_team_tasks','read_project_team_takeover','read_team_context','read_team_inbox','read_team_profiles','read_team_recovery','record_team_peer_delivery','record_team_recovery_control','save_team_profile','send_team_peer_message','read_team_usage','record_team_peer_sender_delivery','remove_team_member','reassign_team_task'].sort());
    assert.deepEqual(tools.find(t=>t.name==='record_team_navigation')._meta.ui.visibility,['app']);
    for(const name of ['request_team_plan_start','record_team_plan_start']){assert.deepEqual(tools.find(t=>t.name===name)._meta.ui.visibility,['app']);const rejected=await client.callTool({name:'team_leader',arguments:{operation:'describe',toolName:name}});assert.equal(rejected.isError,true);assert.match(rejected.content[0].text,/not available/);}
    const roleGoal=tools.find(t=>t.name==='update_team_member_goal');assert.deepEqual(roleGoal._meta.ui.visibility,['app']);assert.ok(roleGoal.inputSchema.required.includes('goalRevision'));assert.ok(roleGoal.inputSchema.required.includes('requestId'));assert.equal(roleGoal.inputSchema.properties.goal.maxLength,2000);
    assert.ok(tools.find(t=>t.name==='record_team_navigation').inputSchema.properties.status.enum.includes('host-accepted'));
    assert.ok(tools.find(t=>t.name==='request_team_navigation').inputSchema.properties.transport.enum.includes('open-link'));
    assert.deepEqual(tools.find(t=>t.name==='open_team_workspace')._meta['openai/ui'].entrypoints,[{type:'thread'}]);
    const addMembers=tools.find(t=>t.name==='add_team_members');
    assert.ok(tools.find(t=>t.name==='read_team').inputSchema.properties.view.enum.includes('panel'));
    assert.ok(addMembers.inputSchema.required.includes('requestId'));
    assert.equal(addMembers.inputSchema.properties.members.maxItems,8);
    assert.deepEqual(addMembers._meta.ui.visibility,['app']);
    assert.equal(tools.filter(t=>!t._meta?.ui?.visibility||t._meta.ui.visibility.includes('model')).length,6);const described=await client.callTool({name:'team_leader',arguments:{operation:'describe',toolName:'plan_team'}});assert.equal(described.structuredContent.inputSchema.properties.goal.type,'string');assert.equal(described.structuredContent.pluginVersion,packageInfo.version);assert.match(described.structuredContent.schemaHash,/^[a-f0-9]{64}$/);const schemaAgain=await client.callTool({name:'team_leader',arguments:{operation:'describe',toolName:'plan_team'}});assert.equal(schemaAgain.structuredContent.schemaHash,described.structuredContent.schemaHash);assert.equal(JSON.parse(described.content[0].text).payload,'structuredContent');assert.equal(JSON.parse(described.content[0].text).inputSchema,undefined);const cached=await client.callTool({name:'team_leader',arguments:{operation:'describe',toolName:'plan_team',schemaHash:described.structuredContent.schemaHash}});assert.equal(cached.structuredContent.unchanged,true);assert.equal(cached.structuredContent.inputSchema,undefined);const refresh=await client.callTool({name:'team_leader',arguments:{operation:'describe',toolName:'plan_team',schemaHash:'a'.repeat(64)}});assert.ok(refresh.structuredContent.inputSchema);const advanceSchema=await client.callTool({name:'team_leader',arguments:{operation:'describe',toolName:'advance_team_workflow'}});assert.equal(advanceSchema.structuredContent.inputSchema.properties.view.default,'coordination');
    const opened = await client.callTool({name:'open_host_probe',arguments:{},_meta:{'private-test-secret':'DO_NOT_LEAK'}});
    assert.equal(client.getServerVersion().version,packageInfo.version);
    assert.equal(opened.structuredContent.pluginVersion,packageInfo.version);
    assert.equal(tools.find(t=>t.name==='open_team_workspace')._meta.ui.resourceUri,`ui://team-workspace-probe/${packageInfo.version}/host.html`);
    assert.equal(tools.find(t=>t.name==='register_team_native_attempts').inputSchema.properties.dryRun.default,true);
    assert.equal(opened.structuredContent.client.name, 'protocol-test-not-desktop');
    assert.equal(opened.structuredContent.productReady,false);
    assert.equal(opened.structuredContent.agentExecution,'EXPERIMENTAL_FIXTURE_ONLY');
    assert.ok(opened.structuredContent.capabilityNames.includes('roots'));
    assert.ok(opened.structuredContent.metadataNames.includes('private-test-secret'));
    assert.ok(!JSON.stringify(opened).includes('DO_NOT_LEAK'));
    const nonce = randomUUID();
    const reply = await client.callTool({name:'probe_roundtrip',arguments:{nonce}});
    assert.equal(reply.structuredContent.nonce,nonce);
    assert.equal(reply.structuredContent.bootId,opened.structuredContent.bootId);
    const invalid = await client.callTool({name:'probe_roundtrip',arguments:{nonce:'invalid'}});
    assert.equal(invalid.isError,true);
    const { contents } = await client.readResource({uri:`ui://team-workspace-probe/${packageInfo.version}/host.html`});
    assert.equal(contents[0].mimeType,'text/html;profile=mcp-app');
    assert.deepEqual(contents[0]._meta['openai/ui'].availableDisplayModes,['fullscreen']);
    assert.ok(contents[0].text.includes('团队跟随当前对话'));
    assert.ok(!contents[0].text.includes('/*__BUNDLE__*/'));
    assert.deepEqual(await readdir(working),[]);
    assert.equal(stderr,'');
  } finally { await client.close(); await rmdir(working); }
});

test('EOF terminates the process without initialization or persistent daemon', {timeout:5000}, async () => {
  const processUnderTest = spawn(process.execPath,[entry],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const exited = once(processUnderTest,'exit');
  processUnderTest.stdin.end();
  const [code] = await exited;
  assert.equal(code,0);
});

test('conversation-first tools remove project picker and duplicate goal form',async()=>{
  const client=new Client({name:'conversation-flow-protocol-test',version:'1'}, {capabilities:{}});
  const transport=new StdioClientTransport({command:process.execPath,args:[entry],stderr:'pipe'});
  try{await client.connect(transport);const {tools}=await client.listTools();
    assert.equal(tools.some(t=>t.name==='select_team_project'),false);
    const plan=tools.find(t=>t.name==='plan_team');assert.equal('grantId' in plan.inputSchema.properties,false);assert.equal(plan.inputSchema.properties.execute.type,'boolean');
    assert.deepEqual(tools.find(t=>t.name==='start_team')._meta.ui.visibility,['app']);assert.ok(tools.find(t=>t.name==='team_leader')._meta.ui.visibility.includes('model'));
    const blocked=await client.callTool({name:'get_current_project',arguments:{}});assert.equal(blocked.isError,true);
    const unauthorizedAddition=await client.callTool({name:'add_team_members',arguments:{teamId:randomUUID(),revision:1,requestId:randomUUID(),members:[{id:'docs',role:'Docs',responsibility:'Documentation',reason:'New role',writeScopes:['docs']}]}});
    assert.equal(unauthorizedAddition.isError,true);assert.match(unauthorizedAddition.content[0].text,/host conversation identity/);
    const resource=await client.readResource({uri:`ui://team-workspace-probe/${packageInfo.version}/host.html`});
    for(const control of ['id="chooseProject"','id="projectSelect"','id="teamGoal"','id="planTeam"'])assert.equal(resource.contents[0].text.includes(control),false);
  }finally{await client.close();}
});
