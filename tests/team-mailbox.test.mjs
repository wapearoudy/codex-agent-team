import test from 'node:test';
import assert from 'node:assert/strict';
import {queueMessage,validateMailbox,acknowledgeMessage} from '../src/team-mailbox.mjs';

function fixture(turnId=null){
  const team={mode:'host-leader',state:'active',members:[{id:'dev'}],tasks:[{id:'work',memberId:'dev',status:'running',attempts:[{id:'original-attempt',agentThreadId:'child',turnId}]}]};
  const message=queueMessage(team,{taskId:'work',text:'Keep all acceptance conditions',requestId:'stable-request'});
  return {team,message,attempt:team.tasks[0].attempts[0]};
}

test('unknown message turns remain readable after the original turn becomes known, including legacy missing fields',()=>{
  const {team,message,attempt}=fixture();validateMailbox(team);attempt.turnId='original-turn';validateMailbox(team);
  delete message.turnId;validateMailbox(team);
  assert.equal(message.status,'queued');assert.equal(message.events.length,1);
  for(const mutate of [m=>{m.turnId='other-turn';},m=>{m.threadId='other-child';},m=>{m.attemptId='other-attempt';},m=>{m.memberId='other-member';},m=>{m.marker='TEAM_WORKSPACE_MESSAGE:other';},m=>{m.turnId='';}]){
    const forged=structuredClone(team);mutate(forged.messages[0]);assert.throws(()=>validateMailbox(forged),/identity mismatch/);
  }
});

test('an unknown message turn cannot be acknowledged from the latest attempt or an unverified original turn',()=>{
  const {team,message,attempt}=fixture();
  const observation={threadId:'child',turnId:'original-turn',messageAcknowledgements:[message.marker]};
  assert.throws(()=>acknowledgeMessage(team,message.id,observation),/No exact/);
  attempt.turnId='original-turn';team.tasks[0].attempts.push({id:'new-attempt',agentThreadId:'child',turnId:'new-turn'});
  const before=structuredClone(team);
  assert.throws(()=>acknowledgeMessage(team,message.id,{...observation,turnId:'new-turn'}),/No exact/);
  assert.throws(()=>acknowledgeMessage(team,message.id,{...observation,threadId:'other-child'}),/No exact/);
  assert.throws(()=>acknowledgeMessage(team,message.id,{...observation,messageAcknowledgements:[]}),/No exact/);
  assert.deepEqual(team,before);
  acknowledgeMessage(team,message.id,observation);validateMailbox(team);
  assert.equal(message.turnId,'original-turn');assert.equal(message.status,'acknowledged');assert.equal(message.attemptId,'original-attempt');
  const events=structuredClone(message.events);acknowledgeMessage(team,message.id,observation);assert.deepEqual(message.events,events);
});

test('validation refuses to turn an acknowledged or resolved record back into an unknown turn',()=>{
  const {team,message,attempt}=fixture('original-turn');message.turnId=null;message.status='acknowledged';
  assert.throws(()=>validateMailbox(team),/identity mismatch/);
  message.status='queued';message.events.push({status:'acknowledged'});assert.throws(()=>validateMailbox(team),/identity mismatch/);
  message.events.pop();message.events.push({type:'turn-bound',turnId:attempt.turnId});assert.throws(()=>validateMailbox(team),/identity mismatch/);
  message.events.pop();validateMailbox(team);
});
