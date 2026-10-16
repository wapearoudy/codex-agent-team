import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {ProjectTeams} from '../src/project-teams.mjs';
import {startTeamGoal} from '../src/goal-start.mjs';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'goal-start-'));t.after(()=>rm(root,{recursive:true,force:true}));const cwd=join(root,'project');await mkdir(cwd);
 const engine=new LeaderEngine({root:join(root,'records'),observer:{async inspect(){throw Error('No native execution authorized here');}}});t.after(()=>engine.close());
 return {engine,projects:new ProjectTeams(engine),context:{cwd,threadId:'leader'},input:{requestId:randomUUID(),goal:'Implement and review business behavior',approvalMode:'immediate',executionAuthorization:'User authorized this fresh goal',members:[{id:'dev',role:'Developer',responsibility:'Implement behavior',reason:'Business work',writeScopes:['keys.py']},{id:'qa',role:'Reviewer',responsibility:'Independent audit',reason:'Independent review',writeScopes:[]}],reviewerId:'qa',batch:{id:'goal',title:'Business goal',goal:'Implement exact business behavior',qualityMode:'standard',integrationRequired:false},units:[{id:'work',title:'Implementation',goal:'Implement every required behavior',memberId:'dev',criteria:[{id:'AC',description:'Required behavior and invalid inputs correct'}],writePaths:['keys.py'],readPaths:['README.md','keys.py'],verifyCommands:['python3 -m unittest discover -v'],dependencies:[]}]}};
}
test('authorized goal compiles independent review and reserves once; concurrent replay never redispatches',async t=>{
 const f=await fixture(t),results=await Promise.all([startTeamGoal(f.projects,'owner',f.context,f.input),startTeamGoal(f.projects,'owner',f.context,f.input)]);
 assert.equal(results[0].dispatches.length,1);assert.equal(results[1].dispatches.length,0);assert.equal(results[1].compiledPlan.replayed,true);
 const saved=await f.engine.native('owner',results[0].team.id);assert.equal(saved.tasks.length,2);assert.deepEqual(saved.tasks[0].contract.readPaths,['README.md','keys.py']);assert.equal(saved.tasks[1].kind,'review');assert.equal(saved.tasks[0].attempts.length,1);assert.equal(saved.totalDispatches,0,'only native self-binding counts a real launch');
 assert.notEqual(saved.policy?.autoRepair,true,'default formation never silently authorizes repairs');
 await assert.rejects(()=>startTeamGoal(f.projects,'owner',f.context,{...f.input,goal:'Different authorized goal'}),/different contents/);
});
test('explicit bounded repair policy survives fused formation and is part of replay identity',async t=>{
 const f=await fixture(t);f.input.policy={autoRepair:true,maxReviewRounds:3};
 const result=await startTeamGoal(f.projects,'owner',f.context,f.input),saved=await f.engine.native('owner',result.team.id);
 assert.equal(saved.policy.autoRepair,true);assert.equal(saved.policy.maxReviewRounds,3);
 await assert.rejects(()=>startTeamGoal(f.projects,'owner',f.context,{...f.input,policy:{autoRepair:false,maxReviewRounds:3}}),/different contents/);
});
test('missing authorization and all compiler errors reject before formation',async t=>{
 const f=await fixture(t);
 await assert.rejects(()=>startTeamGoal(f.projects,'owner',f.context,{...f.input,approvalMode:'required'}),/authorization/);
 await assert.rejects(()=>startTeamGoal(f.projects,'owner',f.context,{...f.input,executionAuthorization:''}),/authorization/);
 for(const patch of [{verifyCommands:[]},{readPaths:['../secret']},{readPaths:['Explain the implementation',null]}]){
  const r=await startTeamGoal(f.projects,'owner',f.context,{...f.input,units:[{...f.input.units[0],...patch}]});assert.equal(r.valid,false);assert.equal(r.startsModel,false);assert.equal(await f.projects.current('owner',f.context),null);assert.equal((await f.engine.store.list('owner')).length,0);
 }
});
test('conflicting or legacy startup parameters cannot be silently discarded by fused goal formation',async t=>{
 const f=await fixture(t);
 for(const patch of [{startupProtocol:'task-bound',memberStartup:'eager'},{startupProtocol:'roster-bound',memberStartup:'on-demand'},{startupProtocol:'roster-bound',memberStartup:'eager'},{startupProtocol:'unknown'}]){
  await assert.rejects(()=>startTeamGoal(f.projects,'owner',f.context,{...f.input,...patch}),/startup|启动/);assert.equal(await f.projects.current('owner',f.context),null);assert.equal((await f.engine.store.list('owner')).length,0);
 }
});
test('existing team cannot be replaced; lost goal-start index recovers same saved formation identity',async t=>{
 const f=await fixture(t),started=await startTeamGoal(f.projects,'owner',f.context,f.input),before=await f.engine.native('owner',started.team.id);
 const blocked=await startTeamGoal(f.projects,'owner',f.context,{...f.input,requestId:randomUUID()});assert.equal(blocked.code,'existing-project-team');assert.deepEqual(await f.engine.native('owner',started.team.id),before);
 await rm(join(f.engine.root,'goal-starts.json'));const replay=await startTeamGoal(f.projects,'owner',f.context,f.input);assert.equal(replay.dispatches.length,0);assert.equal(replay.compiledPlan.replayed,true);assert.equal((await f.engine.store.list('owner')).length,1);
});
test('failure after formation resumes the exact same team without another formation or native attempt',async t=>{
 const f=await fixture(t),compile=f.engine.compileTasks.bind(f.engine);let once=true;
 f.engine.compileTasks=async(...args)=>{if(once){once=false;throw Error('Simulated response interruption');}return compile(...args);};
 await assert.rejects(()=>startTeamGoal(f.projects,'owner',f.context,f.input),/interruption/);
 const current=await f.projects.current('owner',f.context);assert.equal(current.tasks.length,0);
 const result=await startTeamGoal(f.projects,'owner',f.context,f.input);assert.equal(result.team.id,current.id);assert.equal(result.dispatches.length,1);assert.equal((await f.engine.store.list('owner')).length,1);
});
