import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {UsageWindow} from '../src/usage-window.mjs';
import {NativePublicFeed} from '../src/native-public.mjs';
import {NativeMembers} from '../src/native-members.mjs';
import {usageReport,assertBudget} from '../src/team-policy.mjs';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {teamResponse,advancementResponse,detailToken} from '../src/team-responses.mjs';
import {COORDINATION_MAX_BYTES} from '../src/team-coordination-response.mjs';
import {largeDisplayFixture} from './fixtures/large-display.mjs';
import {evidencePage} from '../src/team-evidence.mjs';

const time=n=>`2026-10-10T03:${String(n).padStart(2,'0')}:00.000Z`;
const u=n=>({totalTokens:n,inputTokens:n-10,cachedInputTokens:Math.max(0,n-20),outputTokens:10});
const event=(id,total,at,last=total)=>JSON.stringify({type:'event_msg',timestamp:at,payload:{type:'token_count',turn_id:'turn',info:{total_token_usage:{total_tokens:total,input_tokens:total-10,cached_input_tokens:Math.max(0,total-20),output_tokens:10},last_token_usage:{total_tokens:last}}}})+'\n';

test('time-window accounting deduplicates cumulative samples, excludes old work and keeps missing baselines unknown',()=>{
 const w=new UsageWindow();w.record(time(1),u(100),u(100));w.record(time(1),u(100),u(100));w.record(time(20),u(160),u(60));w.record(time(30),u(200),u(40));
 const report=w.read({since:time(10),until:time(25)});assert.equal(report.usage.totalTokens,60);assert.equal(report.usage.inputTokens,60);assert.equal(report.sampleCount,1);assert.equal(report.complete,true);assert.equal(w.read({since:time(40)}).usage.totalTokens,0);
 const restored=new UsageWindow();restored.record(time(20),u(1000),u(100));assert.equal(restored.read({since:time(10)}).complete,false);assert.equal(restored.read({since:time(10)}).unknownSamples,1);restored.record(time(30),u(1050),u(50));assert.equal(restored.read({since:time(25)}).usage.totalTokens,50);assert.equal(restored.read({since:time(25)}).complete,true);
 const bounded=new UsageWindow({maxSamples:1});bounded.record(time(1),u(10),u(10));bounded.record(time(20),u(20),u(10));assert.equal(bounded.read({since:time(1)}).complete,false);assert.equal(bounded.read({since:time(10)}).complete,true);assert.equal(new UsageWindow().read({since:time(1)}).usage,null);
});

async function nativeFixture(t){
 const root=await mkdtemp(join(tmpdir(),'native-usage-')),cwd=join(root,'project');await mkdir(cwd);const records=new Map(),calls=[],measured=[];
 const seed=async(id,createdAt=Date.parse(time(11))/1000,extra={})=>{const path=join(root,id+'.jsonl');await writeFile(path,JSON.stringify({type:'session_meta',payload:{id}})+'\n');records.set(id,{id,cwd,path,parentThreadId:'leader',createdAt,...extra});return path;};
 const leader=await seed('leader',0,{parentThreadId:null,turns:[{items:['member','fallback','old','foreign'].map(agentThreadId=>({type:'subAgentActivity',agentThreadId}))}]});await appendFile(leader,event('leader',100,time(1))+event('leader',150,time(20),50));
 await appendFile(await seed('member'),event('member',50,time(20)));await appendFile(await seed('fallback'),event('fallback',70,time(20)));await seed('old',0);await seed('foreign',Date.parse(time(11))/1000,{parentThreadId:'another-leader'});
 const feed=new NativePublicFeed({sessionsRoot:root}),measure=feed.usageWindow.bind(feed);feed.usageWindow=async(thread,window)=>{measured.push(thread.id);return measure(thread,window);};
 const observer=new NativeMembers({publicFeed:feed,rpcFactory:()=>({async connect(){},async close(){},async call(method,args){assert.equal(method,'thread/read');calls.push(args);if(args.includeTurns&&args.threadId!=='leader')throw new Error('Do not load child transcripts for accounting');return {thread:structuredClone(records.get(args.threadId))};}})});
 t.after(async()=>{await observer.close();await rm(root,{recursive:true,force:true});});
 const team={id:'team',createdAt:time(10),leaderThreadId:'leader',projectPath:cwd,members:[{id:'dev'}],tasks:[{id:'work',memberId:'dev',attempts:[{id:'one',agentThreadId:'member',observation:{usage:{totalTokens:50}}},{id:'two',agentThreadId:'member',observation:{usage:{totalTokens:50}}}]}],policy:{tokenLimit:200,requireKnownUsage:true}};
 return {root,cwd,team,leader,records,calls,measured,observer};
}

test('Leader and eligible fallback usage is counted once without reading foreign or historical child content',async t=>{
 const f=await nativeFixture(t),accounting=await f.observer.teamUsage(f.team),report=usageReport(f.team,[],accounting);
 assert.equal(report.totalTokens,170);assert.equal(report.leaderTokens,50);assert.equal(report.memberTokens,50);assert.equal(report.unregisteredNativeTokens,70);assert.equal(report.unregisteredNativeCount,1);assert.equal(report.attributedTokens,100);assert.equal(report.complete,true);assert.equal(report.inferredContextsAreExecutionAuthority,false);
 assert.deepEqual(f.measured,['leader','member','fallback']);assert.ok(f.calls.filter(c=>c.includeTurns).every(c=>c.threadId==='leader'));const before=f.calls.length;assert.equal(await f.observer.teamUsage(f.team),accounting);assert.equal(f.calls.length,before);
 await appendFile(f.leader,event('leader',250,time(30),100));const fresh=await f.observer.teamUsage(f.team,{fresh:true});assert.equal(usageReport(f.team,[],fresh).totalTokens,270);assert.throws(()=>assertBudget(f.team,[],fresh),/exhausted/);
});

test('unavailable Leader accounting is not treated as zero or as a verified budget',async t=>{
 const f=await nativeFixture(t);await writeFile(f.leader,JSON.stringify({type:'session_meta',payload:{id:'leader'}})+'\n');const accounting=await f.observer.teamUsage(f.team),report=usageReport(f.team,[],accounting);assert.equal(report.complete,false);assert.equal(report.remaining,null);assert.equal(report.unverifiable,true);assert.throws(()=>assertBudget(f.team,[],accounting),/unavailable/);
});

test('a delayed display read cannot overwrite newer fresh budget accounting',async t=>{
 const f=await nativeFixture(t),original=f.observer.publicFeed.usageWindow.bind(f.observer.publicFeed);let release,entered,held=false;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 f.observer.publicFeed.usageWindow=async(thread,window)=>{const result=await original(thread,window);if(thread.id==='leader'&&!held){held=true;entered();await gate;}return result;};
 const display=f.observer.teamUsage(f.team);await started;await appendFile(f.leader,event('leader',250,time(30),100));const fresh=await f.observer.teamUsage(f.team,{fresh:true});assert.equal(usageReport(f.team,[],fresh).totalTokens,270);release();assert.equal(usageReport(f.team,[],await display).totalTokens,170);assert.equal(f.observer.cachedTeamUsage(f.team),fresh);
});

test('object file-change events cannot abort accounting; identity rejection cannot skip into a later retry',async t=>{
 const f=await nativeFixture(t);await appendFile(f.leader,JSON.stringify({type:'event_msg',payload:{type:'item_completed',turn_id:'turn',thread_id:'leader',item:{type:'FileChange',changes:{'src/work.mjs':{type:'update'}}}}})+'\n'+event('leader',200,time(25),50));
 const data=await f.observer.teamUsage(f.team,{fresh:true});assert.equal(data.contexts[0].usage.totalTokens,100);assert.equal(data.contexts[0].complete,true);
 const path=join(f.root,'corrupt.jsonl');await writeFile(path,JSON.stringify({type:'session_meta',payload:{id:'foreign'}})+'\n'+event('corrupt',500,time(20)));const feed=new NativePublicFeed({sessionsRoot:f.root});for(let n=0;n<2;n++)await assert.rejects(()=>feed.usageWindow({id:'corrupt',path},{since:time(10)}),/identity mismatch/);
});

test('oversized non-public rows are streamed past without losing later counters or retaining their body',async t=>{
 const f=await nativeFixture(t);await appendFile(f.leader,JSON.stringify({type:'response_item',payload:{type:'function_call_output',output:'x'.repeat(9*1024*1024)}})+'\n'+event('leader',250,time(30),100));
 const result=await f.observer.teamUsage(f.team,{fresh:true}),leader=result.contexts[0];assert.equal(leader.usage.totalTokens,150);assert.equal(leader.complete,true);assert.equal(leader.skippedNonPublicRows,1);assert.ok([...f.observer.publicFeed.files.values()].every(file=>file.pending.length<8*1024*1024));assert.ok(JSON.stringify(result).length<3000);
});

test('large public output truncates activity only; unknown oversized accounting stays incomplete',async t=>{
 const f=await nativeFixture(t),feed=f.observer.publicFeed;
 await appendFile(f.leader,JSON.stringify({type:'event_msg',payload:{type:'item_completed',turn_id:'turn',item:{type:'CommandExecution',aggregatedOutput:'x'.repeat(9*1024*1024)}}})+'\n'+event('leader',250,time(30),100));
 const result=await f.observer.teamUsage(f.team,{fresh:true}),leader=result.contexts[0];assert.equal(leader.usage.totalTokens,150);assert.equal(leader.complete,true);assert.equal(leader.skippedPublicRows,1);assert.equal((await feed.read(f.records.get('leader'),'turn')).truncated,true);
 await appendFile(f.leader,JSON.stringify({type:'event_msg',payload:{type:'token_count',padding:'x'.repeat(9*1024*1024)}})+'\n');
 assert.equal((await f.observer.teamUsage(f.team,{fresh:true})).contexts[0].complete,false);
});

test('claim checks fresh complete accounting and rejects exhausted budget before reserving or spawning',async t=>{
 const root=await mkdtemp(join(tmpdir(),'budget-fresh-')),calls=[],observer={async inspect(){throw new Error('No member is launched');},async teamUsage(team,opts){calls.push(opts);return {source:'host-observed-team-contexts',complete:true,discoveryComplete:true,contexts:[{kind:'leader',threadId:'leader',usage:{totalTokens:250},complete:true},{kind:'unregistered-native',threadId:'fallback',usage:{totalTokens:50},complete:true}]};},cachedTeamUsage(){return null;}};
 const engine=new LeaderEngine({root,observer});t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 const team=await engine.planOnce('owner',{threadId:'leader',cwd:root},{goal:'Deliver without exceeding the agreed budget',execute:true,memberStartup:'on-demand',policy:{tokenLimit:200},plan:{members:[{id:'dev',role:'Dev',responsibility:'Implement',reason:'Delivery',writeScopes:[]},{id:'qa',role:'QA',responsibility:'Review',reason:'Independence',writeScopes:[]}],tasks:[{id:'work',title:'Implement',goal:'Deliver',acceptance:'Verify',memberId:'dev',kind:'work',dependencies:[]},{id:'review',title:'Review',goal:'Verify',acceptance:'Pass',memberId:'qa',kind:'review',reviewOfTaskId:'work',dependencies:[{taskId:'work',when:'submitted'}]}]}});
 await assert.rejects(()=>engine.claim('owner',team.id,team.revision,'work'),/exhausted/);assert.deepEqual(calls,[{fresh:true}]);assert.deepEqual(await engine.native('owner',team.id),team);
 const read=await engine.read('owner',team.id);assert.equal(read.workflow.budgetBlocked,true);assert.ok(!read.workflow.actions.some(a=>a.type==='claim-batch'));
});

test('terminal waits observe only active attempts and never enumerate Leader accounting or produce historical payloads',async t=>{
 const root=await mkdtemp(join(tmpdir(),'terminal-only-')),inspections=[];
 const observer={async inspect(leader,cwd,thread,marker){inspections.push(thread);return {threadId:thread,turnId:'turn',status:'completed',outputs:[{text:'x'.repeat(20000)}]};},async teamUsage(){throw new Error('Waiting must not enumerate accounting');}};
 const engine=new LeaderEngine({root,observer});t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 engine.native=async()=>({revision:4,leaderThreadId:'leader',projectPath:root,tasks:[{id:'done',status:'accepted',attempts:[{id:'old',agentThreadId:'old-child',observation:{outputs:[{text:'Historical delivery'}]}}]},{id:'active',status:'running',attempts:[{id:'current',agentThreadId:'child',turnId:'turn',marker:'MARK'}]}]});
 const result=await engine.terminalSnapshot('owner','team');assert.deepEqual(inspections,['child']);assert.deepEqual(result,{team:{revision:4},workflow:{actions:[{type:'settle',taskId:'active',attemptId:'current',observedStatus:'completed'}]}});assert.ok(JSON.stringify(result).length<300);
});

test('coordination cursors ignore logs and usage ticks but catch stop, terminal, new attempts and inbox changes',()=>{
 const data=largeDisplayFixture();data.team.leaderThreadId='leader';data.workflow={stage:'observe',actions:[]};data.usage={totalTokens:100};const first=teamResponse(data,'coordination');assert.ok(Buffer.byteLength(JSON.stringify(first))<COORDINATION_MAX_BYTES);assert.equal(first.runs,undefined);assert.equal(first.team,undefined);assert.equal(first.detailToken,undefined);
 const changed=structuredClone(data);changed.runs[0].observedAt='2030-01-01T00:00:00Z';changed.runs[0].commands[0].output+='Updated long log';changed.usage.totalTokens=200;assert.equal(teamResponse(changed,'coordination','team-summary',{cursor:first.cursor}).kind,'team-unchanged');assert.ok(JSON.stringify(teamResponse(changed,'coordination','team-summary',{cursor:first.cursor})).length<350);
 const tick=structuredClone(data);tick.team.revision++;assert.equal(teamResponse(tick,'coordination','team-summary',{cursor:first.cursor}).kind,'team-unchanged');
 for(const mutate of [d=>d.team.goal='Changed approved goal',d=>d.runs.at(-1).observationIssue={kind:'verification-failed',at:'2030-01-01'},d=>d.team.executionControl={status:'stopping'},d=>d.runs.at(-1).status='completed',d=>d.runs.at(-1).turnId='new',d=>d.team.peerMessages=[{id:'message',recipientThreadId:'leader',status:'queued'}]]){const next=structuredClone(data);mutate(next);assert.notEqual(teamResponse(next,'coordination','team-summary',{cursor:first.cursor}).kind,'team-unchanged');}
 assert.equal(teamResponse({...data,team:{...data.team,peerMessages:[{id:'m',recipientThreadId:'leader',status:'queued'}]}},'coordination').inbox.readRequired,true);
 assert.equal(teamResponse(data,'full').runs[0].commands[0].output.length,data.runs[0].commands[0].output.length);
});

test('selected evidence pages reconstruct exact public results without retransmitting unrelated logs or mixing revisions',()=>{
 const text='独立验证结果\n'.repeat(1500),command='verify '+ 'x'.repeat(1000),output='Long command output\n'.repeat(1000),team={id:'team',revision:1,tasks:[{id:'work',contractRevision:2,attempts:[{id:'attempt',turnId:'turn',observation:{outputs:[{text}],commands:[{command,status:'completed',exitCode:0,output}]}}],evidence:[]},{id:'unrelated',attempts:[{id:'other',observation:{outputs:[{text:'UNRELATED PRIVATE TASK'}]}}]}]};
 const before=structuredClone(team),first=evidencePage(team,{taskId:'work'});assert.equal(first.hasMore,true);assert.equal(first.text.length,4000);assert.equal(first.text.includes('UNRELATED PRIVATE TASK'),false);
 let body=first.text,page=first;while(page.hasMore){team.revision++;page=evidencePage(team,{taskId:'work',offset:page.nextOffset,cursor:page.cursor});body+=page.text;}assert.equal(body,text);assert.deepEqual(team.tasks,before.tasks);
 const rows=evidencePage(team,{taskId:'work',section:'commands'});assert.equal(rows.commands[0].exitCode,0);assert.equal(rows.commands[0].commandTruncated,true);assert.ok(JSON.stringify(rows).length<2000);assert.equal(rows.commands[0].output,undefined);
 assert.equal(evidencePage(team,{taskId:'work',section:'command',commandIndex:0,limit:2000}).text,command);assert.equal(evidencePage(team,{taskId:'work',section:'command-output',commandIndex:0}).text,output.slice(0,4000));
 team.tasks[0].attempts[0].observation.outputs[0].text+='Updated result';assert.throws(()=>evidencePage(team,{taskId:'work',offset:first.nextOffset,cursor:first.cursor}),/different native results/);assert.throws(()=>evidencePage(team,{taskId:'work',limit:8001}),/Invalid/);
});


test('one advancement returns bounded changes and complete dispatch packets without historical logs',()=>{
 const data=largeDisplayFixture();data.workflow={stage:'execute',actions:[{type:'claim-batch',taskIds:['next']}]};
 data.advancement={fromRevision:1,toRevision:2,changes:[{taskId:'work',status:'accepted',acceptedBy:'independent-reviewer'}],readAgainRequired:false};
 data.dispatches=[{taskId:'next',prompt:'Entire contract and all acceptance criteria',spawnOptions:{fork_turns:'none'},attemptId:'new'}];
 const reply=advancementResponse(data);assert.equal(reply.kind,'team-advancement');assert.deepEqual(reply.dispatches,data.dispatches);assert.deepEqual(reply.advancement,data.advancement);assert.equal(reply.team,undefined);assert.equal(reply.runs,undefined);assert.ok(Buffer.byteLength(JSON.stringify(reply))<2500);
 assert.equal(advancementResponse(data,'summary').kind,'team-update');assert.equal(data.runs[0].commands[0].output,'中文 command output '.repeat(1000));
});

test('unregistered contexts produce bounded reconciliation hints, never a task status or inferred acceptance',()=>{
 const data=largeDisplayFixture();data.workflow={stage:'execute',actions:[{type:'claim-batch',taskIds:['task5']}]};
 data.usage={totalTokens:200,unregisteredNativeCount:12,contexts:Array.from({length:12},(_,i)=>({threadId:'fallback-'+i,kind:'unregistered-native',totalTokens:10}))};
 const before=structuredClone(data.team),reply=teamResponse(data,'coordination');assert.equal(reply.registrationGap.count,12);assert.equal(reply.registrationGap.threadIds.length,8);assert.equal(reply.registrationGap.hasMore,true);assert.equal(reply.registrationGap.executionAuthority,false);assert.equal(reply.registrationGap.registrationTool,'register_team_native_attempts');assert.ok(JSON.stringify(reply).length<6000);
 assert.deepEqual(teamResponse(data,'state').registrationGap,reply.registrationGap);assert.deepEqual(teamResponse(data,'panel').registrationGap,reply.registrationGap);assert.deepEqual(data.team,before);
 const next=structuredClone(data);next.usage.contexts[0].threadId='replacement';assert.notEqual(teamResponse(next,'coordination','team-summary',{cursor:reply.cursor}).kind,'team-unchanged');
 next.usage.unregisteredNativeCount=0;assert.equal(teamResponse(next,'state').registrationGap,null);
});

test('roster initialization contexts are counted as members and invalidate usage discovery cache on binding',async t=>{
 const f=await nativeFixture(t),old=await f.observer.teamUsage(f.team);assert.equal(old.contexts.find(c=>c.threadId==='fallback').kind,'unregistered-native');
 f.team.members.push({id:'qa',agentThreadId:'fallback',rosterVerified:true});const data=await f.observer.teamUsage(f.team);assert.notEqual(data,old);const report=usageReport(f.team,[],data);assert.equal(report.unregisteredNativeCount,0);assert.equal(report.memberTokens,120);assert.equal(report.totalTokens,170);
});

test('cache breakdown remains unknown for missing, inconsistent or incomplete counters; budget retains all processing',()=>{
 const team={members:[],tasks:[],policy:{tokenLimit:120}};
 const accounting={complete:true,discoveryComplete:true,contexts:[{kind:'leader',threadId:'leader',complete:true,usage:{totalTokens:150,inputTokens:140,cachedInputTokens:100,outputTokens:10}}]};
 const report=usageReport(team,[],accounting);assert.equal(report.uncachedInputTokens,40);assert.equal(report.cacheRatio,100/140);assert.equal(report.exhausted,true);assert.equal(report.totalTokens,150);
 for(const mutate of [a=>delete a.contexts[0].usage.cachedInputTokens,a=>a.contexts[0].usage.cachedInputTokens=200,a=>a.contexts[0].complete=false,a=>a.discoveryComplete=false]){const a=structuredClone(accounting);mutate(a);assert.equal(usageReport(team,[],a).uncachedInputTokens,null);assert.equal(usageReport(team,[],a).cacheRatio,null);}
});

test('panel evidence tokens ignore historical logs and activity but detect same-length current evidence changes',()=>{
 const data=largeDisplayFixture(),token=detailToken(data);data.runs[0].commands[0].output='historical change';data.runs.at(-1).usage={totalTokens:400};data.runs.at(-1).progress=[{text:'New activity'}];assert.equal(detailToken(data),token);
 const current=data.runs.at(-1);current.commands[0].output=current.commands[0].output.replace('中文','变化');assert.notEqual(detailToken(data),token);
 const team={id:'team',tasks:[{id:'work',contractRevision:1,attempts:[{id:'a',turnId:'turn',observation:{commands:[{command:'check',status:'completed',exitCode:0,output:'PASS'}]}}]}]},list=evidencePage(team,{taskId:'work',section:'commands'});team.tasks[0].attempts[0].observation.commands[0].output='FAIL';assert.throws(()=>evidencePage(team,{taskId:'work',section:'commands',cursor:list.cursor}),/different native results/);
});
