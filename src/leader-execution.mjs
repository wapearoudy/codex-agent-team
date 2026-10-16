import {validateLeaderResumptions} from './leader-resume.mjs';
import {createHash} from 'node:crypto';
import {leaderStartTransport} from './leader-start.mjs';
export const executionHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function activateLeaderDispatch(engine,data,owner,context){
  let packet=data.dispatches?.find(p=>p.action==='execute-in-leader');
  let recovered=false;
  if(!packet){
    // A replay/continuation can lose the transport bundle after its original
    // reservation was consumed. Recover only the current unfinished Leader
    // attempt; startLeaderTask revalidates the host, route, controls and turn.
    // Never replay a child launch, submitted checkpoint or historical attempt.
    const candidates=(data.team?.tasks??[]).filter(t=>{
      const a=t.attempts?.at(-1);
      return t.executionMode==='leader'&&t.kind!=='review'&&t.status==='running'&&a?.executionMode==='leader'&&['reserved','running'].includes(a.state)&&!a.leaderCheckpoint&&!a.memberSubmission&&(!a.agentThreadId||a.agentThreadId===data.team.leaderThreadId);
    });
    if(candidates.length>1)throw Error('Multiple unfinished Leader attempts; preserve reservations and resolve their identities before work');
    if(!candidates.length)return data;
    const t=candidates[0];packet={taskId:t.id,attemptId:t.attempts.at(-1).id};recovered=true;
  }
  const args={teamId:data.team.id,taskId:packet.taskId,attemptId:packet.attemptId};let execution;
  try{execution=await engine.startLeaderTask(owner,data.team.id,context,args);}catch(error){
    if(error.code!=='LEADER_ACTIVITY_STALE')throw error;
    const nextRead=leaderStartTransport(args);
    execution={kind:'leader-execution',...args,readyForWork:false,reason:error.message,startsModel:false,runsCommands:false,nextRead,startInvocation:nextRead.invocation,instruction:'Long wait exceeded native activity freshness. Invoke startInvocation unchanged in ONE NEW functions.exec before writes/tests. It calls the exact authenticated start once and stores the ready execution as teamStep.leaderExecution, including its submissionProgram. Do not copy or reconstruct that program. If the binding still cannot verify activity, stop and retain this reservation and all original evidence; do not wait-loop, respawn or claim completion.'};
  }
  if(recovered)execution={...execution,recoveredFromCurrentAttempt:true,startsModel:false,runsCommands:false};
  return {...data,...await engine.receipt(owner,data.team.id),dispatches:(data.dispatches??[]).filter(p=>p!==packet),leaderExecution:execution};
}
// Task submission is a sealed checkpoint, NOT a synthetic native turn end.
// The Leader remains inProgress while a different native reviewer works.
export function executionCompleted(a){
  if(a?.executionMode!=='leader')return a?.observation?.status==='completed';
  const c=a.leaderCheckpoint,r=a.observation;
  return !!c&&c.source==='authenticated-leader-submission'&&c.threadId===a.agentThreadId&&c.turnId===a.turnId&&r?.threadId===a.agentThreadId&&r.turnId===a.turnId&&r.source==='native-leader-checkpoint'&&['inProgress','completed'].includes(r.status)&&Array.isArray(r.commands)&&r.commands.every(x=>x.commandId&&x.turnId===a.turnId&&['completed','failed'].includes(x.status)&&Number.isInteger(x.exitCode))&&c.commandHash===executionHash(r.commands)&&(!a.leaderResumptions?.length||c.reusedCommandHash===executionHash(a.leaderReusedVerificationCommands??[]))&&a.memberSubmission?.source==='authenticated-leader'&&c.deliveryHash===a.memberSubmission?.deliveryHash&&c.deliveryHash===createHash('sha256').update(a.memberSubmission.text??'').digest('hex')&&a.memberSubmission.contractRevision===(a.contractRevision??1)&&c.candidateFingerprint===a.evidenceSnapshot?.fingerprint&&!!c.candidateFingerprint&&!!a.endedAt;
}
export function validateLeaderExecutions(team){
  validateLeaderResumptions(team);
  for(const t of team.tasks)for(const a of t.attempts??[]){
    if(a.executionMode!=='leader')continue;
    if(t.kind==='review'||t.executionMode!=='leader'||a.agentThreadId&&a.agentThreadId!==team.leaderThreadId||a.leaderCheckpoint&&!executionCompleted(a))throw new Error('Invalid Leader execution checkpoint; preserve native status and exact evidence');
    const c=a.leaderStopCheckpoint;
    if(c&&(c.source!=='authenticated-leader-stop'||c.threadId!==team.leaderThreadId||c.turnId!==a.turnId||c.observation?.threadId!==team.leaderThreadId||c.observation.turnId!==a.turnId||c.commandHash!==executionHash(c.observation.commands)||c.observation.commands.some(x=>!['completed','failed'].includes(x.status)||!Number.isInteger(x.exitCode))))throw new Error('Invalid cooperative Leader stop checkpoint');
  }
}
