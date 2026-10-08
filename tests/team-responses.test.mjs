import test from 'node:test';
import assert from 'node:assert/strict';
import {teamResponse} from '../src/team-responses.mjs';
import {RequestContext} from '../src/request-context.mjs';
import {PANEL_MAX_BYTES} from '../src/panel-response.mjs';

import {largeDisplayFixture} from './fixtures/large-display.mjs';

test('panel previews and state are bounded for multi-megabyte duplicated logs; full evidence stays exact',()=>{
  const data=largeDisplayFixture(),panel=teamResponse(data,'panel'),state=teamResponse(data,'state');
  assert.ok(Buffer.byteLength(JSON.stringify(panel))<=PANEL_MAX_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(state))<45*1024);
  assert.equal(panel.displayLimits.truncated,true);assert.equal(panel.evidenceAccess.arguments.view,'full');
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
  assert.equal(summary.team.tasks[0].attempt.id,'now');assert.equal(summary.team.members[0].agentThreadId,'child');assert.equal(summary.evidenceAccess.arguments.view,'full');
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
