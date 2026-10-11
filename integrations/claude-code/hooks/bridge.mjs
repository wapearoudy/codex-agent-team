import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {HostBridge} from '../../../src/host-bridge.mjs';
import {compactNames} from '../../common/names.mjs';
import {publicText} from '../../../src/host-normalize.mjs';
export async function handleHook(input,{bridge=new HostBridge({host:'claude-code'})}={}){
  if(!input.session_id||!input.cwd)throw new Error('Claude native session and cwd required');const event=input.hook_event_name,isChildEvent=['SubagentStart','SubagentStop'].includes(event),id=input.agent_id??input.session_id;
  let parent;try{parent=await bridge.readThread(input.session_id);}catch(error){if(error.code!=='HOST_SESSION_UNAVAILABLE')throw error;parent=await bridge.putThread({id:input.session_id,cwd:input.cwd,parentThreadId:null,turns:[]});}
  if(input.transcript_path)await bridge.registerClaudeTranscript(input.session_id,input.transcript_path).catch(e=>{if(e.code!=='ENOENT')throw e;});
  let thread;try{thread=await bridge.readThread(id);}catch(error){if(error.code!=='HOST_SESSION_UNAVAILABLE')throw error;if(id!==input.session_id&&!isChildEvent)throw new Error('Subagent must first be observed by SubagentStart');thread={id,cwd:input.cwd,parentThreadId:id===input.session_id?null:input.session_id,turns:[]};}
  if(event==='SubagentStart'||event==='UserPromptSubmit'){const baseline=thread.turns.at(-1)?.id??null,hookTurnId=input.tool_use_id??randomUUID();thread.turns.push({id:hookTurnId,status:'inProgress',items:input.prompt?[{type:'userMessage',content:input.prompt}]:[]});await bridge.store.transaction(d=>{d.claudeHookTurns??={};d.claudeHookTurns[id]={hookTurnId,baselineTranscriptTurnId:baseline,linkedTranscriptTurnId:null,receiptTurnId:null};});}
  const turn=thread.turns.at(-1)??{id:input.tool_use_id??randomUUID(),status:'unknown',items:[]};if(!thread.turns.length)thread.turns.push(turn);
  if(['SubagentStop','Stop'].includes(event)){if(typeof input.last_assistant_message==='string')turn.items.push({type:'agentMessage',text:input.last_assistant_message,phase:'final_answer'});if(turn.statusEvidence?.source!=='native-task-receipt'){turn.status='unknown';turn.statusEvidence={status:'unknown',source:'native-stop-hook-awaiting-receipt'};}}
  if(input.tool_name==='Bash'&&event==='PreToolUse')turn.items.push({type:'commandExecution',commandId:input.tool_use_id,cwd:input.cwd,command:input.tool_input?.command??'',status:'inProgress',aggregatedOutput:''});
  if(input.tool_name==='Bash'&&['PostToolUse','PostToolUseFailure'].includes(event)){const item=turn.items.find(i=>i.type==='commandExecution'&&i.commandId===input.tool_use_id);if(item){const r=input.tool_response??{};item.status=event==='PostToolUseFailure'?'failed':'completed';item.exitCode=r.exitCode??r.exit_code??null;item.aggregatedOutput=publicText(typeof r==='string'?r:[r.stdout,r.stderr].filter(Boolean).join('\n'));}}
  if(input.tool_name==='SubagentHandback'&&event==='PostToolUse')turn.items.push({type:'agentMessage',text:input.tool_input?.message??'',phase:'final_answer'});
  // TaskStop receipts prove only that cancellation was requested.
  await bridge.putThread(thread);
  if(event==='PostToolUse'&&['Agent','TaskOutput'].includes(input.tool_name)){
    const r=input.tool_response??{},task=r.task??r,taskId=task.task_id??r.task_id,agentId=task.agentId??task.agent_id??r.agentId??r.agent_id;
    if(input.tool_name==='Agent'&&agentId&&taskId){const child=await bridge.readThread(agentId);if(child.parentThreadId!==input.session_id)throw new Error('Claude launch receipt parent mismatch');await bridge.store.transaction(d=>{d.claudeTasks??={};d.claudeTasks[taskId]={agentId,parentId:input.session_id,hookTurnId:d.claudeHookTurns?.[agentId]?.hookTurnId??null};});}
    const registry=await bridge.store.read(),binding=taskId?registry.claudeTasks?.[taskId]:null;
    const childId=agentId??binding?.agentId;
    // Only structured committed receipts count. A stop hook or prose summary
    // cannot establish lifecycle completion, and task IDs are never guessed.
    const terminal=task.status==='completed'||task.status==='failed';
    const foreground=input.tool_name==='Agent'&&agentId&&r.isAsync===false;
    const currentHookTurn=childId?registry.claudeHookTurns?.[childId]?.hookTurnId:null;
    const sameAttempt=input.tool_name==='Agent'||binding?.hookTurnId&&binding.hookTurnId===currentHookTurn;
    if(childId&&sameAttempt&&(terminal||foreground)){
      const child=await bridge.readThread(childId);if(child.parentThreadId!==input.session_id||binding&&binding.parentId!==input.session_id)throw new Error('Claude terminal receipt parent mismatch');
      const last=child.turns.at(-1);if(last){last.status=task.status==='failed'?'failed':'completed';last.statusEvidence={status:last.status,source:'native-task-receipt'};await bridge.store.transaction(d=>{const state=d.claudeHookTurns?.[childId];if(state)state.receiptTurnId=state.hookTurnId;});await bridge.putThread(child);}
    }
  }
  if(isChildEvent&&id!==parent.id){const pturn=parent.turns.at(-1)??{id:randomUUID(),status:'unknown',items:[]};if(!parent.turns.length)parent.turns.push(pturn);if(!pturn.items.some(i=>i.agentThreadId===id))pturn.items.push({type:'subAgentActivity',agentThreadId:id});await bridge.putThread(parent);}
  if(event==='SubagentStop'&&input.agent_transcript_path)await bridge.registerClaudeTranscript(id,input.agent_transcript_path).catch(e=>{if(e.code!=='ENOENT')throw e;});
  if(event==='PreToolUse'&&input.tool_name?.startsWith('mcp__team-workspace__')){const name=input.tool_name.slice('mcp__team-workspace__'.length);if(!compactNames.has(name))throw new Error('Unsupported Team Workspace tool');return {hookSpecificOutput:{hookEventName:'PreToolUse',updatedInput:{...input.tool_input,_hostTicket:await bridge.issueContext(id,name)}}};}
  return {};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){let body='';for await(const chunk of process.stdin)body+=chunk;try{process.stdout.write(JSON.stringify(await handleHook(JSON.parse(body))));}catch(error){process.stderr.write(`Team Workspace hook: ${error.message}\n`);process.exitCode=2;}}
