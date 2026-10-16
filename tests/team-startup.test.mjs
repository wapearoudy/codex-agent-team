import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {ProjectTeams} from '../src/project-teams.mjs';
import {assertStartupConfiguration,startupBlockers,startupWaitBlocked} from '../src/team-startup.mjs';
import {coordinationResponse} from '../src/team-coordination-response.mjs';
import {advancementResponse,teamResponse} from '../src/team-responses.mjs';
import {updateDraft,planConfiguration} from '../src/team-plan-review.mjs';
const members=[{id:'dev',role:'Developer',responsibility:'Implement bounded behavior',reason:'Business work',writeScopes:['keys.py']},{id:'qa',role:'Independent reviewer',responsibility:'Review exact candidate',reason:'Independent review',writeScopes:[]}];
const args=(extra={})=>({goal:'Implement and independently review normalization',taskPlanning:'leader',initializeMembers:true,execute:true,approvalMode:'immediate',executionAuthorization:'User explicitly authorized this test',memberStartup:'on-demand',startupProtocol:'task-bound',plan:{members:structuredClone(members),tasks:[]},...extra});
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'team-startup-'));t.after(()=>rm(root,{recursive:true,force:true}));const cwd=join(root,'project');await mkdir(cwd);const engine=new LeaderEngine({root:join(root,'records'),observer:{async inspect(){throw new Error('No native child should be observed in this test');}}});return {root,cwd,engine,context:{cwd,threadId:'leader'}};}
const compilerInput=()=>({reviewerId:'qa',batch:{id:'low',title:'Low goal',goal:'Implement required normalization',qualityMode:'standard'},units:[{id:'normalize',memberId:'dev',title:'Normalize keys',goal:'Implement exact normalization',writePaths:['keys.py'],criteria:[{id:'behavior',description:'Required normalization works'}],verifyCommands:['python3 -m unittest discover -v']}]});
test('both incompatible explicit protocols fail before team and project index creation',async t=>{
 const f=await fixture(t),projects=new ProjectTeams(f.engine);
 for(const input of [args({memberStartup:'eager'}),args({startupProtocol:'roster-bound'})]){
  await assert.rejects(()=>projects.plan('owner',f.context,input),/startup-config-conflict/);
  await assert.rejects(()=>f.engine.planOnce('owner',f.context,input),/startup-config-conflict/);
 }
 assert.deepEqual(await f.engine.store.list('owner'),[]);
 const files=await readdir(join(f.root,'records')).catch(e=>e.code==='ENOENT'?[]:Promise.reject(e));assert.equal(files.includes('project-teams.json'),false);assert.equal(files.includes('leader-plan-requests.json'),false);
});
test('normal task-bound formation dispatches the first business attempt with no ready-only initialization',async t=>{
 const f=await fixture(t),team=await f.engine.planOnce('owner',f.context,args());
 const data=await f.engine.receipt('owner',team.id);assert.deepEqual(data.initializations,[]);assert.equal(data.team.startupProtocol,'task-bound');
 const result=await f.engine.compileTasks('owner',team.id,team.revision,{...compilerInput(),requestId:randomUUID(),commit:true,dispatchReady:true});
 assert.equal(result.dispatches.length,1);assert.equal(result.dispatches[0].taskId,'normalize');assert.equal(result.team.tasks[0].attempts.length,1);assert.equal(result.team.tasks[1].status,'waiting');assert.equal(result.workflow.waitBlocked,undefined);
});
test('legacy eager startup exposes missing bindings and never recommends unchanged waiting or respawning',async t=>{
 const f=await fixture(t),team=await f.engine.planOnce('owner',f.context,args({memberStartup:'eager',startupProtocol:undefined}));
 await f.engine.compileTasks('owner',team.id,team.revision,{...compilerInput(),requestId:randomUUID(),commit:true});
 const data=await f.engine.receipt('owner',team.id),before=JSON.stringify(data.team);
 assert.equal(data.workflow.stage,'startup-blocked');assert.equal(startupWaitBlocked(data.team,data.workflow),true);assert.match(data.workflow.startupBlockers[0].message,/Developer.*Independent reviewer/);
 const response=advancementResponse(data);assert.equal(response.waitBlocked,true);assert.equal(response.nextAction,'resolve-startup');assert.equal(response.nextTool,null);assert.equal(response.continuationArgs,undefined);assert.equal(response.dispatches,undefined);
 const first=coordinationResponse(data),second=coordinationResponse(data,{cursor:first.cursor});assert.equal(second.unchanged,undefined);assert.equal(second.waitBlocked,true);
 assert.equal(teamResponse(data,'state').workflow.startupBlockers[0].code,'member-initialization');assert.equal(JSON.stringify(data.team),before);
 const verified=structuredClone(data.team);verified.members.forEach(m=>{m.rosterVerified=true;m.agentThreadId='child-'+m.id;});assert.deepEqual(startupBlockers(verified),[]);
});
test('compatible roster-bound remains available and pause withholds initialization packets',async t=>{
 const f=await fixture(t),team=await f.engine.planOnce('owner',f.context,args({memberStartup:'eager',startupProtocol:'roster-bound'}));
 const data=await f.engine.receipt('owner',team.id);assert.equal(data.initializations.length,2);
 await f.engine.store.update(team.id,'owner',team.revision,t=>{t.dispatchPaused=true;});assert.deepEqual((await f.engine.receipt('owner',team.id)).initializations,[]);
 const pending=await f.engine.planOnce('owner',{...f.context,cwd:join(f.cwd,'pending')},args({memberStartup:'eager',startupProtocol:'roster-bound',execute:false,requestId:randomUUID()}));assert.deepEqual((await f.engine.receipt('owner',pending.id)).initializations,[]);
});
test('draft conflict is checked before mutation and deliberate paired change is allowed',async t=>{
 const f=await fixture(t),team=await f.engine.planOnce('owner',f.context,args({execute:false})),config=planConfiguration(team),before=structuredClone(team);
 assert.throws(()=>updateDraft(team,{...config,memberStartup:'eager'}),/startup-config-conflict/);assert.deepEqual(team,before);
 updateDraft(team,{...config,memberStartup:'eager',startupProtocol:'roster-bound'});assert.equal(team.startupProtocol,'roster-bound');assert.equal(planConfiguration(team).startupProtocol,'roster-bound');
 assert.throws(()=>assertStartupConfiguration({startupProtocol:'unknown',memberStartup:'eager'}),/startup-config-conflict/);
});
