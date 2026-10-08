// Pure read projections. Historical attempts never imply a currently running member.
import {memberName} from './team-naming.mjs';
export function runIsActive(run,nowMs=Date.now()){
  if(run?.status!=='inProgress')return false;
  if(run.connection==='connected')return true;
  if(run.connection!=='snapshot')return false;
  const until=Date.parse(run.statusEvidence?.freshUntil??'');
  if(Number.isFinite(until))return nowMs<until;
  return run.source==='native-thread-persisted-snapshot'&&Number.isFinite(Date.parse(run.observedAt))&&nowMs-Date.parse(run.observedAt)<60000;
}
export function taskDisplayState(task,runs=[]){
  if(task.status!=='running')return task.status;
  const attempt=task.attempts.at(-1);
  if(attempt?.state==='reserved')return 'reserved';
  const run=runs.find(r=>r.attemptId===attempt?.id&&r.taskId===task.id);
  if(runIsActive(run))return 'running';
  if(run?.status==='inProgress'&&run?.statusEvidence?.freshUntil&&Date.parse(run.statusEvidence.freshUntil)<=Date.now())return 'unknown';
  if(['completed','failed','interrupted'].includes(run?.status))return run.status;
  if(run?.status==='starting'||attempt?.state==='linking')return run?.status==='unknown'?'unknown':'starting';
  if(run?.status==='unknown')return 'unknown';
  if(['completed','failed','interrupted'].includes(run?.status))return run.status;
  if(run?.connection==='snapshot')return 'observed';
  return task.status;
}
export function memberExecutions(member,tasks,runs){
  return tasks.flatMap(task=>(task.attempts??[]).filter(a=>(a.memberId??task.memberId)===member.id).map(attempt=>{
    const run=runs.find(r=>r.attemptId===attempt.id&&r.taskId===task.id&&r.memberId===member.id);
    return {taskId:task.id,attemptId:attempt.id,number:attempt.number,threadId:run?.threadId??attempt.agentThreadId,
      turnId:run?.turnId??attempt.turnId,model:run?.model??null,status:run?.status==='inProgress'&&run?.statusEvidence?.freshUntil&&Date.parse(run.statusEvidence.freshUntil)<=Date.now()?'unknown':run?.status??attempt.runtimeStatus??'unknown',
      connection:run?.connection??attempt.connection,active:task.memberId===member.id&&task.status==='running'&&runIsActive(run),current:task.memberId===member.id&&task.attempts.at(-1).id===attempt.id,startedAt:attempt.startedAt,endedAt:attempt.endedAt};
  }));
}
export function memberState(member,tasks,runs){
  if(member.removedAt)return 'removed';
  const assigned=tasks.filter(t=>t.memberId===member.id);
  const current=memberExecutions(member,tasks,runs).filter(e=>e.current&&assigned.some(t=>t.id===e.taskId&&t.status==='running'));
  if(assigned.some(t=>t.status==='running'&&t.attempts.at(-1)?.state==='reserved'))return 'reserved';
  if(assigned.some(t=>t.status==='running')){
    if(current.some(e=>e.active))return 'running';
    if(current.some(e=>e.status==='starting'))return 'starting';
    if(current.some(e=>e.status==='unknown'))return 'unknown';
  }
  if(current.some(e=>e.connection==='snapshot'&&!['completed','failed','interrupted'].includes(e.status)))return 'observed';
  if(current.some(e=>e.status==='unknown'||(!['completed','failed','interrupted'].includes(e.status)&&e.connection!=='connected')))return 'unknown';
  if(assigned.some(t=>t.status==='running')){const ended=current.find(e=>['completed','failed','interrupted'].includes(e.status));if(ended)return ended.status;}
  if(assigned.some(t=>t.status==='running'))return current.some(e=>e.status==='inProgress'&&e.connection==='connected')?'running':'starting';
  if(assigned.some(t=>t.status==='blocked'))return 'blocked';
  if(assigned.some(t=>t.status==='submitted'))return 'submitted';
  if(assigned.length&&assigned.every(t=>t.status==='cancelled'))return 'cancelled';
  if(assigned.length&&assigned.every(t=>['accepted','cancelled'].includes(t.status)))return 'accepted';
  return member.agentThreadId?(member.rosterVerified===false?'starting':'idle'):current.some(e=>e.threadId)?'idle':'planned';
}
export function orderedMembers(team,runs){
  return team.members.map((member,index)=>({member,index,state:memberState(member,team.tasks,runs),unfinished:memberHasWork(member,team.tasks),finishedAt:memberFinishedAt(member,team.tasks)}))
    .sort((a,b)=>Number(['running','starting','reserved'].includes(b.state))-Number(['running','starting','reserved'].includes(a.state))||Number(b.unfinished)-Number(a.unfinished)||b.finishedAt-a.finishedAt||a.index-b.index);
}
export function memberHasWork(member,tasks){return tasks.some(t=>t.memberId===member.id&&!['accepted','cancelled'].includes(t.status));}
export function memberFinishedAt(member,tasks){return Math.max(0,...tasks.filter(t=>t.memberId===member.id).flatMap(t=>(t.attempts??[]).map(a=>Date.parse(a.endedAt)||0)));}
export function dependencySatisfied(task,when){return when==='accepted'?task?.status==='accepted':['submitted','accepted'].includes(task?.status);}
export function taskRelationships(team,task){
  return {waiting:(task.dependencies??[]).filter(d=>!dependencySatisfied(team.tasks.find(t=>t.id===d.taskId),d.when)).map(d=>{
    const upstream=team.tasks.find(t=>t.id===d.taskId),member=team.members.find(m=>m.id===upstream?.memberId);
    return {...d,title:upstream?.title??'前置任务不存在',memberLabel:member?memberName(team,member):'未分配',status:upstream?.status??'unknown'};
  }),downstream:team.tasks.filter(t=>t.dependencies.some(d=>d.taskId===task.id)).map(t=>{const member=team.members.find(m=>m.id===t.memberId);return {id:t.id,title:t.title,memberLabel:member?memberName(team,member):'未分配',when:t.dependencies.find(d=>d.taskId===task.id).when};})};
}
export function memberWorkSummary(team,member,runs,readiness=[]){
  if(member.removedAt)return {taskId:null,kind:'removed',text:'岗位已移除，执行历史保留'};
  const tasks=team.tasks.filter(t=>t.memberId===member.id),running=tasks.find(t=>t.status==='running');
  if(running)return {taskId:running.id,kind:taskDisplayState(running,runs),text:running.title};
  const submitted=tasks.find(t=>t.status==='submitted');if(submitted)return {taskId:submitted.id,kind:'submitted',text:'已交付，等待独立审查和验收'};
  const pending=tasks.find(t=>!['accepted','cancelled'].includes(t.status));
  if(pending){const waiting=taskRelationships(team,pending).waiting;if(waiting.length)return {taskId:pending.id,kind:'waiting',text:waiting.map(d=>`等待 ${d.taskId}（${d.memberLabel}）${d.when==='accepted'?'验收':'提交'}`).join('；')};
    const blockers=readiness.find(r=>r.taskId===pending.id)?.blockers??[];return {taskId:pending.id,kind:pending.status==='blocked'?'blocked':'waiting',text:pending.blockReason||blockers.map(b=>b.message).join('；')||'已就绪，等待 Leader 派发'};}
  return {taskId:null,kind:memberState(member,team.tasks,runs),text:tasks.length?'本批任务已结束':'等待 Leader 分配任务'};
}
export function dependencyFamily(tasks,selected){
  const parents=new Set([selected]),children=new Set([selected]);
  for(let changed=true;changed;){changed=false;for(const task of tasks){if(parents.has(task.id))for(const d of task.dependencies)if(!parents.has(d.taskId)){parents.add(d.taskId);changed=true;}}}
  for(let changed=true;changed;){changed=false;for(const task of tasks)if(!children.has(task.id)&&task.dependencies.some(d=>children.has(d.taskId))){children.add(task.id);changed=true;}}
  return new Set([...parents,...children]);
}
