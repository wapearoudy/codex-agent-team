import {validatePlanReview} from './team-plan-review.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join,resolve,isAbsolute,win32 } from 'node:path';
import {DurableStore} from './durable-store.mjs';
import {validateMailbox} from './team-mailbox.mjs';
import {validateCheckpoints} from './team-checkpoints.mjs';
import {validateRoster,requiredRosterMembers} from './team-roster.mjs';
import {TeamArchive} from './team-archive.mjs';
import {TeamDocument} from './team-document.mjs';
import {validateQualityPlan,qualityBlockers} from './team-quality.mjs';
const now=()=>new Date().toISOString();
const allowedStatuses=new Set(['waiting','ready','running','submitted','accepted','blocked','cancelled']);

export function validatePlan(plan) {
  const {members,tasks}=plan;
  if(!Array.isArray(members)||members.filter(m=>!m.removedAt).length<1||members.filter(m=>!m.removedAt).length>8) throw new Error('A team plan needs 1–8 role-specific members');
  if(!Array.isArray(tasks)||tasks.length<1||tasks.filter(t=>t.kind!=='integration-review'&&!['accepted','cancelled'].includes(t.status)).length>40||tasks.filter(t=>t.kind==='integration-review').length>1) throw new Error('A plan needs at most 40 unfinished tasks plus at most one final integration review');
  const memberIds=new Set();
  for(const m of members){
    if(!m||typeof m.id!=='string'||!m.id||memberIds.has(m.id)) throw new Error('Member IDs must be unique');
    memberIds.add(m.id);
    for(const field of ['role','responsibility','reason']) if(typeof m[field]!=='string'||!m[field].trim()) throw new Error(`Member ${field} is required`);
    if(!Array.isArray(m.writeScopes)||m.writeScopes.some(p=>typeof p!=='string'||!p||isAbsolute(p)||win32.isAbsolute(p)||/[:*?\0]/.test(p)||p.split(/[\\/]/).some(s=>s==='..'||s==='.git'||s==='.codex'))) throw new Error('Member write scopes must be safe project-relative paths');
  }
  const taskIds=new Set();
  for(const t of tasks){
    if(!t||typeof t.id!=='string'||!t.id||taskIds.has(t.id)) throw new Error('Task IDs must be unique'); taskIds.add(t.id);
    for(const f of ['title','goal','acceptance']) if(typeof t[f]!=='string'||!t[f].trim()) throw new Error(`Task ${f} is required`);
    if(!memberIds.has(t.memberId)) throw new Error(`Task ${t.id} has no valid member`);
    if(members.find(m=>m.id===t.memberId).removedAt&&!['accepted','cancelled'].includes(t.status))throw new Error('Unfinished tasks cannot belong to removed members');
    if(t.validationMode!==undefined&&!['execute','source-only'].includes(t.validationMode))throw new Error('Invalid task validation mode');
    if(t.acceptanceCriteria!==undefined&&(!Array.isArray(t.acceptanceCriteria)||!t.acceptanceCriteria.length||t.acceptanceCriteria.length>30||t.acceptanceCriteria.some(c=>!c||typeof c.id!=='string'||!c.id.trim()||typeof c.description!=='string'||!c.description.trim())||new Set(t.acceptanceCriteria.map(c=>c.id)).size!==t.acceptanceCriteria.length))throw new Error('Acceptance criteria need unique IDs and descriptions');
    if(t.timeoutSeconds!==undefined&&(!Number.isInteger(t.timeoutSeconds)||t.timeoutSeconds<60||t.timeoutSeconds>7200))throw new Error('Task timeout must be 60–7200 seconds');
    if(t.kind==='review'&&typeof t.reviewOfTaskId!=='string')throw new Error(`Review task ${t.id} must identify its implementation task`);
    if(!Array.isArray(t.dependencies)||t.dependencies.some(d=>!d||typeof d.taskId!=='string'||!['submitted','accepted'].includes(d.when))) throw new Error(`Task ${t.id} has invalid dependencies`);
  }
  for(const t of tasks) for(const d of t.dependencies) if(!taskIds.has(d.taskId)||d.taskId===t.id) throw new Error(`Task ${t.id} references a missing or self dependency`);
  for(const t of tasks) if(t.kind==='review'&&(!taskIds.has(t.reviewOfTaskId)||t.reviewOfTaskId===t.id))throw new Error(`Review task ${t.id} references a missing target`);
  for(const t of tasks)if(t.kind==='review'){
    const target=tasks.find(x=>x.id===t.reviewOfTaskId);
    if(target.kind==='review')throw new Error('Review must target a deliverable task');
    if(target.memberId===t.memberId)throw new Error('A member cannot be the sole reviewer of its own work');
    if(!t.dependencies.some(d=>d.taskId===target.id&&d.when==='submitted'))throw new Error('Independent review must depend on the submitted implementation');
  }
  for(const t of tasks)if(['review','integration-review'].includes(t.kind)&&members.find(m=>m.id===t.memberId).writeScopes.length)throw new Error('Independent reviewers must be read-only');
  for(const t of tasks){if(new Set(t.dependencies.map(d=>d.taskId)).size!==t.dependencies.length)throw new Error('Duplicate dependency');if(t.parentTaskId){const seen=new Set([t.id]);let parent=t.parentTaskId;while(parent){if(seen.has(parent))throw new Error('Parent task cycle');seen.add(parent);const row=tasks.find(x=>x.id===parent);if(!row)throw new Error('Missing parent task');parent=row.parentTaskId;}}}
  const visiting=new Set(),visited=new Set(),byId=new Map(tasks.map(t=>[t.id,t]));
  function visit(id){if(visiting.has(id))throw new Error('Task dependencies contain a cycle');if(visited.has(id))return;visiting.add(id);for(const d of byId.get(id).dependencies)visit(d.taskId);visiting.delete(id);visited.add(id);}
  for(const t of tasks)visit(t.id);
  validateQualityPlan(plan);
  return true;
}

export function createTeam({projectId,projectPath,goal,plan,maxParallel=3}) {
  validatePlan(plan);
  if(typeof projectId!=='string'||!projectId||typeof projectPath!=='string'||!projectPath)throw new Error('A selected project is required');
  if(typeof goal!=='string'||goal.trim().length<8||goal.length>2000)throw new Error('Describe a specific team goal (8–2000 characters)');
  if(!Number.isInteger(maxParallel)||maxParallel<1||maxParallel>8)throw new Error('Parallel member limit must be 1–8');
  const time=now(),members=plan.members.map(m=>({...structuredClone(m),status:'planned',agentThreadId:null,lastActivityAt:time}));
  return {id:randomUUID(),projectId,projectPath,goal:goal.trim(),state:'planned',dispatchPaused:false,maxParallel,
    ...(plan.goalCriteria||plan.tasks.some(t=>t.contract)?{requiresTeamWorkspaceVersion:'0.10.0'}:{}),
    ...(plan.goalCriteria?{goalCriteria:structuredClone(plan.goalCriteria)}:{}),createdAt:time,updatedAt:time,members,tasks:plan.tasks.map(t=>({...structuredClone(t),status:'waiting',attempt:0,attempts:[],evidence:[],blockReason:null,createdAt:time,updatedAt:time})),events:[{at:time,type:'team-planned'}]};
}

function addEvent(team,type,details={}){const at=now();team.updatedAt=at;team.events.push({at,type,...details});if(team.mode!=='host-leader')team.events=team.events.slice(-500);}
function dependenciesReady(team,task){return task.dependencies.every(d=>{const pre=team.tasks.find(t=>t.id===d.taskId);return d.when==='submitted'?['submitted','accepted'].includes(pre.status):pre.status==='accepted';});}
function conflict(a,b){const normalize=p=>p.replaceAll('\\','/').replace(/\/$/,'').toLowerCase();const A=(a.writeScopes??[]).map(normalize),B=(b.writeScopes??[]).map(normalize);if(A.length&&B.length&&a.workspace?.mode==='git-worktree'&&b.workspace?.mode==='git-worktree'&&a.workspace.path!==b.workspace.path)return false;if(!A.length&&!B.length)return false;return !A.length||!B.length||A.some(x=>B.some(y=>x==='.'||y==='.'||x===y||x.startsWith(y+'/')||y.startsWith(x+'/')));}

export function consumedAttempts(task){return task.attempts?.length?task.attempts.filter(a=>a.state!=='released').length:task.attempt??0;}
export function dispatchBlockers(team,task){
  const reasons=[],add=(code,message,taskId)=>reasons.push({code,message,...(taskId?{taskId}:{})});
  if(task.status!=='waiting')add('task-state',`任务当前为 ${task.status}，不能重复派发`);
  if(requiredRosterMembers(team,[task.id]).some(m=>!m.agentThreadId||!m.rosterVerified))add('member-initialization','请先完成负责岗位及初始团队成员的原生初始化与绑定');
  if(team.planReview?.scope==='initial'&&team.planReview.status!=='approved')add('plan-approval','请先确认当前版本的团队计划');
  if(team.dispatchPaused)add('paused','Leader 已暂停新任务派发');
  reasons.push(...qualityBlockers(team,task));
  if(consumedAttempts(task)>=(team.policy?.maxAttempts??3))add('attempt-limit',`已达到 ${team.policy?.maxAttempts??3} 次实际执行/预留上限，保留历史等待 Leader 调整范围`);
  for(const d of task.dependencies){const pre=team.tasks.find(t=>t.id===d.taskId);if(!(d.when==='submitted'?['submitted','accepted'].includes(pre?.status):pre?.status==='accepted'))add('dependency',`等待 ${d.taskId} ${d.when==='accepted'?'验收':'提交'}`,d.taskId);}
  const member=team.members.find(m=>m.id===task.memberId),active=team.tasks.filter(t=>t.status==='running'&&t.id!==task.id);
  if(!member||!['planned','idle'].includes(member.status))add('member-busy','负责成员尚未空闲');
  if(active.length>=team.maxParallel)add('parallel-limit','团队并发名额已满');
  for(const other of active){
    if((other.resources??[]).some(r=>(task.resources??[]).includes(r)))add('resource',`与 ${other.id} 使用同一共享资源`,other.id);
    const owner=team.members.find(m=>m.id===other.memberId);
    if(member&&owner&&conflict(member,owner))add('write-conflict',`等待 ${other.id} 释放写入/独立审查范围`,other.id);
  }
  return reasons;
}

export function readyTasks(team){
  return team.tasks.filter(t=>t.status==='waiting'&&dependenciesReady(team,t)&&!team.dispatchPaused)
    .sort((a,b)=>(a.priority??3)-(b.priority??3)||a.createdAt.localeCompare(b.createdAt));
}
export function schedule(team){
  if(team.dispatchPaused)return [];
  const active=team.tasks.filter(t=>t.status==='running'),slots=Math.max(0,team.maxParallel-active.length),selected=[];
  for(const task of readyTasks(team)){
    if(consumedAttempts(task)>=(team.policy?.maxAttempts??3)){task.status='blocked';task.blockReason=`Task attempt limit reached (${team.policy?.maxAttempts??3}); history and budget are retained`;continue;}
    if(selected.length>=slots)break;
    const member=team.members.find(m=>m.id===task.memberId);
    if(dispatchBlockers(team,task).length)continue;
    const attempt={id:randomUUID(),memberId:task.memberId,number:task.attempt+1,state:'running',agentThreadId:null,startedAt:now(),endedAt:null,summary:null,
      dependencyAttempts:task.dependencies.map(d=>({taskId:d.taskId,attemptId:team.tasks.find(t=>t.id===d.taskId).attempts.at(-1)?.id??null}))};
    task.attempt++;task.status='running';task.blockReason=null;task.attempts.push(attempt);task.updatedAt=now();
    member.status='starting';member.lastActivityAt=now();selected.push(task);addEvent(team,'task-dispatched',{taskId:task.id,attemptId:attempt.id,memberId:member.id});
  }
  return selected;
}
export function pauseDispatch(team){team.dispatchPaused=true;addEvent(team,'dispatch-paused');}
export function resumeDispatch(team){team.dispatchPaused=false;addEvent(team,'dispatch-resumed');return schedule(team);}
function currentAttempt(task,attemptId){if(!task||!attemptId||task.attempts.at(-1)?.id!==attemptId)throw new Error('Stale or missing task attempt; refusing late result');return task.attempts.at(-1);}
export function bindMemberThread(team,taskId,threadId,attemptId){const t=team.tasks.find(x=>x.id===taskId);const a=currentAttempt(t,attemptId);if(t.status!=='running')throw new Error('Task has no active attempt');if(typeof threadId!=='string'||!threadId)throw new Error('Actual thread ID required');if(a.agentThreadId&&a.agentThreadId!==threadId)throw new Error('Attempt already bound to a different thread');const m=team.members.find(x=>x.id===t.memberId);a.agentThreadId=threadId;m.agentThreadId=threadId;m.status='running';m.lastActivityAt=now();addEvent(team,'member-thread-bound',{taskId,attemptId:a.id,memberId:m.id,threadId});}
export function submitTask(team,taskId,{attemptId,summary,evidence=[]}){const t=team.tasks.find(x=>x.id===taskId);currentAttempt(t,attemptId);if(t.status!=='running')throw new Error('Only a running task can be submitted');if(typeof summary!=='string'||!summary.trim()||!Array.isArray(evidence))throw new Error('A summary and evidence list are required');t.status='submitted';t.evidence.push({attempt:t.attempt,attemptId,summary:summary.trim(),references:structuredClone(evidence),at:now()});t.attempts.at(-1).state='submitted';t.attempts.at(-1).endedAt=now();t.attempts.at(-1).summary=summary.trim();t.updatedAt=now();const m=team.members.find(x=>x.id===t.memberId);m.status='idle';m.lastActivityAt=now();addEvent(team,'task-submitted',{taskId,attempt:t.attempt});return t;}
export function reviewTask(team,reviewTaskId,{attemptId,decision,note}){
  const review=team.tasks.find(x=>x.id===reviewTaskId);
  const reviewAttempt=currentAttempt(review,attemptId);
  if(!review||review.status!=='submitted'||review.kind!=='review')throw new Error('A submitted independent review task is required');
  const target=team.tasks.find(x=>x.id===review.reviewOfTaskId);
  if(!target||target.status!=='submitted')throw new Error('The reviewed implementation is not awaiting review');
  if(reviewAttempt.dependencyAttempts.find(d=>d.taskId===target.id)?.attemptId!==target.attempts.at(-1)?.id)throw new Error('Review targets an outdated implementation attempt');
  if(!['accept','rework'].includes(decision)||typeof note!=='string'||!note.trim())throw new Error('Review needs a decision and reason');
  const affected=new Set(),queue=[target.id];
  if(decision==='rework')while(queue.length){const parent=queue.shift();for(const down of team.tasks){if(down.dependencies.some(d=>d.taskId===parent)&&!affected.has(down.id)){if(down.status==='running')throw new Error(`Cannot invalidate running downstream task ${down.id}`);affected.add(down.id);queue.push(down.id);}}}
  review.attempts.at(-1).review={decision,note:note.trim(),at:now()};review.updatedAt=now();review.status=decision==='accept'?'accepted':'waiting';
  target.attempts.at(-1).review={decision,note:note.trim(),reviewTaskId:review.id,at:now()};target.updatedAt=now();
  if(decision==='accept'){target.status='accepted';addEvent(team,'task-accepted',{taskId:target.id,reviewTaskId,attempt:target.attempt});return [];}
  target.status='waiting';target.blockReason='Independent review requested rework';
  for(const id of affected){const down=team.tasks.find(x=>x.id===id);if(['accepted','submitted','blocked'].includes(down.status)){down.status='waiting';down.blockReason=`Upstream task ${target.id} returned for rework; previous evidence retained`;down.updatedAt=now();}}
  addEvent(team,'task-rework-requested',{taskId:target.id,reviewTaskId,attempt:target.attempt,invalidatedTaskIds:[...affected]});return [...affected];
}
export function validateTeam(team){if(team.requiresTeamWorkspaceVersion&&!['0.10.0','0.11.0'].includes(team.requiresTeamWorkspaceVersion))throw new Error('Unsupported Team Workspace version; preserve data and upgrade');validatePlanReview(team);validatePlan(team);for(const t of team.tasks)if(!allowedStatuses.has(t.status))throw new Error(`Invalid task status: ${t.status}`);validateMailbox(team);validateCheckpoints(team);validateRoster(team);return true;}

export class TeamStore {
  constructor(root=join(homedir(),'.codex','team-workspace','teams')){this.root=resolve(root);this.archive=new TeamArchive(join(this.root,'archives'));}
  ownerId(hostThreadId){if(typeof hostThreadId!=='string'||!hostThreadId)throw new Error('Current Desktop conversation is required');return createHash('sha256').update(hostThreadId).digest('hex');}
  path(id){if(!/^[0-9a-f-]{36}$/i.test(id))throw new Error('Invalid team ID');return join(this.root,`${id}.json`);}
  document(id){return new TeamDocument(this.path(id),this.archive,validateTeam);}
  async create(input,owner){const team=createTeam(input);team.ownerId=owner;team.revision=1;const saved=team.requiresTeamWorkspaceVersion?await this.archive.compact(team):team;await this.document(team.id).transaction(d=>{if(d.id)throw new Error('Team already exists');Object.assign(d,saved);});return team;}
  async get(id,owner){const saved=await this.document(id).read();if(saved.ownerId!==owner)throw new Error('Team not found in this Desktop conversation');const team=await this.archive.hydrate(saved);validateTeam(team);return team;}
  async list(owner){let names;try{names=await readdir(this.root);}catch(e){if(e.code==='ENOENT')return[];throw e;}const rows=[];const ids=[...new Set(names.filter(n=>/^[0-9a-f-]{36}(?:\.v2)?\.json$/i.test(n)).map(n=>n.replace(/(?:\.v2)?\.json$/,'')))];for(const tid of ids){const saved=await this.document(tid).read();if(saved.ownerId===owner){const row=await this.archive.hydrate(saved);validateTeam(row);rows.push(row);}}return rows.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
  async update(id,owner,expectedRevision,mutate){return this.document(id).transaction(async saved=>{if(saved.ownerId!==owner)throw new Error('Team not found in this Desktop conversation');if(saved.revision!==expectedRevision)throw new Error('Team changed in another Desktop window; refresh the board before retrying');const team=await this.archive.hydrate(structuredClone(saved));validateTeam(team);const result=await mutate(team);team.revision++;team.updatedAt=now();validateTeam(team);const compact=await this.archive.compact(team);for(const key of Object.keys(saved))delete saved[key];Object.assign(saved,compact);return{team,result};});}
}
