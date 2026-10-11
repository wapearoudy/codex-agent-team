import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {HostBridge} from '../../src/host-bridge.mjs';

export async function runLive({project,bridgeRoot,packageRoot,evidence,record=()=>{},binary=join(process.env.APPDATA,'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe')}) {
  const bridge=new HostBridge({host:'claude-code',root:bridgeRoot});
  const marker=`TEAM_WORKSPACE_NATIVE_CLAUDE:${randomUUID()}`;
  const parentId=randomUUID(),messages=[],tasks=new Map();let childId,activeTaskId,closed=false;const deadline=Date.now()+240000;
  const emit=event=>record({host:'claude-code',parentId,...event});
  const proc=spawn(binary,['--print','--verbose','--input-format','stream-json','--output-format','stream-json','--include-partial-messages','--session-id',parentId,'--plugin-dir',packageRoot,'--tools','Agent,SendMessage,TaskStop,Read,Bash','--allowedTools','Agent,SendMessage,TaskStop,Read,Bash'],{cwd:project,env:{...process.env,TEAM_WORKSPACE_BRIDGE_ROOT:bridgeRoot},windowsHide:true,stdio:['pipe','pipe','pipe']});
  let pending='';proc.stdout.on('data',chunk=>{pending+=chunk;let index;while((index=pending.indexOf('\n'))>=0){const line=pending.slice(0,index);pending=pending.slice(index+1);let row;try{row=JSON.parse(line);}catch{continue;}messages.push(row);if(row.type==='system'&&['task_started','task_notification','task_updated'].includes(row.subtype)){tasks.set(row.task_id,{...tasks.get(row.task_id),...row});emit({kind:row.subtype,taskId:row.task_id,toolUseId:row.tool_use_id,status:row.status});}if(row.type==='system'&&row.subtype==='init')emit({kind:'init',model:row.model,sessionId:row.session_id,tools:row.tools});}});
  proc.stderr.on('data',()=>{});proc.on('close',code=>{closed=true;emit({kind:'process-close',code});});proc.on('error',error=>{closed=true;emit({kind:'launch-error',code:error.code});});
  const send=prompt=>proc.stdin.write(JSON.stringify({type:'user',session_id:parentId,message:{role:'user',content:prompt},parent_tool_use_id:null})+'\n');
  const until=async(predicate,label)=>{while(Date.now()<deadline){const failure=messages.find(row=>row.type==='result'&&row.is_error===true);if(failure){emit({kind:'native-failure',subtype:failure.subtype,errors:([failure.result,...(failure.errors??[])]).filter(Boolean).map(String).map(s=>s.replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_.-]+/g,'[redacted]').slice(0,300))});throw new Error(`Claude native result failed before ${label}`);}const value=await predicate();if(value)return value;if(closed)throw new Error(`Claude exited before ${label}`);await new Promise(resolve=>setTimeout(resolve,150));}throw new Error(`Claude native verification timeout: ${label}`);};
  const snapshot=async()=>{try{return await bridge.readThread(childId);}catch(error){if(error.code==='HOST_SESSION_UNAVAILABLE')return null;throw error;}};
  try {
    send(`Perform only this read-only native delegation test. Use Agent to create exactly one general-purpose background agent with prompt: "Do not use tools or modify files. Print exactly ${marker}:initial and stop." Do not set or change its model. Report its exact agentId. Do not launch another agent.`);
    await until(async()=>{const d=await bridge.store.read();const children=Object.values(d.threads).filter(t=>t.parentThreadId===parentId);if(children.length){assert.equal(children.length,1);childId=children[0].id;return true;}return false;},'native Agent child hook');
    emit({kind:'native-child',childId,marker});
    const initial=await until(async()=>{const t=await snapshot();return t?.turns.at(-1)?.status==='completed'&&t;},'plugin-observed initial terminal');
    assert.ok(JSON.stringify(initial).includes(`${marker}:initial`));assert.equal(initial.cwd,project);
    emit({kind:'initial-terminal',childId,turnId:initial.turns.at(-1).id,status:'completed'});
    send(`Use native SendMessage to the same exact agent ${childId} with: "Do not use tools or modify files. Print exactly ${marker}:resumed and stop." Do not create another Agent. Wait for its completion.`);
    const resumed=await until(async()=>{const t=await snapshot();return t?.turns.at(-1)?.id!==initial.turns.at(-1).id&&t?.turns.at(-1)?.status==='completed'&&t;},'same member new terminal');assert.ok(JSON.stringify(resumed.turns.at(-1)).includes(`${marker}:resumed`));
    emit({kind:'resumed-terminal',childId,turnId:resumed.turns.at(-1).id,status:'completed'});
    const existingTasks=new Set(tasks.keys());send(`Use native SendMessage to the same exact agent ${childId} with: "Read-only cancellation test. Use Bash to run node -e 'setTimeout(()=>{},60000)' once, then print finished. Do not modify files." Do not create another Agent. Wait for its completion.`);
    const active=await until(async()=>{const t=await snapshot();return t?.turns.at(-1)?.id!==resumed.turns.at(-1).id&&t?.turns.at(-1)?.status==='inProgress'&&t;},'plugin active same child');
    emit({kind:'bridge-active',childId,turnId:active.turns.at(-1).id,status:'inProgress'});
    activeTaskId=await until(()=>[...tasks].find(([id,t])=>!existingTasks.has(id)&&t.subtype==='task_started')?.[0],'native active task id');
    const requestId=randomUUID();proc.stdin.write(JSON.stringify({type:'control_request',request_id:requestId,request:{subtype:'stop_task',task_id:activeTaskId}})+'\n');emit({kind:'stop-control-request',childId,taskId:activeTaskId,requestId});
    await until(()=>messages.find(row=>row.type==='control_response'&&row.response?.request_id===requestId),'native stop control response');
    const terminal=await until(async()=>{const t=await snapshot();return t?.turns.at(-1)?.id===active.turns.at(-1).id&&t?.turns.at(-1)?.status==='interrupted'&&t;},'plugin-observed native stopped terminal');
    assert.ok([...tasks.values()].some(t=>t.task_id===activeTaskId&&['stopped','killed'].includes(t.status)));
    const result={host:'claude-code',status:'PASS',parentId,childId,marker,turns:[initial,resumed,terminal].map(t=>({id:t.turns.at(-1).id,status:t.turns.at(-1).status,statusEvidence:t.turns.at(-1).statusEvidence}))};emit({kind:'result',...result});return result;
  } finally {if(!closed){proc.stdin.end();await new Promise(resolve=>{const timer=setTimeout(()=>{proc.kill();resolve();},5000);proc.once('close',()=>{clearTimeout(timer);resolve();});});}emit({kind:'cleanup',terminalProof:false});}
}

