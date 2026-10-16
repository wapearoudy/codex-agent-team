import {resumeLeaderTurn,resumedLeaderCommands,leaderEvidenceTurnIds} from './leader-resume.mjs';
import {memberReportProgram,memberReportInvocation} from './cached-member.mjs';
import {prepareTeamCommand} from './team-output.mjs';
import {currentVerificationEvidence} from './verification-reuse.mjs';
import {bootstrapSource} from './bootstrap-source.mjs';
import {executionCompleted,executionHash} from './leader-execution.mjs';
import {dispatchReference,readDispatchContext,reservedNativeDispatch} from './dispatch-reference.mjs';
import {reviewInputs} from './review-inputs.mjs';
import {leaderSubmissionProgram} from './leader-submission.mjs';
import {bootstrapReservation,assertBootstrapObservation,bootstrapReportInput,bootstrapStartInput} from './member-bootstrap.mjs';
import {assertStartupConfiguration,startupConflict,startupFailureAction} from './team-startup.mjs';
import {compileTeamTasks} from './team-plan-compiler.mjs';
import {memberTaskPrompt} from './member-prompt.mjs';
import {deliveryTemplate,deliveryHash,preflightDelivery,resolveDeliveryReceipt} from './delivery-preflight.mjs';
import {teamEconomy,economyForecast,phaseEconomy,historicalCostProfile} from './team-economy.mjs';
import {settlementInputHash} from './settlement-exception.mjs';
import {captureEvidenceSnapshot,assertEvidenceSnapshot} from './evidence-snapshot.mjs';
import {reconcileDelivery} from './delivery-reconciliation.mjs';
import {reconcileVerification} from './verification-reconciliation.mjs';
import {reconcileReview} from './review-reconciliation.mjs';
import {verificationCommandMatches} from './verification-command.mjs';
import {applyReviewDecision,acceptCompletedReview,reviewInputHash} from './reviewer-acceptance.mjs';
import {reuseFinalEvidence} from './final-evidence.mjs';
import {lastMemberExecution,retireTaskContext,stoppedContextIsIdle,assertFreshBinding,boundedDispatchPrompt} from './task-context.mjs';
import {registerNativeAttempts,registrationOptions,submitRegistered} from './native-registration.mjs';
import {memberGoalRequest,changeMemberGoal,memberGoalSnapshot,memberGoalDetail} from './member-goals.mjs';
import {memberClaimRequest,memberReport,assertMember} from './member-work.mjs';
import {amendContract} from './team-contracts.mjs';
import {requestStop,resumeTeam,stopTargets,controlRequest} from './team-control.mjs';
import {requireTeamVersion} from './team-version.mjs';
import {associateTurn,assertObservationTurn,attemptTurnIds,sumTurnUsage} from './turn-association.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {TeamStore,schedule,bindMemberThread,submitTask,pauseDispatch,validatePlan,dispatchBlockers} from './team.mjs';
import {DurableStore} from './durable-store.mjs';
import {NativeMembers} from './native-members.mjs';
import {failedRunObservation} from './team-projection.mjs';
import {settlePhaseHandoff,linkPhaseContinuation,reusablePhaseCommands} from './task-phases.mjs';
import {OUTPUT_POLICY,dispatchPayload,memberClaimPayload} from './team-efficiency.mjs';
import {queueMessage,messageAction,recordMessageDelivery,acknowledgeMessage,mailboxProjection} from './team-mailbox.mjs';
import {recordCheckpoint,checkpointProjection,buildHandoff} from './team-checkpoints.mjs';
import {rosterPacket,requiredRosterMembers} from './team-roster.mjs';
import {memberNaming,memberTitleAction} from './team-naming.mjs';
import {assertBudget,usageReport,normalizePolicy,nativeRoute} from './team-policy.mjs';
import {diagnostics} from './team-diagnostics.mjs';
import {workflowActions} from './team-workflow.mjs';
import {peerActions} from './team-peer-mailbox.mjs';
import {TeamWorktrees} from './team-worktrees.mjs';
import {assertContractDelivery,assertContractPass,qualityReport,assertQualityFinish,openFindings} from './team-quality.mjs';
import {lifecycleRequest,reassignTask,removeMember,verifyQuiescence} from './team-lifecycle.mjs';

import {requestPlanFeedback,setPlanReview,assertPlanExecutable,assertDispatchAllowed,assertPlanMutable,editablePlan,updateDraft,updateExpansionDraft,stageExpansion,expansionCandidate,policyExpands,reviewRequest,finishPlanDecision,planHash} from './team-plan-review.mjs';

import {applyQualityDefaults,assertReviewTopology,reviewTargetIds,qualityMode,commandClassification,qualityMetrics} from './quality-policy.mjs';
import {attachBatch,finishScope} from './team-batches.mjs';
import {planRepair} from './team-quality.mjs';
const now=()=>new Date().toISOString();
const terminal=s=>['completed','failed','interrupted'].includes(s);
function reservedTaskName(team,member,attempt,hostId='codex'){
  if(attempt.bootstrap?.taskName&&(!attempt.bootstrap.attemptId||attempt.bootstrap.attemptId===attempt.id))return attempt.bootstrap.taskName;
  const name=memberNaming(team,member).taskName,generation=member.contextGeneration??1,suffix='_ctx_'+generation+'_'+attempt.id.replaceAll('-','');
  return generation>1||((team.hostId??hostId)==='codex'&&!member.agentThreadId)?name.slice(0,64-suffix.length)+suffix:name;
}
export class LeaderEngine {
  constructor({root=join(homedir(),'.codex','team-workspace'),store,observer,adapter}={}){
    this.root=root;this.store=store??new TeamStore(join(root,'teams'));this.observer=observer??new NativeMembers();this.adapter=adapter;
    this.worktrees=new TeamWorktrees(join(root,'worktrees'));
  }
  async planOnce(owner,context,args){
    assertStartupConfiguration(args);
    const taskPlanning=args.taskPlanning;
    args={...args,plan:{...args.plan,tasks:args.plan.tasks??[]}};
    for(const task of args.plan.tasks)if(task.qualityMode||task.riskFlags)applyQualityDefaults(task,args.policy?.qualityMode??'standard');
    validatePlan(args.plan,{allowEmpty:taskPlanning==='leader'});
    assertReviewTopology(args.plan);
    const key=createHash('sha256').update(JSON.stringify({owner,cwd:context.cwd,goal:args.goal,plan:args.plan,taskPlanning,requestId:args.requestId??null,fixedRoster:!!args.initializeMembers,memberStartup:args.memberStartup,startupProtocol:args.startupProtocol,approvalMode:args.approvalMode,execute:args.execute,maxParallel:args.maxParallel,policy:args.policy,executionAuthorization:args.executionAuthorization,goalStartHash:args.goalStartHash})).digest('hex');
    return new DurableStore(join(this.root,'leader-plan-requests.json'),{requests:{}}).transaction(async d=>{
      if(d.requests[key]){const existing=await this.store.get(d.requests[key],owner);if(existing.state!=='archived')return existing;}
      const team=await this.store.create({projectId:createHash('sha256').update(context.cwd).digest('hex').slice(0,24),projectPath:context.cwd,goal:args.goal,plan:args.plan,maxParallel:args.maxParallel??3,taskPlanning},owner);
      const saved=(await this.store.update(team.id,owner,team.revision,t=>{t.mode='host-leader';if(args.goalStartHash)t.goalStartRequest={requestId:args.requestId,hash:args.goalStartHash};if(t.tasks.some(x=>x.qualityMode))requireTeamVersion(t,'0.37.0');if(context.hostId){t.hostId=context.hostId;t.nativeTools=context.nativeTools??[];requireTeamVersion(t,'0.33.0');}if(t.members.some(m=>m.routeSnapshot||m.fallbackRoute))requireTeamVersion(t,'0.13.0');t.leaderThreadId=context.threadId;t.dispatchPaused=!args.execute;t.state=args.execute?'active':'planned';t.totalDispatches=0;if(args.policy){t.policy=normalizePolicy(args.policy);if(t.policy.providerConcurrency||t.policy.modelConcurrency)requireTeamVersion(t,'0.38.0');}if(args.memberStartup){t.memberStartup=args.memberStartup;requireTeamVersion(t,'0.12.0');}if(args.startupProtocol){t.startupProtocol=args.startupProtocol;requireTeamVersion(t,'0.40.0');}if(args.approvalMode||taskPlanning==='leader')setPlanReview(t,{mode:args.approvalMode??'required',execute:args.execute,executionAuthorization:args.executionAuthorization,brief:args.brief});if(args.initializeMembers){t.fixedRoster=true;for(const m of t.members){m.rosterMarker=`TEAM_WORKSPACE_MEMBER:${randomUUID()}`;m.rosterVerified=false;}}})).team;
      d.requests[key]=saved.id;return saved;
    });
  }
  async native(owner,id){const team=await this.store.get(id,owner);if(team.mode!=='host-leader')throw new Error('This is a legacy isolated team; native delegation requires a host-leader plan');return team;}
  async startLeaderTask(owner,id,context,input){
    let team=await this.native(owner,id),task=team.tasks.find(t=>t.id===input.taskId),a=task?.attempts.at(-1);
    if(context.threadId!==team.leaderThreadId||context.cwd!==team.projectPath||(team.hostId??'codex')!=='codex'||task?.executionMode!=='leader'||task.kind==='review'||task.status!=='running'||a?.id!==input.attemptId||a.executionMode!=='leader')throw new Error('Only the authenticated Leader can start its explicitly reserved bounded work unit');
    assertDispatchAllowed(team);if(team.dispatchPaused||team.executionControl&&team.executionControl.status!=='active')throw new Error('Leader execution is paused');
    // The next reservation needs its actual repair context, not the previous
    // generic goal or delivery. Keep histories stored rather than forwarding.
    const workContext={title:task.title,context:task.context??'',repairRootTaskId:task.repairRootTaskId??null,repairRound:task.repairRound??null,repairFindingIds:task.repairFindingIds??[],...(task.repairFocus?{repairFocus:task.repairFocus}:{}),openFindings:openFindings(team,task).map(({id,severity,status,description,criterionId,basis,evidence,expected,actual})=>({id,severity,status,description,...(criterionId?{criterionId,basis,evidence,expected,actual}:{})}))};
    if(JSON.stringify(workContext).length>normalizePolicy(team.policy).contextChars)throw new Error('Required Leader work context exceeds its reviewed context budget; narrow the task or explicitly raise the budget. No findings were omitted and no work is authorized.');
    let run;try{run=await this.observer.inspectLeader(team.leaderThreadId,team.projectPath,a.turnId);}catch(error){if(error.code!=='LEADER_TURN_CHANGED'||!this.observer.inspectHistoricalLeader)throw error;const resumed=await resumeLeaderTurn(this,owner,team,task,context);team=resumed.team;task=team.tasks.find(t=>t.id===input.taskId);a=task.attempts.at(-1);run=resumed.run;}if(run.status!=='inProgress'||run.commands.some(c=>!['completed','failed'].includes(c.status)||!Number.isInteger(c.exitCode)))throw new Error('Leader execution requires its current active native turn and no pending baseline commands');
    if(task.executionStrategy?.inheritedRoute&&['model','provider','reasoningEffort'].some(k=>(run[k]??null)!==task.executionStrategy.inheritedRoute[k])){
      const expected=task.executionStrategy.inheritedRoute,observed=Object.fromEntries(['model','provider','reasoningEffort'].map(k=>[k,run[k]??null]));
      if(JSON.stringify([a.leaderRouteBlocker?.expected,a.leaderRouteBlocker?.observed])!==JSON.stringify([expected,observed]))await this.store.update(id,owner,team.revision,t=>{const attempt=t.tasks.find(x=>x.id===task.id).attempts.at(-1);if(attempt.leaderRouteBlocker)(attempt.leaderRouteBlockerHistory??=[]).push(attempt.leaderRouteBlocker);attempt.leaderRouteBlocker={expected,observed,at:now(),source:'native-leader-route-gate',code:'leader-model-route-mismatch',message:'主会话当前模型路由与该任务继承快照不同或未知，已保留预留；核对原路由后重试启动，不执行写入或测试。'};});
      throw new Error('Auto Leader route changed or is unknown; preserve the reservation and original model route before any writes/tests');
    }
    if(a.agentThreadId&&a.leaderRouteBlocker)await this.store.update(id,owner,team.revision,t=>{const attempt=t.tasks.find(x=>x.id===task.id).attempts.at(-1);(attempt.leaderRouteBlockerHistory??=[]).push(attempt.leaderRouteBlocker);delete attempt.leaderRouteBlocker;});
    if(!a.agentThreadId)await this.store.update(id,owner,team.revision,t=>{
      if(t.tasks.some(other=>other.id!==task.id&&other.status==='running'&&other.attempts.at(-1)?.agentThreadId===context.threadId))throw new Error('Leader already owns a different active task');
      const current=t.tasks.find(x=>x.id===task.id),attempt=current.attempts.at(-1),m=t.members.find(m=>m.id===current.memberId);
      if(attempt.id!==input.attemptId||attempt.state!=='reserved')throw new Error('Leader reservation changed');
      if(attempt.leaderRouteBlocker){(attempt.leaderRouteBlockerHistory??=[]).push(attempt.leaderRouteBlocker);delete attempt.leaderRouteBlocker;}
      bindMemberThread(t,task.id,context.threadId,attempt.id);m.executionMode='leader';m.rosterVerified=true;attempt.state='running';associateTurn(t,current,run);attempt.boundAt=now();attempt.leaderBaselineCommandIds=run.commands.map(c=>c.commandId);attempt.leaderBindingHistory=structuredClone(run);attempt.executedRoute={model:run.model,provider:run.provider,reasoningEffort:run.reasoningEffort,source:'host-observed-model'};t.totalDispatches++;
      attempt.leaderReportRequestId??=randomUUID();attempt.leaderVerificationRequests=(current.contract.verify??[]).map(command=>({command,requestId:randomUUID()}));
      t.events.push({at:attempt.boundAt,type:'leader-self-bound',taskId:task.id,attemptId:attempt.id,threadId:context.threadId,turnId:run.turnId});
    });
    const saved=await this.native(owner,id),current=saved.tasks.find(t=>t.id===task.id),attempt=current.attempts.at(-1);
    const sourceInputs=await bootstrapSource(saved,context,current);
    const execution={kind:'leader-execution',readyForWork:true,...(attempt.leaderResumptions?.length?{resumedFromTurnId:attempt.leaderResumptions.at(-1).fromTurnId}:{}),teamId:id,revision:saved.revision,taskId:task.id,attemptId:attempt.id,turnId:attempt.turnId,goal:current.goal,contract:current.contract,acceptanceCriteria:current.acceptanceCriteria,workContext,sourceInputs,deliveryTemplate:deliveryTemplate(saved,current),verificationPreparation:(attempt.leaderVerificationRequests??[]).map(v=>({operation:'prepare_team_command',arguments:{teamId:id,taskId:task.id,attemptId:attempt.id,...v,verificationInputs:[...new Set([...(current.contract.inScope??[]),...(current.contract.readPaths??[])])]}})),reportArguments:{teamId:id,taskId:task.id,attemptId:attempt.id},instruction:'Read current workContext/context/openFindings and actual sourceInputs once; the previous delivery is not this repair goal. Address every current criterion and repair finding; only distinct QA resolves findings. After edits and factual source assessment store teamDelivery, omitting copied attemptMarker only with the exact authenticated teamDeliveryIdentity. Run submissionInvocation as raw code in the SAME functions.exec; use AsyncFunction to evaluate a program string, never synchronous new Function. It executes exact native validation once, saves logs/actual exits, rechecks complete inputs and registers review-ready evidence. Resume a yielded cell, never reinvoke after unknown transport. Failed/unknown/changed evidence preserves the attempt and requires correction, never PASS. A registration-only correction uses valid saved results and a fresh report UUID in this SAME attempt; do not rerun tests or restart QA. Code changes after verification require fresh command UUIDs. Distinct terminal native QA remains mandatory; sealed checkpoint preserves actual native inProgress.'};
    execution.verificationTransportOwnsValidation=true;
    execution.instruction+=' Do not run the contract checks separately before submissionInvocation: this transport owns that one validation run. For an already completed check, first reuse its authenticated prepared-command or original-manifest evidence through the existing reconciliation path; never run the helper just to register it again.';
    execution.submissionProgram=leaderSubmissionProgram(execution,attempt.leaderReportRequestId??attempt.id);
    execution.submissionInvocation="await (new Function('tools','ALL_TOOLS','text','store','load','notify','return (async()=>{'+load('teamStep').leaderExecution.submissionProgram+'})()'))(tools,ALL_TOOLS,text,store,load,notify);";
    return execution;
  }
  async reportLeaderTask(owner,id,context,input){
    const team=await this.native(owner,id),task=team.tasks.find(t=>t.id===input.taskId),a=task?.attempts.at(-1),member=team.members.find(m=>m.id===task?.memberId);
    if(context.threadId!==team.leaderThreadId||context.cwd!==team.projectPath||task?.executionMode!=='leader'||task.kind==='review'||a?.id!==input.attemptId||a.agentThreadId!==context.threadId||!a.turnId)throw new Error('Leader report does not identify its own bound task');
    const hash=deliveryHash(input.delivery);
    const oldDraft=a.submissionDrafts?.find(d=>d.requestId===input.requestId);if(oldDraft&&oldDraft.hash!==hash)throw new Error('Leader submission request ID already has different contents; preserve the original draft');
    if(task.status!=='running'){if(a.leaderCheckpoint?.requestId===input.requestId&&a.leaderCheckpoint.deliveryHash===hash&&executionCompleted(a))return this.receipt(owner,id);throw new Error('Leader task is already sealed; preserve its report and review');}
    if(team.dispatchPaused||team.executionControl&&team.executionControl.status!=='active')throw new Error('Resume the original team before sealing Leader work');
    const observed=await this.observer.inspectLeader(team.leaderThreadId,team.projectPath,a.turnId),baseline=new Set(a.leaderBaselineCommandIds??[]),currentCommands=observed.commands.filter(c=>!baseline.has(c.commandId)),commands=[...resumedLeaderCommands(a),...currentCommands];
    if(currentCommands.some(c=>!c.commandId||c.turnId!==a.turnId||!['completed','failed'].includes(c.status)||!Number.isInteger(c.exitCode)))throw new Error('Leader task still has a running or unknown native command; preserve its session and real exit');
    const historicalProof=await currentVerificationEvidence(this.root,team,task,commands,undefined,undefined,{authenticatedTurnIds:leaderEvidenceTurnIds(a)});
    const preflight=preflightDelivery(team,task,member,input.delivery,commands,{requireReviewReady:input.requireReviewReady===true});
    for(const v of historicalProof)if(v.turnId&&v.turnId!==a.turnId&&!v.canReuse){preflight.valid=false;preflight.errors.push({path:'commandsRun',message:'Historical Leader validation lacks unchanged complete original input proof: '+v.command});}
    if(!preflight.valid){await this.store.update(id,owner,team.revision,t=>{const attempt=t.tasks.find(t=>t.id===task.id).attempts.at(-1);(attempt.submissionDrafts??=[]).push({requestId:input.requestId,hash,text:input.delivery,turnId:a.turnId,status:'format-rejected',errors:preflight.errors,source:'authenticated-leader',at:now()});});return {kind:'leader-delivery-preflight',correctionMode:'same-attempt',reviewBudgetConsumed:false,correctionRequestId:randomUUID(),verificationEvidence:await currentVerificationEvidence(this.root,team,task,commands),deliveryPreflight:preflight,repairTemplate:deliveryTemplate(team,task),startsModel:false,runsCommands:false,startsReview:false,instruction:'Correct this exact report in the SAME bound attempt using valid saved commands and complete input proof. Preserve actual FAIL/BLOCKED/NOT_RUN; never relabel it to register QA. No code/test rerun or new review is required for registration-only corrections.'};}
    await this.store.update(id,owner,team.revision,async t=>{
      const current=t.tasks.find(t=>t.id===task.id),attempt=current.attempts.at(-1);
      const run={...observed,commands:currentCommands};associateTurn(t,current,run);attempt.leaderReusedVerificationCommands=structuredClone(resumedLeaderCommands(a));
      attempt.leaderNativeHistory=observed;attempt.delivery=assertContractDelivery(current,member,input.delivery,commands,{projectPath:t.projectPath});attempt.evidenceSnapshot=await captureEvidenceSnapshot(t,current);
      attempt.memberSubmission={requestId:input.requestId,text:input.delivery,turnId:a.turnId,deliveryHash:hash,contractRevision:current.contractRevision??1,status:'checkpoint-verified',source:'authenticated-leader',at:now()};
      submitTask(t,current.id,{attemptId:attempt.id,summary:input.delivery,evidence:[{source:'authenticated-leader-submission',threadId:context.threadId,turnId:a.turnId,commands}]});
      attempt.leaderCheckpoint={source:'authenticated-leader-submission',requestId:input.requestId,threadId:context.threadId,turnId:a.turnId,deliveryHash:hash,commandHash:executionHash(currentCommands),...(attempt.leaderResumptions?.length?{reusedCommandHash:executionHash(attempt.leaderReusedVerificationCommands)}:{}),candidateFingerprint:attempt.evidenceSnapshot.fingerprint,at:now()};
      t.events.push({type:'leader-task-checkpoint-sealed',taskId:current.id,attemptId:attempt.id,threadId:context.threadId,turnId:a.turnId,at:now()});
    });
    const saved=await this.native(owner,id);return this.advance(owner,id,saved.revision,{settleCompleted:false,dispatchReady:true});
  }
  async prepareCommand(owner,id,context,input){
    const team=await this.native(owner,id),task=team.tasks.find(t=>t.id===input.taskId),a=task?.attempts.at(-1);
    const run=context.threadId===team.leaderThreadId?await this.observer.inspectLeader(team.leaderThreadId,team.projectPath,a?.turnId):await this.checkpointRun(team,input);
    const baseline=new Set(a?.leaderBaselineCommandIds??[]),commands=[...resumedLeaderCommands(a??{}),...(run.commands??[]).filter(c=>!baseline.has(c.commandId))];
    if(a?.leaderResumptions?.length){const old=await currentVerificationEvidence(this.root,team,task,commands,[input.command],input.verificationInputs,{authenticatedTurnIds:leaderEvidenceTurnIds(a)});if(old[0]?.commandId&&old[0].turnId!==a.turnId&&old[0].status==='completed'&&old[0].exitCode===0&&!old[0].requestId)return {kind:'prepared-native-command',executionArguments:null,mustReuse:false,reuseEvidence:old[0],inputProof:{reusable:false,reason:'Original historical success lacks a complete before-command input proof; explicitly reconcile its original manifest, never rerun tests for registration.'},startsCommand:false};}
    return prepareTeamCommand(this.root,team,context,input,{commands});
  }
  async registerNative(owner,id,revision,input){return registerNativeAttempts(this,owner,id,revision,input);}
  async reconcileDelivery(owner,id,revision,input){return reconcileDelivery(this,owner,id,revision,input);}
  async reconcileVerification(owner,id,revision,input){return reconcileVerification(this,owner,id,revision,input);}
  async reconcileReview(owner,id,revision,input){return reconcileReview(this,owner,id,revision,input);}
  packet(team,task){
    const a=task.attempts.at(-1),m=team.members.find(x=>x.id===task.memberId);
    if(task.executionMode==='leader')return {teamId:team.id,revision:team.revision,taskId:task.id,attemptId:a.id,memberId:m.id,marker:a.marker,action:'execute-in-leader',leaderStart:{operation:'start_leader_team_task',arguments:{teamId:team.id,taskId:task.id,attemptId:a.id}},instruction:'Execute this explicitly assigned bounded unit in the authenticated Leader, after start_leader_team_task. Never spawn an executor or self-review. Independent native QA remains mandatory.'};
    const naming=memberNaming(team,m),generation=m.contextGeneration??1;
    const bounded=boundedDispatchPrompt(handoff=>memberTaskPrompt(team,task,m,a,handoff),buildHandoff(team,task.id),normalizePolicy(team.policy).contextChars);
    const packet={teamId:team.id,revision:team.revision,promptHash:deliveryHash(bounded.prompt),deliveryTemplate:deliveryTemplate(team,task),leaderThreadId:team.leaderThreadId,...(team.nativeTools?{nativeTools:team.nativeTools}:{}),...(m.nativeTarget?{nativeTarget:m.nativeTarget}:{}),taskId:task.id,attemptId:a.id,memberId:m.id,...naming,taskName:reservedTaskName(team,m,a,this.adapter?.id??'codex'),titleAction:memberTitleAction(team,m),existingThreadId:m.agentThreadId,existingAgentPath:m.agentPath??null,marker:a.marker,spawnOptions:nativeRoute(m),workspace:m.workspace??{path:team.projectPath,mode:'shared'},...bounded,contextIsolation:{mode:'task',generation,previousThreadId:team.contextHistory?.findLast(c=>c.memberId===m.id)?.threadId??null},
      action:m.agentThreadId?'followup-native-member':'spawn-native-member'};
    if(a.bootstrap)packet.memberBootstrap={operation:'start_member_team_task',arguments:{teamId:team.id,bootstrapToken:a.bootstrap.token}};
    if((team.hostId??this.adapter?.id??'codex')==='codex')packet.nativeAction=packet.existingThreadId
      ?{tool:'followup_task',arguments:{target:packet.existingAgentPath,message:packet.prompt},instruction:'Reuse this exact existing target; a completed delivery is never followed up only to register it.'}
      :{tool:'spawn_agent',arguments:{task_name:packet.taskName,message:packet.prompt,fork_turns:'none',...(packet.spawnOptions.model?{model:packet.spawnOptions.model}:{}),...(packet.spawnOptions.reasoning_effort?{reasoning_effort:packet.spawnOptions.reasoning_effort}:{})},instruction:'Use these exact native arguments, including task_name; do not reconstruct a role label or rewrite the prompt.'};
    return this.adapter?.dispatch(packet)??packet;
  }
  async referenceDispatches(data){return {...data,dispatches:await Promise.all((data.dispatches??[]).map(p=>p.dispatchReference||p.dispatchUnchanged?p:dispatchReference(this.root,p)))};}
  async guardDispatches(data){
    // Every Codex launch entry, including legacy claim/full views, returns only
    // the reservation capability. Business context is released after binding.
    const guard=p=>p?.memberBootstrap&&!p.dispatchReference?dispatchReference(this.root,p):p;
    return {...data,...(data.dispatch?{dispatch:await guard(data.dispatch)}:{}),...(data.dispatches?{dispatches:await Promise.all(data.dispatches.map(guard))}:{})};
  }
  async claim(owner,id,revision,taskId){
    const data=await this.claimMany(owner,id,revision,[taskId]);const {dispatches,...rest}=data;return {...rest,dispatch:dispatches[0]};
  }
  async claimMany(owner,id,revision,taskIds,{knownDispatchHashes={}}={}){
    if(!taskIds?.length||taskIds.length>8||new Set(taskIds).size!==taskIds.length)throw new Error('Provide 1–8 unique tasks');
    const rosterTeam=await this.native(owner,id),verified=[];assertStartupConfiguration(rosterTeam);assertDispatchAllowed(rosterTeam);
    if(rosterTeam.revision!==revision)throw new Error('Team changed; refresh before controlling members');
    if(rosterTeam.state==='superseded')throw new Error('Historical team cannot dispatch; use the project’s current team');
    if(rosterTeam.policy?.tokenLimit){const [runs,accounting]=await Promise.all([this.observations(rosterTeam),this.accounting(rosterTeam,{fresh:true})]);assertBudget(rosterTeam,runs,accounting);}
    if(rosterTeam.members.some(m=>!m.removedAt&&m.recoveryControl?.status==='unavailable'))throw new Error('A native member handle is unavailable; preserve the roster and verify recovery before dispatch');
    const retirements=new Map();
    for(const taskId of taskIds){
      const task=rosterTeam.tasks.find(t=>t.id===taskId),member=rosterTeam.members.find(m=>m.id===task?.memberId);
      if(!member||task.status==='running')continue;
      const last=lastMemberExecution(rosterTeam,member);if(!last)continue;
      if(task.executionMode==='leader'){
        if((!executionCompleted(last.attempt)&&!last.attempt.leaderStopCheckpoint&&!['failed','interrupted'].includes(last.attempt.observation?.status))||last.attempt.agentThreadId!==rosterTeam.leaderThreadId)throw new Error('Previous Leader task checkpoint is not sealed or stopped; preserve its original execution');
        continue;
      }
      if(member.executionMode==='leader')throw new Error('A Leader execution role cannot be reused as a native child; use a distinct execution role');
      if(rosterTeam.tasks.some(t=>t.memberId===member.id&&t.status==='running'))throw new Error('Member still has an active attempt; preserve its context');
      if(last.attempt.state==='stopped'&&last.attempt.stopEvidence?.quiescence?.source==='native-latest-turn'){
        const idle=await this.observer.inspectIdle(rosterTeam.leaderThreadId,rosterTeam.projectPath,member.agentThreadId);
        if(!stoppedContextIsIdle(last,idle))throw new Error('Stopped member quiescence changed; reconcile its latest native state before retiring');
        retirements.set(member.id,idle);continue;
      }
      const run=await this.observer.inspect(rosterTeam.leaderThreadId,rosterTeam.projectPath,member.agentThreadId,last.attempt.marker,{requireIdle:true,boundTurnId:last.attempt.turnId,...registrationOptions(last.attempt)});
      assertObservationTurn(last.attempt,run);
      if(!last.attempt.endedAt||!terminal(run.status)||run.turnId!==last.attempt.turnId)throw new Error('Native member is not confirmed terminal; preserve its task context');
      retirements.set(member.id,run);
    }
    if(rosterTeam.fixedRoster){
      const required=requiredRosterMembers(rosterTeam,taskIds);
      if(rosterTeam.memberStartup!=='on-demand'&&required.some(m=>!m.agentThreadId&&!m.contextGeneration))throw new Error('Initialize and bind every fixed native member required by these tasks before dispatching');
      verified.push(...await Promise.all(required.filter(m=>m.agentThreadId&&!m.rosterVerified).map(async m=>{const run=await this.observer.inspect(rosterTeam.leaderThreadId,rosterTeam.projectPath,m.agentThreadId,m.rosterMarker);if(!run.turnId||run.status!=='completed')throw new Error('Member initialization is not complete; observe the same member without respawning');return {id:m.id,threadId:m.agentThreadId,turnId:run.turnId};})));
    }
    const {result:dispatches}=await this.store.update(id,owner,revision,async t=>{
      for(const item of verified){const m=t.members.find(m=>m.id===item.id);if(m.agentThreadId!==item.threadId)throw new Error('Roster changed');m.rosterVerified=true;m.initializationTurnId=item.turnId;m.status='idle';}
      if(t.mode!=='host-leader'||t.dispatchPaused)throw new Error('Leader dispatch is paused or this is a legacy team');
      for(const taskId of taskIds){
      const task=t.tasks.find(x=>x.id===taskId);if(!task)throw new Error('Task not found');
      if(task.status==='running'&&task.attempts.at(-1)?.state==='reserved')continue;
      const blockers=dispatchBlockers(t,task);if(blockers.length)throw new Error('Task is not ready: '+blockers.map(b=>b.message).join('; '));
      const retiringMember=t.members.find(m=>m.id===task.memberId);
      if(retirements.has(retiringMember.id))retireTaskContext(t,retiringMember,retirements.get(retiringMember.id));
      const draft=structuredClone(t);draft.maxParallel=Math.min(t.maxParallel,t.tasks.filter(x=>x.status==='running').length+1);
      draft.tasks.find(x=>x.id===taskId).priority=0;
      const selected=schedule(draft);if(selected.length!==1||selected[0].id!==taskId)throw new Error('Task is not ready: check dependencies, member availability, write conflicts and parallel limit');
      const candidate=selected[0];candidate.priority=task.priority;Object.assign(task,candidate);
      const member=t.members.find(x=>x.id===task.memberId);Object.assign(member,draft.members.find(x=>x.id===member.id));
      const a=task.attempts.at(-1);a.state='reserved';a.runtimeStatus='reserved';a.marker=`TEAM_WORKSPACE_ATTEMPT:${a.id}`;a.contextGeneration=member.contextGeneration??1;requireTeamVersion(t,'0.14.0');linkPhaseContinuation(t,task);
      if(a.phaseContinuation)await reusablePhaseCommands(t,task);
      if(member.goalRevision)a.memberGoalSnapshot={...memberGoalSnapshot(member),source:'task-reservation'};
      if(task.executionMode==='leader'){a.executionMode='leader';requireTeamVersion(t,'0.40.0');}
      else if((t.hostId??this.adapter?.id??'codex')==='codex')a.bootstrap={token:randomUUID(),attemptId:a.id,contractRevision:task.contractRevision??1,taskName:reservedTaskName(t,member,a,this.adapter?.id??'codex'),...(member.agentPath?{agentPath:member.agentPath}:{})};
      if(a.bootstrap)a.startupBaseline=await captureEvidenceSnapshot(t,{...task,validationMode:'source-only'},[...new Set([...(task.contract?.inScope??member.writeScopes??[]),...(task.contract?.readPaths??[])])]);
      t.events.push({at:now(),type:'leader-task-reserved',taskId,attemptId:a.id});
      }
      return taskIds.map(taskId=>{const task=t.tasks.find(x=>x.id===taskId),packet=this.packet(t,task);task.attempts.at(-1).contextBudget=packet.contextBudget;return dispatchPayload(packet,knownDispatchHashes[packet.attemptId]);});
    });
    return {...await this.receipt(owner,id),dispatches};
  }
  async bind(owner,id,revision,taskId,attemptId,threadId){
    const data=await this.bindMany(owner,id,revision,[{taskId,attemptId,threadId}]);const {titleActions,...rest}=data;return {...rest,titleAction:titleActions[0]};
  }
  async bindMany(owner,id,revision,assignments){
    if(!assignments?.length||assignments.length>8||new Set(assignments.map(x=>x.taskId)).size!==assignments.length)throw new Error('Provide 1–8 unique task bindings');
    const team=await this.native(owner,id);
    if(team.revision!==revision)throw new Error('Team changed; refresh before controlling members');
    const verified=await Promise.all(assignments.map(async input=>{
      const task=team.tasks.find(x=>x.id===input.taskId),a=task?.attempts.at(-1);
      if(!a||a.id!==input.attemptId||task.status!=='running')throw new Error('Stale or inactive attempt');
      const member=team.members.find(m=>m.id===task.memberId);
      const snapshot=await this.observer.inspect(team.leaderThreadId,team.projectPath,input.threadId,a.marker,{allowPending:true,requireFresh:!!a.contextGeneration,boundTurnId:a.turnId,...(a.bootstrap?{launchMember:member}:{})});
      assertObservationTurn(a,snapshot);
      return {...input,threadId:snapshot.threadId,snapshot};
    }));
    await this.store.update(id,owner,revision,t=>{
      for(const {taskId,attemptId,threadId,snapshot} of verified){
      const task=t.tasks.find(x=>x.id===taskId),a=task.attempts.at(-1);
      if(a.id!==attemptId||task.status!=='running')throw new Error('Stale attempt');
      if(t.tasks.some(x=>x.id!==taskId&&x.status==='running'&&x.attempts.at(-1)?.agentThreadId===threadId))throw new Error('Member is already executing another task');
      const m=t.members.find(x=>x.id===task.memberId);
      if(m.agentThreadId&&m.agentThreadId!==threadId)throw new Error('Reuse the existing native member; do not silently replace it');
      assertFreshBinding(t,m,threadId);
      if(snapshot.nativeTarget){m.nativeTarget=snapshot.nativeTarget;a.nativeTarget=snapshot.nativeTarget;requireTeamVersion(t,'0.35.0');}
        const first=!a.agentThreadId;bindMemberThread(t,taskId,threadId,attemptId);m.agentPath=snapshot.agentPath??m.agentPath??null;if(t.memberStartup==='on-demand'||m.contextGeneration){m.rosterVerified=true;m.initializationTurnId??=snapshot.turnId;}a.state=snapshot.turnId?'running':'linking';associateTurn(t,task,snapshot);a.executedRoute={model:snapshot.model??nativeRoute(m).model??null,provider:snapshot.provider??m.routeSnapshot?.provider??null,reasoningEffort:snapshot.reasoningEffort??nativeRoute(m).reasoning_effort??null,source:snapshot.model?'host-observed-model':'frozen-route-only'};if(first){a.boundAt=now();t.totalDispatches++;}
      }
    });
    const data=await this.receipt(owner,id);return {...data,bindings:verified.map(v=>({taskId:v.taskId,attemptId:v.attemptId,threadId:v.threadId,turnId:v.snapshot.turnId??null,readyForWork:!!v.snapshot.turnId&&v.snapshot.status==='inProgress',nativeStatus:v.snapshot.status,requiredPublicMarker:data.team.tasks.find(t=>t.id===v.taskId).attempts.at(-1).marker,instruction:v.snapshot.turnId?(v.snapshot.status==='inProgress'?'Send BIND_READY for this exact attempt.':'This exact native turn already ended; settle its saved result/interruption. Do not send BIND_READY or follow up a completed turn for missing delivery.'):'Parent/project identity linked only. Do NOT send BIND_READY yet; request the exact standalone public marker in the SAME active child turn, then rebind without respawning.'})),titleActions:verified.map(v=>memberTitleAction(data.team,data.team.members.find(m=>m.id===data.team.tasks.find(t=>t.id===v.taskId).memberId)))};
  }
  async bindRoster(owner,id,revision,memberId,threadId){
    const data=await this.bindRosterMany(owner,id,revision,[{memberId,threadId}]);const {titleActions,...rest}=data;return {...rest,titleAction:titleActions[0]};
  }
  async bindRosterMany(owner,id,revision,assignments){
    if(!assignments?.length||assignments.length>8||new Set(assignments.map(x=>x.memberId)).size!==assignments.length)throw new Error('Provide 1–8 unique roster bindings');
    const team=await this.native(owner,id);assertStartupConfiguration(team);assertDispatchAllowed(team);if(team.revision!==revision)throw new Error('Team changed; refresh before controlling members');
    const verified=await Promise.all(assignments.map(async input=>{
      const member=team.members.find(m=>m.id===input.memberId&&!m.removedAt);if(!team.fixedRoster||!member)throw new Error('An active fixed roster member is required');
      if(member.contextGeneration)throw new Error('Bind an isolated task context through its reserved attempt; do not reinitialize the roster');
      return {...input,snapshot:await this.observer.inspect(team.leaderThreadId,team.projectPath,input.threadId,member.rosterMarker,{allowPending:true})};
    }));
    await this.store.update(id,owner,revision,t=>{for(const {memberId,snapshot} of verified){const m=t.members.find(m=>m.id===memberId);
      if(m.agentThreadId&&m.agentThreadId!==snapshot.threadId)throw new Error('Reuse this member’s existing native subagent');
      assertFreshBinding(t,m,snapshot.threadId);
      if(snapshot.nativeTarget){m.nativeTarget=snapshot.nativeTarget;requireTeamVersion(t,'0.35.0');}
      m.agentThreadId=snapshot.threadId;m.agentPath=snapshot.agentPath;delete m.initializationNeedsRetry;m.rosterVerified=snapshot.status==='completed'&&!!snapshot.turnId;m.initializationTurnId=snapshot.turnId;m.status=m.rosterVerified?'idle':'starting';m.lastActivityAt=now();
      t.events.push({at:now(),type:'native-roster-member-linked',memberId,threadId:snapshot.threadId,verified:m.rosterVerified});
    }});const data=await this.receipt(owner,id);return {...data,titleActions:verified.map(v=>memberTitleAction(data.team,data.team.members.find(m=>m.id===v.memberId)))};
  }
  async observations(team,{observe=true}={}){
    return Promise.all(team.tasks.flatMap(t=>t.attempts.filter(a=>a.agentThreadId||a===t.attempts.at(-1)&&t.status==='running'&&a.state==='reserved'&&a.bootstrap).map(async a=>{
      if(!a.agentThreadId){let run={status:'starting'};if(observe&&this.observer.inspectStartup)try{run=await this.observer.inspectStartup(team,t);}catch(error){run={status:'unknown',observationIssue:{kind:'startup-not-confirmed',reason:error.message}};}return {...run,startupOnly:true,executionAuthority:false,taskId:t.id,memberId:t.memberId,attemptId:a.id};}
      let observation=a.observation;
      if(a.executionMode==='leader'){
        if(observe&&t.status==='running')try{observation=await this.observer.inspectLeader(team.leaderThreadId,team.projectPath,a.turnId,{allowStopped:true});}catch(error){observation=failedRunObservation(observation,error);}
        return {...observation,taskId:t.id,memberId:t.memberId,attemptId:a.id,threadId:a.agentThreadId,executionMode:'leader',taskCheckpointCompleted:executionCompleted(a)};
      }
      if(observe&&t.attempts.at(-1)?.id===a.id&&t.status==='running')try{observation=await this.observer.inspect(team.leaderThreadId,team.projectPath,a.agentThreadId,a.marker,{allowPending:a.state==='linking',boundTurnId:a.turnId,...registrationOptions(a)});assertObservationTurn(a,observation);}catch(error){observation=failedRunObservation(observation,error);}
      return {...observation,taskId:t.id,memberId:a.memberId??t.memberId,attemptId:a.id,threadId:a.agentThreadId};
    })));
  }
  async receipt(owner,id){return this.read(owner,id,{observe:false});}
  async terminalSnapshot(owner,id){
    // Waiting needs current terminal identities only. Do not enumerate Leader
    // history, recompute all usage or build dispatch/validation projections.
    const team=await this.native(owner,id),running=team.tasks.filter(t=>t.status==='running'),runs=await this.observations({...team,tasks:running});
    return {team:{revision:team.revision},workflow:{actions:running.flatMap(t=>{const a=t.attempts.at(-1),run=runs.find(r=>r.attemptId===a?.id),failure=startupFailureAction(t,run);if(failure)return [failure];return a&&a.state!=='reserved'&&terminal(run?.status)&&!(a.continuationRequested?.turnId===run.turnId&&run.status==='interrupted')&&(!a.settlementException||a.settlementException.inputHash!==settlementInputHash(team,t,run))?[{type:'settle',taskId:t.id,attemptId:a.id,observedStatus:run.status}]:[];})}};
  }
  async accounting(team,{observe=true,fresh=false}={}){
    if(!this.observer.teamUsage||this.observer.supportsTeamUsage===false)return undefined;
    if(!observe)return this.observer.cachedTeamUsage?.(team)??null;
    try{return await this.observer.teamUsage(team,{fresh});}catch{return null;}
  }
  async read(owner,id,{observe=true}={}){
    const observedAt=now(),stored=await this.native(owner,id),team={...stored,members:stored.members.map(member=>({...member,...memberNaming(stored,member)}))},[runs,accounting]=await Promise.all([this.observations(team,{observe}),this.accounting(team,{observe})]),usage=usageReport(team,runs,accounting);
    const readiness=team.tasks.map(task=>({taskId:task.id,ready:task.status==='waiting'&&!dispatchBlockers(team,task).length,blockers:dispatchBlockers(team,task)}));
    const recovery=team.tasks.flatMap(task=>{const a=task.attempts.at(-1),run=runs.find(r=>r.attemptId===a?.id);if(task.status==='running')return [{taskId:task.id,attemptId:a.id,threadId:a.agentThreadId,agentPath:team.members.find(m=>m.id===task.memberId)?.agentPath??null,action:a.state==='reserved'?'verify-host-before-bind-or-release':terminal(run?.status)?'settle-confirmed-turn':'observe-existing-member',message:a.state==='reserved'?'核对宿主是否已启动；绑定失败不能重建成员':terminal(run?.status)?'成员已有终态，等待 Leader 接收':'继续核对现有成员；未知状态不自动重派'}];if(task.status==='blocked')return[{taskId:task.id,action:'leader-rework-decision',message:task.blockReason}];return[];});
    return {team,runs,readiness,recovery,quality:qualityReport(finishScope(team).team),qualityMetrics:qualityMetrics(team),usage,workflow:workflowActions(team,runs,{usage}),diagnostics:diagnostics(team,runs),peerDelivery:peerActions(team),initializations:team.state==='active'&&!team.dispatchPaused&&!startupConflict(team)&&!usage.exhausted&&!usage.unverifiable&&!['superseded','archived'].includes(team.state)&&(!team.executionControl||team.executionControl.status==='active')&&team.memberStartup!=='on-demand'&&team.fixedRoster&&!(team.planReview?.scope==='initial'&&team.planReview.status!=='approved')?team.members.filter(m=>!m.removedAt&&!m.rosterVerified).map(m=>{const p={...(team.nativeTools?{nativeTools:team.nativeTools}:{}),...rosterPacket(team,m),spawnOptions:nativeRoute(m),workspace:m.workspace??{mode:'shared',path:team.projectPath}};return this.adapter?.dispatch(p)??p;}):[],messages:mailboxProjection(team),checkpoints:checkpointProjection(team,runs),observedAt,observationMode:observe?'fresh':'saved',runtimeSource:'native-thread-persisted-snapshot',limitations:[
      '当前主会话负责原生成员派发、消息和停止；插件不启动模型轮次。',
      '面板读取宿主已持久化的轮次记录，可能滞后；执行结束不代表已验收。',
      '成员共用当前项目，写入范围由 Leader 和成员遵守，并发冲突在派发时检查；不是文件系统沙箱。'
    ]};
  }
  async settle(owner,id,revision,taskId,attemptId,{recordFailure=false}={}){
    const team=await this.native(owner,id),task=team.tasks.find(x=>x.id===taskId),a=task?.attempts.at(-1);
    if(!a||a.id!==attemptId||!a.agentThreadId)throw new Error('A bound current attempt is required');
    if(task.status!=='running'){if(executionCompleted(a)||a.endedAt&&(['submitted','accepted','blocked'].includes(task.status)||task.status==='waiting'&&a.phaseHandoff?.status==='completed')&&['completed','failed','interrupted'].includes(a.observation?.status??a.runtimeStatus))return this.receipt(owner,id);throw new Error('Attempt is already settled');}
    const run=task.executionMode==='leader'?await this.observer.inspectLeader(team.leaderThreadId,team.projectPath,a.turnId,{allowStopped:true}):await this.observer.inspect(team.leaderThreadId,team.projectPath,a.agentThreadId,a.marker,{boundTurnId:a.turnId,...registrationOptions(a)});
    if(!terminal(run.status))throw new Error('Native turn has no confirmed terminal record');
    if(a.continuationRequested?.turnId===run.turnId&&run.status==='interrupted')throw new Error('Continuation awaits a new marked native turn; preserve the existing request');
    // A typed terminal receipt explicitly selects the unchanged failed native
    // proposal. Arbitrary final prose never authorizes automatic recovery.
    try{
    let terminalReceipt;try{terminalReceipt=JSON.parse(run.outputs?.at(-1)?.text?.trim());}catch{}
    if(terminalReceipt?.kind==='team-report-recovery'){
      if(Object.keys(terminalReceipt).length!==2||typeof terminalReceipt.requestId!=='string')throw Error('Recovery receipt may contain only kind and the exact original report requestId');
      const report=run.reportAttempts?.at(-1);
      if(report&&report.requestId!==terminalReceipt.requestId)throw Error('Terminal recovery receipt does not select the latest native report request');
      if(a.memberSubmission)resolveDeliveryReceipt(task,run,JSON.stringify(terminalReceipt));
      else{
        if(!report?.requestId)throw Error('Original rejected native report is not yet available; preserve the receipt');
        return await this.reconcileDelivery(owner,id,revision,{taskId,attemptId,requestId:terminalReceipt.requestId,nativeReportCallId:report.callId,note:'Member explicitly ended with its original rejected-report recovery receipt; restore metadata only, retaining native verification and independent QA',dryRun:false});
      }
    }
    await this.store.update(id,owner,revision,async t=>{
      const task=t.tasks.find(x=>x.id===taskId),a=task.attempts.at(-1),member=t.members.find(x=>x.id===task.memberId);
      if(a.id!==attemptId||task.status!=='running')throw new Error('Stale or inactive attempt');
      if(a.settlementException){a.settlementExceptionHistory??=[];a.settlementExceptionHistory.push({...structuredClone(a.settlementException),observation:structuredClone(a.observation)});}
      associateTurn(t,task,run);
      if(run.status!=='completed'){task.status='blocked';task.blockReason=`Native turn ${run.status}; Leader must decide next step`;a.state=run.status;a.endedAt=now();member.status='idle';if(!task.qualityMode)pauseDispatch(t);return;}
      if(await settlePhaseHandoff(t,task,run))return;
      await this.submitObserved(t,task,run);
      delete a.settlementException;task.blockReason=null;
    });}catch(error){
      if(recordFailure&&run.status==='completed'){
        // A rejected terminal delivery is retained once as an exception. The
        // original work remains unaccepted and is never silently rerun.
        try{await this.store.update(id,owner,revision,t=>{
          const current=t.tasks.find(x=>x.id===taskId),attempt=current?.attempts.at(-1);
          if(attempt?.id!==attemptId||current.status!=='running')throw new Error('Stale settlement');
          const key=settlementInputHash(t,current,run);if(attempt.settlementException?.inputHash===key)return;
          if(attempt.settlementException){attempt.settlementExceptionHistory??=[];attempt.settlementExceptionHistory.push({...structuredClone(attempt.settlementException),observation:structuredClone(attempt.observation)});}
          associateTurn(t,current,run);attempt.settlementException={source:'plugin-settlement-gate',inputHash:key,reason:error.message.slice(0,2000),at:now(),taskId,attemptId};current.blockReason=attempt.settlementException.reason;requireTeamVersion(t,'0.31.0');
          t.events.push({type:'settlement-exception',taskId,attemptId,reason:attempt.settlementException.reason,at:now()});
        });}catch{}
      }
      throw error;
    }
    return this.receipt(owner,id);
  }
  async submitObserved(team,task,run){
    if(task.executionMode==='leader')throw new Error('Leader work requires its authenticated task checkpoint; a native turn end is not a task submission');
    if(task.attempts.at(-1)?.nativeRegistration){submitRegistered(team,task,run);await this.validateSubmittedReview(team,task);return;}
    const a=task.attempts.at(-1),member=team.members.find(m=>m.id===task.memberId);
    const nativeOutput=run.outputs?.at(-1)?.text?.trim();if(!nativeOutput)throw new Error('Completed turn has no public delivery');
    const output=resolveDeliveryReceipt(task,run,nativeOutput);
    if(output!==nativeOutput)a.finalDeliveryReceipt={text:nativeOutput,turnId:run.turnId,at:now()};
    // Quality gates use the completed turn's commands. Earlier interrupted
    // checks remain turn-scoped evidence and cannot silently validate this result.
    const reusable=a.phaseContinuation?await reusablePhaseCommands(team,task):[];
    const delivery=assertContractDelivery(task,member,output,[...reusable,...(run.commands??[])],{projectPath:team.projectPath});if(delivery)a.delivery=delivery;
    if(member.workspace?.mode==='git-worktree'){
      const candidate=await this.worktrees.inspect(team,member.id);if(candidate.dirty)throw new Error('Commit the isolated candidate before submitting it for independent review');
      a.candidate={head:candidate.head,path:candidate.workspace.path,branch:candidate.workspace.branch,base:candidate.workspace.base,observedAt:now()};
    }
    if(task.kind!=='review'){try{a.evidenceSnapshot=await captureEvidenceSnapshot(team,task);}catch(error){a.evidenceSnapshot={error:error.message,at:now()};}}
    if(a.memberSubmission)a.memberSubmission.status='native-verified';
    submitTask(team,task.id,{attemptId:a.id,summary:output,evidence:[{source:run.source,threadId:run.threadId,turnId:run.turnId,commands:run.commands,...(run.turnAssociation?{turnAssociation:run.turnAssociation}: {})}]});
    await this.validateSubmittedReview(team,task);
  }
  async validateSubmittedReview(team,task){return acceptCompletedReview(this,team,task);}
  async acceptReview(owner,id,revision,taskId,attemptId,decision,note,nonValidationFailures=[],deferredChecks=[]){
    const recorded=await this.native(owner,id),prior=recorded.tasks.find(x=>x.id===taskId),attempt=prior?.attempts.at(-1),target=recorded.tasks.find(x=>x.id===prior?.reviewOfTaskId),dependency=attempt?.dependencyAttempts?.find(d=>d.taskId===target?.id);
    if(prior?.kind==='review'&&attempt?.id===attemptId&&attempt.acceptance&&decision==='accept'&&prior.status==='accepted'&&target?.status==='accepted'&&dependency?.attemptId===target.attempts.at(-1)?.id&&(dependency.contractRevision??1)===(target.contractRevision??1))return this.receipt(owner,id);
    if(prior?.kind==='review'&&target&&dependency&&attempt?.id===attemptId&&attempt.review?.decision===decision&&attempt.review.note===note.trim()&&dependency?.attemptId===target?.attempts.at(-1)?.id&&(dependency.contractRevision??1)===(target.contractRevision??1)&&JSON.stringify(attempt.commandExplanations?.items??[])===JSON.stringify(nonValidationFailures)&&JSON.stringify(attempt.deferredCheckExplanations?.items??[])===JSON.stringify(deferredChecks)&&((decision==='accept'&&prior.status==='accepted'&&target.status==='accepted')||(decision==='rework'&&prior.status==='waiting'&&target.status==='waiting')))return this.receipt(owner,id);
    await this.store.update(id,owner,revision,t=>applyReviewDecision(this,t,taskId,attemptId,decision,note,nonValidationFailures,deferredChecks));return this.receipt(owner,id);
  }
  async acceptDelivery(owner,id,revision,taskId,attemptId,note){
    await this.store.update(id,owner,revision,async team=>{
      assertPlanExecutable(team);if(team.executionControl&&team.executionControl.status!=='active'||['stopping','halted','archived','superseded'].includes(team.state))throw new Error('Resume before acceptance');
      const task=team.tasks.find(t=>t.id===taskId),a=task?.attempts.at(-1);
      if(!task||qualityMode(task)!=='light'||team.tasks.some(r=>r.kind==='review'&&reviewTargetIds(r).includes(taskId)))throw new Error('Only unreviewed light deliveries use Leader acceptance');
      if(a?.id!==attemptId||a.observation?.status!=='completed'||a.observation.threadId!==a.agentThreadId)throw new Error('Exact host-verified completed delivery required');
      if(task.status==='accepted'&&a.leaderAcceptance)return;
      if(task.status!=='submitted')throw new Error('Delivery is not submitted');
      if(openFindings(team,task).some(f=>['blocker','high'].includes(f.severity)))throw new Error('Unresolved severe findings prevent acceptance');
      assertContractPass(task);await assertEvidenceSnapshot(team,task);
      task.status='accepted';a.leaderAcceptance={source:'main-conversation-leader',taskId,attemptId,qualityMode:'light',turnId:a.turnId,candidateFingerprint:a.evidenceSnapshot.fingerprint,note,at:now()};
      team.events.push({type:'light-delivery-accepted',taskId,attemptId,at:now()});requireTeamVersion(team,'0.37.0');
    });return this.receipt(owner,id);
  }
  async repairDelivery(owner,id,revision,taskId,note,repairTargetTaskId){
    const saved=await this.native(owner,id),original=saved.tasks.find(t=>t.id===taskId);
    if(original?.supersededBy&&saved.tasks.some(t=>t.id===original.supersededBy&&t.repairRootTaskId===(original.repairRootTaskId??original.id)))return this.receipt(owner,id);
    if((saved.repairRoutings??[]).some(r=>r.sourceTaskId===taskId&&r.sourceAttemptId===original?.attempts.at(-1)?.id&&r.ownerTaskId===repairTargetTaskId))return this.receipt(owner,id);
    await this.store.update(id,owner,revision,async team=>{assertPlanExecutable(team);if(team.executionControl&&team.executionControl.status!=='active'||team.dispatchPaused)throw new Error('Resume before repair planning');const target=team.tasks.find(t=>t.id===taskId),review=team.tasks.find(r=>r.kind==='review'&&reviewTargetIds(r).includes(taskId)&&(r.attempts.at(-1)?.batchReview?.targets?.some(v=>v.taskId===taskId&&v.decision==='rework')||r.attempts.at(-1)?.reworkRegistration?.targetAttemptId===target?.attempts.at(-1)?.id));
      if(target?.status!=='blocked'||!review)throw new Error('A recorded independent rework decision is required');
      if(!repairTargetTaskId||repairTargetTaskId===taskId){planRepair(team,review,target,note,{retainReview:true});return;}
      if(!target.contract||!['integration','verification'].includes(target.contract.stage)||target.contract.inScope?.length)throw new Error('Cross-task repair routing requires a verification-only source');
      const upstream=new Set(),queue=target.dependencies.map(d=>d.taskId);while(queue.length){const key=queue.shift();if(upstream.has(key))continue;upstream.add(key);queue.push(...(team.tasks.find(t=>t.id===key)?.dependencies??[]).map(d=>d.taskId));}
      const code=team.tasks.find(t=>t.id===repairTargetTaskId),codeReview=team.tasks.find(r=>r.kind==='review'&&r.status==='accepted'&&reviewTargetIds(r).includes(code?.id));
      if(!upstream.has(code?.id)||code?.status!=='accepted'||code.kind==='review'||code.supersededBy||!code.contract?.inScope?.length||!codeReview)throw new Error('Repair owner must be an independently accepted upstream code task within the existing scope');
      await assertEvidenceSnapshot(team,code);
      const result=planRepair(team,codeReview,code,note+'\nVerification finding: '+target.blockReason,{retainReview:true,sourceReview:review,sourceTarget:target});
      if(result){const repair=team.tasks.find(t=>t.id===result.repairTaskId);repair.context=(repair.context+'\nRetain findings on verification root '+(target.repairRootTaskId??target.id)+'; its next independent review must resolve them.').slice(-12000);
        (team.repairRoutings??=[]).push({sourceTaskId:target.id,sourceAttemptId:target.attempts.at(-1).id,sourceReviewTaskId:review.id,sourceReviewAttemptId:review.attempts.at(-1).id,ownerTaskId:code.id,...result,note,at:now()});
        team.events.push({type:'verification-repair-routed',taskId:target.id,ownerTaskId:code.id,...result,at:now()});
      }
    });return this.receipt(owner,id);
  }
  async finish(owner,id,revision,note,checks=[],reuseEvidence=true,batchId){
    const prior=await this.native(owner,id),priorScope=finishScope(prior,batchId),saved=priorScope.batch?.finalAcceptance??(!priorScope.batch?prior.finalAcceptance:null);
    if(saved){if(saved.note===note&&(!checks.length||JSON.stringify(saved.providedChecks??saved.checks)===JSON.stringify(checks)))return this.receipt(owner,id);throw new Error('Final acceptance is already recorded; add a new goal batch');}
    const cachedAccounting=this.observer.cachedTeamUsage?.(prior),economyUsage=cachedAccounting?usageReport(prior,[],cachedAccounting):{complete:false};
    await this.store.update(id,owner,revision,async t=>{
      assertPlanExecutable(t);if(t.executionControl&&t.executionControl.status!=='active'||['stopping','halted','archived','superseded'].includes(t.state))throw new Error('Resume the original team before final acceptance');
      const scope=finishScope(t,batchId);if(!scope.tasks.length)throw new Error('Plan concrete deliveries before final validation');
      if(!scope.tasks.every(x=>['accepted','cancelled'].includes(x.status)))throw new Error(scope.batch?'All deliveries require acceptance first':'All deliveries require independent acceptance first');
      if(scope.batch&&!scope.tasks.some(x=>x.kind!=='review'&&x.status==='accepted'))throw new Error('Cancelled work is not a completed goal');
      assertQualityFinish(scope.team);for(const task of scope.tasks.filter(t=>t.status==='accepted')){const verification=assertContractPass(task);if(verification)Object.assign(task.attempts.at(-1).delivery,verification);}
      const reused=reuseEvidence?await reuseFinalEvidence(scope.team):{checks:[],references:[]},finalChecks=[...checks,...reused.checks];
      if(finalChecks.some(c=>c.status!=='PASS'||!c.evidence?.trim())||scope.integrationRequired&&(!finalChecks.length||scope.batch&&!reused.references.length))throw new Error('Final project validation requires valid integration evidence; missing checks are not a pass and individual task checks alone are insufficient');
      const acceptance={source:'main-conversation-leader',note,checks:finalChecks,providedChecks:structuredClone(checks),reusedEvidence:reused.references,at:now(),...(scope.batch?{batchId:scope.batch.id,qualityMode:scope.batch.qualityMode,metrics:qualityMetrics(t,scope.batch.id)}:{})};
      if(scope.batch){scope.batch.state='delivered';scope.batch.finalAcceptance=acceptance;scope.batch.completedAt=acceptance.at;t.state='active';t.events.push({type:'goal-batch-delivered',batchId:scope.batch.id,at:acceptance.at});}
      else {t.state='delivered';t.finalAcceptance=acceptance;t.dispatchPaused=true;}
      if(scope.batch)acceptance.metrics=qualityMetrics(t,scope.batch.id);
      (t.efficiencyHistory??=[]).push({at:acceptance.at,batchId:scope.batch?.id??null,observation:'last-verified-accounting-before-final-receipt',...teamEconomy(t,economyUsage),historicalProfile:historicalCostProfile(t,economyUsage,scope.tasks)});
    });return this.receipt(owner,id);
  }
  async start(owner,id,revision){await this.native(owner,id);await this.store.update(id,owner,revision,t=>{assertDispatchAllowed(t);if(t.state==='superseded')throw new Error('Historical team cannot restart');if(t.state==='delivered')return;t.dispatchPaused=false;t.state='active';});return this.receipt(owner,id);}
  async addMembers(owner,id,revision,members,requestId,{reviewExpansion=false}={}){
    if(typeof requestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId))throw new Error('A stable UUID request ID is required');
    if(!Array.isArray(members)||!members.length||members.length>8)throw new Error('Provide 1–8 new members');
    // Accept configuration only. Native identity and initialization markers are
    // always assigned here, never copied from caller-provided runtime fields.
    const inputs=members.map(m=>({id:m.id,role:m.role,responsibility:m.responsibility,reason:m.reason,writeScopes:structuredClone(m.writeScopes),...(m.route?{route:{...(m.route.model?{model:m.route.model}:{}),...(m.route.reasoningEffort?{reasoningEffort:m.route.reasoningEffort}:{})}}:{})}));
    const hash=createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
    const replay=team=>{
      if(team.state==='superseded')throw new Error('This is a historical team; use the project’s current team');
      if(!team.fixedRoster)throw new Error('Adding members requires a fixed native roster');
      const saved=[...(team.memberAdditions??[]),...(team.planMemberRequests??[])].find(r=>r.requestId===requestId);
      if(saved&&saved.hash!==hash)throw new Error('Member addition request ID already has different contents');
      return saved;
    };
    const existing=replay(await this.native(owner,id));
    if(existing)return {...await this.receipt(owner,id),memberAddition:{requestId,memberIds:existing.memberIds,replayed:true}};
    let record;
    try{
      const updated=await this.store.update(id,owner,revision,t=>{
        replay(t);
        assertPlanMutable(t);
        const timestamp=now();
        if(t.planReview||reviewExpansion){stageExpansion(t,{members:inputs},inputs.map(m=>m.role+'：'+m.reason).join('；'));this.validateExpansion(t);const addition={requestId,hash,memberIds:inputs.map(m=>m.id),at:timestamp,pending:true};t.planMemberRequests??=[];t.planMemberRequests.push(addition);t.planMemberRequests=t.planMemberRequests.slice(-200);return addition;}
        t.members.push(...inputs.map(m=>({...m,status:'planned',agentThreadId:null,rosterMarker:`TEAM_WORKSPACE_MEMBER:${randomUUID()}`,rosterVerified:false,addedAt:timestamp,lastActivityAt:timestamp})));
        validatePlan(t);
        const addition={requestId,hash,memberIds:inputs.map(m=>m.id),at:timestamp};
        t.memberAdditions??=[];t.memberAdditions.push(addition);
        t.events.push({at:timestamp,type:'members-added-to-fixed-team',requestId,memberIds:addition.memberIds});
        return addition;
      });
      record=updated.result;
    }catch(error){
      // Concurrent retries may have committed while this request waited for the
      // revision lock. Recover that exact request, never create another role.
      const committed=replay(await this.native(owner,id));
      if(!committed)throw error;
      return {...await this.receipt(owner,id),memberAddition:{requestId,memberIds:committed.memberIds,replayed:true}};
    }
    return {...await this.receipt(owner,id),memberAddition:{requestId,memberIds:record.memberIds,replayed:false}};
  }
  async compileTasks(owner,id,revision,input,selectionContext={}){
    if(input.dispatchReady===true&&input.commit!==true)throw new Error('dispatchReady requires commit=true; preflight never reserves work');
    const team=await this.native(owner,id);
    const {revision:transportRevision,teamId:transportTeamId,dispatchReady:transportDispatch,dispatchView:transportView,...semanticInput}=input;
    const digest=createHash('sha256').update(JSON.stringify(semanticInput)).digest('hex');
    const prior=team.compiledPlans?.find(p=>p.requestId===input.requestId);
    if(prior){if(prior.inputHash!==digest)throw new Error('Plan request ID has different contents');return {...await this.receipt(owner,id),compiledPlan:{...prior,replayed:true},...(input.dispatchReady?{dispatches:[],dispatchReplay:{requiresReconciliation:true,instruction:'Compilation was already committed. Never redispatch an earlier packet. Reconcile existing reservations/native starts before normal next_team_step.'}}:{})};}
    if(team.revision!==revision)throw new Error('Team changed; refresh only revision before compiling.');
    const result=compileTeamTasks(team,input,selectionContext),forecast=economyForecast(team,input.forecast,result.valid?result.tasks:[]);
    if(!result.valid||input.commit!==true)return {...result,forecast};
    const data=await this.addTasks(owner,id,revision,result.tasks,{batch:result.batch,compiledPlan:{requestId:input.requestId,inputHash:digest,planHash:result.planHash,forecast,summary:result.summary}});
    const compiledPlan={requestId:input.requestId,planHash:result.planHash,summary:result.summary,warnings:result.warnings,forecast,replayed:false};
    if(!input.dispatchReady)return {...data,compiledPlan};
    // The saved plan and reservation are separate revision-checked transactions.
    // A stop/concurrent edit between them retains the plan but permits no stale
    // dispatch. Replaying compilation never starts or reserves another attempt.
    try{return {...await this.advance(owner,id,data.team.revision,{settleCompleted:false,dispatchReady:true}),compiledPlan};}
    catch(error){return {...await this.receipt(owner,id),compiledPlan,dispatches:[],advancement:{errors:[{operation:'dispatch',reason:error.message.slice(0,600)}]}};}
  }
  async economy(owner,id,input={}){const data=await this.read(owner,id);return {...teamEconomy(data.team,data.usage,input),phaseDecision:phaseEconomy(input.phaseEstimate??{})};}
  async addTasks(owner,id,revision,tasks,{scopeChange=false,note='',batch,batchReviewId,compiledPlan}={}){await this.native(owner,id);await this.store.update(id,owner,revision,t=>{
    if(t.state==='superseded')throw new Error('This is a historical team; use the project’s current team');
    assertPlanMutable(t);
    if(!Array.isArray(tasks)||!tasks.length)throw new Error('Provide concrete tasks with independent reviews');
    if(batchReviewId&&(scopeChange||t.planReview&&tasks.some(task=>!t.members.some(m=>m.id===task.memberId&&!m.removedAt))))throw new Error('A scope change needs a separate review proposal; an existing review cannot be expanded before approval');
    if(t.profileConstraints)tasks=tasks.map(task=>{const prefix='Template constraints: '+t.profileConstraints,context=task.context?.startsWith(prefix)?task.context:prefix+(task.context?'\n\nTask context: '+task.context:'');if(context.length>12000)throw new Error('Template constraints plus task context exceed 12000 characters');return {...task,context};});
    if(scopeChange||t.planReview&&tasks.some(task=>!t.members.some(m=>m.id===task.memberId&&!m.removedAt))){stageExpansion(t,{tasks,...(batch?{batch}:{})},note||'新增任务需要确认新的职责范围');this.validateExpansion(t);return;}
    const timestamp=now();t.tasks.push(...tasks.map(task=>({...task,status:'waiting',attempt:0,attempts:[],evidence:[],history:[{at:timestamp,type:'added'}],blockReason:null,createdAt:timestamp,updatedAt:timestamp})));
    if(tasks.some(task=>task.contract))t.requiresTeamWorkspaceVersion??='0.10.0';
    if(tasks.some(task=>task.reviewEvidencePolicy))requireTeamVersion(t,'0.40.45');
    if(tasks.some(task=>task.reviewScopePolicy))requireTeamVersion(t,'0.40.48');
    const added=t.tasks.filter(x=>tasks.some(n=>n.id===x.id));attachBatch(t,added,batch);
    if(compiledPlan)(t.compiledPlans??=[]).push({...compiledPlan,at:now()});
    if(batchReviewId){
      const review=t.tasks.find(x=>x.id===batchReviewId);
      if(!review||review.kind!=='review'||review.status!=='waiting'||review.attempts.length||review.supersededBy||review.batchId!==t.activeBatchId||added.some(x=>x.kind!=='work'||qualityMode(x)!=='standard'||x.memberId===review.memberId))throw new Error('Only an unstarted independent review in the same standard goal may accept new deliveries');
      const ids=reviewTargetIds(review);if(ids.some(id=>qualityMode(t.tasks.find(x=>x.id===id))!=='standard'))throw new Error('Strict review targets cannot be merged');
      review.reviewOfTaskIds=[...ids,...added.map(x=>x.id)];review.dependencies.push(...added.map(x=>({taskId:x.id,when:'submitted'})));review.updatedAt=timestamp;
      requireTeamVersion(t,'0.38.0');t.events.push({at:timestamp,type:'batch-review-expanded',taskId:review.id,targetTaskIds:added.map(x=>x.id),note});
    }
    requireTeamVersion(t,'0.37.0');validatePlan(t);assertReviewTopology(t);
    if(t.finalAcceptance){t.acceptanceHistory??=[];t.acceptanceHistory.push(t.finalAcceptance);delete t.finalAcceptance;}if(t.state==='delivered')t.dispatchPaused=false;if(!t.executionControl||t.executionControl.status==='active')t.state='active';t.events.push({at:timestamp,type:'tasks-added-to-fixed-team',taskIds:tasks.map(t=>t.id)});
  });return this.receipt(owner,id);}
  validateExpansion(team){const candidate=expansionCandidate(team);validatePlan(candidate);assertReviewTopology(candidate);if(!Number.isInteger(candidate.maxParallel)||candidate.maxParallel<1||candidate.maxParallel>8)throw new Error('Parallel member limit must be 1–8');}
  async requestPlanFeedback(owner,id,revision,input){const old=await this.native(owner,id);if(old.planReview?.feedback?.requestId===input.requestId){requestPlanFeedback(structuredClone(old),input);return this.readPlan(owner,id);}await this.store.update(id,owner,revision,t=>requestPlanFeedback(t,input));return this.readPlan(owner,id);}
  async readPlan(owner,id){return editablePlan(await this.native(owner,id));}
  async revisePlan(owner,id,revision,configuration,brief){await this.store.update(id,owner,revision,t=>{if(t.planReview?.scope==='expansion'){updateExpansionDraft(t,configuration,brief);this.validateExpansion(t);return;}updateDraft(t,configuration,brief);validatePlan(t);assertReviewTopology(t);});return this.readPlan(owner,id);}
  async proposeChange(owner,id,revision,change,brief){await this.store.update(id,owner,revision,t=>{stageExpansion(t,change,brief);this.validateExpansion(t);});return this.receipt(owner,id);}
  async configurePolicy(owner,id,revision,policy,{reviewExpansion=false}={}){await this.store.update(id,owner,revision,t=>{assertPlanMutable(t);const next=normalizePolicy({...t.policy,...policy});if((t.planReview||reviewExpansion)&&policyExpands(t.policy,next)){stageExpansion(t,{policy:next},'提高执行预算或自动修复额度');this.validateExpansion(t);return;}t.policy=next;if(next.providerConcurrency||next.modelConcurrency)requireTeamVersion(t,'0.38.0');if(next.autoRepair)t.requiresTeamWorkspaceVersion??='0.10.0';});return this.receipt(owner,id);}
  async decidePlan(owner,id,revision,input,action){
    const existing=reviewRequest(await this.native(owner,id),input,action);if(existing.saved)return {...await this.receipt(owner,id),planDecision:{replayed:true,action}};
    let replayed=false;try{await this.store.update(id,owner,revision,t=>{
      const request=reviewRequest(t,input,action),p=t.planReview;if(request.saved)return;
      if(action==='approve'){
        if(p.scope==='initial'){if(!t.executionControl||t.executionControl.status==='active'){t.dispatchPaused=false;t.state='active';}}
        else {this.validateExpansion(t);const pending=p.pending,at=now();t.members.push(...pending.members.map(m=>({...m,status:'planned',agentThreadId:null,rosterMarker:`TEAM_WORKSPACE_MEMBER:${randomUUID()}`,rosterVerified:false,addedAt:at,lastActivityAt:at})));if(pending.members.length){t.memberAdditions??=[];t.memberAdditions.push({requestId:input.requestId,hash:planHash(pending.members),memberIds:pending.members.map(m=>m.id),at});}t.tasks.push(...pending.tasks.map(task=>({...task,status:'waiting',attempt:0,attempts:[],evidence:[],blockReason:null,createdAt:at,updatedAt:at})));if(pending.policy)t.policy=pending.policy;if(pending.maxParallel)t.maxParallel=pending.maxParallel;if(pending.tasks.length){if(t.finalAcceptance){t.acceptanceHistory??=[];t.acceptanceHistory.push(t.finalAcceptance);delete t.finalAcceptance;}t.state='active';}}
      }else if(p.scope==='initial'){t.dispatchPaused=true;t.state='cancelled';for(const task of t.tasks)task.status='cancelled';}
      if(action==='approve'&&p.scope==='expansion'&&p.pending.tasks.length)attachBatch(t,t.tasks.filter(task=>p.pending.tasks.some(n=>n.id===task.id)),p.pending.batch);
      if(t.executionControl&&t.executionControl.status!=='active'){t.dispatchPaused=true;t.state=t.executionControl.status;}finishPlanDecision(t,input,action,request.hash);
    });}catch(error){if(!reviewRequest(await this.native(owner,id),input,action).saved)throw error;replayed=true;}
    return {...await this.receipt(owner,id),planDecision:{replayed,action}};
  }
  async amendContract(owner,id,revision,input){const team=await this.native(owner,id),prior=team.contractAmendments?.find(r=>r.requestId===input.requestId);if(prior){amendContract(structuredClone(team),input);return this.receipt(owner,id);}await this.store.update(id,owner,revision,t=>{amendContract(t,input);validatePlan(t);});return this.receipt(owner,id);}
  async changeMember(owner,id,revision,requestId,payload){
    if(typeof payload.note!=='string'||!payload.note.trim()||payload.note.length>3000)throw new Error('Member changes require an explicit reason');
    const team=await this.native(owner,id),check=lifecycleRequest(team,requestId,payload);
    if(check.prior)return {...await this.receipt(owner,id),memberChange:{...check.prior.result,replayed:true,requestId}};
    if(team.revision!==revision)throw new Error('Team changed; refresh before changing members');
    const task=payload.type==='reassign'?team.tasks.find(t=>t.id===payload.taskId):undefined;
    const source=team.members.find(m=>m.id===(task?.memberId??payload.memberId)&&!m.removedAt);
    if(!source)throw new Error('Active source member not found');
    // Check business invariants on a clone before reading any native transcript.
    const preview=structuredClone(team);if(payload.type==='reassign')reassignTask(preview,payload);else removeMember(preview,payload);validatePlan(preview);
    await verifyQuiescence(team,source,this.observer,{task});
    let result;
    try{
      ({result}=await this.store.update(id,owner,revision,t=>{
        lifecycleRequest(t,requestId,payload);
        const result=payload.type==='reassign'?reassignTask(t,payload):removeMember(t,payload);
        (t.memberChanges??=[]).push({requestId,hash:check.hash,at:now(),result});return result;
      }));
    }catch(error){const {prior}=lifecycleRequest(await this.native(owner,id),requestId,payload);if(!prior)throw error;return {...await this.receipt(owner,id),memberChange:{...prior.result,replayed:true,requestId}};}
    return {...await this.receipt(owner,id),memberChange:{...result,replayed:false,requestId}};
  }
  async reassign(owner,id,revision,taskId,memberId,note,requestId){return this.changeMember(owner,id,revision,requestId,{type:'reassign',taskId,memberId,note});}
  async removeMember(owner,id,revision,memberId,note,requestId){return this.changeMember(owner,id,revision,requestId,{type:'remove',memberId,note});}
  async updateMemberGoal(owner,id,revision,input){
    const team=await this.native(owner,id),request=memberGoalRequest(team,input);
    if(request.prior)return {...memberGoalDetail(team,input.memberId,{historyLimit:0}),change:{requestId:input.requestId,replayed:true}};
    let change;try{({result:change}=await this.store.update(id,owner,revision,t=>changeMemberGoal(t,input)));}
    catch(error){const {prior}=memberGoalRequest(await this.native(owner,id),input);if(!prior)throw error;change={...prior,replayed:true};}
    return {...memberGoalDetail(await this.native(owner,id),input.memberId,{historyLimit:0}),change:{requestId:input.requestId,replayed:change.replayed}};
  }
  async pause(owner,id,revision){await this.native(owner,id);await this.store.update(id,owner,revision,pauseDispatch);return this.receipt(owner,id);}
  async stop(owner,id,revision,input){
    const t=await this.native(owner,id);if(!input||!controlRequest(t,'stop',input).saved)try{
      const task=t.tasks.find(x=>x.executionMode==='leader'&&x.status==='running'&&x.attempts.at(-1)?.turnId),run=task?await this.observer.inspectLeader(t.leaderThreadId,t.projectPath,task.attempts.at(-1).turnId,{allowStopped:true,allowHistoricalStop:true}):null;
      if(run?.commands.some(c=>!['completed','failed'].includes(c.status)||!Number.isInteger(c.exitCode)))throw new Error('Wait for the existing Leader command to end before sealing a cooperative stop; do not interrupt the root through child controls');
      await this.store.update(id,owner,revision,team=>{requestStop(team,input);if(task){const a=team.tasks.find(x=>x.id===task.id).attempts.at(-1);a.leaderStopCheckpoint={source:'authenticated-leader-stop',threadId:team.leaderThreadId,turnId:a.turnId,observation:run,commandHash:executionHash(run.commands),at:now(),scope:'assigned-task-only; native-Leader-may-remain-active'};}});
    }catch(error){if(!input||!controlRequest(await this.native(owner,id),'stop',input).saved)throw error;}
    const data=await this.receipt(owner,id),active=data.team.executionControl?.status==='stopping'&&(!input||data.team.executionControl.requestId===input.requestId),targets=active?stopTargets(data.team).filter(x=>x.threadId!==data.team.leaderThreadId):[];return {...data,leaderAction:active?{type:'interrupt-native-members',leaderWork:'cooperatively-paused; native-Leader-status-preserved',targets:this.adapter?.interruptTargets?await this.adapter.interruptTargets(data.team,targets):targets,note:'Stop child members using verified native identity; tool=null requires native identity verification before control. Leader task work is cooperatively paused, not a synthetic native turn end. Reconcile the saved task stop and actual child terminal states; unknown children are never halted.'}:null};
  }
  async reconcileStop(owner,id,revision,{unstartedTaskIds=[],note=''}={}){
    const team=await this.native(owner,id);if(team.executionControl?.status!=='stopping')throw new Error('Team is not stopping');
    if(unstartedTaskIds.length&&!note.trim())throw new Error('Record host evidence that these dispatches never started');
    const observations=await Promise.all(stopTargets(team).filter(x=>x.threadId).map(async x=>{
      const m=team.members.find(m=>m.id===x.memberId),a=team.tasks.find(t=>t.id===x.taskId)?.attempts.at(-1),last=a??lastMemberExecution(team,m)?.attempt;
      if(x.threadId===team.leaderThreadId){const c=last?.leaderStopCheckpoint;if(a&&!c)return {...x,error:'Leader task has no authenticated cooperative stop checkpoint'};return {...x,run:c?.observation??last?.observation,leaderCooperativeStop:true};}
      try{const run=await this.observer.inspect(team.leaderThreadId,team.projectPath,x.threadId,last?.marker??m.rosterMarker,{allowPending:true,requireIdle:true,boundTurnId:last?.turnId});if(last)assertObservationTurn(last,run);return {...x,run};}
      catch(error){try{if(!this.observer.inspectIdle)throw error;return {...x,run:await this.observer.inspectIdle(team.leaderThreadId,team.projectPath,x.threadId),associationError:error.message};}catch(idleError){return {...x,error:idleError.message};}}
    }));
    await this.store.update(id,owner,revision,async t=>{
      const pending=[];
      for(const item of observations){if(item.error||!item.leaderCooperativeStop&&!item.run?.quiescence){pending.push({memberId:item.memberId,reason:item.error??'Latest native turn has no confirmed terminal record'});continue;}
        const m=t.members.find(m=>m.id===item.memberId),task=t.tasks.find(task=>task.id===item.taskId),a=task?.attempts.at(-1);
        if(item.leaderCooperativeStop){if(a){a.stopEvidence={source:'authenticated-leader-task-stop',note,nativeStatus:item.run.status};a.state='stopped';a.endedAt=now();task.status='blocked';task.blockReason='Leader task cooperatively stopped; preserve command and source evidence, explicitly select retry when resuming';}m.status='idle';continue;}
        if(a){
          if(!item.associationError)associateTurn(t,task,item.run);
          a.stopEvidence={quiescence:item.run.quiescence,note,...(item.associationError?{associationError:item.associationError}: {})};
          if(!item.associationError&&item.run.status==='completed')try{await this.submitObserved(t,task,item.run);}catch(error){a.stopEvidence.settlementError=error.message;}
          if(task.status==='running'){a.state=unstartedTaskIds.includes(task.id)&&!a.turnId&&!item.associationError?'released':'stopped';a.endedAt=now();task.status=a.state==='released'?'waiting':'blocked';task.blockReason=a.stopEvidence.associationError??a.stopEvidence.settlementError??'Team stopped; explicitly select retry tasks when resuming';}
        }
        if(!a&&!lastMemberExecution(t,m)&&item.run.status==='completed'&&item.run.turnId){m.rosterVerified=true;m.initializationTurnId=item.run.turnId;}m.status='idle';m.stopObservation=item.run.quiescence;
      }
      for(const task of t.tasks.filter(task=>task.status==='running'&&!task.attempts.at(-1)?.agentThreadId))pending.push({taskId:task.id,reason:'Verify and bind or release the unbound reservation'});
      t.executionControl.pending=pending;t.executionControl.observedAt=now();
      if(!pending.length){t.executionControl.status='halted';t.executionControl.stoppedAt=now();t.state='halted';}
    });return this.receipt(owner,id);
  }
  async resume(owner,id,revision,input){const t=await this.native(owner,id);if(!controlRequest(t,'resume',input).saved)try{await this.store.update(id,owner,revision,t=>resumeTeam(t,input));}catch(error){if(!controlRequest(await this.native(owner,id),'resume',input).saved)throw error;}return this.receipt(owner,id);}
  async continueInterrupted(owner,id,revision,input){
    const team=await this.native(owner,id),task=team.tasks.find(t=>t.id===input.taskId),a=task?.attempts.at(-1);
    const hash=createHash('sha256').update(JSON.stringify({taskId:input.taskId,attemptId:input.attemptId,reason:input.reason})).digest('hex');
    const prior=team.interruptedContinuations?.find(r=>r.requestId===input.requestId);
    if(prior){if(prior.hash!==hash)throw new Error('Continuation request ID already has different contents');return this.receipt(owner,id);}
    if(!input.reason?.trim()||! /^[0-9a-f-]{36}$/i.test(input.requestId??''))throw new Error('A stable UUID and a non-empty reason are required');
    if(team.revision!==revision)throw new Error('Team changed; refresh before continuing');
    const member=team.members.find(m=>m.id===task?.memberId);
    if(task?.status!=='blocked'||a?.id!==input.attemptId||a.state!=='interrupted'||!a.turnId||!a.agentThreadId||!a.endedAt||member?.removedAt||member?.agentThreadId!==a.agentThreadId||(member.contextGeneration??1)!==(a.contextGeneration??1)||(task.contractRevision??1)!==(a.contractRevision??1)||(member.goalRevision??1)!==(a.memberGoalSnapshot?.revision??1))throw new Error('Only the current interrupted attempt in its unchanged member context can continue');
    if(['superseded','archived','delivered'].includes(team.state)||team.dispatchPaused||team.executionControl&&team.executionControl.status!=='active')throw new Error('Resume the stopped team before continuing its interrupted task');
    const blockers=dispatchBlockers(team,{...task,status:'waiting'}).filter(b=>b.code!=='attempt-limit');
    if(blockers.length)throw new Error('Continuation is not ready: '+blockers.map(b=>b.message).join('; '));
    if((a.dependencyAttempts??[]).some(d=>{const upstream=team.tasks.find(t=>t.id===d.taskId);return upstream?.attempts.at(-1)?.id!==d.attemptId||(upstream?.contractRevision??1)!==(d.contractRevision??1);}))throw new Error('Upstream delivery changed; preserve the interrupted attempt and plan new scoped work');
    const run=await this.observer.inspect(team.leaderThreadId,team.projectPath,a.agentThreadId,a.marker,{boundTurnId:a.turnId,requireIdle:true,...registrationOptions(a)});
    assertObservationTurn(a,run);
    if(run.status!=='interrupted'||run.turnId!==a.turnId||run.latestTurnId!==a.turnId||run.statusEvidence?.status!=='interrupted'||!['persisted-turn-aborted','persisted-native-task-stop'].includes(run.statusEvidence.source))throw new Error('Latest native turn is not a verified interruption');
    if(team.policy?.tokenLimit)assertBudget(team,await this.observations(team),await this.accounting(team,{fresh:true}));
    await this.store.update(id,owner,revision,t=>{
      const current=t.tasks.find(x=>x.id===input.taskId),attempt=current.attempts.at(-1),m=t.members.find(x=>x.id===current.memberId);
      (attempt.interruptionHistory??=[]).push({turnId:attempt.turnId,endedAt:attempt.endedAt,observation:structuredClone(attempt.observation),reason:input.reason,at:now()});
      attempt.state='running';attempt.endedAt=null;attempt.continuationRequested={turnId:attempt.turnId,requestId:input.requestId,at:now()};current.status='running';current.blockReason=null;current.updatedAt=now();m.status='running';
      (t.interruptedContinuations??=[]).push({requestId:input.requestId,hash,taskId:current.id,attemptId:attempt.id,threadId:attempt.agentThreadId,turnId:attempt.turnId,reason:input.reason,at:now()});
      t.events.push({type:'native-task-continuation-requested',taskId:current.id,attemptId:attempt.id,at:now()});requireTeamVersion(t,'0.39.0');
    });
    const saved=await this.native(owner,id);
    return {...await this.receipt(owner,id),dispatch:this.packet(saved,saved.tasks.find(x=>x.id===input.taskId)),instruction:'Continue this SAME attempt marker in the SAME native member thread. Do not claim, rework, spawn or replay this request. Native continuation remains a Leader action; no model was started.'};
  }
  async release(owner,id,revision,taskId,attemptId,note){await this.native(owner,id);await this.store.update(id,owner,revision,t=>{
    const task=t.tasks.find(x=>x.id===taskId),a=task?.attempts.at(-1);if(!a||a.id!==attemptId||a.agentThreadId||a.state!=='reserved')throw new Error('Only an unbound reservation can be released after Leader verifies no member was launched');
    a.state='released';a.summary=note;a.endedAt=now();task.status='waiting';t.members.find(x=>x.id===task.memberId).status='idle';
  });return this.receipt(owner,id);}
  async recoverStartup(owner,id,revision,input){
    let team=await this.native(owner,id);
    const prior=team.tasks.flatMap(t=>t.attempts).find(a=>a.startupRecovery?.requestId===input.requestId);
    if(prior){if(prior.id!==input.attemptId||prior.startupRecovery.taskId!==input.taskId)throw Error('Startup recovery request already identifies a different reservation');return {...await this.receipt(owner,id),startupRecovered:{replayed:true,attemptId:prior.id}};}
    if(team.revision!==revision)throw Error('Team changed; preserve the current startup and refresh once');
    assertDispatchAllowed(team);if(team.dispatchPaused||team.executionControl&&team.executionControl.status!=='active')throw Error('Startup recovery is paused');
    const task=team.tasks.find(t=>t.id===input.taskId),a=task?.attempts.at(-1),member=team.members.find(m=>m.id===task?.memberId);
    if(task?.status!=='running'||a?.id!==input.attemptId||a.state!=='reserved'||!a.bootstrap||a.agentThreadId||a.bootstrapSource||a.memberSubmission||a.delivery||a.turnId||member?.agentThreadId)throw Error('Only an unbound, never-authorized failed bootstrap may recover; preserve running work or existing results');
    if(task.attempts.filter(a=>a.startupRecovery).length>=3)throw Error('Startup recovery limit reached; resolve the launch configuration before another attempt');
    const normalize=run=>run.startupTerminal?{...run,turnId:run.startupTerminal.turnId,status:run.startupTerminal.status}:run;
    const first=normalize(await this.observer.inspectStartup(team,task)),proof=first.startupRecovery;
    if(!first.threadId||first.parentThreadId!==team.leaderThreadId||!terminal(first.status)||proof?.source!=='native-startup-history'||!proof.allTurnsTerminal||!proof.noExecutionItems||proof.noPublicDelivery!==true||!proof.turnIds?.length)throw Error('Startup recovery requires authenticated terminal native history with no execution or successful tools; running, unknown and executed work cannot be replaced');
    if(!a.startupBaseline?.fingerprint)throw Error('Original startup input baseline is missing; preserve legacy work and reconcile existing evidence, never infer unchanged inputs');
    const snapshot=await captureEvidenceSnapshot(team,{...task,validationMode:'source-only'},a.startupBaseline?.roots??[...new Set([...(task.contract?.inScope??member.writeScopes??[]),...(task.contract?.readPaths??[])])]);
    if(a.startupBaseline&&(snapshot.workspace!==a.startupBaseline.workspace||snapshot.fingerprint!==a.startupBaseline.fingerprint))throw Error('Candidate changed since reservation; preserve evidence and reconcile existing work, never redispatch for registration');
    const checked=normalize(await this.observer.inspectStartup(team,task));
    if(checked.threadId!==first.threadId||checked.turnId!==first.turnId||checked.status!==first.status||JSON.stringify(checked.startupRecovery)!==JSON.stringify(proof))throw Error('Native startup changed during recovery; preserve the reservation');
    await this.store.update(id,owner,revision,async t=>{
      const current=t.tasks.find(t=>t.id===task.id),attempt=current.attempts.at(-1),m=t.members.find(m=>m.id===current.memberId);
      if(attempt.id!==a.id||attempt.state!=='reserved'||attempt.agentThreadId||attempt.bootstrapSource||m.agentThreadId)throw Error('Startup acquired authority concurrently; recovery refused');
      // A reviewer has no write scope. Its own empty startup baseline is not
      // proof that the submitted candidate it was assigned to inspect is still
      // the same. Verify exact dependency identities and original file hashes;
      // this reads saved evidence and never runs a verification command.
      const reviewCandidates=[];
      if(current.kind==='review')for(const targetId of reviewTargetIds(current)){
        const target=t.tasks.find(x=>x.id===targetId),dependency=attempt.dependencyAttempts?.find(d=>d.taskId===targetId),latest=target?.attempts.at(-1);
        if(!dependency||!latest||dependency.attemptId!==latest.id||(dependency.contractRevision??1)!==(target.contractRevision??1)||!['submitted','accepted'].includes(target.status))throw Error('Review candidate identity changed or is missing; preserve the original startup and review evidence');
        const checked=await assertEvidenceSnapshot(t,target);
        reviewCandidates.push({taskId:targetId,attemptId:latest.id,contractRevision:target.contractRevision??1,workspace:checked.workspace,fingerprint:checked.fingerprint,roots:checked.roots});
      }
      attempt.agentThreadId=checked.threadId;attempt.turnId=checked.turnId;attempt.endedAt=now();attempt.state='failed';m.agentThreadId=checked.threadId;m.agentPath=checked.agentPath;
      attempt.startupRecovery={source:'verified-terminal-bootstrap-recovery',requestId:input.requestId,taskId:current.id,native:structuredClone(checked),candidate:snapshot,...(reviewCandidates.length?{reviewCandidates}:{}),at:now(),codeRepairBudgetConsumed:false,reviewBudgetConsumed:false};
      current.status='waiting';retireTaskContext(t,m,checked);attempt.state='released';attempt.summary='Native bootstrap ended before work authorization; original startup retained';current.status='waiting';current.blockReason=null;m.status='idle';
      t.events.push({type:'startup-recovered',taskId:current.id,attemptId:attempt.id,threadId:checked.threadId,requestId:input.requestId,at:now(),codeRepairBudgetConsumed:false,reviewBudgetConsumed:false});
    });
    return {...await this.receipt(owner,id),startupRecovered:{attemptId:a.id,threadId:checked.threadId,historyPreserved:true,testsExecuted:false,readyToReserve:true}};
  }
  async rework(owner,id,revision,taskId,note){await this.native(owner,id);await this.store.update(id,owner,revision,t=>{
    if(t.state==='delivered')throw new Error('Delivered work needs a new scoped task');
    const target=t.tasks.find(x=>x.id===taskId);if(!target||!['submitted','accepted','blocked'].includes(target.status))throw new Error('Task is not ready for rework');
    const reviewTarget=target.kind==='review'?t.tasks.find(x=>x.id===target.reviewOfTaskId):null;
    if(reviewTarget&&!['submitted','accepted'].includes(reviewTarget.status))throw new Error('Review-only recheck needs a submitted implementation');
    const affected=new Set([reviewTarget?.id??taskId]);for(let changed=true;changed;){changed=false;for(const row of t.tasks)if(!affected.has(row.id)&&row.dependencies.some(d=>affected.has(d.taskId))){affected.add(row.id);changed=true;}}
    for(const row of t.tasks.filter(x=>affected.has(x.id)))if(row.status==='running')throw new Error('Stop and settle affected native members before rework');
    for(const row of t.tasks.filter(x=>affected.has(x.id))){if(row.status==='cancelled')continue;row.status=row.id===reviewTarget?.id?'submitted':'waiting';row.blockReason=note;row.history??=[];row.history.push({type:'leader-rework',note,at:now()});}
    t.state='rework-planned';pauseDispatch(t);
  });return this.receipt(owner,id);}
  async memberClaim(owner,id,revision,context,input){
    const t=await this.native(owner,id),r=memberClaimRequest(t,context,input);
    if(r.prior)return memberClaimPayload(this.packet(t,r.task),t.revision,input.knownPromptHash);
    const data=await this.claim(owner,id,revision,input.taskId);
    await this.store.update(id,owner,data.team.revision,t=>{const a=t.tasks.find(task=>task.id===input.taskId).attempts.at(-1);(t.memberClaims??=[]).push({requestId:input.requestId,hash:r.hash,memberId:r.member.id,taskId:input.taskId,attemptId:a.id,at:now()});requireTeamVersion(t,'0.12.0');});
    const saved=await this.native(owner,id);return memberClaimPayload(this.packet(saved,saved.tasks.find(task=>task.id===input.taskId)),saved.revision,input.knownPromptHash);
  }
  async memberBind(owner,id,revision,context,input){const t=await this.native(owner,id),m=assertMember(t,context),task=t.tasks.find(task=>task.id===input.taskId);if(task?.memberId!==m.id)throw new Error('Only your own task may be bound');return this.bind(owner,id,revision,input.taskId,input.attemptId,context.threadId);}
  async memberBootstrap(owner,id,context,input){
    for(let tries=0;tries<4;tries++){
      const team=await this.native(owner,id);input=bootstrapStartInput(team,context,input);const {attempt}=bootstrapReservation(team,context,input);
      const taskContext=await readDispatchContext(this.root,team,input);
      const member=team.members.find(m=>m.id===team.tasks.find(t=>t.id===input.taskId).memberId);
      let run;
      try{run=await this.observer.inspect(team.leaderThreadId,team.projectPath,context.threadId,attempt.marker,{requireFresh:!!attempt.contextGeneration,boundTurnId:attempt.turnId,launchMember:member,authenticatedSelfBootstrap:true,beforeFirstBootstrap:!attempt.agentThreadId&&!attempt.bootstrapSource});}
      catch(error){
        if(error.code==='NATIVE_LAUNCH_REJECTED'&&!attempt.agentThreadId)await this.store.update(id,owner,team.revision,t=>{const a=t.tasks.find(t=>t.id===input.taskId).attempts.at(-1);if(a.id!==attempt.id||a.agentThreadId)throw Error('Startup changed');a.startupRejections??=[];if(!a.startupRejections.some(r=>r.threadId===context.threadId&&r.reason===error.message))a.startupRejections.push({threadId:context.threadId,reason:error.message,source:'authenticated-child-launch-gate',at:now(),executionAuthority:false});});
        throw error;
      }
      assertBootstrapObservation(team,context,input,run);
      if(attempt.agentThreadId===context.threadId&&attempt.turnId===run.turnId)return {kind:'member-bootstrap',teamId:id,revision:team.revision,taskId:input.taskId,attemptId:attempt.id,readyForWork:true,...taskContext,...(taskContext.taskContext?{reviewInputs:await reviewInputs(team,team.tasks.find(t=>t.id===input.taskId),{root:this.root,context}),sourceInputs:await bootstrapSource(team,context,team.tasks.find(t=>t.id===input.taskId))}:{}),turnId:run.turnId,reportArguments:{teamId:id,bootstrapToken:attempt.bootstrap.token},deliveryTemplate:deliveryTemplate(team,team.tasks.find(t=>t.id===input.taskId)),nextReportRequestId:randomUUID(),reportProgram:memberReportProgram(),memberReportInvocation,instruction:'Use the cached authenticated member report invocation, end with the saved receipt and retain independent review. No parent binding or ready wait.'};
      try{
        await this.store.update(id,owner,team.revision,t=>{
          const {task,attempt:a,member}=bootstrapReservation(t,context,input);assertBootstrapObservation(t,context,input,run);assertObservationTurn(a,run);
          bindMemberThread(t,task.id,context.threadId,a.id);member.agentPath=run.agentPath;member.rosterVerified=true;member.initializationTurnId??=run.turnId;
          a.state='running';associateTurn(t,task,run);a.boundAt=now();a.bootstrapSource='authenticated-member-native-observation';a.bootstrapTurnId=run.turnId;if(run.launchIdentity)requireTeamVersion(t,'0.40.48');a.executedRoute={model:run.model??nativeRoute(member).model??null,provider:run.provider??member.routeSnapshot?.provider??null,reasoningEffort:run.reasoningEffort??nativeRoute(member).reasoning_effort??null,source:run.model?'host-observed-model':'frozen-route-only'};t.totalDispatches++;
          t.events.push({at:now(),type:'member-self-bound',taskId:task.id,attemptId:a.id,threadId:context.threadId,turnId:run.turnId});
        });
      }catch(error){if(!/Team changed in another Desktop window/.test(error.message)||tries===3)throw error;}
    }
    // A fourth successful concurrent commit is returned without another bind.
    const team=await this.native(owner,id);input=bootstrapStartInput(team,context,input);const {attempt}=bootstrapReservation(team,context,input);
    if(attempt.agentThreadId!==context.threadId||!attempt.turnId)throw new Error('Bootstrap contention; retry this same active native turn');
    const taskContext=await readDispatchContext(this.root,team,input);
    return {kind:'member-bootstrap',teamId:id,revision:team.revision,taskId:input.taskId,attemptId:attempt.id,readyForWork:true,...taskContext,...(taskContext.taskContext?{reviewInputs:await reviewInputs(team,team.tasks.find(t=>t.id===input.taskId),{root:this.root,context}),sourceInputs:await bootstrapSource(team,context,team.tasks.find(t=>t.id===input.taskId))}:{}),turnId:attempt.turnId,reportArguments:{teamId:id,bootstrapToken:attempt.bootstrap.token},deliveryTemplate:deliveryTemplate(team,team.tasks.find(t=>t.id===input.taskId)),nextReportRequestId:randomUUID(),reportProgram:memberReportProgram(),memberReportInvocation};
  }
  async checkpointRun(team,input){
    const task=team.tasks.find(t=>t.id===input.taskId),a=task?.attempts.at(-1);
    if(!['running','submitted'].includes(task?.status)||a?.id!==input.attemptId||!a.agentThreadId)throw new Error('Checkpoint requires a bound active native attempt');
    const run=await this.observer.inspect(team.leaderThreadId,team.projectPath,a.agentThreadId,a.marker,{boundTurnId:a.turnId,...registrationOptions(a)});
    assertObservationTurn(a,run);
    if(!run.turnId||!['inProgress','completed'].includes(run.status)||(run.latestTurnId&&run.latestTurnId!==run.turnId))throw new Error('Current checkpoint turn is not verified; emit the attempt marker in the resumed native turn and retry');
    return run;
  }
  async memberReport(owner,id,revision,context,input){
    if(input.bootstrapToken){
      // Team-wide revision can change when unrelated members report. A reserved
      // capability fences the exact contract/attempt instead; legacy CAS stays.
      for(let tries=0;tries<4;tries++){
        const current=await this.native(owner,id),resolved=bootstrapReportInput(current,context,input);bootstrapReservation(current,context,resolved,{requireDispatch:false});
        try{return await this.memberReport(owner,id,current.revision,context,{...resolved,bootstrapToken:undefined});}
        catch(error){if(!/Team changed/.test(error.message)||tries===3)throw error;}
      }
    }
    const team=await this.native(owner,id),member=assertMember(team,context),task=team.tasks.find(t=>t.id===input.taskId);
    if(task?.memberId!==member.id||task.status!=='running'||task.attempts.at(-1)?.id!==input.attemptId||task.attempts.at(-1)?.agentThreadId!==context.threadId)throw new Error('Only your bound current attempt may report progress');
    if(team.revision!==revision)throw new Error('Team changed; refresh before recording progress');
    const existing=team.checkpoints?.find(c=>c.requestId===input.requestId?.toLowerCase()),run=existing?null:await this.checkpointRun(team,input);
    const preflight=input.delivery!==undefined&&(task.contract||task.kind==='review')?preflightDelivery(team,task,member,input.delivery,run?.commands??task.attempts.at(-1).observation?.commands??[]):null;
    if(preflight&&!preflight.valid){
      const hash=deliveryHash(input.delivery),attempt=task.attempts.at(-1);
      let saved=team;
      if(!attempt.submissionDrafts?.some(d=>d.requestId===input.requestId&&d.hash===hash))saved=(await this.store.update(id,owner,revision,t=>{const a=t.tasks.find(x=>x.id===task.id).attempts.at(-1);(a.submissionDrafts??=[]).push({requestId:input.requestId,hash,text:input.delivery,turnId:run?.turnId??a.turnId,status:'format-rejected',errors:preflight.errors,source:'authenticated-member',at:now()});})).team;
      return {kind:'member-delivery-preflight',correctionMode:'same-attempt',reviewBudgetConsumed:false,verificationEvidence:await currentVerificationEvidence(this.root,team,task,run?.commands??task.attempts.at(-1).observation?.commands??[]),revision:saved.revision,nextReportRequestId:randomUUID(),deliveryPreflight:preflight,repairTemplate:deliveryTemplate(team,task),startsModel:false,runsCommands:false,instruction:'Resolve the explicit format or decision contradiction in this SAME turn with a fresh requestId and returned revision. Required contract failures need factual rework findings or an explicit blocker, regardless of severity; never relabel FAIL as PASS or rewrite another member delivery to register acceptance. repairTemplate gives the required structure, not a verdict. Retain valid checks, findings and original evidence. No new audit or test run is needed for a report-only correction.'};
    }
    const r=await this.store.update(id,owner,revision,t=>{if(run)associateTurn(t,t.tasks.find(t=>t.id===input.taskId),run);return memberReport(t,context,{...input,...(preflight?{preflight}: {})});});
    return {...r.result,revision:r.team.revision};
  }
  async close(){await this.observer.close?.();}
  async message(owner,id,revision,taskId,text,requestId){
    await this.native(owner,id);const {team,result}=await this.store.update(id,owner,revision,t=>{const before=t.messages?.length??0;const message=queueMessage(t,{taskId,text,requestId});return {message,firstOffer:t.messages.length>before};});
    return {...await this.receipt(owner,id),leaderAction:messageAction(team,result.message,result.firstOffer)};
  }
  async checkpoint(owner,id,revision,input){
    const team=await this.native(owner,id);
    if(team.revision!==revision)throw new Error('Team changed; refresh before recording progress');
    const existing=team.checkpoints?.find(c=>c.requestId===input.requestId?.toLowerCase()),run=existing?null:await this.checkpointRun(team,input);
    const {result}=await this.store.update(id,owner,revision,t=>{if(run)associateTurn(t,t.tasks.find(t=>t.id===input.taskId),run);return recordCheckpoint(t,input);});
    return {...await this.receipt(owner,id),checkpoint:result};
  }
  async handoff(owner,id,taskId){
    const team=await this.native(owner,id),handoff=buildHandoff(team,taskId),attempt=team.tasks.find(t=>t.id===taskId).attempts.at(-1);
    return {team,handoff:{...handoff,currentExecution:attempt?{attemptId:attempt.id,state:attempt.state,observationMode:'saved',observation:attempt.observation??null}:null}};
  }
  async messageDelivery(owner,id,revision,messageId,status,note){await this.native(owner,id);await this.store.update(id,owner,revision,t=>recordMessageDelivery(t,messageId,status,note));return this.receipt(owner,id);}
  async reconcileMessage(owner,id,revision,messageId){
    const team=await this.native(owner,id),message=team.messages?.find(m=>m.id===messageId);if(!message)throw new Error('Message not found');
    const attempt=team.tasks.find(t=>t.id===message.taskId)?.attempts.find(a=>a.id===message.attemptId);
    if(!attempt?.marker)throw new Error('Original message attempt unavailable');
    const run=await this.observer.inspect(team.leaderThreadId,team.projectPath,message.threadId,attempt.marker,{boundTurnId:attempt.turnId,...registrationOptions(attempt)});
    try{assertObservationTurn(attempt,run);}catch(error){throw new Error('No exact public member receipt in the original message turn: '+error.message);}
    const original=message.turnId&&run.turnHistory?.find(row=>row.turnId===message.turnId);
    const observation=original?{...run,...original}:run;
    await this.store.update(id,owner,revision,t=>acknowledgeMessage(t,messageId,observation));return this.receipt(owner,id);
  }
  async syncProgress(owner,id,revision){
    const data=await this.read(owner,id),team=data.team;
    if(team.revision!==revision)return {...data,progressSync:{changed:false,reason:'revision-changed',retryAfterFreshState:true,startsModels:false}};
    if(team.state!=='active'||team.dispatchPaused||team.executionControl&&team.executionControl.status!=='active'||team.planReview&&team.planReview.status!=='approved')return {...data,progressSync:{changed:false,reason:'execution-not-active',startsModels:false}};
    if(!data.workflow.actions.some(a=>['settle','accept-review'].includes(a.type)))return {...data,progressSync:{changed:false,reason:'nothing-to-register',startsModels:false}};
    try{
      const updated=await this.advance(owner,id,revision,{settleCompleted:true,dispatchReady:false,decisions:[]});
      return {...updated,progressSync:{changed:updated.team.revision!==revision,startsModels:false,dispatchesWork:false,closesTeam:false}};
    }catch(error){
      const latest=await this.read(owner,id);
      if(latest.team.revision===revision)throw error;
      return {...latest,progressSync:{changed:false,reason:'concurrent-control-or-registration',retryAfterFreshState:true,startsModels:false}};
    }
  }
  async advance(owner,id,revision,{settleCompleted=true,dispatchReady=false,finishReady=false,decisions=[]}={}) {
    let data=await this.read(owner,id);if(data.team.revision!==revision)throw new Error('Team changed; refresh before workflow advancement');
    const errors=[];
    const before=new Map(data.team.tasks.map(t=>[t.id,JSON.stringify([t.status,t.attempts.at(-1)?.id,!!t.attempts.at(-1)?.acceptanceException])])),observed=data.runs;
    if(settleCompleted)for(const action of data.workflow.actions.filter(a=>a.type==='settle')){
      try{data=await this.settle(owner,id,data.team.revision,action.taskId,action.attemptId,{recordFailure:true});}
      catch(error){errors.push({operation:'settle',taskId:action.taskId,attemptId:action.attemptId,reason:error.message.slice(0,600)});data=await this.receipt(owner,id);}
    }
    const registrationAllowed=(!data.team.executionControl||data.team.executionControl.status==='active')&&!['stopping','halted','archived','superseded','delivered'].includes(data.team.state);
    const pending=registrationAllowed?data.team.tasks.filter(t=>(!data.team.activeBatchId||t.batchId===data.team.activeBatchId)&&t.kind==='review'&&t.status==='submitted'&&t.attempts.at(-1)?.acceptanceException?.inputHash!==reviewInputHash(data.team,t)):[];
    if(pending.length){await this.store.update(id,owner,data.team.revision,async t=>{for(const task of t.tasks.filter(t=>pending.some(p=>p.id===t.id)))await this.validateSubmittedReview(t,task);});data=await this.receipt(owner,id);}
    for(const decision of decisions){
      try{data=await this.acceptReview(owner,id,data.team.revision,decision.taskId,decision.attemptId,decision.decision,decision.note,decision.nonValidationFailures??[],decision.deferredChecks??[]);}
      catch(error){errors.push({operation:'review',taskId:decision.taskId,attemptId:decision.attemptId,reason:error.message.slice(0,600)});data=await this.receipt(owner,id);}
    }
    // One bounded batch uses its initial observations for still-running attempts.
    // Settlement independently verifies terminal identities; claimMany still
    // verifies fresh accounting before reserving. A second complete native read
    // would rediscover the same progress/usage without advancing this batch.
    data.runs=data.runs.map(r=>data.team.tasks.some(t=>t.status==='running'&&t.attempts.at(-1)?.id===r.attemptId)?observed.find(o=>o.attemptId===r.attemptId)??r:r);
    data.workflow=workflowActions(data.team,data.runs,{usage:data.usage});
    const batch=data.workflow.actions.find(a=>a.type==='claim-batch');
    if(dispatchReady&&batch&&!errors.length){try{data=await this.claimMany(owner,id,data.team.revision,batch.taskIds);}catch(error){errors.push({operation:'dispatch',reason:error.message.slice(0,600)});data=await this.receipt(owner,id);}}
    if(dispatchReady&&!errors.length&&!data.team.dispatchPaused&&(!data.team.executionControl||data.team.executionControl.status==='active')&&!data.usage?.exhausted&&!data.usage?.unverifiable){
      const pending=data.team.tasks.filter(t=>t.status==='running'&&t.attempts.at(-1)?.state==='reserved'&&!t.attempts.at(-1).agentThreadId&&t.attempts.at(-1).bootstrap&&observed.some(r=>r.attemptId===t.attempts.at(-1).id&&r.status==='not-started'&&r.launchIntent?.verified&&r.launchIntent.launchCallObserved===false));
      for(const task of pending)try{const packet=await reservedNativeDispatch(this.root,data.team,task);data.dispatches??=[];if(!data.dispatches.some(p=>p.attemptId===packet.attemptId))data.dispatches.push({...packet,recoveredUnissuedLaunch:true});}catch(error){errors.push({operation:'recover-original-dispatch',taskId:task.id,reason:error.message.slice(0,600)});}
    }
    data.runs=data.runs.map(r=>data.team.tasks.some(t=>t.status==='running'&&t.attempts.at(-1)?.id===r.attemptId)?observed.find(o=>o.attemptId===r.attemptId)??r:r);
    data.workflow=workflowActions(data.team,data.runs,{usage:data.usage});
    // Explicit Leader opt-in uses the same final acceptance gate, never panel sync.
    const finalAction=data.workflow.actions.find(a=>a.type==='final-validation');
    if(finishReady&&finalAction&&!errors.length&&!data.dispatches?.length&&!data.team.dispatchPaused){
      const args=finalAction.finalizationArguments;
      try{data=await this.finish(owner,id,args.revision,args.note,[],args.reuseEvidence,args.batchId);}
      catch(error){errors.push({operation:'finish',reason:error.message.slice(0,600)});data=await this.receipt(owner,id);}
    }
    const changes=data.team.tasks.filter(t=>before.get(t.id)!==JSON.stringify([t.status,t.attempts.at(-1)?.id,!!t.attempts.at(-1)?.acceptanceException])).map(t=>({taskId:t.id,status:t.status,attemptId:t.attempts.at(-1)?.id??null,...(t.attempts.at(-1)?.acceptance?{acceptedBy:'independent-reviewer'}:{}),...(t.attempts.at(-1)?.acceptanceException?{exception:t.attempts.at(-1).acceptanceException.reason.slice(0,400)}:{})}));
    return {...data,advancement:{fromRevision:revision,toRevision:data.team.revision,changes:changes.slice(0,32),errors:errors.slice(0,32),partial:errors.length>0,hasMore:changes.length>32||errors.length>32,readAgainRequired:false}};
  }
  async usage(owner,id,{refreshHistorical=false}={}) {
    const data=await this.read(owner,id);
    if(refreshHistorical&&this.observer.historicalUsage)for(const threadId of new Set(data.team.tasks.flatMap(t=>t.attempts.filter(a=>a.agentThreadId&&a.turnId).map(a=>a.agentThreadId)))){
      const attempts=data.team.tasks.flatMap(t=>t.attempts).filter(a=>a.agentThreadId===threadId&&a.turnId);
      const turnIds=[...new Set(attempts.flatMap(a=>attemptTurnIds(data.runs.find(r=>r.attemptId===a.id)??a)))];
      const observed=await this.observer.historicalUsage(data.team.leaderThreadId,data.team.projectPath,threadId,turnIds);
      for(const a of attempts){const run=data.runs.find(r=>r.attemptId===a.id);if(run){const ids=attemptTurnIds(run.turnId?run:a),rows=ids.map(turnId=>({turnId,usage:observed.find(o=>o.turnId===turnId)?.usage??null}));run.usage=rows.length>1?sumTurnUsage(rows):rows[0]?.usage??null;}}
    }
    return usageReport(data.team,data.runs,await this.accounting(data.team));
  }
}
