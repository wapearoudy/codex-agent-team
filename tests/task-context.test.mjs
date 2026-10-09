import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {TeamNavigation} from '../src/team-navigation.mjs';
import {memberClaimRequest,assertMember,memberWork} from '../src/member-work.mjs';
import {validateTeam} from '../src/team.mjs';
import {boundedDispatchPrompt} from '../src/task-context.mjs';
import {TeamArchive as LegacyArchive} from './fixtures/legacy-archive-v011.mjs';
import {NativeMembers} from '../src/native-members.mjs';
import {TeamArchive} from '../src/team-archive.mjs';

const role=(id,writeScopes=[])=>({id,role:id,responsibility:'Scoped execution',reason:'Independent responsibility',writeScopes});
const work=(id,dependencies=[])=>({id,title:'Work '+id,goal:'Implement '+id,acceptance:'Verified '+id,acceptanceCriteria:[{id:'criterion-'+id,description:'Preserve the exact requirement for '+id}],memberId:'dev',kind:'work',dependencies});
const review=id=>({id:'review-'+id,title:'Review '+id,goal:'Independently check '+id,acceptance:'Evidence checked',memberId:'qa',kind:'review',reviewOfTaskId:id,dependencies:[{taskId:id,when:'submitted'}]});
async function fixture({contextChars=24000}={}){
  const root=await mkdtemp(join(tmpdir(),'task-context-')),runs=new Map(),usageCalls=[];
  const observer={async inspect(parent,cwd,thread,marker,options={}){const r=runs.get(marker);if(!r||r.threadId!==thread)throw new Error('No verified native execution');if(options.requireIdle&&r.latestActive)throw new Error('Latest native turn is active');return structuredClone({...r,parentThreadId:parent});},async historicalUsage(parent,cwd,thread,turns){usageCalls.push(thread);return turns.map(turnId=>({turnId,usage:{totalTokens:100,inputTokens:80,outputTokens:20,cachedInputTokens:0}}));}};
  const engine=new LeaderEngine({root,observer}),team=await engine.planOnce('owner',{cwd:root,threadId:'leader'},{goal:'Implement independently reviewed scoped work',initializeMembers:true,memberStartup:'on-demand',execute:true,plan:{members:[role('dev',['src']),role('qa')],tasks:[work('a'),review('a'),work('b',[{taskId:'a',when:'submitted'}]),review('b')]},policy:{contextChars}});
  const saved=()=>engine.native('owner',team.id),claim=async(id='a')=>{const t=await saved();return engine.claim('owner',team.id,t.revision,id);};
  function seed(dispatch,thread,status='completed',extra={}){runs.set(dispatch.marker,{threadId:thread,agentPath:'/root/'+dispatch.taskName,turnId:'turn-'+dispatch.attemptId,status,outputs:[{text:dispatch.marker+'\nCompleted '+dispatch.taskId}],commands:[],usage:{totalTokens:100,inputTokens:80,outputTokens:20,cachedInputTokens:0},...extra});}
  async function complete(c,thread){seed(c.dispatch,thread);let t=await saved();const bound=await engine.bind('owner',team.id,t.revision,c.dispatch.taskId,c.dispatch.attemptId,thread);return engine.settle('owner',team.id,bound.team.revision,c.dispatch.taskId,c.dispatch.attemptId);}
  return {root,engine,team,runs,observer,usageCalls,saved,claim,seed,complete};
}

test('completed task history is never reused for another task; the role, workspace and historical evidence survive restart',async()=>{
  const f=await fixture(),first=await f.claim();await f.complete(first,'native-a');const before=await f.saved();
  await f.engine.store.update(f.team.id,'owner',before.revision,t=>{t.members[0].workspace={mode:'git-worktree',path:f.root+'/worktree'};t.tasks[0].evidence[0].summary='UNNECESSARY_LOG_'.repeat(6000);});
  const next=await f.claim('b');assert.equal(next.dispatch.action,'spawn-native-member');assert.equal(next.dispatch.existingThreadId,null);assert.equal(next.dispatch.spawnOptions.fork_turns,'none');assert.equal(next.dispatch.contextIsolation.generation,2);assert.match(next.dispatch.taskName,/_ctx_2_[a-f0-9]{32}$/);assert.ok(next.dispatch.taskName.length<=64);assert.notEqual(first.dispatch.taskName,next.dispatch.taskName);assert.equal(next.dispatch.workspace.path,f.root+'/worktree');
  assert.equal(next.team.members[0].id,'dev');assert.equal(next.team.contextHistory[0].threadId,'native-a');assert.equal(next.team.tasks[0].attempts[0].agentThreadId,'native-a');assert.equal(next.team.tasks[0].status,'submitted');assert.equal(next.team.tasks[0].evidence[0].summary.length,96000);
  assert.ok(next.dispatch.prompt.length<=24000);assert.equal(next.dispatch.contextBudget.chars,next.dispatch.prompt.length);assert.ok(next.dispatch.prompt.includes('read_team_context'));assert.ok(!next.dispatch.prompt.includes('UNNECESSARY_LOG_'.repeat(1000)));assert.ok(next.dispatch.prompt.includes('Preserve the exact requirement for b'));
  const restarted=new LeaderEngine({root:f.root,observer:f.observer}),replay=await restarted.claim('owner',f.team.id,next.team.revision,'b');assert.equal(replay.dispatch.attemptId,next.dispatch.attemptId);assert.equal(replay.dispatch.taskName,next.dispatch.taskName);assert.equal(replay.team.contextHistory.length,1);
  f.seed(next.dispatch,'native-a');await assert.rejects(()=>restarted.bind('owner',f.team.id,replay.team.revision,'b',next.dispatch.attemptId,'native-a'),/Retired/);
  f.seed(next.dispatch,'native-b');const bound=await restarted.bind('owner',f.team.id,replay.team.revision,'b',next.dispatch.attemptId,'native-b');assert.equal(bound.team.members[0].agentThreadId,'native-b');assert.equal(bound.team.members[0].contextGeneration,2);assert.equal(validateTeam(bound.team),true);
  assert.throws(()=>assertMember(bound.team,{cwd:f.root,threadId:'native-a',parentThreadId:'leader'}),/authenticated/);
  assert.throws(()=>validateTeam({...bound.team,contextHistory:[]}),/ownership|generation|native context/);
});

test('uncertain or currently active native execution blocks rotation without changing reservations or history',async()=>{
  const f=await fixture(),first=await f.claim();await f.complete(first,'native-a');const before=await f.saved(),run=f.runs.get(first.dispatch.marker);
  for(const change of [{status:'unknown'},{latestActive:true}]){f.runs.set(first.dispatch.marker,{...run,...change});await assert.rejects(()=>f.claim('b'),/terminal|active/);assert.deepEqual(await f.saved(),before);}
  f.runs.set(first.dispatch.marker,run);const next=await f.claim('b');f.seed(next.dispatch,'native-b','starting',{turnId:null});await f.engine.bind('owner',f.team.id,next.team.revision,'b',next.dispatch.attemptId,'native-b');const pending=await f.saved();await assert.rejects(()=>f.claim('b'),/not ready/);assert.deepEqual(await f.saved(),pending);assert.equal(pending.contextHistory.length,1);
});

test('a completed member cannot self-claim new work in its old context',async()=>{
  const f=await fixture(),first=await f.claim();await f.complete(first,'native-a');const team=await f.saved(),context={cwd:f.root,threadId:'native-a',parentThreadId:'leader'};
  assert.throws(()=>memberClaimRequest(team,context,{taskId:'b',requestId:randomUUID()}),/clean execution/);const work=memberWork(team,context);assert.equal(work.tasks.find(t=>t.taskId==='b').ready,false);assert.ok(work.tasks.find(t=>t.taskId==='b').blockers.some(b=>b.code==='task-context-isolation'));assert.deepEqual(await f.saved(),team);
});

test('historical navigation and token accounting follow each recorded native context, including retired ones',async()=>{
  const f=await fixture(),first=await f.claim();await f.complete(first,'native-a');const next=await f.claim('b');await f.complete(next,'native-b');
  const nav=new TeamNavigation({root:f.root,store:f.engine.store,observer:f.observer});const destination=await nav.request('owner',{cwd:f.root,threadId:'leader'},{teamId:f.team.id,memberId:'dev',taskId:'a',attemptId:first.dispatch.attemptId,requestId:randomUUID()});assert.equal(destination.request.target.threadId,'native-a');
  const report=await f.engine.usage('owner',f.team.id,{refreshHistorical:true});assert.equal(report.totalTokens,200);assert.deepEqual(f.usageCalls.sort(),['native-a','native-b']);
});

test('complete prompt overflow rolls back the entire batch and does not erase a previous context',async()=>{
  const f=await fixture(),first=await f.claim();await f.complete(first,'native-a');let t=await f.saved();await f.engine.store.update(f.team.id,'owner',t.revision,t=>{t.tasks.find(t=>t.id==='b').acceptance='MUST_KEEP_'.repeat(5000);for(const m of t.members)m.writeScopes=[];});t=await f.saved();
  await assert.rejects(()=>f.engine.claimMany('owner',t.id,t.revision,['review-a','b']),/Complete dispatch prompt exceeds/);assert.deepEqual(await f.saved(),t);assert.equal(t.contextHistory,undefined);assert.equal(t.tasks.find(t=>t.id==='review-a').attempts.length,0);
});

test('dependency and checkpoint history is reduced to retrieval references under a complete prompt budget',()=>{
  const handoff={taskId:'next',goal:'Required goal',acceptance:'Required acceptance',dependencies:[{taskId:'old',attemptId:'old-attempt',status:'accepted',candidate:{revision:'immutable'},evidence:Array.from({length:40},()=>({summary:'LOG'.repeat(20000),attemptId:'old-attempt',source:'native'}))}],checkpoint:{id:'checkpoint',taskId:'next',summary:'HISTORY'.repeat(10000)}};
  const render=h=>'Required instructions '+h.goal+' '+h.acceptance+'\n'+JSON.stringify(h),packet=boundedDispatchPrompt(render,handoff,4000);assert.ok(packet.prompt.length<=4000);assert.equal(packet.contextBudget.chars,packet.prompt.length);assert.ok(packet.prompt.includes('Required acceptance'));assert.ok(packet.prompt.includes('immutable'));assert.ok(packet.prompt.includes('read_team_context'));assert.equal(handoff.dependencies[0].evidence.length,40);
});

test('new isolation records are rejected by legacy readers and archives preserve all context generations',async()=>{
  const f=await fixture(),first=await f.claim();await f.complete(first,'native-a');await f.claim('b');const t=await f.saved();assert.equal(t.requiresTeamWorkspaceVersion,'0.14.0');
  const packed=await f.engine.store.archive.compact(t);await assert.rejects(()=>new LegacyArchive(join(f.root,'legacy')).hydrate(packed),/Unsupported|version/);assert.deepEqual(await f.engine.store.archive.hydrate(packed),t);
});

test('a new native thread that inherited a previous task transcript is rejected instead of pretending to be clean',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'task-context-host-')),marker='TEAM_WORKSPACE_ATTEMPT:'+randomUUID(),old='TEAM_WORKSPACE_ATTEMPT:'+randomUUID();
  let inherited=true;const calls=[];
  const observer=new NativeMembers({rpcFactory:()=>({async connect(){},async call(method,args){calls.push(method);return {thread:{id:'new-native',cwd,parentThreadId:'leader',turns:args.includeTurns?[...(inherited?[{id:'old-turn',status:'completed',items:[{type:'agentMessage',text:old+'\nPrevious task'}]}]:[]),{id:'new-turn',status:'completed',items:[{type:'agentMessage',text:marker+'\nCurrent task'}]}]:undefined}};}}),publicFeed:{async read(){return {events:[],usage:null};}}});
  await assert.rejects(()=>observer.inspect('leader',cwd,'new-native',marker,{requireFresh:true}),/different task attempt/);inherited=false;assert.equal((await observer.inspect('leader',cwd,'new-native',marker,{requireFresh:true})).turnId,'new-turn');assert.deepEqual([...new Set(calls)],['thread/read']);
});

test('multiple task generations survive segmented archive roundtrips and stop checks use the latest task identity',async()=>{
  const f=await fixture(),first=await f.claim();await f.complete(first,'native-a');const second=await f.claim('b');await f.complete(second,'native-b');
  let t=await f.saved();const rework=await f.engine.rework('owner',t.id,t.revision,'b','Verify another attempt independently');await f.engine.start('owner',t.id,rework.team.revision);const third=await f.claim('b');assert.equal(third.dispatch.contextIsolation.generation,3);await f.complete(third,'native-b-retry');t=await f.saved();assert.equal(t.contextHistory.length,2);assert.equal(validateTeam(t),true);
  const archive=new TeamArchive(join(f.root,'segmented'),{hotRows:1,segmentRows:1}),packed=await archive.compact(t);assert.ok(packed.archiveManifest.segments.some(s=>s.field==='contextHistory'));assert.deepEqual(await archive.hydrate(packed),t);
  const stop=await f.engine.stop('owner',t.id,t.revision,{requestId:randomUUID(),reason:'Verify current sessions stopped'});const current=f.runs.get(third.dispatch.marker);current.quiescence={turnId:current.turnId,status:'completed'};const halted=await f.engine.reconcileStop('owner',t.id,stop.team.revision);assert.equal(halted.team.executionControl.status,'halted');
});

test('clean session native names remain unique when long role names truncate and reservations are replaced',async()=>{
  const f=await fixture(),first=await f.claim();await f.complete(first,'native-a');const next=await f.claim('b'),team=structuredClone(next.team),task=team.tasks.find(t=>t.id==='b');team.members[0].role='a'.repeat(80);team.projectPath=f.root+'/'+'p'.repeat(80);
  const left=f.engine.packet(team,task);task.attempts.at(-1).id=randomUUID();task.attempts.at(-1).marker='TEAM_WORKSPACE_ATTEMPT:'+task.attempts.at(-1).id;const right=f.engine.packet(team,task);assert.notEqual(left.taskName,right.taskName);assert.ok(left.taskName.length<=64&&right.taskName.length<=64);assert.match(left.taskName,/^[a-z0-9_]+$/);
});
