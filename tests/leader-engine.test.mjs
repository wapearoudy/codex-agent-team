import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,open,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {NativeMembers} from '../src/native-members.mjs';
import {taskDisplayState,memberState} from '../src/team-projection.mjs';

const plan=()=>({members:[{id:'dev',role:'Developer',responsibility:'Implement',reason:'Implementation',writeScopes:['src']},{id:'qa',role:'Reviewer',responsibility:'Review',reason:'Independent check',writeScopes:[]}],tasks:[{id:'work',title:'Change source',goal:'Implement requested behavior',acceptance:'Required checks pass',memberId:'dev',kind:'work',dependencies:[]},{id:'review',title:'Review source',goal:'Independently verify',acceptance:'Checks pass',memberId:'qa',kind:'review',reviewOfTaskId:'work',dependencies:[{taskId:'work',when:'submitted'}]}]});
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'leader-engine-')),cwd=join(root,'project');await mkdir(cwd);
  const runs=new Map(),observer={calls:0,async inspect(leader,project,thread,marker){this.calls++;const r=runs.get(marker);if(!r||r.threadId!==thread)throw new Error('No verified native attempt');assert.equal(leader,'leader');assert.equal(project,cwd);return structuredClone(r);}};
  const engine=new LeaderEngine({root:join(root,'records'),observer});
  const args={goal:'Implement a bounded test change',plan:plan(),execute:true,maxParallel:2};
  const team=await engine.planOnce('owner',{cwd,threadId:'leader'},args);
  return {root,cwd,runs,observer,engine,team,args};
}
async function claim(f,id){const t=await f.engine.store.get(f.team.id,'owner');return f.engine.claim('owner',t.id,t.revision,id);}
function seed(f,dispatch,thread='child-dev',output='Implemented and checked',status='completed'){
  const run={threadId:thread,turnId:dispatch.attemptId,status,outputs:[{text:output}],commands:[],connection:'snapshot',source:'native-thread-persisted-snapshot'};
  f.runs.set(dispatch.marker,run);return run;
}

test('checkpoint persists across engine restart and handoff is read-only and fenced by revision',async()=>{
  const f=await fixture(),c=await claim(f,'work');seed(f,c.dispatch,'child-dev','working','inProgress');
  const b=await f.engine.bind('owner',f.team.id,c.team.revision,'work',c.dispatch.attemptId,'child-dev');
  const input={taskId:'work',attemptId:c.dispatch.attemptId,requestId:'edd66862-0381-44db-9b6e-87b052c04421',summary:'Parser implemented',decisions:['Use current project'],remainingWork:['Independent review'],validation:[{name:'Review',status:'NOT_RUN',evidence:'Not dispatched yet'}],evidence:['src/parser.mjs']};
  const saved=await f.engine.checkpoint('owner',f.team.id,b.team.revision,input);
  assert.equal(saved.checkpoints.length,1);assert.equal(saved.checkpoints[0].stale,false);
  await assert.rejects(()=>f.engine.checkpoint('owner',f.team.id,b.team.revision,input),/changed/);
  const restarted=new LeaderEngine({root:join(f.root,'records'),observer:f.observer});
  const before=await restarted.store.get(f.team.id,'owner');
  const handoff=await restarted.handoff('owner',f.team.id,'work');
  assert.ok(JSON.stringify(handoff.handoff).includes('Parser implemented'));
  assert.equal(handoff.handoff.currentExecution.attemptId,c.dispatch.attemptId);
  assert.equal(handoff.handoff.currentExecution.observationMode,'saved');
  assert.deepEqual(handoff.handoff.currentExecution.observation.outputs,[{text:'working'}]);
  assert.deepEqual(await restarted.store.get(f.team.id,'owner'),before);
  const replay=await restarted.checkpoint('owner',f.team.id,before.revision,input);assert.equal(replay.checkpoints.length,1);
  await assert.rejects(()=>restarted.handoff('different-owner',f.team.id,'work'),/not found/);
  await restarted.close();await f.engine.close();
});
async function bindSettle(f,c,thread,output){seed(f,c.dispatch,thread,output);const bound=await f.engine.bind('owner',f.team.id,c.team.revision,c.dispatch.taskId,c.dispatch.attemptId,thread);return f.engine.settle('owner',f.team.id,bound.team.revision,c.dispatch.taskId,c.dispatch.attemptId);}

test('fixed roster binds all members once and tasks reuse the same distinct native children',async()=>{
  const f=await fixture();f.team=await f.engine.planOnce('owner',{cwd:f.cwd,threadId:'leader'},{...f.args,initializeMembers:true});
  const initializing=await f.engine.read('owner',f.team.id);assert.equal(initializing.initializations.length,2);
  assert.deepEqual(initializing.initializations.map(m=>[m.displayName,m.taskName,m.threadTitle]),[['project-Developer','project_developer','project-Developer'],['project-Reviewer','project_reviewer','project-Reviewer']]);
  await assert.rejects(()=>claim(f,'work'),/every fixed/);
  for(const m of f.team.members){f.runs.set(m.rosterMarker,{threadId:'child-'+m.id,turnId:'init-'+m.id,status:'completed',outputs:[],commands:[]});const t=await f.engine.store.get(f.team.id,'owner');const bound=await f.engine.bindRoster('owner',t.id,t.revision,m.id,'child-'+m.id);assert.equal(bound.titleAction.threadId,'child-'+m.id);assert.equal(bound.titleAction.title,'project-'+m.role);assert.equal(bound.titleAction.tool,'set_thread_title');}
  const roster=await f.engine.store.get(f.team.id,'owner');assert.ok(roster.members.every(m=>m.rosterVerified));assert.equal((await f.engine.read('owner',f.team.id)).initializations.length,0);
  const c=await claim(f,'work');assert.equal(c.dispatch.existingThreadId,'child-dev');assert.equal(c.dispatch.action,'followup-native-member');
  assert.equal(c.dispatch.displayName,'project-Developer');assert.equal(c.dispatch.taskName,'project_developer');assert.equal(c.dispatch.titleAction.threadId,'child-dev');assert.equal(c.dispatch.titleAction.title,'project-Developer');
  const beforeRead=await f.engine.store.get(f.team.id,'owner');await f.engine.read('owner',f.team.id);assert.deepEqual(await f.engine.store.get(f.team.id,'owner'),beforeRead);
  const m=roster.members[0];f.runs.set(m.rosterMarker,{threadId:'replacement',turnId:'other',status:'completed'});
  await assert.rejects(()=>f.engine.bindRoster('owner',roster.id,c.team.revision,'dev','replacement'),/existing/);
  f.runs.set(m.rosterMarker,{threadId:'child-qa',turnId:'duplicate',status:'completed'});
  await assert.rejects(()=>f.engine.bindRoster('owner',roster.id,c.team.revision,'dev','child-qa'),/existing|distinct/);
});

test('native identity links before public acknowledgement and cannot settle an unverified turn',async()=>{
  const f=await fixture(),c=await claim(f,'work');
  f.runs.set(c.dispatch.marker,{threadId:'child-dev',agentPath:'/root/dev',turnId:null,status:'starting',outputs:[],commands:[]});
  const linked=await f.engine.bind('owner',f.team.id,c.team.revision,'work',c.dispatch.attemptId,'child-dev');assert.equal(linked.team.tasks[0].attempts.at(-1).state,'linking');assert.equal(linked.team.members[0].agentThreadId,'child-dev');
  await assert.rejects(()=>f.engine.settle('owner',f.team.id,linked.team.revision,'work',c.dispatch.attemptId),/terminal/);
  seed(f,c.dispatch,'child-dev','Completed public delivery');
  const settled=await f.engine.settle('owner',f.team.id,linked.team.revision,'work',c.dispatch.attemptId);assert.equal(settled.team.tasks[0].status,'submitted');assert.equal(settled.team.tasks[0].attempts.at(-1).turnId,c.dispatch.attemptId);
});

test('pending roster initialization becomes idle before dispatch, without a replacement member',async()=>{
  const f=await fixture();f.team=await f.engine.planOnce('owner',{cwd:f.cwd,threadId:'leader'},{...f.args,initializeMembers:true});
  for(const m of f.team.members){f.runs.set(m.rosterMarker,{threadId:'fixed-'+m.id,turnId:null,status:'starting',outputs:[],commands:[]});const t=await f.engine.store.get(f.team.id,'owner');await f.engine.bindRoster('owner',t.id,t.revision,m.id,'fixed-'+m.id);f.runs.set(m.rosterMarker,{threadId:'fixed-'+m.id,turnId:'init-'+m.id,status:'completed',outputs:[],commands:[]});}
  const claimResult=await claim(f,'work');assert.equal(claimResult.dispatch.existingThreadId,'fixed-dev');assert.equal(claimResult.team.members[1].status,'idle');assert.ok(claimResult.team.members.every(m=>m.rosterVerified));
});

test('native plan and claim do not read or copy a project with a file over 128 MiB',async()=>{
  const f=await fixture();const file=await open(join(f.cwd,'historical.log'),'w');await file.truncate(200*1024*1024);await file.close();
  await writeFile(join(f.cwd,'package.json'),'invalid manifest must not affect delegation');
  const t=await f.engine.planOnce('owner',{cwd:f.cwd,threadId:'leader'},f.args);assert.equal(t.id,f.team.id);
  const c=await claim(f,'work');assert.equal(f.observer.calls,0);assert.equal(c.team.mode,'host-leader');assert.equal(c.team.original,undefined);assert.equal(c.team.totalDispatches,0);assert.equal(c.dispatch.action,'spawn-native-member');
  assert.deepEqual((await readdir(f.root)).sort(),['project','records']);assert.equal(c.team.tasks[0].attempts[0].state,'reserved');
  const retry=await f.engine.claim('owner',t.id,c.team.revision,'work');assert.equal(retry.dispatch.attemptId,c.dispatch.attemptId);
});
test('dependency, stale revision, owner and parallel gates block invalid claims',async()=>{
  const f=await fixture();await assert.rejects(()=>claim(f,'review'),/not ready/);
  const c=await claim(f,'work');await assert.rejects(()=>f.engine.claim('owner',f.team.id,f.team.revision,'work'),/changed/);
  await assert.rejects(()=>f.engine.read('other',f.team.id),/not found/);await assert.rejects(()=>claim(f,'review'),/not ready/);
  const stopped=await f.engine.stop('owner',f.team.id,c.team.revision);assert.equal(stopped.team.tasks[0].status,'running');assert.equal(stopped.leaderAction.type,'interrupt-native-members');await assert.rejects(()=>claim(f,'work'),/paused/);
});
test('completed native turn submits only; independent review and Leader evidence gate delivery',async()=>{
  const f=await fixture(),c=await claim(f,'work');const submitted=await bindSettle(f,c,'child-dev','Source updated');
  assert.equal(submitted.team.tasks[0].status,'submitted');assert.equal(submitted.team.totalDispatches,1);
  await assert.rejects(()=>f.engine.finish('owner',f.team.id,submitted.team.revision,'done',[]),/independent/);
  const r=await claim(f,'review');const reviewed=await bindSettle(f,r,'child-qa',JSON.stringify({summary:'checked',decision:'accept',reason:'Requirements verified',checks:[{name:'actual test',status:'PASS',evidence:'node --test: passed'}],findings:[]}));
  const accepted=await f.engine.acceptReview('owner',f.team.id,reviewed.team.revision,'review',r.dispatch.attemptId,'accept','Reviewed actual evidence');
  assert.equal(accepted.team.state,'awaiting-leader-acceptance');assert.ok(accepted.team.tasks.every(t=>t.status==='accepted'));
  await assert.rejects(()=>f.engine.finish('owner',f.team.id,accepted.team.revision,'done',[]),/evidence/);
  const done=await f.engine.finish('owner',f.team.id,accepted.team.revision,'Final integrated checks verified',[{name:'integration',status:'PASS',evidence:'Leader ran the check on the current project'}]);
  assert.equal(done.team.state,'delivered');assert.equal(done.team.finalAcceptance.source,'main-conversation-leader');
});

test('released reservations preserve unique history without exhausting real execution attempts',async()=>{
  const f=await fixture();const ids=new Set();
  for(let i=0;i<5;i++){
    const c=await claim(f,'work');ids.add(c.dispatch.attemptId);
    await f.engine.release('owner',f.team.id,c.team.revision,'work',c.dispatch.attemptId,'Confirmed no host member was launched');
  }
  const c=await claim(f,'work');assert.equal(ids.size,5);assert.equal(c.team.tasks[0].attempts.length,6);assert.equal(c.team.totalDispatches,0);
  assert.ok(c.recovery.some(r=>r.taskId==='work'&&r.action==='verify-host-before-bind-or-release'));
  assert.ok(c.readiness.find(r=>r.taskId==='review').blockers.some(b=>b.code==='dependency'));
});
test('role identity survives task context rotation, while stale attempts and retired threads are rejected',async()=>{
  const f=await fixture(),c=await claim(f,'work');const submitted=await bindSettle(f,c,'child-dev','first');
  const rework=await f.engine.rework('owner',f.team.id,submitted.team.revision,'work','fix result');
  await f.engine.start('owner',f.team.id,rework.team.revision);const next=await claim(f,'work');assert.equal(next.dispatch.existingThreadId,null);assert.equal(next.dispatch.action,'spawn-native-member');assert.equal(next.dispatch.contextIsolation.generation,2);assert.equal(next.team.contextHistory[0].threadId,'child-dev');assert.notEqual(next.dispatch.attemptId,c.dispatch.attemptId);
  await assert.rejects(()=>f.engine.bind('owner',f.team.id,next.team.revision,'work',c.dispatch.attemptId,'child-dev'),/Stale/);
  await assert.rejects(()=>f.engine.bind('owner',f.team.id,next.team.revision,'work',next.dispatch.attemptId,'child-dev'),/verified/);
  seed(f,next.dispatch,'child-dev');await assert.rejects(()=>f.engine.bind('owner',f.team.id,next.team.revision,'work',next.dispatch.attemptId,'child-dev'),/Retired/);
  seed(f,next.dispatch,'different-child');const fresh=await f.engine.bind('owner',f.team.id,next.team.revision,'work',next.dispatch.attemptId,'different-child');assert.equal(fresh.team.members[0].id,'dev');assert.equal(fresh.team.tasks[0].attempts[0].agentThreadId,'child-dev');
});
test('failed commands and unverified reviewer checks cannot be accepted',async()=>{
  const f=await fixture();await bindSettle(f,await claim(f,'work'),'dev','implementation');const c=await claim(f,'review');const submitted=await bindSettle(f,c,'qa',JSON.stringify({decision:'accept',checks:[{name:'browser',status:'NOT_RUN'}]}));
  await assert.rejects(()=>f.engine.acceptReview('owner',f.team.id,submitted.team.revision,'review',c.dispatch.attemptId,'accept','looks good'),/unverified/);
  const rework=await f.engine.acceptReview('owner',f.team.id,submitted.team.revision,'review',c.dispatch.attemptId,'rework','Need actual browser test');assert.equal(rework.team.tasks[0].status,'waiting');
});

test('review-only recheck revokes acceptance without rerunning implementation',async()=>{
  const f=await fixture();await bindSettle(f,await claim(f,'work'),'dev','implementation');
  const c=await claim(f,'review'),verdict=JSON.stringify({summary:'checked',decision:'accept',reason:'source checked',checks:[{name:'source',status:'PASS',evidence:'src/file'}],findings:[]});
  const submitted=await bindSettle(f,c,'qa',verdict);
  const accepted=await f.engine.acceptReview('owner',f.team.id,submitted.team.revision,'review',c.dispatch.attemptId,'accept','checked');
  const recheck=await f.engine.rework('owner',f.team.id,accepted.team.revision,'review','Review updated gate');
  assert.equal(recheck.team.tasks[0].status,'submitted');assert.equal(recheck.team.tasks[0].attempt,1);assert.equal(recheck.team.tasks[1].status,'waiting');
  await f.engine.start('owner',f.team.id,recheck.team.revision);const next=await claim(f,'review');assert.equal(next.dispatch.existingThreadId,null);assert.equal(next.team.contextHistory[0].threadId,'qa');
  const resubmitted=await bindSettle(f,next,'qa-fresh',verdict);const done=await f.engine.acceptReview('owner',f.team.id,resubmitted.team.revision,'review',next.dispatch.attemptId,'accept','rechecked');assert.equal(done.team.state,'awaiting-leader-acceptance');
});
test('observation failure is unknown and never launches a replacement; read never settles',async()=>{
  const f=await fixture(),c=await claim(f,'work');seed(f,c.dispatch,'child','working','inProgress');const bound=await f.engine.bind('owner',f.team.id,c.team.revision,'work',c.dispatch.attemptId,'child');
  f.runs.clear();const read=await f.engine.read('owner',f.team.id);assert.equal(read.runs[0].status,'unknown');assert.equal(read.team.revision,bound.team.revision);assert.equal(read.team.tasks[0].status,'running');
  await assert.rejects(()=>f.engine.release('owner',f.team.id,read.team.revision,'work',c.dispatch.attemptId,'release'),/unbound/);
});
test('native observer verifies parent and project before loading any transcript; only reads RPC',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'native-observer-'));const calls=[];let parent='wrong';let marker='current';
  const rpc={async connect(){},async close(){},async call(method,args){calls.push({method,args});return {thread:{id:'child',parentThreadId:parent,cwd,model:'host-model',turns:[{id:'turn',status:'completed',items:[{type:'userMessage',content:[{type:'text',text:marker}]},{type:'reasoning',text:'NEVER EXPOSE'},{type:'agentMessage',phase:'final_answer',text:'public'}]}]}};}};
  const observer=new NativeMembers({rpcFactory:()=>rpc});
  await assert.rejects(()=>observer.inspect('leader',cwd,'child','current'),/native child/);assert.equal(calls.length,1);assert.equal(calls[0].args.includeTurns,false);
  parent='leader';marker='old';await assert.rejects(()=>observer.inspect('leader',cwd,'child','current'),/uniquely/);
  marker='current';const result=await observer.inspect('leader',cwd,'child','current');assert.equal(result.status,'completed');assert.ok(!JSON.stringify(result).includes('NEVER EXPOSE'));assert.ok(calls.every(x=>x.method==='thread/read'));await observer.close();
});
test('panel separates reservation, persisted activity and completed execution from acceptance',async()=>{
  const f=await fixture(),c=await claim(f,'work'),task=c.team.tasks[0],member=c.team.members[0];
  assert.equal(taskDisplayState(task),'reserved');assert.equal(memberState(member,c.team.tasks,[]),'reserved');
  task.attempts[0].state='running';
  const runs=[{taskId:task.id,memberId:member.id,attemptId:task.attempts[0].id,status:'inProgress',connection:'snapshot'}];
  assert.equal(taskDisplayState(task,runs),'observed');assert.equal(memberState(member,c.team.tasks,runs),'observed');
  runs[0].status='completed';assert.equal(taskDisplayState(task,runs),'completed');assert.equal(memberState(member,c.team.tasks,runs),'completed');
  runs[0].status='failed';assert.equal(taskDisplayState(task,runs),'failed');assert.equal(memberState(member,c.team.tasks,runs),'failed');
});

test('host agent paths resolve through Leader activity and encrypted prompts use public attempt acknowledgements',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'native-path-')),marker='TEAM_WORKSPACE_ATTEMPT:current';
  let text=marker;let duplicate=false;
  const rpc={async connect(){},async close(){},async call(method,args){
    assert.equal(method,'thread/read');
    if(args.threadId==='leader')return {thread:{id:'leader',turns:[{items:[{type:'subAgentActivity',agentPath:'/root/reader',agentThreadId:'child'}]}]}};
    return {thread:{id:'child',parentThreadId:'leader',cwd,source:{subAgent:{thread_spawn:{agent_path:'/root/reader'}}},turns:[{id:'turn',status:'completed',items:[{type:'agentMessage',phase:'commentary',text},{type:'agentMessage',phase:'final_answer',text:'Read-only result'}]},...(duplicate?[{id:'old',status:'completed',items:[{type:'agentMessage',phase:'commentary',text:marker}]}]:[])]}};
  }};
  const observer=new NativeMembers({rpcFactory:()=>rpc});
  const run=await observer.inspect('leader',cwd,'/root/reader',marker);assert.equal(run.threadId,'child');assert.equal(run.agentPath,'/root/reader');assert.equal(run.attemptIdentitySource,'public-member-acknowledgement');assert.equal(run.outputs.length,1);
  text='Quoted '+marker;await assert.rejects(()=>observer.inspect('leader',cwd,'/root/reader',marker),/uniquely/);
  text=marker;duplicate=true;await assert.rejects(()=>observer.inspect('leader',cwd,'/root/reader',marker),/uniquely/);
  await observer.close();
});

test('native outbox survives engine restart, fences attempts and verifies member receipt separately',async()=>{
  const f=await fixture(),c=await claim(f,'work');
  const run=seed(f,c.dispatch,'child','working','inProgress');
  const bound=await f.engine.bind('owner',f.team.id,c.team.revision,'work',c.dispatch.attemptId,'child');
  const queued=await f.engine.message('owner',f.team.id,bound.team.revision,'work','Check negative case','request-1');
  const message=queued.messages[0];assert.equal(message.status,'queued');assert.equal(queued.leaderAction.type,'message-native-member');
  const restarted=new LeaderEngine({root:f.engine.root,observer:f.observer});
  const retry=await restarted.message('owner',f.team.id,queued.team.revision,'work','Check negative case','request-1');
  assert.equal(retry.messages.length,1);assert.equal(retry.messages[0].id,message.id);assert.equal(retry.leaderAction.type,'verify-message-before-retry');
  await assert.rejects(()=>restarted.message('owner',f.team.id,retry.team.revision,'work','Different text','request-1'),/different/);
  const reported=await restarted.messageDelivery('owner',f.team.id,retry.team.revision,message.id,'host-accepted','Host tool returned success; member receipt not yet seen');
  assert.equal(reported.messages[0].status,'host-accepted');
  await assert.rejects(()=>restarted.reconcileMessage('owner',f.team.id,reported.team.revision,message.id),/No exact/);
  run.messageAcknowledgements=[message.marker];f.runs.set(c.dispatch.marker,run);
  run.turnId='wrong-turn';await assert.rejects(()=>restarted.reconcileMessage('owner',f.team.id,reported.team.revision,message.id),/original message turn/);run.turnId=c.dispatch.attemptId;
  const confirmed=await restarted.reconcileMessage('owner',f.team.id,reported.team.revision,message.id);
  assert.equal(confirmed.messages[0].status,'acknowledged');assert.equal(confirmed.messages[0].events.at(-1).source,'native-public-member-receipt');
  const next=await restarted.message('owner',f.team.id,confirmed.team.revision,'work','Another note','request-2');
  await restarted.store.update(f.team.id,'owner',next.team.revision,t=>{t.tasks[0].attempts.push({...t.tasks[0].attempts[0],id:'different-attempt'});});
  const stale=await restarted.read('owner',f.team.id);assert.equal(stale.messages[1].stale,true);
  await assert.rejects(()=>restarted.messageDelivery('owner',f.team.id,stale.team.revision,next.messages[1].id,'unknown','Uncertain outcome'),/older attempt/);
  await assert.rejects(()=>restarted.read('other-owner',f.team.id),/not found/);
});

test('an early message with an unknown turn cannot block review settlement or independent acceptance',async()=>{
  const f=await fixture(),work=await claim(f,'work');await bindSettle(f,work,'child-dev','Original implementation and checks');
  const c=await claim(f,'review');
  f.runs.set(c.dispatch.marker,{threadId:'child-qa',turnId:null,status:'starting',outputs:[],commands:[]});
  const linked=await f.engine.bind('owner',f.team.id,c.team.revision,'review',c.dispatch.attemptId,'child-qa');
  const queued=await f.engine.message('owner',f.team.id,linked.team.revision,'review','Check all acceptance conditions','early-message');
  assert.equal(queued.messages[0].turnId,null);
  const reported=await f.engine.messageDelivery('owner',f.team.id,queued.team.revision,queued.messages[0].id,'host-accepted','Host accepted steering; no member receipt yet');
  const run=seed(f,c.dispatch,'child-qa',JSON.stringify({summary:'independent review',decision:'accept',reason:'Conditions verified',checks:[{name:'actual check',status:'PASS',evidence:'Original fixture check evidence'}],findings:[]}));
  const restarted=new LeaderEngine({root:f.engine.root,observer:f.observer});
  const settled=await restarted.settle('owner',f.team.id,reported.team.revision,'review',c.dispatch.attemptId);
  assert.equal(settled.team.tasks[1].status,'submitted');assert.equal(settled.team.tasks[1].attempts.at(-1).turnId,c.dispatch.attemptId);
  assert.equal(settled.messages[0].status,'host-accepted');assert.equal(settled.messages[0].turnId,null,'settlement is not a message receipt');
  const before=await restarted.store.get(f.team.id,'owner');
  await assert.rejects(()=>restarted.reconcileMessage('owner',f.team.id,before.revision,queued.messages[0].id),/No exact/);
  assert.deepEqual(await restarted.store.get(f.team.id,'owner'),before);
  run.messageAcknowledgements=[queued.messages[0].marker];run.turnId='unrelated-turn';
  await assert.rejects(()=>restarted.reconcileMessage('owner',f.team.id,before.revision,queued.messages[0].id),/No exact/);
  assert.deepEqual(await restarted.store.get(f.team.id,'owner'),before);
  run.turnId=c.dispatch.attemptId;
  const receipt=await restarted.reconcileMessage('owner',f.team.id,before.revision,queued.messages[0].id);
  assert.equal(receipt.messages[0].status,'acknowledged');assert.equal(receipt.messages[0].turnId,c.dispatch.attemptId);
  assert.ok(receipt.messages[0].events.some(e=>e.type==='turn-bound'&&e.previousTurnId===null&&e.turnId===c.dispatch.attemptId));
  const accepted=await restarted.acceptReview('owner',f.team.id,receipt.team.revision,'review',c.dispatch.attemptId,'accept','Reviewed original independent evidence');
  assert.ok(accepted.team.tasks.every(t=>t.status==='accepted'));
  await restarted.close();await f.engine.close();
});

test('rebinding a pending native turn preserves an early message without pretending it was acknowledged',async()=>{
  const f=await fixture(),c=await claim(f,'work');
  f.runs.set(c.dispatch.marker,{threadId:'child-dev',turnId:null,status:'starting',outputs:[],commands:[]});
  const linked=await f.engine.bind('owner',f.team.id,c.team.revision,'work',c.dispatch.attemptId,'child-dev');
  const queued=await f.engine.message('owner',f.team.id,linked.team.revision,'work','Preserve original requirements','early-rebind');
  seed(f,c.dispatch,'child-dev','Working','inProgress');
  const bound=await f.engine.bind('owner',f.team.id,queued.team.revision,'work',c.dispatch.attemptId,'child-dev');
  assert.equal(bound.team.tasks[0].attempts.at(-1).state,'running');assert.equal(bound.messages[0].status,'queued');assert.equal(bound.messages[0].turnId,null);
  assert.deepEqual(bound.messages[0],queued.messages[0]);assert.equal(bound.team.totalDispatches,1);
  await f.engine.close();
});
