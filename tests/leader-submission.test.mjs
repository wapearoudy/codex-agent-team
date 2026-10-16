import test from 'node:test';
import assert from 'node:assert/strict';
import {runLeaderSubmission,leaderSubmissionProgram} from '../src/leader-submission.mjs';

function fixture(){
 const values=new Map(),outputs=[],calls=[],commands=[],polls=[];
 const config={attemptMarker:'marker',criterionIds:['AC'],reportArguments:{teamId:'team',taskId:'work',attemptId:'attempt'},verificationPreparation:[{operation:'prepare_team_command',arguments:{command:'python3 -m unittest',requestId:'command-request'}}],requestId:'report-request'};
 const delivery={attemptMarker:'marker',summary:'Implemented checked behavior',changedPaths:['source.py'],acceptanceResults:[{criterionId:'AC',status:'PASS',evidence:'Inspected actual required source behavior'}],commandsRun:['untrusted old command']};
 values.set('teamDelivery',delivery);
 const prepared={executionArguments:{cmd:'exact redirect command',max_output_tokens:1200},logPath:'/saved/full.log',inputProof:{reusable:true,currentMatchesSavedInputs:true,fingerprint:'unchanged'},waitOptions:{yield_time_ms:55000,max_output_tokens:1200}};
 const receipt={kind:'coordination',dispatches:[{memberId:'qa'}],waitProgram:'exact saved wait program'};
 const tools={async mcp__team__team_leader(input){calls.push(input);return {structuredContent:input.operation==='prepare_team_command'?structuredClone(prepared):receipt};},async exec_command(input){commands.push(input);return {exit_code:0};},async write_stdin(input){polls.push(input);return {exit_code:0};}};
 const api={tools,ALL_TOOLS:[{name:'mcp__team__team_leader'}],text:r=>outputs.push(r),store:(k,v)=>values.set(k,structuredClone(v)),load:k=>values.get(k),notify:r=>outputs.push(r)};
 return {api,config,delivery,prepared,receipt,values,outputs,calls,commands,polls,run:()=>runLeaderSubmission(api,config)};
}
test('serialized submission runs exact native validation once and reports factual exits without log rereads',async()=>{
 const f=fixture(),execution={deliveryTemplate:f.delivery,acceptanceCriteria:[{id:'AC'}],reportArguments:f.config.reportArguments,verificationPreparation:f.config.verificationPreparation};
 const program=leaderSubmissionProgram(execution,f.config.requestId);
 await new Function('tools','ALL_TOOLS','text','store','load','notify','return (async()=>{'+program+'})()')(...['tools','ALL_TOOLS','text','store','load','notify'].map(k=>f.api[k]));
 assert.deepEqual(f.commands,[f.prepared.executionArguments]);assert.deepEqual(f.calls.map(c=>c.operation),['prepare_team_command','prepare_team_command','report_leader_team_task']);
 const args=f.calls.at(-1).arguments,report=JSON.parse(args.delivery);assert.equal(args.requireReviewReady,true);assert.equal(args.requestId,'report-request');assert.deepEqual(report.commandsRun,[{command:'python3 -m unittest',exitCode:0,evidence:'/saved/full.log'}]);assert.deepEqual(report.acceptanceResults,f.delivery.acceptanceResults);assert.deepEqual(f.values.get('teamStep'),f.receipt);assert.equal(f.values.get('teamWaitProgram'),f.receipt.waitProgram);
 await f.run();assert.equal(f.commands.length,1);assert.equal(f.calls.length,3);assert.deepEqual(f.outputs.at(-1),f.receipt);
});
test('incomplete source assessment and unavailable tools block before command execution',async()=>{
 for(const status of ['FAIL','BLOCKED','NOT_RUN']){const f=fixture();f.delivery.acceptanceResults[0].status=status;await f.run();assert.equal(f.commands.length,0);assert.equal(f.calls.length,0);assert.equal(f.outputs.at(-1).startsReview,false);}
 const f=fixture();f.api.ALL_TOOLS=[];await f.run();assert.equal(f.commands.length,0);assert.match(f.outputs.at(-1).reason,/unavailable/);
});
test('omitted marker is bound mechanically only to exact cached authenticated assessment identity',async()=>{
 const f=fixture();delete f.delivery.attemptMarker;f.values.set('teamDeliveryIdentity',f.config.reportArguments);await f.run();assert.equal(f.commands.length,1);assert.equal(JSON.parse(f.calls.at(-1).arguments.delivery).attemptMarker,'marker');
 for(const identity of [undefined,{...f.config.reportArguments,teamId:'other'},{...f.config.reportArguments,attemptId:'other'}]){const x=fixture();delete x.delivery.attemptMarker;x.values.set('teamDeliveryIdentity',identity);await x.run();assert.equal(x.commands.length,0);}
 const x=fixture();x.delivery.attemptMarker='wrong';x.values.set('teamDeliveryIdentity',x.config.reportArguments);await x.run();assert.equal(x.commands.length,0);
});
test('running verification waits the same native session, never repeats execution',async()=>{
 const f=fixture();f.api.tools.exec_command=async input=>{f.commands.push(input);return {session_id:42};};let pending=true;f.api.tools.write_stdin=async input=>{f.polls.push(input);if(pending){pending=false;return {session_id:42};}return {exit_code:0};};await f.run();assert.equal(f.commands.length,1);assert.equal(f.polls.length,2);assert.ok(f.polls.every(p=>p.session_id===42&&p.yield_time_ms===55000));assert.equal(f.calls.at(-1).operation,'report_leader_team_task');
});
test('failed and unknown native exits preserve results and never submit PASS or restart tests',async()=>{
 for(const exit_code of [1,undefined,null]){const f=fixture();f.api.tools.exec_command=async input=>{f.commands.push(input);return {exit_code};};await f.run();assert.equal(f.calls.length,1);assert.equal(f.values.get('leaderSubmission:attempt').commands[0].exitCode,exit_code);await f.run();assert.equal(f.commands.length,1);assert.equal(f.outputs.at(-1).startsReview,false);}
});
test('missing or changed complete input proof blocks reuse before and after real validation',async()=>{
 for(const inputProof of [{reusable:false},{reusable:true,currentMatchesSavedInputs:false}]){const f=fixture();f.prepared.inputProof=inputProof;await f.run();assert.equal(f.commands.length,0);assert.equal(f.calls.length,1);}
 const f=fixture();f.api.tools.mcp__team__team_leader=async input=>{f.calls.push(input);return {structuredContent:{...f.prepared,inputProof:{reusable:true,currentMatchesSavedInputs:f.calls.length===1}}};};await f.run();assert.equal(f.commands.length,1);assert.equal(f.calls.length,2);assert.equal(f.outputs.at(-1).startsReview,false);await f.run();assert.equal(f.commands.length,1);
});
test('lost command or registration replies retain exact evidence and never rerun on reinvocation',async()=>{
 for(const phase of ['command','report']){const f=fixture();if(phase==='command')f.api.tools.exec_command=async input=>{f.commands.push(input);throw Error('native reply unavailable');};else f.api.tools.mcp__team__team_leader=async input=>{f.calls.push(input);if(input.operation==='report_leader_team_task')throw Error('registration reply unavailable');return {structuredContent:f.prepared};};await f.run();assert.equal(f.values.get('leaderSubmission:attempt').phase,'unknown-reply');await f.run();assert.equal(f.commands.length,1);assert.equal(f.calls.filter(c=>c.operation==='report_leader_team_task').length,phase==='command'?0:1);}
});
test('an already verified candidate uses authenticated original results without any native test execution',async()=>{
 const f=fixture();f.prepared.mustReuse=true;f.prepared.executionArguments=null;f.prepared.reuseEvidence={canReuse:true,commandId:'original',turnId:'original-turn',requestId:'original-request',exitCode:0,logPath:'/saved/original.log'};
 await f.run();assert.equal(f.commands.length,0);assert.equal(f.calls.at(-1).operation,'report_leader_team_task');assert.equal(JSON.parse(f.calls.at(-1).arguments.delivery).commandsRun[0].evidence,'/saved/original.log');
});
test('registration-only rejection is corrected in the SAME attempt with a fresh report and no second test run',async()=>{
 const f=fixture();let reports=0;f.api.tools.mcp__team__team_leader=async input=>{f.calls.push(input);if(input.operation==='report_leader_team_task'){reports++;return {structuredContent:reports===1?{deliveryPreflight:{valid:false},correctionRequestId:'corrected-report',reviewBudgetConsumed:false}:f.receipt};}if(reports)return {structuredContent:{...f.prepared,mustReuse:true,executionArguments:null,reuseEvidence:{canReuse:true,requestId:'command-request',exitCode:0,logPath:f.prepared.logPath,commandId:'original',turnId:'turn'}}};return {structuredContent:f.prepared};};
 await f.run();assert.equal(f.values.get('leaderSubmission:attempt').phase,'correction-needed');f.delivery.acceptanceResults[0].evidence='Corrected factual citation on unchanged source';await f.run();assert.equal(f.commands.length,1);assert.equal(reports,2);assert.equal(f.calls.at(-1).arguments.requestId,'corrected-report');assert.deepEqual(f.values.get('teamStep'),f.receipt);
});
test('known failing verification recovers on changed inputs with a fresh bound command, preserving the failed log and history',async()=>{
 const f=fixture();f.api.tools.exec_command=async input=>{f.commands.push(input);return {exit_code:f.commands.length===1?1:0};};
 await f.run();assert.equal(f.values.get('leaderSubmission:attempt').phase,'verification-failed');
 f.api.tools.mcp__team__team_leader=async input=>{f.calls.push(input);if(input.operation==='report_leader_team_task')return {structuredContent:f.receipt};return {structuredContent:{...f.prepared,requestId:'fresh-command',logPath:'/saved/fresh.log',inputProof:{...f.prepared.inputProof,fingerprint:'changed'},...(input.arguments.refreshChangedInputs?{refreshedFrom:{source:'known-native-terminal-on-changed-inputs',requestId:'command-request',exitCode:1}}:{})}};};
 await f.run();assert.equal(f.commands.length,2);assert.equal(f.calls.findLast(c=>c.operation==='prepare_team_command').arguments.requestId,'fresh-command');
 const s=f.values.get('leaderSubmission:attempt');assert.deepEqual(s.commandHistory.map(c=>c.exitCode),[1,0]);assert.equal(s.commandHistory[0].logPath,'/saved/full.log');assert.equal(s.commands.length,1);assert.equal(JSON.parse(f.calls.at(-1).arguments.delivery).commandsRun[0].evidence,'/saved/fresh.log');
 await f.run();assert.equal(f.commands.length,2);
});
test('retry preserves successful unchanged earlier checks and never repeats them after a different failed check',async()=>{
 const f=fixture();f.config.verificationPreparation.push({operation:'prepare_team_command',arguments:{command:'python3 check-b.py',requestId:'request-b'}});let runB=0;
 f.api.tools.exec_command=async input=>{f.commands.push(input);return {exit_code:input.cmd==='check-b'&&++runB===1?1:0};};
 f.api.tools.mcp__team__team_leader=async input=>{f.calls.push(input);if(input.operation==='report_leader_team_task')return {structuredContent:f.receipt};const retry=input.arguments.refreshChangedInputs;if(input.arguments.command==='python3 -m unittest'&&retry)return {structuredContent:{...f.prepared,mustReuse:true,executionArguments:null,reuseEvidence:{canReuse:true,requestId:'command-request',exitCode:0,logPath:f.prepared.logPath}}};return {structuredContent:{...f.prepared,executionArguments:{cmd:input.arguments.command==='python3 check-b.py'?'check-b':'check-a'},requestId:input.arguments.command==='python3 check-b.py'?'fresh-b':input.arguments.requestId,...(retry?{refreshedFrom:{source:'known-native-terminal-on-changed-inputs'}}:{})}};};
 await f.run();await f.run();assert.deepEqual(f.commands.map(c=>c.cmd),['check-a','check-b','check-b']);assert.equal(f.calls.at(-1).operation,'report_leader_team_task');
});

test('three changed-input failures advance from the latest binding instead of returning to the first request',async()=>{
 const f=fixture();let attempt=0;const expected=['command-request','fresh-1','fresh-2','fresh-3'];f.api.tools.exec_command=async args=>{f.commands.push(args);return {exit_code:++attempt<4?1:0};};f.api.tools.mcp__team__team_leader=async input=>{f.calls.push(input);if(input.operation==='report_leader_team_task')return {structuredContent:f.receipt};const retry=input.arguments.refreshChangedInputs;if(retry){assert.equal(input.arguments.requestId,expected[attempt-1]);return {structuredContent:{...f.prepared,requestId:expected[attempt],logPath:'/saved/'+expected[attempt]+'.log',refreshedFrom:{source:'known-native-terminal-on-changed-inputs',requestId:expected[attempt-1]}}};}return {structuredContent:f.prepared};};for(let n=0;n<4;n++)await f.run();assert.equal(f.commands.length,4);assert.deepEqual(f.values.get('leaderSubmission:attempt').commandHistory.map(c=>c.requestId),expected);await f.run();assert.equal(f.commands.length,4);
});
test('a stale serialized Leader program cannot execute in the adopted new binding',async()=>{const f=fixture();f.config.turnId='old';f.values.set('leaderSubmissionEpoch:attempt','new');await f.run();assert.equal(f.commands.length,0);assert.equal(f.calls.length,0);assert.match(f.outputs.at(-1).reason,/older native Leader turn/);});
test('known prior failure with no executable binding remains correctable after real input changes',async()=>{
 const f=fixture();f.prepared.executionArguments=null;f.prepared.reuseEvidence={status:'failed',exitCode:1};await f.run();assert.equal(f.commands.length,0);assert.equal(f.values.get('leaderSubmission:attempt').phase,'verification-failed');f.prepared.executionArguments={cmd:'fresh after real correction'};f.prepared.refreshedFrom={source:'known-native-terminal-on-changed-inputs'};f.prepared.requestId='new-corrected';await f.run();assert.equal(f.commands.length,1);assert.equal(f.calls.at(-1).operation,'report_leader_team_task');
});
test('a real input change during report correction becomes stale validation rather than a permanently preparing transport',async()=>{
 const f=fixture();let reports=0;f.api.tools.mcp__team__team_leader=async input=>{f.calls.push(input);if(input.operation==='report_leader_team_task')return {structuredContent:++reports===1?{deliveryPreflight:{valid:false},correctionRequestId:'corrected'}:f.receipt};if(reports===1)return {structuredContent:{...f.prepared,inputProof:{reusable:true,currentMatchesSavedInputs:false}}};return {structuredContent:f.prepared};};await f.run();await f.run();assert.equal(f.commands.length,1);assert.equal(f.values.get('leaderSubmission:attempt').phase,'verification-stale');f.api.tools.mcp__team__team_leader=async input=>{f.calls.push(input);return {structuredContent:input.operation==='report_leader_team_task'?f.receipt:{...f.prepared,requestId:'changed-input',refreshedFrom:{source:'known-native-terminal-on-changed-inputs'}}};};await f.run();assert.equal(f.commands.length,2);assert.equal(f.calls.at(-1).operation,'report_leader_team_task');
});
