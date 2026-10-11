import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeTeamProjection} from '../src/native-team-projection.mjs';
test('native UI projection selects authenticated current Leader and exposes only exact verified child bindings',()=>{
  const context={threadId:'leader'},team={id:'team',leaderThreadId:'leader',revision:2,goal:'Goal',state:'active',activeBatchId:'batch',members:[{id:'dev',role:'Dev',agentThreadId:'child',rosterVerified:true}],tasks:[{id:'old',batchId:'old',memberId:'dev',status:'accepted',attempts:[]},{id:'t',batchId:'batch',number:7,title:'Task',memberId:'dev',status:'running',dependencies:[{taskId:'old',when:'accepted'}],attempts:[{id:'a',agentThreadId:'child',turnId:'turn'}]}]},run={attemptId:'a',threadId:'child',parentThreadId:'leader',turnId:'turn',status:'inProgress'};
  const p=nativeTeamProjection(context,'deepseek-harness',team,[run]);assert.equal(p.source,'team-workspace-engine');assert.equal(p.team.tasks.length,1);assert.equal(p.team.tasks[0].number,7);assert.equal(p.team.tasks[0].ownerMemberId,'dev');assert.deepEqual(p.team.tasks[0].blockedBy,[]);assert.equal(p.team.members[0].nativeSessionId,'child');
  for(const changed of [{threadId:'foreign'},{parentThreadId:'other'},{turnId:'old'},{error:'unavailable'},{observationIssue:'ambiguous'},{observationError:'missing rollout'}]){const member=nativeTeamProjection(context,'deepseek-harness',team,[{...run,...changed}]).team.members[0];assert.equal(member.bindingVerified,false);assert.equal(member.nativeSessionId,null);}
  assert.throws(()=>nativeTeamProjection({threadId:'forged'},'deepseek-harness',team,[run]),/actual current Leader/);assert.equal(nativeTeamProjection(context,'deepseek-harness',null).team,null);
});
