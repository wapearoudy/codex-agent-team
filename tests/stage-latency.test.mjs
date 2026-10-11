import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnostics} from '../src/team-diagnostics.mjs';
test('stage timings use exact saved native timestamps and retain unavailable UI/model observations',()=>{
  const at=n=>new Date(1700000000000+n).toISOString(),team={tasks:[{id:'t',createdAt:at(0),attempts:[{id:'a',startedAt:at(20),boundAt:at(50),endedAt:at(200),acceptance:{at:at(300)},observation:{activity:{events:[{type:'agent_message',at:at(70)},{type:'task_complete',at:at(150)}]},usage:{totalTokens:12}}}]}],events:[{type:'task-dispatched',taskId:'t',attemptId:'a',at:at(20)}]};
  const stage=diagnostics(team).stages[0];assert.equal(stage.planningToReservationMs,20);assert.equal(stage.reservationToBindMs,30);assert.equal(stage.bindToFirstPublicActivityMs,20);assert.equal(stage.nativeCompletionToSettlementMs,50);assert.equal(stage.submissionToAcceptanceMs,100);assert.equal(stage.observedTokens,12);assert.equal(stage.panelRenderDelayMs,null);
  delete team.tasks[0].attempts[0].observation;const absent=diagnostics(team).stages[0];assert.equal(absent.observedTokens,null);assert.equal(absent.bindToFirstPublicActivityMs,null);assert.equal(absent.nativeCompletionToSettlementMs,null);
});
