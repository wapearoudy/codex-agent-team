import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {ProjectTeams} from '../src/project-teams.mjs';
import {validatePlan} from '../src/team.mjs';
const plan=()=>({members:[{id:'dev',role:'Dev',responsibility:'Implement',reason:'Work',writeScopes:[]},{id:'qa',role:'QA',responsibility:'Review',reason:'Independent',writeScopes:[]}],tasks:[{id:'work',memberId:'dev',kind:'work',title:'Work',goal:'Implement',acceptance:'Pass',dependencies:[]},{id:'review',memberId:'qa',kind:'review',reviewOfTaskId:'work',title:'Review',goal:'Review',acceptance:'Pass',dependencies:[{taskId:'work',when:'submitted'}]}]});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'fixed-project-team-')),cwd=join(root,'project');await mkdir(cwd);const engine=new LeaderEngine({root:join(root,'data'),observer:{async close(){}}});return {engine,projects:new ProjectTeams(engine),context:{cwd,threadId:'leader'},args:{goal:'Requested project work',plan:plan(),execute:true}};}
test('different requests and concurrent new work reuse one fixed project team',async()=>{
  const f=await fixture();const results=await Promise.all([f.projects.plan('owner',f.context,f.args),f.projects.plan('owner',f.context,{...f.args,goal:'A completely new task request'})]);assert.equal(results[0].team.id,results[1].team.id);assert.equal((await f.engine.store.list('owner')).length,1);assert.equal(results[1].reused,true);
  assert.deepEqual((await f.projects.current('owner',f.context)).members,results[0].team.members);
  await assert.rejects(()=>f.projects.plan('other-owner',f.context,f.args),/another Leader/);
});
test('existing history selects one fixed roster and read does not create more teams',async()=>{
  const f=await fixture();await f.engine.planOnce('owner',f.context,f.args);const fixed=await f.engine.planOnce('owner',f.context,{...f.args,initializeMembers:true});const before=await f.engine.store.list('owner');
  assert.equal((await f.projects.current('owner',f.context)).id,fixed.id);assert.deepEqual(await f.engine.store.list('owner'),before);assert.equal((await f.projects.plan('owner',f.context,{...f.args,goal:'Next work'})).team.id,fixed.id);
});
test('explicit rebuild changes the team once, preserves old history and refuses active attempts',async()=>{
  const f=await fixture(),original=(await f.projects.plan('owner',f.context,f.args)).team;
  const args={...f.args,requestId:'68c0b62c-6657-489c-89ab-670d67a5e4eb'};
  const rebuilt=await f.projects.rebuild('owner',f.context,args);assert.notEqual(rebuilt.team.id,original.id);assert.equal((await f.projects.current('owner',f.context)).id,rebuilt.team.id);assert.equal((await f.engine.store.get(original.id,'owner')).state,'superseded');
  const historical=await f.engine.store.get(original.id,'owner');await assert.rejects(()=>f.engine.start('owner',original.id,historical.revision),/Historical/);await assert.rejects(()=>f.engine.claim('owner',original.id,historical.revision,'work'),/Historical/);
  assert.equal((await f.projects.rebuild('owner',f.context,args)).team.id,rebuilt.team.id);assert.equal((await f.engine.store.list('owner')).length,2);
  await assert.rejects(()=>f.projects.rebuild('owner',f.context,{...args,goal:'Conflicting request'}),/different contents/);
  await f.engine.store.update(rebuilt.team.id,'owner',rebuilt.team.revision,t=>{t.tasks[0].status='running';});
  await assert.rejects(()=>f.projects.rebuild('owner',f.context,{...args,requestId:'b0c28068-e36e-4a70-8f08-56c6d0a11bcf'}),/Stop and settle/);
});
test('new tasks reopen a delivered team while preserving member identity and prior acceptance',async()=>{
  const f=await fixture(),team=(await f.projects.plan('owner',f.context,f.args)).team;
  const delivered=(await f.engine.store.update(team.id,'owner',team.revision,t=>{t.state='delivered';t.dispatchPaused=true;t.members[0].agentThreadId='fixed-dev';t.members[1].agentThreadId='fixed-qa';t.tasks.forEach(x=>x.status='accepted');t.finalAcceptance={source:'main-conversation-leader',checks:[{status:'PASS',evidence:'previous work'}]};})).team;
  const tasks=plan().tasks.map(t=>({...t,id:t.id+'2',reviewOfTaskId:t.reviewOfTaskId?t.reviewOfTaskId+'2':undefined,dependencies:t.dependencies.map(d=>({...d,taskId:d.taskId+'2'}))}));
  const updated=await f.engine.addTasks('owner',team.id,delivered.revision,tasks);assert.equal(updated.team.id,team.id);assert.equal(updated.team.members[0].agentThreadId,'fixed-dev');assert.equal(updated.team.members[1].agentThreadId,'fixed-qa');assert.equal(updated.team.acceptanceHistory.length,1);assert.equal(updated.team.tasks.length,4);assert.equal(updated.team.dispatchPaused,false);assert.equal((await f.projects.plan('owner',f.context,{...f.args,goal:'Further work'})).team.id,team.id);
});
test('completed history does not consume the forty unfinished task allowance',()=>{
  const p=plan();p.tasks=Array.from({length:80},(_,i)=>({...p.tasks[0],id:'old'+i,status:'accepted'})).concat(p.tasks);assert.doesNotThrow(()=>validatePlan(p));
});

test('explicit rebuild refuses a member whose initialization remains active or unknown',async()=>{
  const f=await fixture(),team=(await f.projects.plan('owner',f.context,f.args)).team;
  await f.engine.store.update(team.id,'owner',team.revision,t=>{t.members[0].agentThreadId='initializing';t.members[0].rosterVerified=false;});
  f.engine.observer.inspect=async()=>({status:'starting',turnId:null});
  await assert.rejects(()=>f.projects.rebuild('owner',f.context,{...f.args,requestId:'f9411ef1-8028-4aa3-a31e-af64e0d9c972'}),/pending member initialization/);
  assert.equal((await f.projects.current('owner',f.context)).id,team.id);
});
