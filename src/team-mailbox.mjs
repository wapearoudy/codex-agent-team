import {randomUUID} from 'node:crypto';
const now=()=>new Date().toISOString();
function target(team,taskId){
  const task=team.tasks.find(t=>t.id===taskId),attempt=task?.attempts.at(-1);
  if(team.mode!=='host-leader'||team.state==='delivered'||task?.status!=='running'||!attempt?.agentThreadId)throw new Error('Messages require a bound active native attempt');
  return {task,attempt,member:team.members.find(m=>m.id===task.memberId)};
}
export function queueMessage(team,{taskId,text,requestId}){
  if(typeof text!=='string'||!text.trim()||text.length>3000)throw new Error('Message text must contain 1–3000 characters');
  if(typeof requestId!=='string'||!requestId.trim())throw new Error('Native messages require a stable requestId before sending; reuse it for retries');
  team.messages??=[];
  const prior=requestId&&team.messages.find(m=>m.requestId===requestId);
  if(prior){if(prior.taskId!==taskId||prior.text!==text.trim())throw new Error('Message request ID already has different contents');return prior;}
  const {attempt,member}=target(team,taskId);
  if(team.messages.length>=2000)throw new Error('Message history limit reached; archive this team before adding more messages');
  const message={id:randomUUID(),requestId:requestId??randomUUID(),taskId,memberId:member.id,attemptId:attempt.id,threadId:attempt.agentThreadId,turnId:attempt.turnId??null,agentPath:member.agentPath??null,text:text.trim(),status:'queued',createdAt:now(),events:[]};
  message.marker=`TEAM_WORKSPACE_MESSAGE:${message.id}`;
  message.events.push({at:message.createdAt,status:'queued',source:'plugin-outbox'});team.messages.push(message);return message;
}
export function messageAction(team,message,firstOffer=false){
  const task=team.tasks.find(t=>t.id===message.taskId);
  const stale=task?.attempts.at(-1)?.id!==message.attemptId||task?.status!=='running';
  return {type:stale?'historical-message-do-not-send':firstOffer?'message-native-member':'verify-message-before-retry',messageId:message.id,taskId:message.taskId,attemptId:message.attemptId,threadId:message.threadId,agentPath:message.agentPath,text:`${message.marker}\n${message.text}\nAcknowledge receipt with a standalone public commentary line containing exactly ${message.marker}.`,note:'Plugin saved the message only. Leader uses the native host tool; never auto-resend an uncertain delivery.',stale};
}
export function recordMessageDelivery(team,messageId,status,note){
  const message=team.messages?.find(m=>m.id===messageId);if(!message)throw new Error('Message not found');
  if(message.status==='acknowledged')return message;
  if(!['host-accepted','unknown','failed'].includes(status)||typeof note!=='string'||!note.trim())throw new Error('Record a host outcome and explicit evidence note');
  const {attempt}=target(team,message.taskId);if(attempt.id!==message.attemptId)throw new Error('Message belongs to an older attempt; refusing delivery update');
  if(message.status==='host-accepted'&&status!=='host-accepted')throw new Error('Accepted host delivery cannot be downgraded without a new message');
  message.status=status;message.events.push({at:now(),status,source:'leader-reported-host-tool',note:note.trim()});return message;
}
export function acknowledgeMessage(team,messageId,observation){
  const message=team.messages?.find(m=>m.id===messageId);if(!message)throw new Error('Message not found');
  const task=team.tasks.find(t=>t.id===message.taskId),attempt=task?.attempts.find(a=>a.id===message.attemptId);
  if(!attempt?.turnId||attempt.agentThreadId!==message.threadId||task.memberId!==message.memberId||observation.threadId!==message.threadId||observation.turnId!==attempt.turnId||(message.turnId!=null&&observation.turnId!==message.turnId)||!observation.messageAcknowledgements?.includes(message.marker))throw new Error('No exact public member receipt in the original message turn');
  if(message.turnId==null){
    message.turnId=observation.turnId;
    message.events.push({at:now(),type:'turn-bound',status:message.status,source:'native-public-member-receipt',previousTurnId:null,threadId:observation.threadId,turnId:observation.turnId,observedAt:observation.observedAt});
  }
  if(message.status!=='acknowledged'){message.status='acknowledged';message.events.push({at:now(),status:'acknowledged',source:'native-public-member-receipt',threadId:observation.threadId,turnId:observation.turnId,observedAt:observation.observedAt});}
  return message;
}
export function mailboxProjection(team){return (team.messages??[]).map(message=>({...message,stale:team.tasks.find(t=>t.id===message.taskId)?.attempts.at(-1)?.id!==message.attemptId}));}

export function validateMailbox(team){
  if(team.messages===undefined)return;
  if(!Array.isArray(team.messages)||team.messages.length>2000)throw new Error('Invalid message history');
  const ids=new Set(),requests=new Set();
  for(const m of team.messages){
    if(!m||typeof m.id!=='string'||ids.has(m.id)||typeof m.requestId!=='string'||requests.has(m.requestId)||typeof m.text!=='string'||!Array.isArray(m.events)||!['queued','host-accepted','unknown','failed','acknowledged'].includes(m.status))throw new Error('Invalid message record');
    const task=team.tasks.find(t=>t.id===m.taskId),attempt=task?.attempts.find(a=>a.id===m.attemptId);
    // Early steering is anchored to the verified attempt/member/thread. An unknown turn
    // stays unknown when binding or settlement discovers the turn; it is not a receipt.
    const unknownTurn=m.turnId==null;
    const invalidTurn=unknownTurn?m.status==='acknowledged'||m.events.some(e=>e?.status==='acknowledged'||e?.type==='turn-bound'):typeof m.turnId!=='string'||!m.turnId||attempt?.turnId!==m.turnId;
    if(!attempt||typeof m.threadId!=='string'||!m.threadId||attempt.agentThreadId!==m.threadId||invalidTurn||task.memberId!==m.memberId||m.marker!==`TEAM_WORKSPACE_MESSAGE:${m.id}`)throw new Error('Message identity mismatch');
    ids.add(m.id);requests.add(m.requestId);
  }
}
