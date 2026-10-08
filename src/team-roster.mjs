import {memberNaming,memberTitleAction} from './team-naming.mjs';
// The founding roster initializes together. Later additions gate only their
// own tasks, so an unbound new role cannot stop established members.
export function requiredRosterMembers(team,taskIds){
  if(!team.fixedRoster)return [];
  const memberIds=new Set(team.tasks.filter(t=>taskIds.includes(t.id)).map(t=>t.memberId));
  return team.members.filter(m=>!m.removedAt&&(team.memberStartup==='on-demand'?memberIds.has(m.id):!m.addedAt||memberIds.has(m.id)));
}
export function rosterPacket(team,member){const naming=memberNaming(team,member);return {memberId:member.id,...naming,marker:member.rosterMarker,action:member.agentThreadId?(member.initializationNeedsRetry?'followup-native-member':'observe-existing-member'):'spawn-native-member',threadId:member.agentThreadId??null,agentPath:member.agentPath??null,titleAction:memberTitleAction(team,member),prompt:[member.rosterMarker,`Emit this exact marker as a standalone public commentary and the first line of your final reply: ${member.rosterMarker}.`,`Your fixed member name is ${naming.displayName}. Keep this project-role identity across every task.`,`You are the fixed ${member.role} member of team ${team.id}, controlled by Leader ${team.leaderThreadId} in ${team.projectPath}.`,`Responsibility: ${member.responsibility}. Allowed writes: ${member.writeScopes.join(', ')||'none'}.`,`Initialize only: reply ready, finish this turn, and wait for your Leader to send a task. Do not execute waiting tasks, create agents or alter team records. Other members share this workspace; do not revert their edits.`].join('\n\n')};}
export function validateRoster(team){
  if(!team.fixedRoster)return;
  if(team.mode!=='host-leader')throw new Error('Fixed roster requires host-leader mode');
  const threads=new Set(),markers=new Set();
  for(const member of team.members){
    if(member.removedAt&&(!Number.isFinite(Date.parse(member.removedAt))||member.status!=='removed'))throw new Error('Invalid removed member history');
    if(typeof member.rosterMarker!=='string'||!/^TEAM_WORKSPACE_MEMBER:[0-9a-f-]{36}$/i.test(member.rosterMarker)||markers.has(member.rosterMarker))throw new Error('Invalid member initialization marker');markers.add(member.rosterMarker);
    if(member.agentThreadId){if(threads.has(member.agentThreadId))throw new Error('Each team member must own a distinct native subagent');threads.add(member.agentThreadId);}
    for(const task of team.tasks)for(const attempt of task.attempts??[])if((attempt.memberId??task.memberId)===member.id&&attempt.agentThreadId&&attempt.agentThreadId!==member.agentThreadId)throw new Error('Task attempt does not belong to its fixed native member');
  }
  for(const task of team.tasks)for(const attempt of task.attempts??[])if(attempt.memberId&&!team.members.some(m=>m.id===attempt.memberId))throw new Error('Task attempt has no historical member');
  if(team.memberChanges!==undefined){
    if(!Array.isArray(team.memberChanges)||team.memberChanges.length>200)throw new Error('Invalid member change history');
    const requests=new Set();
    for(const entry of team.memberChanges){
      if(!entry||! /^[0-9a-f-]{36}$/i.test(entry.requestId??'')||requests.has(entry.requestId)||!/^[a-f0-9]{64}$/.test(entry.hash??'')||!Number.isFinite(Date.parse(entry.at))||!['remove','reassign'].includes(entry.result?.type)||!team.members.some(m=>m.id===entry.result.memberId)||entry.result.type==='reassign'&&!team.tasks.some(t=>t.id===entry.result.taskId))throw new Error('Invalid member change identity');
      requests.add(entry.requestId);
    }
  }
  if(team.memberAdditions!==undefined){
    if(!Array.isArray(team.memberAdditions))throw new Error('Invalid member addition history');
    const requests=new Set(),added=new Set();
    for(const entry of team.memberAdditions){
      if(!entry||typeof entry.requestId!=='string'||requests.has(entry.requestId)||!/^[a-f0-9]{64}$/.test(entry.hash)||!Array.isArray(entry.memberIds)||!entry.memberIds.length||!Number.isFinite(Date.parse(entry.at)))throw new Error('Invalid member addition history');
      requests.add(entry.requestId);
      for(const id of entry.memberIds){const m=team.members.find(m=>m.id===id);if(!m||added.has(id)||m.addedAt!==entry.at)throw new Error('Member addition identity mismatch');added.add(id);}
    }
    if(team.members.some(m=>m.addedAt&&!added.has(m.id)))throw new Error('Missing member addition history');
  }
}
