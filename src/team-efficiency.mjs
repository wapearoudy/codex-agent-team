import {createHash} from 'node:crypto';
import {phaseEconomy} from './team-economy.mjs';

export const OUTPUT_POLICY=Object.freeze({nativeMaxOutputTokens:1200,batchMaxChars:6000,sourcePageChars:4000,logPageChars:2000,phaseInputTokens:60000,phaseCommandCount:30,maxPhaseHandoffs:3});
const pick=(o,keys)=>Object.fromEntries(keys.filter(k=>o?.[k]!==undefined).map(k=>[k,o[k]]));
export const peerReceipt=m=>pick(m,['id','taskId','attemptId','senderMemberId','toMemberId','recipientThreadId','recipientAttemptId','recipientTurnId','kind','status','createdAt']);
// Opt-in references only: an unknown/changed digest always returns the full
// authenticated packet. No cache entry can authorize another native execution.
export function dispatchPayload(packet,knownHash){
  const {revision:transportRevision,...identityAndInstructions}=packet;
  const dispatchHash=createHash('sha256').update(JSON.stringify(identityAndInstructions)).digest('hex');
  if(knownHash!==dispatchHash)return {...packet,dispatchHash};
  return {...pick(packet,['taskId','attemptId','memberId','marker','existingThreadId','existingAgentPath','contextIsolation','contextBudget']),dispatchHash,dispatchUnchanged:true,action:'reuse-cached-dispatch',instruction:'Use your retained complete packet with this exact dispatchHash and attemptId. This is not a new dispatch or permission to resend. If the complete cache is missing, retry without knownDispatchHashes.'};
}
export function memberClaimPayload(packet,revision,knownHash){
  const payload={kind:'member-claim',revision,...pick(packet,['taskId','attemptId','marker']),action:'continue-current-native-turn'};
  const promptHash=createHash('sha256').update(JSON.stringify([payload.taskId,payload.attemptId,payload.marker,packet.prompt])).digest('hex');
  return {...payload,promptHash,...(knownHash===promptHash||knownHash===packet.promptHash?{promptUnchanged:true,instruction:'Use the retained complete prompt for this exact promptHash and attempt. Cache missing: retry without knownPromptHash. Do not spawn or follow up yourself.'}:{prompt:packet.prompt,instruction:'Emit marker publicly and bind_member_team_task to your existing thread; do not spawn/follow up yourself.'})};
}
export function efficiencyAdvice(run){
  const input=run?.usage?.currentInputTokens??null,commands=run?.commands?.length??0;
  return {policy:OUTPUT_POLICY,currentInputTokens:input,commandCount:commands,phaseHandoffRecommended:input>=OUTPUT_POLICY.phaseInputTokens||commands>=OUTPUT_POLICY.phaseCommandCount,phaseCostDecision:phaseEconomy({currentInputTokens:input,...run?.phaseCostEstimate}),automaticReset:false,transportFailureRestarts:false};
}
// Checkpoints, progress, usage and delivery receipt timestamps are not business
// events. A stop, contract/goal change, new attempt or actionable inbox is.
export function coordinationSignature(t){
  const bootstrapping=(t.tasks??[]).filter(x=>x.status==='running'&&x.attempts?.at(-1)?.bootstrap&&(['reserved','linking'].includes(x.attempts.at(-1).state)||x.attempts.at(-1).bootstrapSource==='authenticated-member-native-observation'));
  const quietMembers=new Map(bootstrapping.map(x=>[x.memberId,x.attempts.at(-1).id]));
  const relevant=new Set((t.tasks??[]).filter(x=>!t.activeBatchId||x.batchId===t.activeBatchId||x.status==='running').map(x=>x.id));
  for(let changed=true;changed;){changed=false;for(const task of t.tasks??[])if(relevant.has(task.id))for(const d of task.dependencies??[])if(!relevant.has(d.taskId)){relevant.add(d.taskId);changed=true;}}
  return createHash('sha256').update(JSON.stringify([t.id,t.state,t.dispatchPaused,t.executionControl,t.planReview,t.policy,t.maxParallel,t.goal,t.memberStartup,t.startupProtocol,t.activeBatchId,t.activeBatchId?(t.batches??[]).filter(b=>b.id===t.activeBatchId):t.batches,
    (t.members??[]).map(m=>{const row=pick(m,['id','status','agentThreadId','goalRevision','removedAt','recoveryControl','writeScopes','route','routeSnapshot','activeRoute','fallbackRoute','workspace']);row.rosterVerified=m.rosterVerified??null;if(quietMembers.has(m.id)&&['starting','running'].includes(m.status)){row.status='reserved-execution';row.agentThreadId=quietMembers.get(m.id);row.rosterVerified='authenticated-reserved-turn';}return row;}),
    (t.tasks??[]).filter(x=>relevant.has(x.id)).map(x=>[x.id,x.status,x.memberId,x.priority,x.dependencies,x.contractRevision,x.goal,x.acceptance,x.acceptanceCriteria,x.contract,x.resources,x.validationMode,x.qualityMode,x.batchId,x.reviewOfTaskIds,x.attempts?.at(-1)?.id,bootstrapping.includes(x)?'authenticated-reserved-turn':x.attempts?.at(-1)?.turnId,x.attempts?.at(-1)?.phaseHandoff?.status,x.attempts?.at(-1)?.settlementException?.inputHash,x.attempts?.at(-1)?.acceptanceException?.inputHash]),
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
