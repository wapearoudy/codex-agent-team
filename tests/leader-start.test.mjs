import test from 'node:test';
import assert from 'node:assert/strict';
import {runLeaderStart,leaderStartTransport} from '../src/leader-start.mjs';
import {leaderSubmissionProgram} from '../src/leader-submission.mjs';

function fixture(){
 const args={teamId:'team',taskId:'repair',attemptId:'current-attempt'},values=new Map(),calls=[],outputs=[],commands=[];
 const execution={kind:'leader-execution',readyForWork:true,...args,deliveryTemplate:{attemptMarker:'current-marker'},acceptanceCriteria:[{id:'AC'}],reportArguments:args,verificationPreparation:[{operation:'prepare_team_command',arguments:{command:'actual test',requestId:'verification'}}]};
 execution.submissionProgram=leaderSubmissionProgram(execution,'report');
 const receipt={kind:'coordination',waitProgram:'saved wait'};
 const api={tools:{async exact__team_leader(input){calls.push(input);return {structuredContent:input.operation==='start_leader_team_task'?execution:input.operation==='prepare_team_command'?{inputProof:{reusable:true,currentMatchesSavedInputs:true},executionArguments:{cmd:'actual saved command'},logPath:'/original/log'}:receipt};},async exec_command(input){commands.push(input);return {exit_code:0};}},ALL_TOOLS:[{name:'exact__team_leader'}],text:v=>outputs.push(v),store:(k,v)=>{assert.notEqual(v,undefined,'The real host rejects undefined stored values');return values.set(k,v);},load:k=>values.get(k),notify:()=>{}};
 const transport=leaderStartTransport(args);values.set('teamStep',{leaderExecution:{readyForWork:false,nextRead:transport}});
 const evaluate=program=>new Function('tools','ALL_TOOLS','text','store','load','notify','return (async()=>{'+program+'})()')(...['tools','ALL_TOOLS','text','store','load','notify'].map(k=>api[k]));
 return {args,values,calls,outputs,commands,execution,receipt,api,transport,evaluate};
}
test('fresh binding replaces stale transport and executes the returned submission unchanged',async()=>{
 const f=fixture();await f.evaluate(f.transport.invocation);
 assert.equal(f.values.get('teamStep').leaderExecution,f.execution);assert.equal(f.calls.length,1);assert.equal(f.commands.length,0);
 assert.equal(f.values.get('teamDelivery'),null);assert.deepEqual(f.values.get('teamDeliveryIdentity'),f.args);
 f.values.set('teamDelivery',{attemptMarker:'current-marker',summary:'Actual repair inspected',changedPaths:['source'],acceptanceResults:[{criterionId:'AC',status:'PASS',evidence:'Inspected corrected source'}]});
 await f.evaluate(f.values.get('teamStep').leaderExecution.submissionProgram);
 assert.equal(f.commands.length,1);assert.equal(f.calls.filter(c=>c.operation==='report_leader_team_task').length,1);assert.equal(f.values.get('teamStep'),f.receipt);
});
test('unavailable, errored, stale or foreign binding never overwrites evidence or starts validation',async()=>{
 for(const mode of ['unavailable','error','stale','foreign']){
  const f=fixture(),before=f.values.get('teamStep');
  if(mode==='unavailable')f.api.ALL_TOOLS=[];
  else if(mode==='error')f.api.tools.exact__team_leader=async()=>({isError:true,content:[{type:'text',text:'Real activity cannot be verified'}]});
  else if(mode==='stale')f.execution.readyForWork=false;
  else f.execution.attemptId='another-attempt';
  if(['stale','foreign'].includes(mode))await assert.rejects(()=>runLeaderStart(f.api,f.args),/exact Leader attempt/);else await runLeaderStart(f.api,f.args);
  assert.equal(f.values.get('teamStep'),before);assert.equal(f.commands.length,0);
 }
});
test('cold start transport adopts a verified resumed epoch without replaying prior work',async()=>{
 const f=fixture();Object.assign(f.execution,{turnId:'new-turn',resumedFromTurnId:'old-turn'});f.values.set('leaderSubmission:current-attempt',{phase:'unknown-reply'});f.values.set('leaderSubmissionEpoch:current-attempt','old-turn');await f.evaluate(f.transport.invocation);assert.equal(f.values.get('leaderSubmission:current-attempt'),null);assert.equal(f.values.get('leaderSubmissionHistory:current-attempt')[0].turnId,'old-turn');assert.equal(f.commands.length,0);
});
