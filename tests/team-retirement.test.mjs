import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {ProjectTeams} from '../src/project-teams.mjs';
import {TeamStore,validateTeam} from '../src/team.mjs';
import {TeamCoordination} from '../src/team-coordination.mjs';
import {TeamArchive as LegacyArchive} from './fixtures/legacy-archive-v011.mjs';
import {DurableStore} from '../src/durable-store.mjs';

const plan=()=>({members:[{id:'dev',role:'开发',responsibility:'交付',reason:'开发',writeScopes:[]},{id:'qa',role:'审查',responsibility:'独立验证',reason:'独立性',writeScopes:[]}],tasks:[{id:'work',title:'交付',goal:'实现目标',acceptance:'独立审查通过',memberId:'dev',kind:'work',dependencies:[]},{id:'review',title:'审查',goal:'验证目标',acceptance:'证据通过',memberId:'qa',kind:'review',reviewOfTaskId:'work',dependencies:[{taskId:'work',when:'submitted'}]}]});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'team-retirement-')),context={cwd:join(root,'project'),threadId:'leader'};await mkdir(context.cwd);
 const observer={calls:[],async inspect(parent,cwd,thread,marker,options){this.calls.push({thread,marker,options});return {threadId:thread,turnId:'turn-'+thread,status:'completed',quiescence:{turnId:'latest-'+thread,status:'completed',source:'native-latest-turn'}};}};
 const engine=new LeaderEngine({root:join(root,'records'),observer}),projects=new ProjectTeams(engine),args={goal:'完成当前目标并独立验收',execute:true,memberStartup:'on-demand',plan:plan()},team=(await projects.plan('owner',context,args)).team;
 const finish=async()=>{let t=await engine.native('owner',team.id);t=(await engine.store.update(t.id,'owner',t.revision,t=>{t.tasks.forEach(x=>x.status='accepted');})).team;await engine.finish('owner',t.id,t.revision,'最终验收通过',[{status:'PASS',evidence:'独立审查与最终检查记录'}]);return engine.native('owner',t.id);};
 const input=t=>({teamId:t.id,revision:t.revision,requestId:randomUUID(),reason:'目标完成，后续任务另建团队',source:'panel-user-action'});
 return {root,context,engine,observer,projects,args,team,finish,input};
}
test('explicit archive preserves accepted history, frees the project, and cannot reactivate through any store write',async()=>{
 const f=await fixture();let t=await f.engine.native('owner',f.team.id);
 await f.engine.updateMemberGoal('owner',t.id,t.revision,{memberId:'dev',goal:'保留人工调整的目标',goalRevision:1,requestId:randomUUID(),note:'人工调整',source:'panel-user-action'});
 t=await f.finish();const input=f.input(t),receipt=await f.projects.archive('owner',f.context,input),saved=await f.engine.native('owner',t.id);
 assert.equal(receipt.replayed,false);assert.equal(saved.state,'archived');assert.equal(saved.requiresTeamWorkspaceVersion,'0.16.0');assert.deepEqual(saved.members,t.members);assert.deepEqual(saved.tasks,t.tasks);assert.deepEqual(saved.finalAcceptance,t.finalAcceptance);assert.deepEqual(saved.memberGoalChanges,t.memberGoalChanges);assert.equal((await f.engine.receipt('owner',t.id)).workflow.actions.length,0);assert.equal(await f.projects.current('owner',f.context),null);
 const data=await f.engine.receipt('owner',t.id),coordination=new TeamCoordination(f.engine.root);assert.equal((await coordination.reserve('owner',data)).firstOffer,false);assert.equal((await coordination.read('owner',data)).enabled,false);await assert.rejects(()=>coordination.enable('owner',data,true),/read-only/);
 const compact=await f.engine.store.document(t.id).read();await assert.rejects(()=>new LegacyArchive(f.engine.store.archive.root).hydrate(compact),/Unsupported archive/);
 await assert.rejects(()=>f.engine.store.update(t.id,'owner',saved.revision,x=>{x.state='active';}),/read-only/);
 await assert.rejects(()=>f.engine.addTasks('owner',t.id,saved.revision,plan().tasks),/Historical|read-only/);
 await assert.rejects(()=>f.engine.start('owner',t.id,saved.revision),/Historical|read-only/);
 const next=await f.projects.plan('owner',f.context,{...f.args,goal:'完全不同的新工作目标'});assert.notEqual(next.team.id,t.id);assert.equal((await f.projects.current('owner',f.context)).id,next.team.id);
 assert.equal((await f.projects.archive('owner',f.context,input)).replayed,true);assert.equal((await f.projects.current('owner',f.context)).id,next.team.id);assert.equal((await f.engine.store.get(t.id,'owner')).revision,saved.revision);
 await assert.rejects(()=>f.projects.archive('owner',f.context,{...input,reason:'不同内容'}),/不一致/);
 const history=await f.engine.store.summaries('owner',f.context.cwd);assert.equal(history.find(x=>x.id===t.id).archivedAt,saved.archival.at);
 const cold=new ProjectTeams(new LeaderEngine({root:f.engine.root,store:new TeamStore(f.engine.store.root),observer:f.observer}));assert.equal((await cold.current('owner',f.context)).id,next.team.id);
});
test('unaccepted, stale, foreign and pending-change requests leave the current team intact',async()=>{
 const f=await fixture();await assert.rejects(()=>f.projects.archive('owner',f.context,f.input(f.team)),/最终验收/);
 let t=await f.finish();await assert.rejects(()=>f.projects.archive('other',f.context,f.input(t)),/not found/);await assert.rejects(()=>f.projects.archive('owner',{cwd:f.root},f.input(t)),/当前项目/);await assert.rejects(()=>f.projects.archive('owner',f.context,{...f.input(t),revision:t.revision-1}),/团队已变化/);await assert.rejects(()=>f.projects.archive('owner',f.context,{...f.input(t),source:'automatic'}),/用户指令/);
 const stage=await f.engine.proposeChange('owner',t.id,t.revision,{members:[],tasks:plan().tasks.map(x=>({...x,id:x.id+'2',reviewOfTaskId:x.reviewOfTaskId?x.reviewOfTaskId+'2':undefined,dependencies:x.dependencies.map(d=>({...d,taskId:d.taskId+'2'}))}))},'后续变更尚未确认');
 await assert.rejects(()=>f.projects.archive('owner',f.context,f.input(stage.team)),/尚未确认/);assert.equal((await f.projects.current('owner',f.context)).id,t.id);assert.equal((await f.engine.native('owner',t.id)).archival,undefined);
});
test('replanning the same brief after archival creates one new team rather than resurrecting the cached plan',async()=>{
 const f=await fixture(),t=await f.finish();await f.projects.archive('owner',f.context,f.input(t));
 const next=await Promise.all([f.projects.plan('owner',f.context,f.args),f.projects.plan('owner',f.context,f.args)]);
 assert.notEqual(next[0].team.id,t.id);assert.equal(next[0].team.id,next[1].team.id);assert.equal(next[0].team.state,'active');assert.equal((await f.engine.native('owner',t.id)).state,'archived');
});
test('archive verifies the latest native turn even when saved tasks and initialization already appear complete',async()=>{
 const f=await fixture();let t=await f.finish();t=(await f.engine.store.update(t.id,'owner',t.revision,x=>{for(const m of x.members){m.agentThreadId=m.id+'-thread';m.rosterVerified=true;m.initializationTurnId='turn-'+m.agentThreadId;m.status='idle';}})).team;
 const inspect=f.observer.inspect;f.observer.inspect=async()=>{throw new Error('Native member is not confirmed idle');};await assert.rejects(()=>f.projects.archive('owner',f.context,f.input(t)),/not confirmed idle/);assert.equal((await f.engine.native('owner',t.id)).state,'delivered');
 f.observer.inspect=async()=>({turnId:'old-turn',status:'completed'});await assert.rejects(()=>f.projects.archive('owner',f.context,f.input(t)),/最新轮次终态/);
 f.observer.inspect=inspect;const result=await f.projects.archive('owner',f.context,f.input(t));assert.equal(f.observer.calls.length,2);assert.ok(f.observer.calls.every(c=>c.options.requireIdle));assert.deepEqual(result.archival.members.map(m=>m.turnId).sort(),['latest-dev-thread','latest-qa-thread']);
 const corrupt=await f.engine.native('owner',t.id);corrupt.archival.members.pop();assert.throws(()=>validateTeam(corrupt),/终态/);
});
test('a concurrent new task during native observation wins the revision check and prevents archival',async()=>{
 const f=await fixture();let t=await f.finish();t=(await f.engine.store.update(t.id,'owner',t.revision,x=>{x.members[0].agentThreadId='dev-thread';x.members[0].rosterVerified=true;})).team;
 const inspect=f.observer.inspect;f.observer.inspect=async function(...args){await f.engine.store.update(t.id,'owner',t.revision,x=>{x.members[0].responsibility='并发修改目标';});return inspect.apply(this,args);};
 await assert.rejects(()=>f.projects.archive('owner',f.context,f.input(t)),/changed in another/);assert.equal((await f.projects.current('owner',f.context)).state,'delivered');
});
test('an uncertain index write is repaired by the same UUID without retiring a newer team or resurrecting legacy history',async()=>{
 const f=await fixture();await f.engine.planOnce('owner',f.context,{...f.args,goal:'历史中的旧候选团队'});const t=await f.finish(),input=f.input(t);
 const normal=f.projects.registry;f.projects.registry=new DurableStore(normal.file,normal.initial,()=>{},{renameFile:async()=>{throw new Error('Controlled index replacement failure');}});
 await assert.rejects(()=>f.projects.archive('owner',f.context,input),/replacement failure/);assert.equal((await f.engine.native('owner',t.id)).state,'archived');assert.equal(await f.projects.current('owner',f.context),null);assert.equal(await f.projects.current('new-owner',f.context),null);
 f.projects.registry=normal;assert.equal((await f.projects.archive('owner',f.context,input)).replayed,true);assert.equal(await f.projects.current('owner',f.context),null);
 const next=await f.projects.plan('new-owner',{...f.context,threadId:'new-leader'},f.args);assert.notEqual(next.team.id,t.id);assert.equal((await f.projects.archive('owner',f.context,input)).replayed,true);assert.equal((await f.projects.current('new-owner',f.context)).id,next.team.id);assert.equal((await f.engine.store.get(t.id,'owner')).revision,t.revision+1);
});
