import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {TeamNavigation} from '../src/team-navigation.mjs';

async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'team-navigation-'));
  const member={id:'dev',role:'开发',agentThreadId:'child',rosterVerified:true,rosterMarker:'member-marker'};
  const task={id:'work',memberId:'dev',title:'Work',attempts:[{id:'old',agentThreadId:'child',turnId:'turn-old',marker:'old-marker'},{id:'new',agentThreadId:'child',turnId:'turn-new',marker:'new-marker'}]};
  const team={id:'team',projectPath:'E:/project',leaderThreadId:'leader',mode:'host-leader',members:[member],tasks:[task]};
  const calls=[],context={cwd:'E:/project',threadId:'leader'};let now=10000;
  const store={async get(id,owner){assert.equal(id,'team');if(owner!=='owner')throw new Error('not owned');return structuredClone(team);}};
  const observer={async inspect(parent,cwd,threadId,marker){calls.push({parent,cwd,threadId,marker});return {threadId,parentThreadId:parent,turnId:marker==='old-marker'?'turn-old':marker==='new-marker'?'turn-new':'init'};}};
  const nav=new TeamNavigation({root,store,observer,clock:()=>now});
  return {nav,team,member,task,context,calls,setClock:value=>now=value,args:()=>({teamId:'team',memberId:'dev',taskId:'work',attemptId:'old',requestId:randomUUID()})};
}
test('navigation retains exact historical task round and native member without dispatching',async()=>{
  const f=await fixture(),args=f.args(),r=await f.nav.request('owner',f.context,args);
  assert.equal(r.request.target.turnId,'turn-old');assert.equal(r.request.target.threadId,'child');assert.equal(r.request.target.nativeTurnAnchorSupported,false);
  assert.deepEqual(r.leaderAction.threadId,'child');assert.match(r.message,/TEAM_WORKSPACE_NAVIGATION:/);assert.equal(r.request.ownerId,undefined);
  assert.equal(f.calls[0].marker,'old-marker');
  const read=await f.nav.read('owner',f.context,'team',args.requestId);assert.equal(read.request.status,'requested');
  const recorded=await f.nav.record('owner',f.context,{teamId:'team',requestId:args.requestId,status:'opened',note:'Actual host tool accepted'});
  assert.equal(recorded.request.status,'opened');assert.equal(recorded.leaderAction,null);assert.equal(recorded.request.source,'leader-recorded-host-navigation-result');
});
test('same request is idempotent; different target with same request is rejected',async()=>{
  const f=await fixture(),args=f.args(),first=await f.nav.request('owner',f.context,args),same=await f.nav.request('owner',f.context,args);
  assert.deepEqual(same.request,first.request);
  await assert.rejects(f.nav.request('owner',f.context,{...args,attemptId:'new'}),/requestId/);
});
test('navigation rejects foreign owner, project, Leader, member, task and attempt',async()=>{
  const f=await fixture();
  await assert.rejects(f.nav.request('foreign',f.context,f.args()),/owned/);
  await assert.rejects(f.nav.request('owner',{...f.context,cwd:'E:/other'},f.args()),/Leader/);
  await assert.rejects(f.nav.request('owner',{...f.context,threadId:'other'},f.args()),/Leader/);
  await assert.rejects(f.nav.request('owner',f.context,{...f.args(),memberId:'unknown'}),/绑定/);
  await assert.rejects(f.nav.request('owner',f.context,{...f.args(),taskId:'unknown'}),/不匹配/);
  await assert.rejects(f.nav.request('owner',f.context,{...f.args(),attemptId:'unknown'}),/不存在/);
  f.task.memberId='qa';await assert.rejects(f.nav.request('owner',f.context,f.args()),/不匹配/);
});
test('roster/host identity mismatch and missing initialization block navigation',async()=>{
  const f=await fixture();f.member.rosterVerified=false;
  await assert.rejects(f.nav.request('owner',f.context,f.args()),/绑定/);f.member.rosterVerified=true;
  f.task.attempts[0].agentThreadId='other';await assert.rejects(f.nav.request('owner',f.context,f.args()),/固定成员/);
  f.task.attempts[0].agentThreadId='child';f.nav.observer={inspect:async()=>({threadId:'other',parentThreadId:'leader',turnId:'turn-old'})};
  await assert.rejects(f.nav.request('owner',f.context,f.args()),/父子关系/);
  f.nav.observer={inspect:async()=>({threadId:'child',parentThreadId:'leader',turnId:'wrong'})};
  await assert.rejects(f.nav.request('owner',f.context,f.args()),/轮次/);
});
test('new navigation supersedes an old one; cancellation and expiry prevent late success',async()=>{
  const f=await fixture(),first=await f.nav.request('owner',f.context,f.args()),second=await f.nav.request('owner',f.context,{...f.args(),attemptId:'new'});
  assert.equal((await f.nav.read('owner',f.context,'team',first.request.id)).request.status,'superseded');
  await assert.rejects(f.nav.record('owner',f.context,{teamId:'team',requestId:first.request.id,status:'opened',note:'late'}),/已过期/);
  await f.nav.cancel('owner',f.context,'team',second.request.id);
  assert.equal((await f.nav.read('owner',f.context,'team',second.request.id)).request.status,'superseded');
  const third=await f.nav.request('owner',f.context,f.args());f.setClock(130000);
  assert.equal((await f.nav.read('owner',f.context,'team',third.request.id)).request.status,'expired');
  await assert.rejects(f.nav.record('owner',f.context,{teamId:'team',requestId:third.request.id,status:'opened',note:'late'}),/已过期/);
});
test('return-to-Leader navigation reuses the verified relationship and failed requests stay failed',async()=>{
  const f=await fixture(),r=await f.nav.request('owner',f.context,{...f.args(),destination:'leader'});
  assert.equal(r.leaderAction.threadId,'leader');assert.equal(r.request.target.threadId,'child');
  const args={teamId:'team',requestId:r.request.id,status:'failed',note:'Host denied'};
  await f.nav.record('owner',f.context,args);assert.equal((await f.nav.record('owner',f.context,args)).request.status,'failed');
  await assert.rejects(f.nav.record('owner',f.context,{...args,status:'opened'}),/已结束/);
});
