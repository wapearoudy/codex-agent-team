import test from 'node:test';
import assert from 'node:assert/strict';
import {queueMessage,messageAction,recordMessageDelivery,acknowledgeMessage,validateMailbox} from '../src/team-mailbox.mjs';
const fixture=()=>({mode:'host-leader',state:'active',members:[{id:'m',agentPath:'/root/m'}],tasks:[{id:'t',memberId:'m',status:'running',attempts:[{id:'a',agentThreadId:'child',turnId:'turn'}]}]});
test('delivery uncertainty never becomes member acknowledgement or an automatic resend',()=>{
  const t=fixture(),m=queueMessage(t,{taskId:'t',text:'inspect',requestId:'r'});
  recordMessageDelivery(t,m.id,'unknown','Transport returned no confirmed result');
  assert.equal(messageAction(t,m).type,'verify-message-before-retry');assert.equal(m.status,'unknown');
  assert.throws(()=>acknowledgeMessage(t,m.id,{threadId:'foreign',turnId:'turn',messageAcknowledgements:[m.marker]}),/No exact/);
  recordMessageDelivery(t,m.id,'host-accepted','Host accepted request');assert.equal(m.status,'host-accepted');
  assert.throws(()=>recordMessageDelivery(t,m.id,'failed','late contradictory report'),/downgraded/);
  acknowledgeMessage(t,m.id,{threadId:'child',turnId:'turn',messageAcknowledgements:[m.marker],observedAt:'now'});assert.equal(m.status,'acknowledged');
  validateMailbox(t);m.turnId='wrong';assert.throws(()=>validateMailbox(t),/identity/);
});
test('messages do not activate an idle or unbound member',()=>{
  const t=fixture();assert.throws(()=>queueMessage(t,{taskId:'t',text:'wake'}),/requestId/);t.tasks[0].status='submitted';assert.throws(()=>queueMessage(t,{taskId:'t',text:'wake',requestId:'r'}),/active/);
  t.tasks[0].status='running';t.tasks[0].attempts[0].agentThreadId=null;assert.throws(()=>queueMessage(t,{taskId:'t',text:'wake',requestId:'r'}),/active/);
});
