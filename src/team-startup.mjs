import {requiredRosterMembers} from './team-roster.mjs';

// A terminal startup receipt is a failure to acquire execution authority,
// never a delivery. Shared by the minimal wait projection and full workflow.
export function startupFailureAction(task,run){
 const a=task.attempts?.at(-1),recoverable=!!a?.startupBaseline?.fingerprint&&run?.startupRecovery?.allTurnsTerminal&&run.startupRecovery.noExecutionItems&&run.startupRecovery.noPublicDelivery===true;
 return a?.state==='reserved'&&!a.agentThreadId&&run?.startupOnly&&(['completed','failed','interrupted'].includes(run.status)||run.startupTerminal)?{type:'startup-failed',taskId:task.id,attemptId:a.id,threadId:run.threadId,observedStatus:run.startupTerminal?.status??run.status,reason:!a.startupBaseline?.fingerprint?'Original startup input baseline is missing; candidate identity cannot be proven unchanged. Preserve the legacy attempt and reconcile existing evidence without tests.':a.startupRejections?.at(-1)?.reason??run.startupReason??'Native child ended before authenticated task binding',...(recoverable?{tool:'recover_team_startup',recoveryArguments:{taskId:task.id,attemptId:a.id,requestId:a.id}}:{}),instruction:recoverable?'Call recover_team_startup once with recoveryArguments and current teamId/revision. It verifies terminal native history twice, no execution and unchanged candidate, retires only this rejected startup and preserves history. Then continue the existing goal with a fresh exact nativeAction; no code/review budget or tests are consumed.':'Stop waiting for this ended startup. Preserve the reservation, original native error and all history. No safe empty-startup proof: reconcile existing work once; never release as never launched, replace unknown work or rerun completed tests.'}:null;
}

// Explicit modern contracts fail before any team/registry write or native launch.
// Missing protocol is a preserved legacy configuration, never silently converted.
export function startupConflict(config){
  const protocol=config.startupProtocol;
  if(protocol===undefined)return null;
  const expected=protocol==='task-bound'?'on-demand':protocol==='roster-bound'?'eager':null;
  if(expected&&config.memberStartup===expected)return null;
  return {code:'startup-config-conflict',message:'启动配置冲突：'+(expected?`startupProtocol=${protocol} requires memberStartup=${expected}.`:'Unknown startupProtocol.'),repair:expected?{startupProtocol:protocol,memberStartup:expected}:null,instruction:'Correct the startup configuration before creating members. Do not spawn, bind, retry dispatch or poll unchanged state.'};
}
export function assertStartupConfiguration(config){
  const issue=startupConflict(config);if(issue)throw new Error(issue.code+': '+issue.message+' '+issue.instruction);
}
export function startupBlockers(team){
  const conflict=startupConflict(team);if(conflict)return [conflict];
  if(!team.fixedRoster)return [];
  const tasks=team.tasks.filter(t=>t.status==='waiting'&&(!team.activeBatchId||t.batchId===team.activeBatchId));
  if(!tasks.length)return [];
  const members=requiredRosterMembers(team,tasks.map(t=>t.id)).filter(m=>!m.rosterVerified&&(team.memberStartup!=='on-demand'||m.agentThreadId));
  if(!members.length)return [];
  return [{code:'member-initialization',message:(team.memberStartup==='on-demand'?'已有原生成员的绑定尚未核实：':'预先初始化模式尚未完成原生成员绑定：')+members.map(m=>m.role??m.id).join('、'),memberIds:members.map(m=>m.id),instruction:'This is roster-bound startup, not task self-bootstrap. Reuse existing initialization conversations; inspect their exact roster markers and bind_team_roster_members once. Do not create replacements, claim tasks or keep waiting. Read read_team(view=full) only to obtain missing initialization packets.'}];
}
export function startupWaitBlocked(team,workflow){
  return !!workflow?.startupBlockers?.length&&!team.tasks.some(t=>t.status==='running')&&!workflow.actions.some(a=>['claim-batch','settle','accept-review','final-validation'].includes(a.type));
}

// An exact host-owned active child may be waited for before it authenticates
// its task. This grants no binding, context, execution or acceptance authority.
export function pendingNativeBootstrap(team,task,run){
 const a=task.attempts?.at(-1),p=run?.startupActivity;
 if(a?.state==='reserved'&&!a.agentThreadId&&a.bootstrap?.taskName&&run?.startupOnly===true&&run.executionAuthority===false&&run.source==='native-observed-launch'&&run.noIndexedChild===true&&run.parentThreadId===team.leaderThreadId&&run.agentPath?.split('/').at(-1)===a.bootstrap.taskName&&!a.startupRejections?.length){
  const intent=run.launchIntent,call=intent?.calls?.[0],at=Date.parse(call?.at),observed=Date.parse(run.observedAt),reserved=Date.parse(a.startedAt);
  return intent?.source==='native-spawn-intent-history'&&intent.verified===true&&intent.launchCallObserved===true&&intent.parentThreadId===team.leaderThreadId&&intent.taskName===a.bootstrap.taskName&&Array.isArray(intent.calls)&&intent.calls.length===1&&typeof call?.callId==='string'&&!!call.callId&&Number.isFinite(at)&&Number.isFinite(observed)&&Number.isFinite(reserved)&&at>=reserved-5000&&at<=observed+5000&&observed-at<120000;
 }
 if(!(a?.state==='reserved'&&!a.agentThreadId&&!!a.bootstrap?.taskName&&run?.startupOnly===true&&run.source==='native-child-metadata'&&run.executionAuthority===false&&!run.startupTerminal&&run.parentThreadId===team.leaderThreadId&&!!run.threadId&&run.agentPath?.split('/').at(-1)===a.bootstrap.taskName&&p?.source==='native-latest-turn'&&p.safePrelude===true&&p.noPublicDelivery===true&&!a.startupRejections?.some(r=>r.threadId===run.threadId)))return false;
 const current=p.turnCount===1&&!!p.turnId&&p.turnId===run.latestTurnId;
 if(current&&p.status==='inProgress')return true;
 // A snapshot server can label an unloaded, freshly created host child unknown
 // before its first public item/turn appears. Waiting grants no authority.
 // The fixed deadline is anchored to native metadata, never renewed by polling.
 const created=Date.parse(p.createdAt),started=Date.parse(p.startedAt),reserved=Date.parse(a.startedAt),observed=Date.parse(run.observedAt),start=current&&Number.isFinite(started)?started:created;
 return p.status==='unknown'&&(current||p.turnCount===0&&!p.turnId&&!run.latestTurnId)&&Number.isFinite(created)&&Number.isFinite(reserved)&&Number.isFinite(observed)&&created>=reserved-5000&&created<=start&&start<=observed+5000&&observed-start<120000;
}
