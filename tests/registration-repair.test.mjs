import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {preflightDelivery} from '../src/delivery-preflight.mjs';
import {planRepair} from '../src/team-quality.mjs';
import {repairBudget,REPAIR_BUDGET_POLICY} from '../src/review-budget.mjs';
import {prepareTeamCommand} from '../src/team-output.mjs';
import {currentVerificationEvidence} from '../src/verification-reuse.mjs';

function budgetFixture(){
 const work={id:'work',kind:'work',memberId:'dev',status:'blocked',repairBudgetPolicy:REPAIR_BUDGET_POLICY,qualityMode:'strict',contract:{stage:'implementation',inScope:['source.py'],verify:['python3 -m unittest']},acceptanceCriteria:[{id:'AC',description:'Required behavior'}],attempts:[{id:'attempt',marker:'marker'}],dependencies:[],evidence:[],history:[]};
 const team={id:'team',policy:{maxReviewRounds:4,maxAttempts:2},tasks:[work],events:[],findings:[]};
 const reviewFor=(target,basis)=>{const review={id:'qa-'+team.tasks.length,kind:'review',status:'accepted',dependencies:[{taskId:target.id,when:'submitted'}],attempts:[{id:'qa-attempt-'+team.tasks.length,marker:'marker',review:{decision:'rework'}}],evidence:[]};review.evidence.push({attemptId:review.attempts[0].id,summary:JSON.stringify({summary:'Independent verdict',decision:'rework',findings:[{status:'open',basis}]})});team.tasks.push(review);return review;};
 return {team,work,reviewFor,repair:(target,basis)=>planRepair(team,reviewFor(target,basis),target,'Actual independent finding',{retainReview:true})};
}
test('registration fixes do not spend code review budget, while genuine repairs stay bounded and all originals remain',()=>{
 const f=budgetFixture(),original=structuredClone(f.work.attempts);let target=f.work;
 for(let i=0;i<2;i++){const r=f.repair(target,'missing-evidence');assert.ok(r);target=f.team.tasks.find(t=>t.id===r.repairTaskId);}
 assert.equal(repairBudget(f.team,target).codeUsed,0);assert.equal(repairBudget(f.team,target,{kind:'registration'}).canRepair,false);
 for(let i=0;i<3;i++){const r=f.repair(target,'source');assert.ok(r);target=f.team.tasks.find(t=>t.id===r.repairTaskId);}
 assert.equal(repairBudget(f.team,target).used,3);assert.equal(f.repair(target,'source'),null);assert.equal(target.status,'blocked');assert.equal(target.repairBudgetBlocker.canRepair,false);assert.deepEqual(f.work.attempts,original);assert.equal(f.team.events.filter(e=>e.type==='repair-planned').length,5);
});
test('unclassified, mixed or unsupported findings never masquerade as registration-only credit',()=>{
 for(const basis of [undefined,'reproduction','source']){const f=budgetFixture();assert.ok(f.repair(f.work,basis));assert.equal(repairBudget(f.team,f.team.tasks.find(t=>t.repairRootTaskId==='work')).codeUsed,1);}
 const f=budgetFixture(),r=f.reviewFor(f.work,'missing-evidence');JSON.parse(r.evidence[0].summary);r.evidence[0].summary=JSON.stringify({decision:'rework',findings:[{status:'open',basis:'missing-evidence'},{status:'open',basis:'source'}]});planRepair(f.team,r,f.work,'Both issues',{retainReview:true});assert.equal(f.team.events.at(-1).budgetClass,'code');
});
test('routed joint findings retain full evidence; exhausted owner budget leaves prior acceptance unchanged',()=>{
 const f=budgetFixture();f.work.status='accepted';const integration={...structuredClone(f.work),id:'integration',status:'blocked',contract:{stage:'integration',inScope:[],verify:['python3 -m unittest']}};f.team.tasks.push(integration);
 const codeReview=f.reviewFor(f.work,'source'),joint=f.reviewFor(integration,'source');f.team.findings=[{id:'fresh-db-race',rootTaskId:'integration',status:'open',criterionId:'joint',basis:'source',evidence:'Concurrent initialization reads schema before the transaction.',expected:'Atomic initialization',actual:'Second opener collides',description:'Fresh DB race'}];
 const r=planRepair(f.team,codeReview,f.work,'Fix joint finding',{retainReview:true,sourceReview:joint,sourceTarget:integration});assert.ok(r);assert.equal(f.team.tasks.find(t=>t.id===r.repairTaskId).repairFocus.routedFindings[0].evidence,f.team.findings[0].evidence);
 const g=budgetFixture();g.work.status='accepted';g.team.events=Array.from({length:3},()=>({type:'repair-planned',rootTaskId:'work',budgetPolicy:REPAIR_BUDGET_POLICY,budgetClass:'code'}));const later={...structuredClone(integration),dependencies:[]};g.team.tasks.push(later);const before=structuredClone(g.work);assert.equal(planRepair(g.team,g.reviewFor(g.work,'source'),g.work,'New joint issue',{retainReview:true,sourceReview:g.reviewFor(later,'source'),sourceTarget:later}),null);assert.deepEqual(g.work,before);assert.equal(later.repairBudgetBlocker.ownerTaskId,'work');
});
test('legacy limits retain their original semantics',()=>{const f=budgetFixture();delete f.work.repairBudgetPolicy;f.work.repairRound=4;assert.equal(f.repair(f.work,'missing-evidence'),null);});
test('NOT_RUN on unchanged criteria rejects before QA; real FAIL/BLOCKED remains factual and legacy reports remain readable',()=>{
 const f=budgetFixture(),member={writeScopes:['source.py']},a=f.work.attempts[0];f.team.projectPath='/work';f.work.deliveryReadinessPolicy='same-attempt-v1';const report={attemptMarker:a.marker,summary:'Only evidence formatting changed',changedPaths:[],acceptanceResults:[{criterionId:'AC',status:'NOT_RUN',evidence:'Unchanged requirement; full suite already passed.'}],commandsRun:[]};const commands=[{commandId:'real-test',turnId:'turn',command:'python3 -m unittest',cwd:'/work',status:'completed',exitCode:0}],before=structuredClone(f.team);
 assert.equal(preflightDelivery(f.team,f.work,member,JSON.stringify(report),commands).valid,false);assert.deepEqual(f.team,before);
 report.acceptanceResults[0]={criterionId:'AC',status:'PASS',evidence:'Inspected current source and the same original successful verification.'};assert.equal(preflightDelivery(f.team,f.work,member,JSON.stringify(report),commands).valid,true);assert.equal(preflightDelivery(f.team,f.work,member,JSON.stringify(report),[{...commands[0],exitCode:null}]).valid,false);
 for(const status of ['FAIL','BLOCKED']){report.acceptanceResults[0].status=status;assert.equal(preflightDelivery(f.team,f.work,member,JSON.stringify(report),[]).valid,true);}
 delete f.work.deliveryReadinessPolicy;report.acceptanceResults[0].status='NOT_RUN';assert.equal(preflightDelivery(f.team,f.work,member,JSON.stringify(report),commands).valid,true);
});

async function evidenceFixture(t){const root=await realpath(await mkdtemp(join(tmpdir(),'team-reuse-')));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,'source.py'),'source=1\n');await writeFile(join(root,'tests.py'),'tests=1\n');const team={id:randomUUID(),projectPath:root,leaderThreadId:'leader',members:[{id:'dev',agentThreadId:'native',writeScopes:['source.py']}],tasks:[{id:'work',memberId:'dev',status:'running',contract:{inScope:['source.py'],readPaths:['tests.py'],verify:['python3 -m unittest']},attempts:[{id:randomUUID(),agentThreadId:'native',turnId:'turn'}]}]},task=team.tasks[0],context={cwd:root,threadId:'native',parentThreadId:'leader'},input={taskId:task.id,attemptId:task.attempts[0].id,requestId:randomUUID(),command:'python3 -m unittest',verificationInputs:['source.py','tests.py']},prepared=await prepareTeamCommand(root,team,context,input);return {root,team,task,context,input,prepared,command:{commandId:'native-exact',turnId:'turn',command:prepared.nativeCommand,cwd:root,status:'completed',exitCode:0}};}
test('same-candidate supplement reuses the exact prior host result, even with a fresh request, and returns no executable command',async t=>{const f=await evidenceFixture(t),before=structuredClone(f.task);for(const requestId of [f.input.requestId,randomUUID()]){const result=await prepareTeamCommand(f.root,f.team,f.context,{...f.input,requestId},{commands:[f.command]});assert.equal(result.mustReuse,true);assert.equal(result.executionArguments,null);assert.equal(result.reuseEvidence.commandId,f.command.commandId);assert.equal(result.reuseEvidence.requestId,f.input.requestId);}assert.deepEqual(f.task,before);});
test('changed/expanded inputs, foreign cwd/turn, later FAIL/unknown cannot reuse an earlier PASS',async t=>{const f=await evidenceFixture(t);for(const c of [{...f.command,cwd:'/other'},{...f.command,turnId:'other'},{...f.command,exitCode:null},{...f.command,exitCode:1,status:'failed'}])assert.equal((await currentVerificationEvidence(f.root,f.team,f.task,[c]))[0].canReuse,false);
 assert.equal((await currentVerificationEvidence(f.root,f.team,f.task,[f.command,{...f.command,commandId:'later',exitCode:1,status:'failed'}]))[0].canReuse,false);
 assert.equal((await currentVerificationEvidence(f.root,f.team,f.task,[f.command],undefined,['source.py','tests.py','new-config.py']))[0].canReuse,false);
 await writeFile(join(f.root,'tests.py'),'tests=2\n');assert.equal((await currentVerificationEvidence(f.root,f.team,f.task,[f.command]))[0].canReuse,false);
});
test('known native failure plus corrected complete inputs prepares a new binding and preserves original metadata and log',async t=>{
 const f=await evidenceFixture(t),before=await readFile(f.prepared.logPath.replace(/\.log$/,'.json'),'utf8');await writeFile(f.prepared.logPath,'original failure\n');await writeFile(join(f.root,'tests.py'),'tests=2\n');
 const fresh=await prepareTeamCommand(f.root,f.team,f.context,{...f.input,refreshChangedInputs:true},{commands:[{...f.command,status:'failed',exitCode:1}]});
 assert.notEqual(fresh.requestId,f.input.requestId);assert.equal(fresh.refreshedFrom.commandId,f.command.commandId);assert.equal(fresh.inputProof.currentMatchesSavedInputs,true);assert.equal(fresh.mustReuse,false);assert.ok(fresh.executionArguments);
 assert.equal(await readFile(f.prepared.logPath.replace(/\.log$/,'.json'),'utf8'),before);assert.equal(await readFile(f.prepared.logPath,'utf8'),'original failure\n');
 const passed={...f.command,commandId:'corrected',command:fresh.nativeCommand};const reuse=await prepareTeamCommand(f.root,f.team,f.context,{...f.input,requestId:fresh.requestId},{commands:[{...f.command,exitCode:1},passed]});assert.equal(reuse.mustReuse,true);assert.equal(reuse.executionArguments,null);
});
test('unchanged, pending, unknown, foreign or unproved outcomes never authorize automatic fresh validation',async t=>{
 const f=await evidenceFixture(t),failed={...f.command,status:'failed',exitCode:1};let result=await prepareTeamCommand(f.root,f.team,f.context,{...f.input,refreshChangedInputs:true},{commands:[failed]});assert.equal(result.requestId,f.input.requestId);assert.equal(result.refreshedFrom,undefined);
 await writeFile(join(f.root,'tests.py'),'tests=2\n');for(const c of [{...failed,exitCode:null},{...failed,status:'inProgress'},{...failed,cwd:'/other'},{...failed,turnId:'other'},{...failed,command:'python3 -m unittest'}]){result=await prepareTeamCommand(f.root,f.team,f.context,{...f.input,refreshChangedInputs:true},{commands:[c]});assert.equal(result.refreshedFrom,undefined);assert.equal(result.requestId,f.input.requestId);}
});

test('a lost changed-input preparation reply replays the same fresh request without another execution',async t=>{
 const f=await evidenceFixture(t),failed={...f.command,status:'failed',exitCode:1};await writeFile(join(f.root,'tests.py'),'tests=2\n');const args={...f.input,refreshChangedInputs:true};const first=await prepareTeamCommand(f.root,f.team,f.context,args,{commands:[failed]}),again=await prepareTeamCommand(f.root,f.team,f.context,args,{commands:[failed]});assert.equal(first.requestId,again.requestId);assert.equal(first.nativeCommand,again.nativeCommand);assert.deepEqual(first.refreshedFrom,again.refreshedFrom);
});
test('multiple known failures can refresh from the latest original proof even if a caller retains the first request ID',async t=>{
 const f=await evidenceFixture(t),commands=[{...f.command,status:'failed',exitCode:1}];let prior=f.input.requestId;for(let n=2;n<=4;n++){await writeFile(join(f.root,'tests.py'),'tests='+n+'\n');const args={...f.input,refreshChangedInputs:true},fresh=await prepareTeamCommand(f.root,f.team,f.context,args,{commands});assert.notEqual(fresh.requestId,prior);assert.equal(fresh.refreshedFrom.requestId,prior);assert.equal(fresh.executionObserved,false);assert.ok(fresh.executionArguments);assert.equal((await prepareTeamCommand(f.root,f.team,f.context,args,{commands})).requestId,fresh.requestId);commands.push({...f.command,commandId:'failure-'+n,command:fresh.nativeCommand,status:'failed',exitCode:1});prior=fresh.requestId;}
 const unchanged=await prepareTeamCommand(f.root,f.team,f.context,{...f.input,requestId:prior,refreshChangedInputs:true},{commands});assert.equal(unchanged.executionArguments,null);assert.equal(unchanged.refreshedFrom,undefined);
});
