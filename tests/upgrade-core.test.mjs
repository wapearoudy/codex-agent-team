import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,readFile,mkdir,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {NativePublicFeed} from '../src/native-public.mjs';
import {TeamArchive} from '../src/team-archive.mjs';
import {createTeam,TeamStore,dispatchBlockers,validateTeam} from '../src/team.mjs';
import {DurableStore} from '../src/durable-store.mjs';
import {usageReport,assertBudget,compactHandoff,TeamProfiles} from '../src/team-policy.mjs';
import {taskQuery,exportTeam} from '../src/team-diagnostics.mjs';
import {queuePeerMessage,peerInbox,acknowledgePeerMessage,recordPeerDelivery} from '../src/team-peer-mailbox.mjs';
import {workflowActions} from '../src/team-workflow.mjs';
import {takeoverBoundary,recordRecoveryControl,recoveryPacket} from '../src/team-recovery.mjs';
import {TeamWorktrees} from '../src/team-worktrees.mjs';

const temp=()=>mkdtemp(join(tmpdir(),'agent-team-upgrade-'));
const event=(type,turn_id='turn',extra={})=>({timestamp:new Date().toISOString(),type:'event_msg',payload:{type,turn_id,...extra}});
function fixture(){return createTeam({projectId:'project',projectPath:process.cwd(),goal:'Upgrade the team protocol',maxParallel:2,plan:{members:[{id:'dev',role:'Dev',reason:'write',responsibility:'source',writeScopes:['src']},{id:'qa',role:'QA',reason:'review',responsibility:'test',writeScopes:[]}],tasks:[{id:'work',title:'Implementation',goal:'Implement feature',acceptance:'Actual tests pass',acceptanceCriteria:[{id:'AC1',description:'Keep full acceptance'}],memberId:'dev',priority:1,kind:'work',resources:[],dependencies:[]},{id:'review',title:'Independent review',memberId:'qa',goal:'Validate',acceptance:'Actual evidence',priority:1,kind:'review',reviewOfTaskId:'work',resources:[],dependencies:[{taskId:'work',when:'submitted'}]}]}});}
function active(){const t=fixture();t.mode='host-leader';t.leaderThreadId='leader';t.ownerId='owner';t.revision=1;t.members[0].agentThreadId='child-dev';t.members[1].agentThreadId='child-qa';t.tasks[0].status='running';t.tasks[0].attempts=[{id:'attempt',marker:'TEAM_WORKSPACE_ATTEMPT:fixture',agentThreadId:'child-dev',turnId:'turn',state:'running'}];return t;}

test('incremental feed exposes only current-child public events, supports split UTF8 and excludes reasoning',async()=>{
  const root=await temp(),path=join(root,'child.jsonl'),thread={id:'child',path},feed=new NativePublicFeed({sessionsRoot:root});
  await writeFile(path,JSON.stringify({type:'session_meta',payload:{id:'child'}})+'\n'+JSON.stringify(event('task_started'))+'\n'+JSON.stringify(event('agent_reasoning','turn',{text:'PRIVATE_REASONING'}))+'\n'+JSON.stringify(event('agent_message','old',{message:'OLD_OUTPUT'}))+'\n');
  const first=await feed.read(thread,'turn');assert.equal(first.events.length,1);
  const bytes=Buffer.from(JSON.stringify(event('agent_message','turn',{message:'中文进度'}))+'\n');
  await appendFile(path,bytes.subarray(0,bytes.length-5));assert.equal((await feed.read(thread,'turn',{cursor:first.cursor})).events.length,0);
  await appendFile(path,bytes.subarray(bytes.length-5));const live=await feed.read(thread,'turn',{cursor:first.cursor});assert.equal(live.events[0].text,'中文进度');assert.doesNotMatch(JSON.stringify(live),/PRIVATE|OLD_OUTPUT/);
  assert.equal((await feed.read(thread,'turn',{cursor:live.cursor})).events.length,0);
  await assert.rejects(()=>new NativePublicFeed({sessionsRoot:root}).read({id:'wrong',path},'turn'),/identity/);
});
test('public token deltas are attributed to exact turns without double-counting session totals',async()=>{
  const root=await temp(),path=join(root,'child.jsonl'),feed=new NativePublicFeed({sessionsRoot:root});
  const rows=[{type:'session_meta',payload:{id:'child'}},event('task_started','first'),event('token_count','first',{info:{total_token_usage:{total_tokens:120,input_tokens:100,output_tokens:20},last_token_usage:{total_tokens:120,input_tokens:100,output_tokens:20}}}),event('task_started'),event('token_count','turn',{info:{total_token_usage:{total_tokens:180,input_tokens:140,output_tokens:40}}})];
  await writeFile(path,rows.map(JSON.stringify).join('\n')+'\n');assert.equal((await feed.read({id:'child',path},'turn')).usage.totalTokens,60);
  assert.equal((await feed.read({id:'child',path},'first')).usage.totalTokens,120);
});
test('archive roundtrip retains duplicates, all old attempts and request IDs beyond old ceilings',async()=>{
  const root=await temp(),archive=new TeamArchive(root,{hotRows:3,segmentRows:100}),team={id:randomUUID(),ownerId:'owner',members:[{id:'same-member'}],tasks:Array.from({length:2200},(_,i)=>({id:'t'+i,attempts:[{id:'a'+i}]})),messages:Array.from({length:2100},(_,i)=>({requestId:'r'+i,text:'duplicate'})),checkpoints:Array.from({length:1100},(_,i)=>({requestId:'c'+i})),events:Array.from({length:600},()=>({at:'same',type:'duplicate'}))};
  const disk=await archive.compact(team);assert.ok(disk.tasks.length<=103);assert.ok(disk.messages.length<=103);assert.deepEqual(await archive.hydrate(disk),team);
  const count=(await readdir(join(root,team.id))).length;assert.deepEqual(await archive.compact(team),disk);assert.equal((await readdir(join(root,team.id))).length,count);
  const appended=structuredClone(team);appended.tasks.push({id:'last',attempts:[]});const extended=await archive.compact(appended);assert.deepEqual(extended.archiveManifest.segments,disk.archiveManifest.segments);assert.equal((await readdir(join(root,team.id))).length,count);
  const segment=disk.archiveManifest.segments[0];await writeFile(join(root,team.id,segment.hash+'.json'),'{}');await assert.rejects(()=>archive.hydrate(disk),/integrity/);
});
test('TeamStore commits compacted history, stale revision cannot mutate and corruption blocks updates',async()=>{
  const root=await temp(),store=new TeamStore(root),team=await store.create({projectId:'p',projectPath:root,goal:'Archive a fixed project team',plan:fixture(),maxParallel:2},'owner');
  const saved=await store.update(team.id,'owner',1,t=>{t.mode='host-leader';t.events.push(...Array.from({length:650},()=>({type:'same'})));});
  assert.equal((await store.get(team.id,'owner')).events.length,651);const raw=JSON.parse(await readFile(store.document(team.id).v2,'utf8'));assert.ok(raw.archiveManifest);
  await assert.rejects(()=>store.update(team.id,'owner',1,t=>{t.goal='wrong';}),/changed/);assert.equal((await store.get(team.id,'owner')).goal,team.goal);
  assert.equal(saved.team.events.length,651);
});
test('known and missing usage remain distinct, budgets block next dispatch without fake pricing',()=>{
  const t=active();t.policy={tokenLimit:100};const report=usageReport(t,[{attemptId:'attempt',usage:{totalTokens:120}}]);assert.equal(report.exhausted,true);assert.equal(report.members[0].totalTokens,120);assert.equal(report.cost,null);assert.throws(()=>assertBudget(t,[{attemptId:'attempt',usage:{totalTokens:120}}]),/exhausted/);
  t.policy.requireKnownUsage=true;assert.throws(()=>assertBudget(t,[]),/unavailable/);assert.equal(usageReport(t,[]).unknownAttempts,1);assert.equal(usageReport(t,[]).remaining,null);
});
test('a restored initial turn without a token baseline cannot inherit lifetime session usage',async()=>{
  const root=await temp(),path=join(root,'child.jsonl'),feed=new NativePublicFeed({sessionsRoot:root});
  await writeFile(path,[{type:'session_meta',payload:{id:'child'}},event('task_started'),event('token_count','turn',{info:{total_token_usage:{total_tokens:10000},last_token_usage:{total_tokens:30}}})].map(JSON.stringify).join('\n')+'\n');
  assert.equal((await feed.read({id:'child',path},'turn')).usage,null);
});
test('legacy upgrade fence survives failed commit and retry retains the exact original backup',async()=>{
  const root=await temp(),store=new TeamStore(root),t=active();
  const body=JSON.stringify(t,null,2);await mkdir(root,{recursive:true});await writeFile(store.path(t.id),body);
  await assert.rejects(()=>store.update(t.id,t.ownerId,t.revision,()=>{throw new Error('simulated crash before v2 commit');}),/simulated crash/);
  const fence=JSON.parse(await readFile(store.path(t.id),'utf8'));assert.equal(fence.requiresTeamWorkspaceVersion,'0.9.0');
  assert.equal(await readFile(store.archive.originalPath(t.id,fence.originalHash),'utf8'),body);
  assert.deepEqual(await store.get(t.id,t.ownerId),t);
  const oldWriter=new DurableStore(store.path(t.id),{},validateTeam);
  await assert.rejects(()=>oldWriter.transaction(x=>{x.goal='old writer';}),/unreadable/);
  await store.update(t.id,t.ownerId,t.revision,x=>{x.goal='new reader works';});
  assert.equal(JSON.parse(await readFile(store.path(t.id),'utf8')).originalHash,fence.originalHash);
  assert.equal((await store.get(t.id,t.ownerId)).goal,'new reader works');
  const results=await Promise.allSettled([store.update(t.id,t.ownerId,2,x=>{x.goal='first';}),store.update(t.id,t.ownerId,2,x=>{x.goal='second';})]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal((await store.get(t.id,t.ownerId)).revision,3);
});
test('a partial pre-existing migration backup cannot replace the complete legacy original',async()=>{
  const root=await temp(),store=new TeamStore(root),t=active(),body=JSON.stringify(t);
  await mkdir(root,{recursive:true});await writeFile(store.path(t.id),body);const backup=store.archive.originalPath(t.id,store.archive.hash(body));await mkdir(join(root,'archives',t.id),{recursive:true});await writeFile(backup,'{"partial":');
  await assert.rejects(()=>store.update(t.id,t.ownerId,1,x=>{x.goal='must not commit';}),/backup integrity/);
  assert.equal(await readFile(store.path(t.id),'utf8'),body);assert.deepEqual(await store.get(t.id,t.ownerId),t);
});
test('context reduction preserves all required fields and provides historical evidence references',()=>{
  const handoff={goal:'exact goal',context:'exact contract',acceptance:'full acceptance',acceptanceCriteria:[{id:'AC',description:'exact criterion'}],dependencies:[{taskId:'before',evidence:[{summary:'large '.repeat(10000),attemptId:'exact'}]}]};
  const reduced=compactHandoff(handoff,{contextChars:4000});for(const k of ['goal','context','acceptance','acceptanceCriteria'])assert.deepEqual(reduced[k],handoff[k]);assert.ok(JSON.stringify(reduced).length<4000);assert.equal(reduced.dependencies[0].evidence[0].reference.taskId,'before');
});
test('profiles persist explicit routing and policy without spawning members',async()=>{
  const profiles=new TeamProfiles(await temp()),plan=fixture();plan.members[0].route={model:'user-selected-model',reasoningEffort:'high'};
  await profiles.save('delivery',plan,{tokenLimit:50000});const loaded=await profiles.read('delivery');assert.equal(loaded.plan.members[0].route.model,'user-selected-model');assert.equal(loaded.policy.tokenLimit,50000);assert.equal((await profiles.read()).length,1);
});
test('peer mailbox enforces source attempt and recipient identity, deduplicates and never auto-sends',()=>{
  const t=active(),requestId=randomUUID(),args={senderMemberId:'dev',senderThreadId:'child-dev',attemptId:'attempt',toMemberId:'qa',text:'Review this contract',requestId};
  const m=queuePeerMessage(t,args);assert.equal(queuePeerMessage(t,args).id,m.id);assert.equal(t.peerMessages.length,1);assert.throws(()=>queuePeerMessage(t,{...args,text:'changed'}),/different/);assert.throws(()=>queuePeerMessage(t,{...args,senderThreadId:'intruder',requestId:randomUUID()}),/authenticated/);
  assert.equal(peerInbox(t,'child-qa').messages.length,1);assert.equal(peerInbox(t,'child-dev').messages.length,0);assert.throws(()=>acknowledgePeerMessage(t,{messageId:m.id,threadId:'child-dev',turnId:'turn'}),/recipient/);
  recordPeerDelivery(t,{messageId:m.id,status:'host-accepted',note:'actual native receipt'});assert.equal(m.status,'host-accepted');acknowledgePeerMessage(t,{messageId:m.id,threadId:'child-qa',turnId:'qa-turn'});assert.equal(m.status,'acknowledged');
  t.tasks[0].status='submitted';assert.equal(queuePeerMessage(t,args).id,m.id);assert.throws(()=>queuePeerMessage(t,{...args,requestId:randomUUID()}),/authenticated/);
});
test('workflow is bounded, reserves only conflict-free lanes and cannot accept review autonomously',()=>{
  const t=fixture();t.mode='host-leader';const w=workflowActions(t,[]);assert.equal(w.automaticAcceptance,false);assert.deepEqual(w.actions.find(a=>a.type==='claim-batch').taskIds,['work']);
  t.tasks[0].status='running';t.tasks[0].attempts=[{id:'a',state:'running'}];assert.equal(workflowActions(t,[{attemptId:'a',status:'completed'}]).actions[0].type,'settle');
  t.policy={maxAttempts:1};t.tasks[0].status='waiting';assert.ok(dispatchBlockers(t,t.tasks[0]).some(b=>b.code==='attempt-limit'));
  const many=fixture();many.tasks=Array.from({length:30},(_,i)=>({...many.tasks[1],id:'review'+i,status:'submitted',evidence:[],attempts:[]}));const bounded=workflowActions(many);assert.equal(bounded.actions.length,bounded.maxActions);assert.equal(bounded.hasMore,true);
});
test('recovery retains original native identity and refuses fictitious cross-Leader control',async()=>{
  const t=active();assert.equal(takeoverBoundary(t,'other').status,'blocked-by-host');assert.equal(takeoverBoundary(t,'other').canTransfer,false);
  recordRecoveryControl(t,{memberId:'dev',threadId:'child-dev',status:'unavailable',tool:'followup_task',note:'native handle unavailable'});assert.equal(t.dispatchPaused,true);
  const packet=await recoveryPacket(t,{inspect:async()=>{throw new Error('not available');}});assert.equal(packet.members[0].threadId,'child-dev');assert.equal(packet.startsModel,false);assert.equal(packet.members[0].status,'unknown');
});
test('history query keeps stable registration numbers and export includes full criteria',()=>{
  const t=fixture(),q=taskQuery(t,{query:'t2',limit:1});assert.equal(q.tasks[0].id,'review');assert.equal(q.tasks[0].number,2);assert.equal(taskQuery(t,{status:'accepted'}).total,0);
  assert.match(exportTeam(t).text,/AC1：Keep full acceptance/);assert.equal(JSON.parse(exportTeam(t,{format:'json'}).text).team.id,t.id);
  t.revision=1;const page=taskQuery(t,{limit:1});assert.equal(taskQuery(t,{limit:1,cursor:page.nextCursor}).tasks[0].id,'review');t.revision=2;assert.throws(()=>taskQuery(t,{limit:1,cursor:page.nextCursor}),/snapshot/);
});
test('real Git worktree candidate integration stays staged and dirty source is rejected',async()=>{
  const root=await temp(),repo=join(root,'repo');await mkdir(repo);const exec=promisify(execFile),git=async(cwd,args)=>(await exec('git',args,{cwd,windowsHide:true})).stdout;
  await git(repo,['init']);await git(repo,['config','core.autocrlf','false']);await git(repo,['config','user.name','Fixture']);await git(repo,['config','user.email','fixture@example.invalid']);await mkdir(join(repo,'src'));await writeFile(join(repo,'src','a.txt'),'base\n');await git(repo,['add','.']);await git(repo,['commit','-m','fixture base']);
  const t=active();t.projectPath=repo;t.tasks[0].status='accepted';t.tasks[1].status='accepted';const worktrees=new TeamWorktrees(join(root,'worktrees')),w=await worktrees.prepare(t,'dev');t.members[0].workspace=w;
  const unrecorded=structuredClone(t);delete unrecorded.members[0].workspace;assert.deepEqual(await worktrees.prepare(unrecorded,'dev'),w);
  await writeFile(join(w.path,'src','a.txt'),'candidate\n');await git(w.path,['add','.']);await git(w.path,['commit','-m','candidate']);const accepted=await worktrees.inspect(t,'dev');t.tasks[0].attempts[0].candidate={head:accepted.head,path:w.path};
  const integrated=await worktrees.integrate(t,'dev');assert.equal(integrated.status,'staged-for-leader-validation');assert.equal(await readFile(join(repo,'src','a.txt'),'utf8'),'candidate\n');assert.match(await git(repo,['status','--porcelain']),/M/);
  assert.deepEqual(await worktrees.integrate(t,'dev'),integrated);
  await writeFile(join(w.path,'src','a.txt'),'unreviewed\n');await git(w.path,['add','.']);await git(w.path,['commit','-m','unreviewed change']);await assert.rejects(()=>worktrees.integrate(t,'dev'),/accepted submission/);assert.equal(await readFile(join(repo,'src','a.txt'),'utf8'),'candidate\n');
  await assert.rejects(()=>worktrees.prepare(t,'dev2'),/writing/);
});
