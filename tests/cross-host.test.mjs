import test from 'node:test';
import {observedNativeTools,observedNativeMembers} from '../integrations/deepseek-harness/index.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HostBridge} from '../src/host-bridge.mjs';
import {sanitizeThread,normalizeDshSession,normalizeOpenCodeSession} from '../src/host-normalize.mjs';
import {handleHook} from '../integrations/claude-code/hooks/bridge.mjs';
import {matchesNativeHookTurn} from '../integrations/claude-code/verify-live.mjs';
const temporary=()=>mkdtemp(join(tmpdir(),'team-host-'));
async function fixture(host='opencode',options={}){const cwd=await temporary(),bridge=new HostBridge({host,root:join(cwd,'bridge'),...options});await bridge.putThread({id:'leader',cwd,parentThreadId:null,turns:[]});return {cwd,bridge};}
test('native tickets bind exact session and tool, expire and consume atomically',async()=>{
  let now=100;const {cwd,bridge}=await fixture('opencode',{now:()=>now,ticketTtlMs:10}),other=new HostBridge({host:'opencode',root:bridge.root,now:()=>now});
  await assert.rejects(bridge.issueContext('model-chosen','read_team'),/unavailable/);await assert.rejects(bridge.authenticate(undefined,'read_team'),/required/);
  const ticket=await bridge.issueContext('leader','read_team');await assert.rejects(bridge.authenticate(ticket,'team_command'),/mismatched/);
  const race=await Promise.allSettled([bridge.authenticate(ticket,'read_team'),other.authenticate(ticket,'read_team')]);assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.deepEqual(race.find(r=>r.status==='fulfilled').value,{threadId:'leader'});
  const expired=await bridge.issueContext('leader','read_team');now=111;await assert.rejects(bridge.authenticate(expired,'read_team'),/expired/);
  await assert.rejects(bridge.putThread({id:'leader',cwd,parentThreadId:'attacker',turns:[]}),/cannot be changed/);
});
test('unchanged native snapshots do not trigger registry write loops',async()=>{const {bridge}=await fixture();const thread=await bridge.readThread('leader'),before=(await stat(bridge.file)).mtimeMs;await bridge.putThread(thread);assert.equal((await stat(bridge.file)).mtimeMs,before);});
test('public normalization removes reasoning and credentials and preserves observer content arrays',()=>{
  const t=sanitizeThread({id:'child',cwd:process.cwd(),parentThreadId:'leader',apiKey:'hidden',turns:[{id:'1',status:'interrupted',items:[{type:'userMessage',content:'PROMPT'},{type:'reasoning',text:'hidden thoughts'},{type:'agentMessage',text:'{"result":"PASS"}',phase:'final_answer'},{type:'commandExecution',commandId:'cmd1',command:'echo api_key=abc',aggregatedOutput:'Bearer abc123',status:'completed',exitCode:0}]}]});
  assert.equal(t.turns[0].status,'unknown');assert.deepEqual(t.turns[0].items[0].content,[{type:'text',text:'PROMPT'}]);assert.equal(t.turns[0].items[1].text,'{"result":"PASS"}');assert.ok(!JSON.stringify(t).includes('hidden'));assert.ok(!JSON.stringify(t).includes('abc123'));
});
test('DSH native turn-end alone establishes terminal cancellation; abort receipt does not',()=>{
  const session={id:'child',header:{cwd:process.cwd(),parentSession:'leader',createdAt:1},inheritedEventCount:0,isOwnSeq:()=>true,requestHeader:()=>({config:{},tools:[{name:'subagent',parameters:{type:'object'}}]})};
  const events=[{seq:0,type:'turn/start',data:{turn:7}},{seq:1,type:'user/message',data:{id:'prompt',content:[{type:'text',text:'CONTRACT'}]}},{seq:2,type:'assistant/message',data:{turn:7,message:{id:'m1',content:[{type:'reasoning',text:'SECRET'},{type:'text',text:'Working'}]},usage:{inputTokens:3,outputTokens:4}}}];
  assert.equal(normalizeDshSession(session,events).turns[0].status,'inProgress');assert.equal(normalizeDshSession(session,events).nativeTools[0].name,'subagent');
  events.push({seq:3,type:'turn/end',data:{turn:7,reason:{kind:'aborted'}}});const stopped=normalizeDshSession(session,events);assert.equal(stopped.turns[0].status,'interrupted');assert.equal(stopped.turns[0].statusEvidence.source,'persisted-turn-aborted');assert.equal(stopped.turns[0].items[0].content[0].text,'CONTRACT');assert.ok(!JSON.stringify(stopped).includes('SECRET'));
});
test('DSH pre-request capabilities require exact native session and honor the request header',()=>{
  const session={id:'native',requestHeader:()=>({tools:[]})},agent={id:'native',session},tools=[{name:'spawn_teammate',description:'Native host delegation',parameters:{name:{type:'string',required:true}}}];
  const ctx={agents:{get:()=>agent},tools:{wireSchemas:scope=>{assert.equal(scope,agent);return {schemas:tools};}}};
  assert.deepEqual(observedNativeTools(ctx,session),tools);
  assert.deepEqual(observedNativeTools({...ctx,agents:{get:()=>({...agent,session:{id:'native'}})}},session),[]);
  assert.deepEqual(observedNativeTools({...ctx,tools:{wireSchemas:()=>{throw new Error('host unavailable');}}},session),[]);
  session.requestHeader=()=>({tools:[{name:'native-header-tool',parameters:{}}]});
  assert.equal(observedNativeTools(ctx,session)[0].name,'native-header-tool');
});
test('DSH native roster maps verified targets and excludes provisioning and diagnostics',()=>{
  const session={id:'lead'},agent={id:'lead',session},ctx={agents:{get:()=>agent},agentTeams:{listMembers:scope=>{assert.equal(scope,agent);return [{id:'lead',name:'lead',status:'running'},{id:'child-id',name:'member',status:'inactive',diagnostics:['private']},{id:'not-started',name:'pending',status:'provisioning'},{id:'failed-id',name:'failed',status:'failed'}];}}};
  assert.deepEqual(observedNativeMembers(ctx,session),[{id:'lead',target:'lead'},{id:'child-id',target:'member'}]);
  const optional={...ctx,get:key=>{assert.equal(key,'agentTeams');return ctx.agentTeams;}};Object.defineProperty(optional,'agentTeams',{get(){throw new Error('Undeclared service property');}});
  assert.deepEqual(observedNativeMembers(optional,session),[{id:'lead',target:'lead'},{id:'child-id',target:'member'}]);
  assert.deepEqual(observedNativeMembers({...ctx,get:()=>undefined},session),[]);
  assert.deepEqual(observedNativeMembers({...ctx,agents:{get:()=>({...agent,session:{id:'lead'}})}},session),[]);
});
test('OpenCode persisted messages determine status; idle and incomplete output remain unknown',()=>{
  const info={id:'child',directory:process.cwd(),parentID:'leader',time:{created:1}},messages=[{info:{id:'u',role:'user'},parts:[{type:'text',text:'contract'}]},{info:{id:'a',parentID:'u',role:'assistant',time:{created:2}},parts:[{type:'reasoning',text:'hidden'},{type:'text',text:'working'}]}];
  assert.equal(normalizeOpenCodeSession(info,messages,{type:'idle'}).turns[0].status,'unknown');messages[1].info.error={name:'MessageAbortedError'};assert.equal(normalizeOpenCodeSession(info,messages).turns[0].status,'interrupted');
});
test('Claude blocked Stop is unknown; exact structured TaskOutput receipt commits child completion',async()=>{
  const {cwd,bridge}=await fixture('claude-code'),base={session_id:'leader',cwd};
  await handleHook({...base,hook_event_name:'SubagentStart',agent_id:'child'},{bridge});
  await handleHook({...base,hook_event_name:'SubagentStop',agent_id:'child',last_assistant_message:'{"result":"PASS"}'},{bridge});
  assert.equal((await bridge.readThread('child')).turns.at(-1).status,'unknown');
  await handleHook({...base,hook_event_name:'PostToolUse',tool_name:'Agent',tool_response:{agentId:'child',task_id:'task-real',isAsync:true}},{bridge});
  await handleHook({...base,hook_event_name:'PostToolUse',tool_name:'TaskStop',tool_input:{task_id:'task-real'},tool_response:{status:'success'}},{bridge});assert.equal((await bridge.readThread('child')).turns.at(-1).status,'unknown');
  await handleHook({...base,hook_event_name:'PostToolUse',tool_name:'TaskOutput',tool_response:{retrieval_status:'success',task:{task_id:'task-real',status:'completed'}}},{bridge});
  const completed=await bridge.readThread('child');assert.equal(completed.turns.at(-1).status,'completed');assert.equal(completed.turns.at(-1).statusEvidence.source,'native-task-receipt');
  await handleHook({...base,hook_event_name:'SubagentStop',agent_id:'child',last_assistant_message:'{"result":"PASS"}'},{bridge});assert.equal((await bridge.readThread('child')).turns.at(-1).status,'completed');
  await assert.rejects(handleHook({...base,hook_event_name:'PreToolUse',agent_id:'unregistered',tool_name:'mcp__team-workspace__read_team',tool_input:{}},{bridge}),/first be observed/);
});
test('Claude hook issues native ticket; MCP model identity cannot override caller',async()=>{
  const {cwd,bridge}=await fixture('claude-code');const result=await handleHook({session_id:'leader',cwd,hook_event_name:'PreToolUse',tool_name:'mcp__team-workspace__read_team',tool_input:{threadId:'attacker',_hostTicket:'model-ticket'}},{bridge});
  assert.notEqual(result.hookSpecificOutput.updatedInput._hostTicket,'model-ticket');assert.deepEqual(await bridge.authenticate(result.hookSpecificOutput.updatedInput._hostTicket,'read_team'),{threadId:'leader'});
});

test('Claude modern Agent receipt works without task_id; foreground commits and background stays active',async()=>{
  const {cwd,bridge}=await fixture('claude-code'),base={session_id:'leader',cwd};
  await handleHook({...base,hook_event_name:'SubagentStart',agent_id:'child'},{bridge});
  await handleHook({...base,hook_event_name:'PostToolUse',tool_name:'Agent',tool_use_id:'launch-real',tool_response:{agentId:'child',status:'async_launched',outputFile:'host-output'}},{bridge});
  assert.equal((await bridge.store.read()).claudeLaunches['launch-real'].agentId,'child');
  assert.equal((await bridge.readThread('child')).turns.at(-1).status,'inProgress');
  await handleHook({...base,hook_event_name:'PostToolUse',tool_name:'Agent',tool_response:{agentId:'child',status:'completed',content:[{type:'text',text:'actual foreground'}]}},{bridge});
  assert.equal((await bridge.readThread('child')).turns.at(-1).status,'completed');
  await handleHook({...base,hook_event_name:'PreToolUse',tool_name:'SendMessage',tool_use_id:'resume-real',tool_input:{to:'child',message:'continue'}},{bridge});
  assert.equal((await bridge.readThread('child')).turns.at(-1).status,'unknown');
  await handleHook({...base,hook_event_name:'PostToolUse',tool_name:'SendMessage',tool_use_id:'resume-real',tool_response:{success:true}},{bridge});
  assert.equal((await bridge.readThread('child')).turns.at(-1).id,'resume-real');
  assert.equal((await bridge.readThread('child')).turns.at(-1).status,'inProgress');
});

test('Claude registered native task notifications bind exact launch and do not settle a resumed turn from old task',async()=>{
  const {cwd,bridge}=await fixture('claude-code'),config=join(cwd,'claude'),project=join(config,'projects','native');await mkdir(project,{recursive:true});const previous=process.env.CLAUDE_CONFIG_DIR;process.env.CLAUDE_CONFIG_DIR=config;
  try {
    const base={session_id:'leader',cwd},path=join(project,'leader.jsonl');await writeFile(path,'');
    await handleHook({...base,hook_event_name:'SessionStart',transcript_path:path},{bridge});
    await handleHook({...base,hook_event_name:'SubagentStart',agent_id:'child'},{bridge});
    await handleHook({...base,hook_event_name:'PostToolUse',tool_name:'Agent',tool_use_id:'launch',tool_response:{agentId:'child',status:'async_launched'}},{bridge});
    const rows=[{type:'system',subtype:'task_started',session_id:'leader',task_id:'real-task',tool_use_id:'launch'},{type:'system',subtype:'task_notification',session_id:'leader',task_id:'real-task',status:'completed'}];await writeFile(path,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
    assert.equal((await bridge.readThread('child')).turns.at(-1).status,'completed');
    await handleHook({...base,hook_event_name:'PreToolUse',tool_name:'SendMessage',tool_use_id:'new-launch',tool_input:{to:'child',message:'resume'}},{bridge});
    await handleHook({...base,hook_event_name:'PostToolUse',tool_name:'SendMessage',tool_use_id:'new-launch',tool_response:{success:true}},{bridge});
    assert.equal((await bridge.readThread('child')).turns.at(-1).status,'inProgress');
    rows.push({type:'system',subtype:'task_started',session_id:'wrong-parent',task_id:'wrong-task',tool_use_id:'new-launch'},{type:'system',subtype:'task_notification',session_id:'wrong-parent',task_id:'wrong-task',status:'completed'});await writeFile(path,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
    assert.equal((await bridge.readThread('child')).turns.at(-1).status,'inProgress');
    rows.push({type:'system',subtype:'task_started',session_id:'leader',task_id:'new-task',tool_use_id:'new-launch'},{type:'system',subtype:'task_updated',session_id:'leader',task_id:'new-task',patch:{status:'stopped'}});await writeFile(path,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
    assert.equal((await bridge.readThread('child')).turns.at(-1).status,'interrupted');
    assert.equal((await bridge.readThread('child')).turns.at(-1).statusEvidence.source,'persisted-native-task-stop');
    await bridge.putThread(await bridge.readThread('child'));
    assert.equal((await bridge.readThread('child')).turns.at(-1).status,'interrupted');
  } finally {if(previous===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=previous;}
});
test('Claude stop verification follows the exact native hook through its transcript identity mapping',()=>{
  assert.equal(matchesNativeHookTurn({id:'stop-launch'},{hookTurnId:'stop-launch',linkedTranscriptTurnId:null},'stop-launch'),true);
  assert.equal(matchesNativeHookTurn({id:'interrupt-transcript'},{hookTurnId:'stop-launch',linkedTranscriptTurnId:'interrupt-transcript'},'stop-launch'),true);
  assert.equal(matchesNativeHookTurn({id:'old-transcript'},{hookTurnId:'stop-launch',linkedTranscriptTurnId:'interrupt-transcript'},'stop-launch'),false);
  assert.equal(matchesNativeHookTurn({id:'interrupt-transcript'},{hookTurnId:'new-launch',linkedTranscriptTurnId:'interrupt-transcript'},'stop-launch'),false);
  assert.equal(matchesNativeHookTurn(undefined,undefined,undefined),false);
});
test('Claude Agent receipt waits for the concurrent native SubagentStart registration',async()=>{
  const {cwd,bridge}=await fixture('claude-code'),base={session_id:'leader',cwd};
  await handleHook({...base,hook_event_name:'SessionStart'},{bridge});
  const receipt=handleHook({...base,hook_event_name:'PostToolUse',tool_name:'Agent',tool_use_id:'concurrent-launch',tool_response:{agentId:'child',isAsync:true,status:'async_launched'}},{bridge});
  const registration=new Promise((resolve,reject)=>setTimeout(()=>handleHook({...base,hook_event_name:'SubagentStart',agent_id:'child'},{bridge}).then(resolve,reject),50));
  const outcomes=await Promise.allSettled([receipt,registration]);for(const outcome of outcomes)assert.equal(outcome.status,'fulfilled',outcome.reason?.message);
  const registry=await bridge.store.read();assert.equal(registry.claudeLaunches['concurrent-launch'].agentId,'child');assert.equal(registry.claudeLaunches['concurrent-launch'].hookTurnId,registry.claudeHookTurns.child.hookTurnId);
  assert.equal((await bridge.readThread('child')).parentThreadId,'leader');
});
test('Claude persisted session-task notification commits only its exact native launch',async()=>{
  const {cwd,bridge}=await fixture('claude-code'),config=join(cwd,'claude'),project=join(config,'projects','native');await mkdir(project,{recursive:true});const previous=process.env.CLAUDE_CONFIG_DIR;process.env.CLAUDE_CONFIG_DIR=config;
  try {
    const base={session_id:'leader',cwd},path=join(project,'leader.jsonl');await writeFile(path,'');
    await handleHook({...base,hook_event_name:'SessionStart',transcript_path:path},{bridge});
    await handleHook({...base,hook_event_name:'SubagentStart',agent_id:'child'},{bridge});
    await handleHook({...base,hook_event_name:'PostToolUse',tool_name:'Agent',tool_use_id:'launch',tool_response:{agentId:'child',status:'async_launched'}},{bridge});
    const notification=(uuid,toolUseId,status,overrides={})=>({uuid,type:'user',sessionId:'leader',cwd,origin:{kind:'task-notification',producer:'session-task'},promptSource:'system',turnOrigin:'task_notification',message:{role:'user',content:`<task-notification>\n<task-id>child</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<result>done</result>\n</task-notification>`},...overrides});
    const rows=[notification('forged','launch','completed',{origin:undefined,promptSource:'user',turnOrigin:undefined}),notification('wrong-parent','launch','completed',{sessionId:'other'}),notification('unknown-launch','not-launched','completed')];
    const persist=()=>writeFile(path,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');await persist();
    assert.equal((await bridge.readThread('child')).turns.at(-1).status,'inProgress');
    rows.push(notification('initial-terminal','launch','completed'));await persist();
    const initial=await bridge.readThread('child');assert.equal(initial.turns.at(-1).status,'completed');assert.equal(initial.turns.at(-1).statusEvidence.source,'native-task-receipt');
    await handleHook({...base,hook_event_name:'PreToolUse',tool_name:'SendMessage',tool_use_id:'resume',tool_input:{to:'child',message:'resume'}},{bridge});
    await handleHook({...base,hook_event_name:'PostToolUse',tool_name:'SendMessage',tool_use_id:'resume',tool_response:{success:true}},{bridge});
    await handleHook({...base,hook_event_name:'SubagentStart',agent_id:'child'},{bridge});
    assert.equal((await bridge.readThread('child')).turns.at(-1).status,'inProgress');
    rows.push(notification('resume-terminal','resume','completed'));await persist();
    const resumed=await bridge.readThread('child');assert.equal(resumed.turns.at(-1).id,'resume');assert.equal(resumed.turns.at(-1).status,'completed');
    await handleHook({...base,hook_event_name:'PreToolUse',tool_name:'SendMessage',tool_use_id:'stop-round',tool_input:{to:'child',message:'wait'}},{bridge});
    await handleHook({...base,hook_event_name:'PostToolUse',tool_name:'SendMessage',tool_use_id:'stop-round',tool_response:{success:true}},{bridge});
    await handleHook({...base,hook_event_name:'SubagentStart',agent_id:'child'},{bridge});
    assert.equal((await bridge.readThread('child')).turns.at(-1).status,'inProgress');
    rows.push(notification('stop-terminal','stop-round','stopped'));await persist();
    const stopped=await bridge.readThread('child');assert.equal(stopped.turns.at(-1).id,'stop-round');assert.equal(stopped.turns.at(-1).status,'interrupted');assert.equal(stopped.turns.at(-1).statusEvidence.source,'persisted-native-task-stop');
  } finally {if(previous===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=previous;}
});
test('Claude transcript refresh preserves the exact hook turn in progress and prior terminal history',async()=>{
  const {cwd,bridge}=await fixture('claude-code'),config=join(cwd,'claude'),project=join(config,'projects','native','leader','subagents');await mkdir(project,{recursive:true});const previous=process.env.CLAUDE_CONFIG_DIR;process.env.CLAUDE_CONFIG_DIR=config;
  try {
    const base={session_id:'leader',cwd},path=join(project,'agent-child.jsonl');
    await handleHook({...base,hook_event_name:'SubagentStart',agent_id:'child'},{bridge});
    const row=(uuid,type,content)=>JSON.stringify({uuid,type,sessionId:'leader',agentId:'child',cwd,message:{role:type,content,stop_reason:type==='assistant'?'end_turn':null}});
    const rows=[row('initial-user','user','first'),row('initial-output','assistant','done')];await writeFile(path,rows.join('\n')+'\n');await bridge.registerClaudeTranscript('child',path);
    await handleHook({...base,hook_event_name:'PostToolUse',tool_name:'Agent',tool_use_id:'initial-launch',tool_response:{agentId:'child',isAsync:false}},{bridge});
    assert.equal((await bridge.readThread('child')).turns.at(-1).status,'completed');
    await handleHook({...base,hook_event_name:'PreToolUse',tool_name:'SendMessage',tool_use_id:'resume-launch',tool_input:{to:'child',message:'run'}},{bridge});
    await handleHook({...base,hook_event_name:'PostToolUse',tool_name:'SendMessage',tool_use_id:'resume-launch',tool_response:{success:true}},{bridge});
    await handleHook({...base,hook_event_name:'SubagentStart',agent_id:'child'},{bridge});
    rows.push(row('resume-user','user','run'));await writeFile(path,rows.join('\n')+'\n');
    await handleHook({...base,agent_id:'child',hook_event_name:'PreToolUse',tool_name:'Bash',tool_use_id:'active-command',tool_input:{command:'node -e "setTimeout(()=>{},60000)"'}},{bridge});
    const active=await bridge.readThread('child');assert.equal(active.turns.at(-1).id,'resume-user');assert.equal(active.turns.at(-1).status,'inProgress');assert.equal(active.turns.at(-1).items.find(i=>i.commandId==='active-command').status,'inProgress');
    assert.equal(active.turns[0].status,'completed');assert.equal(active.turns[0].statusEvidence.source,'native-task-receipt');
    const repeat=await bridge.readThread('child');assert.equal(repeat.turns.at(-1).status,'inProgress');assert.equal(repeat.turns[0].status,'completed');
  } finally {if(previous===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=previous;}
});
test('Claude authorized transcript refresh stays unknown without committed receipt',async()=>{
  const {cwd,bridge}=await fixture('claude-code'),config=join(cwd,'claude'),project=join(config,'projects','native');await mkdir(project,{recursive:true});const previous=process.env.CLAUDE_CONFIG_DIR;process.env.CLAUDE_CONFIG_DIR=config;
  try{const path=join(project,'leader.jsonl');await writeFile(path,JSON.stringify({uuid:'u',sessionId:'leader',cwd,type:'user',message:{role:'user',content:'task'}})+'\n'+JSON.stringify({uuid:'a',sessionId:'leader',cwd,type:'assistant',message:{role:'assistant',model:'actual-model',stop_reason:'end_turn',content:[{type:'thinking',thinking:'secret'},{type:'text',text:'done'}]}})+'\n');await bridge.registerClaudeTranscript('leader',path);const t=await bridge.readThread('leader');assert.equal(t.turns[0].status,'unknown');assert.equal(t.model,'actual-model');assert.ok(!JSON.stringify(t).includes('secret'));await assert.rejects(bridge.registerClaudeTranscript('leader',join(project,'other.jsonl')),/identity mismatch/);}finally{if(previous===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=previous;}
});
test('Claude resume cannot inherit previous receipt or transcript completion',async()=>{
  const {cwd,bridge}=await fixture('claude-code'),base={session_id:'leader',cwd};
  await handleHook({...base,hook_event_name:'SubagentStart',agent_id:'child'},{bridge});await handleHook({...base,hook_event_name:'PostToolUse',tool_name:'Agent',tool_response:{agentId:'child',task_id:'old-task',isAsync:true}},{bridge});await handleHook({...base,hook_event_name:'PostToolUse',tool_name:'TaskOutput',tool_response:{task:{task_id:'old-task',status:'completed'}}},{bridge});assert.equal((await bridge.readThread('child')).turns.at(-1).status,'completed');
  await handleHook({...base,hook_event_name:'SubagentStart',agent_id:'child'},{bridge});assert.equal((await bridge.readThread('child')).turns.at(-1).status,'inProgress');
  await handleHook({...base,hook_event_name:'PostToolUse',tool_name:'TaskOutput',tool_response:{task:{task_id:'old-task',status:'completed'}}},{bridge});assert.equal((await bridge.readThread('child')).turns.at(-1).status,'inProgress');
  const config=join(cwd,'claude'),project=join(config,'projects','native','leader','subagents');await mkdir(project,{recursive:true});const prior=process.env.CLAUDE_CONFIG_DIR;process.env.CLAUDE_CONFIG_DIR=config;
  try{const path=join(project,'agent-child.jsonl'),row=(id,type,content)=>JSON.stringify({uuid:id,sessionId:'leader',agentId:'child',cwd,type,message:{role:type==='assistant'?'assistant':'user',content,stop_reason:type==='assistant'?'end_turn':null}});await writeFile(path,row('new-user','user','new task')+'\n'+row('new-assistant','assistant','new report')+'\n');await bridge.registerClaudeTranscript('child',path);const pending=await bridge.readThread('child');assert.equal(pending.turns.at(-1).status,'inProgress');assert.notEqual(pending.turns.at(-1).statusEvidence?.source,'native-task-receipt');await handleHook({...base,hook_event_name:'PostToolUse',tool_name:'Agent',tool_response:{agentId:'child',task_id:'new-task',isAsync:true}},{bridge});await handleHook({...base,hook_event_name:'PostToolUse',tool_name:'TaskOutput',tool_response:{task:{task_id:'new-task',status:'completed'}}},{bridge});assert.equal((await bridge.readThread('child')).turns.at(-1).status,'completed');await writeFile(path,row('third-user','user','later request')+'\n'+row('third-assistant','assistant','later report')+'\n');assert.equal((await bridge.readThread('child')).turns.at(-1).status,'unknown');}finally{if(prior===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=prior;}
});
