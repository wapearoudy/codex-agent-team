import test from 'node:test';
import assert from 'node:assert/strict';
import {completionReceipt,COMPLETION_MAX_BYTES} from '../src/team-completion.mjs';
import {advancementResponse,operationResponse} from '../src/team-responses.mjs';

function fixture(){
 const work={id:'work',batchId:'current',kind:'work',status:'accepted',contract:{verify:['python3 -m unittest -v']},attempts:[{id:'attempt',agentThreadId:'worker',turnId:'turn',evidenceSnapshot:{workspace:'/tmp/project'},acceptance:{source:'independent-reviewer',gate:'plugin-quality-checks',reviewTaskId:'review',reviewAttemptId:'review-attempt'},observation:{commands:[{command:'python3 -m unittest -v',cwd:'/tmp/project',turnId:'turn',status:'completed',exitCode:0,output:'Original full log'}]}}],evidence:[{attemptId:'attempt',summary:JSON.stringify({summary:'Implemented behavior',changedPaths:['source.py']})}]};
 return {id:'team',revision:9,state:'active',projectPath:'/tmp/project',activeBatchId:'current',members:[],batches:[{id:'old',state:'delivered',finalAcceptance:{at:'old'}},{id:'current',goal:'Current authorized goal',state:'delivered',finalAcceptance:{at:'now',reusedEvidence:[{taskId:'work'}]}}],tasks:[work,{id:'review',batchId:'current',kind:'review',status:'accepted',attempts:[{id:'review-attempt',agentThreadId:'qa',turnId:'review-turn'}]},{id:'old-work',batchId:'old',kind:'work',status:'accepted',attempts:[],evidence:[{summary:'Historical record'}]}]};
}
test('closure receipts carry exact current task identities, validation and artifacts without historical logs',()=>{
 const team=fixture(),before=structuredClone(team),r=completionReceipt(team);
 assert.deepEqual(r.counts,{accepted:2,cancelled:0,independentReviews:1,contractCommands:1});assert.equal(r.tasks[0].attemptId,'attempt');assert.equal(r.tasks[0].threadId,'worker');assert.equal(r.tasks[0].acceptance.reviewTaskId,'review');assert.equal(r.commands[0].exitCode,0);assert.equal(r.commands[0].verifiedAtAcceptance,true);assert.deepEqual(r.changedPaths,['source.py']);assert.equal(r.reusedEvidenceCount,1);assert.equal(r.currentFilesRechecked,false);assert.doesNotMatch(JSON.stringify(r),/Original full log|Historical record/);assert.deepEqual(team,before);
 for(const fn of [data=>advancementResponse(data),data=>operationResponse(data,{operation:'finish_team'})]){const result=fn({team,runs:[],workflow:{stage:'completed',actions:[]}});assert.equal(result.terminal,true);assert.equal(result.continuationArgs,undefined);assert.deepEqual(result.completion,r);assert.match(result.completion.instruction,/no routine history/);}
});
test('no completion claim from submitted/pending/reopened/cancelled-only or another batch acceptance',()=>{
 for(const alter of [t=>delete t.batches[1].finalAcceptance,t=>t.tasks[0].status='submitted',t=>t.tasks[0].status='waiting',t=>t.activeBatchId='new',t=>{t.batches.push({id:'new'});t.activeBatchId='new';},t=>t.tasks[0].status='cancelled']){const team=fixture();alter(team);assert.equal(completionReceipt(team),null);}
});
test('legacy closure is supported, missing/failed commands remain unknown/failed and source-only work claims no test',()=>{
 const team=fixture();delete team.activeBatchId;team.batches=[];team.tasks=team.tasks.slice(0,2);team.finalAcceptance={at:'now'};
 team.tasks[0].attempts[0].observation.commands[0].exitCode=1;let r=completionReceipt(team);assert.equal(r.commands[0].verifiedAtAcceptance,false);assert.equal(r.commands[0].exitCode,1);
 team.tasks[0].attempts[0].observation.commands=[];r=completionReceipt(team);assert.equal(r.commands[0].verifiedAtAcceptance,false);assert.equal(r.commands[0].exitCode,null);
 team.tasks[0].contract.verify=[];r=completionReceipt(team);assert.deepEqual(r.commands,[]);assert.equal(r.counts.contractCommands,0);
});
test('large histories and long command declarations stay bounded with explicit detail references',()=>{
 const team=fixture(),template=team.tasks[0];team.tasks=Array.from({length:100},(_,i)=>({...structuredClone(template),id:'t'+i}));for(const task of team.tasks)task.contract.verify=['node '+('x'.repeat(2000))];
 const before=structuredClone(team),r=completionReceipt(team);assert.ok(Buffer.byteLength(JSON.stringify(r))<=COMPLETION_MAX_BYTES);assert.equal(r.truncated,true);assert.equal(r.counts.accepted,100);assert.equal(r.counts.contractCommands,100);assert.equal(r.detailAccess.explicitDetailOnly,true);assert.deepEqual(team,before);
});
test('bounded output keeps final integration command even when per-task command previews are omitted',()=>{
 const team=fixture(),template=team.tasks[0];team.batches[1].integrationRequired=true;team.tasks=Array.from({length:25},(_,i)=>({...structuredClone(template),id:'t'+i}));const integration=team.tasks.at(-1);integration.id='final-integration';integration.contract.stage='integration';integration.contract.verify=['node --test integration.mjs'];integration.attempts[0].observation.commands=[{command:'node --test integration.mjs',cwd:team.projectPath,status:'completed',exitCode:0}];
 const before=structuredClone(team),r=completionReceipt(team);assert.ok(Buffer.byteLength(JSON.stringify(r))<=COMPLETION_MAX_BYTES);assert.equal(r.validation.integrationRequired,true);assert.equal(r.validation.finalVerification.taskId,'final-integration');assert.equal(r.validation.finalVerification.command,'node --test integration.mjs');assert.equal(r.validation.finalVerification.exitCode,0);assert.equal(r.validation.declaredCommands,25);assert.equal(r.validation.verifiedCommands,25);assert.equal(r.truncated,true);assert.deepEqual(team,before);
});
