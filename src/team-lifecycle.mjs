import {createHash} from 'node:crypto';

const now=()=>new Date().toISOString();
export function lifecycleRequest(team,requestId,payload){
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId??''))throw new Error('A stable UUID request ID is required');
  if(!team.fixedRoster||team.state==='superseded')throw new Error('Member lifecycle changes require the current fixed native roster');
  const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex'),prior=team.memberChanges?.find(r=>r.requestId===requestId);
  if(prior&&prior.hash!==hash)throw new Error('Member change request ID already has different contents');
  if(!prior&&(team.memberChanges?.length??0)>=200)throw new Error('Member change history is full; preserve history and rebuild explicitly');
  return {hash,prior};
}
export function reassignTask(team,{taskId,memberId,note}){
  if(team.state==='delivered')throw new Error('Delivered work needs a new scoped task');
  const task=team.tasks.find(t=>t.id===taskId),member=team.members.find(m=>m.id===memberId&&!m.removedAt);
  if(!task||!member)throw new Error('Task or active destination member not found');
  if(!['waiting','blocked'].includes(task.status)||task.supersededBy)throw new Error('Stop and settle running attempts, then request explicit rework before reassignment; submitted/accepted evidence cannot change owner');
  if(task.memberId===memberId)throw new Error('Task already belongs to this member');
  const fromMemberId=task.memberId;
  team.requiresTeamWorkspaceVersion='0.10.0';
  // Materialize old ownership before moving the task, including pre-0.10 rows.
  for(const a of task.attempts??[])a.memberId??=fromMemberId;
  task.memberId=memberId;task.status='waiting';task.blockReason=null;task.updatedAt=now();
  (task.history??=[]).push({at:task.updatedAt,type:'task-reassigned',fromMemberId,toMemberId:memberId,note});
  team.events.push({at:task.updatedAt,type:'task-reassigned',taskId,fromMemberId,toMemberId:memberId,note});
  return {type:'reassign',taskId,fromMemberId,memberId};
}
export function removeMember(team,{memberId,note}){
  const member=team.members.find(m=>m.id===memberId&&!m.removedAt);
  if(!member)throw new Error('Active member not found');
  if(team.members.filter(m=>!m.removedAt).length<=1)throw new Error('Keep at least one active member');
  if(team.tasks.some(t=>t.memberId===memberId&&!['accepted','cancelled'].includes(t.status)))throw new Error('Reassign or finish every unfinished task before removing the member');
  if(member.agentThreadId&&!member.rosterVerified)throw new Error('Member initialization is not confirmed terminal; stop and verify it before removal');
  member.removedAt=now();member.status='removed';member.removalNote=note;
  team.requiresTeamWorkspaceVersion='0.10.0';
  team.events.push({at:member.removedAt,type:'member-removed',memberId,note});
  return {type:'remove',memberId,threadId:member.agentThreadId??null};
}
export async function verifyQuiescence(team,member,observer,{task}={}){
  if(task?.status==='running')throw new Error('Stop and settle the active native attempt before reassignment');
  const attempts=(task?[task]:team.tasks).flatMap(t=>(t.attempts??[]).filter(a=>(a.memberId??t.memberId)===member.id).map(a=>({a,task:t}))).filter(({a})=>a.agentThreadId&&a.state!=='released');
  if(task?.attempts.at(-1)?.state==='reserved')throw new Error('Release the unbound reservation only after verifying no member was launched');
  if(!member.agentThreadId)return;
  const last=attempts.sort((x,y)=>Date.parse(x.a.startedAt)-Date.parse(y.a.startedAt)).at(-1)?.a;
  const marker=last?.marker??member.rosterMarker;
  if(!marker)throw new Error('Member has no verifiable native identity');
  const run=await observer.inspect(team.leaderThreadId,team.projectPath,member.agentThreadId,marker,{requireIdle:true});
  if(!run.turnId||!['completed','failed','interrupted'].includes(run.status)||last?.turnId&&run.turnId!==last.turnId)throw new Error('Native member is not confirmed terminal; preserve ownership and verify the existing member');
}
