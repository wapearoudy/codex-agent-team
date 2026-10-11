import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HostBridge} from '../src/host-bridge.mjs';
import {sanitizeThread,normalizeDshSession,normalizeOpenCodeSession} from '../src/host-normalize.mjs';
import {handleHook} from '../integrations/claude-code/hooks/bridge.mjs';
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
  try{const path=join(project,'agent-child.jsonl'),row=(id,type,content)=>JSON.stringify({uuid:id,sessionId:'leader',agentId:'child',cwd,type,message:{role:type==='assistant'?'assistant':'user',content,stop_reason:type==='assistant'?'end_turn':null}});await writeFile(path,row('new-user','user','new task')+'\n'+row('new-assistant','assistant','new report')+'\n');await bridge.registerClaudeTranscript('child',path);assert.equal((await bridge.readThread('child')).turns.at(-1).status,'unknown');await handleHook({...base,hook_event_name:'PostToolUse',tool_name:'Agent',tool_response:{agentId:'child',task_id:'new-task',isAsync:true}},{bridge});await handleHook({...base,hook_event_name:'PostToolUse',tool_name:'TaskOutput',tool_response:{task:{task_id:'new-task',status:'completed'}}},{bridge});assert.equal((await bridge.readThread('child')).turns.at(-1).status,'completed');await writeFile(path,row('third-user','user','later request')+'\n'+row('third-assistant','assistant','later report')+'\n');assert.equal((await bridge.readThread('child')).turns.at(-1).status,'unknown');}finally{if(prior===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=prior;}
});
