import assert from 'node:assert/strict';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
import {HostBridge} from '../../src/host-bridge.mjs';
import {createHostAdapter} from '../../src/host-adapters.mjs';

// The real desktop composition owns the model and credentials. This verifier
// drives its native tool runtime; it never builds an alternate model client.
export async function runLive({project,bridgeRoot,packageRoot,evidence,record=()=>{},runtimeRoot=join(process.env.APPDATA,'npm/node_modules/@deepseek-ai/dsh'),runtimeReady}) {
  const emit=event=>record({host:'deepseek-harness',...event});
  const load=path=>import(pathToFileURL(join(runtimeRoot,path)).href);
  const {runProfile}=await load('lib/profile-boot.js');
  const {loadLayeredEnv}=await load('node_modules/@deepseek-ai/dsh-app-boot/lib/index.js');
  const overlay=join(evidence,'dsh-live.patch.yml');await mkdir(evidence,{recursive:true});
  await writeFile(overlay,`- insert:\n    - id: team-workspace-live\n      name: ${JSON.stringify(join(packageRoot,'dist/index.mjs').replaceAll('\\','/'))}\n      inject: [tools, sessions, agents]\n      config:\n        bridgeRoot: ${JSON.stringify(bridgeRoot.replaceAll('\\','/'))}\n`);
  let runtime,parent,child;const events=[];const controller=new AbortController();
  const safe=value=>String(value??'').replace(/([?&](?:token|key|api_key)=)[^\s&]+/gi,'$1[redacted]').replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_.-]+/g,'[redacted]').slice(0,600);
  const previousStdout=process.stdout.write,previousStderr=process.stderr.write;
  process.stdout.write=function(chunk,...args){return previousStdout.call(this,safe(Buffer.isBuffer(chunk)?chunk.toString():chunk),...args);};
  process.stderr.write=function(chunk,...args){return previousStderr.call(this,safe(Buffer.isBuffer(chunk)?chunk.toString():chunk),...args);};
  const deadline=Date.now()+180000;
  const until=async(predicate,label)=>{while(Date.now()<deadline){if(child){const failed=events.find(e=>e.kind==='turn/end'&&e.id===child&&e.reason==='error');if(failed){emit({kind:'native-failure',childId:child,turn:failed.turn});throw new Error(`DSH native child failed before ${label}`);}}const value=await predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error(`DSH native verification timeout: ${label}`);};
  const bridge=new HostBridge({host:'deepseek-harness',root:bridgeRoot});
  const adapter=createHostAdapter({host:'deepseek-harness',bridge});
  try {
    runtime=await runProfile({environment:loadLayeredEnv('dsh'),profile:'desktop',patchFiles:[overlay],args:['--port','0','--no-open']});
    const {ctx}=runtime;if(runtimeReady)await runtimeReady(ctx);
    const selection=ctx.agentDefaultModel.currentSelection();
    assert.equal(typeof selection.model,'string');assert.ok(selection.model);assert.equal(typeof selection.provider,'string');assert.ok(selection.provider);
    emit({kind:'configured-model',model:selection.model,provider:selection.provider});
    const lifecycle=event=>{events.push(event);emit(event);};
    ctx.on('session/event',(session,event)=>{if(['turn/start','turn/end'].includes(event.type))lifecycle({kind:event.type,id:session.id,turn:event.data.turn,reason:event.data.reason?.kind});});
    ctx.on('subagent/start',info=>lifecycle({kind:'subagent/start',id:info.id,runId:info.runId}));
    ctx.on('subagent/end',info=>lifecycle({kind:'subagent/end',id:info.id,runId:info.runId,reason:info.stopReason?.kind??info.stopReason}));
    parent=(await ctx.agents.create({sessionId:randomUUID(),meta:{cwd:project},agentOptions:selection})).agent;
    const nativeTools=ctx.tools.schemas(parent),wire=ctx.tools.wireSchemas(parent);
    emit({kind:'native-tools',parentId:parent.id,tools:nativeTools.map(tool=>({name:tool.name})),wireTools:wire.schemas.map(tool=>({name:tool.name}))});
    const call=async(name,args)=>{
      const ptc=!wire.schemas.some(tool=>tool.name===name)&&wire.schemas.some(tool=>tool.name==='run_code')&&nativeTools.some(tool=>tool.name===name);
      const request=ptc?{name:'run_code',arguments:{code:`return await tools[${JSON.stringify(name)}](${JSON.stringify(args)});`,description:`Native ${name} lifecycle verification`}}:{name,arguments:args};
      const receipt=await ctx.tools.execute({callId:randomUUID(),...request,agent:parent,signal:controller.signal});
      if(receipt.isError){const message=safe(receipt.error?.message??receipt.content?.filter(b=>b.type==='text').map(b=>b.text).join(' '));emit({kind:'native-tool-failure',name,transport:request.name,code:receipt.error?.info?.code,message});throw new Error(`Native ${name} failed: ${message}`);}
      emit({kind:'native-tool-receipt',name,transport:request.name});
      return ptc?receipt.value?.result:receipt.value;
    };
    const marker=`TEAM_WORKSPACE_NATIVE_DSH:${randomUUID()}`;
    const teamMode=!nativeTools.some(tool=>tool.name==='subagent')&&nativeTools.some(tool=>tool.name==='spawn_teammate');
    const target=`native-check-${randomUUID().slice(0,8)}`;
    const launchPrompt=`Read-only task. Do not use tools or modify files. Print exactly ${marker}:initial and stop.`;
    const launched=await call(teamMode?'spawn_teammate':'subagent',teamMode?{name:target,description:'Read-only native lifecycle verification',prompt:launchPrompt,context:'fresh'}:{description:'Read-only native lifecycle verification',prompt:launchPrompt,run_in_background:true});
    if(teamMode){assert.equal(launched.member?.target,target);child=ctx.agentTeams.listMembers(parent).find(member=>member.name===target)?.id;}else{assert.equal(launched.kind,'continuable');child=launched.subagentId;}assert.ok(child);
    emit({kind:'native-child',parentId:parent.id,childId:child,tool:teamMode?'spawn_teammate':'subagent',target:teamMode?target:child});
    const address=teamMode?{target}:{agent_id:child};
    const initial=await until(async()=>{try{const t=await bridge.readThread(child);return t.turns.at(-1)?.status==='completed'&&t;}catch{return false;}},'initial child terminal');
    assert.equal(initial.parentThreadId,parent.id);assert.equal(initial.cwd,project);assert.ok(JSON.stringify(initial).includes(`${marker}:initial`));
    if(teamMode){const authority=await until(async()=>{const thread=await bridge.readThread(parent.id);return thread.nativeMembers?.some(member=>member.id===child&&member.target===target)&&thread;},'plugin native roster binding');emit({kind:'plugin-native-roster',parentId:parent.id,members:authority.nativeMembers,tools:authority.nativeTools.map(tool=>({name:tool.name}))});}
    const projectContext=await call('get_current_project',{});emit({kind:'native-current-project',result:projectContext});
    emit({kind:'initial-terminal',parentId:parent.id,childId:child,turnId:initial.turns.at(-1).id,status:'completed',marker});
    const initialInspection=await adapter.observer.inspect(parent.id,project,child,`${marker}:initial`);assert.equal(initialInspection.threadId,child);if(teamMode)assert.equal(initialInspection.nativeTarget,target);emit({kind:'initial-native-inspection',threadId:initialInspection.threadId,turnId:initialInspection.turnId,nativeTarget:initialInspection.nativeTarget,status:initialInspection.status});
    await call('send_message',{...address,message:`Same read-only member. Print exactly ${marker}:resumed and stop.`});
    const resumed=await until(async()=>{const t=await bridge.readThread(child);return t.turns.at(-1)?.id!==initial.turns.at(-1).id&&t.turns.at(-1)?.status==='completed'&&t;},'same member resumed terminal');
    assert.ok(JSON.stringify(resumed.turns.at(-1)).includes(`${marker}:resumed`));
    emit({kind:'resumed-terminal',parentId:parent.id,childId:child,turnId:resumed.turns.at(-1).id,status:'completed'});
    const resumedInspection=await adapter.observer.inspect(parent.id,project,child,`${marker}:resumed`);assert.equal(resumedInspection.threadId,child);assert.notEqual(resumedInspection.turnId,initialInspection.turnId);if(teamMode)assert.equal(resumedInspection.nativeTarget,target);emit({kind:'resumed-native-inspection',threadId:resumedInspection.threadId,turnId:resumedInspection.turnId,nativeTarget:resumedInspection.nativeTarget,status:resumedInspection.status});
    await call('send_message',{...address,message:'Read-only cancellation test. Do not use tools or modify files. Print exactly cancellation-ready and stop.'});
    const active=await until(async()=>{const t=await bridge.readThread(child);return t.turns.at(-1)?.id!==resumed.turns.at(-1).id&&t.turns.at(-1)?.status==='inProgress'&&t;},'active cancellation turn');
    emit({kind:'bridge-active',childId:child,turnId:active.turns.at(-1).id,status:'inProgress'});
    const stopped=await call('interrupt_agent',address);if(teamMode)assert.equal(stopped.previousStatus,'running');else assert.equal(stopped.accepted,true);emit({kind:'interrupt-request',childId:child,accepted:true});
    const terminal=await until(async()=>{const t=await bridge.readThread(child);return t.turns.at(-1)?.id===active.turns.at(-1).id&&t.turns.at(-1)?.status==='interrupted'&&t;},'persisted aborted native turn');
    assert.ok(terminal.turns.some(turn=>turn.id===initial.turns.at(-1).id),'Initial turn history must survive native cold resume');assert.ok(terminal.turns.some(turn=>turn.id===resumed.turns.at(-1).id),'Resume turn history must survive later activation');
    await ctx.agents.get(child)?.whenIdle();const resident=ctx.sessions.get(child);if(resident)await ctx.sessions.flush(resident);
    const nativeEnd=events.find(e=>e.kind==='subagent/end'&&e.id===child&&e.reason==='aborted');assert.ok(nativeEnd,'Native subagent/end aborted required');
    const result={host:'deepseek-harness',status:'PASS',parentId:parent.id,childId:child,model:selection.model,provider:selection.provider,turns:[initial,resumed,terminal].map(t=>({id:t.turns.at(-1).id,status:t.turns.at(-1).status,statusEvidence:t.turns.at(-1).statusEvidence})),marker};emit({kind:'result',...result});return result;
  } finally {
    controller.abort();if(child&&runtime)try{runtime.ctx.subagents.interrupt(child,{kind:'ancestor',agent:parent});}catch{}
    try {if(runtime)await runtime.shutdown.shutdown(0);}finally {process.stdout.write=previousStdout;process.stderr.write=previousStderr;}
  }
}


