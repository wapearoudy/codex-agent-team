import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {compileTeamTasks} from '../src/team-plan-compiler.mjs';
import {preflightDelivery,resolveDeliveryReceipt,deliveryHash} from '../src/delivery-preflight.mjs';
import {economyForecast,teamEconomy,phaseEconomy,historicalCostProfile,historicalCostReference} from '../src/team-economy.mjs';
import {nativeIdentityCandidates} from '../src/native-identity-index.mjs';
import {memberTaskPrompt} from '../src/member-prompt.mjs';
import {evidencePage} from '../src/team-evidence.mjs';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {workflowActions} from '../src/team-workflow.mjs';
import {coordinationResponse,COORDINATION_MAX_BYTES} from '../src/team-coordination-response.mjs';
import {advancementResponse} from '../src/team-responses.mjs';
const members=[{id:'dev',role:'Developer',responsibility:'Implement',reason:'Business work',writeScopes:['src']},{id:'qa',role:'Reviewer',responsibility:'Independent review',reason:'Verify',writeScopes:[]}];
const unit=(id='code')=>({id,title:'Implement source',goal:'Complete required business behavior',memberId:'dev',criteria:[{id:'behavior',description:'Required business behavior works'}],writePaths:['src'],verifyCommands:['node --test test.mjs']});
const input=(units=[unit()])=>({units,reviewerId:'qa',batch:{id:'batch',title:'Business goal',goal:'Complete the confirmed business goal',qualityMode:'standard'}});
const base=()=>({id:randomUUID(),members:structuredClone(members),tasks:[],batches:[],projectPath:'/tmp/compiler-project'});
test('grouping malformed new units cannot throw before aggregated criterion validation',()=>{
 const malformed={...unit('a')};delete malformed.criteria;
 const p=compileTeamTasks(base(),{...input([malformed,unit('b')]),combineGroups:[{id:'joined',unitIds:['a','b']}]});
 assert.equal(p.valid,false);assert.ok(p.errors.some(e=>e.path==='units[0].criteria'));assert.equal(p.startsModel,false);
});
test('single-target repair reports the exact missing reason without suggesting another envelope',()=>{
 const team=base();team.tasks=compileTeamTasks(team,input()).tasks;for(const t of team.tasks)t.attempts=[{id:randomUUID(),marker:'TEAM_WORKSPACE_ATTEMPT:'+randomUUID()}];
 const target=team.tasks[0];Object.assign(target.attempts[0],{contractRevision:target.contractRevision??1,delivery:{acceptanceResults:target.acceptanceCriteria.map(c=>({criterionId:c.id,status:'PASS',evidence:'Saved exact candidate evidence'}))},observation:{commands:[{command:'node --test test.mjs',cwd:team.projectPath,status:'completed',exitCode:0}]},evidenceSnapshot:{workspace:team.projectPath}});
 const task=team.tasks[1],report={attemptMarker:task.attempts[0].marker,summary:'Verified behavior',decision:'accept',reason:'',checks:team.tasks[0].acceptanceCriteria.map(c=>({name:c.description,criterionId:c.id,status:'PASS',evidence:'Exact candidate source and host command verified'})),findings:[]};
 const rejected=preflightDelivery(team,task,members[1],JSON.stringify(report));assert.deepEqual(rejected.errors.map(e=>e.path),['$.reason']);
 report.reason='All required conditions have independent evidence';assert.equal(preflightDelivery(team,task,members[1],JSON.stringify(report)).valid,true);
});
test('final action supplies one closure call but grants no acceptance or additional review authority',()=>{
 const team=base();team.tasks=compileTeamTasks(team,input()).tasks.map(t=>({...t,status:'accepted',attempts:[]}));team.state='active';team.revision=4;
 const action=workflowActions(team).actions.find(a=>a.type==='final-validation');assert.equal(action.tool,'finish_team');assert.equal(action.finalizationArguments.reuseEvidence,true);assert.equal(action.finalizationArguments.revision,4);assert.match(action.instruction,/not acceptance/);assert.deepEqual(action.reusableEvidence,[]);
});
test('model projection retains executable final closure and its no-repeat instruction under bounded output',()=>{
 const team=base();team.tasks=compileTeamTasks(team,input()).tasks.map(t=>({...t,status:'accepted',attempts:[]}));team.state='active';team.revision=4;
 const workflow=workflowActions(team),expected=workflow.actions.find(a=>a.type==='final-validation');
 const result=coordinationResponse({team,workflow,runs:[]}),actual=result.actions.find(a=>a.type==='final-validation');
 assert.deepEqual(actual.finalizationArguments,expected.finalizationArguments);assert.match(actual.instruction,/Read only the specific exception/);assert.ok(Buffer.byteLength(JSON.stringify(result))<=COORDINATION_MAX_BYTES);assert.equal(team.finalAcceptance,undefined);
 workflow.actions=Array.from({length:8},()=>({...expected,reason:'x'.repeat(1000),reusableEvidence:Array.from({length:8},()=>({proof:'x'.repeat(600)}))}));
 const bounded=coordinationResponse({team,workflow,runs:[]});assert.equal(bounded.truncated,true);assert.deepEqual(bounded.actions[0].finalizationArguments,expected.finalizationArguments);assert.ok(Buffer.byteLength(JSON.stringify(bounded))<=COORDINATION_MAX_BYTES);
});
test('advancement transports exact dispatch before waiting and retains reusable wait arguments after native launch',()=>{
 const team=base();team.revision=4;const prompt='Complete exact prompt',packet={teamId:team.id,taskId:'code',attemptId:randomUUID(),prompt,spawnOptions:{model:'gpt-6-luna'},taskName:'exact_name',workspace:{path:team.projectPath},dispatchReference:{path:'/tmp/immutable.json',sha256:'a'.repeat(64),complete:true,immutable:true},nativeAction:{tool:'spawn_agent',arguments:{task_name:'exact_name',message:prompt,fork_turns:'none',model:'gpt-6-luna'}}};
 const result=advancementResponse({team,runs:[],workflow:{actions:[]},dispatches:[packet]},'coordination',{dispatchReady:false,dispatchView:'reference'});
 assert.equal(result.dispatches[0].prompt,undefined);assert.deepEqual(result.dispatches[0].nativeAction,packet.nativeAction);assert.deepEqual(result.dispatches[0].dispatchReference,packet.dispatchReference);assert.equal(packet.prompt,prompt);
 assert.equal(result.continuationArgs,undefined);assert.equal(result.nextAction,'dispatch-native');
 const active=advancementResponse({team,runs:[],workflow:{actions:[]}},'coordination',{dispatchReady:false,dispatchView:'reference'});
 assert.deepEqual(active.continuationArgs,{teamId:team.id,revision:4,wait:true,waitCursor:active.waitCursor,timeoutMs:55000,dispatchReady:false,dispatchView:'reference'});
 const legacy={...packet};delete legacy.nativeAction;assert.equal(advancementResponse({team,runs:[],workflow:{actions:[]},dispatches:[legacy]}).dispatches[0].prompt,prompt);
 const full={...packet};delete full.dispatchReference;assert.equal(advancementResponse({team,runs:[],workflow:{actions:[]},dispatches:[full]}).dispatches[0].prompt,prompt);
});
test('completed or historical teams never recommend another model wait; pending final closure remains explicit',()=>{
 const team=base();team.revision=4;
 for(const state of ['delivered','archived','superseded']){
  team.state=state;const result=advancementResponse({team,runs:[],workflow:{actions:[],stage:'completed'}});
  assert.equal(result.terminal,true);assert.equal(result.nextTool,null);assert.equal(result.nextAction,'return-result');assert.equal(result.continuationArgs,undefined);
 }
 team.state='awaiting-leader-acceptance';const pending=advancementResponse({team,runs:[],workflow:{actions:[{type:'final-validation',tool:'finish_team'}],stage:'integrate'}});
 assert.equal(pending.terminal,undefined);assert.equal(pending.actions[0].tool,'finish_team');assert.ok(pending.continuationArgs);assert.equal(team.finalAcceptance,undefined);
 team.state='active';const blocked=advancementResponse({team,runs:[],workflow:{actions:[],stage:'observe'}});assert.equal(blocked.terminal,undefined);
});
test('compiler catches missing final goal coverage before reserving work',()=>{
 const plan=input();plan.batch.goalCriteria=[{id:'business',description:'All business behavior'},{id:'validation',description:'Reviewed current candidate'}];
 const rejected=compileTeamTasks(base(),plan);assert.equal(rejected.valid,false);assert.equal(rejected.errors.filter(e=>e.code==='missing-coverage').length,2);
 plan.units[0].coverageOf=['business','validation'];assert.equal(compileTeamTasks(base(),plan).valid,true);
});
test('historical cost reference excludes incomplete, overlapping or different-contract/model samples',()=>{
 const team=base();team.tasks=compileTeamTasks(team,input()).tasks;
 const usage={accountingComplete:true,totalTokens:120,leaderTokens:40,unregisteredNativeTokens:10,tasks:team.tasks.map((t,i)=>({taskId:t.id,totalTokens:i?30:40,unknownAttempts:0}))};
 const profile=historicalCostProfile(team,usage);assert.equal(profile.complete,true);assert.equal(profile.components.startupTokens,null);
 team.efficiencyHistory=[{historicalProfile:profile},{historicalProfile:{...profile,complete:false,totalTokens:1}}];
 const reference=historicalCostReference(team);assert.equal(reference.sampleCount,1);assert.equal(reference.totalTokens.median,120);assert.equal(reference.components.independentReviewIncludingStartupTokens.median,30);
 assert.equal(historicalCostProfile(team,usage,[team.tasks[0]]).complete,false);
 assert.equal(historicalCostReference({...team,members:team.members.map(m=>({...m,route:{model:'different'}}))}).sampleCount,0);
 assert.equal(historicalCostReference({...team,tasks:team.tasks.map(t=>({...t,goal:t.goal+' changed'}))}).sampleCount,0);
 assert.equal(economyForecast(team).confidence,'unknown');assert.equal(economyForecast(team).historicalReference.executionAuthority,false);
});
test('compiler creates one independent batch review and precise dependency contracts without mutation',()=>{
 const team=base(),before=structuredClone(team),p=compileTeamTasks(team,input([unit('a'),{...unit('b'),dependencies:['a']} ]));
 assert.equal(p.valid,true,JSON.stringify(p.errors));assert.deepEqual(team,before);assert.deepEqual(p.summary,{workUnits:2,independentReviews:1,executionMembers:1});
 assert.deepEqual(p.tasks[1].dependencies,[{taskId:'a',when:'delivered'}]);assert.deepEqual(p.tasks[2].dependencies,[{taskId:'a',when:'submitted'},{taskId:'b',when:'submitted'}]);assert.deepEqual(p.tasks[2].contract.inScope,[]);assert.equal(p.startsModel,false);
});
test('compiler reports contract errors together and handles malformed values without throwing',()=>{
 const team=base(),bad={...unit(),criteria:[null],riskFlags:42,dependencies:'bad',verifyCommands:{},writePaths:null};
 const malformed=compileTeamTasks(team,input([bad,null]));assert.equal(malformed.valid,false);assert.ok(malformed.errors.length>=6);assert.equal(team.tasks.length,0);
 const p=compileTeamTasks(team,input([{...unit(),verifyCommands:['Run all tests and report success'],writePaths:['foreign'],reviewerId:'dev'}]));assert.equal(p.valid,false);assert.ok(p.errors.some(e=>e.code==='independence'));assert.ok(p.errors.some(e=>e.code==='command-not-instruction'));assert.ok(p.errors.some(e=>e.code==='scope'));
 for(const value of [null,{}, {units:'bad'},input([{...unit(),criteria:[{}]}])])assert.equal(compileTeamTasks(team,value).valid,false);
});
test('strict risk retains individual review and integration requirement; cycles are rejected',()=>{
 const team=base(),p=compileTeamTasks(team,{...input(),batch:{...input().batch,qualityMode:'strict'}});assert.equal(p.valid,false);assert.ok(p.errors.some(e=>e.code==='integration'));
 const plan=input([unit('a'),{...unit('integration'),stage:'integration',dependencies:['a']}]);plan.batch.qualityMode='strict';const valid=compileTeamTasks(team,plan);assert.equal(valid.valid,true,JSON.stringify(valid.errors));assert.equal(valid.summary.independentReviews,2);
 const cycle=compileTeamTasks(team,input([{...unit('a'),dependencies:['b']},{...unit('b'),dependencies:['a']} ]));assert.equal(cycle.valid,false);
});
test('economy distinguishes unknown cost from zero and never removes quality or claims incomplete savings',()=>{
 const t=base();assert.equal(economyForecast(t).confidence,'unknown');assert.equal(teamEconomy(t,{complete:false,totalTokens:1},{soloTokens:10}).actual.totalTokens,null);
 const estimate={soloTokens:100,businessTokens:80,avoidedInputTokens:20,startupTokensPerContext:10,coordinationTokens:5,reviewTokens:10,integrationTokens:5,recoveryTokens:0,executionContexts:2};
 const p=economyForecast(t,estimate);assert.equal(p.estimatedTeamTokens,100);assert.equal(p.recommendedExecution,'combine-coupled-work-with-independent-review');assert.equal(p.changesQuality,false);
 assert.equal(teamEconomy(t,{complete:true,totalTokens:90},estimate).actual.savingsClaimAllowed,false);t.finalAcceptance={note:'Complete'};assert.equal(teamEconomy(t,{complete:true,totalTokens:90},estimate).actual.savingsClaimAllowed,true);
 assert.equal(phaseEconomy({currentInputTokens:60000}).rotate,false);assert.equal(phaseEconomy({currentInputTokens:60000,remainingRequests:1,cleanInputTokens:30000,handoffTokens:5000}).rotate,false);assert.equal(phaseEconomy({currentInputTokens:60000,remainingRequests:3,cleanInputTokens:30000,handoffTokens:5000}).rotate,true);
});
test('receipt requires the exact authenticated draft, native turn, marker and unchanged contract',()=>{
 const raw='{"summary":"Retained original evidence"}',a={marker:'marker',memberSubmission:{text:raw,source:'authenticated-member',turnId:'turn',contractRevision:1,deliveryHash:deliveryHash(raw)}},task={attempts:[a]};const r=JSON.stringify({kind:'team-delivery-receipt',attemptMarker:'marker',deliveryHash:deliveryHash(raw)});
 assert.equal(resolveDeliveryReceipt(task,{turnId:'turn'},r),raw);assert.equal(resolveDeliveryReceipt(task,{turnId:'turn'},raw),raw);
 assert.throws(()=>resolveDeliveryReceipt(task,{turnId:'wrong'},r),/exact native turn/);task.contractRevision=2;assert.throws(()=>resolveDeliveryReceipt(task,{turnId:'turn'},r));task.contractRevision=1;a.memberSubmission.text+='changed';assert.throws(()=>resolveDeliveryReceipt(task,{turnId:'turn'},r));
});
test('review preflight catches stale attempts and missing or duplicate required checks without accepting',()=>{
 const work={id:'work',attempts:[{id:'current'}],acceptanceCriteria:[{id:'AC',description:'Behavior'}]},review={kind:'review',reviewOfTaskId:'work',attempts:[{marker:'marker'}]},team={tasks:[work,review]};
 const report={attemptMarker:'marker',summary:'Checked source',taskId:'work',attemptId:'current',decision:'accept',reason:'All checked',checks:[{name:'Behavior',criterionId:'AC',status:'PASS',evidence:'src/a.mjs'}],findings:[]};
 assert.equal(preflightDelivery(team,review,members[1],JSON.stringify(report)).valid,true);report.attemptId='old';assert.equal(preflightDelivery(team,review,members[1],JSON.stringify(report)).valid,false);report.attemptId='current';report.checks.push(report.checks[0]);assert.equal(preflightDelivery(team,review,members[1],JSON.stringify(report)).valid,false);
});
test('compiler commit is idempotent across revision transport changes and rejected plans preserve history',async t=>{
 const root=await mkdtemp(join(tmpdir(),'compiled-plan-'));t.after(()=>rm(root,{recursive:true,force:true}));const cwd=join(root,'project');await mkdir(join(cwd,'src'),{recursive:true});await writeFile(join(cwd,'src/a.mjs'),'original');
 const engine=new LeaderEngine({root:join(root,'records'),observer:{async inspect(){throw Error('must not launch or observe');}}});t.after(()=>engine.close());
 const team=await engine.planOnce('owner',{cwd,threadId:'leader'},{goal:'Confirmed business goal',execute:true,taskPlanning:'leader',approvalMode:'immediate',executionAuthorization:'User explicitly approved controlled experiment',plan:{members,tasks:[]}});
 const args={...input(),requestId:randomUUID(),commit:true,teamId:team.id,revision:team.revision};const bad={...args,units:[{...unit(),verifyCommands:['Run tests']} ]};assert.equal((await engine.compileTasks('owner',team.id,team.revision,bad)).valid,false);assert.deepEqual(await engine.native('owner',team.id),team);
 const committed=await engine.compileTasks('owner',team.id,team.revision,args);assert.equal(committed.compiledPlan.replayed,false);const saved=await engine.native('owner',team.id);assert.equal(saved.tasks.length,2);assert.equal(saved.compiledPlans.length,1);
 const replay=await engine.compileTasks('owner',team.id,saved.revision,{...args,revision:saved.revision});assert.equal(replay.compiledPlan.replayed,true);assert.deepEqual(await engine.native('owner',team.id),saved);await assert.rejects(()=>engine.compileTasks('owner',team.id,saved.revision,{...args,units:[{...unit(),goal:'Different goal'}]}),/different contents/);
});
test('compilation can reserve the first batch once; preflight, replay and concurrent pause never redispatch',async t=>{
 const root=await mkdtemp(join(tmpdir(),'compile-dispatch-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const paused of [false,true])await t.test(String(paused),async t=>{
  const cwd=join(root,paused?'paused':'normal');await mkdir(join(cwd,'src'),{recursive:true});await writeFile(join(cwd,'src/a.mjs'),'original');
  const engine=new LeaderEngine({root:join(cwd,'records'),observer:{async inspect(){throw Error('No model may start');}}});t.after(()=>engine.close());
  const team=await engine.planOnce('owner',{cwd,threadId:'leader'},{goal:'Confirmed business goal',execute:true,taskPlanning:'leader',approvalMode:'immediate',executionAuthorization:'User authorized this work',plan:{members,tasks:[]}});
  const args={...input(),requestId:randomUUID(),commit:true,dispatchReady:true};
  await assert.rejects(()=>engine.compileTasks('owner',team.id,team.revision,{...args,commit:false}),/preflight never reserves/);assert.deepEqual(await engine.native('owner',team.id),team);
  if(paused){const add=engine.addTasks.bind(engine);engine.addTasks=async(...a)=>{const saved=await add(...a);await engine.pause('owner',team.id,saved.team.revision);return saved;};}
  const result=await engine.compileTasks('owner',team.id,team.revision,args),saved=await engine.native('owner',team.id);
  assert.equal(saved.compiledPlans.length,1);assert.equal(saved.tasks.length,2);assert.equal(result.compiledPlan.replayed,false);
  assert.equal(result.dispatches?.length??0,paused?0:1);assert.equal(saved.tasks[0].attempts.length,paused?0:1);assert.equal(saved.tasks[1].attempts.length,0);
  if(paused)assert.equal(result.advancement.errors[0].operation,'dispatch');
  else {assert.equal(result.dispatches[0].taskId,'code');assert.equal(result.dispatches[0].spawnOptions.fork_turns,'none');assert.ok(result.dispatches[0].memberBootstrap);}
  const replay=await engine.compileTasks('owner',team.id,1,{...args,dispatchView:'full'});assert.equal(replay.compiledPlan.replayed,true);assert.deepEqual(replay.dispatches,[]);assert.equal(replay.dispatchReplay.requiresReconciliation,true);assert.deepEqual(await engine.native('owner',team.id),saved);
  await assert.rejects(()=>engine.compileTasks('owner',team.id,saved.revision,{...args,units:[{...unit(),goal:'A different goal'}]}),/different contents/);
 });
});
test('read-only identity hint scopes metadata to exact parent, project and canonical path',async t=>{
 const {DatabaseSync}=await import('node:sqlite');const root=await mkdtemp(join(tmpdir(),'native-identity-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'state.sqlite'),db=new DatabaseSync(path);db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, source TEXT)');const insert=db.prepare('INSERT INTO threads VALUES (?, ?, ?)');
 for(const [id,cwd,parent,agent] of [['own','project','leader','/root/dev'],['foreign','project','other','/root/dev'],['other-project','elsewhere','leader','/root/dev'],['review','project','leader','/root/qa']])insert.run(id,cwd,JSON.stringify({subagent:{thread_spawn:{parent_thread_id:parent,agent_path:agent}}}));db.close();
 const found=await nativeIdentityCandidates({leaderThreadId:'leader',cwd:'project',agentPath:'/root/dev',databasePath:path});assert.deepEqual(found.ids,['own']);assert.equal(found.complete,true);assert.equal((await nativeIdentityCandidates({leaderThreadId:'leader',cwd:'project',databasePath:join(root,'missing')})).complete,false);
});

test('explicit grouping preserves all business criteria and rewires downstream references without merging strict review',()=>{
 const team=base(),args=input([unit('a'),{...unit('b'),dependencies:['a']},{...unit('c'),dependencies:['b']}]);args.combineGroups=[{id:'ab',unitIds:['a','b']}];const p=compileTeamTasks(team,args);assert.equal(p.valid,true,JSON.stringify(p.errors));assert.equal(p.grouping.executionUnits,2);assert.deepEqual(p.tasks.find(t=>t.id==='ab').acceptanceCriteria.map(c=>c.id),['a_behavior','b_behavior']);assert.deepEqual(p.tasks.find(t=>t.id==='c').dependencies,[{taskId:'ab',when:'delivered'}]);assert.equal(p.summary.independentReviews,1);args.batch.qualityMode='strict';assert.equal(compileTeamTasks(team,args).valid,false);assert.equal(team.tasks.length,0);
});
test('same-turn draft repair keeps rejected report and original host evidence; final receipt settles without rerunning commands',async t=>{
 const root=await mkdtemp(join(tmpdir(),'draft-preflight-'));t.after(()=>rm(root,{recursive:true,force:true}));const cwd=join(root,'project');await mkdir(join(cwd,'src'),{recursive:true});await writeFile(join(cwd,'src/a.mjs'),'original');let run;
 const engine=new LeaderEngine({root:join(root,'records'),observer:{async inspect(){return structuredClone(run);}}});t.after(()=>engine.close());
 const work={id:'work',title:'Source analysis',goal:'Analyze required source behavior',acceptance:'Evidence for behavior',acceptanceCriteria:[{id:'AC',description:'Required behavior'}],memberId:'dev',kind:'work',validationMode:'source-only',dependencies:[],contract:{stage:'requirements',inScope:[],outOfScope:[],verify:[],coverageOf:[]}},review={id:'review',title:'Review',goal:'Check source',acceptance:'Independent evidence',memberId:'qa',kind:'review',reviewOfTaskId:'work',dependencies:[{taskId:'work',when:'submitted'}]};
 const team=await engine.planOnce('owner',{cwd,threadId:'leader'},{goal:'Source analysis goal',execute:true,plan:{members,tasks:[work,review]}}),claimed=await engine.claim('owner',team.id,team.revision,'work'),d=claimed.dispatch;
 run={threadId:'child',turnId:d.attemptId,status:'inProgress',outputs:[{text:d.marker}],commands:[],source:'native-thread-persisted-snapshot'};
 const bound=await engine.bind('owner',team.id,claimed.team.revision,'work',d.attemptId,'child'),args={taskId:'work',attemptId:d.attemptId,summary:'Analysis evidence',requestId:randomUUID(),delivery:JSON.stringify({attemptMarker:d.marker,summary:'Old missing criteria'})},context={threadId:'child',parentThreadId:'leader',cwd};
 const rejected=await engine.memberReport('owner',team.id,bound.team.revision,context,args);assert.equal(rejected.deliveryPreflight.valid,false);assert.equal(rejected.runsCommands,false);
 const original=JSON.stringify({attemptMarker:d.marker,summary:'Source checked',changedPaths:[],verificationInputs:['src'],acceptanceResults:[{criterionId:'AC',status:'PASS',evidence:'Inspected src/a.mjs, source-only no execution claimed'}],commandsRun:[]});
 const fixed=await engine.memberReport('owner',team.id,rejected.revision,context,{...args,requestId:randomUUID(),delivery:original});assert.equal(fixed.deliveryPreflight.valid,true);const saved=await engine.native('owner',team.id);assert.equal(saved.tasks[0].attempts[0].submissionDrafts.length,2);assert.equal(saved.tasks[0].status,'running');
 run={...run,status:'completed',outputs:[{text:JSON.stringify(fixed.finalReceipt)}]};const done=await engine.settle('owner',team.id,saved.revision,'work',d.attemptId);assert.equal(done.team.tasks[0].status,'submitted');assert.equal(done.team.tasks[0].evidence.at(-1).summary,original);assert.deepEqual(done.team.tasks[0].attempts[0].observation.commands,[]);assert.equal(done.team.tasks[0].attempts[0].submissionDrafts[0].text,args.delivery);
 const page=evidencePage(done.team,{taskId:'work',section:'delivery'});assert.equal(page.text,original);assert.equal(page.deliverySource,'authenticated-saved-draft');assert.equal(done.team.tasks[0].attempts[0].observation.outputs[0].text,JSON.stringify(fixed.finalReceipt));
 const cold=await engine.native('owner',team.id);assert.equal(evidencePage(cold,{taskId:'work',attemptId:d.attemptId}).text,original);
 const historical=structuredClone(cold);historical.tasks[0].contractRevision=2;historical.tasks[0].attempts.push({id:'later',turnId:'later',observation:{outputs:[{text:'different report'}]}});assert.equal(evidencePage(historical,{taskId:'work',attemptId:d.attemptId}).text,original);
 cold.tasks[0].attempts[0].memberSubmission.text+='tampered';assert.throws(()=>evidencePage(cold,{taskId:'work'}),/authenticated draft/);
});

test('malformed review arrays yield repairable field diagnostics instead of an exception',()=>{
 const work={id:'work',attempts:[{id:'current'}],acceptanceCriteria:[{id:'AC',description:'Behavior'}]},review={kind:'review',reviewOfTaskId:'work',attempts:[{marker:'marker'}]},team={tasks:[work,review]};for(const checks of [null,{},'bad',[]])assert.equal(preflightDelivery(team,review,members[1],JSON.stringify({summary:'Observed source',checks,findings:[]})).valid,false);
});
import {dispatchReference} from '../src/dispatch-reference.mjs';
test('reference dispatch retains the complete immutable original contract and cannot rewrite a cached file',async t=>{
 const root=await mkdtemp(join(tmpdir(),'dispatch-reference-'));t.after(()=>rm(root,{recursive:true,force:true}));const p={teamId:randomUUID(),attemptId:randomUUID(),revision:1,memberId:'dev',taskId:'work',marker:'TEAM_WORKSPACE_ATTEMPT:'+randomUUID(),prompt:'Full original criteria and evidence rules',deliveryTemplate:{summary:'',acceptanceResults:[]},spawnOptions:{model:'gpt-6-luna',reasoning_effort:'medium',fork_turns:'none'},workspace:{path:root},action:'spawn-native-member'};
 const ref=await dispatchReference(root,p),again=await dispatchReference(root,{...p,revision:2});assert.equal(ref.dispatchReference.path,again.dispatchReference.path);const {readFile}=await import('node:fs/promises');const saved=JSON.parse(await readFile(ref.dispatchReference.path,'utf8'));assert.equal(saved.prompt,p.prompt);assert.deepEqual(saved.deliveryTemplate,p.deliveryTemplate);assert.match(ref.prompt,/EXACT standalone/);assert.ok(ref.prompt.includes(p.marker));assert.equal(ref.spawnOptions.model,'gpt-6-luna');assert.equal(ref.prompt.includes(p.prompt),false);assert.equal(await readFile(ref.dispatchReference.promptPath,'utf8'),p.prompt);assert.equal(ref.dispatchReference.promptSha256,deliveryHash(p.prompt));assert.ok(ref.prompt.includes(ref.dispatchReference.promptPath));
 const changed=await dispatchReference(root,{...p,prompt:'Changed criterion'});assert.notEqual(changed.dispatchReference.path,ref.dispatchReference.path);assert.equal(JSON.parse(await readFile(ref.dispatchReference.path,'utf8')).prompt,p.prompt);await writeFile(ref.dispatchReference.promptPath,'corruption');await assert.rejects(()=>dispatchReference(root,p),/Immutable dispatch prompt/);await writeFile(ref.dispatchReference.promptPath,p.prompt);await writeFile(ref.dispatchReference.path,'corruption');await assert.rejects(()=>dispatchReference(root,p),/Immutable dispatch/);
});
test('pending binding distinguishes linked identity from work readiness and confirms the same child without a second dispatch',async t=>{
 const root=await mkdtemp(join(tmpdir(),'pending-binding-'));t.after(()=>rm(root,{recursive:true,force:true}));const cwd=join(root,'project');await mkdir(cwd);let run={threadId:'child',turnId:null,status:'starting',outputs:[],commands:[],source:'native-child-metadata'};
 const engine=new LeaderEngine({root:join(root,'records'),observer:{async inspect(){return structuredClone(run);}}});t.after(()=>engine.close());const work={id:'work',title:'Source task',goal:'Required source work',acceptance:'Independent proof',memberId:'dev',kind:'work',dependencies:[]},review={id:'review',title:'Review',goal:'Check source',acceptance:'Independent proof',memberId:'qa',kind:'review',reviewOfTaskId:'work',dependencies:[{taskId:'work',when:'submitted'}]};
 const team=await engine.planOnce('owner',{cwd,threadId:'leader'},{goal:'Required business task',execute:true,plan:{members,tasks:[work,review]}}),c=await engine.claim('owner',team.id,team.revision,'work');const first=await engine.bindMany('owner',team.id,c.team.revision,[{taskId:'work',attemptId:c.dispatch.attemptId,threadId:'child'}]);assert.equal(first.bindings[0].readyForWork,false);assert.equal(first.bindings[0].requiredPublicMarker,c.dispatch.marker);assert.match(first.bindings[0].instruction,/Do NOT send BIND_READY/);assert.equal(first.team.tasks[0].attempts[0].state,'linking');
 run={...run,turnId:'turn',status:'inProgress',outputs:[{text:c.dispatch.marker}],source:'native-thread-persisted-snapshot'};const ready=await engine.bindMany('owner',team.id,first.team.revision,[{taskId:'work',attemptId:c.dispatch.attemptId,threadId:'child'}]);assert.equal(ready.bindings[0].readyForWork,true);assert.equal(ready.team.totalDispatches,1);assert.equal(ready.team.tasks[0].attempts.length,1);
});
test('finding format failures name each exact field to repair in the same turn',()=>{
 const work={id:'work',attempts:[{id:'current'}],acceptanceCriteria:[{id:'AC',description:'Behavior'}]},review={kind:'review',reviewOfTaskId:'work',attempts:[{marker:'marker'}]},team={tasks:[work,review]},report={attemptMarker:'marker',summary:'Independent report',decision:'rework',reason:'Business issue found',checks:[{name:'Behavior',criterionId:'AC',status:'FAIL',evidence:'Exact reproducer'}],findings:[{id:'issue',severity:'major',summary:'Specific bug'}]};const p=preflightDelivery(team,review,members[1],JSON.stringify(report));assert.equal(p.valid,false);assert.deepEqual(p.errors.map(e=>e.path),['findings.work[0].severity','findings.work[0].status','findings.work[0].description']);report.findings[0]={id:'issue',severity:'medium',status:'open',description:'Specific bug'};assert.equal(preflightDelivery(team,review,members[1],JSON.stringify(report)).valid,true);
});

test('ordinary repair progress is not queried as a phase handoff checkpoint',()=>{
 const team={id:randomUUID(),projectPath:'/tmp/project',leaderThreadId:'leader'},task={id:'work',title:'Repair',goal:'Fix defect',acceptance:'Check',kind:'work',contract:{stage:'repair'},acceptanceCriteria:[],attempts:[{id:randomUUID(),marker:'marker'}]},member={id:'dev',role:'Developer',responsibility:'Fix',writeScopes:['src']};const handoff={teamGoal:'Business',dependencies:[],checkpoint:{attemptId:'historical',summary:'Original evidence'}};const prompt=memberTaskPrompt(team,task,member,task.attempts[0],handoff);assert.match(prompt,/Historical progress checkpoint/);assert.doesNotMatch(prompt,/Read the complete phase checkpoint/);assert.match(prompt,/view=full/);
});

test('literal saved-delivery reference resolves only format-validated authenticated exact-turn drafts',()=>{
 const raw='{"summary":"Original independent verdict"}',saved={text:raw,source:'authenticated-member',turnId:'turn',contractRevision:1,deliveryHash:deliveryHash(raw),preflightVersion:1},task={attempts:[{marker:'marker',memberSubmission:saved}]},r='{"kind":"team-saved-delivery"}';
 assert.equal(resolveDeliveryReceipt(task,{turnId:'turn'},r),raw);
 for(const change of [s=>s.source='leader',s=>s.turnId='old',s=>s.contractRevision=2,s=>delete s.preflightVersion,s=>s.text+='tamper',s=>s.deliveryHash='wrong']){const copy=structuredClone(task);change(copy.attempts[0].memberSubmission);assert.throws(()=>resolveDeliveryReceipt(copy,{turnId:'turn'},r),/authenticated draft/);}
 for(const extra of [{decision:'accept'},{deliveryHash:saved.deliveryHash},{attemptMarker:'marker'}])assert.throws(()=>resolveDeliveryReceipt(task,{turnId:'turn'},JSON.stringify({kind:'team-saved-delivery',...extra})),/authenticated draft/);
 assert.throws(()=>resolveDeliveryReceipt({attempts:[{}]},{turnId:'turn'},r),/authenticated draft/);
 // Legacy corrupt receipts remain rejected; a reference never repairs them.
 assert.throws(()=>resolveDeliveryReceipt(task,{turnId:'turn'},JSON.stringify({kind:'team-delivery-receipt',attemptMarker:'marker',deliveryHash:'copied-wrong'})),/authenticated draft/);
});

test('explicit finalization authorization survives bounded continuation without changing the default',()=>{
 const team=base();team.revision=4;team.state='active';team.tasks=compileTeamTasks(team,input()).tasks;
 const data={team,runs:[],workflow:{actions:[],stage:'observe'}};
 assert.equal(advancementResponse(data).continuationArgs.finishReady,undefined);
 assert.equal(advancementResponse(data,'coordination',{finishReady:true}).continuationArgs.finishReady,true);
});
