import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePlan,createTeam,schedule,pauseDispatch,resumeDispatch,bindMemberThread,submitTask,reviewTask} from '../src/team.mjs';
const plan=()=>({members:[
  {id:'impl',role:'Implementation',responsibility:'Implement bounded API change',reason:'Owns the API slice',writeScopes:['src/api']},
  {id:'review',role:'Independent review',responsibility:'Review submitted change',reason:'Independent quality check',writeScopes:[]},
  {id:'docs',role:'Documentation',responsibility:'Update API guide',reason:'Separate documentation deliverable',writeScopes:['docs']}
],tasks:[
  {id:'code',title:'Implement endpoint',goal:'Add bounded endpoint behavior',acceptance:'Focused endpoint check passes',memberId:'impl',priority:1,dependencies:[]},
  {id:'review-code',kind:'review',reviewOfTaskId:'code',title:'Review endpoint',goal:'Inspect submitted endpoint diff',acceptance:'Independent review passes',memberId:'review',priority:1,dependencies:[{taskId:'code',when:'submitted'}]},
  {id:'docs-task',title:'Document endpoint',goal:'Document accepted public behavior',acceptance:'Guide matches implementation',memberId:'docs',priority:2,dependencies:[{taskId:'code',when:'accepted'}]}
]});
test('plan validation rejects cycles, missing owners, unsafe scopes and duplicate IDs',()=>{
  const p=plan();assert.equal(validatePlan(p),true);
  assert.throws(()=>validatePlan({...p,tasks:p.tasks.map(t=>t.id==='code'?{...t,dependencies:[{taskId:'docs-task',when:'accepted'}]}:t)}),/cycle/);
  assert.throws(()=>validatePlan({...p,tasks:p.tasks.map(t=>t.id==='code'?{...t,memberId:'missing'}:t)}),/member/);
  assert.throws(()=>validatePlan({...p,members:[{...p.members[0],writeScopes:['../outside']},...p.members.slice(1)]}),/safe/);
  assert.throws(()=>validatePlan({...p,tasks:[p.tasks[0],{...p.tasks[1],id:'code'},p.tasks[2]]}),/unique/);
});
test('scheduler starts only tasks whose dependencies have been accepted',()=>{
  const team=createTeam({projectId:'p',projectPath:'C:/repo',goal:'Implement a bounded API change',plan:plan()});
  assert.deepEqual(schedule(team).map(t=>t.id),['code']);
});
test('dependencies unlock at submitted or accepted milestones and reviewer rework keeps evidence',()=>{
  const p=plan(),team=createTeam({projectId:'p',projectPath:'C:/repo',goal:'Implement a bounded API change',plan:p});
  assert.deepEqual(schedule(team).map(t=>t.id),['code']);
  pauseDispatch(team);assert.deepEqual(resumeDispatch(team),[]);
  const first=team.tasks.find(t=>t.id==='code');bindMemberThread(team,'code','thread-code',first.attempts.at(-1).id);
  submitTask(team,'code',{attemptId:first.attempts.at(-1).id,summary:'Endpoint committed in isolated worktree',evidence:[{kind:'diff',ref:'commit:abc'}]});
  assert.deepEqual(schedule(team).map(t=>t.id),['review-code']);
  assert.equal(team.tasks.find(t=>t.id==='docs-task').status,'waiting');
  bindMemberThread(team,'review-code','thread-review',team.tasks[1].attempts.at(-1).id);submitTask(team,'review-code',{attemptId:team.tasks[1].attempts.at(-1).id,summary:'Review found missing negative case',evidence:[{kind:'review',ref:'attempt:1'}]});
  const invalidated=reviewTask(team,'review-code',{attemptId:team.tasks[1].attempts.at(-1).id,decision:'rework',note:'Add the missing negative case'});
  assert.deepEqual(invalidated,['review-code','docs-task']);assert.equal(first.evidence.length,1);assert.equal(first.attempt,1);
  assert.equal(team.tasks.find(t=>t.id==='review-code').status,'waiting');
  const afterReview=schedule(team);
  assert.equal(afterReview.some(t=>t.id==='docs-task'),false);
  const rework=afterReview.find(t=>t.id==='code');
  assert.equal(rework.attempt,2);assert.equal(rework.attempts.length,2);
});
test('overlapping write scopes serialize instead of inflating parallelism',()=>{
  const p=plan();p.members[2].writeScopes=['src/api/generated'];p.tasks[2].dependencies=[];
  const team=createTeam({projectId:'p',projectPath:'C:/repo',goal:'Implement a bounded API change',plan:p});
  assert.deepEqual(schedule(team).map(t=>t.id),['code']);
});
