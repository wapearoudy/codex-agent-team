import test from 'node:test';
import assert from 'node:assert/strict';
import {preflightDelivery,deliveryTemplate} from '../src/delivery-preflight.mjs';
const marker='TEAM_WORKSPACE_ATTEMPT:11111111-1111-4111-8111-111111111111';
function fixture(){
 const work={id:'work',kind:'work',memberId:'dev',contractRevision:1,contract:{stage:'implementation',verify:['python3 -m unittest']},acceptanceCriteria:[{id:'AC',description:'required behavior'}],attempts:[{id:'work-attempt',contractRevision:1,turnId:'work-turn',evidenceSnapshot:{workspace:'/work'},delivery:{acceptanceResults:[{criterionId:'AC',status:'PASS',evidence:'original evidence'}]},observation:{commands:[{commandId:'test',command:'python3 -m unittest',cwd:'/work',status:'completed',exitCode:0}]}}]};
 const review={id:'review',kind:'review',reviewOfTaskId:'work',attempts:[{id:'review-attempt',marker}]};
 const team={id:'team',projectPath:'/work',tasks:[work,review]},report={attemptMarker:marker,taskId:'work',attemptId:'work-attempt',summary:'Independent inspection',decision:'accept',reason:'Actual evidence satisfies this criterion',checks:[{name:'required behavior',criterionId:'AC',status:'PASS',evidence:'actual original source and host result'}],findings:[]};
 return {team,work,review,report,run:()=>preflightDelivery(team,review,{writeScopes:[]},JSON.stringify(report))};
}
test('accept preflight rejects the exact saved target contract failure without mutation or changing a verdict',()=>{
 const f=fixture();f.work.attempts[0].delivery.acceptanceResults[0].status='FAIL';f.report.findings=[{id:'typed-input',severity:'medium',status:'open',description:'Required malformed input returns the wrong error'}];const before=structuredClone(f.team),r=f.run();assert.equal(r.valid,false);assert.match(r.errors.find(e=>e.path==='targets.work.contract').message,/every criterion PASS/);assert.deepEqual(f.team,before);assert.equal(f.report.decision,'accept');
 f.report.decision='rework';f.report.checks[0].status='FAIL';f.report.reason='Fix the original required input mapping';assert.equal(f.run().valid,true,'The independent reviewer may report the actual negative result in the same native turn');
});
test('required check failures cannot be accepted based on medium severity; advisory medium findings remain possible',()=>{
 const f=fixture();f.report.findings=[{id:'advice',severity:'medium',status:'open',description:'Optional maintainability improvement'}];assert.equal(f.run().valid,true);
 f.report.checks[0].status='BLOCKED';assert.equal(f.run().valid,false);f.report.checks[0].status='PASS';f.report.findings[0].severity='high';assert.equal(f.run().valid,false);f.report.findings={invalid:'not array'};assert.equal(f.run().valid,false);
});
test('unknown or latest failed host result blocks accept preflight, but no test executes to fill the gap',()=>{
 const f=fixture(),a=f.work.attempts[0];a.observation.commands[0].exitCode=null;assert.equal(f.run().valid,false);a.observation.commands[0].exitCode=0;assert.equal(f.run().valid,true);a.observation.commands.push({...a.observation.commands[0],commandId:'later-failure',exitCode:1,status:'failed'});assert.equal(f.run().valid,false);f.report.decision='rework';f.report.findings=[{id:'verification',severity:'medium',status:'open',description:'Current exact host verification failed'}];assert.equal(f.run().valid,true);
});
test('batch preflight fences each current target independently',()=>{
 const f=fixture(),other=structuredClone(f.work);other.id='other';other.attempts[0].id='other-attempt';other.attempts[0].delivery.acceptanceResults[0].status='NOT_RUN';f.team.tasks.push(other);delete f.review.reviewOfTaskId;f.review.reviewOfTaskIds=['work','other'];const report={attemptMarker:marker,summary:'Batch audit',decision:'accept',targets:[f.report,{...structuredClone(f.report),taskId:'other',attemptId:'other-attempt'}]};const r=preflightDelivery(f.team,f.review,{writeScopes:[]},JSON.stringify(report));assert.equal(r.valid,false);assert.deepEqual(r.errors.map(e=>e.path),['targets.other.contract']);
});

test('single review uses its saved target binding without model-copied IDs; supplied wrong IDs still reject',()=>{
 const f=fixture(),template=deliveryTemplate(f.team,f.review);assert.equal(template.taskId,undefined);assert.equal(template.attemptId,undefined);
 const {taskId,attemptId,...report}=f.report;assert.equal(preflightDelivery(f.team,f.review,{writeScopes:[]},JSON.stringify(report)).valid,true);
 assert.equal(preflightDelivery(f.team,f.review,{writeScopes:[]},JSON.stringify({...report,attemptId:'wrong-target'})).valid,false);
 f.work.attempts[0].observation.commands[0].exitCode=1;assert.equal(preflightDelivery(f.team,f.review,{writeScopes:[]},JSON.stringify(report)).valid,false);
 f.review.reviewOfTaskIds=['work','other'];delete f.review.reviewOfTaskId;f.team.tasks.push({...structuredClone(f.work),id:'other'});const batch=deliveryTemplate(f.team,f.review);assert.deepEqual(batch.targets.map(r=>r.taskId),['work','other']);assert.equal(batch.targets[0].attemptId,'work-attempt');
});
test('finding closure and identity gates reject BEFORE ending QA; same review reuses inspected evidence without mutations',()=>{
 const f=fixture();f.team.findings=[{rootTaskId:'work',id:'sql-errors',severity:'high',status:'open',description:'Handle SQLite read errors',history:[{status:'open',evidence:'Original independent finding'}]}];const before=structuredClone(f.team);
 assert.equal(f.run().valid,false);assert.match(f.run().errors.at(-1).message,/sql-errors.*resolution evidence/);
 f.report.findings=[{id:'sql-errors',severity:'high',status:'resolved',description:'Handle SQLite read errors',resolutionEvidence:'Independently inspected current get/list/events wrappers mapping actual sqlite failures to storage-error'}];assert.equal(f.run().valid,true);assert.deepEqual(f.team,before);
 f.report.findings[0].severity='medium';assert.equal(f.run().valid,false);f.report.findings[0].severity='high';f.report.findings.push({...f.report.findings[0]});assert.equal(f.run().valid,false);f.report.findings.pop();f.report.findings[0].id='wrong-owner';f.team.findings.push({id:'wrong-owner',rootTaskId:'other',severity:'high',status:'open',description:'Other owner'});assert.equal(f.run().valid,false);
});

test('rework with only resolved findings rejects in the same QA turn instead of failing later registration',()=>{
 const f=fixture();f.work.qualityMode='strict';f.report.decision='rework';f.report.reason='The required current host verification result is missing';
 f.report.findings=[{id:'previous-defect',severity:'medium',status:'resolved',description:'Previous source defect closed',resolutionEvidence:'Independently inspected current unchanged source'}];const before=structuredClone(f.team);
 const rejected=f.run();assert.equal(rejected.valid,false);assert.match(rejected.errors.at(-1).message,/concrete open finding/);assert.deepEqual(f.team,before);
 f.report.findings.push({id:'required-host-verification',severity:'medium',status:'open',description:'Required host command has no authenticated terminal result'});assert.equal(f.run().valid,true);assert.deepEqual(f.team,before);
});
