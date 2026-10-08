import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {ProjectTeams} from '../src/project-teams.mjs';
import {teamResponse} from '../src/team-responses.mjs';

const member=(id,writeScopes=[])=>({id,role:id,responsibility:'Own '+id,reason:'Additional expertise',writeScopes});
const tasks=(id,memberId)=>[
  {id,title:'Implement '+id,goal:'Deliver '+id,acceptance:'Checks pass',memberId,kind:'work',dependencies:[]},
  {id:'review-'+id,title:'Review '+id,goal:'Verify '+id,acceptance:'Checks pass',memberId:'qa',kind:'review',reviewOfTaskId:id,dependencies:[{taskId:id,when:'submitted'}]}
];
async function fixture({initialize=true}={}){
  const root=await mkdtemp(join(tmpdir(),'team-member-addition-')),cwd=join(root,'project');await mkdir(cwd);
  const runs=new Map(),observer={calls:0,async inspect(leader,project,thread,marker){this.calls++;assert.equal(leader,'leader');assert.equal(project,cwd);const run=runs.get(marker);if(!run||run.threadId!==thread)throw new Error('No verified native member');return structuredClone(run);}};
  const engine=new LeaderEngine({root:join(root,'records'),observer}),projects=new ProjectTeams(engine);
  const {team}=await projects.plan('owner',{cwd,threadId:'leader'},{goal:'Implement a scoped project change',execute:true,maxParallel:3,plan:{members:[member('dev',['src']),member('qa')],tasks:tasks('work','dev')}});
  const f={engine,projects,team,runs,observer,cwd,root};
  f.saved=()=>engine.store.get(team.id,'owner');
  f.bind=async(id,status='completed')=>{const t=await f.saved(),m=t.members.find(m=>m.id===id);runs.set(m.rosterMarker,{threadId:'child-'+id,agentPath:'/root/'+id,turnId:status==='completed'?'init-'+id:null,status,outputs:[],commands:[]});return engine.bindRoster('owner',t.id,t.revision,id,'child-'+id);};
  f.add=async(members,requestId=randomUUID(),revision)=>engine.addMembers('owner',team.id,revision??(await f.saved()).revision,members,requestId);
  f.claim=async(id)=>{const t=await f.saved();return engine.claim('owner',t.id,t.revision,id);};
  if(initialize){await f.bind('dev');await f.bind('qa');}
  return f;
}

test('adding roles preserves active native execution, existing history and project team identity',async()=>{
  const f=await fixture(),claimed=await f.claim('work');
  f.runs.set(claimed.dispatch.marker,{threadId:'child-dev',turnId:'work-turn',status:'inProgress',outputs:[],commands:[]});
  await f.engine.bind('owner',f.team.id,claimed.team.revision,'work',claimed.dispatch.attemptId,'child-dev');
  const before=await f.saved(),calls=f.observer.calls;
  const added=await f.add([{...member('docs',['docs']),route:{model:'configured-model',reasoningEffort:'high'},agentThreadId:'forged',rosterVerified:true,status:'running'},member('security')]);
  assert.equal(f.observer.calls,calls,'registering roles never starts or observes native agents');
  assert.equal(added.team.id,before.id);assert.equal(added.team.revision,before.revision+1);
  assert.deepEqual(added.team.members.slice(0,2).map(m=>({id:m.id,thread:m.agentThreadId,status:m.status,marker:m.rosterMarker})),before.members.map(m=>({id:m.id,thread:m.agentThreadId,status:m.status,marker:m.rosterMarker})));
  assert.deepEqual(added.team.tasks,before.tasks);assert.equal(added.team.totalDispatches,before.totalDispatches);
  assert.equal(added.team.dispatchPaused,before.dispatchPaused);assert.equal(added.team.state,before.state);
  assert.deepEqual(added.memberAddition.memberIds,['docs','security']);assert.equal(added.memberAddition.replayed,false);
  assert.deepEqual(added.initializations.map(m=>m.memberId),['docs','security']);
  assert.ok(added.initializations.every(m=>m.action==='spawn-native-member'&&m.threadId===null));
  assert.deepEqual(added.initializations[0].spawnOptions,{fork_turns:'none',model:'configured-model',reasoning_effort:'high'});
  assert.equal(added.team.members[2].rosterVerified,false);assert.equal(new Set(added.team.members.map(m=>m.rosterMarker)).size,4);
  assert.equal((await f.projects.current('owner',{cwd:f.cwd})).id,before.id);
  const compact=teamResponse(added,'summary','team-update');assert.deepEqual(compact.memberAddition,added.memberAddition);assert.equal(compact.initializations.length,2);
});

test('identical concurrent retries and retries after restart do not duplicate roles or markers',async()=>{
  const f=await fixture(),requestId=randomUUID(),before=await f.saved(),input=[member('docs',['docs'])];
  const results=await Promise.all([f.add(input,requestId,before.revision),f.add(input,requestId,before.revision)]);
  assert.deepEqual(results.map(r=>r.memberAddition.replayed).sort(),[false,true]);
  const saved=await f.saved();assert.equal(saved.revision,before.revision+1);assert.equal(saved.members.length,3);assert.equal(saved.memberAdditions.length,1);
  const restarted=new LeaderEngine({root:join(f.root,'records'),observer:f.observer});
  const replay=await restarted.addMembers('owner',saved.id,before.revision,input,requestId);
  assert.equal(replay.memberAddition.replayed,true);assert.equal(replay.initializations[0].marker,saved.members[2].rosterMarker);
  assert.deepEqual(await f.saved(),saved);
  await assert.rejects(()=>f.add([member('different')],requestId),/different contents/);
  await assert.rejects(()=>f.add([{...input[0],responsibility:'Changed responsibility'}],requestId),/different contents/);
  assert.deepEqual(await f.saved(),saved);
});

test('invalid batches, duplicate IDs, stale revisions and excess capacity leave the whole roster unchanged',async()=>{
  const f=await fixture(),before=await f.saved();
  for(const input of [[member('docs'),member('dev')],[member('docs'),member('docs')],[member('docs',['../outside'])],[{...member('docs'),responsibility:' '}],Array.from({length:7},(_,i)=>member('extra'+i))]){
    await assert.rejects(()=>f.add(input),/unique|safe|required|1–8/);assert.deepEqual(await f.saved(),before);
  }
  await assert.rejects(()=>f.add([member('docs')],randomUUID(),before.revision-1),/changed/);
  await assert.rejects(()=>f.engine.addMembers('other',before.id,before.revision,[member('docs')],randomUUID()),/not found/);
  await assert.rejects(()=>f.add([member('docs')],'unstable'),/UUID/);assert.deepEqual(await f.saved(),before);
  const full=await f.add(Array.from({length:6},(_,i)=>member('extra'+i)));assert.equal(full.team.members.length,8);
  const fullBefore=await f.saved();await assert.rejects(()=>f.add([member('overflow')]),/1–8/);assert.deepEqual(await f.saved(),fullBefore);
  assert.equal((await f.saved()).revision,full.team.revision);
});

test('a competing roster update is fenced and can be retried with the latest revision',async()=>{
  const f=await fixture(),before=await f.saved(),a=randomUUID(),b=randomUUID();
  const results=await Promise.allSettled([f.add([member('docs')],a,before.revision),f.add([member('security')],b,before.revision)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
  assert.match(results.find(r=>r.status==='rejected').reason.message,/changed/);
  const failed=results[0].status==='rejected'?{id:'docs',requestId:a}:{id:'security',requestId:b};
  const retried=await f.add([member(failed.id)],failed.requestId);assert.equal(retried.team.members.length,4);assert.equal(retried.team.memberAdditions.length,2);
});

test('new uninitialized roles block only their own tasks and join execution on the same bound thread',async()=>{
  const f=await fixture(),added=await f.add([member('docs',['docs'])]);
  const appended=await f.engine.addTasks('owner',f.team.id,added.team.revision,tasks('guide','docs'));
  const docs=appended.readiness.find(r=>r.taskId==='guide');assert.equal(docs.ready,false);assert.ok(docs.blockers.some(b=>b.code==='member-initialization'));
  assert.equal(appended.readiness.find(r=>r.taskId==='work').ready,true);
  assert.ok(appended.workflow.actions.some(a=>a.type==='claim-batch'&&a.taskIds.includes('work')&&!a.taskIds.includes('guide')));
  const before=await f.saved();
  await assert.rejects(()=>f.engine.claimMany('owner',before.id,before.revision,['work','guide']),/Initialize and bind/);assert.deepEqual(await f.saved(),before);
  const work=await f.claim('work');assert.equal(work.dispatch.existingThreadId,'child-dev');
  await f.bind('docs','starting');
  const pending=await f.saved();await assert.rejects(()=>f.claim('guide'),/initialization is not complete/);assert.deepEqual(await f.saved(),pending);
  const marker=pending.members.find(m=>m.id==='docs').rosterMarker;f.runs.set(marker,{threadId:'child-docs',turnId:'init-docs',status:'completed',outputs:[],commands:[]});
  const guide=await f.claim('guide');assert.equal(guide.dispatch.action,'followup-native-member');assert.equal(guide.dispatch.existingThreadId,'child-docs');
  assert.equal(guide.team.members.find(m=>m.id==='docs').rosterVerified,true);
  assert.equal(guide.team.tasks.find(t=>t.id==='work').attempts.at(-1).id,work.dispatch.attemptId);
  f.runs.set(marker,{threadId:'child-qa',turnId:'wrong',status:'completed'});
  await assert.rejects(()=>f.engine.bindRoster('owner',guide.team.id,guide.team.revision,'docs','child-qa'),/existing|distinct/);
});

test('founding members must still all initialize before the first task can dispatch',async()=>{
  const f=await fixture({initialize:false});await f.bind('dev');await f.add([member('docs')]);
  await assert.rejects(()=>f.claim('work'),/Initialize and bind/);
  await f.bind('qa');const claimed=await f.claim('work');assert.equal(claimed.dispatch.existingThreadId,'child-dev');
});

test('role-only expansion preserves delivery and pause; later tasks reopen the same team',async()=>{
  const f=await fixture(),t=await f.saved();
  await f.engine.store.update(t.id,'owner',t.revision,s=>{s.tasks.forEach(t=>t.status='accepted');s.state='delivered';s.dispatchPaused=true;s.finalAcceptance={source:'main-conversation-leader',note:'previous release',checks:[{name:'check',status:'PASS',evidence:'fixture'}]};});
  const before=await f.saved(),added=await f.add([member('docs',['docs'])]);
  assert.equal(added.team.state,'delivered');assert.equal(added.team.dispatchPaused,true);assert.deepEqual(added.team.finalAcceptance,before.finalAcceptance);
  const reopened=await f.engine.addTasks('owner',t.id,added.team.revision,tasks('guide','docs'));
  assert.equal(reopened.team.id,t.id);assert.equal(reopened.team.state,'active');assert.equal(reopened.team.dispatchPaused,false);
  assert.deepEqual(reopened.team.acceptanceHistory,[before.finalAcceptance]);assert.deepEqual(reopened.team.tasks.slice(0,2),before.tasks);
});

test('historical and legacy teams cannot be expanded or claimed through replay',async()=>{
  const f=await fixture(),requestId=randomUUID();await f.add([member('docs')],requestId);const before=await f.saved();
  await f.engine.store.update(before.id,'owner',before.revision,t=>{t.state='superseded';});
  await assert.rejects(()=>f.add([member('docs')],requestId),/historical/);
  await assert.rejects(()=>f.add([member('security')]),/historical/);
  const legacy=await f.engine.planOnce('owner',{cwd:f.cwd,threadId:'leader'},{goal:'Legacy native team test',execute:true,plan:{members:[member('dev'),member('qa')],tasks:tasks('work','dev')}});
  await assert.rejects(()=>f.engine.addMembers('owner',legacy.id,legacy.revision,[member('docs')],randomUUID()),/fixed native roster/);
});
