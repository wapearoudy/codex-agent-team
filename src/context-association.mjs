import {registeredContextIds} from './native-usage.mjs';

// Projection only: a planned native path is a launch intent, never execution
// authority. Only authenticated bootstrap may bind the actual turn.
export function projectContextAssociations(team,contexts,{nowMs=Date.now(),runs=[]}={}){
 const registered=new Set(registeredContextIds(team));
 const pending=team.tasks.flatMap(task=>{const a=task.attempts?.at(-1),m=team.members?.find(m=>m.id===task.memberId);return task.status==='running'&&a?.state==='reserved'&&!a.agentThreadId&&a.bootstrap?[{task,a,path:m?.agentPath??a.bootstrap.agentPath,name:a.bootstrap.taskName}]:[];});
 const matches=c=>pending.filter(p=>c.agentPath&&(p.path?c.agentPath===p.path:c.agentPath===(c.parentAgentPath??'/root')+'/'+p.name)&&Number.isFinite(c.createdAt)&&c.createdAt>=Date.parse(p.a.startedAt)-1000);
 return contexts.map(c=>{
  if(c.kind==='leader')return c;
  if(registered.has(c.threadId))return {...c,kind:'member',association:{status:'linked'}};
  if(c.kind!=='unregistered-native')return c;
  const candidates=matches(c),p=candidates[0];
  if(candidates.length===1&&contexts.filter(other=>other.kind==='unregistered-native'&&matches(other).some(x=>x.a.id===p.a.id)).length===1){
   const run=runs.find(r=>r.startupOnly&&r.attemptId===p.a.id&&r.threadId===c.threadId);
   if(run&&(['completed','failed','interrupted'].includes(run.status)||run.startupTerminal))return {...c,association:{status:'startup-failed',taskId:p.task.id,attemptId:p.a.id,turnId:run.startupTerminal?.turnId??run.turnId,reason:run.startupReason,executionAuthority:false}};
   const age=nowMs-c.createdAt,paused=team.dispatchPaused||team.executionControl&&team.executionControl.status!=='active'||team.state!=='active';
   return {...c,association:{status:paused?'startup-paused':age>=0&&age<120000?'starting':'startup-overdue',taskId:p.task.id,attemptId:p.a.id,executionAuthority:false}};
  }
  return {...c,association:{status:candidates.length?'ambiguous':'unmapped',executionAuthority:false}};
 });
}
