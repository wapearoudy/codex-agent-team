import {verificationCommandMatches} from './verification-command.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {captureEvidenceSnapshot} from './evidence-snapshot.mjs';
import {requireTeamVersion,teamVersionAtLeast} from './team-version.mjs';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const leaderEvidenceTurnIds=a=>[...(a.leaderResumptions??[]).map(r=>r.fromTurnId),a.turnId];
export const resumedLeaderCommands=a=>(a.leaderResumptions??[]).flatMap(r=>[...r.previousTaskCommands,...(r.currentBaselineFailures??[])]);
export async function resumeLeaderTurn(engine,owner,team,task,context){
 const a=task.attempts.at(-1),member=team.members.find(m=>m.id===task.memberId);
 if(context.threadId!==team.leaderThreadId||context.cwd!==team.projectPath||task.executionMode!=='leader'||task.kind==='review'||task.status!=='running'||a.executionMode!=='leader'||a.state!=='running'||a.agentThreadId!==team.leaderThreadId||a.leaderCheckpoint||a.memberSubmission||team.dispatchPaused||team.executionControl&&team.executionControl.status!=='active'||(task.contractRevision??1)!==(a.contractRevision??1)||member.removedAt)throw Error('Only the original authorized unfinished Leader task may resume');
 const [current,previous]=await Promise.all([engine.observer.inspectLeader(team.leaderThreadId,team.projectPath),engine.observer.inspectHistoricalLeader(team.leaderThreadId,team.projectPath,a.turnId)]);
 if(current.source!=='native-leader-checkpoint'||current.threadId!==team.leaderThreadId||current.status!=='inProgress'||!current.turnId||current.turnId===a.turnId||previous.source!=='native-leader-checkpoint'||previous.historicalResumeOnly!==true||previous.threadId!==team.leaderThreadId||previous.turnId!==a.turnId||previous.latestTurnId!==current.turnId||!['completed','failed','interrupted'].includes(previous.status)||previous.status==='interrupted'&&!(previous.statusEvidence?.status==='interrupted'&&['persisted-turn-aborted','persisted-native-task-stop'].includes(previous.statusEvidence.source))||[...current.commands,...previous.commands].some(c=>!c.commandId||!['completed','failed'].includes(c.status)||!Number.isInteger(c.exitCode)))throw Error('Leader resume requires an exact ended predecessor, an active current turn and known native command outcomes');
 if(['model','provider','reasoningEffort'].some(k=>!a.executedRoute?.[k]||current[k]!==a.executedRoute[k]))throw Error('Leader resume model route differs from its original frozen binding');
 const baseline=new Set(a.leaderBaselineCommandIds??[]),previousTaskCommands=previous.commands.filter(c=>!baseline.has(c.commandId));
 const prepared=structuredClone(a.leaderVerificationRequests??[]);
 const snapshot=await captureEvidenceSnapshot(team,task),record={source:'authenticated-leader-same-task-resume',threadId:team.leaderThreadId,taskId:task.id,attemptId:a.id,contractRevision:a.contractRevision??1,fromTurnId:a.turnId,toTurnId:current.turnId,previousStatus:previous.status,previousStatusEvidence:structuredClone(previous.statusEvidence??null),previousTaskCommands,currentBaselineFailures:current.commands.filter(c=>(c.status!=='completed'||c.exitCode!==0)&&(task.contract?.verify??[]).some(command=>verificationCommandMatches(c.command,command,{cwd:c.cwd,workspace:member.workspace?.path??team.projectPath}))),previousBaselineCommandIds:[...baseline],previousBindingHistory:structuredClone(a.leaderBindingHistory),previousReportRequestId:a.leaderReportRequestId??a.id,previousVerificationRequests:structuredClone(a.leaderVerificationRequests??[]),currentSnapshot:snapshot,currentBaselineCommandIds:current.commands.map(c=>c.commandId),route:structuredClone(a.executedRoute),at:new Date().toISOString(),testsExecuted:false,reviewBudgetConsumed:false};record.integrityHash=hash(record);
 const saved=await engine.store.update(team.id,owner,team.revision,t=>{
  const candidate=t.tasks.find(x=>x.id===task.id),attempt=candidate.attempts.at(-1);
  if(candidate.status!=='running'||attempt.id!==a.id||attempt.turnId!==a.turnId||attempt.leaderCheckpoint||attempt.memberSubmission||t.dispatchPaused||t.executionControl&&t.executionControl.status!=='active')throw Error('Leader binding changed during resume; preserve original evidence');
  (attempt.leaderResumptions??=[]).push(record);attempt.turnId=current.turnId;attempt.observation=structuredClone(current);attempt.runtimeStatus=current.status;attempt.leaderBindingHistory=structuredClone(current);attempt.leaderBaselineCommandIds=current.commands.map(c=>c.commandId);attempt.leaderVerificationRequests=prepared;attempt.leaderReportRequestId=randomUUID();attempt.boundAt=record.at;
  if(attempt.settlementException)(attempt.settlementExceptionHistory??=[]).push(attempt.settlementException);delete attempt.settlementException;
  requireTeamVersion(t,'0.40.55');t.events.push({type:'leader-task-turn-resumed',taskId:task.id,attemptId:a.id,fromTurnId:a.turnId,toTurnId:current.turnId,testsExecuted:false,reviewBudgetConsumed:false,at:record.at});
 });
 return {team:saved.team,run:current};
}
export function validateLeaderResumptions(team){
 for(const task of team.tasks)for(const a of task.attempts??[]){
  const rows=a.leaderResumptions??[];if(!rows.length)continue;
  if(!teamVersionAtLeast(team,'0.40.55')||task.executionMode!=='leader'||a.executionMode!=='leader'||a.agentThreadId!==team.leaderThreadId||rows.at(-1).toTurnId!==a.turnId)throw Error('Invalid Leader resume ownership');
  const seen=new Set();for(const [i,r]of rows.entries()){
   const {integrityHash,...body}=r;
   if(integrityHash!==hash(body)||r.source!=='authenticated-leader-same-task-resume'||r.threadId!==team.leaderThreadId||r.taskId!==task.id||r.attemptId!==a.id||r.contractRevision!==(a.contractRevision??1)||!r.fromTurnId||!r.toTurnId||r.fromTurnId===r.toTurnId||seen.has(r.toTurnId)||i&&rows[i-1].toTurnId!==r.fromTurnId||!['completed','failed','interrupted'].includes(r.previousStatus)||r.previousStatus==='interrupted'&&!(r.previousStatusEvidence?.status==='interrupted'&&['persisted-turn-aborted','persisted-native-task-stop'].includes(r.previousStatusEvidence.source))||r.testsExecuted!==false||r.reviewBudgetConsumed!==false||!r.currentSnapshot?.fingerprint||!Number.isFinite(Date.parse(r.at))||(r.currentBaselineFailures??[]).some(c=>c.turnId!==r.toTurnId||!c.commandId||!['completed','failed'].includes(c.status)||!Number.isInteger(c.exitCode)||c.status==='completed'&&c.exitCode===0)||r.previousTaskCommands.some(c=>c.turnId!==r.fromTurnId||!c.commandId||!['completed','failed'].includes(c.status)||!Number.isInteger(c.exitCode)))throw Error('Invalid authenticated Leader resume history');seen.add(r.fromTurnId);seen.add(r.toTurnId);
  }
  if(a.leaderCheckpoint&&(a.leaderCheckpoint.reusedCommandHash!==hash(a.leaderReusedVerificationCommands??[])||hash(a.leaderReusedVerificationCommands??[])!==hash(resumedLeaderCommands(a))))throw Error('Resumed Leader checkpoint lost its original verification evidence');
 }
}
