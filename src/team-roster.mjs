import {memberNaming,memberTitleAction} from './team-naming.mjs';
export function rosterPacket(team,member){const naming=memberNaming(team,member);return {memberId:member.id,...naming,marker:member.rosterMarker,action:member.agentThreadId?'observe-existing-member':'spawn-native-member',threadId:member.agentThreadId??null,agentPath:member.agentPath??null,titleAction:memberTitleAction(team,member),prompt:[member.rosterMarker,`Emit this exact marker as a standalone public commentary and the first line of your final reply: ${member.rosterMarker}.`,`Your fixed member name is ${naming.displayName}. Keep this project-role identity across every task.`,`You are the fixed ${member.role} member of team ${team.id}, controlled by Leader ${team.leaderThreadId} in ${team.projectPath}.`,`Responsibility: ${member.responsibility}. Allowed writes: ${member.writeScopes.join(', ')||'none'}.`,`Initialize only: reply ready, finish this turn, and wait for your Leader to send a task. Do not execute waiting tasks, create agents or alter team records. Other members share this workspace; do not revert their edits.`].join('\n\n')};}
export function validateRoster(team){
  if(!team.fixedRoster)return;
  if(team.mode!=='host-leader')throw new Error('Fixed roster requires host-leader mode');
  const threads=new Set(),markers=new Set();
  for(const member of team.members){
    if(typeof member.rosterMarker!=='string'||!/^TEAM_WORKSPACE_MEMBER:[0-9a-f-]{36}$/i.test(member.rosterMarker)||markers.has(member.rosterMarker))throw new Error('Invalid member initialization marker');markers.add(member.rosterMarker);
    if(member.agentThreadId){if(threads.has(member.agentThreadId))throw new Error('Each team member must own a distinct native subagent');threads.add(member.agentThreadId);}
    for(const task of team.tasks.filter(t=>t.memberId===member.id))for(const attempt of task.attempts??[])if(attempt.agentThreadId&&attempt.agentThreadId!==member.agentThreadId)throw new Error('Task attempt does not belong to its fixed native member');
  }
}
