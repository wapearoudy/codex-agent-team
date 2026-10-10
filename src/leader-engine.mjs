import {settlementInputHash} from './settlement-exception.mjs';
import {captureEvidenceSnapshot} from './evidence-snapshot.mjs';
import {reconcileVerification} from './verification-reconciliation.mjs';
import {reconcileReview} from './review-reconciliation.mjs';
import {verificationCommandMatches} from './verification-command.mjs';
import {applyReviewDecision,acceptCompletedReview,reviewInputHash} from './reviewer-acceptance.mjs';
import {reuseFinalEvidence} from './final-evidence.mjs';
import {lastMemberExecution,retireTaskContext,assertFreshBinding,boundedDispatchPrompt} from './task-context.mjs';
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
import {OUTPUT_POLICY,MEMBER_PROTOCOL} from './team-efficiency.mjs';
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

const now=()=>new Date().toISOString();
const terminal=s=>['completed','failed','interrupted'].includes(s);
export class LeaderEngine {
  constructor({root=join(homedir(),'.codex','team-workspace'),store,observer}={}){
    this.root=root;this.store=store??new TeamStore(join(root,'teams'));this.observer=observer??new NativeMembers();
    this.worktrees=new TeamWorktrees(join(root,'worktrees'));
  }
  async planOnce(owner,context,args){
    const taskPlanning=args.taskPlanning;
    args={...args,plan:{...args.plan,tasks:args.plan.tasks??[]}};
    validatePlan(args.plan,{allowEmpty:taskPlanning==='leader'});
    for(const task of args.plan.tasks.filter(t=>t.kind!=='review'))if(args.plan.tasks.filter(r=>r.kind==='review'&&r.reviewOfTaskId===task.id).length!==1)throw new Error('Each work task requires one independent review');
    const key=createHash('sha256').update(JSON.stringify({owner,cwd:context.cwd,goal:args.goal,plan:args.plan,taskPlanning,requestId:args.requestId??null,fixedRoster:!!args.initializeMembers,memberStartup:args.memberStartup,approvalMode:args.approvalMode,execute:args.execute,maxParallel:args.maxParallel,policy:args.policy,executionAuthorization:args.executionAuthorization})).digest('hex');
    return new DurableStore(join(this.root,'leader-plan-requests.json'),{requests:{}}).transaction(async d=>{
      if(d.requests[key]){const existing=await this.store.get(d.requests[key],owner);if(existing.state!=='archived')return existing;}
      const team=await this.store.create({projectId:createHash('sha256').update(context.cwd).digest('hex').slice(0,24),projectPath:context.cwd,goal:args.goal,plan:args.plan,maxParallel:args.maxParallel??3,taskPlanning},owner);
      const saved=(await this.store.update(team.id,owner,team.revision,t=>{t.mode='host-leader';if(t.members.some(m=>m.routeSnapshot||m.fallbackRoute))requireTeamVersion(t,'0.13.0');t.leaderThreadId=context.threadId;t.dispatchPaused=!args.execute;t.state=args.execute?'active':'planned';t.totalDispatches=0;if(args.policy)t.policy=normalizePolicy(args.policy);if(args.memberStartup){t.memberStartup=args.memberStartup;requireTeamVersion(t,'0.12.0');}if(args.approvalMode||taskPlanning==='leader')setPlanReview(t,{mode:args.approvalMode??'required',execute:args.execute,executionAuthorization:args.executionAuthorization,brief:args.brief});if(args.initializeMembers){t.fixedRoster=true;for(const m of t.members){m.rosterMarker=`TEAM_WORKSPACE_MEMBER:${randomUUID()}`;m.rosterVerified=false;}}})).team;
      d.requests[key]=saved.id;return saved;
    });
  }
  async native(owner,id){const team=await this.store.get(id,owner);if(team.mode!=='host-leader')throw new Error('This is a legacy isolated team; native delegation requires a host-leader plan');return team;}
  async registerNative(owner,id,revision,input){return registerNativeAttempts(this,owner,id,revision,input);}
  async reconcileVerification(owner,id,revision,input){return reconcileVerification(this,owner,id,revision,input);}
  async reconcileReview(owner,id,revision,input){return reconcileReview(this,owner,id,revision,input);}
  packet(team,task){
    const a=task.attempts.at(-1),m=team.members.find(x=>x.id===task.memberId);
    const naming=memberNaming(team,m),generation=m.contextGeneration??1,contextSuffix='_ctx_'+generation+'_'+a.id.replaceAll('-','');
    const bounded=boundedDispatchPrompt(handoff=>[a.marker,`Before working, emit this exact marker as a standalone public commentary message: ${a.marker}. Structured JSON reports must include attemptMarker with this exact value; an optional first-line marker must match it. Plain-text deliveries start with this marker. Do not repeat markers from earlier attempts.`, `Leader: ${team.leaderThreadId}. Project: ${team.projectPath}.`,
        `Fixed member name: ${memberNaming(team,m).displayName}. Role: ${m.role}. Responsibility: ${a.memberGoalSnapshot?.goal??m.responsibility}.`, `Task: ${task.title}\n${task.goal}`,`Acceptance: ${task.acceptance}`,
        `Team goal: ${handoff.teamGoal}`,`Acceptance criteria: ${JSON.stringify(task.acceptanceCriteria??[])}`,`Additional context: ${task.context??''}`,`Upstream evidence: ${JSON.stringify(handoff.dependencies)}`,
        `Quality contract: ${JSON.stringify(task.contract??null)}. Declared goal coverage: ${JSON.stringify(team.goalCriteria??[])}. Scope paths are project-relative; explicit outOfScope paths must never be changed.`,
        `Open findings for this delivery: ${JSON.stringify(openFindings(team,task.kind==='review'?team.tasks.find(t=>t.id===task.reviewOfTaskId):task).map(({history,...f})=>f))}. Keep their IDs and severities across repair/review rounds. Only an independent reviewer can resolve them with concrete resolutionEvidence.`,
        `Saved checkpoint (explicit source; stale checkpoints are not current validation): ${JSON.stringify(handoff.checkpoint)}`,
        `Validation scope: ${task.validationMode??'execute'}. Report actual commands and results; source-only review is not proof that tests ran.`,
        `Allowed source writes: ${m.writeScopes.join(', ')||'none (read-only reviewer)'}. Shared project: other members are working here; do not revert their edits. Read only what this task needs.`,
        m.workspace?`Your assigned Git worktree is ${m.workspace.path}. Use this directory for every file write and command workdir. The native conversation remains in the Leader project. Commit the candidate in this worktree; do not merge or write back to the Leader workspace.`:'Work in the current shared project.',
        `Output budget: native max_output_tokens=${OUTPUT_POLICY.nativeMaxOutputTokens}; forwarded batch <=${OUTPUT_POLICY.batchMaxChars} characters. Use read_team_source for bounded selected source pages. Use prepare_team_command before long tests/builds, declaring verificationInputs for configs/fixtures beyond contract scope: it saves the pre-command input fingerprint and returns a literal log redirect, never executes. Run its nativeCommand once in its workspace through the native command tool, keep the real exit code/session; if running, wait on the SAME session using waitOptions (55000 ms), no frequent short polls. When invoking a bounded wait through functions.exec, set @exec yield_time_ms=60000 so the 55-second wait completes before an early wrapper yield. Read_team_command_log only for needed failure/summary pages. Commands run directly must also cap output and persist long logs. Never print whole source/history/build logs. Preserve full goals, criteria, scope and contracts.`,
        MEMBER_PROTOCOL,
        `Long work: after about ${OUTPUT_POLICY.phaseInputTokens} current input tokens or ${OUTPUT_POLICY.phaseCommandCount} commands, choose a coherent phase boundary if work remains. Do not rotate on transport errors. Save report_member_team_task(handoff=true) with exact decisions, remainingWork, evidence, validation and verificationInputs covering all verification inputs; no delivery. Emit its exact finalReceipt JSON as your final answer and END this turn. Only a verified completed receipt allows Leader to dispatch a clean continuation of the SAME task. No self-spawn/followup. At most ${OUTPUT_POLICY.maxPhaseHandoffs} handoffs. Phase checkpoints are not acceptance.`,
        ...(a.phaseContinuation?[`Verified phase continuation: ${JSON.stringify(a.phaseContinuation)}. Before work page read_team_context(teamId=${team.id},taskId=${task.id},attemptId=${a.phaseContinuation.fromAttemptId},view=evidence,section=checkpoint,limit=4000) for the complete phase checkpoint including decisions and remainingWork; continue nextOffset/cursor while hasMore. Continue within the current goal/contract and retain compatible decisions. If contractAmendmentId is present, the checkpoint is historical scope; the explicit amended goal/contract takes precedence and old verification cannot cover the new contract. Current reusable contract.verify indices: ${JSON.stringify((task.contract?.verify??[]).flatMap((command,i)=>(a.reusedVerificationCommands??[]).some(c=>verificationCommandMatches(c.command,command,{cwd:c.cwd,workspace:a.evidenceSnapshot?.workspace??m.workspace?.path??team.projectPath}))?[i]:[]))}. These checks are from successful host commands with unchanged declared inputs at dispatch; plugin rechecks inputs at settlement. Do not rerun a covered check merely for registration; further input changes or missing proof require verification.`]:[]),
        `For task-scoped coordination, use send_team_peer_message with teamId ${team.id}, attemptId ${a.id} and a stable requestId. Send only to a roster member or leader. The returned nativeAction may be delivered using the existing native send_message tool; record its actual result with record_team_peer_sender_delivery. Never auto-resend an unknown delivery. Use consume_team_inbox to read and acknowledge your exact pending messages in one call. Progress belongs in checkpoints or kind=progress (saved only); only actionable blockers/questions/completions request native delivery. After your final delivery, finish this turn and wait. Never self-claim another task in this execution context.`,
        task.kind==='review'?`Return JSON with attemptMarker, summary, decision (accept or rework), reason, checks [{name,criterionId,status:PASS|FAIL|BLOCKED|NOT_RUN,evidence}], findings [{id,severity:blocker|high|medium|low,status:open|resolved,description,resolutionEvidence}]. resolutionEvidence must be nonempty text or a nonempty list of nonempty text entries; retain concrete proof for every resolved finding. Use stable IDs for new findings and preserve supplied IDs when resolving earlier findings. Use findings:[] if none. Every PASS check requires concrete evidence. Cover these target criteria: ${JSON.stringify(team.tasks.find(t=>t.id===task.reviewOfTaskId)?.acceptanceCriteria??[])}. Review independently against the exact upstream attempt and contract; do not fix the implementation. Reuse saved host verification and logs when they cover the same unchanged candidate and required checks; do not repeat tests merely to register acceptance. An accept verdict that passes plugin gates directly accepts the target and unlocks dependencies. Report changed candidates, missing evidence or findings as exceptions.`:task.contract?'Return JSON with attemptMarker, summary, changedPaths (project-relative), acceptanceResults [{criterionId,status:PASS|FAIL|BLOCKED|NOT_RUN,evidence}], commandsRun, verificationInputs (project-relative files needed to keep this evidence valid) and limitations. Execute uncovered contract.verify commands using native command tools, so the host records the real exit code. A phase check may be reused only while its declared inputs remain unchanged; otherwise execute that check. Report missing/failed checks honestly; submission is not acceptance.':'Return a summary, changed file paths, test commands/results and remaining limitations. Completion is a submission, not acceptance.'
      ].join('\n\n'),buildHandoff(team,task.id),normalizePolicy(team.policy).contextChars);
    return {taskId:task.id,attemptId:a.id,memberId:m.id,...naming,taskName:generation>1?naming.taskName.slice(0,64-contextSuffix.length)+contextSuffix:naming.taskName,titleAction:memberTitleAction(team,m),existingThreadId:m.agentThreadId,existingAgentPath:m.agentPath??null,marker:a.marker,spawnOptions:nativeRoute(m),workspace:m.workspace??{path:team.projectPath,mode:'shared'},...bounded,contextIsolation:{mode:'task',generation,previousThreadId:team.contextHistory?.findLast(c=>c.memberId===m.id)?.threadId??null},
      action:m.agentThreadId?'followup-native-member':'spawn-native-member'};
  }
  async claim(owner,id,revision,taskId){
    const data=await this.claimMany(owner,id,revision,[taskId]);const {dispatches,...rest}=data;return {...rest,dispatch:dispatches[0]};
  }
  async claimMany(owner,id,revision,taskIds){
    if(!taskIds?.length||taskIds.length>8||new Set(taskIds).size!==taskIds.length)throw new Error('Provide 1–8 unique tasks');
    const rosterTeam=await this.native(owner,id),verified=[];assertDispatchAllowed(rosterTeam);
    if(rosterTeam.revision!==revision)throw new Error('Team changed; refresh before controlling members');
    if(rosterTeam.state==='superseded')throw new Error('Historical team cannot dispatch; use the project’s current team');
    if(rosterTeam.policy?.tokenLimit){const [runs,accounting]=await Promise.all([this.observations(rosterTeam),this.accounting(rosterTeam,{fresh:true})]);assertBudget(rosterTeam,runs,accounting);}
    if(rosterTeam.members.some(m=>!m.removedAt&&m.recoveryControl?.status==='unavailable'))throw new Error('A native member handle is unavailable; preserve the roster and verify recovery before dispatch');
    const retirements=new Map();
    for(const taskId of taskIds){
      const task=rosterTeam.tasks.find(t=>t.id===taskId),member=rosterTeam.members.find(m=>m.id===task?.memberId);
      if(!member||task.status==='running')continue;
      const last=lastMemberExecution(rosterTeam,member);if(!last)continue;
      if(rosterTeam.tasks.some(t=>t.memberId===member.id&&t.status==='running'))throw new Error('Member still has an active attempt; preserve its context');
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
      t.events.push({at:now(),type:'leader-task-reserved',taskId,attemptId:a.id});
      }
      return taskIds.map(taskId=>{const task=t.tasks.find(x=>x.id===taskId),packet=this.packet(t,task);task.attempts.at(-1).contextBudget=packet.contextBudget;return packet;});
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
      const snapshot=await this.observer.inspect(team.leaderThreadId,team.projectPath,input.threadId,a.marker,{allowPending:true,requireFresh:!!a.contextGeneration,boundTurnId:a.turnId});
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
        const first=!a.agentThreadId;bindMemberThread(t,taskId,threadId,attemptId);m.agentPath=snapshot.agentPath??m.agentPath??null;if(t.memberStartup==='on-demand'||m.contextGeneration){m.rosterVerified=true;m.initializationTurnId??=snapshot.turnId;}a.state=snapshot.turnId?'running':'linking';associateTurn(t,task,snapshot);a.executedRoute={model:snapshot.model??nativeRoute(m).model??null,provider:snapshot.provider??m.routeSnapshot?.provider??null,reasoningEffort:snapshot.reasoningEffort??nativeRoute(m).reasoning_effort??null,source:snapshot.model?'host-observed-model':'frozen-route-only'};if(first){a.boundAt=now();t.totalDispatches++;}
      }
    });
    const data=await this.receipt(owner,id);return {...data,titleActions:verified.map(v=>memberTitleAction(data.team,data.team.members.find(m=>m.id===data.team.tasks.find(t=>t.id===v.taskId).memberId)))};
  }
  async bindRoster(owner,id,revision,memberId,threadId){
    const data=await this.bindRosterMany(owner,id,revision,[{memberId,threadId}]);const {titleActions,...rest}=data;return {...rest,titleAction:titleActions[0]};
  }
  async bindRosterMany(owner,id,revision,assignments){
    if(!assignments?.length||assignments.length>8||new Set(assignments.map(x=>x.memberId)).size!==assignments.length)throw new Error('Provide 1–8 unique roster bindings');
    const team=await this.native(owner,id);assertDispatchAllowed(team);if(team.revision!==revision)throw new Error('Team changed; refresh before controlling members');
    const verified=await Promise.all(assignments.map(async input=>{
      const member=team.members.find(m=>m.id===input.memberId&&!m.removedAt);if(!team.fixedRoster||!member)throw new Error('An active fixed roster member is required');
      if(member.contextGeneration)throw new Error('Bind an isolated task context through its reserved attempt; do not reinitialize the roster');
      return {...input,snapshot:await this.observer.inspect(team.leaderThreadId,team.projectPath,input.threadId,member.rosterMarker,{allowPending:true})};
    }));
    await this.store.update(id,owner,revision,t=>{for(const {memberId,snapshot} of verified){const m=t.members.find(m=>m.id===memberId);
      if(m.agentThreadId&&m.agentThreadId!==snapshot.threadId)throw new Error('Reuse this member’s existing native subagent');
      assertFreshBinding(t,m,snapshot.threadId);
      m.agentThreadId=snapshot.threadId;m.agentPath=snapshot.agentPath;delete m.initializationNeedsRetry;m.rosterVerified=snapshot.status==='completed'&&!!snapshot.turnId;m.initializationTurnId=snapshot.turnId;m.status=m.rosterVerified?'idle':'starting';m.lastActivityAt=now();
      t.events.push({at:now(),type:'native-roster-member-linked',memberId,threadId:snapshot.threadId,verified:m.rosterVerified});
    }});const data=await this.receipt(owner,id);return {...data,titleActions:verified.map(v=>memberTitleAction(data.team,data.team.members.find(m=>m.id===v.memberId)))};
  }
  async observations(team,{observe=true}={}){
    return Promise.all(team.tasks.flatMap(t=>t.attempts.filter(a=>a.agentThreadId).map(async a=>{
      let observation=a.observation;
      if(observe&&t.attempts.at(-1)?.id===a.id&&t.status==='running')try{observation=await this.observer.inspect(team.leaderThreadId,team.projectPath,a.agentThreadId,a.marker,{allowPending:a.state==='linking',boundTurnId:a.turnId,...registrationOptions(a)});assertObservationTurn(a,observation);}catch(error){observation=failedRunObservation(observation,error);}
      return {...observation,taskId:t.id,memberId:a.memberId??t.memberId,attemptId:a.id,threadId:a.agentThreadId};
    })));
  }
  async receipt(owner,id){return this.read(owner,id,{observe:false});}
  async terminalSnapshot(owner,id){
    // Waiting needs current terminal identities only. Do not enumerate Leader
    // history, recompute all usage or build dispatch/validation projections.
    const team=await this.native(owner,id),running=team.tasks.filter(t=>t.status==='running'),runs=await this.observations({...team,tasks:running});
    return {team:{revision:team.revision},workflow:{actions:running.flatMap(t=>{const a=t.attempts.at(-1),run=runs.find(r=>r.attemptId===a?.id);return a&&terminal(run?.status)?[{type:'settle',taskId:t.id,attemptId:a.id,observedStatus:run.status}]:[];})}};
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
    return {team,runs,readiness,recovery,quality:qualityReport(team),usage,workflow:workflowActions(team,runs,{usage}),diagnostics:diagnostics(team,runs),peerDelivery:peerActions(team),initializations:!usage.exhausted&&!usage.unverifiable&&!['superseded','archived'].includes(team.state)&&(!team.executionControl||team.executionControl.status==='active')&&team.memberStartup!=='on-demand'&&team.fixedRoster&&!(team.planReview?.scope==='initial'&&team.planReview.status!=='approved')?team.members.filter(m=>!m.removedAt&&!m.rosterVerified).map(m=>({...rosterPacket(team,m),spawnOptions:nativeRoute(m),workspace:m.workspace??{mode:'shared',path:team.projectPath}})):[],messages:mailboxProjection(team),checkpoints:checkpointProjection(team,runs),observedAt,observationMode:observe?'fresh':'saved',runtimeSource:'native-thread-persisted-snapshot',limitations:[
      '当前主会话负责原生成员派发、消息和停止；插件不启动模型轮次。',
      '面板读取宿主已持久化的轮次记录，可能滞后；执行结束不代表已验收。',
      '成员共用当前项目，写入范围由 Leader 和成员遵守，并发冲突在派发时检查；不是文件系统沙箱。'
    ]};
  }
  async settle(owner,id,revision,taskId,attemptId,{recordFailure=false}={}){
    const team=await this.native(owner,id),task=team.tasks.find(x=>x.id===taskId),a=task?.attempts.at(-1);
    if(!a||a.id!==attemptId||!a.agentThreadId)throw new Error('A bound current attempt is required');
    if(task.status!=='running'){if(a.endedAt&&(['submitted','accepted','blocked'].includes(task.status)||task.status==='waiting'&&a.phaseHandoff?.status==='completed')&&['completed','failed','interrupted'].includes(a.observation?.status??a.runtimeStatus))return this.receipt(owner,id);throw new Error('Attempt is already settled');}
    const run=await this.observer.inspect(team.leaderThreadId,team.projectPath,a.agentThreadId,a.marker,{boundTurnId:a.turnId,...registrationOptions(a)});
    if(!terminal(run.status))throw new Error('Native turn has no confirmed terminal record');
    try{await this.store.update(id,owner,revision,async t=>{
      const task=t.tasks.find(x=>x.id===taskId),a=task.attempts.at(-1),member=t.members.find(x=>x.id===task.memberId);
      if(a.id!==attemptId||task.status!=='running')throw new Error('Stale or inactive attempt');
      if(a.settlementException){a.settlementExceptionHistory??=[];a.settlementExceptionHistory.push({...structuredClone(a.settlementException),observation:structuredClone(a.observation)});}
      associateTurn(t,task,run);
      if(run.status!=='completed'){task.status='blocked';task.blockReason=`Native turn ${run.status}; Leader must decide next step`;a.state=run.status;a.endedAt=now();member.status='idle';pauseDispatch(t);return;}
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
    if(task.attempts.at(-1)?.nativeRegistration){submitRegistered(team,task,run);await this.validateSubmittedReview(team,task);return;}
    const a=task.attempts.at(-1),member=team.members.find(m=>m.id===task.memberId);
    const output=run.outputs?.at(-1)?.text?.trim();if(!output)throw new Error('Completed turn has no public delivery');
    // Quality gates use the completed turn's commands. Earlier interrupted
    // checks remain turn-scoped evidence and cannot silently validate this result.
    const reusable=a.phaseContinuation?await reusablePhaseCommands(team,task):[];
    const delivery=assertContractDelivery(task,member,output,[...reusable,...(run.commands??[])]);if(delivery)a.delivery=delivery;
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
  async finish(owner,id,revision,note,checks=[],reuseEvidence=true){
    const prior=await this.native(owner,id);
    if(prior.state==='delivered'&&prior.finalAcceptance){if(prior.finalAcceptance.note===note&&((!checks.length&&prior.finalAcceptance.reusedEvidence?.length)||JSON.stringify(prior.finalAcceptance.providedChecks??prior.finalAcceptance.checks)===JSON.stringify(checks)))return this.receipt(owner,id);throw new Error('Final acceptance is already recorded; add explicitly authorized new work instead of replacing the result');}
    await this.store.update(id,owner,revision,async t=>{
      assertPlanExecutable(t);if(t.executionControl&&t.executionControl.status!=='active'||['stopping','halted','archived','superseded'].includes(t.state))throw new Error('Resume the original team before final acceptance');if(!t.tasks.length)throw new Error('Plan and independently accept concrete deliveries before final validation');
      if(!t.tasks.every(x=>['accepted','cancelled'].includes(x.status)))throw new Error('All deliveries require independent acceptance first');
      assertQualityFinish(t);
      for(const task of t.tasks.filter(t=>t.status==='accepted')){const verification=assertContractPass(task);if(verification)Object.assign(task.attempts.at(-1).delivery,verification);}
      const reused=reuseEvidence?await reuseFinalEvidence(t):{checks:[],references:[]};
      const finalChecks=[...checks,...reused.checks];
      if(!finalChecks.length||finalChecks.some(c=>c.status!=='PASS'||!c.evidence?.trim()))throw new Error('Final project validation requires valid integration evidence; missing checks are not a pass and individual task checks alone are insufficient');
      t.state='delivered';t.finalAcceptance={source:'main-conversation-leader',note,checks:finalChecks,providedChecks:structuredClone(checks),...(reused.references.length?{reusedEvidence:reused.references}:{}),at:now()};t.dispatchPaused=true;
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
  async addTasks(owner,id,revision,tasks,{scopeChange=false,note=''}={}){await this.native(owner,id);await this.store.update(id,owner,revision,t=>{
    if(t.state==='superseded')throw new Error('This is a historical team; use the project’s current team');
    assertPlanMutable(t);
    if(!Array.isArray(tasks)||!tasks.length)throw new Error('Provide concrete tasks with independent reviews');
    if(t.profileConstraints)tasks=tasks.map(task=>{const prefix='Template constraints: '+t.profileConstraints,context=task.context?.startsWith(prefix)?task.context:prefix+(task.context?'\n\nTask context: '+task.context:'');if(context.length>12000)throw new Error('Template constraints plus task context exceed 12000 characters');return {...task,context};});
    if(scopeChange||t.planReview&&tasks.some(task=>!t.members.some(m=>m.id===task.memberId&&!m.removedAt))){stageExpansion(t,{tasks},note||'新增任务需要确认新的职责范围');this.validateExpansion(t);return;}
    const timestamp=now();t.tasks.push(...tasks.map(task=>({...task,status:'waiting',attempt:0,attempts:[],evidence:[],history:[{at:timestamp,type:'added'}],blockReason:null,createdAt:timestamp,updatedAt:timestamp})));
    if(tasks.some(task=>task.contract))t.requiresTeamWorkspaceVersion??='0.10.0';
    validatePlan(t);for(const task of t.tasks.filter(x=>x.kind!=='review'))if(t.tasks.filter(r=>r.kind==='review'&&r.reviewOfTaskId===task.id).length!==1)throw new Error('New deliveries require one independent review');
    if(t.finalAcceptance){t.acceptanceHistory??=[];t.acceptanceHistory.push(t.finalAcceptance);delete t.finalAcceptance;}if(t.state==='delivered')t.dispatchPaused=false;if(!t.executionControl||t.executionControl.status==='active')t.state='active';t.events.push({at:timestamp,type:'tasks-added-to-fixed-team',taskIds:tasks.map(t=>t.id)});
  });return this.receipt(owner,id);}
  validateExpansion(team){const candidate=expansionCandidate(team);validatePlan(candidate);for(const task of candidate.tasks.filter(t=>t.kind!=='review'))if(candidate.tasks.filter(r=>r.kind==='review'&&r.reviewOfTaskId===task.id).length!==1)throw new Error('Each work task requires one independent review');if(!Number.isInteger(candidate.maxParallel)||candidate.maxParallel<1||candidate.maxParallel>8)throw new Error('Parallel member limit must be 1–8');}
  async requestPlanFeedback(owner,id,revision,input){const old=await this.native(owner,id);if(old.planReview?.feedback?.requestId===input.requestId){requestPlanFeedback(structuredClone(old),input);return this.readPlan(owner,id);}await this.store.update(id,owner,revision,t=>requestPlanFeedback(t,input));return this.readPlan(owner,id);}
  async readPlan(owner,id){return editablePlan(await this.native(owner,id));}
  async revisePlan(owner,id,revision,configuration,brief){await this.store.update(id,owner,revision,t=>{if(t.planReview?.scope==='expansion'){updateExpansionDraft(t,configuration,brief);this.validateExpansion(t);return;}updateDraft(t,configuration,brief);validatePlan(t);for(const task of t.tasks.filter(t=>t.kind!=='review'))if(t.tasks.filter(r=>r.kind==='review'&&r.reviewOfTaskId===task.id).length!==1)throw new Error('Each work task requires one independent review');});return this.readPlan(owner,id);}
  async proposeChange(owner,id,revision,change,brief){await this.store.update(id,owner,revision,t=>{stageExpansion(t,change,brief);this.validateExpansion(t);});return this.receipt(owner,id);}
  async configurePolicy(owner,id,revision,policy,{reviewExpansion=false}={}){await this.store.update(id,owner,revision,t=>{assertPlanMutable(t);const next=normalizePolicy({...t.policy,...policy});if((t.planReview||reviewExpansion)&&policyExpands(t.policy,next)){stageExpansion(t,{policy:next},'提高执行预算或自动修复额度');this.validateExpansion(t);return;}t.policy=next;if(next.autoRepair)t.requiresTeamWorkspaceVersion??='0.10.0';});return this.receipt(owner,id);}
  async decidePlan(owner,id,revision,input,action){
    const existing=reviewRequest(await this.native(owner,id),input,action);if(existing.saved)return {...await this.receipt(owner,id),planDecision:{replayed:true,action}};
    let replayed=false;try{await this.store.update(id,owner,revision,t=>{
      const request=reviewRequest(t,input,action),p=t.planReview;if(request.saved)return;
      if(action==='approve'){
        if(p.scope==='initial'){if(!t.executionControl||t.executionControl.status==='active'){t.dispatchPaused=false;t.state='active';}}
        else {this.validateExpansion(t);const pending=p.pending,at=now();t.members.push(...pending.members.map(m=>({...m,status:'planned',agentThreadId:null,rosterMarker:`TEAM_WORKSPACE_MEMBER:${randomUUID()}`,rosterVerified:false,addedAt:at,lastActivityAt:at})));if(pending.members.length){t.memberAdditions??=[];t.memberAdditions.push({requestId:input.requestId,hash:planHash(pending.members),memberIds:pending.members.map(m=>m.id),at});}t.tasks.push(...pending.tasks.map(task=>({...task,status:'waiting',attempt:0,attempts:[],evidence:[],blockReason:null,createdAt:at,updatedAt:at})));if(pending.policy)t.policy=pending.policy;if(pending.maxParallel)t.maxParallel=pending.maxParallel;if(pending.tasks.length){if(t.finalAcceptance){t.acceptanceHistory??=[];t.acceptanceHistory.push(t.finalAcceptance);delete t.finalAcceptance;}t.state='active';}}
      }else if(p.scope==='initial'){t.dispatchPaused=true;t.state='cancelled';for(const task of t.tasks)task.status='cancelled';}
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
    const t=await this.native(owner,id);if(!input||!controlRequest(t,'stop',input).saved)try{await this.store.update(id,owner,revision,t=>requestStop(t,input));}catch(error){if(!input||!controlRequest(await this.native(owner,id),'stop',input).saved)throw error;}
    const data=await this.receipt(owner,id),active=data.team.executionControl?.status==='stopping'&&(!input||data.team.executionControl.requestId===input.requestId);return {...data,leaderAction:active?{type:'interrupt-native-members',targets:stopTargets(data.team),note:'Interrupt all existing native members, including initialization turns. Bind or explicitly release uncertain reservations. Then reconcile_team_stop; unknown is never halted. End the Leader work turn after reconciliation.'}:null};
  }
  async reconcileStop(owner,id,revision,{unstartedTaskIds=[],note=''}={}){
    const team=await this.native(owner,id);if(team.executionControl?.status!=='stopping')throw new Error('Team is not stopping');
    if(unstartedTaskIds.length&&!note.trim())throw new Error('Record host evidence that these dispatches never started');
    const observations=await Promise.all(stopTargets(team).filter(x=>x.threadId).map(async x=>{
      const m=team.members.find(m=>m.id===x.memberId),a=team.tasks.find(t=>t.id===x.taskId)?.attempts.at(-1),last=a??lastMemberExecution(team,m)?.attempt;
      try{const run=await this.observer.inspect(team.leaderThreadId,team.projectPath,x.threadId,last?.marker??m.rosterMarker,{allowPending:true,requireIdle:true,boundTurnId:last?.turnId});if(last)assertObservationTurn(last,run);return {...x,run};}
      catch(error){try{if(!this.observer.inspectIdle)throw error;return {...x,run:await this.observer.inspectIdle(team.leaderThreadId,team.projectPath,x.threadId),associationError:error.message};}catch(idleError){return {...x,error:idleError.message};}}
    }));
    await this.store.update(id,owner,revision,async t=>{
      const pending=[];
      for(const item of observations){if(item.error||!item.run.quiescence){pending.push({memberId:item.memberId,reason:item.error??'Latest native turn has no confirmed terminal record'});continue;}
        const m=t.members.find(m=>m.id===item.memberId),task=t.tasks.find(task=>task.id===item.taskId),a=task?.attempts.at(-1);
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
  async release(owner,id,revision,taskId,attemptId,note){await this.native(owner,id);await this.store.update(id,owner,revision,t=>{
    const task=t.tasks.find(x=>x.id===taskId),a=task?.attempts.at(-1);if(!a||a.id!==attemptId||a.agentThreadId||a.state!=='reserved')throw new Error('Only an unbound reservation can be released after Leader verifies no member was launched');
    a.state='released';a.summary=note;a.endedAt=now();task.status='waiting';t.members.find(x=>x.id===task.memberId).status='idle';
  });return this.receipt(owner,id);}
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
    if(r.prior){const {prompt,marker,taskId,attemptId}=this.packet(t,r.task);return {kind:'member-claim',revision:t.revision,taskId,attemptId,marker,prompt,action:'continue-current-native-turn'};}
    const data=await this.claim(owner,id,revision,input.taskId);
    await this.store.update(id,owner,data.team.revision,t=>{const a=t.tasks.find(task=>task.id===input.taskId).attempts.at(-1);(t.memberClaims??=[]).push({requestId:input.requestId,hash:r.hash,memberId:r.member.id,taskId:input.taskId,attemptId:a.id,at:now()});requireTeamVersion(t,'0.12.0');});
    const saved=await this.native(owner,id),{prompt,marker,taskId,attemptId}=this.packet(saved,saved.tasks.find(task=>task.id===input.taskId));return {kind:'member-claim',revision:saved.revision,taskId,attemptId,marker,prompt,action:'continue-current-native-turn',instruction:'Emit marker publicly and bind_member_team_task to your existing thread; do not spawn/follow up yourself.'};
  }
  async memberBind(owner,id,revision,context,input){const t=await this.native(owner,id),m=assertMember(t,context),task=t.tasks.find(task=>task.id===input.taskId);if(task?.memberId!==m.id)throw new Error('Only your own task may be bound');return this.bind(owner,id,revision,input.taskId,input.attemptId,context.threadId);}
  async checkpointRun(team,input){
    const task=team.tasks.find(t=>t.id===input.taskId),a=task?.attempts.at(-1);
    if(!['running','submitted'].includes(task?.status)||a?.id!==input.attemptId||!a.agentThreadId||!a.turnId)throw new Error('Checkpoint requires a bound active native attempt');
    const run=await this.observer.inspect(team.leaderThreadId,team.projectPath,a.agentThreadId,a.marker,{boundTurnId:a.turnId});
    assertObservationTurn(a,run);
    if(!run.turnId||!['inProgress','completed'].includes(run.status)||(run.latestTurnId&&run.latestTurnId!==run.turnId))throw new Error('Current checkpoint turn is not verified; emit the attempt marker in the resumed native turn and retry');
    return run;
  }
  async memberReport(owner,id,revision,context,input){
    const team=await this.native(owner,id),member=assertMember(team,context),task=team.tasks.find(t=>t.id===input.taskId);
    if(task?.memberId!==member.id||task.status!=='running'||task.attempts.at(-1)?.id!==input.attemptId||task.attempts.at(-1)?.agentThreadId!==context.threadId)throw new Error('Only your bound current attempt may report progress');
    if(team.revision!==revision)throw new Error('Team changed; refresh before recording progress');
    const existing=team.checkpoints?.find(c=>c.requestId===input.requestId?.toLowerCase()),run=existing?null:await this.checkpointRun(team,input);
    const r=await this.store.update(id,owner,revision,t=>{if(run)associateTurn(t,t.tasks.find(t=>t.id===input.taskId),run);return memberReport(t,context,input);});
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
    const run=await this.observer.inspect(team.leaderThreadId,team.projectPath,message.threadId,attempt.marker,{boundTurnId:attempt.turnId});
    try{assertObservationTurn(attempt,run);}catch(error){throw new Error('No exact public member receipt in the original message turn: '+error.message);}
    const original=message.turnId&&run.turnHistory?.find(row=>row.turnId===message.turnId);
    const observation=original?{...run,...original}:run;
    await this.store.update(id,owner,revision,t=>acknowledgeMessage(t,messageId,observation));return this.receipt(owner,id);
  }
  async advance(owner,id,revision,{settleCompleted=true,dispatchReady=false,decisions=[]}={}) {
    let data=await this.read(owner,id);if(data.team.revision!==revision)throw new Error('Team changed; refresh before workflow advancement');
    const errors=[];
    const before=new Map(data.team.tasks.map(t=>[t.id,JSON.stringify([t.status,t.attempts.at(-1)?.id,!!t.attempts.at(-1)?.acceptanceException])])),observed=data.runs;
    if(settleCompleted)for(const action of data.workflow.actions.filter(a=>a.type==='settle')){
      try{data=await this.settle(owner,id,data.team.revision,action.taskId,action.attemptId,{recordFailure:true});}
      catch(error){errors.push({operation:'settle',taskId:action.taskId,attemptId:action.attemptId,reason:error.message.slice(0,600)});data=await this.receipt(owner,id);}
    }
    const registrationAllowed=(!data.team.executionControl||data.team.executionControl.status==='active')&&!['stopping','halted','archived','superseded','delivered'].includes(data.team.state);
    const pending=registrationAllowed?data.team.tasks.filter(t=>t.kind==='review'&&t.status==='submitted'&&t.attempts.at(-1)?.acceptanceException?.inputHash!==reviewInputHash(data.team,t)):[];
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
    data.runs=data.runs.map(r=>data.team.tasks.some(t=>t.status==='running'&&t.attempts.at(-1)?.id===r.attemptId)?observed.find(o=>o.attemptId===r.attemptId)??r:r);
    data.workflow=workflowActions(data.team,data.runs,{usage:data.usage});
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
