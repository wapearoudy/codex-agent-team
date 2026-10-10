import test from 'node:test';
import assert from 'node:assert/strict';
import {memberState,memberExecutions,dependencyFamily,taskDisplayState,runIsActive,mergeRunObservation,failedRunObservation,memberHasWork,orderedMembers,taskRelationships,memberWorkSummary} from '../src/team-projection.mjs';
import {authorizeTeam} from '../src/host-context.mjs';
import {workflowActions} from '../src/team-workflow.mjs';

test('fresh native snapshot is running in both task and member views; stale activity is not online',()=>{
  const member={id:'dev',agentThreadId:'child'},task={id:'work',memberId:'dev',status:'running',attempts:[{id:'attempt',state:'running'}]};
  const run={taskId:'work',memberId:'dev',attemptId:'attempt',status:'inProgress',connection:'snapshot',source:'native-thread-persisted-snapshot',statusEvidence:{freshUntil:new Date(Date.now()+60000).toISOString()}};
  assert.equal(runIsActive(run),true);assert.equal(taskDisplayState(task,[run]),'running');assert.equal(memberState(member,[task],[run]),'running');
  run.status='unknown';assert.equal(taskDisplayState(task,[run]),'unknown');assert.equal(memberState(member,[task],[run]),'unknown');
  task.status='waiting';member.rosterVerified=true;assert.equal(memberState(member,[task],[]),'idle');
});

test('historical unknown execution cannot hide a new active attempt; cancelled is not accepted',()=>{
  const member={id:'a'},tasks=[{id:'t',memberId:'a',status:'running',attempts:[{id:'old',number:1},{id:'new',number:2}]}];
  const runs=[{taskId:'t',memberId:'a',attemptId:'old',status:'unknown',threadId:'thread-old'},{taskId:'t',memberId:'a',attemptId:'new',status:'inProgress',connection:'connected',threadId:'thread-new'}];
  assert.equal(memberState(member,tasks,runs),'running');assert.equal(memberExecutions(member,tasks,runs).length,2);
  runs[1].connection='disconnected';assert.equal(memberState(member,tasks,runs),'unknown');
  runs[1].status='completed';tasks[0].status='cancelled';assert.equal(memberState(member,tasks,runs),'cancelled');
});
test('dependency focus includes transitive ancestors and descendants but not siblings',()=>{
  const tasks=[{id:'a',dependencies:[]},{id:'b',dependencies:[{taskId:'a'}]},{id:'c',dependencies:[{taskId:'b'}]},{id:'d',dependencies:[{taskId:'c'}]},{id:'sibling',dependencies:[{taskId:'a'}]}];
  assert.deepEqual([...dependencyFamily(tasks,'c')].sort(),['a','b','c','d']);
});
test('project guard rejects changed project after owner lookup',async()=>{
  let seen;const store={get:async(id,owner)=>{seen=[id,owner];return{projectPath:'E:\\project-a'};}};
  await assert.rejects(authorizeTeam({owner:'owner',context:{cwd:'E:\\project-b'},store,teamId:'id'}),/跨项目/);
  assert.deepEqual(seen,['id','owner']);assert.equal(await authorizeTeam({owner:'owner',context:{cwd:'E:\\project-a'},store,teamId:'id'}),'owner');
});
test('unfinished members stay visible, finished members sort by real end time with stable ties',()=>{
  const members=['a','b','c','d'].map(id=>({id,agentThreadId:id}));
  const tasks=[{id:'a',memberId:'a',status:'accepted',attempts:[{endedAt:'2026-01-01'}]}, {id:'b',memberId:'b',status:'accepted',attempts:[{endedAt:'2026-01-03'}]},
    {id:'c',memberId:'c',status:'waiting',attempts:[]},{id:'d',memberId:'d',status:'submitted',attempts:[]}];
  assert.deepEqual(orderedMembers({members,tasks},[]).map(r=>r.member.id),['c','d','b','a']);
  assert.equal(memberHasWork(members[2],tasks),true);assert.equal(memberHasWork(members[3],tasks),true);assert.equal(memberHasWork(members[0],tasks),false);
});
test('dependency explanations distinguish submission from acceptance and include actual owner',()=>{
  const team={members:[{id:'a',role:'开发'},{id:'b',role:'测试'}],tasks:[{id:'a',memberId:'a',title:'开发任务',status:'submitted',dependencies:[],attempts:[]},{id:'b',memberId:'b',title:'测试任务',status:'waiting',dependencies:[{taskId:'a',when:'accepted'}],attempts:[]}]};
  assert.equal(taskRelationships(team,team.tasks[1]).waiting[0].memberLabel,'开发');
  assert.match(memberWorkSummary(team,team.members[1],[]).text,/等待 a（开发）验收/);
  team.tasks[1].dependencies[0].when='submitted';assert.equal(taskRelationships(team,team.tasks[1]).waiting.length,0);
  assert.match(memberWorkSummary(team,team.members[0],[]).text,/等待独立审查/);
});

test('observation merging preserves newer samples and terminal evidence, but allows a verified continuation and a new attempt',()=>{
 const previous={taskId:'work',attemptId:'a',threadId:'child',turnId:'old',status:'interrupted',observedAt:'2026-10-10T10:00:00Z',outputs:[{text:'Original turn'}]};
 assert.equal(mergeRunObservation(previous,{...previous,status:'unknown',observedAt:'2026-10-10T10:01:00Z'}).status,'interrupted');
 assert.equal(mergeRunObservation(previous,{...previous,status:'inProgress',observedAt:'2026-10-10T09:59:00Z'},{saved:true}).status,'interrupted');
 const resumed={...previous,turnId:'new',status:'inProgress',observedAt:'2026-10-10T10:02:00Z',continuation:{turns:[{turnId:'old',status:'interrupted'},{turnId:'new',status:'inProgress'}]}};assert.equal(mergeRunObservation(previous,resumed).status,'inProgress');
 assert.equal(mergeRunObservation(previous,{...resumed,continuation:undefined}).turnId,'old');assert.equal(mergeRunObservation(previous,{...resumed,attemptId:'new-attempt',threadId:'new-child'}).attemptId,'new-attempt');
});

test('record silence is displayed separately from an unverifiable identity and never renews activity',()=>{
 const member={id:'dev'},task={id:'work',memberId:'dev',status:'running',attempts:[{id:'a',state:'running',agentThreadId:'child'}]};
 const run={taskId:'work',memberId:'dev',attemptId:'a',threadId:'child',turnId:'turn',status:'unknown',connection:'snapshot',source:'native-thread-persisted-snapshot',statusEvidence:{status:'unknown',source:'persisted-native-activity-stale',freshUntil:new Date(Date.now()-1000).toISOString()}};
 assert.equal(runIsActive(run),false);assert.equal(taskDisplayState(task,[run]),'observed');assert.equal(memberState(member,[task],[run]),'observed');assert.equal(memberExecutions(member,[task],[run])[0].status,'observed');
 assert.equal(task.status,'running','a stale observation must not change the business task');
 assert.deepEqual(workflowActions({state:'active',members:[member],tasks:[task]},[run]).actions,[],'record delay cannot accept, settle or redispatch a task');
 const invalid={...run,statusEvidence:{status:'unknown',source:'persisted-native-activity-invalid-time'}};
 assert.equal(taskDisplayState(task,[invalid]),'unknown');assert.equal(memberState(member,[task],[invalid]),'unknown');
});

test('a transient read failure retains only unexpired exact-turn evidence; verification failures invalidate it immediately',()=>{
 const stamp=Date.now(),freshUntil=new Date(stamp+1000).toISOString();
 const previous={taskId:'work',attemptId:'a',threadId:'child',turnId:'turn',status:'inProgress',connection:'snapshot',source:'native-thread-persisted-snapshot',observedAt:new Date(stamp-2000).toISOString(),statusEvidence:{status:'inProgress',source:'persisted-native-activity',freshUntil},activity:{cursor:5},outputs:[{text:'Keep evidence'}]};
 const error=Object.assign(new Error('Execution connection closed'),{code:'NATIVE_RPC_UNAVAILABLE'});
 const failed=failedRunObservation(previous,error);
 assert.equal(failed.status,'inProgress');assert.equal(failed.statusEvidence.freshUntil,freshUntil);assert.equal(failed.observedAt,previous.observedAt);assert.equal(failed.observationIssue.kind,'transport-unavailable');assert.equal(runIsActive(failed,stamp+1001),false);
 const stale={...previous,status:'unknown',observedAt:new Date(stamp).toISOString(),statusEvidence:{...previous.statusEvidence,freshUntil:new Date(stamp-1).toISOString()}};
 const recovered=mergeRunObservation(previous,failedRunObservation(stale,error));
 assert.equal(recovered.status,'inProgress');assert.equal(recovered.activity.cursor,5);assert.equal(recovered.statusEvidence.freshUntil,freshUntil);
 assert.equal(mergeRunObservation(previous,{...failedRunObservation(stale,error),turnId:'other'}).observationIssue,undefined,'unassociated turns cannot carry cached evidence');
 assert.equal(failedRunObservation(previous,new Error('Member workspace does not match the current project')).status,'unknown');
 const rejected=failedRunObservation(stale,new Error('Member workspace does not match the current project'));
 assert.equal(mergeRunObservation(previous,{...rejected,activity:{cursor:0}}).status,'unknown','a regressed log cursor cannot hide a fresh identity verification failure');
 const restored=mergeRunObservation(failed,{...previous,observedAt:new Date(stamp+1).toISOString()});assert.equal(restored.observationIssue,null);assert.equal(restored.observationError,null);
 const expired=failedRunObservation({...previous,statusEvidence:{...previous.statusEvidence,freshUntil:new Date(stamp-1).toISOString()}},error);assert.equal(expired.status,'unknown');assert.equal(runIsActive(expired),false);
});

test('missing public logs cannot hide a newer confirmed native completion',()=>{
 const previous={taskId:'work',attemptId:'a',threadId:'child',turnId:'turn',status:'inProgress',observedAt:'2026-10-10T08:00:00Z',activity:{cursor:20,events:[{text:'Earlier public log'}]},usage:{totalTokens:100}};
 const incoming={...previous,status:'completed',observedAt:'2026-10-10T08:00:01Z',activity:{cursor:0,source:'unavailable'},usage:null,outputs:[{text:'Final delivery'}]};
 const merged=mergeRunObservation(previous,incoming);assert.equal(merged.status,'completed');assert.equal(merged.outputs[0].text,'Final delivery');assert.equal(merged.activity.cursor,20);assert.equal(merged.usage.totalTokens,100);
 assert.equal(mergeRunObservation(previous,{...incoming,observedAt:'2026-10-10T07:59:59Z'}).status,'inProgress','an older sample still cannot overwrite the current observation');
});
