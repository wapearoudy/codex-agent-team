import {lastMemberExecution,retireTaskContext,assertFreshBinding,boundedDispatchPrompt} from './task-context.mjs';
import {memberGoalRequest,changeMemberGoal,memberGoalSnapshot,memberGoalDetail} from './member-goals.mjs';
import {memberClaimRequest,memberReport,assertMember} from './member-work.mjs';
import {amendContract} from './team-contracts.mjs';
import {requestStop,resumeTeam,stopTargets,controlRequest} from './team-control.mjs';
import {requireTeamVersion} from './team-version.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {TeamStore,schedule,bindMemberThread,submitTask,reviewTask,pauseDispatch,validatePlan,dispatchBlockers} from './team.mjs';
import {DurableStore} from './durable-store.mjs';
import {NativeMembers} from './native-members.mjs';
import {parseReview,assertReviewPass} from './quality-gates.mjs';
import {queueMessage,messageAction,recordMessageDelivery,acknowledgeMessage,mailboxProjection} from './team-mailbox.mjs';
import {recordCheckpoint,checkpointProjection,buildHandoff} from './team-checkpoints.mjs';
import {rosterPacket,requiredRosterMembers} from './team-roster.mjs';
import {memberNaming,memberTitleAction} from './team-naming.mjs';
import {assertBudget,usageReport,normalizePolicy,nativeRoute} from './team-policy.mjs';
import {diagnostics} from './team-diagnostics.mjs';
import {workflowActions} from './team-workflow.mjs';
import {peerActions} from './team-peer-mailbox.mjs';
import {TeamWorktrees} from './team-worktrees.mjs';
import {assertContractDelivery,assertContractPass,recordFindings,planRepair,qualityReport,assertQualityFinish,openFindings} from './team-quality.mjs';
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
    validatePlan(args.plan);
    for(const task of args.plan.tasks.filter(t=>t.kind!=='review'))if(args.plan.tasks.filter(r=>r.kind==='review'&&r.reviewOfTaskId===task.id).length!==1)throw new Error('Each work task requires one independent review');
    const key=createHash('sha256').update(JSON.stringify({owner,cwd:context.cwd,goal:args.goal,plan:args.plan,requestId:args.requestId??null,fixedRoster:!!args.initializeMembers,memberStartup:args.memberStartup,approvalMode:args.approvalMode,execute:args.execute,maxParallel:args.maxParallel,policy:args.policy,executionAuthorization:args.executionAuthorization})).digest('hex');
    return new DurableStore(join(this.root,'leader-plan-requests.json'),{requests:{}}).transaction(async d=>{
      if(d.requests[key])return this.store.get(d.requests[key],owner);
      const team=await this.store.create({projectId:createHash('sha256').update(context.cwd).digest('hex').slice(0,24),projectPath:context.cwd,goal:args.goal,plan:args.plan,maxParallel:args.maxParallel??3},owner);
      const saved=(await this.store.update(team.id,owner,team.revision,t=>{t.mode='host-leader';if(t.members.some(m=>m.routeSnapshot||m.fallbackRoute))requireTeamVersion(t,'0.13.0');t.leaderThreadId=context.threadId;t.dispatchPaused=!args.execute;t.state=args.execute?'active':'planned';t.totalDispatches=0;if(args.policy)t.policy=normalizePolicy(args.policy);if(args.memberStartup){t.memberStartup=args.memberStartup;requireTeamVersion(t,'0.12.0');}if(args.approvalMode)setPlanReview(t,{mode:args.approvalMode,execute:args.execute,executionAuthorization:args.executionAuthorization,brief:args.brief});if(args.initializeMembers){t.fixedRoster=true;for(const m of t.members){m.rosterMarker=`TEAM_WORKSPACE_MEMBER:${randomUUID()}`;m.rosterVerified=false;}}})).team;
      d.requests[key]=saved.id;return saved;
    });
  }
  async native(owner,id){const team=await this.store.get(id,owner);if(team.mode!=='host-leader')throw new Error('This is a legacy isolated team; native delegation requires a host-leader plan');return team;}
  packet(team,task){
    const a=task.attempts.at(-1),m=team.members.find(x=>x.id===task.memberId);
    const naming=memberNaming(team,m),generation=m.contextGeneration??1,contextSuffix='_ctx_'+generation+'_'+a.id.replaceAll('-','');
    const bounded=boundedDispatchPrompt(handoff=>[a.marker,`Before working, emit this exact marker as a standalone public commentary message: ${a.marker}. Include it as the first line of your final delivery, or as attemptMarker in a JSON review. Do not repeat markers from earlier attempts.`, `Leader: ${team.leaderThreadId}. Project: ${team.projectPath}.`,
        `Fixed member name: ${memberNaming(team,m).displayName}. Role: ${m.role}. Responsibility: ${a.memberGoalSnapshot?.goal??m.responsibility}.`, `Task: ${task.title}\n${task.goal}`,`Acceptance: ${task.acceptance}`,
        `Team goal: ${handoff.teamGoal}`,`Acceptance criteria: ${JSON.stringify(task.acceptanceCriteria??[])}`,`Additional context: ${task.context??''}`,`Upstream evidence: ${JSON.stringify(handoff.dependencies)}`,
        `Quality contract: ${JSON.stringify(task.contract??null)}. Declared goal coverage: ${JSON.stringify(team.goalCriteria??[])}. Scope paths are project-relative; explicit outOfScope paths must never be changed.`,
        `Open findings for this delivery: ${JSON.stringify(openFindings(team,task.kind==='review'?team.tasks.find(t=>t.id===task.reviewOfTaskId):task).map(({history,...f})=>f))}. Keep their IDs and severities across repair/review rounds. Only an independent reviewer can resolve them with concrete resolutionEvidence.`,
        `Saved checkpoint (explicit source; stale checkpoints are not current validation): ${JSON.stringify(handoff.checkpoint)}`,
        `Validation scope: ${task.validationMode??'execute'}. Report actual commands and results; source-only review is not proof that tests ran.`,
        `Allowed source writes: ${m.writeScopes.join(', ')||'none (read-only reviewer)'}. Shared project: other members are working here; do not revert their edits. Read only what this task needs.`,
        m.workspace?`Your assigned Git worktree is ${m.workspace.path}. Use this directory for every file write and command workdir. The native conversation remains in the Leader project. Commit the candidate in this worktree; do not merge or write back to the Leader workspace.`:'Work in the current shared project.',
        'Use the team_member router: operation=describe with toolName to read one operation schema, then operation=<business tool name>, arguments=<that input>. The current main conversation is your Leader. Do not create a separate team. You may read_member_team_work, claim_member_team_task, bind_member_team_task and report_member_team_task for your own assigned work only; never accept your own delivery or change scope/other members. Report blockers to the Leader; do not install dependencies or expand scope without authorization.',
        `For task-scoped coordination, use send_team_peer_message with teamId ${team.id}, attemptId ${a.id} and a stable requestId. Send only to a roster member or leader. The returned nativeAction may be delivered using the existing native send_message tool; record its actual result with record_team_peer_sender_delivery. Never auto-resend an unknown delivery. Read your own inbox and acknowledge the original message/recipient attempt. After your final delivery, finish this turn and wait. Never self-claim another task in this execution context.`,
        task.kind==='review'?`Return JSON with attemptMarker, summary, decision (accept or rework), reason, checks [{name,criterionId,status:PASS|FAIL|BLOCKED|NOT_RUN,evidence}], findings [{id,severity:blocker|high|medium|low,status:open|resolved,description,resolutionEvidence}]. Use stable IDs for new findings and preserve supplied IDs when resolving earlier findings. Use findings:[] if none. Every PASS check requires concrete evidence. Cover these target criteria: ${JSON.stringify(team.tasks.find(t=>t.id===task.reviewOfTaskId)?.acceptanceCriteria??[])}. Review independently; do not fix the implementation.`:task.contract?'Return JSON with attemptMarker, summary, changedPaths (project-relative), acceptanceResults [{criterionId,status:PASS|FAIL|BLOCKED|NOT_RUN,evidence}], commandsRun and limitations. Execute every exact contract.verify command using native command tools, so the host records its exit code. Report missing/failed checks honestly; submission is not acceptance.':'Return a summary, changed file paths, test commands/results and remaining limitations. Completion is a submission, not acceptance.'
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
    if(rosterTeam.policy?.tokenLimit)assertBudget(rosterTeam,await this.observations(rosterTeam));
    if(rosterTeam.members.some(m=>!m.removedAt&&m.recoveryControl?.status==='unavailable'))throw new Error('A native member handle is unavailable; preserve the roster and verify recovery before dispatch');
    const retirements=new Map();
    for(const taskId of taskIds){
      const task=rosterTeam.tasks.find(t=>t.id===taskId),member=rosterTeam.members.find(m=>m.id===task?.memberId);
      if(!member||task.status==='running')continue;
      const last=lastMemberExecution(rosterTeam,member);if(!last)continue;
      if(rosterTeam.tasks.some(t=>t.memberId===member.id&&t.status==='running'))throw new Error('Member still has an active attempt; preserve its context');
      const run=await this.observer.inspect(rosterTeam.leaderThreadId,rosterTeam.projectPath,member.agentThreadId,last.attempt.marker,{requireIdle:true});
      if(!last.attempt.endedAt||!terminal(run.status)||run.turnId!==last.attempt.turnId)throw new Error('Native member is not confirmed terminal; preserve its task context');
      retirements.set(member.id,run);
    }
    if(rosterTeam.fixedRoster){
      const required=requiredRosterMembers(rosterTeam,taskIds);
      if(rosterTeam.memberStartup!=='on-demand'&&required.some(m=>!m.agentThreadId&&!m.contextGeneration))throw new Error('Initialize and bind every fixed native member required by these tasks before dispatching');
      verified.push(...await Promise.all(required.filter(m=>m.agentThreadId&&!m.rosterVerified).map(async m=>{const run=await this.observer.inspect(rosterTeam.leaderThreadId,rosterTeam.projectPath,m.agentThreadId,m.rosterMarker);if(!run.turnId||run.status!=='completed')throw new Error('Member initialization is not complete; observe the same member without respawning');return {id:m.id,threadId:m.agentThreadId,turnId:run.turnId};})));
    }
    const {result:dispatches}=await this.store.update(id,owner,revision,t=>{
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
      const a=task.attempts.at(-1);a.state='reserved';a.runtimeStatus='reserved';a.marker=`TEAM_WORKSPACE_ATTEMPT:${a.id}`;a.contextGeneration=member.contextGeneration??1;requireTeamVersion(t,'0.14.0');
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
      const snapshot=await this.observer.inspect(team.leaderThreadId,team.projectPath,input.threadId,a.marker,{allowPending:true,requireFresh:!!a.contextGeneration});
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
        const first=!a.agentThreadId;bindMemberThread(t,taskId,threadId,attemptId);m.agentPath=snapshot.agentPath??m.agentPath??null;if(t.memberStartup==='on-demand'||m.contextGeneration){m.rosterVerified=true;m.initializationTurnId??=snapshot.turnId;}a.state=snapshot.turnId?'running':'linking';a.turnId=snapshot.turnId;a.runtimeStatus=snapshot.status;a.observation=snapshot;a.executedRoute={model:snapshot.model??nativeRoute(m).model??null,provider:snapshot.provider??m.routeSnapshot?.provider??null,reasoningEffort:snapshot.reasoningEffort??nativeRoute(m).reasoning_effort??null,source:snapshot.model?'host-observed-model':'frozen-route-only'};if(first){a.boundAt=now();t.totalDispatches++;}
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
      if(observe&&t.attempts.at(-1)?.id===a.id&&t.status==='running')try{observation=await this.observer.inspect(team.leaderThreadId,team.projectPath,a.agentThreadId,a.marker,{allowPending:a.state==='linking'});}catch(error){observation={...observation,status:'unknown',observationError:error.message,connection:'unavailable',observedAt:now()};}
      return {...observation,taskId:t.id,memberId:a.memberId??t.memberId,attemptId:a.id,threadId:a.agentThreadId};
    })));
  }
  async receipt(owner,id){return this.read(owner,id,{observe:false});}
  async read(owner,id,{observe=true}={}){
    const stored=await this.native(owner,id),team={...stored,members:stored.members.map(member=>({...member,...memberNaming(stored,member)}))},runs=await this.observations(team,{observe});
    const readiness=team.tasks.map(task=>({taskId:task.id,ready:task.status==='waiting'&&!dispatchBlockers(team,task).length,blockers:dispatchBlockers(team,task)}));
    const recovery=team.tasks.flatMap(task=>{const a=task.attempts.at(-1),run=runs.find(r=>r.attemptId===a?.id);if(task.status==='running')return [{taskId:task.id,attemptId:a.id,threadId:a.agentThreadId,agentPath:team.members.find(m=>m.id===task.memberId)?.agentPath??null,action:a.state==='reserved'?'verify-host-before-bind-or-release':terminal(run?.status)?'settle-confirmed-turn':'observe-existing-member',message:a.state==='reserved'?'核对宿主是否已启动；绑定失败不能重建成员':terminal(run?.status)?'成员已有终态，等待 Leader 接收':'继续核对现有成员；未知状态不自动重派'}];if(task.status==='blocked')return[{taskId:task.id,action:'leader-rework-decision',message:task.blockReason}];return[];});
    return {team,runs,readiness,recovery,quality:qualityReport(team),usage:usageReport(team,runs),workflow:workflowActions(team,runs),diagnostics:diagnostics(team,runs),peerDelivery:peerActions(team),initializations:(!team.executionControl||team.executionControl.status==='active')&&team.memberStartup!=='on-demand'&&team.fixedRoster&&!(team.planReview?.scope==='initial'&&team.planReview.status!=='approved')?team.members.filter(m=>!m.removedAt&&!m.rosterVerified).map(m=>({...rosterPacket(team,m),spawnOptions:nativeRoute(m),workspace:m.workspace??{mode:'shared',path:team.projectPath}})):[],messages:mailboxProjection(team),checkpoints:checkpointProjection(team),observedAt:now(),observationMode:observe?'fresh':'saved',runtimeSource:'native-thread-persisted-snapshot',limitations:[
      '当前主会话负责原生成员派发、消息和停止；插件不启动模型轮次。',
      '面板读取宿主已持久化的轮次记录，可能滞后；执行结束不代表已验收。',
      '成员共用当前项目，写入范围由 Leader 和成员遵守，并发冲突在派发时检查；不是文件系统沙箱。'
    ]};
  }
  async settle(owner,id,revision,taskId,attemptId){
    const team=await this.native(owner,id),task=team.tasks.find(x=>x.id===taskId),a=task?.attempts.at(-1);
    if(!a||a.id!==attemptId||!a.agentThreadId)throw new Error('A bound current attempt is required');
    if(task.status!=='running')throw new Error('Attempt is already settled');
    const run=await this.observer.inspect(team.leaderThreadId,team.projectPath,a.agentThreadId,a.marker);
    if(!terminal(run.status))throw new Error('Native turn has no confirmed terminal record');
    await this.store.update(id,owner,revision,async t=>{
      const task=t.tasks.find(x=>x.id===taskId),a=task.attempts.at(-1),member=t.members.find(x=>x.id===task.memberId);
        if(a.id!==attemptId||(a.turnId!==run.turnId&&!(a.state==='linking'&&!a.turnId&&run.turnId)))throw new Error('Attempt/turn mismatch');
        if(a.state==='linking')a.turnId=run.turnId;
      a.observation=run;a.runtimeStatus=run.status;
      if(run.status!=='completed'){task.status='blocked';task.blockReason=`Native turn ${run.status}; Leader must decide next step`;a.state=run.status;member.status='idle';pauseDispatch(t);return;}
      const output=run.outputs.at(-1)?.text?.trim();if(!output)throw new Error('Completed turn has no public delivery');
      const delivery=assertContractDelivery(task,member,output,run.commands??[]);if(delivery)a.delivery=delivery;
      if(member.workspace?.mode==='git-worktree'){
        const candidate=await this.worktrees.inspect(t,member.id);if(candidate.dirty)throw new Error('Commit the isolated candidate before submitting it for independent review');
        a.candidate={head:candidate.head,path:candidate.workspace.path,branch:candidate.workspace.branch,base:candidate.workspace.base,observedAt:now()};
      }
      if(a.memberSubmission)a.memberSubmission.status='native-verified';submitTask(t,taskId,{attemptId,summary:output,evidence:[{source:run.source,threadId:run.threadId,turnId:run.turnId,commands:run.commands}]});
    });
    return this.receipt(owner,id);
  }
  async acceptReview(owner,id,revision,taskId,attemptId,decision,note,nonValidationFailures=[]){
    await this.native(owner,id);
    await this.store.update(id,owner,revision,async t=>{
      const task=t.tasks.find(x=>x.id===taskId),a=task?.attempts.at(-1);
      if(!a||a.id!==attemptId||task.kind!=='review')throw new Error('Current independent review required');
      const target=t.tasks.find(x=>x.id===task.reviewOfTaskId);
      let verdict;try{verdict=parseReview(task.evidence.at(-1)?.summary);}catch(error){if(decision==='accept'||t.policy?.autoRepair)throw error;}
      if(verdict&&t.policy?.autoRepair&&verdict.decision!==decision)throw new Error('Leader decision must match the structured review before automatic repair');
      if(t.policy?.autoRepair&&(!verdict?.summary?.trim()||!verdict.reason?.trim()||!Array.isArray(verdict.findings)))throw new Error('Automatic repair requires a structured review summary, reason and explicit findings array');
      if(decision==='accept'){
        const member=t.members.find(m=>m.id===target?.memberId);
        if(member?.workspace?.mode==='git-worktree'){
          const candidate=await this.worktrees.inspect(t,member.id),submitted=target.attempts.at(-1)?.candidate;
          if(candidate.dirty||!submitted||candidate.head!==submitted.head||candidate.workspace.path!==submitted.path)throw new Error('Isolated candidate changed after submission; rework and independently review the new commit');
        }
        assertReviewPass(verdict,a.observation?.commands??[],target?.acceptanceCriteria??[],nonValidationFailures);
        const verification=assertContractPass(target);if(verification)Object.assign(target.attempts.at(-1).delivery,verification);
        if(nonValidationFailures.length)a.commandExplanations={source:'main-conversation-leader',note,items:structuredClone(nonValidationFailures),at:now()};
      }
      if(verdict?.findings)recordFindings(t,task,target,verdict,{accept:decision==='accept'});
      reviewTask(t,taskId,{attemptId,decision,note});t.state=t.tasks.every(x=>['accepted','cancelled'].includes(x.status))?'awaiting-leader-acceptance':'active';
      if(decision==='rework'&&t.policy?.autoRepair)planRepair(t,task,target,note);
    });return this.receipt(owner,id);
  }
  async finish(owner,id,revision,note,checks){await this.native(owner,id);await this.store.update(id,owner,revision,t=>{
    if(!t.tasks.every(x=>['accepted','cancelled'].includes(x.status)))throw new Error('All deliveries require independent acceptance first');
    if(!checks?.length||checks.some(c=>c.status!=='PASS'||!c.evidence?.trim()))throw new Error('Leader must supply final project validation evidence; missing checks are not a pass');
    assertQualityFinish(t);for(const task of t.tasks.filter(t=>t.status==='accepted')){const verification=assertContractPass(task);if(verification)Object.assign(task.attempts.at(-1).delivery,verification);}
    t.state='delivered';t.finalAcceptance={source:'main-conversation-leader',note,checks,at:now()};t.dispatchPaused=true;
  });return this.receipt(owner,id);}
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
    const observations=await Promise.all(stopTargets(team).filter(x=>x.threadId).map(async x=>{try{const m=team.members.find(m=>m.id===x.memberId),a=team.tasks.find(t=>t.id===x.taskId)?.attempts.at(-1);return {...x,run:await this.observer.inspect(team.leaderThreadId,team.projectPath,x.threadId,a?.marker??lastMemberExecution(team,m)?.attempt.marker??m.rosterMarker,{allowPending:true,requireIdle:true})};}catch(error){return {...x,error:error.message};}}));
    await this.store.update(id,owner,revision,t=>{
      const pending=[];
      for(const item of observations){if(item.error||!item.run.quiescence){pending.push({memberId:item.memberId,reason:item.error??'Latest native turn has no confirmed terminal record'});continue;}
        const m=t.members.find(m=>m.id===item.memberId),task=t.tasks.find(task=>task.id===item.taskId),a=task?.attempts.at(-1);
        if(a&&(!item.run.turnId||!terminal(item.run.status))&&!unstartedTaskIds.includes(task.id)){pending.push({memberId:m.id,taskId:task.id,reason:'Attempt identity is not terminal; verify host dispatch before retrying'});continue;}
        if(a){a.observation=item.run;a.runtimeStatus=item.run.status;a.state=unstartedTaskIds.includes(task.id)&&!item.run.turnId?'released':'stopped';a.endedAt=now();a.stopEvidence={quiescence:item.run.quiescence,note};task.status=a.state==='released'?'waiting':'blocked';task.blockReason='Team stopped; explicitly select retry tasks when resuming';}
        if(!a&&item.run.status==='completed'&&item.run.turnId){m.rosterVerified=true;m.initializationTurnId=item.run.turnId;}m.status='idle';m.stopObservation=item.run.quiescence;
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
  async memberReport(owner,id,revision,context,input){const r=await this.store.update(id,owner,revision,t=>memberReport(t,context,input));return {...r.result,revision:r.team.revision};}
  async close(){await this.observer.close?.();}
  async message(owner,id,revision,taskId,text,requestId){
    await this.native(owner,id);const {team,result}=await this.store.update(id,owner,revision,t=>{const before=t.messages?.length??0;const message=queueMessage(t,{taskId,text,requestId});return {message,firstOffer:t.messages.length>before};});
    return {...await this.receipt(owner,id),leaderAction:messageAction(team,result.message,result.firstOffer)};
  }
  async checkpoint(owner,id,revision,input){
    await this.native(owner,id);
    const {result}=await this.store.update(id,owner,revision,t=>recordCheckpoint(t,input));
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
    const observation=await this.observer.inspect(team.leaderThreadId,team.projectPath,message.threadId,attempt.marker);
    await this.store.update(id,owner,revision,t=>acknowledgeMessage(t,messageId,observation));return this.receipt(owner,id);
  }
  async advance(owner,id,revision,{settleCompleted=true,dispatchReady=false,decisions=[]}={}) {
    let data=await this.read(owner,id);if(data.team.revision!==revision)throw new Error('Team changed; refresh before workflow advancement');
    if(settleCompleted)for(const action of data.workflow.actions.filter(a=>a.type==='settle'))data=await this.settle(owner,id,data.team.revision,action.taskId,action.attemptId);
    for(const decision of decisions)data=await this.acceptReview(owner,id,data.team.revision,decision.taskId,decision.attemptId,decision.decision,decision.note,decision.nonValidationFailures??[]);
    data=await this.read(owner,id);
    const batch=data.workflow.actions.find(a=>a.type==='claim-batch');
    if(dispatchReady&&batch)data=await this.claimMany(owner,id,data.team.revision,batch.taskIds);
    return data;
  }
  async usage(owner,id,{refreshHistorical=false}={}) {
    const data=await this.read(owner,id);
    if(refreshHistorical&&this.observer.historicalUsage)for(const threadId of new Set(data.team.tasks.flatMap(t=>t.attempts.filter(a=>a.agentThreadId&&a.turnId).map(a=>a.agentThreadId)))){
      const attempts=data.team.tasks.flatMap(t=>t.attempts).filter(a=>a.agentThreadId===threadId&&a.turnId);
      const observed=await this.observer.historicalUsage(data.team.leaderThreadId,data.team.projectPath,threadId,[...new Set(attempts.map(a=>a.turnId))]);
      for(const a of attempts){const run=data.runs.find(r=>r.attemptId===a.id);if(run)run.usage=observed.find(o=>o.turnId===a.turnId)?.usage??null;}
    }
    return usageReport(data.team,data.runs);
  }
}
