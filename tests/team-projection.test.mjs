import test from 'node:test';
import assert from 'node:assert/strict';
import {memberState,memberExecutions,dependencyFamily,taskDisplayState,runIsActive,memberHasWork,orderedMembers,taskRelationships,memberWorkSummary} from '../src/team-projection.mjs';
import {authorizeTeam} from '../src/host-context.mjs';

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
