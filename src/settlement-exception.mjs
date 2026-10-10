import {evidenceHash} from './evidence-snapshot.mjs';
export function settlementInputHash(team,task,run){
  const a=task.attempts.at(-1),member=team.members.find(m=>m.id===task.memberId);
  return evidenceHash(['terminal-settlement-v1',a.id,run.threadId,run.turnId,run.status,run.outputs,run.commands,run.turnAssociation,task.contractRevision??1,task.contract,task.acceptanceCriteria,member.workspace]);
}
export function validateSettlementExceptions(team){
  for(const task of team.tasks)for(const a of task.attempts??[]){
    for(const e of [a.settlementException,...(a.settlementExceptionHistory??[])].filter(Boolean)){
    if(team.requiresTeamWorkspaceVersion!=='0.31.0'||e.source!=='plugin-settlement-gate'||e.taskId!==task.id||e.attemptId!==a.id||!e.reason?.trim()||!Number.isFinite(Date.parse(e.at))||! /^[a-f0-9]{64}$/.test(e.inputHash)||(e.observation??a.observation)?.status!=='completed')throw new Error('Invalid terminal settlement exception');
    }
  }
}
