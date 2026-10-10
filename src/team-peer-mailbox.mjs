import {randomUUID,createHash} from 'node:crypto';

export function queuePeerMessage(team,{senderMemberId,senderThreadId,attemptId,toMemberId,text,requestId,kind='action'}) {
  const sender=team.members.find(m=>m.id===senderMemberId);
  if(!sender||sender.removedAt||sender.agentThreadId!==senderThreadId)throw new Error('Only the authenticated current member attempt may send');
  const recipient=toMemberId==='leader'?null:team.members.find(m=>m.id===toMemberId);
  if(toMemberId!=='leader'&&(!recipient?.agentThreadId||recipient.removedAt||recipient.id===sender.id))throw new Error('Recipient must be a different active bound team member or leader');
  if(typeof text!=='string'||!text.trim()||text.length>4000||!/^[a-f0-9-]{36}$/i.test(requestId))throw new Error('A message and stable request ID are required');
  if(!['action','blocker','completion','progress'].includes(kind))throw new Error('Invalid peer message kind');
  const payload={senderMemberId,senderThreadId,attemptId,toMemberId,text:text.trim(),requestId,kind};
  team.peerMessages??=[];const prior=team.peerMessages.find(m=>m.requestId===requestId);
  if(prior){if(Object.keys(payload).some(k=>payload[k]!==prior[k]&&!(k==='kind'&&kind==='action'&&!prior.kind)))throw new Error('Message request ID has different contents');return prior;}
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
  return (team.peerMessages??[]).filter(m=>m.kind!=='progress'&&m.status==='queued'&&team.tasks.some(t=>t.id===m.taskId&&t.status==='running'&&t.memberId===m.senderMemberId&&t.attempts.at(-1)?.id===m.attemptId)&&(m.toMemberId==='leader'||team.members.some(x=>x.id===m.toMemberId&&!x.removedAt&&x.agentThreadId===m.recipientThreadId))).map(m=>({messageId:m.id,threadId:m.recipientThreadId,agentPath:team.members.find(x=>x.agentThreadId===m.recipientThreadId)?.agentPath??null,
    text:m.marker+'\nFrom '+m.senderMemberId+': '+m.text+'\nRead your team inbox and acknowledge this exact message ID.',action:m.toMemberId==='leader'?'leader-inbox':'send-native-message',note:'Leader controls delivery; reading this queue never sends or retries a message.'}));
}
export function pendingPeerInbox(team,threadId,{after=0,attemptId,turnId,maxChars=6000}={}){
  if(!Number.isInteger(after)||after<0)throw new Error('Invalid inbox cursor');
  const all=(team.peerMessages??[]).filter(m=>m.recipientThreadId===threadId),messages=[];let cursor=Math.min(after,all.length),size=0;
  for(;cursor<all.length;cursor++){
    const m=all[cursor];if(m.status==='acknowledged'||m.kind==='progress'||m.recipientAttemptId&&m.recipientAttemptId!==attemptId||m.recipientTurnId&&m.recipientTurnId!==turnId)continue;
    const row={id:m.id,taskId:m.taskId,attemptId:m.attemptId,senderMemberId:m.senderMemberId,kind:m.kind??'action',text:m.text};
    const length=JSON.stringify(row).length;if(size+length>maxChars){if(!messages.length)return {messages:[],cursor,hasMore:true,oversizedMessage:{id:m.id,tool:'read_team_peer_message',note:'Read selected pages then acknowledge this exact message; no partial read was acknowledged'}};break;}messages.push(row);size+=length;
  }
  return {messages,cursor,hasMore:cursor<all.length};
}
export function peerMessagePage(team,threadId,{messageId,offset=0,maxChars=2000,cursor,attemptId,turnId}={}){
  const m=team.peerMessages?.find(m=>m.id===messageId);
  if(!m||m.recipientThreadId!==threadId||m.recipientAttemptId&&m.recipientAttemptId!==attemptId||m.recipientTurnId&&m.recipientTurnId!==turnId)throw new Error('Only the exact authenticated recipient may read this message');
  if(!Number.isInteger(offset)||offset<0||offset>m.text.length||!Number.isInteger(maxChars)||maxChars<256||maxChars>2000)throw new Error('Invalid message page');
  const hash=createHash('sha256').update(JSON.stringify([team.id,m.id,m.text])).digest('hex');if(cursor&&cursor!==hash)throw new Error('Message changed; restart selected pages');
  let text=m.text.slice(offset,offset+maxChars);while(JSON.stringify(text).length>4000||/[\uD800-\uDBFF]$/.test(text))text=text.slice(0,-1);
  return {id:m.id,senderMemberId:m.senderMemberId,kind:m.kind??'action',offset,text,cursor:hash,nextOffset:offset+text.length,hasMore:offset+text.length<m.text.length,acknowledged:false};
}
export function recordPeerDelivery(team,{messageId,status,note,source='leader-host-tool'}) {
  const m=team.peerMessages?.find(m=>m.id===messageId);if(!m)throw new Error('Peer message not found');
  if(!['host-accepted','unknown','failed'].includes(status)||!note?.trim())throw new Error('A real host delivery outcome is required');
  if(m.status==='acknowledged')return m;
  if(m.status==='host-accepted'&&status!=='host-accepted')throw new Error('Accepted delivery cannot be downgraded');
  m.status=status;m.events.push({at:new Date().toISOString(),status,note,source});return m;
}
