import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {ProjectTeams} from '../src/project-teams.mjs';
import {startTeamGoal} from '../src/goal-start.mjs';
import {executionCompleted,validateLeaderExecutions,activateLeaderDispatch} from '../src/leader-execution.mjs';
import {deliveryReady,bindMemberThread,submitTask} from '../src/team.mjs';
import {planRepair} from '../src/team-quality.mjs';
import {associateTurn} from '../src/turn-association.mjs';
import {applyReviewDecision} from '../src/reviewer-acceptance.mjs';
import {workflowActions} from '../src/team-workflow.mjs';
import {advancementResponse} from '../src/team-responses.mjs';
import {completionReceipt} from '../src/team-completion.mjs';
import {qualityMetrics} from '../src/quality-policy.mjs';

async function fixture(t,{auto=false}={}){
 const cwd=await realpath(await mkdtemp(join(tmpdir(),'leader-inline-')));t.after(()=>rm(cwd,{recursive:true,force:true}));await writeFile(join(cwd,'keys.py'),'value=1\n');
 const run={threadId:'leader',turnId:'root-turn',status:'inProgress',commands:[],source:'native-leader-checkpoint',observedAt:new Date().toISOString()},observer={async inspectLeader(root,path,turn){assert.equal(root,'leader');assert.equal(path,cwd);if(turn&&turn!==run.turnId)throw Error('exact bound native turn');return structuredClone(run);}};
 const engine=new LeaderEngine({root:join(cwd,'records'),observer});t.after(()=>engine.close());
 const input={requestId:randomUUID(),goal:'Bounded behavior',approvalMode:'immediate',executionAuthorization:'User authorized bounded implementation and independent review',members:[{id:'dev',role:'Developer',responsibility:'Leader implementation',reason:'Avoid extra execution context',writeScopes:['keys.py']},{id:'qa',role:'Reviewer',responsibility:'Independent audit',reason:'Independent review',writeScopes:[]}],reviewerId:'qa',batch:{id:'goal',title:'Bounded goal',goal:'Implement behavior',qualityMode:'standard',integrationRequired:false},units:[{id:'work',title:'Implementation',goal:'Implement behavior',memberId:'dev',executionMode:'leader',criteria:[{id:'AC',description:'Required behavior'}],writePaths:['keys.py'],readPaths:['keys.py'],verifyCommands:['python3 -m unittest'],dependencies:[]}]};
 if(auto)Object.assign(input.units[0],{executionMode:'auto',complexity:'medium'});
 const context={cwd,threadId:'leader',hostId:'codex'},result=await startTeamGoal(new ProjectTeams(engine),'owner',context,input),teamId=result.team.id,attemptId=result.dispatches[0].attemptId;
 const start=()=>engine.startLeaderTask('owner',teamId,context,{taskId:'work',attemptId});
 const report=async()=>{const team=await engine.native('owner',teamId),a=team.tasks[0].attempts.at(-1);return {taskId:'work',attemptId,requestId:randomUUID(),delivery:JSON.stringify({attemptMarker:a.marker,summary:'Implemented exact bounded behavior',changedPaths:['keys.py'],acceptanceResults:[{criterionId:'AC',status:'PASS',evidence:'Exact source and actual test exit'}],commandsRun:['python3 -m unittest'],verificationInputs:['keys.py'],limitations:[]})};};
 const command=(id='test')=>({commandId:id,turnId:run.turnId,command:'python3 -m unittest',cwd,status:'completed',exitCode:0,output:'actual test log'});
 return {cwd,engine,input,context,run,result,teamId,attemptId,start,report,command};
}
test('replayed startup and routine continuation recover the original active Leader bundle without another binding or validation',async t=>{
 const f=await fixture(t),projects=new ProjectTeams(f.engine);
 await activateLeaderDispatch(f.engine,f.result,'owner',f.context);
 const before=await f.engine.native('owner',f.teamId);
 f.run.commands.push(f.command('already-completed-validation'));
 const replay=await startTeamGoal(projects,'owner',f.context,f.input);
 assert.equal(replay.dispatches.length,0);
 const recovered=await activateLeaderDispatch(f.engine,replay,'owner',f.context);
 assert.equal(recovered.leaderExecution.attemptId,f.attemptId);
 assert.equal(recovered.leaderExecution.readyForWork,true);
 assert.equal(recovered.leaderExecution.recoveredFromCurrentAttempt,true);
 assert.equal(typeof recovered.leaderExecution.submissionProgram,'string');
 assert.equal(recovered.dispatches.length,0);
 const after=await f.engine.native('owner',f.teamId);
 assert.deepEqual(after.tasks[0].attempts,before.tasks[0].attempts);
 assert.equal(after.totalDispatches,before.totalDispatches);
 assert.equal(f.run.commands.length,1);
 const routine=await activateLeaderDispatch(f.engine,{...replay,team:after},'owner',f.context);
 assert.equal(routine.leaderExecution.attemptId,f.attemptId);
 f.run.turnId='new-root-turn';
 await assert.rejects(()=>activateLeaderDispatch(f.engine,{...replay,team:after},'owner',f.context),/exact bound native turn/);
 assert.deepEqual((await f.engine.native('owner',f.teamId)).tasks[0].attempts,after.tasks[0].attempts);
});
test('recovery never reopens a sealed submission, launches a child, or bypasses execution controls',async t=>{
 const f=await fixture(t);await f.start();f.run.commands.push(f.command());
 const submitted=await f.engine.reportLeaderTask('owner',f.teamId,f.context,await f.report());
 const input={...submitted,dispatches:[]};assert.equal((await activateLeaderDispatch(f.engine,input,'owner',f.context)).leaderExecution,undefined);
 const g=await fixture(t);await g.start();let team=await g.engine.native('owner',g.teamId);
 team=(await g.engine.store.update(g.teamId,'owner',team.revision,t=>{t.dispatchPaused=true;})).team;
 await assert.rejects(()=>activateLeaderDispatch(g.engine,{team,dispatches:[]},'owner',g.context),/paused/);
 assert.equal(g.run.commands.length,0);
 const child=structuredClone(team);child.tasks[0].executionMode='member';
 assert.equal((await activateLeaderDispatch(g.engine,{team:child,dispatches:[]},'owner',g.context)).leaderExecution,undefined);
});
test('Leader checkpoint starts before own work, keeps native turn active, and reserves distinct QA once',async t=>{
 const f=await fixture(t);assert.equal(f.result.dispatches[0].action,'execute-in-leader');await assert.rejects(()=>f.engine.reportLeaderTask('owner',f.teamId,f.context,{taskId:'work',attemptId:f.attemptId,delivery:'{}'}),/bound/);
 const first=await f.start(),replay=await f.start();assert.equal(first.sourceInputs.complete,true);assert.equal(first.sourceInputs.pages[0].text,'value=1\n');assert.equal(first.sourceInputs.isVerdict,false);assert.deepEqual(first.verificationPreparation,replay.verificationPreparation);assert.equal(first.verificationPreparation[0].operation,'prepare_team_command');f.run.commands.push(f.command());const report=await f.report(),r=await f.engine.reportLeaderTask('owner',f.teamId,f.context,report),team=r.team,a=team.tasks[0].attempts[0];
 assert.equal(a.observation.status,'inProgress');assert.equal(a.leaderNativeHistory.status,'inProgress');assert.equal(executionCompleted(a),true);assert.equal(deliveryReady(team.tasks[0]),true,JSON.stringify([team.tasks[0].contract, a.delivery, a.evidenceSnapshot.workspace, a.observation.commands]));assert.equal(team.tasks[0].status,'submitted');assert.equal(team.tasks[1].status,'running');assert.equal(r.dispatches.length,1);assert.equal(r.dispatches[0].memberId,'qa');assert.equal(team.events.filter(e=>e.type==='leader-self-bound').length,1);
 assert.equal((await f.engine.reportLeaderTask('owner',f.teamId,f.context,report)).dispatches?.length??0,0);await assert.rejects(()=>f.engine.reportLeaderTask('owner',f.teamId,f.context,{...report,delivery:report.delivery+' '}),/already sealed/);
 const edited=structuredClone(team);edited.tasks[0].attempts[0].memberSubmission.text+=' ';assert.equal(executionCompleted(edited.tasks[0].attempts[0]),false);assert.throws(()=>validateLeaderExecutions(edited),/checkpoint/);
});
test('auto Leader execution completes independent QA, persistent registration and final closure without duplicate validation',async t=>{
 const f=await fixture(t,{auto:true});assert.equal(f.result.team.requiresTeamWorkspaceVersion,'0.40.48');assert.equal(f.result.team.tasks[0].executionStrategy.mode,'leader');await f.start();f.run.commands.push(f.command());await f.engine.reportLeaderTask('owner',f.teamId,f.context,await f.report());
 const team=await f.engine.native('owner',f.teamId),review=team.tasks[1],a=review.attempts[0],verdict={attemptMarker:a.marker,summary:'Independent contract audit',decision:'accept',reason:'Exact candidate satisfies required behavior',checks:[{name:'Required behavior',criterionId:'AC',status:'PASS',evidence:'keys.py:1 exact current source and original host validation exit 0'}],findings:[]};
 bindMemberThread(team,review.id,'qa-native',a.id);associateTurn(team,review,{threadId:'qa-native',turnId:'qa-turn',status:'completed',source:'native-thread-persisted-snapshot',commands:[],outputs:[{text:JSON.stringify(verdict)}]});submitTask(team,review.id,{attemptId:a.id,summary:JSON.stringify(verdict)});await applyReviewDecision(f.engine,team,review.id,a.id,'accept',verdict.reason);
 await f.engine.store.update(f.teamId,'owner',team.revision,t=>Object.assign(t,team));const saved=await f.engine.native('owner',f.teamId),closed=await f.engine.finish('owner',f.teamId,saved.revision,'Close independently accepted exact candidate',[],true,'goal'),receipt=completionReceipt(closed.team);
 assert.equal(receipt?.kind,'team-goal-completion');assert.equal(qualityMetrics(closed.team).deliveryQuality.goalClosed,true);assert.equal(qualityMetrics(closed.team).deliveryQuality.firstReviewPassRate,1);assert.equal(f.run.commands.length,1);
 const replay=await f.engine.finish('owner',f.teamId,closed.team.revision,'Close independently accepted exact candidate',[],true,'goal');assert.deepEqual(completionReceipt(replay.team),receipt);assert.equal(replay.team.tasks[0].attempts[0].id,f.attemptId);assert.equal(replay.team.tasks[1].attempts[0].id,a.id);assert.equal(f.run.commands.length,1);
});
test('review-readiness rejects incomplete bookkeeping before QA and corrects the SAME attempt using existing validation',async t=>{
 const f=await fixture(t);await f.start();f.run.commands.push(f.command());const report=await f.report(),original=JSON.parse(report.delivery);original.acceptanceResults[0].status='NOT_RUN';
 const rejected=await f.engine.reportLeaderTask('owner',f.teamId,f.context,{...report,delivery:JSON.stringify(original),requireReviewReady:true});
 assert.equal(rejected.deliveryPreflight.valid,false);assert.equal(rejected.startsReview,false);let team=await f.engine.native('owner',f.teamId);assert.equal(team.tasks[0].status,'running');assert.equal(team.tasks[1].attempts.length,0);assert.equal(team.tasks[0].attempts[0].submissionDrafts[0].text,JSON.stringify(original));
 const accepted=await f.engine.reportLeaderTask('owner',f.teamId,f.context,{...report,requestId:randomUUID(),requireReviewReady:true});team=accepted.team;assert.equal(team.tasks[0].attempts.length,1);assert.equal(team.tasks[0].attempts[0].id,f.attemptId);assert.equal(team.tasks[0].attempts[0].submissionDrafts.length,1);assert.equal(team.tasks[1].attempts.length,1);assert.equal(f.run.commands.length,1);assert.equal(team.tasks[0].status,'submitted');
});
test('auto inherited model drift blocks binding before writes, retaining the exact reservation for correction',async t=>{
 const f=await fixture(t,{auto:true}),team=await f.engine.native('owner',f.teamId),route={model:'gpt-6-luna',provider:'openai',reasoningEffort:'medium'};await f.engine.store.update(f.teamId,'owner',team.revision,t=>{t.tasks[0].executionStrategy.inheritedRoute=route;});
 await assert.rejects(f.start,/route changed or is unknown/);let saved=await f.engine.native('owner',f.teamId);assert.equal(saved.tasks[0].attempts[0].id,f.attemptId);assert.equal(saved.tasks[0].attempts[0].agentThreadId,null);assert.equal(f.run.commands.length,0);const blocked=workflowActions(saved,[]);assert.equal(blocked.waitBlocked,true);assert.equal(blocked.startupBlockers.at(-1).code,'leader-model-route-mismatch');const wire=advancementResponse({team:saved,workflow:blocked,runs:[],usage:{}},'coordination',{includeWaitProgram:true});assert.equal(wire.waitProgram,undefined);const revision=saved.revision;await assert.rejects(f.start,/route changed or is unknown/);assert.equal((await f.engine.native('owner',f.teamId)).revision,revision,'Same rejected route does not add duplicate evidence');
 Object.assign(f.run,route);await f.start();saved=await f.engine.native('owner',f.teamId);assert.equal(saved.tasks[0].attempts[0].executedRoute.model,'gpt-6-luna');assert.equal(saved.tasks[0].attempts.length,1);assert.equal(saved.tasks[0].attempts[0].leaderRouteBlocker,undefined);assert.equal(saved.tasks[0].attempts[0].leaderRouteBlockerHistory.length,1);
 f.run.reasoningEffort='high';await assert.rejects(f.start,/route changed or is unknown/);assert.equal(f.run.commands.length,0);
});
test('baseline commands cannot supply verification; pending exits, wrong turn and foreign Leader cannot seal',async t=>{
 const f=await fixture(t);f.run.commands.push(f.command('old-test'));await f.start();const report=await f.report();let r=await f.engine.reportLeaderTask('owner',f.teamId,f.context,report);assert.equal(r.deliveryPreflight.valid,false);const retained=await f.engine.native('owner',f.teamId);assert.equal(retained.tasks[0].status,'running');assert.equal(retained.tasks[1].attempts.length,0);assert.equal(retained.tasks[0].attempts[0].leaderBindingHistory.commands.length,1);assert.equal(r.startsReview,false,'Baseline test cannot supply current review-ready PASS');
 const g=await fixture(t);await g.start();g.run.commands.push({...g.command(),status:'inProgress',exitCode:null});await assert.rejects(async()=>g.engine.reportLeaderTask('owner',g.teamId,g.context,await g.report()),/running or unknown/);g.run.commands[0]=g.command();g.run.turnId='another-turn';await assert.rejects(async()=>g.engine.reportLeaderTask('owner',g.teamId,g.context,await g.report()),/exact bound/);await assert.rejects(()=>g.engine.startLeaderTask('owner',g.teamId,{...g.context,threadId:'foreign'},{taskId:'work',attemptId:g.attemptId}),/authenticated Leader/);
});
test('long-wait stale activity returns original reservation and one explicit fresh bind, never a fake active status',async t=>{
 const f=await fixture(t),original=f.engine.observer.inspectLeader;
 f.engine.observer.inspectLeader=async()=>{const e=Error('Activity expired during native wait');e.code='LEADER_ACTIVITY_STALE';throw e;};
 const r=await activateLeaderDispatch(f.engine,f.result,'owner',f.context),a=r.team.tasks[0].attempts[0];
 assert.equal(a.agentThreadId,null);assert.equal(a.state,'reserved');assert.equal(r.leaderExecution.readyForWork,false);assert.equal(r.dispatches.length,0);assert.equal(r.leaderExecution.startsModel,false);
 const wire=advancementResponse(r,'coordination',{includeWaitProgram:true});assert.deepEqual(wire.leaderExecution,r.leaderExecution);assert.equal(wire.waitProgram,undefined);
 f.engine.observer.inspectLeader=original;const values=new Map([['teamStep',wire]]),outputs=[],calls=[];
 const api={tools:{async native__team_leader(input){calls.push(input);return {structuredContent:await f.engine.startLeaderTask('owner',f.teamId,f.context,input.arguments)};}},ALL_TOOLS:[{name:'native__team_leader'}],text:x=>outputs.push(x),store:(k,v)=>values.set(k,v),load:k=>values.get(k)};
 await new Function('tools','ALL_TOOLS','text','store','load','return (async()=>{'+wire.leaderExecution.startInvocation+'})()')(...['tools','ALL_TOOLS','text','store','load'].map(k=>api[k]));
 const bound=values.get('teamStep').leaderExecution;assert.equal(bound.readyForWork,true);assert.equal(bound.attemptId,f.attemptId);assert.equal(calls.length,1);assert.equal(outputs.length,1);assert.equal(typeof bound.submissionProgram,'string');
 assert.equal((await f.engine.native('owner',f.teamId)).events.filter(e=>e.type==='leader-self-bound').length,1);
 const g=await fixture(t);g.engine.observer.inspectLeader=async()=>{throw Error('Real abort or identity mismatch');};await assert.rejects(()=>activateLeaderDispatch(g.engine,g.result,'owner',g.context),/Real abort/);
});
test('independent terminal QA can accept the root checkpoint; changed candidate and self-review cannot',async t=>{
 const f=await fixture(t);await f.start();f.run.commands.push(f.command());await f.engine.reportLeaderTask('owner',f.teamId,f.context,await f.report());
 let team=await f.engine.native('owner',f.teamId),review=team.tasks[1],a=review.attempts[0];
 const verdict={attemptMarker:a.marker,taskId:'work',attemptId:f.attemptId,summary:'Independent source inspection',decision:'accept',reason:'Actual source satisfies all criteria',checks:[{name:'Required behavior',criterionId:'AC',status:'PASS',evidence:'Original current source, unchanged candidate and real test exit 0'}],findings:[]};
 bindMemberThread(team,review.id,'qa-native',a.id);associateTurn(team,review,{threadId:'qa-native',turnId:'qa-turn',status:'completed',source:'native-thread-persisted-snapshot',commands:[],outputs:[{text:JSON.stringify(verdict)}]});submitTask(team,review.id,{attemptId:a.id,summary:JSON.stringify(verdict)});
 await writeFile(join(f.cwd,'keys.py'),'changed=2\n');await assert.rejects(()=>applyReviewDecision(f.engine,team,review.id,a.id,'accept','QA accepted'),/changed/);await writeFile(join(f.cwd,'keys.py'),'value=1\n');
 const self=structuredClone(team);self.tasks[1].attempts[0].agentThreadId='leader';self.tasks[1].attempts[0].observation.threadId='leader';await assert.rejects(()=>applyReviewDecision(f.engine,self,review.id,a.id,'accept','Self audit'),/distinct/);
 await applyReviewDecision(f.engine,team,review.id,a.id,'accept','Native QA passed');assert.equal(team.tasks[0].status,'accepted');assert.equal(team.tasks[0].attempts[0].observation.status,'inProgress');assert.equal(team.tasks[1].status,'accepted');
});
test('Leader repair startup carries exact independent findings and keeps old evidence without forwarding history',async t=>{
 const f=await fixture(t);await f.start();f.run.commands.push(f.command());await f.engine.reportLeaderTask('owner',f.teamId,f.context,await f.report());
 const team=await f.engine.native('owner',f.teamId),target=team.tasks[0],review=team.tasks[1],a=review.attempts[0];
 const verdict={attemptMarker:a.marker,taskId:target.id,attemptId:f.attemptId,summary:'Independent source defect',decision:'rework',reason:'Invalid state types must raise ValueError',checks:[{name:'Required behavior',criterionId:'AC',status:'FAIL',evidence:'List state currently raises TypeError'}],findings:[{id:'invalid-state',severity:'high',status:'open',criterionId:'AC',basis:'source',evidence:'keys.py:1 has no required invalid-state guard',expected:target.acceptanceCriteria[0].description,actual:'TypeError from set membership',description:'List/object state must raise ValueError; fix the state guard, not the earlier argparse issue.'}]};
 bindMemberThread(team,review.id,'qa-native',a.id);associateTurn(team,review,{threadId:'qa-native',turnId:'qa-turn',status:'completed',source:'native-thread-persisted-snapshot',commands:[],outputs:[{text:JSON.stringify(verdict)}]});submitTask(team,review.id,{attemptId:a.id,summary:JSON.stringify(verdict)});
 await applyReviewDecision(f.engine,team,review.id,a.id,'rework',verdict.reason);
 const original=structuredClone(target.attempts[0]),result=await f.engine.store.update(f.teamId,'owner',team.revision,t=>{Object.assign(t,team);const p=planRepair(t,t.tasks[1],t.tasks[0],verdict.reason,{retainReview:true});return p;});
 const claimed=await f.engine.claimMany('owner',f.teamId,result.team.revision,[result.result.repairTaskId]),repair=claimed.team.tasks.find(t=>t.id===result.result.repairTaskId),started=await f.engine.startLeaderTask('owner',f.teamId,f.context,{taskId:repair.id,attemptId:repair.attempts[0].id});
 assert.match(started.workContext.context,/Invalid state types/);assert.equal(started.workContext.repairRootTaskId,'work');assert.deepEqual(started.workContext.repairFindingIds,['invalid-state']);assert.deepEqual(started.workContext.openFindings,verdict.findings);assert.equal(started.workContext.openFindings[0].history,undefined);
 assert.deepEqual((await f.engine.native('owner',f.teamId)).tasks[0].attempts[0],original);assert.match(started.instruction,/previous delivery is not this repair goal/);assert.deepEqual(started.contract.inScope,['keys.py']);
});
test('cooperative stop retains real native activity and never interrupts root as a child',async t=>{
 const f=await fixture(t);await f.start();f.run.commands.push(f.command());let team=await f.engine.native('owner',f.teamId);let r=await f.engine.stop('owner',f.teamId,team.revision,{requestId:randomUUID(),reason:'User requested pause'});assert.ok(r.leaderAction.targets.every(x=>x.threadId!=='leader'));
 r=await f.engine.reconcileStop('owner',f.teamId,r.team.revision);assert.equal(r.team.state,'halted');assert.equal(r.team.tasks[0].status,'blocked');assert.equal(r.team.tasks[0].attempts[0].leaderStopCheckpoint.observation.status,'inProgress');assert.equal(r.team.tasks[0].attempts[0].stopEvidence.quiescence,undefined);
 const g=await fixture(t);await g.start();g.run.commands.push({...g.command(),status:'inProgress',exitCode:null});team=await g.engine.native('owner',g.teamId);await assert.rejects(()=>g.engine.stop('owner',g.teamId,team.revision,{requestId:randomUUID(),reason:'Pause'}),/existing Leader command/);assert.equal((await g.engine.native('owner',g.teamId)).state,'active');
});
test('invalid grouped/strict/non-Codex Leader configuration rejects before creating a team',async t=>{
 const f=await fixture(t);for(const patch of [{batch:{...f.input.batch,qualityMode:'strict'}},{units:[f.input.units[0],{...f.input.units[0],id:'second'}],combineGroups:[{id:'group',unitIds:['work','second']}]}]){const cwd=await mkdtemp(join(tmpdir(),'leader-invalid-'));t.after(()=>rm(cwd,{recursive:true,force:true}));const r=await startTeamGoal(new ProjectTeams(f.engine),'other',{...f.context,cwd},{...f.input,requestId:randomUUID(),...patch});assert.equal(r.valid,false);assert.equal(r.startsModel,false);}
 await assert.rejects(()=>startTeamGoal(new ProjectTeams(f.engine),'other',{...f.context,hostId:'deepseek-harness'},{...f.input,requestId:randomUUID()}),/Codex/);
 const team=await f.engine.native('owner',f.teamId);assert.ok(workflowActions(team).actions.some(a=>a.type==='execute-in-leader'));
});

async function resumeFixture(t,{exitCode=0,prepared=true,drift=false,pending=false,baselineFailure=false,rejectedDraft=false}={}){
 const f=await fixture(t);Object.assign(f.run,{model:'gpt-6-luna',provider:'openai',reasoningEffort:'medium'});const started=await f.start(),args=started.verificationPreparation[0].arguments;const cmd=prepared?await f.engine.prepareCommand('owner',f.teamId,f.context,args):null;f.run.commands.push({...f.command('original-required-check'),command:cmd?.nativeCommand??'python3 -m unittest',exitCode, status:pending?'inProgress':'completed'});if(rejectedDraft){const rejected=await f.report();rejected.requestId=(await f.engine.native('owner',f.teamId)).tasks[0].attempts[0].leaderReportRequestId;const body=JSON.parse(rejected.delivery);body.acceptanceResults[0].status='NOT_RUN';rejected.delivery=JSON.stringify(body);assert.equal((await f.engine.reportLeaderTask('owner',f.teamId,f.context,{...rejected,requireReviewReady:true})).deliveryPreflight.valid,false);}const previous=structuredClone(f.run);previous.status='completed';Object.assign(f.run,{turnId:'continued-root-turn',status:'inProgress',commands:baselineFailure?[{...f.command('new-baseline-failure'),turnId:'continued-root-turn',exitCode:1}]:[]});if(drift)f.run.model='different-model';
 f.engine.observer.inspectLeader=async(root,cwd,bound)=>{if(bound&&bound!==f.run.turnId)throw Object.assign(Error('exact bound native turn'),{code:'LEADER_TURN_CHANGED'});return structuredClone(f.run);};f.engine.observer.inspectHistoricalLeader=async()=>({...structuredClone(previous),latestTurnId:f.run.turnId,historicalResumeOnly:true});return {...f,previous,preparedArgs:args,preparedCommand:cmd};
}
test('ended Leader work resumes the SAME attempt and reuses original unchanged validation without tests or another review',async t=>{
 const f=await resumeFixture(t),before=await f.engine.native('owner',f.teamId),started=await f.start();assert.equal(started.resumedFromTurnId,'root-turn');assert.equal(started.turnId,'continued-root-turn');let team=await f.engine.native('owner',f.teamId),a=team.tasks[0].attempts[0];assert.equal(a.id,f.attemptId);assert.equal(team.totalDispatches,before.totalDispatches);assert.equal(a.leaderResumptions.length,1);assert.equal(a.leaderResumptions[0].testsExecuted,false);assert.equal(a.leaderResumptions[0].previousTaskCommands[0].commandId,'original-required-check');
 const reused=await f.engine.prepareCommand('owner',f.teamId,f.context,started.verificationPreparation[0].arguments);assert.equal(reused.mustReuse,true);assert.equal(reused.executionArguments,null);await f.start();assert.equal((await f.engine.native('owner',f.teamId)).tasks[0].attempts[0].leaderResumptions.length,1);
 const submitted=await f.engine.reportLeaderTask('owner',f.teamId,f.context,await f.report());team=submitted.team;a=team.tasks[0].attempts[0];assert.equal(executionCompleted(a),true);assert.equal(team.tasks[0].status,'submitted');assert.equal(team.tasks[1].status,'running');assert.equal(a.leaderReusedVerificationCommands[0].turnId,'root-turn');assert.equal(f.run.commands.length,0);validateLeaderExecutions(team);const edited=structuredClone(team);edited.tasks[0].attempts[0].leaderResumptions[0].previousTaskCommands[0].exitCode=1;assert.throws(()=>validateLeaderExecutions(edited),/history/);
});
test('Leader resume refuses route drift and pending/unknown native outcomes without partial rebinding',async t=>{
 for(const options of [{drift:true},{pending:true},{exitCode:null}]){const f=await resumeFixture(t,options),before=await f.engine.native('owner',f.teamId);await assert.rejects(f.start,/resume|Historical/);assert.deepEqual(await f.engine.native('owner',f.teamId),before);}
});
test('changed resumed inputs invalidate old PASS; original failure and unprepared success never authorize bookkeeping reruns',async t=>{
 const f=await resumeFixture(t);await writeFile(join(f.cwd,'keys.py'),'value=2\n');const started=await f.start(),rejected=await f.engine.reportLeaderTask('owner',f.teamId,f.context,await f.report());assert.equal(rejected.deliveryPreflight.valid,false);const fresh=await f.engine.prepareCommand('owner',f.teamId,f.context,{...started.verificationPreparation[0].arguments,refreshChangedInputs:true});assert.notEqual(fresh.requestId,f.preparedArgs.requestId);assert.equal(fresh.refreshedFrom.exitCode,0);assert.ok(fresh.executionArguments);assert.equal(f.run.commands.length,0);
 const g=await resumeFixture(t,{exitCode:1});let execution=await g.start(),blocked=await g.engine.prepareCommand('owner',g.teamId,g.context,{...execution.verificationPreparation[0].arguments,refreshChangedInputs:true});assert.equal(blocked.executionArguments,null);assert.equal(blocked.mustReuse,false);await writeFile(join(g.cwd,'keys.py'),'value=3\n');blocked=await g.engine.prepareCommand('owner',g.teamId,g.context,{...execution.verificationPreparation[0].arguments,refreshChangedInputs:true});assert.ok(blocked.executionArguments);
 const h=await resumeFixture(t,{prepared:false});execution=await h.start();blocked=await h.engine.prepareCommand('owner',h.teamId,h.context,execution.verificationPreparation[0].arguments);assert.equal(blocked.executionArguments,null);assert.equal(blocked.inputProof.reusable,false);assert.match(blocked.inputProof.reason,/never rerun/);
});
test('a newer pre-resume native failure invalidates historical success instead of supplying or bypassing a check',async t=>{
 const f=await resumeFixture(t,{baselineFailure:true});await f.start();const r=await f.engine.reportLeaderTask('owner',f.teamId,f.context,await f.report());assert.equal(r.deliveryPreflight.valid,false);const saved=await f.engine.native('owner',f.teamId);assert.equal(saved.tasks[1].attempts.length,0);assert.equal(saved.tasks[0].attempts[0].leaderResumptions[0].currentBaselineFailures[0].commandId,'new-baseline-failure');
});

test('multiple authenticated Leader resumptions preserve the chain and allocate a fresh report ID after a rejected draft',async t=>{
 const f=await resumeFixture(t,{rejectedDraft:true}),before=await f.engine.native('owner',f.teamId),oldReportId=before.tasks[0].attempts[0].leaderReportRequestId;await f.start();let saved=await f.engine.native('owner',f.teamId);const firstReportId=saved.tasks[0].attempts[0].leaderReportRequestId;assert.notEqual(firstReportId,oldReportId);assert.equal(saved.tasks[0].attempts[0].submissionDrafts.length,1);const middle=structuredClone(f.run);middle.status='completed';f.run.turnId='third-root-turn';f.engine.observer.inspectHistoricalLeader=async()=>({...middle,latestTurnId:f.run.turnId,historicalResumeOnly:true});await f.start();saved=await f.engine.native('owner',f.teamId);const a=saved.tasks[0].attempts[0];assert.equal(a.leaderResumptions.length,2);assert.deepEqual(a.leaderResumptions.map(r=>r.fromTurnId),['root-turn','continued-root-turn']);assert.notEqual(a.leaderReportRequestId,firstReportId);const report=await f.report();report.requestId=a.leaderReportRequestId;const submitted=await f.engine.reportLeaderTask('owner',f.teamId,f.context,report);assert.equal(submitted.team.tasks[0].status,'submitted');assert.equal(f.run.commands.length,0);assert.equal(submitted.team.totalDispatches,1,'Resuming and reserving QA never fabricate another started execution');
});
test('native historical Leader evidence is read-only, exact and rejects live or pending predecessors',async t=>{
 const {NativeMembers}=await import('../src/native-members.mjs'),f=await fixture(t);let evidence={status:'interrupted',source:'persisted-turn-aborted'};const thread={id:'leader',cwd:f.cwd,model:'gpt-6-luna',modelProvider:'openai',reasoningEffort:'medium',turns:[{id:'old',status:'completed',items:[{type:'commandExecution',id:'old-command',command:'python3 -m unittest',cwd:f.cwd,status:'completed',exitCode:0}]},{id:'new',status:'inProgress',items:[]}]};const native=new NativeMembers({rpcFactory:()=>({async connect(){},async close(){},async call(){return {thread:structuredClone(thread)};}}),lifecycleReader:async()=>evidence});t.after(()=>native.close());
 await assert.rejects(()=>native.inspectLeader('leader',f.cwd,'old'),e=>e.code==='LEADER_TURN_CHANGED');const proof=await native.inspectHistoricalLeader('leader',f.cwd,'old');assert.equal(proof.historicalResumeOnly,true);assert.equal(proof.historicalStopOnly,undefined);assert.equal(proof.turnId,'old');assert.equal(proof.latestTurnId,'new');assert.equal(proof.commands[0].turnId,'old');
 thread.turns[0].status='inProgress';await assert.rejects(()=>native.inspectHistoricalLeader('leader',f.cwd,'old'),/Historical/);thread.turns[0].status='completed';thread.turns[0].items[0].exitCode=null;await assert.rejects(()=>native.inspectHistoricalLeader('leader',f.cwd,'old'),/Historical/);thread.turns[0].items[0].exitCode=0;thread.turns[0].status='interrupted';assert.equal((await native.inspectHistoricalLeader('leader',f.cwd,'old')).status,'interrupted');evidence={status:'unknown',source:'persisted-native-activity-stale'};await assert.rejects(()=>native.inspectHistoricalLeader('leader',f.cwd,'old'),/unknown/);assert.equal(thread.turns.length,2);
});
