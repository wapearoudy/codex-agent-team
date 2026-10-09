import {createHash} from 'node:crypto';
import {assertPlanMutable} from './team-plan-review.mjs';
import {requireTeamVersion} from './team-version.mjs';

const sources=new Set(['panel-user-action','leader-recorded-user-instruction']);
export const memberGoalSnapshot=member=>({revision:member.goalRevision??1,goal:member.responsibility});
export function memberGoalRequest(team,input){
  assertPlanMutable(team);
  if(!team.fixedRoster||team.mode!=='host-leader'||team.state==='cancelled')throw new Error('只有已组建的当前原生团队可以调整角色目标');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId??''))throw new Error('角色目标修改需要稳定的 UUID');
  if(typeof input.goal!=='string'||!input.goal.trim()||input.goal.length>2000)throw new Error('角色目标需要 1–2000 个字符');
  if(!Number.isInteger(input.goalRevision)||input.goalRevision<1)throw new Error('请先读取角色目标的当前版本');
  if(typeof input.note!=='string'||!input.note.trim()||input.note.length>1000||!sources.has(input.source))throw new Error('角色目标修改需要有效的来源和说明');
  const payload={memberId:input.memberId,goal:input.goal.trim(),goalRevision:input.goalRevision,note:input.note.trim(),source:input.source};
  const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex'),prior=team.memberGoalChanges?.find(r=>r.requestId===input.requestId);
  if(prior&&prior.hash!==hash)throw new Error('目标修改 requestId 已用于其他内容');
  if(prior)return {hash,prior,payload};
  const member=team.members.find(m=>m.id===input.memberId&&!m.removedAt);
  if(!member)throw new Error('当前角色不存在或已移除');
  if((member.goalRevision??1)!==input.goalRevision)throw new Error('角色目标已被其他操作修改，请重新读取后再保存');
  if(member.responsibility===payload.goal)throw new Error('角色目标没有变化');
  if((team.memberGoalChanges?.length??0)>=200)throw new Error('角色目标修订已达历史上限，请保留记录并明确重建团队');
  return {hash,payload,member};
}
export function changeMemberGoal(team,input){
  const request=memberGoalRequest(team,input);if(request.prior)return {...request.prior,replayed:true};
  const {member,payload,hash}=request,previous=memberGoalSnapshot(member),at=new Date().toISOString();
  // Capture existing attempts before changing the role. Repeated reservations
  // and historical packets must keep their previously issued instructions.
  for(const task of team.tasks)for(const attempt of task.attempts??[])if((attempt.memberId??task.memberId)===member.id&&!attempt.memberGoalSnapshot)
    attempt.memberGoalSnapshot={...previous,source:'captured-before-role-goal-edit'};
  member.responsibility=payload.goal;member.goalRevision=previous.revision+1;member.goalUpdatedAt=at;
  const row={requestId:input.requestId,hash,memberId:member.id,previous,next:memberGoalSnapshot(member),note:payload.note,source:payload.source,at,effect:'next-dispatch'};
  (team.memberGoalChanges??=[]).push(row);team.events.push({at,type:'member-goal-updated',memberId:member.id,goalRevision:member.goalRevision,requestId:input.requestId});
  requireTeamVersion(team,'0.15.0');return {...row,replayed:false};
}
export function memberGoalDetail(team,memberId,{historyLimit=10}={}){
  const member=team.members.find(m=>m.id===memberId);if(!member)throw new Error('角色不存在');
  return {kind:'team-member-goal',teamId:team.id,revision:team.revision,memberId,role:member.role,goalRevision:member.goalRevision??1,goal:member.responsibility,updatedAt:member.goalUpdatedAt??null,removed:!!member.removedAt,
    effect:'next-dispatch',history:historyLimit?(team.memberGoalChanges??[]).filter(r=>r.memberId===memberId).slice(-historyLimit).map(({hash,...row})=>row):[]};
}
export function validateMemberGoals(team){
  if(team.memberGoalChanges===undefined&&!team.members.some(m=>m.goalRevision))return;
  if(!['0.15.0','0.16.0','0.17.0'].includes(team.requiresTeamWorkspaceVersion)||!Array.isArray(team.memberGoalChanges)||team.memberGoalChanges.length>200)throw new Error('角色目标修订需要 Team Workspace 0.15.0');
  const ids=new Set();
  for(const member of team.members){let revision=1,goal;
    for(const row of team.memberGoalChanges.filter(r=>r.memberId===member.id)){
      if(ids.has(row.requestId)||!row.requestId||!/^[a-f0-9]{64}$/.test(row.hash??'')||row.previous?.revision!==revision||row.next?.revision!==revision+1||typeof row.previous.goal!=='string'||typeof row.next?.goal!=='string'||!row.next.goal.trim()||row.next.goal.length>2000||goal!==undefined&&row.previous.goal!==goal||!sources.has(row.source)||row.effect!=='next-dispatch'||typeof row.note!=='string'||!row.note.trim()||row.note.length>1000||!Number.isFinite(Date.parse(row.at)))throw new Error('角色目标修订历史不连续或无效');
      const payload={memberId:row.memberId,goal:row.next.goal,goalRevision:row.previous.revision,note:row.note,source:row.source};
      if(createHash('sha256').update(JSON.stringify(payload)).digest('hex')!==row.hash)throw new Error('角色目标修订校验失败');
      ids.add(row.requestId);revision++;goal=row.next.goal;
    }
    if((member.goalRevision??1)!==revision||goal!==undefined&&member.responsibility!==goal)throw new Error('当前角色目标与修订记录不一致');
  }
  if(ids.size!==team.memberGoalChanges.length)throw new Error('目标修订引用了不存在的角色');
  for(const task of team.tasks)for(const attempt of task.attempts??[]){const snapshot=attempt.memberGoalSnapshot;if(snapshot){const member=team.members.find(m=>m.id===(attempt.memberId??task.memberId)),changes=team.memberGoalChanges.filter(r=>r.memberId===member?.id),expected=snapshot.revision===1?(changes[0]?.previous.goal??member?.responsibility):changes.find(r=>r.next.revision===snapshot.revision)?.next.goal;if(!member||!Number.isInteger(snapshot.revision)||snapshot.revision<1||snapshot.revision>(member.goalRevision??1)||snapshot.goal!==expected||!['task-reservation','captured-before-role-goal-edit'].includes(snapshot.source))throw new Error('任务的角色目标快照无效');}}
}
