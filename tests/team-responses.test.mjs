import test from 'node:test';
import assert from 'node:assert/strict';
import {teamResponse,advancementResponse} from '../src/team-responses.mjs';
import {RequestContext} from '../src/request-context.mjs';
import {PANEL_MAX_BYTES,panelTasks} from '../src/panel-response.mjs';
import {workflowActions} from '../src/team-workflow.mjs';
import {coordinationResponse} from '../src/team-coordination-response.mjs';

import {largeDisplayFixture} from './fixtures/large-display.mjs';
test('exhausted or unverifiable usage yields one blocker, never a wait even with the same cursor',()=>{
 for(const usage of [{exhausted:true,limit:100,totalTokens:101,complete:true},{unverifiable:true,limit:100,totalTokens:30,complete:false}]){
  const data=largeDisplayFixture();data.runs=[];data.workflow={actions:[],stage:'observe'};data.usage=usage;const before=structuredClone(data);
  const first=coordinationResponse(data),again=coordinationResponse(data,{cursor:first.cursor}),advance=advancementResponse(data,'coordination',{includeWaitProgram:true});
  for(const r of [first,again,advance]){assert.equal(r.waitBlocked,true);assert.equal(r.nextAction,'token-budget-limit');assert.equal(r.nextTool,null);assert.deepEqual(r.budgetBlocker.activeNativeWork,[]);assert.equal(r.unchanged,undefined);assert.equal(r.continuationArgs,undefined);assert.equal(r.waitInvocation,undefined);}
  assert.deepEqual(data,before);
 }
});
test('budget blocker preserves actual active members and terminal completion takes precedence',()=>{
 const data=largeDisplayFixture(),task=data.team.tasks[0],a=task.attempts.at(-1);task.status='running';data.team.leaderThreadId='leader';data.runs=[{taskId:task.id,attemptId:a.id,threadId:'native-child',turnId:'real-turn',status:'inProgress'}];data.workflow={actions:[],stage:'observe'};data.usage={exhausted:true,limit:100,totalTokens:101};
 const before=structuredClone(data),r=advancementResponse(data,'coordination',{includeWaitProgram:true});assert.equal(r.waitBlocked,true);assert.deepEqual(r.budgetBlocker.activeNativeWork,[{taskId:task.id,attemptId:a.id,threadId:'native-child',turnId:'real-turn',status:'inProgress'}]);assert.equal(r.terminal,undefined);assert.deepEqual(data,before);
 data.team.state='delivered';const done=advancementResponse(data,'coordination',{includeWaitProgram:true});assert.equal(done.terminal,true);assert.equal(done.nextAction,'return-result');assert.equal(done.continuationArgs,undefined);
});
test('a paused rework plan without workers is actionable, never an empty wait or an automatic resume',()=>{
 const data=largeDisplayFixture();data.runs=[];data.team.tasks=data.team.tasks.slice(-1);data.team.tasks[0].status='waiting';data.team.state='rework-planned';data.team.dispatchPaused=true;
 const before=structuredClone(data.team);data.workflow=workflowActions(data.team,[]);const r=advancementResponse(data,'coordination',{includeWaitProgram:true});
 assert.equal(r.requiresLeaderAction,true);assert.equal(r.stage,'dispatch-paused');assert.equal(r.actions.find(a=>a.type==='dispatch-paused').tool,'start_team');assert.equal(r.continuationArgs,undefined);assert.equal(r.waitInvocation,undefined);assert.deepEqual(data.team,before);
 data.team.tasks[0].status='running';assert.equal(workflowActions(data.team,[]).actions.some(a=>a.type==='dispatch-paused'),false,'A real running native task may still produce a terminal event');
 data.team.tasks[0].status='waiting';data.team.executionControl={status:'halted'};assert.equal(workflowActions(data.team,[]).actions.some(a=>a.type==='dispatch-paused'),false,'Never authorize start_team in place of stop reconciliation');
});
test('ordinary advancement returns a cold-store wait entry once, but decisions and other hosts cannot wait',()=>{
 const data=largeDisplayFixture();data.runs=[];data.workflow={actions:[],stage:'observe'};const before=structuredClone(data);
 const r=advancementResponse(data,'coordination',{finishReady:true,includeWaitProgram:true,includeLegacyWaitProgram:false});
 assert.equal(r.waitProgram,undefined);assert.match(r.waitInvocation,/operation:'next_team_step'/);assert.match(r.waitInvocation,/for\(let i=0;i<4/);assert.equal(r.continuationArgs.finishReady,true);assert.deepEqual(data,before);
 data.team.hostId='dsh';assert.equal(advancementResponse(data,'coordination',{includeWaitProgram:true}).waitInvocation,undefined);
 data.team.hostId='codex';data.team.state='delivered';assert.equal(advancementResponse(data,'coordination',{includeWaitProgram:true}).waitInvocation,undefined);
 data.team.state='active';data.workflow.actions=[{type:'settlement-exception',taskId:'task5',reason:'Original rejected evidence'}];assert.equal(advancementResponse(data,'coordination',{includeWaitProgram:true}).waitInvocation,undefined);
});
test('cancelled history cannot crowd current work out of the panel preview',()=>{
 const cancelled=Array.from({length:80},(_,i)=>({id:'cancelled-'+i,status:'cancelled',batchId:'current',attempts:[{id:'original-'+i}]}));
 const accepted=Array.from({length:9},(_,i)=>({id:'accepted-'+i,status:'accepted',batchId:'current'})),tasks=[...cancelled,...accepted],before=structuredClone(tasks);
 const rows=panelTasks(tasks,'current');assert.equal(rows.length,80);assert.equal(rows.filter(t=>t.status==='accepted').length,9);assert.equal(rows.filter(t=>t.status==='cancelled').length,71);assert.deepEqual(tasks,before);
 assert.deepEqual(panelTasks(tasks.slice(0,12),'current'),tasks.slice(0,12));
});
test('native dispatch transport preserves launch arguments and explicitly avoids functions.exec probes',()=>{
 const data=largeDisplayFixture(),packet={teamId:'team',taskId:'work',dispatchReference:{path:'/saved/exact.json'},prompt:'duplicate',nativeAction:{tool:'spawn_agent',arguments:{task_name:'exact',message:'exact isolated message',fork_turns:'none'}}};data.dispatches=[packet];const before=structuredClone(data);const r=advancementResponse(data);assert.match(r.nativeDispatchInstruction,/directly/);assert.match(r.nativeDispatchInstruction,/not on the functions.exec tools object/);assert.deepEqual(r.dispatches[0].nativeAction,packet.nativeAction);assert.equal(r.dispatches[0].prompt,undefined);assert.deepEqual(data,before);
});

test('a returned native dispatch precedes every wait even with another active worker',()=>{
 const data=largeDisplayFixture();data.workflow={actions:[],stage:'observe'};
 const packet={teamId:'team',taskId:'work',attemptId:'reserved',nativeAction:{tool:'spawn_agent',arguments:{task_name:'exact',message:'FULL_CONTRACT',fork_turns:'none'}}};data.dispatches=[packet];
 const before=structuredClone(data),reply=advancementResponse(data,'coordination',{includeWaitProgram:true});
 assert.equal(reply.nextAction,'dispatch-native');assert.equal(reply.waitCall,undefined);assert.equal(reply.continuationArgs,undefined);assert.equal(reply.waitInvocation,undefined);assert.deepEqual(reply.dispatches,[packet]);assert.deepEqual(data,before);
});

test('unconfirmed reservations cannot receive unchanged waits or infer a safe redispatch',()=>{
 for(const run of [undefined,{threadId:'unconfirmed',status:'unknown'}]){
  const data=largeDisplayFixture();data.team.tasks=data.team.tasks.slice(0,1);const task=data.team.tasks[0];task.executionMode='member';task.status='running';task.attempts=[{id:'original-reservation',state:'reserved'}];data.runs=run?[{...run,taskId:task.id,attemptId:'original-reservation'}]:[];data.workflow=workflowActions(data.team,data.runs);
  const before=structuredClone(data),first=coordinationResponse(data),again=coordinationResponse(data,{cursor:first.cursor}),reply=advancementResponse(data,'coordination',{includeWaitProgram:true});
  for(const r of [first,again,reply]){assert.equal(r.requiresLeaderAction,true);assert.equal(r.unchanged,undefined);assert.equal(r.waitInvocation,undefined);assert.equal(r.continuationArgs,undefined);assert.equal(r.dispatches,undefined);assert.match(r.actions[0].instruction,/otherwise reconcile/);}
  assert.deepEqual(data,before);
 }
 const data=largeDisplayFixture();data.team.tasks=data.team.tasks.slice(0,1);const task=data.team.tasks[0];task.executionMode='member';task.status='running';task.attempts=[{id:'original-reservation',state:'reserved'}];data.runs=[{threadId:'real-child',status:'inProgress',taskId:task.id,attemptId:'original-reservation'}];data.workflow=workflowActions(data.team,data.runs);
 const reply=advancementResponse(data,'coordination',{includeWaitProgram:true});assert.equal(reply.requiresLeaderAction,undefined);assert.equal(typeof reply.waitInvocation,'string');assert.equal(reply.dispatches,undefined);
});
test('exhausted repair policy is one explicit decision, never a wait or another repair instruction',()=>{
 const data=largeDisplayFixture();data.workflow={actions:[{type:'review-round-limit',taskId:'work',requiresLeaderValidation:true,requiresUserDecision:true,round:3,limit:3}],stage:'observe'};data.runs=[];
 const r=advancementResponse(data,'coordination',{includeWaitProgram:true});assert.equal(r.requiresLeaderAction,true);assert.equal(r.requiresUserDecision,true);assert.equal(r.waitBlocked,true);assert.equal(r.nextAction,'review-round-limit');assert.equal(r.nextTool,null);assert.equal(r.continuationArgs,undefined);assert.equal(r.waitProgram,undefined);
});

test('member totals are computed from full history before panel and state previews truncate attempts',()=>{
 const data=largeDisplayFixture(),member=data.team.members[0];data.team.activeBatchId='current';
 data.team.tasks=[{...data.team.tasks[0],id:'current',memberId:member.id,batchId:'current',attempts:Array.from({length:24},(_,i)=>({id:'current-'+i,number:i+1,memberId:member.id}))},{...data.team.tasks[0],id:'old',memberId:'other-owner',batchId:'old',attempts:Array.from({length:13},(_,i)=>({id:'old-'+i,number:i+1,memberId:member.id}))}];data.runs=[];
 const frozen=structuredClone(data),panel=teamResponse(data,'panel'),state=teamResponse(data,'state');
 assert.ok(panel.team.tasks[0].attempts.length<24);assert.deepEqual(panel.team.members[0].executionCounts,{total:37,currentGoal:24});assert.deepEqual(state.team.members[0].executionCounts,{total:37,currentGoal:24});assert.deepEqual(data,frozen);
});

test('panel previews and state are bounded for multi-megabyte duplicated logs; full evidence stays exact',()=>{
  const data=largeDisplayFixture(),panel=teamResponse(data,'panel'),state=teamResponse(data,'state');
  assert.ok(Buffer.byteLength(JSON.stringify(panel))<=PANEL_MAX_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(state))<45*1024);
  assert.equal(panel.displayLimits.truncated,true);assert.equal(panel.evidenceAccess.arguments.view,'evidence');
  assert.equal(panel.team.tasks.length,6);assert.equal(panel.team.tasks[5].attempts.at(-1).id,'attempt5-2');
  assert.equal(panel.team.tasks[0].attempts[0].observation,undefined);
  assert.equal(state.runs.at(-1).activity.lastActivity,undefined);
  assert.equal(teamResponse(data,'full').team,data.team);assert.equal(teamResponse(data,'full').runs[0].commands,data.runs[0].commands);
  assert.equal(data.team.tasks[0].attempts[0].observation.commands[0].output.length,18000);
});

test('panel caps structural history and labels omissions without changing the saved roster or records',()=>{
  const data=largeDisplayFixture();data.team.tasks=Array.from({length:300},(_,i)=>({...data.team.tasks[0],id:'task'+i,number:i+1,status:i===299?'running':'accepted'}));
  const panel=teamResponse(data,'panel');assert.ok(Buffer.byteLength(JSON.stringify(panel))<=PANEL_MAX_BYTES);
  assert.equal(panel.displayLimits.totalTasks,300);assert.equal(panel.displayLimits.truncated,true);
  assert.ok(panel.team.tasks.some(t=>t.id==='task299'));assert.equal(data.team.tasks.length,300);
});

test('lightweight responses retain identities and dispatch but full evidence remains lossless',()=>{
  const original={team:{id:'team',revision:9,mode:'host-leader',state:'active',projectPath:'E:/project',leaderThreadId:'leader',members:[{id:'dev',role:'Dev',displayName:'project-Dev',agentThreadId:'child',agentPath:'/root/dev'}],tasks:[{id:'work',title:'Read source',memberId:'dev',status:'running',kind:'work',dependencies:[],attempts:[{id:'old'},{id:'now',state:'running',turnId:'turn',agentThreadId:'child'}],evidence:[{summary:'history '.repeat(20000)}]}]},runs:[{taskId:'work',attemptId:'old',outputs:[{text:'old evidence'}]},{taskId:'work',attemptId:'now',status:'inProgress',outputs:[{text:'exact public delivery'}],commands:[{command:'actual test',exitCode:0}],observedAt:'2026-10-07T12:00:00Z'}],readiness:[],recovery:[],initializations:[],messages:[],checkpoints:[],observationMode:'saved',dispatch:{attemptId:'now',marker:'exact-marker',prompt:'Every acceptance criterion and context stays here'}};
  const before=structuredClone(original),full=teamResponse(original,'full'),summary=teamResponse(original),state=teamResponse(original,'state'),receipt=teamResponse(original,'summary','team-update');
  assert.deepEqual(original,before);assert.deepEqual(full.team,original.team);assert.deepEqual(full.runs,original.runs);
  assert.deepEqual(receipt.dispatch,original.dispatch);assert.equal(receipt.observationMode,'saved');
  assert.equal(summary.team.tasks[0].attempt.id,'now');assert.equal(summary.team.members[0].agentThreadId,'child');assert.equal(summary.evidenceAccess.arguments.view,'evidence');assert.deepEqual(summary.evidenceAccess.required,['taskId']);assert.equal(summary.evidenceAccess.fullHistory.view,'full');assert.equal(summary.evidenceAccess.fullHistory.explicitOnly,true);
  assert.equal(state.runs.length,1);assert.equal(state.runs[0].attemptId,'now');assert.ok(JSON.stringify(state).length<2000);assert.ok(JSON.stringify(summary).length<2500);
  assert.equal(state.detailToken,full.detailToken);
  const activity=structuredClone(original);activity.runs[1].status='completed';activity.runs[1].observedAt='2026-10-07T12:01:00Z';
  assert.equal(teamResponse(activity,'state').detailToken,full.detailToken,'a status-only change does not retransmit historical evidence');
  activity.runs[1].outputs[0].text='new public delivery';assert.notEqual(teamResponse(activity,'state').detailToken,full.detailToken);
  activity.runs[1].outputs=original.runs[1].outputs;activity.team.revision++;assert.notEqual(teamResponse(activity,'state').detailToken,full.detailToken);
});

test('host authorization is shared only within its own tool request, including concurrent checks',async()=>{
  let count=0;const context=new RequestContext(async meta=>({id:meta.threadId,sequence:++count})),extra={_meta:{threadId:'first'}};
  await context.run(async()=>{
    const [a,b]=await Promise.all([context.project(extra),context.project(extra)]);assert.equal(a,b);assert.equal(count,1);
    const other=await context.project({_meta:{threadId:'other'}});assert.equal(other.id,'other');assert.equal(count,2);
  });
  extra._meta.threadId='changed';const next=await context.run(()=>context.project(extra));assert.equal(next.id,'changed');assert.equal(count,3,'new request must reauthorize');
  await Promise.all([context.run(()=>context.project(extra)),context.run(()=>context.project(extra))]);assert.equal(count,5,'parallel tool requests cannot reuse authorization');
  await context.project(extra);assert.equal(count,6);
});
test('Leader receipts keep unfinished work but do not retransmit a whole project history',()=>{
  const tasks=Array.from({length:2200},(_,i)=>({id:'t'+i,title:'history',status:i===0?'running':'accepted',dependencies:[],attempts:[]})),data={team:{id:'team',revision:1,members:[],tasks},runs:[],readiness:[],checkpoints:Array.from({length:1000},()=>({id:'checkpoint'})),messages:[]};
  const summary=teamResponse(data);assert.equal(summary.taskHistory.total,2200);assert.equal(summary.team.tasks.length,21);assert.equal(summary.team.tasks[0].id,'t0');assert.equal(summary.team.tasks[1].number,2181);assert.equal(summary.checkpoints.length,20);assert.ok(JSON.stringify(summary).length<6000);assert.equal(teamResponse(data,'full').team.tasks.length,2200);
});

test('lightweight panel and state preserve a bounded registration reason, never the duplicated native observation',()=>{
 const data=largeDisplayFixture(),task=data.team.tasks[0],a=task.attempts.at(-1);a.settlementException={reason:'Exact contract delivery mismatch',inputHash:'original-hash',source:'plugin-settlement-gate',observation:{outputs:[{text:'native historical logs '.repeat(100000)}]}};const before=structuredClone(data);
 const panel=teamResponse(data,'panel'),state=teamResponse(data,'state');for(const attempt of [panel.team.tasks[0].attempts.at(-1),state.team.tasks[0].attempt]){assert.equal(attempt.settlementException.reason,'Exact contract delivery mismatch');assert.equal(attempt.settlementException.inputHash,'original-hash');assert.equal(attempt.settlementException.observation,undefined);}
 assert.deepEqual(data,before);assert.ok(Buffer.byteLength(JSON.stringify(panel))<=PANEL_MAX_BYTES);assert.equal(teamResponse(data,'full').team.tasks[0].attempts.at(-1).settlementException.observation,a.settlementException.observation);
});

test('cold coordination and summary point at the actual exposed router, never require a standalone wait tool',()=>{
 const data=largeDisplayFixture();data.runs=[];data.workflow={actions:[],stage:'observe'};const first=coordinationResponse(data),again=coordinationResponse(data,{cursor:first.cursor});assert.equal(again.nextTool,'team_leader');assert.equal(again.nextOperation,'next_team_step');assert.equal(again.wait,true);assert.equal(again.waitCall,undefined);for(const r of [first]){assert.equal(r.nextTool,'team_leader');assert.equal(r.waitCall.tool,'team_leader');assert.equal(r.waitCall.arguments.operation,'next_team_step');assert.equal(r.waitCall.arguments.arguments.teamId,data.team.id);assert.equal(r.waitCall.arguments.arguments.revision,data.team.revision);assert.equal(r.waitCall.arguments.arguments.wait,true);}const workflow=workflowActions(data.team,[]);assert.equal(workflow.communication.waitTool,'team_leader');assert.equal(workflow.communication.waitOperation,'next_team_step');assert.match(workflow.communication.instruction,/NOT a missing capability/);data.usage={exhausted:true};assert.equal(coordinationResponse(data).waitCall,undefined);
});
