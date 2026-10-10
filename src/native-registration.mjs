import {createHash} from 'node:crypto';
import {isAbsolute,relative} from 'node:path';
import {associateTurn,attemptTurnIds} from './turn-association.mjs';
import {lastMemberExecution,retireTaskContext} from './task-context.mjs';
import {submitTask,reviewTask,validateTeam} from './team.mjs';
import {assertContractDelivery,assertContractPass,recordFindings} from './team-quality.mjs';
import {assertReviewPass,resolutionEvidenceText} from './quality-gates.mjs';
import {futureReviewChecks,scopeAudit} from './review-scope.mjs';
import {requireTeamVersion} from './team-version.mjs';
import {parseStructuredReport,reportEnvelope,assertReportMarker} from './report-format.mjs';

const now=()=>new Date().toISOString();
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const uuid=v=>{const h=hash(v);return h.slice(0,8)+'-'+h.slice(8,12)+'-5'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);};
const terminal=s=>['completed','failed','interrupted'].includes(s);
const text=v=>typeof v==='string'?v:Array.isArray(v)?v.map(text).join('\n'):v==null?'':JSON.stringify(v);
export function registrationOptions(attempt){
  return attempt?.nativeRegistration?{registration:{...attempt.nativeRegistration,turnIds:attemptTurnIds(attempt)}}:{};
}
// Format adaptation is lossless: raw public delivery and the exact transform
// remain in the evidence record. Never promote custom statuses to PASS.
export function normalizeNativeReport(output,expectedMarker){
  const body=output?.trim();if(!body)throw new Error('Completed native turn has no public delivery');
  let report;try{report=parseStructuredReport(body,{expectedMarker});}catch(error){
    if(error.code==='TEAM_REPORT_MARKER_MISMATCH')throw error;
    // Preserve the explicit import adapter's legacy single-fence support. A
    // recognized task prefix must always satisfy the strict public envelope.
    if(reportEnvelope(body).prefix||/^TEAM_WORKSPACE_ATTEMPT:/i.test(body))return null;
    const fenced=[...body.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)];
    const values=fenced.flatMap(m=>{try{return [parseStructuredReport(m[1],{expectedMarker})];}catch(error){if(error.code==='TEAM_REPORT_MARKER_MISMATCH')throw error;return [];}});
    if(values.length!==1)return null;report=values[0];
  }
  assertReportMarker(report,expectedMarker);
  const v=structuredClone(report);
  for(const key of ['checks','acceptanceResults'])if(Array.isArray(v[key]))v[key]=v[key].map(c=>({...c,evidence:text(c.evidence)}));
  if(Array.isArray(v.findings))v.findings=v.findings.map(f=>({...f,severity:typeof f.severity==='string'?f.severity.toLowerCase():f.severity,description:text(f.description??f.title??f.trigger??f.impact??f.resolutionEvidence),resolutionEvidence:resolutionEvidenceText(f.resolutionEvidence)??f.resolutionEvidence}));
  return v;
}
export function submitRegistered(team,task,run){
  const a=task.attempts.at(-1),member=team.members.find(m=>m.id===task.memberId),raw=run.outputs?.at(-1)?.text?.trim();
  if(!raw)throw new Error('Completed native turn has no public delivery');
  const normalized=normalizeNativeReport(raw,a.marker);
  let summary=raw;
  if(task.kind==='review'&&normalized){
    // Missing summary can be described by the actual reviewer reason; no checks
    // or findings are invented. Acceptance still runs the ordinary gates.
    normalized.summary??=normalized.reason;
    summary=JSON.stringify(normalized);
  }else if(normalized){
    const delivery=structuredClone(normalized),required=new Set(task.acceptanceCriteria?.map(c=>c.id));
    if(task.validationMode==='source-only'&&delivery.acceptanceResults){
      const extras=delivery.acceptanceResults.filter(c=>!required.has(c.criterionId));
      if(extras.length&&extras.every(c=>c.status==='NOT_RUN')){
        a.nativeOutOfPhaseResults=extras;delivery.acceptanceResults=delivery.acceptanceResults.filter(c=>required.has(c.criterionId));
      }
    }
    if(Array.isArray(delivery.changedPaths))delivery.changedPaths=delivery.changedPaths.map(p=>isAbsolute(p)?relative(team.projectPath,p):p);
    try{a.delivery=assertContractDelivery(task,member,JSON.stringify(delivery),run.commands??[]);}
    catch(error){a.nativeDeliveryValidationError=error.message;}
  }
  a.nativeReportAdaptation={source:'lossless-native-format-adapter',rawHash:hash(raw),normalizedHash:hash(summary),at:now()};
  submitTask(team,task.id,{attemptId:a.id,summary,evidence:[{source:'explicit-native-registration',rawDelivery:raw,threadId:run.threadId,turnId:run.turnId,commands:run.commands,turnAssociation:run.turnAssociation??null}]});
}
function inputHash(entries,note){return hash({entries,note});}
function replay(team,requestId,digest){
  const old=team.nativeRegistrations?.find(r=>r.requestId===requestId);
  if(old&&old.hash!==digest)throw new Error('Native registration request ID has different contents');
  return old;
}
function assertInput(team,entries,requestId,note){
  if(team.mode!=='host-leader'||['archived','superseded','delivered','stopping','halted'].includes(team.state)||team.executionControl&&team.executionControl.status!=='active')throw new Error('An active original host team is required');
  if(!/^[0-9a-f-]{36}$/i.test(requestId??'')||typeof note!=='string'||!note.trim()||note.length>3000)throw new Error('Explicit registration requires a stable request ID and reason');
  if(!Array.isArray(entries)||!entries.length||entries.length>40||new Set(entries.map(e=>e.key)).size!==entries.length)throw new Error('Provide 1–40 unique native execution mappings');
  for(const e of entries){
    const task=team.tasks.find(t=>t.id===e.taskId);
    if(!task||!e.key||!e.threadId||!e.agentPath?.startsWith('/root/')||!e.marker||!Array.isArray(e.turnIds)||!e.turnIds.length||new Set(e.turnIds).size!==e.turnIds.length)throw new Error('Exact task, native child path and ordered turn IDs are required');
    if(e.reviewDecision&&(task.kind!=='review'||!['accept','rework'].includes(e.reviewDecision.decision)||!e.reviewDecision.note?.trim()))throw new Error('Only an independent review may record an explicit Leader decision');
    if(task.kind==='review'&&!e.targetKey&&!e.targetAttemptId)throw new Error('An imported review must identify the exact reviewed attempt');
    if(e.reviewDecision?.decision==='accept'&&!e.reviewDecision.proofReference?.trim())throw new Error('Restoring acceptance requires the existing Leader decision evidence');
  }
}
async function prepare(engine,team,entries){
  const runs=new Map();
  // Verify metadata before reading child contents. No spawn, resume, message,
  // command execution or acceptance occurs during observation or dry-run.
  for(const e of entries){
    const registration={source:'explicit-native-registration',threadId:e.threadId,agentPath:e.agentPath,marker:e.marker,turnIds:e.turnIds};
    const run=await engine.observer.inspect(team.leaderThreadId,team.projectPath,e.threadId,e.marker,{registration});
    if(run.agentPath!==e.agentPath||run.latestTurnId!==run.turnId)throw new Error('Native execution is not the explicitly selected current task context');
    runs.set(e.key,run);
  }
  const retiring=new Map();
  for(const memberId of new Set(entries.map(e=>team.tasks.find(t=>t.id===e.taskId).memberId))){
    const member=team.members.find(m=>m.id===memberId),last=lastMemberExecution(team,member);
    if(!last)continue;
    if(team.tasks.some(t=>t.memberId===memberId&&t.status==='running'))throw new Error('Logical member already has registered running work; preserve that binding');
    const run=await engine.observer.inspect(team.leaderThreadId,team.projectPath,member.agentThreadId,last.attempt.marker,{requireIdle:true,boundTurnId:last.attempt.turnId,...registrationOptions(last.attempt)});
    if(!terminal(run.status)||run.turnId!==last.attempt.turnId)throw new Error('Previous registered member context is not settled');
    retiring.set(memberId,run);
  }
  return {runs,retiring};
}
function apply(team,entries,prepared,requestId,note,digest){
  const prior=replay(team,requestId,digest);if(prior)return prior;
  // Existing context/continuation/deferred-review records use the compatible
  // 0.21 schema. Older readers fail closed on an unrecognized native marker;
  // they may not guess a turn or discard this explicit association.
  requireTeamVersion(team,'0.21.0');
  const mapped=new Map(),at=now();
  for(const e of entries){
    const task=team.tasks.find(t=>t.id===e.taskId),member=team.members.find(m=>m.id===task.memberId),run=prepared.runs.get(e.key);
    const id=uuid([team.id,task.id,e.threadId,e.turnIds[0]]);
    const existing=team.tasks.flatMap(t=>t.attempts.map(a=>({task:t,attempt:a}))).find(x=>x.attempt.id===id||x.attempt.agentThreadId===e.threadId);
    if(existing)throw new Error('Native execution is already registered; use its existing attempt, never import it twice');
    if(['running','submitted','accepted','cancelled'].includes(task.status))throw new Error('Task already has active, submitted or accepted work; preserve its current attempt');
    if(member.agentThreadId){
      const old=lastMemberExecution(team,member),observed=old?.attempt.observation??prepared.retiring.get(member.id);
      if(prepared.retiring.has(member.id)){retireTaskContext(team,member,prepared.retiring.get(member.id));prepared.retiring.delete(member.id);}
      else if(old)retireTaskContext(team,member,observed);
      else throw new Error('Member has an unrelated native initialization; preserve the original binding');
    }
    const target=task.kind==='review'?team.tasks.find(t=>t.id===task.reviewOfTaskId):null;
    const targetId=e.targetKey?mapped.get(e.targetKey):e.targetAttemptId;
    if(target&&(!targetId||target.attempts.at(-1)?.id!==targetId||target.status!=='submitted'))throw new Error('Review mapping does not target the exact submitted implementation');
    const registration={source:'explicit-native-registration',requestId,key:e.key,threadId:e.threadId,agentPath:e.agentPath,marker:e.marker,turnIds:[...e.turnIds],at};
    const a={id,memberId:member.id,number:task.attempt+1,state:'running',agentThreadId:e.threadId,marker:e.marker,startedAt:run.startedAt??at,endedAt:null,summary:null,contextGeneration:member.contextGeneration??1,contractRevision:task.contractRevision??1,nativeRegistration:registration,dependencyAttempts:task.dependencies.map(d=>({taskId:d.taskId,attemptId:d.taskId===target?.id?targetId:team.tasks.find(t=>t.id===d.taskId).attempts.at(-1)?.id??null,contractRevision:team.tasks.find(t=>t.id===d.taskId).contractRevision??1})),executedRoute:{model:run.model??null,reasoningEffort:run.reasoningEffort??null,source:'host-observed-model'},boundAt:at};
    task.attempt++;task.attempts.push(a);task.status='running';task.blockReason=null;task.updatedAt=at;
    member.agentThreadId=e.threadId;member.agentPath=e.agentPath;member.rosterVerified=true;member.initializationTurnId??=run.turnId;member.status='running';member.lastActivityAt=at;
    associateTurn(team,task,run);team.totalDispatches=(team.totalDispatches??0)+1;mapped.set(e.key,id);
    if(run.status==='completed')submitRegistered(team,task,run);
    else if(terminal(run.status)){a.state=run.status;a.endedAt=at;task.status='blocked';task.blockReason='已登记中断/失败轮次，保留交付等待明确续跑关联';member.status='idle';}
    if(e.reviewDecision){
      if(run.status!=='completed')throw new Error('A running or interrupted review cannot restore a decision');
      const verdict=normalizeNativeReport(run.outputs.at(-1)?.text,a.marker),decision=e.reviewDecision;
      if(!verdict||verdict.decision!==decision.decision)throw new Error('Leader decision does not match the actual independent review');
      if(decision.decision==='accept'){
        const normalized=JSON.parse(task.evidence.at(-1).summary);
        const futureChecks=futureReviewChecks(team,task,normalized);
        assertReviewPass(normalized,run.commands??[],target.acceptanceCriteria??[],decision.nonValidationFailures??[],{validationMode:target.validationMode,deferredChecks:decision.deferredChecks??[],futureChecks,verificationCommands:target.contract?.verify??[],workspace:target.attempts.at(-1)?.evidenceSnapshot?.workspace??team.projectPath});
        if(futureChecks.length){a.futureCheckAssociations=scopeAudit(team,task,normalized,futureChecks);requireTeamVersion(team,'0.31.0');}
        assertContractPass(target);
        if(decision.nonValidationFailures?.length)a.commandExplanations={source:'main-conversation-leader',note:decision.note,items:structuredClone(decision.nonValidationFailures),verificationCommands:structuredClone(target.contract?.verify??[]),workspace:target.attempts.at(-1)?.evidenceSnapshot?.workspace??team.projectPath,at};
        if(decision.deferredChecks?.length)a.deferredCheckExplanations={source:'main-conversation-leader',note:decision.note,validationMode:target.validationMode,targetTaskId:target.id,targetAttemptId:targetId,contractRevision:target.contractRevision??1,items:structuredClone(decision.deferredChecks),at};
      }
      recordFindings(team,task,target,verdict,{accept:decision.decision==='accept'});
      reviewTask(team,task.id,{attemptId:id,decision:decision.decision,note:decision.note});
      a.restoredReviewDecision={source:'explicit-native-registration',proofReference:decision.proofReference??null,requestId,at};
    }
    team.events.push({at,type:'native-attempt-registered',requestId,taskId:task.id,attemptId:id,threadId:e.threadId,turnIds:attemptTurnIds(a),key:e.key});
  }
  // Terminal imported contexts are historical executions, not live roster
  // sessions. Retire them now so the next task gets a clean context and old
  // hosts never have to reuse an unfamiliar fallback task marker.
  for(const member of team.members){
    const last=lastMemberExecution(team,member);
    if(last?.attempt.nativeRegistration?.requestId===requestId&&last.attempt.observation?.status==='completed'&&!team.tasks.some(t=>t.memberId===member.id&&t.status==='running'))retireTaskContext(team,member,last.attempt.observation);
  }
  const receipt={requestId,hash:digest,note,at,source:'explicit-native-registration',entries:entries.map(e=>({key:e.key,taskId:e.taskId,attemptId:mapped.get(e.key),threadId:e.threadId}))};
  (team.nativeRegistrations??=[]).push(receipt);validateNativeRegistrations(team);validateTeam(team);return receipt;
}
export function validateNativeRegistrations(team){
  if(!team.nativeRegistrations&&!team.tasks.some(t=>t.attempts.some(a=>a.nativeRegistration)))return;
  const seen=new Set();
  for(const r of team.nativeRegistrations??[]){
    if(!/^[0-9a-f-]{36}$/i.test(r.requestId??'')||seen.has(r.requestId)||!/^[a-f0-9]{64}$/.test(r.hash??'')||r.source!=='explicit-native-registration'||!r.note?.trim()||!Number.isFinite(Date.parse(r.at))||!r.entries?.length)throw new Error('Invalid native registration receipt');
    seen.add(r.requestId);
  }
  const contexts=new Set();
  for(const task of team.tasks)for(const a of task.attempts){
    const link=a.nativeRegistration;if(!link)continue;
    const receipt=team.nativeRegistrations?.find(r=>r.requestId===link.requestId),mapping=receipt?.entries.find(e=>e.attemptId===a.id),ids=attemptTurnIds(a);
    if(!mapping||mapping.taskId!==task.id||mapping.key!==link.key||mapping.threadId!==a.agentThreadId||link.source!=='explicit-native-registration'||link.threadId!==a.agentThreadId||link.marker!==a.marker||!link.agentPath?.startsWith('/root/')||contexts.has(a.agentThreadId)||!link.turnIds?.length||link.turnIds.some((id,i)=>id!==ids[i])||a.observation?.attemptIdentitySource!=='explicit-native-registration')throw new Error('Invalid native execution ownership link');
    contexts.add(a.agentThreadId);
  }
}
export async function registerNativeAttempts(engine,owner,id,revision,{entries,requestId,note,dryRun=false}){
  const team=await engine.native(owner,id),digest=inputHash(entries,note),old=replay(team,requestId,digest);
  if(old)return {registration:old,replayed:true,dryRun};
  assertInput(team,entries,requestId,note);
  if(team.revision!==revision)throw new Error('Team changed; refresh before registering existing native work');
  const prepared=await prepare(engine,team,entries),draft=structuredClone(team),receipt=apply(draft,entries,{runs:prepared.runs,retiring:new Map(prepared.retiring)},requestId,note,digest);
  if(dryRun)return {registration:receipt,dryRun:true,replayed:false,team:draft};
  try{const saved=await engine.store.update(id,owner,revision,t=>apply(t,entries,prepared,requestId,note,digest));return {registration:saved.result,team:saved.team,replayed:false,dryRun:false};}
  catch(error){const committed=replay(await engine.native(owner,id),requestId,digest);if(committed)return {registration:committed,replayed:true,dryRun:false};throw error;}
}
