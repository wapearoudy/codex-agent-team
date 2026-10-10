import {createHash} from 'node:crypto';

export const OUTPUT_POLICY=Object.freeze({nativeMaxOutputTokens:1200,batchMaxChars:6000,sourcePageChars:4000,logPageChars:2000,phaseInputTokens:90000,phaseCommandCount:50,maxPhaseHandoffs:3});
const pick=(o,keys)=>Object.fromEntries(keys.filter(k=>o?.[k]!==undefined).map(k=>[k,o[k]]));
export const peerReceipt=m=>pick(m,['id','taskId','attemptId','senderMemberId','toMemberId','recipientThreadId','recipientAttemptId','recipientTurnId','kind','status','createdAt']);
export function efficiencyAdvice(run){
  const input=run?.usage?.currentInputTokens??null,commands=run?.commands?.length??0;
  return {policy:OUTPUT_POLICY,currentInputTokens:input,commandCount:commands,phaseHandoffRecommended:input>=OUTPUT_POLICY.phaseInputTokens||commands>=OUTPUT_POLICY.phaseCommandCount,automaticReset:false,transportFailureRestarts:false};
}
// Checkpoints, progress, usage and delivery receipt timestamps are not business
// events. A stop, contract/goal change, new attempt or actionable inbox is.
export function coordinationSignature(t){
  return createHash('sha256').update(JSON.stringify([t.id,t.state,t.dispatchPaused,t.executionControl,t.planReview,t.policy,t.maxParallel,t.goal,
    (t.members??[]).map(m=>pick(m,['id','status','agentThreadId','goalRevision','removedAt','recoveryControl'])),
    (t.tasks??[]).map(x=>[x.id,x.status,x.memberId,x.priority,x.dependencies,x.contractRevision,x.goal,x.acceptance,x.acceptanceCriteria,x.contract,x.resources,x.validationMode,x.attempts?.at(-1)?.id,x.attempts?.at(-1)?.turnId,x.attempts?.at(-1)?.phaseHandoff?.status]),
    (t.peerMessages??[]).filter(m=>m.recipientThreadId===t.leaderThreadId&&m.status!=='acknowledged'&&m.kind!=='progress').map(m=>[m.id,m.status])])).digest('hex');
}
export class SchemaCatalog{
  constructor(version){this.version=version;this.entries=new Map();}
  describe(name,inputSchema,description,knownHash){
    let row=this.entries.get(name);
    if(!row){row={kind:'team-tool-schema',name,description,inputSchema,schemaHash:createHash('sha256').update(JSON.stringify([this.version,name,inputSchema])).digest('hex'),schemaReuse:'same-operation-and-pluginVersion'};this.entries.set(name,row);}
    return knownHash===row.schemaHash?{kind:'team-tool-schema-unchanged',name,schemaHash:row.schemaHash,unchanged:true}:row;
  }
}
export const MEMBER_PROTOCOL=`Use team_member(operation, arguments). Read structuredContent ?? content, and forward only that selected payload; never print both copies. Known argument shapes (optional fields may be omitted):
read_member_team_work {teamId}; read_team_context {teamId,taskId,view:compact|full|evidence,attemptId?,section?,offset?,limit?,cursor?}; read_team_source {teamId,taskId,path,startLine?,maxChars?,cursor?}; prepare_team_command {teamId,taskId,attemptId,requestId,command}; read_team_command_log {teamId,taskId,attemptId,requestId,offset?,maxChars?};
send_team_peer_message {teamId,attemptId,toMemberId,text,requestId,kind?:action|blocker|completion|progress}; record_team_peer_sender_delivery {teamId,messageId,status:host-accepted|unknown|failed,note}; consume_team_inbox {teamId,attemptId,after?};
report_member_team_task {teamId,revision,taskId,attemptId,requestId,summary,remainingWork?,decisions?,evidence?,validation?:[{name,status:PASS|FAIL|BLOCKED|NOT_RUN,evidence}],handoff?,verificationInputs?,delivery?}.
Reuse these shapes. Describe only an unknown operation; retain its schemaHash and pass schemaHash on refresh. A version mismatch refreshes the schema, never restarts an active task.`;
