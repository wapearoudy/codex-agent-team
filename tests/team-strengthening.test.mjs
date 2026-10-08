import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {validatePlan,dispatchBlockers} from '../src/team.mjs';
import {normalizePolicy,usageReport} from '../src/team-policy.mjs';
import {memberExecutions,memberState} from '../src/team-projection.mjs';
import {qualityReport,assertQualityFinish} from '../src/team-quality.mjs';
import {teamResponse} from '../src/team-responses.mjs';
import {NativeMembers} from '../src/native-members.mjs';
import {TeamNavigation} from '../src/team-navigation.mjs';
import {queuePeerMessage,peerActions} from '../src/team-peer-mailbox.mjs';
import {TeamArchive as LegacyArchive} from './fixtures/legacy-archive-v094.mjs';

const member=(id,writeScopes=[])=>({id,role:id,responsibility:'Own '+id,reason:'Needed expertise',writeScopes});
const criterion={id:'AC-1',description:'Requested behavior works'};
const contract=()=>({stage:'implementation',inScope:['src'],outOfScope:['src/secrets'],verify:['node --test'],coverageOf:['G-1']});
function plan({contracts=true,next=false}={}){
  const tasks=[{id:'work',title:'Implement behavior',goal:'Implement requested behavior',acceptance:'Checks pass',acceptanceCriteria:[criterion],memberId:'dev',kind:'work',dependencies:[],...(contracts?{contract:contract()}:{} )},
    {id:'review',title:'Independent review',goal:'Verify requested behavior',acceptance:'Checks pass',memberId:'qa',kind:'review',reviewOfTaskId:'work',dependencies:[{taskId:'work',when:'submitted'}]}];
  if(next)tasks.push({id:'next',title:'Dependent delivery',goal:'Use the accepted implementation',acceptance:'Checks pass',memberId:'dev2',kind:'work',dependencies:[{taskId:'work',when:'accepted'},{taskId:'review',when:'accepted'}]},
    {id:'review-next',title:'Review dependent delivery',goal:'Verify dependent behavior',acceptance:'Checks pass',memberId:'qa',kind:'review',reviewOfTaskId:'next',dependencies:[{taskId:'next',when:'submitted'}]});
  return {members:[member('dev',['src']),member('dev2',['src']),member('qa')],...(contracts?{goalCriteria:[{id:'G-1',description:'Deliver the requested goal'}]}:{}),tasks};
}
async function fixture(options={}){
  const root=await mkdtemp(join(tmpdir(),'team-strengthening-')),cwd=join(root,'project');await mkdir(cwd);
  const runs=new Map(),latest=new Map(),observer={async inspect(leader,project,thread,marker,options={}){assert.equal(leader,'leader');assert.equal(project,cwd);const run=runs.get(marker);if(!run||run.threadId!==thread)throw new Error('Unverified native identity');if(options.requireIdle&&!['completed','failed','interrupted'].includes(latest.get(thread)?.status))throw new Error('Native member is not confirmed idle');return structuredClone(run);}};
  const engine=new LeaderEngine({root:join(root,'records'),observer});
  const team=await engine.planOnce('owner',{cwd,threadId:'leader'},{goal:'Deliver a carefully scoped change',plan:options.plan??plan(options),execute:true,initializeMembers:true,maxParallel:3});
  const f={root,cwd,engine,team,runs,latest,observer};f.saved=()=>engine.store.get(team.id,'owner');
  f.seed=(marker,threadId,status='completed',text='Ready',commands=[])=>{const run={threadId,turnId:randomUUID(),status,outputs:[{text}],commands,usage:{totalTokens:10},connection:'snapshot'};runs.set(marker,run);latest.set(threadId,run);return run;};
  for(const m of team.members){f.seed(m.rosterMarker,'child-'+m.id);const t=await f.saved();await engine.bindRoster('owner',team.id,t.revision,m.id,'child-'+m.id);}
  if(options.autoRepair){const t=await f.saved();await engine.store.update(t.id,'owner',t.revision,t=>{t.policy=normalizePolicy({autoRepair:true,maxReviewRounds:options.maxReviewRounds??3});});}
  f.claim=async taskId=>{const t=await f.saved();return engine.claim('owner',team.id,t.revision,taskId);};
  f.run=async(taskId,output,commands=[],status='completed')=>{const c=await f.claim(taskId),thread=c.dispatch.existingThreadId;f.seed(c.dispatch.marker,thread,status,output,commands);const b=await engine.bind('owner',team.id,c.team.revision,taskId,c.dispatch.attemptId,thread);const data=await engine.settle('owner',team.id,b.team.revision,taskId,c.dispatch.attemptId);return {...data,attemptId:c.dispatch.attemptId};};
  f.decide=async(taskId,decision='accept')=>{const t=await f.saved();return engine.acceptReview('owner',team.id,t.revision,taskId,t.tasks.find(x=>x.id===taskId).attempts.at(-1).id,decision,'Independent evidence checked');};
  return f;
}
const commands=[{command:'node --test',exitCode:0,status:'completed'}];
const delivery=(overrides={})=>JSON.stringify({summary:'Implemented behavior',changedPaths:['src/feature.mjs'],acceptanceResults:[{criterionId:'AC-1',status:'PASS',evidence:'Observed expected behavior'}],commandsRun:['node --test'],...overrides});
const review=(overrides={})=>JSON.stringify({summary:'Independent result',decision:'accept',reason:'Checked concrete evidence',checks:[{name:'behavior',criterionId:'AC-1',status:'PASS',evidence:'Independent check passed'}],findings:[],...overrides});
const finding={id:'F-1',severity:'high',status:'open',description:'Missing negative input handling'};

test('quality contract validation rejects missing criteria, unsafe scope, unverified mode and undeclared coverage',()=>{
  assert.equal(validatePlan(plan()),true);
  for(const mutate of [p=>delete p.tasks[0].acceptanceCriteria,p=>p.tasks[0].contract.inScope=['../outside'],p=>p.tasks[0].contract.inScope=['docs'],p=>p.tasks[0].contract.verify=[],p=>p.tasks[0].validationMode='source-only',p=>p.tasks[0].contract.coverageOf=['unknown'],p=>p.tasks[0].contract.stage='review']){
    const p=plan();mutate(p);assert.throws(()=>validatePlan(p),/criteria|scope|contract|Source-only|coverage|Review/);
  }
  assert.throws(()=>normalizePolicy({maxReviewRounds:0}),/round/);
});
test('declared requirements gate implementation until independent acceptance, including without a DAG dependency',async()=>{
  const p=plan();p.members.push(member('requirements'));
  p.tasks.push({id:'requirements',title:'Clarify requirements',goal:'Confirm observable acceptance',acceptance:'Requirements are complete',acceptanceCriteria:[criterion],memberId:'requirements',kind:'work',validationMode:'source-only',contract:{stage:'requirements',inScope:[],outOfScope:[],verify:[],coverageOf:[]},dependencies:[]},
    {id:'review-requirements',title:'Review requirements',goal:'Verify requirements completeness',acceptance:'Complete',memberId:'qa',kind:'review',reviewOfTaskId:'requirements',dependencies:[{taskId:'requirements',when:'submitted'}]});
  const f=await fixture({plan:p});const t=await f.saved();assert.ok(dispatchBlockers(t,t.tasks[0]).some(b=>b.code==='requirements-gate'));
  await assert.rejects(()=>f.claim('work'),/需求/);
  await f.run('requirements',delivery({changedPaths:[]}));await f.run('review-requirements',review());await f.decide('review-requirements');
  const c=await f.claim('work');assert.equal(c.dispatch.taskId,'work');assert.ok(c.dispatch.prompt.includes('Quality contract'));
});
test('contract settlement rejects out-of-scope paths and missing criterion evidence atomically',async()=>{
  for(const output of [delivery({changedPaths:['src/secrets/key']}),delivery({changedPaths:['src/./secrets/key']}),delivery({changedPaths:['src//secrets/key']}),delivery({changedPaths:['docs/file']}),delivery({changedPaths:['../escape']}),delivery({acceptanceResults:[]}),'Informal success']){
    const f=await fixture(),c=await f.claim('work');f.seed(c.dispatch.marker,c.dispatch.existingThreadId,'completed',output,commands);
    const b=await f.engine.bind('owner',f.team.id,c.team.revision,'work',c.dispatch.attemptId,c.dispatch.existingThreadId),before=await f.saved();
    await assert.rejects(()=>f.engine.settle('owner',f.team.id,b.team.revision,'work',c.dispatch.attemptId),/scope|changedPaths|criterion|JSON/);
    assert.deepEqual(await f.saved(),before);
  }
});
test('model-claimed checks, wrong commands and failed criteria cannot pass independent contract acceptance',async()=>{
  for(const [records,output] of [[[],delivery()],[commands.map(c=>({...c,command:'echo passed'})),delivery()],[commands.map(c=>({...c,exitCode:1})),delivery()],[commands,delivery({acceptanceResults:[{criterionId:'AC-1',status:'NOT_RUN',evidence:'Not run'}]})]]){
    const f=await fixture();await f.run('work',output,records);await f.run('review',review());const before=await f.saved();
    await assert.rejects(()=>f.decide('review'),/Contract acceptance/);assert.deepEqual(await f.saved(),before);
  }
});
test('automatic repair preserves evidence, redirects both dependency types, and independently resolves stable findings',async()=>{
  const f=await fixture({autoRepair:true,next:true});await f.run('work',delivery(),commands);await f.run('review',review({decision:'rework',findings:[finding]}));
  const before=await f.saved(),result=await f.decide('review','rework'),repair=result.team.tasks.find(t=>t.repairRootTaskId==='work'),r=result.team.tasks.find(t=>t.reviewOfTaskId===repair.id);
  assert.equal(repair.contract.stage,'repair');assert.equal(repair.repairRound,2);assert.deepEqual(repair.repairFindingIds,['F-1']);
  assert.deepEqual(result.team.tasks[0].evidence,before.tasks[0].evidence);assert.deepEqual(result.team.tasks[1].evidence,before.tasks[1].evidence);
  assert.equal(result.team.tasks[0].status,'cancelled');assert.equal(result.team.tasks[0].supersededBy,repair.id);
  assert.deepEqual(result.team.tasks.find(t=>t.id==='next').dependencies,[{taskId:repair.id,when:'accepted'},{taskId:r.id,when:'accepted'}]);
  assert.equal(result.quality.coverage[0].status,'pending');assert.equal(result.quality.openFindings[0].id,'F-1');
  await f.run(repair.id,delivery(),commands);await f.run(r.id,review());await assert.rejects(()=>f.decide(r.id),/F-1.*resolution/);
  const saved=await f.saved();await f.engine.rework('owner',f.team.id,saved.revision,r.id,'Explicit resolution required');await f.engine.start('owner',f.team.id,(await f.saved()).revision);
  await f.run(r.id,review({findings:[{...finding,status:'resolved',resolutionEvidence:'Negative input independently returned the expected rejection'}]}));
  const accepted=await f.decide(r.id);assert.equal(accepted.quality.openFindings.length,0);assert.equal(accepted.quality.coverage[0].status,'accepted');assert.equal(accepted.team.findings[0].history.length,2);
  assert.ok(accepted.readiness.find(t=>t.taskId==='next').ready);
  const restarted=new LeaderEngine({root:f.engine.root,observer:f.observer});assert.deepEqual((await restarted.read('owner',f.team.id)).team.findings,accepted.team.findings);
});
test('repair round cap pauses escalation without creating another repair or resetting attempts',async()=>{
  const f=await fixture({autoRepair:true,maxReviewRounds:1});await f.run('work',delivery(),commands);await f.run('review',review({decision:'rework',findings:[finding]}));
  const result=await f.decide('review','rework');assert.equal(result.team.tasks.length,2);assert.equal(result.team.state,'review-escalated');assert.equal(result.team.dispatchPaused,true);assert.equal(result.team.tasks[0].status,'blocked');assert.match(result.team.tasks[0].blockReason,/limit/);
  assert.equal(result.team.tasks[0].attempt,1);await assert.rejects(()=>f.claim('work'),/paused|not ready/);
});
test('legacy manual rework remains compatible and auto repair rejects contradictory verdicts',async()=>{
  const f=await fixture({contracts:false});await f.run('work','Legacy delivery');await f.run('review','Need another check');const result=await f.decide('review','rework');assert.equal(result.team.tasks.length,2);assert.equal(result.team.tasks[0].status,'waiting');
  const auto=await fixture({autoRepair:true});await auto.run('work',delivery(),commands);await auto.run('review',review());await assert.rejects(()=>auto.decide('review','rework'),/match/);
});
test('finding IDs cannot move across deliverables, downgrade severity, or resolve without evidence',async()=>{
  const f=await fixture({autoRepair:true});await f.run('work',delivery(),commands);await f.run('review',review({decision:'rework',findings:[finding]}));const result=await f.decide('review','rework'),repair=result.team.tasks.find(t=>t.repairRootTaskId),r=result.team.tasks.find(t=>t.reviewOfTaskId===repair.id);
  await f.run(repair.id,delivery(),commands);await f.run(r.id,review({findings:[{...finding,severity:'low',status:'resolved',resolutionEvidence:'Claimed'}]}));const before=await f.saved();await assert.rejects(()=>f.decide(r.id),/severity/);assert.deepEqual(await f.saved(),before);
});
test('final coverage requires every declared deliverable and blocks unresolved severe findings',()=>{
  const p=plan();p.tasks[0].status='accepted';assert.doesNotThrow(()=>assertQualityFinish(p));
  p.goalCriteria.push({id:'G-2',description:'Unplanned requirement'});assert.equal(qualityReport(p).coverage[1].status,'missing');assert.throws(()=>assertQualityFinish(p),/coverage/);
  p.goalCriteria.pop();p.tasks.push({...p.tasks[0],id:'second',status:'waiting'});assert.throws(()=>assertQualityFinish(p),/coverage/);
  p.tasks.pop();p.findings=[{...finding,rootTaskId:'work'}];assert.throws(()=>assertQualityFinish(p),/Unresolved/);
});
test('safe reassignment preserves historical identities, checkpoints, messages, tokens and retry budget',async()=>{
  const f=await fixture({contracts:false}),c=await f.claim('work'),run=f.seed(c.dispatch.marker,c.dispatch.existingThreadId,'inProgress','Working');
  let data=await f.engine.bind('owner',f.team.id,c.team.revision,'work',c.dispatch.attemptId,c.dispatch.existingThreadId);
  data=await f.engine.checkpoint('owner',f.team.id,data.team.revision,{taskId:'work',attemptId:c.dispatch.attemptId,requestId:randomUUID(),summary:'Partial implementation'});
  data=await f.engine.message('owner',f.team.id,data.team.revision,'work','Keep original scope',randomUUID());
  const requestId=randomUUID();await assert.rejects(()=>f.engine.reassign('owner',f.team.id,data.team.revision,'work','dev2','Replace unavailable executor',requestId),/Stop and settle/);
  run.status='failed';f.runs.set(c.dispatch.marker,run);f.latest.set(run.threadId,run);data=await f.engine.settle('owner',f.team.id,data.team.revision,'work',c.dispatch.attemptId);
  const before=await f.saved(),moved=await f.engine.reassign('owner',f.team.id,data.team.revision,'work','dev2','Replace unavailable executor',requestId);
  assert.equal(moved.team.tasks[0].memberId,'dev2');assert.equal(moved.team.tasks[0].attempts[0].memberId,'dev');assert.equal(moved.team.tasks[0].attempt,1);
  assert.deepEqual(moved.team.tasks[0].evidence,before.tasks[0].evidence);assert.equal(moved.checkpoints[0].stale,true);assert.equal(moved.messages[0].memberId,'dev');
  assert.equal(moved.runs[0].memberId,'dev');assert.equal(moved.usage.members.find(m=>m.memberId==='dev').totalTokens,10);assert.equal(moved.usage.members.find(m=>m.memberId==='dev2').totalTokens,0);
  assert.equal(memberExecutions(moved.team.members[0],moved.team.tasks,moved.runs).length,1);
  const replay=await f.engine.reassign('owner',f.team.id,before.revision,'work','dev2','Replace unavailable executor',requestId);assert.equal(replay.memberChange.replayed,true);assert.equal(replay.team.revision,moved.team.revision);
  await assert.rejects(()=>f.engine.reassign('owner',f.team.id,moved.team.revision,'work','qa','Changed request',requestId),/different/);
  await f.engine.start('owner',f.team.id,moved.team.revision);const next=await f.claim('work');assert.equal(next.dispatch.existingThreadId,'child-dev2');assert.equal(next.team.tasks[0].attempt,2);
});
test('reassignment rejects self-review and incompatible scopes without changing records',async()=>{
  const f=await fixture(),t=await f.saved();
  await assert.rejects(()=>f.engine.reassign('owner',t.id,t.revision,'work','qa','Take over',randomUUID()),/sole reviewer|scope/);assert.deepEqual(await f.saved(),t);
  await assert.rejects(()=>f.engine.reassign('owner',t.id,t.revision,'review','dev','Self review',randomUUID()),/sole reviewer/);assert.deepEqual(await f.saved(),t);
  await assert.rejects(()=>f.engine.reassign('other',t.id,t.revision,'work','dev2','Take over',randomUUID()),/not found/);
});
test('removal requires no unfinished work and an idle native head, preserves history and releases capacity',async()=>{
  const f=await fixture({contracts:false});let t=await f.saved();
  await assert.rejects(()=>f.engine.removeMember('owner',t.id,t.revision,'dev','Retire',randomUUID()),/unfinished/);
  f.latest.set('child-dev2',{status:'inProgress'});await assert.rejects(()=>f.engine.removeMember('owner',t.id,t.revision,'dev2','Retire',randomUUID()),/idle/);assert.deepEqual(await f.saved(),t);
  f.latest.set('child-dev2',{status:'completed'});const requestId=randomUUID(),removed=await f.engine.removeMember('owner',t.id,t.revision,'dev2','Retire unused role',requestId);
  const retired=removed.team.members.find(m=>m.id==='dev2');assert.ok(retired.removedAt);assert.equal(retired.agentThreadId,'child-dev2');assert.equal(memberState(retired,removed.team.tasks,[]),'removed');
  const replay=await f.engine.removeMember('owner',t.id,t.revision,'dev2','Retire unused role',requestId);assert.equal(replay.memberChange.replayed,true);
  const added=await f.engine.addMembers('owner',t.id,removed.team.revision,Array.from({length:6},(_,i)=>member('new'+i)),randomUUID());assert.equal(added.team.members.filter(m=>!m.removedAt).length,8);assert.equal(added.team.members.length,9);
  t=await f.saved();await assert.rejects(()=>f.engine.bindRoster('owner',t.id,t.revision,'dev2','child-dev2'),/active/);
  await assert.rejects(()=>f.engine.addMembers('owner',t.id,t.revision,[member('dev2')],randomUUID()),/unique|1–8/);
  assert.equal(teamResponse(added,'summary').team.members.find(m=>m.id==='dev2').removedAt,retired.removedAt);
});
test('concurrent identical member changes commit once and stale distinct changes are fenced',async()=>{
  const f=await fixture({contracts:false}),t=await f.saved(),requestId=randomUUID();
  const results=await Promise.all([f.engine.reassign('owner',t.id,t.revision,'work','dev2','New executor',requestId),f.engine.reassign('owner',t.id,t.revision,'work','dev2','New executor',requestId)]);
  assert.deepEqual(results.map(r=>r.memberChange.replayed).sort(),[false,true]);assert.equal((await f.saved()).revision,t.revision+1);
  await assert.rejects(()=>f.engine.reassign('owner',t.id,t.revision,'work','dev','Return',randomUUID()),/changed/);
});
test('a repaired contract delivery finishes only after independent finding closure and Leader validation',async()=>{
  const f=await fixture({autoRepair:true});await f.run('work',delivery(),commands);await f.run('review',review({decision:'rework',findings:[finding]}));
  const repairPlan=await f.decide('review','rework'),repair=repairPlan.team.tasks.find(t=>t.repairRootTaskId),r=repairPlan.team.tasks.find(t=>t.reviewOfTaskId===repair.id);
  await f.run(repair.id,delivery(),commands);await f.run(r.id,review({findings:[{...finding,status:'resolved',resolutionEvidence:'Independent negative input regression passed'}]}));
  const accepted=await f.decide(r.id),done=await f.engine.finish('owner',f.team.id,accepted.team.revision,'Leader verified integrated candidate',[{name:'integration',status:'PASS',evidence:'Controlled fixture integration verification'}]);
  assert.equal(done.team.state,'delivered');assert.equal(done.quality.coverage[0].status,'accepted');assert.equal(done.quality.resolvedFindingCount,1);
});
test('native quiescence checks the latest host turn rather than a completed historical initialization',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'team-idle-head-'));let status='inProgress',lifecycleStatus='unknown';
  const rpc={async connect(){},async close(){},async call(){return {thread:{id:'child',parentThreadId:'leader',cwd,turns:[{id:'init',status:'completed',items:[{type:'userMessage',content:[{type:'text',text:'init-marker'}]}]},{id:'new',status,items:[]}]}};}};
  const observer=new NativeMembers({rpcFactory:()=>rpc,lifecycleReader:async()=>({status:lifecycleStatus}),publicFeed:{async read(){return {events:[],usage:null};}}});
  assert.equal((await observer.inspect('leader',cwd,'child','init-marker')).status,'completed');
  await assert.rejects(()=>observer.inspect('leader',cwd,'child','init-marker',{requireIdle:true}),/idle/);
  status='interrupted';await assert.rejects(()=>observer.inspect('leader',cwd,'child','init-marker',{requireIdle:true}),/idle/);
  lifecycleStatus='interrupted';assert.equal((await observer.inspect('leader',cwd,'child','init-marker',{requireIdle:true})).turnId,'init');await observer.close();
});
test('historical navigation keeps the original executor after reassignment and refuses the new member for old turns',async()=>{
  const f=await fixture({contracts:false}),result=await f.run('work','Interrupted implementation',[],'failed'),before=await f.saved();
  await f.engine.store.update(before.id,'owner',before.revision,t=>{delete t.tasks[0].attempts[0].memberId;});
  const moved=await f.engine.reassign('owner',before.id,(await f.saved()).revision,'work','dev2','Continue elsewhere',randomUUID());
  assert.equal(moved.team.tasks[0].attempts[0].memberId,'dev','legacy ownership is materialized before transfer');
  const observer={async inspect(parent,cwd,thread,marker){return {...await f.observer.inspect(parent,cwd,thread,marker),parentThreadId:parent};}};
  const nav=new TeamNavigation({root:f.root,store:f.engine.store,observer}),args={teamId:before.id,memberId:'dev',taskId:'work',attemptId:result.attemptId,requestId:randomUUID()};
  const target=await nav.request('owner',{cwd:f.cwd,threadId:'leader'},args);assert.equal(target.leaderAction.threadId,'child-dev');
  await assert.rejects(()=>nav.request('owner',{cwd:f.cwd,threadId:'leader'},{...args,memberId:'dev2',requestId:randomUUID()}),/不匹配/);
});
test('queued peer delivery cannot target retired members or carry a previous executor attempt after reassignment',async()=>{
  const f=await fixture({contracts:false}),c=await f.claim('work');f.seed(c.dispatch.marker,'child-dev','inProgress','Working');
  const bound=await f.engine.bind('owner',f.team.id,c.team.revision,'work',c.dispatch.attemptId,'child-dev'),team=structuredClone(bound.team);
  const args={senderMemberId:'dev',senderThreadId:'child-dev',attemptId:c.dispatch.attemptId,toMemberId:'dev2',text:'Coordinate',requestId:randomUUID()};
  queuePeerMessage(team,args);assert.equal(peerActions(team).length,1);
  team.members.find(m=>m.id==='dev2').removedAt=new Date().toISOString();assert.equal(peerActions(team).length,0);
  assert.throws(()=>queuePeerMessage(team,{...args,requestId:randomUUID()}),/active/);
  delete team.members.find(m=>m.id==='dev2').removedAt;team.tasks[0].memberId='dev2';assert.equal(peerActions(team).length,0);
});
test('new quality and lifecycle states fence the unchanged 0.9.4 archive reader before it can write',async()=>{
  for(const contracts of [true,false]){
    const f=await fixture({contracts});
    if(!contracts){const t=await f.saved();await f.engine.reassign('owner',t.id,t.revision,'work','dev2','Controlled ownership transfer',randomUUID());}
    const file=f.engine.store.document(f.team.id).v2,bytes=await readFile(file,'utf8'),saved=JSON.parse(bytes);
    assert.equal(saved.requiresTeamWorkspaceVersion,'0.10.0');assert.equal(saved.archiveManifest.schemaVersion,2);
    const legacy=new LegacyArchive(f.engine.store.archive.root);await assert.rejects(()=>legacy.hydrate(saved),/Unsupported archive/);
    assert.equal(await readFile(file,'utf8'),bytes);assert.equal((await f.saved()).id,f.team.id);
  }
});
