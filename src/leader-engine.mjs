import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {TeamStore,schedule,bindMemberThread,submitTask,reviewTask,pauseDispatch,validatePlan,dispatchBlockers} from './team.mjs';
import {DurableStore} from './durable-store.mjs';
import {NativeMembers} from './native-members.mjs';
import {parseReview,assertReviewPass} from './quality-gates.mjs';
import {queueMessage,messageAction,recordMessageDelivery,acknowledgeMessage,mailboxProjection} from './team-mailbox.mjs';
import {recordCheckpoint,checkpointProjection,buildHandoff} from './team-checkpoints.mjs';
import {rosterPacket} from './team-roster.mjs';
import {memberNaming,memberTitleAction} from './team-naming.mjs';
import {assertBudget,usageReport,normalizePolicy,compactHandoff,nativeRoute} from './team-policy.mjs';
import {diagnostics} from './team-diagnostics.mjs';
import {workflowActions} from './team-workflow.mjs';
import {peerActions} from './team-peer-mailbox.mjs';
import {TeamWorktrees} from './team-worktrees.mjs';

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
    const key=createHash('sha256').update(JSON.stringify({owner,cwd:context.cwd,goal:args.goal,plan:args.plan,requestId:args.requestId??null,fixedRoster:!!args.initializeMembers})).digest('hex');
    return new DurableStore(join(this.root,'leader-plan-requests.json'),{requests:{}}).transaction(async d=>{
      if(d.requests[key])return this.store.get(d.requests[key],owner);
      const team=await this.store.create({projectId:createHash('sha256').update(context.cwd).digest('hex').slice(0,24),projectPath:context.cwd,goal:args.goal,plan:args.plan,maxParallel:args.maxParallel??3},owner);
      const saved=(await this.store.update(team.id,owner,team.revision,t=>{t.mode='host-leader';t.leaderThreadId=context.threadId;t.dispatchPaused=!args.execute;t.state=args.execute?'active':'planned';t.totalDispatches=0;if(args.initializeMembers){t.fixedRoster=true;for(const m of t.members){m.rosterMarker=`TEAM_WORKSPACE_MEMBER:${randomUUID()}`;m.rosterVerified=false;}}})).team;
      d.requests[key]=saved.id;return saved;
    });
  }
  async native(owner,id){const team=await this.store.get(id,owner);if(team.mode!=='host-leader')throw new Error('This is a legacy isolated team; native delegation requires a host-leader plan');return team;}
  packet(team,task){
    const a=task.attempts.at(-1),m=team.members.find(x=>x.id===task.memberId);
    const handoff=compactHandoff(buildHandoff(team,task.id),normalizePolicy(team.policy));
    return {taskId:task.id,attemptId:a.id,memberId:m.id,...memberNaming(team,m),titleAction:memberTitleAction(team,m),existingThreadId:m.agentThreadId,existingAgentPath:m.agentPath??null,marker:a.marker,spawnOptions:nativeRoute(m),workspace:m.workspace??{path:team.projectPath,mode:'shared'},contextBudget:handoff.contextBudget,
      action:m.agentThreadId?'followup-native-member':'spawn-native-member',
      prompt:[a.marker,`Before working, emit this exact marker as a standalone public commentary message: ${a.marker}. Include it as the first line of your final delivery, or as attemptMarker in a JSON review. Do not repeat markers from earlier attempts.`, `Leader: ${team.leaderThreadId}. Project: ${team.projectPath}.`,
        `Fixed member name: ${memberNaming(team,m).displayName}. Role: ${m.role}. Responsibility: ${m.responsibility}.`, `Task: ${task.title}\n${task.goal}`,`Acceptance: ${task.acceptance}`,
        `Team goal: ${handoff.teamGoal}`,`Acceptance criteria: ${JSON.stringify(task.acceptanceCriteria??[])}`,`Additional context: ${task.context??''}`,`Upstream evidence: ${JSON.stringify(handoff.dependencies)}`,
        `Saved checkpoint (Leader-recorded; stale checkpoints are not current validation): ${JSON.stringify(handoff.checkpoint)}`,
        `Validation scope: ${task.validationMode??'execute'}. Report actual commands and results; source-only review is not proof that tests ran.`,
        `Allowed source writes: ${m.writeScopes.join(', ')||'none (read-only reviewer)'}. Shared project: other members are working here; do not revert their edits. Read only what this task needs.`,
        m.workspace?`Your assigned Git worktree is ${m.workspace.path}. Use this directory for every file write and command workdir. The native conversation remains in the Leader project. Commit the candidate in this worktree; do not merge or write back to the Leader workspace.`:'Work in the current shared project.',
        'The current main conversation is your Leader. Do not create a separate team or change team records. Report blockers to the Leader; do not install dependencies or expand scope without authorization.',
        `For task-scoped coordination, use send_team_peer_message with teamId ${team.id}, attemptId ${a.id} and a stable requestId. Send only to a roster member or leader. The returned nativeAction may be delivered using the existing native send_message tool; record its actual result with record_team_peer_sender_delivery. Never auto-resend an unknown delivery. Read your own inbox and acknowledge the original message/recipient attempt.`,
        task.kind==='review'?`Return JSON with attemptMarker, summary, decision (accept or rework), reason, checks [{name,criterionId,status:PASS|FAIL|BLOCKED|NOT_RUN,evidence}], findings [{severity:blocker|high|medium|low,status:open|resolved,description}]. Use findings:[] if none. Every PASS check requires concrete evidence. Cover these target criteria: ${JSON.stringify(team.tasks.find(t=>t.id===task.reviewOfTaskId)?.acceptanceCriteria??[])}. Review independently; do not fix the implementation.`:'Return a summary, changed file paths, test commands/results and remaining limitations. Completion is a submission, not acceptance.'
      ].join('\n\n')};
  }
  async claim(owner,id,revision,taskId){
    const data=await this.claimMany(owner,id,revision,[taskId]);const {dispatches,...rest}=data;return {...rest,dispatch:dispatches[0]};
  }
  async claimMany(owner,id,revision,taskIds){
    if(!taskIds?.length||taskIds.length>8||new Set(taskIds).size!==taskIds.length)throw new Error('Provide 1–8 unique tasks');
    const rosterTeam=await this.native(owner,id),verified=[];
    if(rosterTeam.revision!==revision)throw new Error('Team changed; refresh before controlling members');
    if(rosterTeam.state==='superseded')throw new Error('Historical team cannot dispatch; use the project’s current team');
    if(rosterTeam.policy?.tokenLimit)assertBudget(rosterTeam,await this.observations(rosterTeam));
    if(rosterTeam.members.some(m=>m.recoveryControl?.status==='unavailable'))throw new Error('A native member handle is unavailable; preserve the roster and verify recovery before dispatch');
    if(rosterTeam.fixedRoster){
      if(rosterTeam.members.some(m=>!m.agentThreadId))throw new Error('Initialize and bind every fixed native member before dispatching tasks');
      verified.push(...await Promise.all(rosterTeam.members.filter(m=>!m.rosterVerified).map(async m=>{const run=await this.observer.inspect(rosterTeam.leaderThreadId,rosterTeam.projectPath,m.agentThreadId,m.rosterMarker);if(!run.turnId||run.status!=='completed')throw new Error('Member initialization is not complete; observe the same member without respawning');return {id:m.id,threadId:m.agentThreadId,turnId:run.turnId};})));
    }
    const {team}=await this.store.update(id,owner,revision,t=>{
      for(const item of verified){const m=t.members.find(m=>m.id===item.id);if(m.agentThreadId!==item.threadId)throw new Error('Roster changed');m.rosterVerified=true;m.initializationTurnId=item.turnId;m.status='idle';}
      if(t.mode!=='host-leader'||t.dispatchPaused)throw new Error('Leader dispatch is paused or this is a legacy team');
      for(const taskId of taskIds){
      const task=t.tasks.find(x=>x.id===taskId);if(!task)throw new Error('Task not found');
      if(task.status==='running'&&task.attempts.at(-1)?.state==='reserved')continue;
      const blockers=dispatchBlockers(t,task);if(blockers.length)throw new Error('Task is not ready: '+blockers.map(b=>b.message).join('; '));
      const draft=structuredClone(t);draft.maxParallel=Math.min(t.maxParallel,t.tasks.filter(x=>x.status==='running').length+1);
      draft.tasks.find(x=>x.id===taskId).priority=0;
      const selected=schedule(draft);if(selected.length!==1||selected[0].id!==taskId)throw new Error('Task is not ready: check dependencies, member availability, write conflicts and parallel limit');
      const candidate=selected[0];candidate.priority=task.priority;Object.assign(task,candidate);
      const member=t.members.find(x=>x.id===task.memberId);Object.assign(member,draft.members.find(x=>x.id===member.id));
      const a=task.attempts.at(-1);a.state='reserved';a.runtimeStatus='reserved';a.marker=`TEAM_WORKSPACE_ATTEMPT:${a.id}`;
      t.events.push({at:now(),type:'leader-task-reserved',taskId,attemptId:a.id});
      }
    });
    return {...await this.receipt(owner,id),dispatches:taskIds.map(taskId=>this.packet(team,team.tasks.find(x=>x.id===taskId)))};
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
      const snapshot=await this.observer.inspect(team.leaderThreadId,team.projectPath,input.threadId,a.marker,{allowPending:true});
      return {...input,threadId:snapshot.threadId,snapshot};
    }));
    await this.store.update(id,owner,revision,t=>{
      for(const {taskId,attemptId,threadId,snapshot} of verified){
      const task=t.tasks.find(x=>x.id===taskId),a=task.attempts.at(-1);
      if(a.id!==attemptId||task.status!=='running')throw new Error('Stale attempt');
      if(t.tasks.some(x=>x.id!==taskId&&x.status==='running'&&x.attempts.at(-1)?.agentThreadId===threadId))throw new Error('Member is already executing another task');
      const m=t.members.find(x=>x.id===task.memberId);
      if(m.agentThreadId&&m.agentThreadId!==threadId)throw new Error('Reuse the existing native member; do not silently replace it');
      if(t.members.some(x=>x.id!==m.id&&x.agentThreadId===threadId))throw new Error('Different roles require distinct native members');
        const first=!a.agentThreadId;bindMemberThread(t,taskId,threadId,attemptId);m.agentPath=snapshot.agentPath??m.agentPath??null;a.state=snapshot.turnId?'running':'linking';a.turnId=snapshot.turnId;a.runtimeStatus=snapshot.status;a.observation=snapshot;if(first){a.boundAt=now();t.totalDispatches++;}
      }
    });
    const data=await this.receipt(owner,id);return {...data,titleActions:verified.map(v=>memberTitleAction(data.team,data.team.members.find(m=>m.id===data.team.tasks.find(t=>t.id===v.taskId).memberId)))};
  }
  async bindRoster(owner,id,revision,memberId,threadId){
    const data=await this.bindRosterMany(owner,id,revision,[{memberId,threadId}]);const {titleActions,...rest}=data;return {...rest,titleAction:titleActions[0]};
  }
  async bindRosterMany(owner,id,revision,assignments){
    if(!assignments?.length||assignments.length>8||new Set(assignments.map(x=>x.memberId)).size!==assignments.length)throw new Error('Provide 1–8 unique roster bindings');
    const team=await this.native(owner,id);if(team.revision!==revision)throw new Error('Team changed; refresh before controlling members');
    const verified=await Promise.all(assignments.map(async input=>{
      const member=team.members.find(m=>m.id===input.memberId);if(!team.fixedRoster||!member)throw new Error('A fixed roster member is required');
      return {...input,snapshot:await this.observer.inspect(team.leaderThreadId,team.projectPath,input.threadId,member.rosterMarker,{allowPending:true})};
    }));
    await this.store.update(id,owner,revision,t=>{for(const {memberId,snapshot} of verified){const m=t.members.find(m=>m.id===memberId);
      if(m.agentThreadId&&m.agentThreadId!==snapshot.threadId)throw new Error('Reuse this member’s existing native subagent');
      if(t.members.some(x=>x.id!==memberId&&x.agentThreadId===snapshot.threadId))throw new Error('Different members require distinct native subagents');
      m.agentThreadId=snapshot.threadId;m.agentPath=snapshot.agentPath;m.rosterVerified=snapshot.status==='completed'&&!!snapshot.turnId;m.initializationTurnId=snapshot.turnId;m.status=m.rosterVerified?'idle':'starting';m.lastActivityAt=now();
      t.events.push({at:now(),type:'native-roster-member-linked',memberId,threadId:snapshot.threadId,verified:m.rosterVerified});
    }});const data=await this.receipt(owner,id);return {...data,titleActions:verified.map(v=>memberTitleAction(data.team,data.team.members.find(m=>m.id===v.memberId)))};
  }
  async observations(team,{observe=true}={}){
    return Promise.all(team.tasks.flatMap(t=>t.attempts.filter(a=>a.agentThreadId).map(async a=>{
      let observation=a.observation;
      if(observe&&t.attempts.at(-1)?.id===a.id&&t.status==='running')try{observation=await this.observer.inspect(team.leaderThreadId,team.projectPath,a.agentThreadId,a.marker,{allowPending:a.state==='linking'});}catch(error){observation={...observation,status:'unknown',observationError:error.message,connection:'unavailable',observedAt:now()};}
      return {...observation,taskId:t.id,memberId:t.memberId,attemptId:a.id,threadId:a.agentThreadId};
    })));
  }
  async receipt(owner,id){return this.read(owner,id,{observe:false});}
  async read(owner,id,{observe=true}={}){
    const stored=await this.native(owner,id),team={...stored,members:stored.members.map(member=>({...member,...memberNaming(stored,member)}))},runs=await this.observations(team,{observe});
    const readiness=team.tasks.map(task=>({taskId:task.id,ready:task.status==='waiting'&&!dispatchBlockers(team,task).length,blockers:dispatchBlockers(team,task)}));
    const recovery=team.tasks.flatMap(task=>{const a=task.attempts.at(-1),run=runs.find(r=>r.attemptId===a?.id);if(task.status==='running')return [{taskId:task.id,attemptId:a.id,threadId:a.agentThreadId,agentPath:team.members.find(m=>m.id===task.memberId)?.agentPath??null,action:a.state==='reserved'?'verify-host-before-bind-or-release':terminal(run?.status)?'settle-confirmed-turn':'observe-existing-member',message:a.state==='reserved'?'核对宿主是否已启动；绑定失败不能重建成员':terminal(run?.status)?'成员已有终态，等待 Leader 接收':'继续核对现有成员；未知状态不自动重派'}];if(task.status==='blocked')return[{taskId:task.id,action:'leader-rework-decision',message:task.blockReason}];return[];});
    return {team,runs,readiness,recovery,usage:usageReport(team,runs),workflow:workflowActions(team,runs),diagnostics:diagnostics(team,runs),peerDelivery:peerActions(team),initializations:team.fixedRoster?team.members.filter(m=>!m.rosterVerified).map(m=>({...rosterPacket(team,m),spawnOptions:nativeRoute(m),workspace:m.workspace??{mode:'shared',path:team.projectPath}})):[],messages:mailboxProjection(team),checkpoints:checkpointProjection(team),observedAt:now(),observationMode:observe?'fresh':'saved',runtimeSource:'native-thread-persisted-snapshot',limitations:[
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
      if(member.workspace?.mode==='git-worktree'){
        const candidate=await this.worktrees.inspect(t,member.id);if(candidate.dirty)throw new Error('Commit the isolated candidate before submitting it for independent review');
        a.candidate={head:candidate.head,path:candidate.workspace.path,branch:candidate.workspace.branch,base:candidate.workspace.base,observedAt:now()};
      }
      submitTask(t,taskId,{attemptId,summary:output,evidence:[{source:run.source,threadId:run.threadId,turnId:run.turnId,commands:run.commands}]});
    });
    return this.receipt(owner,id);
  }
  async acceptReview(owner,id,revision,taskId,attemptId,decision,note,nonValidationFailures=[]){
    await this.native(owner,id);
    await this.store.update(id,owner,revision,async t=>{
      const task=t.tasks.find(x=>x.id===taskId),a=task?.attempts.at(-1);
      if(!a||a.id!==attemptId||task.kind!=='review')throw new Error('Current independent review required');
      if(decision==='accept'){
        const verdict=parseReview(task.evidence.at(-1)?.summary);
        const target=t.tasks.find(x=>x.id===task.reviewOfTaskId);
        const member=t.members.find(m=>m.id===target?.memberId);
        if(member?.workspace?.mode==='git-worktree'){
          const candidate=await this.worktrees.inspect(t,member.id),submitted=target.attempts.at(-1)?.candidate;
          if(candidate.dirty||!submitted||candidate.head!==submitted.head||candidate.workspace.path!==submitted.path)throw new Error('Isolated candidate changed after submission; rework and independently review the new commit');
        }
        assertReviewPass(verdict,a.observation?.commands??[],target?.acceptanceCriteria??[],nonValidationFailures);
        if(nonValidationFailures.length)a.commandExplanations={source:'main-conversation-leader',note,items:structuredClone(nonValidationFailures),at:now()};
      }
      reviewTask(t,taskId,{attemptId,decision,note});t.state=t.tasks.every(x=>['accepted','cancelled'].includes(x.status))?'awaiting-leader-acceptance':'active';
    });return this.receipt(owner,id);
  }
  async finish(owner,id,revision,note,checks){await this.native(owner,id);await this.store.update(id,owner,revision,t=>{
    if(!t.tasks.every(x=>['accepted','cancelled'].includes(x.status)))throw new Error('All deliveries require independent acceptance first');
    if(!checks?.length||checks.some(c=>c.status!=='PASS'||!c.evidence?.trim()))throw new Error('Leader must supply final project validation evidence; missing checks are not a pass');
    t.state='delivered';t.finalAcceptance={source:'main-conversation-leader',note,checks,at:now()};t.dispatchPaused=true;
  });return this.receipt(owner,id);}
  async start(owner,id,revision){await this.native(owner,id);await this.store.update(id,owner,revision,t=>{if(t.state==='superseded')throw new Error('Historical team cannot restart');if(t.state==='delivered')return;t.dispatchPaused=false;t.state='active';});return this.receipt(owner,id);}
  async addTasks(owner,id,revision,tasks){await this.native(owner,id);await this.store.update(id,owner,revision,t=>{
    if(t.state==='superseded')throw new Error('This is a historical team; use the project’s current team');
    const timestamp=now();t.tasks.push(...tasks.map(task=>({...task,status:'waiting',attempt:0,attempts:[],evidence:[],history:[{at:timestamp,type:'added'}],blockReason:null,createdAt:timestamp,updatedAt:timestamp})));
    validatePlan(t);for(const task of t.tasks.filter(x=>x.kind!=='review'))if(t.tasks.filter(r=>r.kind==='review'&&r.reviewOfTaskId===task.id).length!==1)throw new Error('New deliveries require one independent review');
    if(t.finalAcceptance){t.acceptanceHistory??=[];t.acceptanceHistory.push(t.finalAcceptance);delete t.finalAcceptance;}t.state='active';t.dispatchPaused=false;t.events.push({at:timestamp,type:'tasks-added-to-fixed-team',taskIds:tasks.map(t=>t.id)});
  });return this.receipt(owner,id);}
  async pause(owner,id,revision){await this.native(owner,id);await this.store.update(id,owner,revision,pauseDispatch);return this.receipt(owner,id);}
  async stop(owner,id,revision){const data=await this.pause(owner,id,revision);return {...data,leaderAction:{type:'interrupt-native-members',targets:data.team.tasks.filter(t=>t.status==='running').map(t=>({taskId:t.id,threadId:t.attempts.at(-1)?.agentThreadId,agentPath:data.team.members.find(m=>m.id===t.memberId)?.agentPath??null,attemptId:t.attempts.at(-1)?.id})),note:'Dispatch paused only. Leader must interrupt native members and settle confirmed terminal records.'}};}
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
    if(refreshHistorical&&this.observer.historicalUsage)for(const member of data.team.members.filter(m=>m.agentThreadId)){
      const attempts=data.team.tasks.filter(t=>t.memberId===member.id).flatMap(t=>t.attempts).filter(a=>a.agentThreadId===member.agentThreadId&&a.turnId);
      const observed=await this.observer.historicalUsage(data.team.leaderThreadId,data.team.projectPath,member.agentThreadId,[...new Set(attempts.map(a=>a.turnId))]);
      for(const a of attempts){const run=data.runs.find(r=>r.attemptId===a.id);if(run)run.usage=observed.find(o=>o.turnId===a.turnId)?.usage??null;}
    }
    return usageReport(data.team,data.runs);
  }
}
