import {randomUUID} from 'node:crypto';

export function queuePeerMessage(team,{senderMemberId,senderThreadId,attemptId,toMemberId,text,requestId}) {
  const sender=team.members.find(m=>m.id===senderMemberId);
  if(!sender||sender.agentThreadId!==senderThreadId)throw new Error('Only the authenticated current member attempt may send');
  const recipient=toMemberId==='leader'?null:team.members.find(m=>m.id===toMemberId);
  if(toMemberId!=='leader'&&(!recipient?.agentThreadId||recipient.id===sender.id))throw new Error('Recipient must be a different bound team member or leader');
  if(typeof text!=='string'||!text.trim()||text.length>4000||!/^[a-f0-9-]{36}$/i.test(requestId))throw new Error('A message and stable request ID are required');
  const payload={senderMemberId,senderThreadId,attemptId,toMemberId,text:text.trim(),requestId};
  team.peerMessages??=[];const prior=team.peerMessages.find(m=>m.requestId===requestId);
  if(prior){if(Object.keys(payload).some(k=>payload[k]!==prior[k]))throw new Error('Message request ID has different contents');return prior;}
  const task=team.tasks.find(t=>t.memberId===senderMemberId&&t.status==='running'&&t.attempts.at(-1)?.id===attemptId);
  if(!task||task.attempts.at(-1).agentThreadId!==senderThreadId)throw new Error('Only the authenticated current member attempt may send');
  const recipientTask=recipient?team.tasks.find(t=>t.memberId===recipient.id&&t.status==='running'):null,recipientAttempt=recipientTask?.attempts.at(-1);
  const id=randomUUID(),record={...payload,id,taskId:task.id,marker:'TEAM_WORKSPACE_PEER:'+id,recipientThreadId:recipient?.agentThreadId??team.leaderThreadId,recipientAttemptId:recipientAttempt?.id??null,recipientTurnId:recipientAttempt?.turnId??null,status:'queued',createdAt:new Date().toISOString(),events:[]};
  team.peerMessages.push(record);return record;
}
export function peerInbox(team,threadId,{after=0}={}) {
  if(!Number.isInteger(after)||after<0)throw new Error('Invalid inbox cursor');
  const messages=(team.peerMessages??[]).filter(m=>m.recipientThreadId===threadId);
  return {messages:messages.slice(after,after+100),cursor:Math.min(messages.length,after+100),hasMore:messages.length>after+100};
}
export function acknowledgePeerMessage(team,{messageId,threadId,turnId,attemptId}) {
  const m=team.peerMessages?.find(m=>m.id===messageId);
  if(!m||m.recipientThreadId!==threadId||(!turnId&&threadId!==team.leaderThreadId))throw new Error('Only the original authenticated recipient can acknowledge');
  if((m.recipientAttemptId&&m.recipientAttemptId!==attemptId)||(m.recipientTurnId&&m.recipientTurnId!==turnId))throw new Error('Receipt belongs to another recipient attempt or turn');
  if(m.status==='acknowledged')return m;
  m.status='acknowledged';m.acknowledgedTurnId=turnId??null;m.events.push({at:new Date().toISOString(),source:threadId===team.leaderThreadId?'authenticated-leader-inbox':'authenticated-recipient',turnId:turnId??null,status:'acknowledged'});return m;
}
export function peerActions(team) {
  return (team.peerMessages??[]).filter(m=>m.status==='queued').map(m=>({messageId:m.id,threadId:m.recipientThreadId,agentPath:team.members.find(x=>x.agentThreadId===m.recipientThreadId)?.agentPath??null,
    text:m.marker+'\nFrom '+m.senderMemberId+': '+m.text+'\nRead your team inbox and acknowledge this exact message ID.',action:m.toMemberId==='leader'?'leader-inbox':'send-native-message',note:'Leader controls delivery; reading this queue never sends or retries a message.'}));
}
export function recordPeerDelivery(team,{messageId,status,note,source='leader-host-tool'}) {
  const m=team.peerMessages?.find(m=>m.id===messageId);if(!m)throw new Error('Peer message not found');
  if(!['host-accepted','unknown','failed'].includes(status)||!note?.trim())throw new Error('A real host delivery outcome is required');
  if(m.status==='acknowledged')return m;
  if(m.status==='host-accepted'&&status!=='host-accepted')throw new Error('Accepted delivery cannot be downgraded');
  m.status=status;m.events.push({at:new Date().toISOString(),status,note,source});return m;
}
