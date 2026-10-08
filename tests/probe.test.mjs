import test from 'node:test';
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
    assert.deepEqual(tools.map(t=>t.name).sort(), ['read_team_model_catalog','reconcile_team_stop','resume_team','amend_team_task_contract','read_member_team_work','claim_member_team_task','bind_member_team_task','report_member_team_task','read_team_plan','revise_team_plan','approve_team_plan','cancel_team_plan','propose_team_change','accept_team_review','add_team_members','add_team_tasks','begin_stop_trial','bind_team_member','bind_team_members','bind_team_roster_member','bind_team_roster_members','cancel_team_navigation','cancel_team_task','claim_team_task','claim_team_tasks','edit_team_task','finish_team','get_current_project','integrate_team','message_execution_probe','message_team_member','open_host_probe','open_team_workspace','pause_team_dispatch','plan_team','probe_roundtrip','read_execution_probe','read_team','read_team_handoff','read_team_navigation','rebuild_project_team','reconcile_team','reconcile_team_message','record_team_checkpoint','record_team_message_delivery','record_team_navigation','recover_team_integration','release_team_reservation','request_team_navigation','rework_team_task','settle_team_task','start_execution_probe','start_team','stop_execution_probe','stop_team','acknowledge_team_peer_message','advance_team_workflow','configure_team_policy','export_team_report','integrate_team_worktree','plan_team_from_profile','prepare_team_worktree','query_team_tasks','read_project_team_takeover','read_team_context','read_team_inbox','read_team_profiles','read_team_recovery','record_team_peer_delivery','record_team_recovery_control','save_team_profile','send_team_peer_message','read_team_usage','record_team_peer_sender_delivery','remove_team_member','reassign_team_task'].sort());
    assert.deepEqual(tools.find(t=>t.name==='record_team_navigation')._meta.ui.visibility,['model']);
    assert.deepEqual(tools.find(t=>t.name==='open_team_workspace')._meta['openai/ui'].entrypoints,[{type:'thread'}]);
    const addMembers=tools.find(t=>t.name==='add_team_members');
    assert.ok(tools.find(t=>t.name==='read_team').inputSchema.properties.view.enum.includes('panel'));
    assert.ok(addMembers.inputSchema.required.includes('requestId'));
    assert.equal(addMembers.inputSchema.properties.members.maxItems,8);
    assert.deepEqual(addMembers._meta.ui.visibility,['model']);
    const opened = await client.callTool({name:'open_host_probe',arguments:{},_meta:{'private-test-secret':'DO_NOT_LEAK'}});
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
    const { contents } = await client.readResource({uri:'ui://team-workspace-probe/0.12.0/host.html'});
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
    assert.ok(tools.find(t=>t.name==='start_team')._meta.ui.visibility.includes('model'));
    const blocked=await client.callTool({name:'get_current_project',arguments:{}});assert.equal(blocked.isError,true);
    const unauthorizedAddition=await client.callTool({name:'add_team_members',arguments:{teamId:randomUUID(),revision:1,requestId:randomUUID(),members:[{id:'docs',role:'Docs',responsibility:'Documentation',reason:'New role',writeScopes:['docs']}]}});
    assert.equal(unauthorizedAddition.isError,true);assert.match(unauthorizedAddition.content[0].text,/host conversation identity/);
    const resource=await client.readResource({uri:'ui://team-workspace-probe/0.12.0/host.html'});
    for(const control of ['id="chooseProject"','id="projectSelect"','id="teamGoal"','id="planTeam"'])assert.equal(resource.contents[0].text.includes(control),false);
  }finally{await client.close();}
});
