import {requireTeamVersion} from './team-version.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {normalizePolicy} from './team-policy.mjs';

const pick=(o,keys)=>Object.fromEntries(keys.filter(k=>o?.[k]!==undefined).map(k=>[k,structuredClone(o[k])]));
const memberKeys=['id','role','responsibility','reason','writeScopes','route','routeSnapshot','fallbackRoute'];
const taskKeys=['id','title','goal','context','acceptance','acceptanceCriteria','contract','memberId','priority','kind','validationMode','reviewOfTaskId','parentTaskId','resources','dependencies'];
const now=()=>new Date().toISOString();
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
export const planHash=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export function planConfiguration(team){return {...(team.taskPlanning?{taskPlanning:team.taskPlanning}:{}),...(team.memberStartup?{memberStartup:team.memberStartup}:{}),goal:team.goal,plan:{members:team.members.filter(m=>!m.removedAt).map(m=>pick(m,memberKeys)),...(team.taskPlanning==='leader'?{}:{tasks:team.tasks.map(t=>pick(t,taskKeys))}),...(team.goalCriteria?{goalCriteria:structuredClone(team.goalCriteria)}:{})},maxParallel:team.maxParallel,policy:normalizePolicy(team.policy)};}
export function assertPlanExecutable(team){if(team.planReview?.scope==='initial'&&team.planReview.status!=='approved')throw new Error('Plan approval is required before initializing members or dispatching tasks');}
export function assertPlanMutable(team){if(['superseded','archived'].includes(team.state))throw new Error('Historical team is read-only');if(team.planReview?.scope==='initial'&&team.planReview.status!=='approved')throw new Error('Use revise_team_plan or cancel_team_plan for this unapproved draft');}
export function planReviewSummary(team){const p=team.planReview;if(!p)return undefined;return pick(p,['status','scope','confirmation','version','hash','mode','reason','brief','approval','cancelledAt','updatedAt','feedback']);}
function recordVersion(team,p,configuration){team.planHistory??=[];team.planHistory.push({version:p.version,hash:p.hash,scope:p.scope,at:now(),configuration:structuredClone(configuration)});team.planHistory=team.planHistory.slice(-20);}
export function setPlanReview(team,{mode='auto',execute=false,executionAuthorization,brief=''}={}){
  if(!['auto','required','immediate'].includes(mode))throw new Error('Unknown approval mode');
  if(mode==='immediate'&&!executionAuthorization?.trim())throw new Error('Immediate execution requires the user’s explicit execution instruction');
  const complex=!!team.goalCriteria||team.tasks.some(t=>t.contract)||team.members.filter(m=>m.writeScopes.length).length>1||team.tasks.filter(t=>t.kind!=='review').length>=3||team.members.length>=4;
  const formation=team.taskPlanning==='leader';
  const pending=!execute||mode==='required'||mode==='auto'&&(formation||complex);
  const configuration=planConfiguration(team),at=now();
  requireTeamVersion(team,'0.11.0');
  team.planReview={status:pending?'pending':'approved',scope:'initial',...(formation?{confirmation:'team'}:{}),version:1,hash:planHash(configuration),mode,brief,reason:formation&&pending?'先确认团队成员、职责和目标；具体任务由 Leader 在确认后拆分':!execute?'仅制定计划，等待用户确认':mode==='required'?'用户要求先确认计划':complex&&mode!=='immediate'?'复杂新团队，先确认目标、分工和验收':'沿用用户的执行授权',updatedAt:at,...(!pending?{approval:{source:mode==='immediate'?'leader-recorded-explicit-instruction':'existing-task-authorization',note:executionAuthorization??'用户已要求执行此项工作',at,version:1,hash:planHash(configuration)}}:{})};
  team.dispatchPaused=pending;team.state=pending?'planned':'active';recordVersion(team,team.planReview,configuration);
}
export function editablePlan(team){const p=team.planReview;if(!p)throw new Error('This legacy team has no plan review; keep its existing authorization');return {kind:'team-plan',teamId:team.id,revision:team.revision,review:planReviewSummary(team),configuration:p.status==='pending'?(p.scope==='expansion'?structuredClone(p.pending??{}):planConfiguration(team)):structuredClone(team.planHistory?.findLast(h=>h.version===p.version&&h.hash===p.hash)?.configuration??planConfiguration(team)),history:(team.planHistory??[]).map(h=>pick(h,['version','hash','scope','at']))};}
export function updateDraft(team,configuration,brief){
  if(['superseded','archived'].includes(team.state))throw new Error('Historical team is read-only');
  const p=team.planReview;if(p?.status!=='pending'||p.scope!=='initial'||team.members.some(m=>m.agentThreadId)||team.tasks.some(t=>t.attempts.length))throw new Error('Only an unstarted pending initial plan may be revised');
  if(typeof configuration.goal!=='string'||configuration.goal.trim().length<8||configuration.goal.length>2000)throw new Error('Describe a specific goal (8–2000 characters)');
  if(!Number.isInteger(configuration.maxParallel)||configuration.maxParallel<1||configuration.maxParallel>8)throw new Error('Parallel member limit must be 1–8');
  const at=now(),old=new Map(team.members.map(m=>[m.id,m]));
  if(configuration.taskPlanning==='leader'){if(configuration.plan.tasks?.length)throw new Error('Team formation does not confirm concrete tasks');team.taskPlanning='leader';p.confirmation='team';requireTeamVersion(team,'0.18.0');}
  if(team.taskPlanning==='leader'&&configuration.plan.tasks?.length)throw new Error('Add tasks only after team formation approval');
  if(configuration.memberStartup){team.memberStartup=configuration.memberStartup;requireTeamVersion(team,'0.12.0');}
  team.goal=configuration.goal.trim();team.maxParallel=configuration.maxParallel;team.policy=normalizePolicy(configuration.policy);
  if(configuration.plan.goalCriteria)team.goalCriteria=structuredClone(configuration.plan.goalCriteria);else delete team.goalCriteria;
  team.members=configuration.plan.members.map(m=>({...pick(m,memberKeys),status:'planned',agentThreadId:null,rosterMarker:old.get(m.id)?.rosterMarker??`TEAM_WORKSPACE_MEMBER:${randomUUID()}`,rosterVerified:false,lastActivityAt:at}));
  team.tasks=(configuration.plan.tasks??[]).map(t=>({...pick(t,taskKeys),status:'waiting',attempt:0,attempts:[],evidence:[],blockReason:null,createdAt:at,updatedAt:at}));
  p.version++;p.hash=planHash(planConfiguration(team));p.brief=brief??p.brief;p.updatedAt=at;delete p.approval;delete p.feedback;recordVersion(team,p,planConfiguration(team));
}
export function requestPlanFeedback(team,input){
  const p=team.planReview;
  if(['superseded','archived'].includes(team.state)||p?.status!=='pending'||p.version!==input.planVersion||p.hash!==input.planHash)throw new Error('Plan version changed; refresh before returning to chat');
  if(!/^[0-9a-f-]{36}$/i.test(input.requestId??'')||!input.note?.trim())throw new Error('Plan feedback needs a stable UUID and a note');
  if(p.feedback?.requestId===input.requestId){if(p.feedback.note!==input.note)throw new Error('Feedback request ID already has different contents');return p.feedback;}
  p.feedback={requestId:input.requestId,note:input.note,version:p.version,at:now(),status:'awaiting-user-feedback'};
  requireTeamVersion(team,'0.13.0');team.events.push({at:now(),type:'plan-feedback-requested',version:p.version});return p.feedback;
}
export function adoptExistingAuthorization(team){
  if(team.planReview)return;const configuration=planConfiguration(team),at=now();requireTeamVersion(team,'0.11.0');
  team.planReview={status:'approved',scope:'initial',version:1,hash:planHash(configuration),mode:'auto',reason:'沿用升级前团队已获得的任务授权',brief:'',updatedAt:at,approval:{source:'existing-team-authorization',note:'仅记录既有团队授权；新增范围仍须单独确认',version:1,hash:planHash(configuration),at}};recordVersion(team,team.planReview,configuration);
}
export function stageExpansion(team,change,brief=''){
  assertPlanMutable(team);adoptExistingAuthorization(team);const previous=team.planReview;
  const pending=previous.scope==='expansion'&&previous.status==='pending'?structuredClone(previous.pending):{members:[],tasks:[]};
  pending.members.push(...(change.members??[]).map(m=>pick(m,memberKeys)));pending.tasks.push(...(change.tasks??[]).map(t=>pick(t,taskKeys)));
  if(change.policy)pending.policy=normalizePolicy({...pending.policy??team.policy,...change.policy});
  if(change.maxParallel!==undefined)pending.maxParallel=change.maxParallel;
  team.planReview={status:'pending',scope:'expansion',version:previous.version+1,hash:planHash(pending),mode:'required',reason:'新增岗位、扩大范围或提高执行预算',brief,pending,updatedAt:now(),previousApproval:previous.approval??previous.previousApproval};
  requireTeamVersion(team,'0.11.0');recordVersion(team,team.planReview,pending);return true;
}
export function expansionCandidate(team){const p=team.planReview?.pending??{};return {...team,members:[...team.members,...(p.members??[])],tasks:[...team.tasks,...(p.tasks??[])],maxParallel:p.maxParallel??team.maxParallel};}
export function policyExpands(before,after){const a=normalizePolicy(before),b=normalizePolicy(after);return a.tokenLimit!==null&&(b.tokenLimit===null||b.tokenLimit>a.tokenLimit)||b.maxAttempts>a.maxAttempts||b.maxReviewRounds>a.maxReviewRounds||b.contextChars>a.contextChars||!a.autoRepair&&b.autoRepair||a.requireKnownUsage&&!b.requireKnownUsage;}
export function reviewRequest(team,input,action){
  if(['superseded','archived'].includes(team.state))throw new Error('Historical team is read-only');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId??''))throw new Error('A stable UUID request ID is required');
  const hash=planHash({action,version:input.planVersion,hash:input.planHash,note:input.note,source:input.source??'leader-recorded-user-confirmation'}),saved=team.planDecisions?.find(r=>r.requestId===input.requestId);
  if(saved&&saved.hash!==hash)throw new Error('Plan decision request ID already has different contents');
  if(saved)return {saved,hash};
  const p=team.planReview;if(p?.status!=='pending'||p.version!==input.planVersion||p.hash!==input.planHash)throw new Error('Plan version changed or is no longer pending; refresh and review the current version');
  if(!input.note?.trim())throw new Error('Record the user’s explicit confirmation or cancellation');
  return {hash};
}
export function finishPlanDecision(team,input,action,hash){const p=team.planReview,at=now();p.status=action==='approve'?'approved':'cancelled';p.updatedAt=at;if(action==='approve')p.approval={source:input.source??'leader-recorded-user-confirmation',note:input.note,version:p.version,hash:p.hash,at};else p.cancelledAt=at;delete p.pending;team.planDecisions??=[];team.planDecisions.push({requestId:input.requestId,hash,action,version:p.version,at});team.planDecisions=team.planDecisions.slice(-200);team.events.push({at,type:`plan-${action}`,scope:p.scope,version:p.version,hash:p.hash,source:input.source??'leader-recorded-user-confirmation'});}
export function validatePlanReview(team){const p=team.planReview;if(!p)return;if(!['0.11.0','0.12.0','0.13.0','0.14.0','0.15.0','0.16.0','0.17.0','0.18.0','0.21.0','0.24.0','0.29.0','0.30.0','0.31.0','0.32.0'].includes(team.requiresTeamWorkspaceVersion)||!['pending','approved','cancelled'].includes(p.status)||!['initial','expansion'].includes(p.scope)||!Number.isInteger(p.version)||p.version<1||! /^[0-9a-f]{64}$/.test(p.hash))throw new Error('Invalid plan review state');if(p.confirmation==='team'&&(team.taskPlanning!=='leader'||p.scope!=='initial'))throw new Error('Invalid formation confirmation');if(p.status==='pending'&&p.scope==='initial'&&team.taskPlanning==='leader'&&team.tasks.length)throw new Error('Formation tasks must be planned after approval');if(p.status==='pending'){const value=p.scope==='initial'?planConfiguration(team):p.pending;if(planHash(value)!==p.hash)throw new Error('Pending plan changed without a new review version');}if(p.scope==='initial'&&p.status!=='approved'&&(team.members.some(m=>m.agentThreadId)||team.tasks.some(t=>t.attempts.length)))throw new Error('Unapproved plans cannot contain native executions');}

export function updateExpansionDraft(team,configuration,brief){const p=team.planReview;if(p?.scope!=='expansion'||p.status!=='pending')throw new Error('Only a pending expansion may be revised');const version=p.version;team.planReview={...p,status:'approved'};stageExpansion(team,{members:configuration.members??[],tasks:configuration.tasks??[],policy:configuration.policy,maxParallel:configuration.maxParallel},brief??p.brief);team.planReview.version=version+1;}

export function assertDispatchAllowed(team){assertPlanExecutable(team);if(team.executionControl&&team.executionControl.status!=='active')throw new Error('Team dispatch is paused: stopping or halted; reconcile and explicitly resume before dispatch');}
