import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {NativeMembers} from '../src/native-members.mjs';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {ProjectTeams} from '../src/project-teams.mjs';
import {TeamStore,validateTeam} from '../src/team.mjs';
import {TeamArchive as PreviousArchive} from './fixtures/legacy-archive-v011.mjs';
import {usageReport} from '../src/team-policy.mjs';
import {teamResponse} from '../src/team-responses.mjs';

const plan=()=>({members:[{id:'dev',role:'开发',responsibility:'实现',reason:'交付',writeScopes:[]},{id:'qa',role:'审查',responsibility:'独立验收',reason:'独立性',writeScopes:[]}],tasks:[{id:'work',title:'实现',goal:'目标',acceptance:'验证',memberId:'dev',kind:'work',dependencies:[]},{id:'review',title:'验收',goal:'独立验证',acceptance:'所有检查通过',memberId:'qa',kind:'review',reviewOfTaskId:'work',dependencies:[{taskId:'work',when:'submitted'}]}]});
const verdict=JSON.stringify({summary:'完成独立验收',decision:'accept',reason:'实际证据已核对',checks:[{name:'tests',status:'PASS',evidence:'411/411 fixture checks'}],findings:[]});
const command=(name='test',exitCode=0)=>({type:'commandExecution',command:name,exitCode,status:exitCode?'failed':'completed',aggregatedOutput:exitCode?'Failed':'PASS'});
function turn(id,marker,status='completed',output='交付',commands=[]){return {id,status,items:[{type:'userMessage',content:[{type:'text',text:marker}]},{type:'agentMessage',phase:'commentary',text:marker},...commands,...(output?[{type:'agentMessage',phase:'final_answer',text:output}]:[]),{type:'reasoning',text:'HIDDEN REASONING'}]};}
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'turn-continuation-')),cwd=join(root,'project');await mkdir(cwd);
  const threads=new Map(),lifecycle=new Map(),usage=new Map(),calls=[];
  const observer=new NativeMembers({rpcFactory:()=>({async connect(){},async close(){},async call(method,args){calls.push({method,args});assert.equal(method,'thread/read');return {thread:structuredClone(threads.get(args.threadId))};}}),lifecycleReader:async(_thread,id)=>lifecycle.get(id)??null,publicFeed:{async read(_thread,id){return {events:[],cursor:0,usage:usage.get(id)??{totalTokens:10},source:'native-public'};}}});
  const engine=new LeaderEngine({root:join(root,'records'),observer}),projects=new ProjectTeams(engine),context={cwd,threadId:'leader'};
  const team=(await projects.plan('owner',context,{goal:'验证任务中断后的同会话续跑机制',execute:true,memberStartup:'on-demand',plan:plan()})).team;
  const saved=()=>engine.native('owner',team.id);
  const set=(id,turns)=>threads.set(id,{id,parentThreadId:'leader',cwd,turns});
  const aborted=id=>lifecycle.set(id,{status:'interrupted',source:'persisted-turn-aborted',at:new Date().toISOString()});
  const claim=async taskId=>{const t=await saved();return engine.claim('owner',t.id,t.revision,taskId);};
  const bind=async(c,id)=>engine.bind('owner',team.id,c.team.revision,c.dispatch.taskId,c.dispatch.attemptId,id);
  const work=async()=>{const c=await claim('work');set('dev',[turn('dev-turn',c.dispatch.marker)]);const b=await bind(c,'dev');await engine.settle('owner',team.id,b.team.revision,'work',c.dispatch.attemptId);return c;};
  return {root,cwd,observer,engine,projects,context,team,threads,lifecycle,usage,calls,saved,set,aborted,claim,bind,work};
}

test('interrupted continuation binds the completed turn and retains turn-scoped evidence without mutating on read',async()=>{
  const f=await fixture(),c=await f.claim('work');
  const first=turn('old',c.dispatch.marker,'inProgress',null,[command('old check',1)]);f.set('dev',[first]);const b=await f.bind(c,'dev');
  first.status='interrupted';f.aborted('old');f.set('dev',[first,turn('new',c.dispatch.marker,'completed','Final delivery',[command('new check')])]);f.usage.set('old',{totalTokens:100});f.usage.set('new',{totalTokens:40});
  const before=await f.saved(),observed=await f.engine.read('owner',f.team.id);
  assert.equal(observed.runs[0].turnId,'new');assert.deepEqual(await f.saved(),before);assert.equal(observed.usage.totalTokens,140);assert.deepEqual(observed.runs[0].commands.map(c=>c.command),['new check']);
  const settled=await f.engine.settle('owner',f.team.id,b.team.revision,'work',c.dispatch.attemptId),a=settled.team.tasks[0].attempts[0];
  assert.equal(a.turnId,'new');assert.equal(a.state,'submitted');assert.equal(settled.team.requiresTeamWorkspaceVersion,'0.17.0');assert.deepEqual(a.turnHistory.map(t=>t.turnId),['old','new']);assert.equal(a.turnHistory[0].commands[0].exitCode,1);assert.equal(a.turnHistory[0].statusEvidence.source,'persisted-turn-aborted');assert.ok(a.turnAssociation.links[0].linkedAt);assert.equal(settled.team.totalDispatches,1);assert.equal(settled.team.tasks[0].attempts.length,1);
  assert.equal(settled.team.events.filter(e=>e.type==='native-task-turn-continued').length,1);assert.ok(!JSON.stringify(settled).includes('HIDDEN REASONING'));
  const disk=new TeamStore(f.engine.store.root);assert.deepEqual((await disk.get(f.team.id,'owner')).tasks[0].attempts[0].turnHistory,a.turnHistory);
  const panel=teamResponse(settled,'panel');assert.equal(panel.runs[0].continuation.turnCount,2);assert.equal(panel.runs[0].turnHistory,undefined);assert.deepEqual(panel.runs[0].continuation.turns.map(t=>t.commandCount),[1,1]);
  assert.ok(f.calls.every(c=>c.method==='thread/read'));await f.engine.close();
});

test('multiple interruptions form one ordered chain; replay cannot duplicate links or roll back a saved chain',async()=>{
  const f=await fixture(),c=await f.claim('work'),marker=c.dispatch.marker;f.set('dev',[turn('one',marker,'inProgress',null)]);await f.bind(c,'dev');
  f.aborted('one');f.aborted('two');f.set('dev',[turn('one',marker,'interrupted',null),turn('two',marker,'interrupted',null),turn('three',marker,'inProgress',null)]);
  let t=await f.saved();let b=await f.engine.bind('owner',t.id,t.revision,'work',c.dispatch.attemptId,'dev');assert.equal(b.team.events.filter(e=>e.type==='native-task-turn-continued').length,2);
  b=await f.engine.bind('owner',t.id,b.team.revision,'work',c.dispatch.attemptId,'dev');assert.equal(b.team.events.filter(e=>e.type==='native-task-turn-continued').length,2);
  f.set('dev',[turn('three',marker,'completed','orphan')]);const before=await f.saved();await assert.rejects(()=>f.engine.settle('owner',t.id,b.team.revision,'work',c.dispatch.attemptId),/history changed/);assert.deepEqual(await f.saved(),before);
  await f.engine.close();
});

test('duplicate completions, failed predecessors, missing interruption proof, skipped and foreign turns remain ambiguous',async()=>{
  const f=await fixture(),marker='TEAM_WORKSPACE_ATTEMPT:'+randomUUID(),other='TEAM_WORKSPACE_ATTEMPT:'+randomUUID();
  const inspect=()=>f.observer.inspect('leader',f.cwd,'dev',marker,{boundTurnId:'old'});
  for(const status of ['completed','failed','interrupted']){f.set('dev',[turn('old',marker,status),turn('new',marker)]);await assert.rejects(inspect,/uniquely/);}
  f.lifecycle.set('old',{status:'inProgress',source:'persisted-native-activity'});await assert.rejects(inspect,/uniquely/);
  f.aborted('old');f.set('dev',[turn('old',marker,'interrupted'),turn('unrelated','unrelated'),turn('new',marker)]);await assert.rejects(inspect,/uniquely/);
  f.set('dev',[turn('old',marker,'interrupted'),turn('new',marker,'completed',other)]);await assert.rejects(inspect,/uniquely/);
  f.set('dev',[turn('old',marker,'interrupted'),turn('new',marker)]);await assert.rejects(()=>f.observer.inspect('leader',f.cwd,'dev',marker,{boundTurnId:'missing'}),/bound turn/);
  f.threads.get('dev').parentThreadId='another-leader';await assert.rejects(inspect,/native child/);await f.engine.close();
});

test('stop preserves and registers the resumed review; final acceptance, final validation and archive succeed after restart',async()=>{
  const f=await fixture();await f.work();const c=await f.claim('review'),marker=c.dispatch.marker;f.set('qa',[turn('interrupted-review',marker,'inProgress',null,[command('original review evidence')])]);await f.bind(c,'qa');
  const old=turn('interrupted-review',marker,'interrupted',null,[command('original review evidence')]);f.aborted(old.id);f.set('qa',[old,turn('completed-review',marker,'completed',verdict,[command('review current checks')])]);
  let t=await f.saved();const stop=await f.engine.stop('owner',t.id,t.revision,{requestId:randomUUID(),reason:'用户要求停止后归档'});const halted=await f.engine.reconcileStop('owner',t.id,stop.team.revision);
  assert.equal(halted.team.state,'halted');assert.deepEqual(halted.team.executionControl.pending,[]);assert.equal(halted.team.tasks[1].status,'accepted');assert.equal(halted.team.tasks[1].attempts[0].turnId,'completed-review');assert.equal(halted.team.tasks[1].evidence.length,1);assert.equal(halted.team.tasks[1].attempts[0].stopEvidence.quiescence.turnId,'completed-review');
  const cold=new LeaderEngine({root:f.engine.root,observer:f.observer});t=(await cold.resume('owner',t.id,halted.team.revision,{requestId:randomUUID(),reason:'继续核对已有交付，无需重新执行',retryTaskIds:[]})).team;
  const accepted=await cold.acceptReview('owner',t.id,t.revision,'review',c.dispatch.attemptId,'accept','Leader核对完整原始独立审查');assert.ok(accepted.team.tasks.every(t=>t.status==='accepted'));
  const done=await cold.finish('owner',t.id,accepted.team.revision,'明确最终验收',[{name:'full tests',status:'PASS',evidence:'controlled 411/411 fixture'}]);const archived=await new ProjectTeams(cold).archive('owner',f.context,{teamId:t.id,revision:done.team.revision,requestId:randomUUID(),source:'leader-recorded-user-instruction',reason:'目标完成；无关工作另建团队'});
  const saved=await cold.native('owner',t.id);assert.equal(saved.state,'archived');assert.equal(saved.requiresTeamWorkspaceVersion,'0.24.0');assert.equal(saved.tasks[1].attempts[0].turnHistory.length,2);assert.equal(saved.archival.members.find(m=>m.memberId==='qa').turnId,'completed-review');assert.equal(archived.replayed,false);
  await assert.rejects(async()=>new PreviousArchive(cold.store.archive.root).hydrate(await cold.store.document(t.id).read()),/Unsupported archive/);
  await cold.close();
});

test('ambiguous history cannot block a verified stop, and cannot be submitted or accepted by that stop',async()=>{
  const f=await fixture(),c=await f.claim('work'),marker=c.dispatch.marker;f.set('dev',[turn('old',marker,'inProgress',null)]);await f.bind(c,'dev');f.set('dev',[turn('old',marker),turn('duplicate',marker)]);
  let t=await f.saved();const stop=await f.engine.stop('owner',t.id,t.revision,{requestId:randomUUID(),reason:'停止错误关联的执行'});const halted=await f.engine.reconcileStop('owner',t.id,stop.team.revision);
  assert.equal(halted.team.state,'halted');assert.equal(halted.team.tasks[0].status,'blocked');assert.equal(halted.team.tasks[0].evidence.length,0);assert.equal(halted.team.tasks[0].attempts[0].turnId,'old');assert.match(halted.team.tasks[0].attempts[0].stopEvidence.associationError,/uniquely/);assert.equal(halted.team.tasks[0].attempts[0].stopEvidence.quiescence.turnId,'duplicate');
  await f.engine.close();
});

test('a live latest turn prevents stopping, while invalid completed delivery is retained without acceptance',async()=>{
  const f=await fixture(),c=await f.claim('work'),marker=c.dispatch.marker;f.set('dev',[turn('old',marker,'inProgress',null)]);await f.bind(c,'dev');f.aborted('old');f.set('dev',[turn('old',marker,'interrupted',null),turn('new',marker,'inProgress',null)]);
  let t=await f.saved();const stop=await f.engine.stop('owner',t.id,t.revision,{requestId:randomUUID(),reason:'停止并核对'});const pending=await f.engine.reconcileStop('owner',t.id,stop.team.revision);assert.equal(pending.team.state,'stopping');assert.equal(pending.team.tasks[0].status,'running');
  f.set('dev',[turn('old',marker,'interrupted',null),turn('new',marker,'completed',null)]);const halted=await f.engine.reconcileStop('owner',t.id,pending.team.revision);assert.equal(halted.team.state,'halted');assert.equal(halted.team.tasks[0].status,'blocked');assert.equal(halted.team.tasks[0].attempts[0].turnHistory.length,2);assert.match(halted.team.tasks[0].attempts[0].stopEvidence.settlementError,/no public delivery/);await f.engine.close();
});

test('original message turn remains addressable after continuation without moving or fabricating its acknowledgement',async()=>{
  const f=await fixture(),c=await f.claim('work'),marker=c.dispatch.marker;f.set('dev',[turn('old',marker,'inProgress',null)]);let b=await f.bind(c,'dev');
  const queued=await f.engine.message('owner',f.team.id,b.team.revision,'work','核对原始证据','message-1'),message=queued.messages[0];assert.equal(message.turnId,'old');
  f.aborted('old');const old=turn('old',marker,'interrupted',null);old.items.push({type:'agentMessage',phase:'commentary',text:message.marker});f.set('dev',[old,turn('new',marker)]);
  b=await f.engine.settle('owner',f.team.id,queued.team.revision,'work',c.dispatch.attemptId);const receipt=await f.engine.reconcileMessage('owner',f.team.id,b.team.revision,message.id);assert.equal(receipt.messages[0].status,'acknowledged');assert.equal(receipt.messages[0].turnId,'old');assert.equal(receipt.team.tasks[0].attempts[0].turnId,'new');validateTeam(receipt.team);
  old.items=old.items.filter(i=>i.text!==message.marker);f.set('dev',[old,turn('new',marker,'completed',message.marker)]);await assert.rejects(()=>f.engine.reconcileMessage('owner',f.team.id,receipt.team.revision,message.id),/original message turn/);await f.engine.close();
});

test('unknown continuation usage cannot fall back to an old single-turn total; historical refresh counts each turn once',async()=>{
  const f=await fixture(),c=await f.claim('work'),marker=c.dispatch.marker;f.set('dev',[turn('old',marker,'inProgress',null)]);const b=await f.bind(c,'dev');f.aborted('old');f.set('dev',[turn('old',marker,'interrupted',null),turn('new',marker)]);f.usage.set('old',{totalTokens:100});f.usage.set('new',null);
  // Explicit unavailable feed rather than the fixture's default known usage.
  f.observer.publicFeed.read=async(_thread,id)=>({events:[],usage:f.usage.get(id)??null});
  const current=await f.engine.read('owner',f.team.id);assert.equal(current.usage.unknownAttempts,1);assert.equal(current.usage.totalTokens,0);assert.equal(usageReport(current.team,current.runs).complete,false);
  f.usage.set('new',{totalTokens:50});const settled=await f.engine.settle('owner',f.team.id,b.team.revision,'work',c.dispatch.attemptId);assert.equal(settled.usage.totalTokens,150);
  const report=await f.engine.usage('owner',f.team.id,{refreshHistorical:true});assert.equal(report.totalTokens,150);assert.equal(report.knownAttempts,1);assert.equal(report.unknownAttempts,0);await f.engine.close();
});

test('continuation records fence old versions, reject broken links and preserve data on stale mutation',async()=>{
  const f=await fixture(),c=await f.claim('work'),marker=c.dispatch.marker;f.set('dev',[turn('old',marker,'inProgress',null)]);const b=await f.bind(c,'dev');f.aborted('old');f.set('dev',[turn('old',marker,'interrupted',null),turn('new',marker)]);
  await assert.rejects(()=>f.engine.settle('owner',f.team.id,b.team.revision-1,'work',c.dispatch.attemptId),/changed/);assert.equal((await f.saved()).tasks[0].attempts[0].turnId,'old');
  const settled=await f.engine.settle('owner',f.team.id,b.team.revision,'work',c.dispatch.attemptId);const invalid=structuredClone(settled.team);invalid.requiresTeamWorkspaceVersion='0.16.0';assert.throws(()=>validateTeam(invalid),/requires Team Workspace/);invalid.requiresTeamWorkspaceVersion='0.17.0';invalid.tasks[0].attempts[0].turnAssociation.links[0].fromTurnId='foreign';assert.throws(()=>validateTeam(invalid),/continuation link/);await f.engine.close();
});

test('old-turn checkpoints survive verified continuation and cannot block settlement, acceptance or archive',async()=>{
 const f=await fixture();await f.work();const c=await f.claim('review'),marker=c.dispatch.marker;f.set('qa',[turn('old',marker,'inProgress',null)]);await f.bind(c,'qa');let t=await f.saved();
 const input={taskId:'review',attemptId:c.dispatch.attemptId,requestId:randomUUID(),summary:'Old interrupted review progress',validation:[{name:'old check',status:'PASS',evidence:'Historical only'}]};
 const cp=await f.engine.checkpoint('owner',t.id,t.revision,input);const original=structuredClone(cp.team.checkpoints[0]);
 f.aborted('old');f.set('qa',[turn('old',marker,'interrupted',null,[command('old check')]),turn('new',marker,'completed',verdict,[command('current check')])]);
 t=await f.saved();assert.equal((await f.engine.read('owner',t.id)).checkpoints[0].stale,true);assert.deepEqual(await f.saved(),t);const settled=await f.engine.settle('owner',t.id,t.revision,'review',c.dispatch.attemptId);assert.equal(settled.team.tasks[1].status,'accepted');assert.equal(settled.team.tasks[1].attempts[0].turnId,'new');assert.equal(settled.team.requiresTeamWorkspaceVersion,'0.24.0');assert.deepEqual(settled.team.checkpoints[0],original);assert.equal(settled.checkpoints[0].stale,true);validateTeam(settled.team);
 const accepted=await f.engine.acceptReview('owner',t.id,settled.team.revision,'review',c.dispatch.attemptId,'accept','Current turn independently verified');assert.ok(accepted.team.tasks.every(t=>t.status==='accepted'));
 const done=await f.engine.finish('owner',t.id,accepted.team.revision,'Final validation',[{name:'checks',status:'PASS',evidence:'Current integrated evidence'}]);const archived=await f.projects.archive('owner',f.context,{teamId:t.id,revision:done.team.revision,requestId:randomUUID(),source:'leader-recorded-user-instruction',reason:'Completed'});assert.equal(archived.kind,'team-archive');assert.equal((await f.saved()).state,'archived');const cold=new LeaderEngine({root:f.engine.root,observer:f.observer});validateTeam(await cold.native('owner',t.id));await f.engine.close();
});

test('new Leader and member checkpoints bind the verified continuation before recording progress',async()=>{
 const f=await fixture(),c=await f.claim('work'),marker=c.dispatch.marker;f.set('dev',[turn('old',marker,'inProgress',null)]);await f.bind(c,'dev');f.aborted('old');f.set('dev',[turn('old',marker,'interrupted',null),turn('new',marker,'inProgress',null)]);let t=await f.saved();
 const input={taskId:'work',attemptId:c.dispatch.attemptId,requestId:randomUUID(),summary:'Current resumed progress'};const saved=await f.engine.checkpoint('owner',t.id,t.revision,input);assert.equal(saved.checkpoints[0].turnId,'new');assert.equal(saved.team.tasks[0].attempts[0].turnId,'new');
 const report={...input,requestId:randomUUID(),summary:'Authenticated current progress'};const result=await f.engine.memberReport('owner',t.id,saved.team.revision,{threadId:'dev',parentThreadId:'leader',cwd:f.cwd},report);assert.equal(result.checkpoint.turnId,'new');validateTeam(await f.saved());await f.engine.close();
});

test('authenticated resumed member reports advance the turn atomically and old checkpoint replays retain their identity',async()=>{
 const f=await fixture(),c=await f.claim('work'),marker=c.dispatch.marker,ctx={threadId:'dev',parentThreadId:'leader',cwd:f.cwd};
 f.set('dev',[turn('old',marker,'inProgress',null)]);await f.bind(c,'dev');let t=await f.saved();
 const input={taskId:'work',attemptId:c.dispatch.attemptId,requestId:randomUUID(),summary:'Original progress'};
 const old=await f.engine.memberReport('owner',t.id,t.revision,ctx,input),original=structuredClone((await f.saved()).checkpoints[0]);
 f.aborted('old');f.set('dev',[turn('old',marker,'interrupted',null),turn('new',marker,'inProgress',null)]);
 const report=await f.engine.memberReport('owner',t.id,old.revision,ctx,{...input,requestId:randomUUID(),summary:'Resumed progress',delivery:marker+'\nCurrent candidate'});
 t=await f.saved();assert.equal(report.checkpoint.turnId,'new');assert.equal(t.tasks[0].attempts[0].turnId,'new');assert.equal(t.requiresTeamWorkspaceVersion,'0.21.0');assert.deepEqual(t.checkpoints[0],original);assert.equal(t.tasks[0].status,'running');assert.equal(t.tasks[1].status,'waiting');
 const calls=f.calls.length,replay=await f.engine.memberReport('owner',t.id,t.revision,ctx,input);assert.equal(replay.checkpoint.turnId,'old');assert.equal(f.calls.length,calls);assert.deepEqual((await f.saved()).checkpoints[0],original);
 for(const mutate of [x=>x.checkpoints[0].turnId='foreign',x=>x.tasks[0].attempts[0].turnHistory[0].statusEvidence.source='unverified',x=>x.requiresTeamWorkspaceVersion='0.18.0']){const invalid=structuredClone(t);mutate(invalid);assert.throws(()=>validateTeam(invalid),/identity|interruption|Historical checkpoints/);}
 await f.engine.close();
});

test('new reports reject interrupted or unacknowledged current turns and authenticate before reading native history',async()=>{
 const f=await fixture(),c=await f.claim('work'),marker=c.dispatch.marker,ctx={threadId:'dev',parentThreadId:'leader',cwd:f.cwd};
 f.set('dev',[turn('old',marker,'inProgress',null)]);await f.bind(c,'dev');const t=await f.saved(),input={taskId:'work',attemptId:c.dispatch.attemptId,requestId:randomUUID(),summary:'Current progress'};
 const before=f.calls.length;await assert.rejects(()=>f.engine.memberReport('owner',t.id,t.revision,{...ctx,parentThreadId:'foreign'},input),/authenticated/);assert.equal(f.calls.length,before);
 f.aborted('old');f.set('dev',[turn('old',marker,'interrupted',null)]);
 await assert.rejects(()=>f.engine.checkpoint('owner',t.id,t.revision,input),/turn is not verified/);
 f.set('dev',[turn('old',marker,'interrupted',null),turn('new','opaque collaboration prompt','inProgress',null)]);
 await assert.rejects(()=>f.engine.memberReport('owner',t.id,t.revision,ctx,input),/turn is not verified/);assert.deepEqual(await f.saved(),t);
 f.set('dev',[turn('old',marker,'interrupted',null),turn('new',marker,'inProgress',null)]);
 const result=await f.engine.memberReport('owner',t.id,t.revision,ctx,input);assert.equal(result.checkpoint.turnId,'new');await f.engine.close();
});

test('phase acceptance retains deferred NOT_RUN evidence, records Leader reasons and cannot relax final acceptance',async()=>{
 const f=await fixture();let t=await f.saved();await f.engine.store.update(t.id,'owner',t.revision,t=>{t.tasks[0].validationMode='source-only';t.tasks[0].acceptanceCriteria=[{id:'spec',description:'Executable specification reviewed'}];});await f.work();
 const c=await f.claim('review'),v=JSON.parse(verdict);v.checks[0].criterionId='spec';v.checks.push({name:'Future implementation checks',criterionId:'spec',status:'NOT_RUN',evidence:'Deferred by specification phase scope'});
 f.set('qa',[turn('review',c.dispatch.marker,'completed',JSON.stringify(v))]);const b=await f.bind(c,'qa'),submitted=await f.engine.settle('owner',t.id,b.team.revision,'review',c.dispatch.attemptId);
 await assert.rejects(()=>f.engine.acceptReview('owner',t.id,submitted.team.revision,'review',c.dispatch.attemptId,'accept','Scoped review'),/unverified/);
 const reasons=[{checkIndex:1,reason:'The confirmed current task reviews specifications only; implementation validation is a later phase'}];
 const accepted=await f.engine.acceptReview('owner',t.id,submitted.team.revision,'review',c.dispatch.attemptId,'accept','Scoped review',[],reasons),a=accepted.team.tasks[1].attempts[0];
 assert.equal(a.deferredCheckExplanations.source,'main-conversation-leader');assert.deepEqual(a.deferredCheckExplanations.items,reasons);assert.deepEqual(JSON.parse(accepted.team.tasks[1].evidence.at(-1).summary),v);assert.equal(accepted.team.requiresTeamWorkspaceVersion,'0.31.0');validateTeam(accepted.team);
 const replay=await f.engine.acceptReview('owner',t.id,submitted.team.revision,'review',c.dispatch.attemptId,'accept','Scoped review',[],reasons);assert.equal(replay.team.revision,accepted.team.revision);
 await assert.rejects(()=>f.engine.finish('owner',t.id,accepted.team.revision,'Final validation',[{name:'future tests',status:'NOT_RUN',evidence:'Still not executed'}]),/missing checks/);
 for(const mutate of [x=>x.requiresTeamWorkspaceVersion='0.18.0',x=>x.tasks[1].attempts[0].deferredCheckExplanations.items[0].checkIndex=0,x=>x.tasks[1].attempts[0].deferredCheckExplanations.targetAttemptId='foreign']){const invalid=structuredClone(accepted.team);mutate(invalid);assert.throws(()=>validateTeam(invalid),/Deferred|deferred/);}
 await f.engine.close();
});
