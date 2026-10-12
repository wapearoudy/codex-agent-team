import test from 'node:test';
import assert from 'node:assert/strict';
import {leaderBrief,LEADER_BRIEF_MAX_BYTES} from '../src/leader-brief.mjs';
import {coordinationSignature} from '../src/team-efficiency.mjs';
const task=(id,batchId,status='waiting')=>({id,batchId,status,title:id,goal:'goal',memberId:'dev',dependencies:[],attempts:[{id:id+'-attempt',turnId:id+'-turn',agentThreadId:'native-child'}]});
const fixture=()=>({id:'team',leaderThreadId:'leader',revision:5,state:'active',goal:'team goal',activeBatchId:'current',maxParallel:2,members:[{id:'dev'}],tasks:[task('work','current'),task('done','current','accepted'),task('history','previous','accepted'),task('other-live','previous','running')],batches:[{id:'current',goal:'Current objective'},{id:'previous',goal:'Old objective'}],checkpoints:[],peerMessages:[]});
test('decision brief scopes history, preserves all active identities and never changes saved authority',()=>{
 const t=fixture(),before=structuredClone(t),brief=leaderBrief(t);assert.equal(brief.goal,'Current objective');assert.deepEqual(brief.activeTasks.map(t=>t.taskId),['work','other-live']);assert.equal(brief.activeTasks[0].attemptId,'work-attempt');assert.equal(brief.activeTasks[0].threadId,'native-child');assert.deepEqual(brief.counts,{waiting:1,accepted:1});assert.equal(brief.history.completedInGoal,1);assert.equal(brief.executionAuthority,false);assert.equal(brief.acceptanceAuthority,false);assert.deepEqual(t,before);
});
test('brief is bounded, paginates exact identities and excludes stale checkpoint decisions and raw logs',()=>{
 const t=fixture();t.tasks=Array.from({length:30},(_,i)=>({...task('w'+i,'current'),blockReason:'error'.repeat(400),evidence:[{summary:'PRIVATE_LARGE_LOG'.repeat(1000)}]}));t.batches[0].goal='\u0001'.repeat(5000);
 t.checkpoints=[{id:'valid',taskId:'w0',attemptId:'w0-attempt',turnId:'w0-turn',memberId:'dev',source:'leader-recorded',decisions:['retain boundary']},{id:'stale',taskId:'w0',attemptId:'old',turnId:'old',memberId:'dev',decisions:['STALE_DECISION']}];
 const brief=leaderBrief(t);assert.ok(Buffer.byteLength(JSON.stringify(brief))<=LEADER_BRIEF_MAX_BYTES);assert.equal(brief.goalTruncated,true);assert.equal(brief.hasMore,true);assert.equal(JSON.stringify(brief).includes('PRIVATE_LARGE_LOG'),false);assert.equal(JSON.stringify(brief).includes('STALE_DECISION'),false);
 const ids=[];for(let offset=0;;){const page=leaderBrief(t,{offset});ids.push(...page.activeTasks.map(t=>t.taskId));if(!page.hasMore)break;assert.ok(page.nextOffset>offset);offset=page.nextOffset;}assert.deepEqual(ids,t.tasks.map(t=>t.id));assert.deepEqual(leaderBrief(t),brief);
});
test('unrelated history does not wake coordination; dependencies, other live work and controls still do',()=>{
 const t=fixture(),first=coordinationSignature(t);t.tasks.find(t=>t.id==='history').goal='unrelated revision';t.batches[1].goal='historical note';assert.equal(coordinationSignature(t),first);
 t.tasks[0].dependencies=[{taskId:'history',when:'accepted'}];const dependency=coordinationSignature(t);t.tasks.find(t=>t.id==='history').status='submitted';assert.notEqual(coordinationSignature(t),dependency);
 const live=coordinationSignature(t);t.tasks.find(t=>t.id==='other-live').status='submitted';assert.notEqual(coordinationSignature(t),live);const control=coordinationSignature(t);t.dispatchPaused=true;assert.notEqual(coordinationSignature(t),control);
 const permissions=coordinationSignature(t);t.members[0].writeScopes=['src'];assert.notEqual(coordinationSignature(t),permissions);const route=coordinationSignature(t);t.members[0].activeRoute={model:'explicitly-approved'};assert.notEqual(coordinationSignature(t),route);
});
