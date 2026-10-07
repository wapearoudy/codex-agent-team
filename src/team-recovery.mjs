import {buildHandoff} from './team-checkpoints.mjs';

export async function recoveryPacket(team,observer) {
  const members=await Promise.all(team.members.map(async m=>{
    const task=team.tasks.find(t=>t.memberId===m.id&&t.status==='running'),a=task?.attempts.at(-1),marker=a?.marker??m.rosterMarker;
    if(!m.agentThreadId||!marker)return {memberId:m.id,status:'not-bound',action:'initialize-original-roster'};
    try {
      const observed=await observer.inspect(team.leaderThreadId,team.projectPath,m.agentThreadId,marker,{allowPending:true});
      return {memberId:m.id,threadId:m.agentThreadId,agentPath:m.agentPath,status:observed.status,turnId:observed.turnId,
        control:m.recoveryControl??{status:'unverified'},action:task?'observe-or-settle-original-attempt':'verify-native-handle-before-followup',taskId:task?.id??null};
    } catch(error) {return {memberId:m.id,threadId:m.agentThreadId,status:'unknown',control:{status:'unverified'},action:'preserve-and-report',error:error.message};}
  }));
  return {teamId:team.id,revision:team.revision,leaderThreadId:team.leaderThreadId,members,
    handoffs:team.tasks.filter(t=>!['accepted','cancelled'].includes(t.status)).map(t=>buildHandoff(team,t.id)),
    dispatchPaused:team.dispatchPaused,startsModel:false,automaticReplacement:false,
    nativeResume:{available:false,reason:'The plugin observer cannot restore the host collaboration registry. The Leader must verify its native handle; no separate executor is started.'}};
}
export function recordRecoveryControl(team,{memberId,threadId,status,tool,note}) {
  const m=team.members.find(m=>m.id===memberId);
  if(!m||m.agentThreadId!==threadId||!['available','unavailable'].includes(status)||!tool?.trim()||!note?.trim())throw new Error('Record the actual native tool receipt for the original member');
  m.recoveryControl={status,tool,note,threadId,at:new Date().toISOString(),source:'leader-native-tool-receipt'};
  if(status==='unavailable')team.dispatchPaused=true;
  return m.recoveryControl;
}
export function takeoverBoundary(team,currentThreadId) {
  return {teamId:team.id,originalLeaderThreadId:team.leaderThreadId,requestedLeaderThreadId:currentThreadId,status:team.leaderThreadId===currentThreadId?'same-leader':'blocked-by-host',
    preservesRoster:true,canTransfer:false,reason:'Native members retain their original parent. Transferring a stored owner ID would not transfer real host control.',
    originalLeaderAction:{tool:'navigate_to_codex_page',threadId:team.leaderThreadId},handoffs:team.tasks.filter(t=>!['accepted','cancelled'].includes(t.status)).map(t=>buildHandoff(team,t.id))};
}
