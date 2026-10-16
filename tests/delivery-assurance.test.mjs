import test from 'node:test';
import assert from 'node:assert/strict';
import {compileTeamTasks} from '../src/team-plan-compiler.mjs';
import {assertReviewAssurance,REVIEW_EVIDENCE_POLICY} from '../src/review-assurance.mjs';
import {preflightDelivery} from '../src/delivery-preflight.mjs';
import {workflowActions} from '../src/team-workflow.mjs';
import {coordinationResponse,COORDINATION_MAX_BYTES} from '../src/team-coordination-response.mjs';
import {advancementResponse} from '../src/team-responses.mjs';
import {qualityMetrics} from '../src/quality-policy.mjs';
import {planRepair,recordFindings,validatedFindings,assertQualityFinish} from '../src/team-quality.mjs';
import {requireTeamVersion} from '../src/team-version.mjs';

const members=[{id:'dev',role:'Developer',reason:'Execution',responsibility:'Implement',writeScopes:['src']},{id:'qa',role:'Reviewer',reason:'Independent audit',responsibility:'Audit',writeScopes:[]}];
const unit=(id='work')=>({id,title:'Business work',goal:'Implement exact business behavior',memberId:'dev',criteria:[{id:'input',description:'Invalid input returns the specified error'}],writePaths:['src'],readPaths:['src/a.mjs'],verifyCommands:['node --test checks.mjs'],dependencies:[]});
const input=(units=[unit()])=>({units,reviewerId:'qa',batch:{id:'goal',title:'Business goal',goal:'Implement full business behavior',qualityMode:'standard'}});
const base=()=>({id:'team',state:'active',hostId:'codex',members:members.map(m=>({...structuredClone(m),status:'planned'})),tasks:[],events:[],batches:[],projectPath:'/project',leaderThreadId:'leader',policy:{maxAttempts:3},maxParallel:3});
const report=()=>({summary:'Independent contract audit',decision:'rework',reason:'Required error mapping is wrong',checks:[{criterionId:'input',name:'Invalid input returns the specified error',status:'FAIL',evidence:'src/a.mjs:7 takes the wrong error branch'}],findings:[{id:'invalid-input',severity:'high',status:'open',criterionId:'input',basis:'source',evidence:'src/a.mjs:7 lacks type validation before set membership',expected:'Invalid input returns the specified error',actual:'TypeError from unhashable array',description:'Wrong invalid-input exception'}]});

test('explicit auto selects bounded low/medium work with native independent QA, preserves models and high/risk scopes',()=>{
 for(const complexity of ['low','medium','high']){const p=compileTeamTasks(base(),input([{...unit(),executionMode:'auto',complexity}]));assert.equal(p.valid,true,JSON.stringify(p.errors));assert.equal(p.tasks[0].executionStrategy.mode,complexity==='high'?'member':'leader');assert.equal(p.tasks[1].reviewEvidencePolicy,REVIEW_EVIDENCE_POLICY);assert.equal(p.tasks[1].memberId,'qa');assert.deepEqual(p.tasks[0].acceptanceCriteria,unit().criteria);}
 for(const setup of ['other-host','route','multiple','risk']){const team=base(),u={...unit(),executionMode:'auto',complexity:'low'};let units=[u];if(setup==='other-host')team.hostId='deepseek-harness';if(setup==='route')team.members[0].route={model:'gpt-6-luna',reasoningEffort:'medium'};if(setup==='multiple')units.push({...unit('second'),dependencies:['work']});if(setup==='risk')u.riskFlags=['concurrency'];const p=compileTeamTasks(team,input(units));if(setup==='risk'){assert.equal(p.valid,false);assert.ok(p.errors.some(e=>e.code==='integration'));}else{assert.equal(p.valid,true,JSON.stringify(p.errors));assert.equal(p.tasks[0].executionStrategy.mode,'member');}}
 assert.equal(compileTeamTasks(base(),input([{...unit(),executionMode:'auto'}])).valid,false);assert.equal(compileTeamTasks(base(),input()).tasks[0].executionMode,undefined,'Default historical planning remains native');
});
test('new review requires contract-linked supported blockers and batches all criteria in one verdict',()=>{
 const review={reviewEvidencePolicy:REVIEW_EVIDENCE_POLICY},target={acceptanceCriteria:unit().criteria},r=report();assert.doesNotThrow(()=>assertReviewAssurance(review,target,r));
 for(const field of ['criterionId','basis','evidence','expected','actual']){const bad=structuredClone(r);delete bad.findings[0][field];assert.throws(()=>assertReviewAssurance(review,target,bad),/Finding/);}
 const outside=structuredClone(r);outside.findings[0].criterionId='later-docker';assert.throws(()=>assertReviewAssurance(review,target,outside),/current contract/);
 const contradiction=structuredClone(r);contradiction.checks[0].status='PASS';assert.throws(()=>assertReviewAssurance(review,target,contradiction),/contradicts/);
 const incomplete=structuredClone(r);incomplete.findings=[];assert.throws(()=>assertReviewAssurance(review,target,incomplete),/Rework requires/);
 assert.doesNotThrow(()=>assertReviewAssurance({},target,{decision:'rework',findings:[]}), 'Historical verdicts are not retroactively migrated');
});
test('auto uses inherited routing only with an exact current host route, never an explicit/fallback override',()=>{
 const team=base(),route={model:'gpt-6-luna',provider:'openai',reasoningEffort:'medium'},u=input([{...unit(),executionMode:'auto',complexity:'medium'}]);team.members[0].routeSnapshot={...route,source:'host-thread-inheritance-snapshot'};
 assert.equal(compileTeamTasks(team,u).tasks[0].executionStrategy.mode,'member');const same=compileTeamTasks(team,u,{leaderRoute:route});assert.equal(same.tasks[0].executionStrategy.mode,'leader');assert.deepEqual(same.tasks[0].executionStrategy.inheritedRoute,route);
 for(const key of ['model','provider','reasoningEffort'])assert.equal(compileTeamTasks(team,u,{leaderRoute:{...route,[key]:'changed'}}).tasks[0].executionStrategy.mode,'member');
 team.members[0].route={...route};assert.equal(compileTeamTasks(team,u,{leaderRoute:route}).tasks[0].executionStrategy.mode,'member');delete team.members[0].route;team.members[0].activeRoute={...route};assert.equal(compileTeamTasks(team,u,{leaderRoute:route}).tasks[0].executionStrategy.mode,'member');
});
test('advisory improvements do not force a repair, required missing evidence is never PASS',()=>{
 const review={reviewEvidencePolicy:REVIEW_EVIDENCE_POLICY},target={acceptanceCriteria:unit().criteria},r=report();r.decision='accept';r.checks[0].status='PASS';r.findings[0].scope='advisory';r.findings[0].severity='low';assert.doesNotThrow(()=>assertReviewAssurance(review,target,r));
 r.decision='rework';assert.throws(()=>assertReviewAssurance(review,target,r),/contract-linked/);r.findings[0].severity='high';assert.throws(()=>assertReviewAssurance(review,target,r),/cannot be advisory/);
 const missing=report();missing.checks[0].status='BLOCKED';missing.findings[0].basis='missing-evidence';assert.doesNotThrow(()=>assertReviewAssurance(review,target,missing));missing.decision='accept';assert.throws(()=>assertReviewAssurance(review,target,missing),/prevents acceptance/);
});
test('unsupported evidence is corrected within the same QA turn, preserving the saved candidate and all observations',()=>{
 const team=base(),p=compileTeamTasks(team,input());team.tasks=p.tasks;const work=team.tasks[0],review=team.tasks[1];work.attempts=[{id:'work-attempt'}];review.attempts=[{id:'qa-attempt',marker:'marker'}];const r={...report(),attemptMarker:'marker'},before=structuredClone(team);delete r.findings[0].evidence;
 const bad=preflightDelivery(team,review,members[1],JSON.stringify(r));assert.equal(bad.valid,false);assert.ok(bad.errors.some(e=>e.path==='assurance.work'));assert.deepEqual(team,before);
 r.findings[0].evidence='src/a.mjs:7 directly calls set membership with a list';assert.equal(preflightDelivery(team,review,members[1],JSON.stringify(r)).valid,true);assert.deepEqual(team,before);
});
test('idle blocked workflows return exact unmet prerequisites with no polling continuation or false completion',()=>{
 const team=base();team.tasks=[{...unit(),kind:'work',status:'blocked',blockReason:'Attempt limit reached',attempts:[],dependencies:[],contract:{stage:'implementation',verify:['node --test checks.mjs']}},{...unit('later'),kind:'work',status:'waiting',attempts:[],dependencies:[{taskId:'work',when:'accepted'}]}];
 const before=structuredClone(team),workflow=workflowActions(team,[]),data={team,runs:[],usage:{},workflow};assert.equal(workflow.stage,'workflow-blocked');assert.equal(workflow.waitBlocked,true);assert.ok(workflow.idleBlockers.find(b=>b.taskId==='later').reasons.some(r=>r.taskId==='work'));
 const r=coordinationResponse(data),again=coordinationResponse(data,{cursor:r.cursor});assert.equal(r.nextAction,'resolve-workflow-blocker');assert.equal(again.unchanged,undefined);assert.equal(r.nextTool,null);const wire=advancementResponse(data,'coordination',{includeWaitProgram:true});assert.equal(wire.waitProgram,undefined);assert.equal(wire.continuationArgs,undefined);assert.deepEqual(team,before);
});
test('native execution, approved closure and real ready work retain their progress paths',()=>{
 const team=base(),p=compileTeamTasks(team,input());team.tasks=p.tasks.map(t=>({...t,status:'waiting',attempts:[]}));assert.ok(workflowActions(team,[]).actions.some(a=>a.type==='claim-batch'));
 team.tasks[0].status='running';team.tasks[0].attempts=[{id:'active',state:'running',agentThreadId:'native'}];assert.equal(workflowActions(team,[{attemptId:'active',status:'inProgress'}]).waitBlocked,undefined);
 for(const t of team.tasks)t.status='accepted';assert.ok(workflowActions(team,[]).actions.some(a=>a.type==='final-validation'));
 team.finalAcceptance={note:'Saved valid closure'};assert.equal(workflowActions(team,[]).stage,'completed');assert.equal(workflowActions(team,[]).waitBlocked,undefined);
});
test('repair focus preserves unrelated accepted branches and requires the complete original contract',()=>{
 const team=base();team.tasks=compileTeamTasks(team,input()).tasks.map(t=>({...t,status:'submitted',attempts:[{id:t.id+'-attempt'}],history:[],evidence:[],context:'Original contract'}));team.tasks.push({...unit('unrelated'),kind:'work',status:'accepted',attempts:[{id:'unrelated-attempt',delivery:{summary:'Saved valid delivery'}}],evidence:[{summary:'Original PASS'}]});const work=team.tasks[0],review=team.tasks[1];recordFindings(team,review,work,report());const unchanged=structuredClone(team.tasks[2]);const planned=planRepair(team,review,work,'Fix the invalid input mapping',{retainReview:true}),repair=team.tasks.find(t=>t.id===planned.repairTaskId);
 assert.deepEqual(team.tasks[2],unchanged);assert.deepEqual(repair.acceptanceCriteria,work.acceptanceCriteria);assert.deepEqual(repair.contract.verify,work.contract.verify);assert.deepEqual(repair.repairFocus.findingIds,['invalid-input']);assert.equal(repair.repairFocus.fullContractRequired,true);assert.equal(team.findings[0].criterionId,'input');assert.equal(team.findings[0].history[0].evidence,report().findings[0].evidence);assert.equal(work.attempts[0].id,'work-attempt');
});
test('quality outcomes count root verdicts and accepted work, not cancelled repairs or accepted negative reviews',()=>{
 const team=base();team.tasks=[{id:'old',kind:'work',status:'cancelled',supersededBy:'repair',attempts:[]},{id:'repair',repairRootTaskId:'old',kind:'work',status:'accepted',attempts:[]},{id:'pending',kind:'work',status:'waiting',attempts:[]},{id:'qa1',kind:'review',reviewOfTaskId:'old',status:'accepted',attempts:[{id:'r1',review:{decision:'rework',at:'2026-10-14T00:00:00Z'}}]},{id:'qa2',kind:'review',reviewOfTaskId:'repair',status:'accepted',attempts:[{id:'r2',review:{decision:'accept',at:'2026-10-14T00:01:00Z'}}]}];team.findings=[{id:'f',rootTaskId:'old',status:'resolved'}];const q=qualityMetrics(team).deliveryQuality;assert.equal(q.currentWorkTasks,2);assert.equal(q.acceptedWorkTasks,1);assert.equal(q.unfinishedWorkTasks,1);assert.equal(q.reviewedWorkRoots,1);assert.equal(q.firstReviewPassRate,0);assert.equal(q.reworkDecisions,1);assert.equal(q.goalClosed,false);assert.equal(q.falsePositiveRate,null);assert.equal(qualityMetrics(base()).deliveryQuality.firstReviewPassRate,null);
});
test('patch-level quality requirements cannot be downgraded by later generic protocol calls',()=>{
 const t={requiresTeamWorkspaceVersion:'0.40.0'};requireTeamVersion(t,'0.40.42');requireTeamVersion(t,'0.40.9');requireTeamVersion(t,'0.38.0');assert.equal(t.requiresTeamWorkspaceVersion,'0.40.42');requireTeamVersion(t,'0.41.0');assert.equal(t.requiresTeamWorkspaceVersion,'0.41.0');
});
test('recorded medium contract defects need explicit closure and cannot be silently relabelled as advice',()=>{
 const team=base();team.tasks=compileTeamTasks(team,input()).tasks.map(t=>({...t,attempts:[{id:t.id+'-attempt'}]}));const [work,review]=team.tasks,r=report();r.findings[0].severity='medium';recordFindings(team,review,work,r);
 assert.equal(team.findings[0].reviewEvidencePolicy,REVIEW_EVIDENCE_POLICY);
 assert.throws(()=>validatedFindings(team,work,{findings:[]},{accept:true}),/resolution evidence/);
 assert.throws(()=>validatedFindings(team,work,{findings:[{...r.findings[0],scope:'advisory'}]}),/reclassified/);
 assert.throws(()=>assertQualityFinish(team),/contract-linked/);
 assert.doesNotThrow(()=>recordFindings(team,review,work,{findings:[{...r.findings[0],status:'resolved',resolutionEvidence:'keys.py:4 now validates the state type before membership'}]},{accept:true}));
 assert.equal(team.findings[0].history.length,2);assert.doesNotThrow(()=>assertQualityFinish(team));
});
test('large idle blocker summaries remain bounded while keeping explicit detail access',()=>{
 const team=base();team.tasks=Array.from({length:20},(_,i)=>({id:'t'+i,kind:'work',status:'blocked',blockReason:'Concrete evidence '.repeat(500),attempts:[],dependencies:[]}));const data={team,workflow:workflowActions(team,[]),runs:[],usage:{}},r=coordinationResponse(data);assert.ok(Buffer.byteLength(JSON.stringify(r))<=COORDINATION_MAX_BYTES);assert.equal(r.nextTool,null);assert.equal(r.hasMoreWorkflowBlockers,true);assert.equal(r.briefAccess.teamId,'team');
});
test('cancelled-only goals neither loop final acceptance nor pretend cancellation is delivery',()=>{
 const team=base();team.tasks=compileTeamTasks(team,input()).tasks.map(t=>({...t,status:'cancelled',attempts:[]}));const workflow=workflowActions(team,[]),r=coordinationResponse({team,workflow,runs:[],usage:{}});
 assert.equal(workflow.waitBlocked,true);assert.equal(workflow.idleBlockers[0].code,'no-accepted-goal-work');assert.ok(!workflow.actions.some(a=>a.type==='final-validation'));assert.equal(r.nextTool,null);assert.equal(r.nextAction,'resolve-workflow-blocker');assert.equal(r.terminal,undefined);
});
