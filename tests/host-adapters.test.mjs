import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hostId,hostDataRoot,hostCapabilities,createHostAdapter,dispatchForHost,nativeMessageAction} from '../src/host-adapters.mjs';
import {HostBridge} from '../src/host-bridge.mjs';
import {ModelCatalog} from '../src/model-catalog.mjs';

test('host selection rejects unknown hosts and isolates non-Codex team data',()=>{
  assert.equal(hostId('DeepSeekHarness'),'deepseek-harness');
  assert.equal(hostId('ClaudeCode'),'claude-code');
  assert.throws(()=>hostId('some-compatible-api'),/Unsupported/);
  assert.equal(hostDataRoot('codex','existing'), 'existing');
  assert.notEqual(hostDataRoot('opencode','existing'),hostDataRoot('claude-code','existing'));
  assert.equal(hostCapabilities('opencode').childModelSelection,false);
  assert.equal(hostCapabilities('claude-code').panel,'native-tools');
});

test('host native dispatch preserves identity and avoids Codex controls in other hosts',()=>{
  const p={attemptId:'attempt',displayName:'project-reviewer',taskName:'project_reviewer',prompt:'marker; use native send_message tool',spawnOptions:{fork_turns:'none'},existingThreadId:null};
  assert.equal(dispatchForHost('codex',p),p);
  const cc=dispatchForHost('claude-code',p);
  assert.equal(cc.nativeAction.tool,'Agent');assert.equal(cc.nativeAction.arguments.run_in_background,true);
  assert.equal(cc.attemptId,p.attemptId);assert.equal(cc.titleAction,null);
  assert.equal(cc.control.interruptTool,'TaskStop');assert.equal('fork_turns' in cc.spawnOptions,false);
  const resumed=dispatchForHost('claude-code',{...p,existingThreadId:'native-agent'});assert.deepEqual(resumed.nativeAction,{tool:'SendMessage',arguments:{to:'native-agent',message:resumed.prompt}});assert.equal('resume' in resumed.nativeAction.arguments,false);
  const oc=dispatchForHost('opencode',p);assert.equal(oc.nativeAction.tool,'task');assert.equal('model' in oc.nativeAction.arguments,false);
  assert.equal(dispatchForHost('deepseek-harness',p).host,'deepseek-harness');
});

test('DSH delegation includes native required fields and honors synchronous profile schemas',()=>{
  const p={displayName:'project-reviewer',prompt:'work',spawnOptions:{},nativeTools:[{name:'subagent',description:'returns a subagent id you can continue with `send_message`',parameters:{type:'object',properties:{description:{type:'string'},prompt:{type:'string'}},required:['description','prompt']}},{name:'send_message'},{name:'interrupt_agent'}]};
  const oneShot=structuredClone(p);oneShot.nativeTools[0].description='This call waits for the result by default.';
  assert.equal(dispatchForHost('dsh',oneShot).nativeAction.tool,null);
  assert.deepEqual(dispatchForHost('dsh',p).nativeAction.arguments,{description:'project-reviewer',prompt:'work'});
  p.nativeTools[0].parameters.properties.run_in_background={type:'boolean'};
  assert.equal(dispatchForHost('dsh',p).nativeAction.arguments.run_in_background,true);
  p.existingThreadId='child';p.nativeTools=p.nativeTools.filter(t=>t.name!=='send_message');assert.equal(dispatchForHost('dsh',p).nativeAction.tool,null);
  p.nativeTools.push({name:'send_message'});
  assert.equal(dispatchForHost('dsh',p).nativeAction.arguments.agent_id,'child');
});

const durableTools=()=>[{name:'spawn_teammate',description:'Create one named, durable teammate. Only the Team Lead may call this tool.',parameters:{name:{type:'string'},description:{type:'string'},prompt:{type:'string'},context:{type:'string',enum:['fresh','fork']}}},{name:'send_message',description:'A running target receives it; an inactive target starts or resumes a turn.',parameters:{target:{type:'string'},message:{type:'string'}}},{name:'interrupt_agent',parameters:{target:{type:'string'}}},{name:'list_agents'}];
test('DSH durable teammate dispatch uses native names and never guesses a name from a session ID',async()=>{
 const p={displayName:'project-role',taskName:'project_role_ctx_2',prompt:'work',nativeTools:durableTools()},adapter=createHostAdapter({host:'dsh',bridge:{}});
 await adapter.freezeRoutes([{id:'dev'}],{nativeTools:p.nativeTools},{validate:async()=>{}});
 const launched=dispatchForHost('dsh',p);assert.deepEqual(launched.nativeAction,{tool:'spawn_teammate',arguments:{name:'project-role-ctx-2',description:'project-role',prompt:'work',context:'fresh'}});assert.equal(launched.binding.lookupTool,'get_current_project');
 assert.equal(dispatchForHost('dsh',{...p,existingThreadId:'native-child'}).nativeAction.tool,null);
 const resumed=dispatchForHost('dsh',{...p,existingThreadId:'native-child',nativeTarget:'real-role'});assert.deepEqual(resumed.nativeAction,{tool:'send_message',arguments:{target:'real-role',message:'work'}});assert.equal(resumed.control.identityArgument,'target');
 assert.deepEqual(nativeMessageAction('dsh',{threadId:'parent-id',text:'note',relationship:'parent',nativeTools:p.nativeTools}).arguments,{target:'lead',message:'note'});
 p.nativeTools[0].description='A one-shot job';await assert.rejects(adapter.freezeRoutes([{id:'dev'}],{nativeTools:p.nativeTools},{validate:async()=>{}}),/verified continuable profile/);
});
test('DSH bridge derives the control target only from the exact native parent roster',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-roster-')),bridge=new HostBridge({host:'deepseek-harness',root}),project=process.cwd(),marker='TEAM_WORKSPACE_ATTEMPT:11111111-1111-4111-8111-111111111111';
 await bridge.putThread({id:'leader',cwd:project,nativeMembers:[{id:'child',target:'real-role'}],turns:[]});
 await bridge.putThread({id:'child',cwd:project,parentThreadId:'leader',turns:[{id:'turn',status:'completed',items:[{type:'userMessage',content:marker},{type:'agentMessage',text:marker,phase:'final_answer'}]}]});
 const adapter=createHostAdapter({host:'dsh',bridge});try{const run=await adapter.observer.inspect('leader',project,'child',marker);assert.equal(run.nativeTarget,'real-role');const context=await adapter.context.resolve({hostVerified:true,host:'deepseek-harness',threadId:'leader'});assert.deepEqual(context.nativeMembers,[{id:'child',target:'real-role'}]);await assert.rejects(adapter.observer.inspect('foreign-parent',project,'child',marker),/Leader/);}finally{await adapter.observer.close();}
});
test('Claude cannot pass a provider model ID to its native alias-only Agent argument',async()=>{
 const adapter=createHostAdapter({host:'claude-code',bridge:{}});await assert.rejects(adapter.freezeRoutes([{route:{model:'deepseek-v4-flash'}}],{},{}),/native aliases only/);
});
test('durable control fails closed when a saved target no longer maps to its native session',async()=>{
 const adapter=createHostAdapter({host:'dsh',bridge:{host:'deepseek-harness',readThread:async()=>({id:'leader',cwd:process.cwd(),nativeMembers:[{id:'child',target:'confirmed-role'}]})}});
 const p={leaderThreadId:'leader',existingThreadId:'child',nativeTarget:'confirmed-role',taskName:'project_role',displayName:'project-role',prompt:'work',nativeTools:durableTools()};
 assert.equal(adapter.dispatch(p).nativeAction.tool,null);
 await adapter.context.resolve({hostVerified:true,host:'deepseek-harness',threadId:'leader'});assert.equal(adapter.dispatch(p).nativeAction.tool,'send_message');
 assert.equal(adapter.dispatch({...p,nativeTarget:'stale-role'}).nativeAction.tool,null);assert.equal(adapter.dispatch({...p,existingThreadId:'other'}).nativeAction.tool,null);
});

test('DSH siblings use the Leader relay instead of unauthorized direct native messages',()=>{
  const args={threadId:'member',text:'note'};
  assert.equal(nativeMessageAction('dsh',{...args,relationship:'sibling'}),null);
  for(const relationship of ['parent','child'])assert.equal(nativeMessageAction('dsh',{...args,relationship}).arguments.agent_id,'member');
  assert.equal(nativeMessageAction('codex',{...args,relationship:'sibling',target:'/root/member'}).target,'/root/member');
});
test('DSH team-stop uses the current native roster and blocks stale or unavailable aliases',async()=>{
 let nativeMembers=[{id:'child',target:'real-role'}];const adapter=createHostAdapter({host:'dsh',bridge:{host:'deepseek-harness',readThread:async()=>({id:'leader',cwd:process.cwd(),nativeTools:durableTools(),nativeMembers})}}),team={leaderThreadId:'leader'},target={memberId:'dev',threadId:'child',nativeTarget:'real-role'};
 assert.equal((await adapter.interruptTargets(team,[target]))[0].nativeAction.tool,null);
 await adapter.context.resolve({hostVerified:true,host:'deepseek-harness',threadId:'leader'});
 assert.deepEqual((await adapter.interruptTargets(team,[target]))[0].nativeAction,{tool:'interrupt_agent',arguments:{target:'real-role'}});
 assert.equal((await adapter.interruptTargets(team,[{...target,nativeTarget:'stale-role'}]))[0].nativeAction.tool,null);
 nativeMembers=[{id:'replacement',target:'real-role'}];await adapter.context.resolve({hostVerified:true,host:'deepseek-harness',threadId:'leader'});
 const blocked=(await adapter.interruptTargets(team,[target]))[0];assert.equal(blocked.nativeAction.tool,null);assert.equal(blocked.nativeTarget,undefined);assert.equal(blocked.savedNativeTarget,'real-role');
 assert.equal((await adapter.interruptTargets({leaderThreadId:'other'},[target]))[0].nativeAction.tool,null);
 const unbound={memberId:'other',threadId:null,action:'verify-host-before-bind-or-release'};assert.deepEqual(await adapter.interruptTargets(team,[unbound]),[unbound]);
});
test('legacy DSH stop requires an actual child snapshot even without a roster service',async()=>{
 const nativeTools=[{name:'subagent',description:'returns a subagent id you can continue with `send_message`'},{name:'send_message'},{name:'interrupt_agent'}],project=process.cwd();let child={id:'child',cwd:project,parentThreadId:'leader'};
 const adapter=createHostAdapter({host:'dsh',bridge:{host:'deepseek-harness',async readThread(id){if(id==='leader')return {id,cwd:project,nativeTools,nativeMembers:[]};if(id!==child.id)throw new Error('Native session unavailable');return child;}}}),team={leaderThreadId:'leader',projectPath:project},target={memberId:'dev',threadId:'child'};
 await adapter.context.resolve({hostVerified:true,host:'deepseek-harness',threadId:'leader'});
 assert.deepEqual((await adapter.interruptTargets(team,[target]))[0].nativeAction,{tool:'interrupt_agent',arguments:{agent_id:'child'}});
 assert.equal((await adapter.interruptTargets(team,[{...target,threadId:'unknown'}]))[0].nativeAction.tool,null);
 child={...child,parentThreadId:'foreign'};assert.equal((await adapter.interruptTargets(team,[target]))[0].nativeAction.tool,null);
 child={...child,parentThreadId:'leader',cwd:tmpdir()};assert.equal((await adapter.interruptTargets(team,[target]))[0].nativeAction.tool,null);
});

test('verified native snapshots go through existing parent, project and attempt gates',async()=>{
  const root=await mkdtemp(join(tmpdir(),'host-adapter-')),project=join(root,'project');await mkdir(project);
  const bridge=new HostBridge({host:'opencode',root:join(root,'bridge')});
  const marker='TEAM_WORKSPACE_ATTEMPT:ad0e18c1-12f0-438e-91ef-75c1bd858de8';
  const thread={id:'child',parentThreadId:'leader',cwd:project,turns:[{id:'turn',status:'inProgress',items:[{type:'userMessage',content:[{type:'text',text:marker}]}],activity:[]}]};
  const adapter=createHostAdapter({host:'opencode',bridge});
  try{
    await bridge.putThread({id:'leader',cwd:project,parentThreadId:null,turns:[]});await bridge.putThread(thread);
    await assert.rejects(adapter.context.resolve({threadId:'leader'}),/ticket/);
    const ticket=await bridge.issueContext('leader','get_current_project');
    const verified=await adapter.authenticate('get_current_project',{_hostTicket:ticket},{_meta:{threadId:'attacker'}});
    assert.equal((await adapter.context.resolve(verified.extra._meta)).threadId,'leader');
    await assert.rejects(adapter.authenticate('get_current_project',{_hostTicket:ticket},{}));
    const running=await adapter.observer.inspect('leader',project,'child',marker);
    assert.equal(running.status,'inProgress');assert.equal(running.turnId,'turn');
    await assert.rejects(adapter.observer.inspect('other-leader',project,'child',marker),/child/);
    thread.turns[0].status='completed';thread.turns[0].items.push({type:'agentMessage',text:marker+'\nDelivered'});await bridge.putThread(thread);
    assert.equal((await adapter.observer.inspectIdle('leader',project,'child')).quiescence.status,'completed');
    thread.turns.push({id:'new-turn',status:'inProgress',items:[]});await bridge.putThread(thread);
    await assert.rejects(adapter.observer.inspectIdle('leader',project,'child'),/idle/);
  }finally{await adapter.observer.close();await rm(root,{recursive:true,force:true});}
});

test('native preset hosts reject explicit overrides instead of silently changing model',async()=>{
  for(const host of ['opencode','deepseek-harness']){
    const adapter=createHostAdapter({host,bridge:{}}),members=[{id:'dev',route:{model:'other'}}];
    await assert.rejects(adapter.freezeRoutes(members,{},{}),/inherits/);
    if(host==='deepseek-harness')await assert.rejects(adapter.freezeRoutes([{id:'dev'}],{nativeTools:[{name:'subagent'}]},{validate:async()=>{}}),/continuable profile/);
    const inherited=[{id:'dev'}];await adapter.freezeRoutes(inherited,{nativeTools:['subagent','send_message','interrupt_agent'].map(name=>({name,description:'returns a subagent id you can continue with `send_message`'})),modelRoute:{model:'leader-model'}},{validate:async()=>{}});
    assert.equal(inherited[0].routeSnapshot.model,null);
  }
});
