import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {memberGoalDetail} from '../src/member-goals.mjs';
import {buildHandoff} from '../src/team-checkpoints.mjs';
import {validateTeam} from '../src/team.mjs';
import {TeamArchive} from '../src/team-archive.mjs';
import {TeamArchive as LegacyArchive} from './fixtures/legacy-archive-v011.mjs';

const role=(id,writeScopes=[])=>({id,role:id,responsibility:id==='dev'?'原角色目标':'独立审查',reason:'Scoped responsibility',writeScopes});
const work=(id,dependencies=[])=>({id,title:id,goal:'完成 '+id,acceptance:'独立检查通过',memberId:'dev',kind:'work',dependencies});
const review=id=>({id:'review-'+id,title:'Review '+id,goal:'独立检查 '+id,acceptance:'证据通过',memberId:'qa',kind:'review',reviewOfTaskId:id,dependencies:[{taskId:id,when:'submitted'}]});
async function fixture(extra={}){
  const root=await mkdtemp(join(tmpdir(),'member-goals-')),runs=new Map();
  const observer={calls:0,async inspect(parent,cwd,thread,marker){this.calls++;const run=runs.get(marker);if(!run||run.threadId!==thread)throw new Error('No verified native execution');return structuredClone(run);}};
  const engine=new LeaderEngine({root,observer}),team=await engine.planOnce('owner',{cwd:root,threadId:'leader'},{goal:'完成交付并进行独立审查',execute:true,initializeMembers:true,memberStartup:'on-demand',plan:{members:[role('dev',['src']),role('qa')],tasks:[work('a'),review('a'),work('b',[{taskId:'a',when:'submitted'}]),review('b')]},...extra});
  const saved=()=>engine.native('owner',team.id),claim=async(id='a')=>{const t=await saved();return engine.claim('owner',team.id,t.revision,id);};
  const input=(goal='新角色目标',goalRevision=1)=>({memberId:'dev',goal,goalRevision,requestId:randomUUID(),note:'用户调整工作侧重点',source:'panel-user-action'});
  const edit=async(value=input(),revision)=>{const t=await saved();return engine.updateMemberGoal('owner',team.id,revision??t.revision,value);};
  return {root,runs,observer,engine,team,saved,claim,input,edit};
}

test('manual goal edits preserve reservations and current instructions; subsequent clean dispatch uses the new goal',async()=>{
  const f=await fixture(),reserved=await f.claim(),before=await f.saved(),calls=f.observer.calls;
  const changed=await f.edit();assert.equal(changed.goalRevision,2);assert.equal(changed.revision,before.revision+1);assert.equal(changed.history.length,0);assert.equal(f.observer.calls,calls);
  let t=await f.saved();assert.equal(t.requiresTeamWorkspaceVersion,'0.15.0');assert.deepEqual(t.tasks.map(x=>({goal:x.goal,acceptance:x.acceptance,attempts:x.attempts.length})),before.tasks.map(x=>({goal:x.goal,acceptance:x.acceptance,attempts:x.attempts.length})));
  assert.equal(t.members[0].id,before.members[0].id);assert.equal(t.members[0].role,before.members[0].role);assert.deepEqual(t.members[0].writeScopes,['src']);
  assert.equal(t.tasks[0].attempts[0].memberGoalSnapshot.goal,'原角色目标');assert.equal(buildHandoff(t,'a').member.responsibility,'原角色目标');assert.equal(buildHandoff(t,'b').member.responsibility,'新角色目标');
  const replay=await f.claim();assert.equal(replay.dispatch.attemptId,reserved.dispatch.attemptId);assert.equal(replay.dispatch.prompt,reserved.dispatch.prompt);
  f.runs.set(reserved.dispatch.marker,{threadId:'native-a',turnId:'turn-a',status:'inProgress',outputs:[],commands:[]});
  const bound=await f.engine.bind('owner',t.id,replay.team.revision,'a',reserved.dispatch.attemptId,'native-a');const activeCalls=f.observer.calls;
  await f.edit(f.input('第三版目标',2));assert.equal(f.observer.calls,activeCalls);t=await f.saved();assert.equal(t.tasks[0].attempts[0].agentThreadId,'native-a');assert.equal(t.tasks[0].attempts[0].state,'running');assert.equal(buildHandoff(t,'a').member.responsibility,'原角色目标');assert.equal(t.dispatchPaused,false);
  f.runs.set(reserved.dispatch.marker,{threadId:'native-a',turnId:'turn-a',status:'completed',outputs:[{text:reserved.dispatch.marker+'\n完成交付'}],commands:[]});
  await f.engine.settle('owner',t.id,t.revision,'a',reserved.dispatch.attemptId);const next=await f.claim('b');
  assert.match(next.dispatch.prompt,/Responsibility: 第三版目标/);assert.doesNotMatch(next.dispatch.prompt,/Responsibility: 原角色目标/);assert.equal(next.dispatch.existingThreadId,null);assert.equal(next.dispatch.spawnOptions.fork_turns,'none');
  assert.deepEqual(next.team.tasks.find(t=>t.id==='b').attempts[0].memberGoalSnapshot,{revision:3,goal:'第三版目标',source:'task-reservation'});assert.equal(validateTeam(next.team),true);
});

test('goal edits are durable, idempotent across lost responses, and conflict checked without mutating unrelated records',async()=>{
  const f=await fixture(),request=f.input(),before=await f.saved();await f.edit(request);const after=await f.saved();
  const restarted=new LeaderEngine({root:f.root,observer:f.observer});const replay=await restarted.updateMemberGoal('owner',after.id,before.revision,request);assert.equal(replay.change.replayed,true);assert.deepEqual(await f.saved(),after);
  await assert.rejects(()=>f.edit({...request,goal:'改了内容'}),/requestId/);await assert.rejects(()=>f.edit(f.input('过期目标',1)),/其他操作修改/);await assert.rejects(()=>f.edit(f.input('目标三',2),before.revision),/changed/);
  await assert.rejects(()=>restarted.updateMemberGoal('another-owner',after.id,after.revision,f.input()),/not found/);assert.deepEqual(await f.saved(),after);
  const detail=memberGoalDetail(after,'dev');assert.equal(detail.revision,after.revision);assert.equal(detail.goalRevision,2);assert.equal(detail.history[0].previous.goal,'原角色目标');assert.equal(detail.history[0].next.goal,'新角色目标');assert.equal(detail.history[0].source,'panel-user-action');assert.equal('hash' in detail.history[0],false);
  const results=await Promise.allSettled([f.edit(f.input('并发甲',2)),f.edit(f.input('并发乙',2))]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await f.saved()).memberGoalChanges.length,2);
});

test('unapproved, historical, removed and cancelled roles cannot be edited; paused teams remain paused',async()=>{
  const pending=await fixture({approvalMode:'required'}),snapshot=await pending.saved();await assert.rejects(()=>pending.edit(),/unapproved/);assert.deepEqual(await pending.saved(),snapshot);
  for(const change of [t=>{t.state='superseded';},t=>{t.state='cancelled';},t=>{t.members[0].removedAt=new Date().toISOString();t.members[0].status='removed';for(const task of t.tasks.filter(t=>t.memberId==='dev'))task.status='cancelled';}]){
    const f=await fixture(),t=await f.saved();await f.engine.store.update(t.id,'owner',t.revision,change);const before=await f.saved();await assert.rejects(()=>f.edit(),/read-only|当前原生团队|已移除/);assert.deepEqual(await f.saved(),before);
  }
  const f=await fixture(),t=await f.saved();await f.engine.store.update(t.id,'owner',t.revision,t=>{t.dispatchPaused=true;t.state='paused';});await f.edit();assert.equal((await f.saved()).dispatchPaused,true);assert.equal((await f.saved()).tasks[0].attempts.length,0);
  for(const patch of [{goal:' '},{goal:'x'.repeat(2001)},{requestId:'bad'},{goalRevision:0},{source:'invented'},{note:''}]){const before=await f.saved();await assert.rejects(()=>f.edit({...f.input('有效目标',2),...patch}));assert.deepEqual(await f.saved(),before);}
});

test('goal history and frozen snapshots survive segmentation; tampered or downgraded records are rejected',async()=>{
  const f=await fixture();await f.claim();for(let revision=1;revision<=7;revision++)await f.edit(f.input('角色目标第 '+(revision+1)+' 版',revision));
  const t=await f.saved(),archive=new TeamArchive(join(f.root,'segmented'),{hotRows:1,segmentRows:2}),stored=await archive.compact(t),hydrated=await archive.hydrate(stored);
  assert.ok(stored.archiveManifest.segments.some(s=>s.field==='memberGoalChanges'));assert.deepEqual(hydrated,t);assert.equal(validateTeam(hydrated),true);
  await assert.rejects(()=>new LegacyArchive(join(f.root,'segmented')).hydrate(stored),/Unsupported/);
  for(const tamper of [x=>{x.requiresTeamWorkspaceVersion='0.14.0';},x=>{x.members[0].responsibility='被覆盖';},x=>{x.memberGoalChanges[1].previous.goal='断链';},x=>{x.tasks[0].attempts[0].memberGoalSnapshot.goal='伪造';},x=>{x.memberGoalChanges=[];}]){const bad=structuredClone(t);tamper(bad);assert.throws(()=>validateTeam(bad));}
  assert.equal(t.memberGoalChanges[0].previous.goal,'原角色目标');assert.equal(t.tasks[0].attempts[0].memberGoalSnapshot.goal,'原角色目标');
});

test('a long role goal is read verbatim and future dispatch still respects its complete prompt budget',async()=>{
  const f=await fixture(),goal='精确目标'.repeat(500);await f.edit(f.input(goal));const before=await f.saved();assert.equal(memberGoalDetail(before,'dev').goal,goal);
  const c=await f.claim();assert.ok(c.dispatch.prompt.includes(goal));assert.ok(c.dispatch.prompt.length<=24000);
  let t=await f.saved();await f.engine.store.update(t.id,'owner',t.revision,t=>{t.tasks[0].acceptance='不可省略的验收'.repeat(6000);});t=await f.saved();await assert.rejects(()=>f.claim(),/Complete dispatch prompt exceeds/);assert.deepEqual(await f.saved(),t);
});
