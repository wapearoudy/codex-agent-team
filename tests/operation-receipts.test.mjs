import test from 'node:test';
import assert from 'node:assert/strict';
import {operationResponse,teamResponse} from '../src/team-responses.mjs';
import {workflowActions} from '../src/team-workflow.mjs';
import {largeDisplayFixture} from './fixtures/large-display.mjs';

test('model mutation receipts exclude completed previews and preserve exact operational packets',()=>{
 const data=largeDisplayFixture();data.workflow={stage:'execute',actions:[{type:'claim-batch',taskIds:['next']}]};
 data.team.tasks.push({id:'review',status:'accepted',reviewOfTaskId:'task0',attempts:[{id:'ra',turnId:'rt',acceptance:{source:'independent-reviewer',reviewTaskId:'review'}}]});
 data.dispatches=[{taskId:'next',prompt:'Full contract\n'+ 'Acceptance evidence\n'.repeat(100),spawnOptions:{fork_turns:'none'}}];
 data.memberAddition={requestId:'request',memberIds:['docs'],replayed:true};
 const before=structuredClone(data),reply=operationResponse(data,{operation:'accept_team_review',taskIds:['review']});
 assert.equal(reply.kind,'team-operation');assert.equal(reply.operation,'accept_team_review');
 for(const key of ['team','runs','readiness','quality','checkpoints','messages','detailToken'])assert.equal(reply[key],undefined);
 assert.deepEqual(reply.dispatches,data.dispatches);assert.deepEqual(reply.memberAddition,data.memberAddition);
 assert.deepEqual(reply.affectedTasks.map(t=>t.taskId),['task0','review']);assert.equal(reply.affectedTasks.at(-1).acceptedBy,'independent-reviewer');
 assert.ok(JSON.stringify(reply).length<6000);assert.deepEqual(data,before);
 assert.equal(teamResponse(data,'full').runs[0].commands[0].output,data.runs[0].commands[0].output);
});

test('compact receipts expose specific exceptions, bounded affected tasks and the selected evidence entry',()=>{
 const data=largeDisplayFixture();data.workflow={stage:'verify',actions:[]};
 data.team.tasks.push(...Array.from({length:4},(_,i)=>({id:'extra'+i,status:'waiting',attempts:[]})));
 data.team.tasks[0].attempts.at(-1).acceptanceException={reason:'Specific gate evidence required '.repeat(1000)};
 const reply=operationResponse(data,{operation:'settle_team_task',taskIds:data.team.tasks.map(t=>t.id)});
 assert.equal(reply.hasMoreAffectedTasks,true);assert.equal(reply.affectedTasks.length,8);
 assert.equal(reply.affectedTasks[0].exception.length,512);assert.equal(reply.affectedTasks[0].requiresLeader,true);
 assert.deepEqual(reply.evidenceAccess.arguments,{teamId:data.team.id,view:'evidence'});assert.deepEqual(reply.evidenceAccess.required,['taskId']);
 assert.equal(reply.evidenceAccess.fullHistory.explicitOnly,true);
});

function schedulingFixture(){return {id:'team',revision:1,maxParallel:3,members:[{id:'a',status:'idle',writeScopes:[]},{id:'b',status:'idle',writeScopes:[]}],tasks:[{id:'one',priority:1,status:'waiting',memberId:'a',dependencies:[],attempts:[]},{id:'two',priority:2,status:'waiting',memberId:'a',dependencies:[],attempts:[]},{id:'three',priority:3,status:'waiting',memberId:'b',dependencies:[],attempts:[]},{id:'history',status:'accepted',memberId:'b',dependencies:[],attempts:[{state:'submitted'}]}]};}
test('batch derivation reserves each logical member once without accessing historical observations',()=>{
 const team=schedulingFixture();Object.defineProperty(team.tasks.at(-1).attempts[0],'observation',{enumerable:true,get(){throw new Error('Historical observation must not be traversed');}});
 const result=workflowActions(team);assert.deepEqual(result.actions.find(a=>a.type==='claim-batch').taskIds,['one','three']);
 assert.equal(team.members[0].status,'idle');assert.equal(team.tasks[0].status,'waiting');assert.equal(team.tasks[0].attempts.length,0);
});
test('lightweight batch derivation retains parallel, resource, scope and dependency constraints',()=>{
 const team=schedulingFixture();team.maxParallel=1;assert.deepEqual(workflowActions(team).actions.find(a=>a.type==='claim-batch').taskIds,['one']);
 team.maxParallel=3;team.tasks[0].resources=['browser'];team.tasks[2].resources=['browser'];assert.deepEqual(workflowActions(team).actions.find(a=>a.type==='claim-batch').taskIds,['one']);
 team.tasks[2].resources=[];team.members[0].writeScopes=['src'];assert.deepEqual(workflowActions(team).actions.find(a=>a.type==='claim-batch').taskIds,['one']);
 team.members[0].writeScopes=[];team.tasks[2].dependencies=[{taskId:'one',when:'accepted'}];assert.deepEqual(workflowActions(team).actions.find(a=>a.type==='claim-batch').taskIds,['one']);
});
