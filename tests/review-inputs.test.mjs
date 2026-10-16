import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureEvidenceSnapshot} from '../src/evidence-snapshot.mjs';
import {reviewInputs,REVIEW_INPUT_MAX_BYTES} from '../src/review-inputs.mjs';
import {evidencePage} from '../src/team-evidence.mjs';

async function fixture(t){const cwd=await mkdtemp(join(tmpdir(),'review-inputs-'));t.after(()=>rm(cwd,{force:true,recursive:true}));await writeFile(join(cwd,'source.py'),'original');const work={id:'work',memberId:'dev',kind:'work',status:'submitted',contractRevision:1,contract:{inScope:['source.py']},attempts:[{id:'attempt',contractRevision:1,turnId:'turn',observation:{status:'completed',commands:[{command:'python3 -m unittest -v',cwd,status:'completed',exitCode:0,output:'original log'}]}}],evidence:[{attemptId:'attempt',summary:'Original full delivery'}]},review={id:'review',kind:'review',reviewOfTaskId:'work',attempts:[{id:'review-attempt',dependencyAttempts:[{taskId:'work',attemptId:'attempt',contractRevision:1}]}]},team={id:'team',revision:4,projectPath:cwd,members:[{id:'dev',writeScopes:['source.py']}],tasks:[work,review]};work.attempts[0].evidenceSnapshot=await captureEvidenceSnapshot(team,work,['source.py']);return {team,work,review,cwd};}
test('review startup bundles exact original evidence and own current input proof without execution or mutation',async t=>{
 const f=await fixture(t),before=structuredClone(f.team),r=await reviewInputs(f.team,f.review),target=r.targets[0];assert.equal(r.executesCommands,false);assert.equal(r.changesAcceptance,false);assert.equal(target.delivery.text,'Original full delivery');assert.equal(target.commands.commands[0].exitCode,0);assert.equal(target.candidate.matchesCompleteSavedInputs,true);assert.equal(target.candidate.currentContractMatches,true);assert.equal(r.completeTargetSet,true);assert.deepEqual(f.team,before);assert.equal(await reviewInputs(f.team,f.work),null);
 await writeFile(join(f.cwd,'source.py'),'changed');assert.equal((await reviewInputs(f.team,f.review)).targets[0].candidate.matchesCompleteSavedInputs,false);
 delete f.work.attempts[0].evidenceSnapshot;const unknown=(await reviewInputs(f.team,f.review)).targets[0].candidate;assert.equal(unknown.verified,false);assert.equal(unknown.matchesSavedInputs,null);
});
test('stale attempt and contract dependencies expose a blocker rather than selecting another delivery',async t=>{
 const f=await fixture(t);f.review.attempts[0].dependencyAttempts[0].attemptId='old';let r=await reviewInputs(f.team,f.review);assert.match(r.targets[0].error,/current exact/);assert.equal(r.targets[0].delivery,undefined);
 f.review.attempts[0].dependencyAttempts[0].attemptId='attempt';f.work.contractRevision=2;r=await reviewInputs(f.team,f.review);assert.match(r.targets[0].error,/current exact/);
});
test('review startup identifies the latest required outcome across paged failures without hiding history or choosing a PASS',async t=>{
 const f=await fixture(t),a=f.work.attempts[0],cwd=a.evidenceSnapshot.workspace;f.work.contract.verify=['python3 -m unittest -v'];
 a.observation.commands=[{commandId:'old-failure',turnId:'turn',command:'python3 -m unittest -v',cwd,status:'failed',exitCode:1}, {...a.observation.commands[0],cwd,commandId:'current-success',turnId:'turn'}];
 let r=await reviewInputs(f.team,f.review),target=r.targets[0];assert.equal(target.commands.commands[0].exitCode,1);assert.equal(target.commands.hasMore,false);assert.equal(target.requiredCommandOutcomes[0].commandId,'current-success');assert.equal(target.requiredCommandOutcomes[0].exitCode,0);assert.equal(target.requiredCommandOutcomes[0].nativeCommandReads[1].arguments.commandIndex,1);assert.equal(target.requiredCommandOutcomes[0].nativeCommandReads[1].arguments.limit,4000);assert.equal(a.observation.commands.length,2);
 a.observation.commands.push({commandId:'later-failure',turnId:'turn',command:'python3 -m unittest -v',cwd,status:'failed',exitCode:2});
 target=(await reviewInputs(f.team,f.review)).targets[0];assert.equal(target.requiredCommandOutcomes[0].commandId,'later-failure');assert.equal(target.requiredCommandOutcomes[0].exitCode,2);
 a.observation.commands.at(-1).exitCode=null;a.observation.commands.at(-1).status='inProgress';target=(await reviewInputs(f.team,f.review)).targets[0];assert.equal(target.requiredCommandOutcomes[0].status,'inProgress');assert.equal(target.requiredCommandOutcomes[0].exitCode,null);
 a.observation.commands=[];a.turnHistory=[{turnId:'prior',commands:[{commandId:'unbound-old-success',turnId:'prior',command:'python3 -m unittest -v',cwd,status:'completed',exitCode:0}]}];target=(await reviewInputs(f.team,f.review)).targets[0];assert.equal(target.requiredCommandOutcomes[0].status,'not-observed');
});
test('canonical evidence continuations read exact missing pages; command references never require schema guesses',async t=>{
 const f=await fixture(t);f.work.evidence[0].summary='原始\\"证据'.repeat(1500);const a=f.work.attempts[0];a.observation.commands[0].output='original command output '.repeat(600);
 for(const section of ['delivery','command-output']){
  const args={taskId:'work',attemptId:'attempt',section,limit:512,...(section==='command-output'?{commandIndex:0}:{})};let page=evidencePage(f.team,args),body=page.text;
  while(page.hasMore){assert.equal(page.nextRead.operation,'read_team_context');assert.equal(page.nextRead.arguments.cursor,page.cursor);assert.equal(page.nextRead.arguments.offset,page.nextOffset);page=evidencePage(f.team,page.nextRead.arguments);body+=page.text;}
  assert.equal(body,section==='delivery'?f.work.evidence[0].summary:a.observation.commands[0].output);assert.equal(page.nextRead,undefined);
 }
 a.observation.commands=Array.from({length:6},(_,i)=>({...a.observation.commands[0],commandId:'id'+i}));const first=evidencePage(f.team,{taskId:'work',section:'commands',limit:512}),next=evidencePage(f.team,first.nextRead.arguments);assert.equal(first.offsetUnit,'command-index');assert.equal(next.commands[0].index,first.nextOffset);const output=first.commands[0].fullTextReads[1];assert.equal(output.arguments.section,'command-output');assert.equal(output.arguments.teamId,f.team.id);assert.equal(evidencePage(f.team,output.arguments).text,a.observation.commands[0].output.slice(0,4000));
 const changed=structuredClone(f.team);changed.tasks[0].attempts[0].observation.commands[0].exitCode=3;assert.throws(()=>evidencePage(changed,first.nextRead.arguments),/Evidence changed/);
});
test('UTF8-heavy bundles shrink exact pages before omitting targets and retain failures without a verdict',async t=>{
 const f=await fixture(t),a=f.work.attempts[0];f.work.evidence[0].summary='中文原始证据'.repeat(4000);f.work.contract.verify=['python3 -m unittest -v'];f.work.acceptanceCriteria=[{id:'AC',description:'behavior'}];a.delivery={acceptanceResults:[{criterionId:'AC',status:'FAIL',evidence:'known defect'}]};a.observation.commands[0].commandId='host-command';
 const before=structuredClone(f.team),result=await reviewInputs(f.team,f.review),target=result.targets[0];assert.ok(Buffer.byteLength(JSON.stringify(result))<=REVIEW_INPUT_MAX_BYTES);assert.ok(target);assert.equal(target.delivery.hasMore,true);assert.equal(target.delivery.nextRead.arguments.offset,target.delivery.nextOffset);assert.equal(target.contractGate.clear,false);assert.equal(target.contractGate.isReviewVerdict,false);assert.deepEqual(target.contractGate.unpassedCriteria,[{criterionId:'AC',status:'FAIL'}]);assert.deepEqual(f.team,before);
});
test('paged evidence is exact and resumable; large target sets stay bounded and omissions explicit',async t=>{
 const f=await fixture(t),body='完整原始报告'.repeat(3000);f.work.evidence[0].summary=body;f.team.tasks=Array.from({length:20},(_,i)=>({...structuredClone(f.work),id:'work'+i}));f.review.reviewOfTaskId=undefined;f.review.reviewOfTaskIds=f.team.tasks.map(t=>t.id);f.review.attempts[0].dependencyAttempts=f.team.tasks.map(t=>({taskId:t.id,attemptId:'attempt',contractRevision:1}));f.team.tasks.push(f.review);
 const before=structuredClone(f.team),r=await reviewInputs(f.team,f.review);assert.ok(Buffer.byteLength(JSON.stringify(r))<=REVIEW_INPUT_MAX_BYTES);assert.equal(r.completeTargetSet,false);assert.equal(r.targets.length+r.remainingTargets.length,20);const page=r.targets[0].delivery;assert.equal(page.hasMore,true);const next=evidencePage(f.team,{taskId:page.taskId,attemptId:page.attemptId,section:'delivery',offset:page.nextOffset,cursor:page.cursor,limit:1000});assert.equal(page.text+next.text,body.slice(0,next.nextOffset));assert.deepEqual(f.team,before);
});
