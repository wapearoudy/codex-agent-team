import {assertPlanExecutable,assertPlanMutable} from './team-plan-review.mjs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PrototypeRuntime } from './runtime.mjs';
import {HostContext,authorizeTeam} from './host-context.mjs';
import {TeamEngine} from './team-engine.mjs';
import {LeaderEngine} from './leader-engine.mjs';
import {ProjectTeams} from './project-teams.mjs';
import {TeamNavigation} from './team-navigation.mjs';
import {teamResponse} from './team-responses.mjs';
import {RequestContext} from './request-context.mjs';
import {PanelSnapshot} from './panel-snapshot.mjs';
import {TeamProfiles,normalizePolicy,compactHandoff} from './team-policy.mjs';
import {taskQuery,exportTeam} from './team-diagnostics.mjs';
import {recoveryPacket,recordRecoveryControl,takeoverBoundary} from './team-recovery.mjs';
import {queuePeerMessage,peerInbox,acknowledgePeerMessage,recordPeerDelivery} from './team-peer-mailbox.mjs';
import {TeamWorktrees} from './team-worktrees.mjs';

const URI = 'ui://team-workspace-probe/0.11.1/host.html';
const bootId = randomUUID();
const startedAt = new Date().toISOString();
const server = new McpServer({ name: 'team-workspace-probe', version: '0.11.1' });
const runtime = new PrototypeRuntime();
const engine=new TeamEngine({root:process.env.TEAM_WORKSPACE_DATA_ROOT});
const leader=new LeaderEngine({root:process.env.TEAM_WORKSPACE_DATA_ROOT,store:engine.store});
const projectTeams=new ProjectTeams(leader);
const navigation=new TeamNavigation({root:leader.root,store:engine.store,observer:leader.observer});
const panelSnapshot=new PanelSnapshot();
const profiles=new TeamProfiles(leader.root);
const worktrees=new TeamWorktrees(join(leader.root,'worktrees'));
const readTeam=async(o,id)=>(await engine.store.get(id,o)).mode==='host-leader'?leader.read(o,id):engine.read(o,id);
async function route(method,o,id,revision,...rest){
 const t=await engine.store.get(id,o);
 if(t.revision!==revision)throw new Error('Team changed; refresh before controlling members');
 if(!['stop','pause','reconcile','recoverIntegration'].includes(method)){const current=await projectTeams.current(o,{cwd:t.projectPath});if(current&&current.id!==id)throw new Error('Historical team is read-only; assign work to the project’s current team');}
 if(t.mode!=='host-leader'){if(method==='start')throw new Error('旧隔离团队已停用启动；保留记录和停止/恢复能力。请由当前 Leader 创建原生成员计划。');return engine[method](o,id,revision,...rest);}
 if(method==='reconcile')return leader.receipt(o,id);
 if(['integrate','recoverIntegration'].includes(method))throw new Error('原生成员直接在当前项目工作，无副本写回操作；请完成独立审查与 Leader 最终验收。');
 if(['edit','cancel'].includes(method)){assertPlanMutable(t);await engine[method](o,id,revision,...rest);return leader.receipt(o,id);}
 return leader[method](o,id,revision,...rest);
}
const owner=extra=>runtime.scope(extra?._meta);
// Only field names, never metadata values, credentials, prompts or file content.
function snapshot(extra) {
  const peer = server.server.getClientVersion();
  return {
    kind: 'host-connection-probe', pluginVersion:'0.11.1', productReady: false,
    observedAt: new Date().toISOString(), bootId, startedAt,
    source: 'live-mcp-connection',
    client: peer ? { name: peer.name, version: peer.version } : null,
    capabilityNames: Object.keys(server.server.getClientCapabilities() ?? {}).sort(),
    metadataNames: Object.keys(extra?._meta ?? {}).sort(),
    projectAuthorization: 'NOT_VERIFIED',
    agentExecution: 'EXPERIMENTAL_FIXTURE_ONLY', agentControl: 'EXPERIMENTAL_UNVERIFIED',
    hostLifecycle: 'NOT_VERIFIED',
    warning: '连接成功不代表能够创建、查询或停止 Agent。'
  };
}
const result = (data) => {
  if(data.kind==='team-detail'&&data.team.mode==='host-leader'&&!data.detailToken)data=teamResponse(data,'summary','team-update');
  const text=data.kind==='team-state'||data.displayLimits?.preview?JSON.stringify({kind:data.kind,teamId:data.team.id,revision:data.team.revision,detailToken:data.detailToken,displayLimits:data.displayLimits}):JSON.stringify(data);
  return {content:[{type:'text',text}],structuredContent:data};
};
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const guarded=fn=>async(args,extra)=>requestContext.run(async()=>{try{return result(await fn(args,extra));}catch(error){return {isError:true,content:[{type:'text',text:error.message}]};}});
const teamId={teamId:z.string().uuid()};
const editTeam={...teamId,revision:z.number().int().positive()};
const id=z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const routeSchema=z.object({model:z.string().min(1).max(100).optional(),reasoningEffort:z.enum(['low','medium','high','xhigh','max','ultra']).optional()});
const policySchema=z.object({tokenLimit:z.number().int().positive().nullable().optional(),contextChars:z.number().int().min(4000).max(100000).optional(),maxAttempts:z.number().int().min(1).max(10).optional(),requireKnownUsage:z.boolean().optional(),autoRepair:z.boolean().optional(),maxReviewRounds:z.number().int().min(1).max(10).optional()});
const memberSchema=z.object({id,role:z.string().min(1).max(100),responsibility:z.string().min(1).max(2000),reason:z.string().min(1).max(1000),writeScopes:z.array(z.string().min(1).max(300)).max(30),route:routeSchema.optional()});
const criteriaSchema=z.array(z.object({id,description:z.string().min(1).max(2000)})).min(1).max(30);
const contractSchema=z.object({stage:z.enum(['requirements','implementation','verification','review','repair','integration']),inScope:z.array(z.string().min(1).max(300)).max(30).default([]),outOfScope:z.array(z.string().min(1).max(300)).max(30).default([]),verify:z.array(z.string().min(1).max(2000)).max(30).default([]),coverageOf:z.array(id).max(30).default([])});
const planSchema=z.object({members:z.array(memberSchema).min(1).max(8),goalCriteria:criteriaSchema.optional(),tasks:z.array(z.object({id,title:z.string().min(1).max(200),goal:z.string().min(1).max(3000),context:z.string().max(12000).optional(),acceptance:z.string().min(1).max(3000),acceptanceCriteria:criteriaSchema.optional(),contract:contractSchema.optional(),memberId:id,priority:z.number().int().min(1).max(5),kind:z.enum(['work','review']).default('work'),validationMode:z.enum(['execute','source-only']).default('execute'),reviewOfTaskId:id.optional(),parentTaskId:id.optional(),resources:z.array(z.string().min(1).max(100)).max(20).default([]),dependencies:z.array(z.object({taskId:id,when:z.enum(['submitted','accepted'])})).max(40)})).min(1).max(40)});
const approvalFields={approvalMode:z.enum(['auto','required','immediate']).default('auto'),executionAuthorization:z.string().min(1).max(2000).optional(),brief:z.string().max(3000).optional()};
const configurationSchema=z.object({goal:z.string().min(8).max(2000),plan:planSchema,maxParallel:z.number().int().min(1).max(8),policy:policySchema.optional()});
const hostContext=new HostContext();
const requestContext=new RequestContext(meta=>hostContext.resolve(meta));
const currentProject=extra=>requestContext.project(extra);
async function assertCurrentTeam(extra,teamId){return authorizeTeam({owner:owner(extra),context:await currentProject(extra),store:engine.store,teamId});}
registerAppTool(server,'open_team_workspace',{title:'团队',description:'打开当前 Codex 项目、当前会话关联的团队监管面板。项目来自宿主线程元数据，不要求重新选择项目或填写目标，不启动成员。',inputSchema:{},annotations:readOnly,_meta:{ui:{resourceUri:URI},'openai/ui':{entrypoints:[{type:'thread'}]}}},guarded(async(_,extra)=>{
  const context=await currentProject(extra),current=await projectTeams.current(owner(extra),context),teams=current?[current]:[];
  return{kind:'team-workspace',version:'0.11.1',context,teams:teams.map(t=>({id:t.id,goal:t.goal,state:t.state,revision:t.revision,updatedAt:t.updatedAt})),observedAt:new Date().toISOString(),productReady:false};
}));
registerAppTool(server,'get_current_project',{title:'读取当前项目上下文',description:'自动读取触发此工具的 Codex 会话项目目录及必要说明。协调者直接沿用当前对话目标；不得要求用户去面板重选项目或重填需求。不会启动模型成员。',inputSchema:{},annotations:readOnly,_meta:{ui:{visibility:['model']}}},guarded(async(_,extra)=>({context:await currentProject(extra),executionMode:'host-leader',projectScan:false,instructions:'当前主会话就是 Leader。使用当前项目和已有对话上下文；按任务读取必要文件。'})));
registerAppTool(server,'plan_team',{title:'组建当前项目团队',description:'直接用当前对话中用户已给出的目标和当前 Codex 项目组队。先调用 get_current_project 了解项目，再按实际需要生成成员和任务图。每项交付有独立审查。execute=true 表示有执行意图；approvalMode=auto 时复杂新团队仍先等待计划确认，required 强制先审阅，immediate 仅限用户明确说直接做并记录 executionAuthorization。只要计划时 execute=false。待确认时不得初始化成员；用 read_team_plan 展示目标、范围、分工和验收，用户随后在聊天确认可用 approve_team_plan，无需再点面板。',inputSchema:{...approvalFields,goal:z.string().min(8).max(2000),plan:planSchema,maxParallel:z.number().int().min(1).max(8).default(3),execute:z.boolean().default(false),requestId:z.string().uuid().optional()},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true},_meta:{ui:{resourceUri:URI}}},guarded(async(args,extra)=>{
  const o=owner(extra),context=await currentProject(extra),{team,reused}=await projectTeams.plan(o,context,args);
  return {kind:'team-detail',...await leader.receipt(o,team.id),reused,requestedGoal:args.goal,leaderAction:team.planReview?.scope==='initial'&&team.planReview.status==='pending'?'Present read_team_plan and wait for the user to confirm this version. Do not initialize members.':reused?'Reuse this fixed project team. Ordinary in-scope work uses existing authorization; material expansions require a separate plan change.':'Initialize only the approved members, then claim ready tasks using native subagent tools. No model has been launched by plan_team.'};
}));
registerAppTool(server,'rebuild_project_team',{description:'仅在用户明确要求重新组建团队时调用。要求旧成员全部停止并接收终态；归档旧团队并创建替代固定成员团队。普通新任务应 add_team_tasks 复用现有团队。',inputSchema:{...approvalFields,goal:z.string().min(8).max(2000),plan:planSchema,maxParallel:z.number().int().min(1).max(8).default(3),execute:z.boolean().default(true),requestId:z.string().uuid()},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{resourceUri:URI,visibility:['model']}}},guarded(async(args,extra)=>{const o=owner(extra),context=await currentProject(extra),{team}=await projectTeams.rebuild(o,context,args);return {kind:'team-detail',...await leader.read(o,team.id)};}));
registerAppTool(server,'read_team_plan',{title:'审阅团队计划',description:'按需读取当前计划原文、版本、范围、分工、任务依赖和预算，不初始化成员。',inputSchema:teamId,annotations:readOnly,_meta:{ui:{visibility:['app','model']}}},guarded(async(a,e)=>leader.readPlan(await assertCurrentTeam(e,a.teamId),a.teamId)));
registerAppTool(server,'revise_team_plan',{title:'调整团队计划',description:'仅修改尚未开工的待确认计划。完整配置原子替换、校验独立审查和依赖；版本递增，旧确认失效。',inputSchema:{...editTeam,configuration:z.union([configurationSchema,z.object({members:z.array(memberSchema).max(8).default([]),tasks:planSchema.shape.tasks.optional(),policy:policySchema.optional(),maxParallel:z.number().int().min(1).max(8).optional()})]),brief:z.string().max(3000).optional()},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{visibility:['app','model']}}},guarded(async(a,e)=>leader.revisePlan(await assertCurrentTeam(e,a.teamId),a.teamId,a.revision,a.configuration,a.brief)));
for(const [name,action] of [['approve_team_plan','approve'],['cancel_team_plan','cancel']])registerAppTool(server,name,{title:action==='approve'?'确认当前计划':'取消待确认计划',description:'必须来自用户对本版本的明确确认或取消。聊天确认由 Leader 如实记录，不能自行推断或把首次执行意图当作待审计划的批准。绑定 planVersion 和 planHash；重复 UUID 去重。只授权执行，不代表验收，也不直接启动模型。取消扩展仅丢弃提案，保留原团队执行。',inputSchema:{...editTeam,planVersion:z.number().int().positive(),planHash:z.string().regex(/^[a-f0-9]{64}$/),requestId:z.string().uuid(),note:z.string().min(1).max(2000),source:z.enum(['panel-user-action','leader-recorded-user-confirmation']).default('leader-recorded-user-confirmation')},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{resourceUri:URI,visibility:['app','model']}}},guarded(async(a,e)=>({kind:'team-detail',...await leader.decidePlan(await assertCurrentTeam(e,a.teamId),a.teamId,a.revision,a,action)})));
registerAppTool(server,'propose_team_change',{title:'提议团队范围变更',description:'暂存新增岗位、任务、并发或预算变更，确认前不应用、不影响原团队。语义上的目标扩展必须主动使用此工具，不能以普通追加任务绕过确认。',inputSchema:{...editTeam,members:z.array(memberSchema).max(8).default([]),tasks:planSchema.shape.tasks.optional(),policy:policySchema.optional(),maxParallel:z.number().int().min(1).max(8).optional(),brief:z.string().min(1).max(3000)},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{visibility:['model']}}},guarded(async(a,e)=>({kind:'team-detail',...await leader.proposeChange(await assertCurrentTeam(e,a.teamId),a.teamId,a.revision,{members:a.members,tasks:a.tasks??[],policy:a.policy,maxParallel:a.maxParallel},a.brief)})));
registerAppTool(server,'read_team',{description:'只读团队状态。默认 summary 返回当前成员、任务、就绪与恢复建议；state 用于面板轻量刷新；panel 返回有大小上限的展示预览，不能作为完整验收证据；完整历史、公开交付或命令明确传 full。panel/full 可传最近 state 的 detailToken 读取同一已核对快照；当前项目授权和 revision 仍每次重新核对。不启动模型或恢复执行。',inputSchema:{...teamId,view:z.enum(['summary','state','panel','full']).default('summary'),detailToken:z.string().regex(/^[a-f0-9]{64}$/).optional()},annotations:readOnly,_meta:{ui:{visibility:['app','model']}}},guarded(async(args,extra)=>{
 const o=await assertCurrentTeam(extra,args.teamId);
 if(['full','panel'].includes(args.view)&&args.detailToken){
   const saved=await engine.store.get(args.teamId,o),cached=panelSnapshot.read(o,args.teamId,saved.revision,args.detailToken);
   if(cached)return teamResponse(cached,args.view);
 }
 const data=await readTeam(o,args.teamId);
 if(data.team.mode!=='host-leader'&&!['panel','state'].includes(args.view))return {kind:'team-detail',...data,detailToken:'legacy-full'};
 const projected=teamResponse(data,args.view);if(args.view==='state')panelSnapshot.save(o,data,projected.detailToken);return projected;
}));
registerAppTool(server,'request_team_navigation',{title:'定位原生成员会话',description:'保存用户点击的原生成员查看请求，核对当前Leader、项目、固定成员和指定任务轮次；返回主会话宿主导航操作，不创建或启动成员。',inputSchema:{...teamId,memberId:id,taskId:id.optional(),attemptId:z.string().uuid().optional(),destination:z.enum(['member','leader']).default('member'),requestId:z.string().uuid()},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{visibility:['app','model']}}},guarded(async(a,e)=>navigation.request(await assertCurrentTeam(e,a.teamId),await currentProject(e),a)));
registerAppTool(server,'read_team_navigation',{description:'核对面板导航请求仍为当前项目、最新有效目标；过期/替换的请求不能执行。只读，不启动模型。',inputSchema:{...teamId,requestId:z.string().uuid()},annotations:readOnly,_meta:{ui:{visibility:['app','model']}}},guarded(async(a,e)=>navigation.read(await assertCurrentTeam(e,a.teamId),await currentProject(e),a.teamId,a.requestId)));
registerAppTool(server,'cancel_team_navigation',{description:'用户离开所选任务或成员时取消尚未执行的导航请求；不停止团队或成员。',inputSchema:{...teamId,requestId:z.string().uuid()},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{visibility:['app','model']}}},guarded(async(a,e)=>navigation.cancel(await assertCurrentTeam(e,a.teamId),await currentProject(e),a.teamId,a.requestId)));
registerAppTool(server,'record_team_navigation',{description:'Leader实际调用宿主导航工具后记录成功或失败；成功是宿主工具回执，不伪称已定位到任务轮次。面板不能自行报告宿主已打开。',inputSchema:{...teamId,requestId:z.string().uuid(),status:z.enum(['opened','failed']),note:z.string().min(1).max(2000)},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{visibility:['model']}}},guarded(async(a,e)=>navigation.record(await assertCurrentTeam(e,a.teamId),await currentProject(e),a)));
for(const [name,method,title] of [['start_team','start','开始执行计划'],['pause_team_dispatch','pause','暂停新任务派发'],['stop_team','stop','请求停止团队轮次'],['integrate_team','integrate','将全部已验收候选写回项目'],['reconcile_team','reconcile','核对已保存的执行状态，不恢复轮次'],['recover_team_integration','recoverIntegration','回退中断的写回；保留外部新改动，不自动重新写回']])registerAppTool(server,name,{title,description:`${title}。原生团队由当前主会话控制；开始仅允许 Leader 派发，不启动后台调度。仅在用户通过当前对话明确授权后执行；旧版本号请求拒绝，未知状态不自动重试。`,inputSchema:editTeam,annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true},_meta:{ui:{resourceUri:URI,visibility:['model']}}},guarded(async(args,extra)=>({kind:'team-detail',...await route(method,await assertCurrentTeam(extra,args.teamId),args.teamId,args.revision)})));
registerAppTool(server,'message_team_member',{description:'原生团队持久保存消息并返回 Leader 原生发送提示；requestId 重试去重。保存不是送达，未知结果不自动重发。旧团队沿用其执行端。',inputSchema:{...editTeam,taskId:id,text:z.string().min(1).max(3000),requestId:z.string().uuid().optional()},annotations:{readOnlyHint:false,openWorldHint:true},_meta:{ui:{visibility:['model']}}},guarded(async(a,e)=>({kind:'team-detail',...await route('message',await assertCurrentTeam(e,a.teamId),a.teamId,a.revision,a.taskId,a.text,a.requestId)})));
registerAppTool(server,'edit_team_task',{description:'修改尚未开工任务的分配、优先级或依赖，保留历史并重新校验任务图。',inputSchema:{...editTeam,taskId:id,patch:z.object({memberId:id.optional(),priority:z.number().int().min(1).max(5).optional(),dependencies:z.array(z.object({taskId:id,when:z.enum(['submitted','accepted'])})).optional()})},annotations:{readOnlyHint:false,openWorldHint:false},_meta:{ui:{visibility:['model']}}},guarded(async(a,e)=>({kind:'team-detail',...await route('edit',await assertCurrentTeam(e,a.teamId),a.teamId,a.revision,a.taskId,a.patch)})));
registerAppTool(server,'add_team_tasks',{description:'在原授权范围内向已有成员追加任务，保留历史和独立审查。目标或范围实质扩大必须 scopeChange=true 并写 note，暂存为待确认提案；分配给待批准新岗位的任务也会暂存。语义范围由 Leader 核对，不可自行推定用户已批准扩展。',inputSchema:{...editTeam,tasks:planSchema.shape.tasks,scopeChange:z.boolean().default(false),note:z.string().max(3000).optional()},annotations:{readOnlyHint:false,openWorldHint:false},_meta:{ui:{visibility:['model']}}},guarded(async(a,e)=>({kind:'team-detail',...await route('addTasks',await assertCurrentTeam(e,a.teamId),a.teamId,a.revision,a.tasks,{scopeChange:a.scopeChange,note:a.note})})));
registerAppTool(server,'cancel_team_task',{description:'取消尚未开工的任务及其尚未开工下游，保留历史；已有执行记录时拒绝伪装取消。',inputSchema:{...editTeam,taskId:id,note:z.string().min(1).max(1000)},annotations:{readOnlyHint:false,openWorldHint:false},_meta:{ui:{visibility:['model']}}},guarded(async(a,e)=>({kind:'team-detail',...await route('cancel',await assertCurrentTeam(e,a.teamId),a.teamId,a.revision,a.taskId,a.note)})));
registerAppTool(server,'rework_team_task',{description:'用户明确要求返工时调用；保留所有历史和预算，使下游结论失效。仍运行或未知的相关成员必须先停止并核对。不会自动开工。',inputSchema:{...editTeam,taskId:id,note:z.string().min(1).max(2000)},annotations:{readOnlyHint:false,openWorldHint:false},_meta:{ui:{visibility:['model']}}},guarded(async(a,e)=>({kind:'team-detail',...await route('rework',await assertCurrentTeam(e,a.teamId),a.teamId,a.revision,a.taskId,a.note)})));

const nativeAttempt={...editTeam,taskId:id,attemptId:z.string().uuid()};
const checkpointText=z.string().trim().min(1).max(2000);
registerAppTool(server,'read_team_handoff',{description:'只读当前任务的目标、职责、前置证据和最新检查点，明确历史轮次；不启动或恢复成员。',inputSchema:{...teamId,taskId:id},annotations:readOnly,_meta:{ui:{visibility:['model']}}},guarded(async(a,e)=>{const {team,handoff}=await leader.handoff(await assertCurrentTeam(e,a.teamId),a.teamId,a.taskId);return {kind:'team-handoff',team:{id:team.id,revision:team.revision,projectPath:team.projectPath,leaderThreadId:team.leaderThreadId},handoff};}));
const nativeTool=(name,description,inputSchema,fn)=>registerAppTool(server,name,{description,inputSchema,annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{visibility:['model']}}},guarded(async(a,e)=>{const o=await assertCurrentTeam(e,a.teamId),t=await engine.store.get(a.teamId,o),current=await projectTeams.current(o,{cwd:t.projectPath});if(current&&current.id!==a.teamId&&!['settle_team_task','release_team_reservation','reconcile_team_message'].includes(name))throw new Error('Historical team is read-only; use the project’s current team');assertPlanExecutable(t);return {kind:'team-detail',...await fn(a,o)};}));
nativeTool('add_team_members','向当前项目的固定团队追加岗位，保留原成员、原生线程、正在执行的任务与历史。传稳定 requestId 重试去重；总人数最多 8。返回新岗位的初始化提示，由 Leader 创建并绑定对应原生 subagent，完成后用 add_team_tasks 分配任务。有计划确认记录的团队先暂存岗位变更，用户确认前不会创建或初始化新岗位；原成员继续工作。',{...editTeam,members:z.array(memberSchema).min(1).max(8),requestId:z.string().uuid()},(a,o)=>leader.addMembers(o,a.teamId,a.revision,a.members,a.requestId,{reviewExpansion:true}));
nativeTool('reassign_team_task','安全改派待执行或阻塞任务，保留每轮执行者、消息、检查点和用量历史。运行中先由 Leader 停止并 settle；已提交或验收任务先显式 rework。目的成员必须保有独立审查和写入范围约束。不会启动、停止模型或重置重试预算。稳定 requestId 去重。',{...editTeam,taskId:id,memberId:id,note:z.string().min(1).max(3000),requestId:z.string().uuid()},(a,o)=>leader.reassign(o,a.teamId,a.revision,a.taskId,a.memberId,a.note,a.requestId));
nativeTool('remove_team_member','移除已确认空闲且没有未完成任务的固定成员；保留其原生线程及全部历史，释放活跃岗位名额。先改派或完成未结束任务，宿主最新轮次未知时拒绝移除。工具不删除或中断原生线程。稳定 requestId 去重；移除后成员 ID 不能重用。',{...editTeam,memberId:id,note:z.string().min(1).max(3000),requestId:z.string().uuid()},(a,o)=>leader.removeMember(o,a.teamId,a.revision,a.memberId,a.note,a.requestId));
registerAppTool(server,'query_team_tasks',{description:'按任务号、文字、状态或成员查询任务历史；分页不加载其他公开交付，不启动成员。',inputSchema:{...teamId,query:z.string().max(200).default(''),status:z.string().max(30).optional(),memberId:id.optional(),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(200).default(50),cursor:z.string().max(2000).optional()},annotations:readOnly,_meta:{ui:{visibility:['app','model']}}},guarded(async(a,e)=>{const o=await assertCurrentTeam(e,a.teamId),t=await engine.store.get(a.teamId,o);return {kind:'team-query',teamId:t.id,revision:t.revision,...taskQuery(t,a)};}));
registerAppTool(server,'export_team_report',{description:'导出当前项目团队的公开任务、交付和用量报告；无隐藏推理、账号凭据或跨项目记录。',inputSchema:{...teamId,format:z.enum(['markdown','json']).default('markdown')},annotations:readOnly,_meta:{ui:{visibility:['app','model']}}},guarded(async(a,e)=>{const d=await leader.read(await assertCurrentTeam(e,a.teamId),a.teamId);return {kind:'team-export',...exportTeam(d.team,{format:a.format,runs:d.runs,usage:d.usage})};}));
registerAppTool(server,'read_team_recovery',{description:'读取原团队、成员与任务的恢复包，观察真实线程；不恢复模型、不换成员、不把历史线程冒充可控句柄。',inputSchema:teamId,annotations:readOnly,_meta:{ui:{visibility:['app','model']}}},guarded(async(a,e)=>{const t=await engine.store.get(a.teamId,await assertCurrentTeam(e,a.teamId));return {kind:'team-recovery',...await recoveryPacket(t,leader.observer)};}));
registerAppTool(server,'read_project_team_takeover',{description:'查看当前项目原团队的接续边界及交接；跨 Leader 不伪造宿主接管，不另建团队。',inputSchema:{},annotations:readOnly,_meta:{ui:{visibility:['model']}}},guarded(async(_,e)=>{const c=await currentProject(e),index=await projectTeams.registry.read(),entry=index.projects[projectTeams.key(c)];if(!entry)return {kind:'team-takeover',status:'no-team'};const t=await engine.store.get(entry.teamId,entry.ownerId);if(t.projectPath!==c.cwd)throw new Error('Project identity mismatch');return {kind:'team-takeover',...takeoverBoundary(t,c.threadId)};}));
nativeTool('record_team_recovery_control','记录 Leader 对原成员实际调用原生工具的结果，失去控制能力时暂停派发，不能用读取成功冒充控制成功。',{...editTeam,memberId:id,threadId:z.string().min(1),status:z.enum(['available','unavailable']),tool:z.string().min(1).max(100),note:z.string().min(1).max(2000)},async(a,o)=>{await engine.store.update(a.teamId,o,a.revision,t=>recordRecoveryControl(t,a));return leader.receipt(o,a.teamId);});
nativeTool('configure_team_policy','调整预算和修复额度。提高预算或自动执行额度时先暂存变更提案，用户确认后才应用；降低额度沿用授权。',{...editTeam,policy:policySchema},(a,o)=>leader.configurePolicy(o,a.teamId,a.revision,a.policy,{reviewExpansion:true}));
nativeTool('advance_team_workflow','Leader 一次接收已确认终态、记录明确审查决定并预留就绪批次。保持独立验收；返回派发包后仍使用原生成员工具，不启动后台协调者。',{...editTeam,settleCompleted:z.boolean().default(true),dispatchReady:z.boolean().default(false),decisions:z.array(z.object({taskId:id,attemptId:z.string().uuid(),decision:z.enum(['accept','rework']),note:z.string().min(1).max(2000)})).max(8).default([])},(a,o)=>leader.advance(o,a.teamId,a.revision,a));
registerAppTool(server,'save_team_profile',{description:'保存可复用的岗位、模型路由与任务模板；不启动成员，不改现有团队身份。',inputSchema:{name:id,plan:planSchema,policy:policySchema.optional(),note:z.string().max(2000).optional()},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{visibility:['model']}}},guarded(async(a,e)=>{await currentProject(e);return {kind:'team-profile',profile:await profiles.save(a.name,a.plan,a.policy,a.note)};}));
registerAppTool(server,'read_team_profiles',{description:'读取已保存团队模板，不启动成员。',inputSchema:{name:id.optional()},annotations:readOnly,_meta:{ui:{visibility:['model']}}},guarded(async(a,e)=>{await currentProject(e);return {kind:'team-profiles',profiles:await profiles.read(a.name)};}));
registerAppTool(server,'plan_team_from_profile',{description:'按用户选择的模板建立或复用当前项目固定团队；已有团队不替换成员。',inputSchema:{...approvalFields,name:id,goal:z.string().min(8).max(2000),execute:z.boolean().default(false)},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{visibility:['model']}}},guarded(async(a,e)=>{const p=await profiles.read(a.name),o=owner(e),c=await currentProject(e),r=await projectTeams.plan(o,c,{...a,plan:p.plan,policy:p.policy});if(!r.reused)await engine.store.update(r.team.id,o,r.team.revision,t=>{t.profile=a.name;});return {kind:'team-detail',...await leader.receipt(o,r.team.id),reused:r.reused};}));
nativeTool('prepare_team_worktree','为闲置写入成员准备可选 Git worktree；保留同一原生线程，任务文件操作使用分配目录，无全项目快照。',{...editTeam,memberId:id},async(a,o)=>{await engine.store.update(a.teamId,o,a.revision,async t=>{t.members.find(m=>m.id===a.memberId).workspace=await worktrees.prepare(t,a.memberId);});return leader.receipt(o,a.teamId);});
nativeTool('integrate_team_worktree','已独立验收且所有写入停止后预检并暂存候选合并；不自动提交，冲突预检不修改主项目。',{...editTeam,memberId:id},async(a,o)=>{const saved=await engine.store.update(a.teamId,o,a.revision,async t=>{const integration=await worktrees.integrate(t,a.memberId);t.integrations??=[];if(!t.integrations.some(i=>i.memberId===integration.memberId&&i.candidate===integration.candidate))t.integrations.push(integration);return integration;});return {...await leader.receipt(o,a.teamId),integration:saved.result};});
nativeTool('record_team_peer_delivery','记录 Leader 通过原生工具转交团队成员消息的真实结果；未知送达不能自动重发。',{...editTeam,messageId:z.string().uuid(),status:z.enum(['host-accepted','unknown','failed']),note:z.string().min(1).max(2000)},async(a,o)=>{await engine.store.update(a.teamId,o,a.revision,t=>recordPeerDelivery(t,a));return leader.receipt(o,a.teamId);});
async function participant(extra,tid){const context=await currentProject(extra),saved=await engine.store.document(tid).read();if(!saved.id)throw new Error('Team not found');const t=await engine.store.get(tid,saved.ownerId),member=t.members.find(m=>m.agentThreadId===context.threadId);if(context.cwd!==t.projectPath||!(context.threadId===t.leaderThreadId||(member&&context.parentThreadId===t.leaderThreadId)))throw new Error('Only an authenticated native team participant can access its mailbox');return {team:t,member,context,owner:t.ownerId};}
registerAppTool(server,'send_team_peer_message',{description:'原生成员为当前任务保存给队友或 Leader 的持久消息；Leader 保留实际原生发送控制，保存不等于送达。',inputSchema:{...teamId,attemptId:z.string().uuid(),toMemberId:id,text:z.string().min(1).max(4000),requestId:z.string().uuid()},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{visibility:['model']}}},guarded(async(a,e)=>{const p=await participant(e,a.teamId);if(!p.member)throw new Error('Use the Leader mailbox tool for Leader messages');const r=await engine.store.update(a.teamId,p.owner,p.team.revision,t=>{const before=t.peerMessages?.length??0,message=queuePeerMessage(t,{...a,senderMemberId:p.member.id,senderThreadId:p.context.threadId});return {message,firstOffer:t.peerMessages.length>before};});const message=r.result.message;return {kind:'peer-message',revision:r.team.revision,message,delivery:'saved-not-sent',nativeAction:r.result.firstOffer?{tool:'send_message',target:message.toMemberId==='leader'?p.member.agentPath?.slice(0,p.member.agentPath.lastIndexOf('/')):r.team.members.find(m=>m.id===message.toMemberId)?.agentPath,threadId:message.recipientThreadId,text:message.marker+'\n'+message.text}:null};}));
registerAppTool(server,'read_team_inbox',{description:'读取当前真实团队参与者的持久收件箱，不能读取其他成员的私有目标收件箱。',inputSchema:{...teamId,after:z.number().int().min(0).default(0)},annotations:readOnly,_meta:{ui:{visibility:['model']}}},guarded(async(a,e)=>{const p=await participant(e,a.teamId);return {kind:'peer-inbox',...peerInbox(p.team,p.context.threadId,a)};}));
registerAppTool(server,'acknowledge_team_peer_message',{description:'原收件成员确认已从收件箱读取指定消息；记录真实原生线程和其当前任务轮次，不代替业务完成。',inputSchema:{...teamId,messageId:z.string().uuid(),attemptId:z.string().uuid().optional()},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{visibility:['model']}}},guarded(async(a,e)=>{const p=await participant(e,a.teamId),task=p.team.tasks.find(t=>t.memberId===p.member?.id&&t.status==='running'&&t.attempts.at(-1)?.id===a.attemptId),attempt=task?.attempts.at(-1);if(p.member&&!attempt?.turnId)throw new Error('A bound current recipient attempt is required');const r=await engine.store.update(a.teamId,p.owner,p.team.revision,t=>acknowledgePeerMessage(t,{messageId:a.messageId,threadId:p.context.threadId,turnId:attempt?.turnId,attemptId:a.attemptId}));return {kind:'peer-acknowledgement',message:r.result,revision:r.team.revision};}));
registerAppTool(server,'read_team_context',{description:'读取按字符预算收敛的任务交接，目标、约束和全部验收条件保持原文；历史证据给出原文读取引用。',inputSchema:{...teamId,taskId:id,view:z.enum(['compact','full']).default('compact')},annotations:readOnly,_meta:{ui:{visibility:['model']}}},guarded(async(a,e)=>{const p=await participant(e,a.teamId);if(p.member){const own=p.team.tasks.find(t=>t.memberId===p.member.id&&t.status==='running');const allowed=new Set();function include(id){if(allowed.has(id))return;allowed.add(id);for(const d of p.team.tasks.find(t=>t.id===id)?.dependencies??[])include(d.taskId);}if(own)include(own.id);if(!allowed.has(a.taskId))throw new Error('Only the current task and its dependency contexts may be read');}const {team,handoff}=await leader.handoff(p.owner,a.teamId,a.taskId);return {kind:'team-context',handoff:a.view==='full'?handoff:compactHandoff(handoff,normalizePolicy(team.policy))};}));
registerAppTool(server,'read_team_usage',{description:'按成员和任务读取真实 token 用量；可显式补读旧轮次，用量缺失保持未知，不估算账号账单。',inputSchema:{...teamId,refreshHistorical:z.boolean().default(false)},annotations:readOnly,_meta:{ui:{visibility:['app','model']}}},guarded(async(a,e)=>({kind:'team-usage',usage:await leader.usage(await assertCurrentTeam(e,a.teamId),a.teamId,a)})));
registerAppTool(server,'record_team_peer_sender_delivery',{description:'原消息发送成员记录自己调用原生消息工具的实际回执；只限自己当前任务的消息，保存或工具成功不等于成员已读。',inputSchema:{...teamId,messageId:z.string().uuid(),status:z.enum(['host-accepted','unknown','failed']),note:z.string().min(1).max(2000)},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{visibility:['model']}}},guarded(async(a,e)=>{const p=await participant(e,a.teamId),message=p.team.peerMessages?.find(m=>m.id===a.messageId);if(!p.member||message?.senderThreadId!==p.context.threadId)throw new Error('Only the original sender can record its delivery');const task=p.team.tasks.find(t=>t.id===message.taskId);if(task?.attempts.at(-1)?.id!==message.attemptId||task.status!=='running')throw new Error('Original sender attempt is no longer active');const r=await engine.store.update(a.teamId,p.owner,p.team.revision,t=>recordPeerDelivery(t,{...a,source:'authenticated-sender-native-tool'}));return {kind:'peer-delivery',message:r.result,revision:r.team.revision};}));
nativeTool('bind_team_roster_member','团队成员与原生 subagent 一对一固定绑定。按 plan 返回的初始化提示创建成员，立即传宿主返回的路径；初始化回执未落盘时保留关联，不能重建。任务复用同一成员。',{...editTeam,memberId:id,threadId:z.string().min(1).max(200)},(a,o)=>leader.bindRoster(o,a.teamId,a.revision,a.memberId,a.threadId));
nativeTool('bind_team_roster_members','批量绑定 1–8 个固定成员；每个成员独立验证原生身份，全部验证后一次提交。失败无部分绑定；不要重新创建成员。',{...editTeam,assignments:z.array(z.object({memberId:id,threadId:z.string().min(1).max(200)})).min(1).max(8)},(a,o)=>leader.bindRosterMany(o,a.teamId,a.revision,a.assignments));
nativeTool('record_team_checkpoint','Leader 保存当前已绑定轮次的结构化进度；明确标为 Leader 记录，不代替独立验收。同 requestId 重试去重，旧轮次不能冒充当前证据。',{...nativeAttempt,requestId:z.string().uuid(),summary:z.string().trim().min(1).max(3000),decisions:z.array(checkpointText).max(30),remainingWork:z.array(checkpointText).max(30),evidence:z.array(checkpointText).max(30),validation:z.array(z.object({name:checkpointText,status:z.enum(['PASS','FAIL','BLOCKED','NOT_RUN']),evidence:checkpointText})).max(30)},(a,o)=>leader.checkpoint(o,a.teamId,a.revision,a));
nativeTool('record_team_message_delivery','记录 Leader 观察到的宿主发送结果；不是成员已读。保留原始消息与审计。',{...editTeam,messageId:z.string().uuid(),status:z.enum(['host-accepted','unknown','failed']),note:z.string().min(1).max(2000)},(a,o)=>leader.messageDelivery(o,a.teamId,a.revision,a.messageId,a.status,a.note));
nativeTool('reconcile_team_message','核对原始成员轮次的公开消息回执；精确匹配才能记录成员确认，不重发消息。',{...editTeam,messageId:z.string().uuid()},(a,o)=>leader.reconcileMessage(o,a.teamId,a.revision,a.messageId));
nativeTool('claim_team_task','Leader 为就绪任务预留唯一 attempt，返回必要上下文与原生成员派发提示。不启动成员；主会话随后使用宿主 spawn/followup 工具，原样携带 marker。重试同一预留返回同一 attempt。',{...editTeam,taskId:id},(a,o)=>leader.claim(o,a.teamId,a.revision,a.taskId));
nativeTool('claim_team_tasks','一次预留 1–8 个独立就绪任务，返回 dispatches。逐项检查依赖、成员、资源、写范围与并发，全部成功才提交；失败无部分预留。单个任务同样可使用此工具。不启动模型。',{...editTeam,taskIds:z.array(id).min(1).max(8)},(a,o)=>leader.claimMany(o,a.teamId,a.revision,a.taskIds));
nativeTool('bind_team_member','把宿主原生 subagent 绑定到任务。threadId 接受宿主返回的成员路径或线程 ID；验证父会话、项目目录和唯一公开 attempt 回执，拒绝无关聊天和旧轮次。绑定失败应重试读取，不能重新创建成员。',{...nativeAttempt,threadId:z.string().min(1).max(200)},(a,o)=>leader.bind(o,a.teamId,a.revision,a.taskId,a.attemptId,a.threadId));
nativeTool('bind_team_members','批量绑定已派发的当前任务轮次。并行读取每个真实成员，核对 Leader、项目、唯一 marker 后一次提交，失败无部分绑定。返回 titleActions；保留原成员，不重新 spawn。',{...editTeam,assignments:z.array(z.object({taskId:id,attemptId:z.string().uuid(),threadId:z.string().min(1).max(200)})).min(1).max(8)},(a,o)=>leader.bindMany(o,a.teamId,a.revision,a.assignments));
nativeTool('settle_team_task','Leader 收到原生成员完成通知后读取终态与公开结果，形成提交。不会自动验收或派发后续任务。',nativeAttempt,(a,o)=>leader.settle(o,a.teamId,a.revision,a.taskId,a.attemptId));
nativeTool('accept_team_review','Leader 根据不同成员的已提交审查决定接受或返工。接受必须有审查者 PASS 证据；不能把执行结束当作通过。',{...nativeAttempt,decision:z.enum(['accept','rework']),note:z.string().min(1).max(3000),nonValidationFailures:z.array(z.object({commandIndex:z.number().int().min(0),reason:z.string().min(1).max(2000)})).max(30).default([])},(a,o)=>leader.acceptReview(o,a.teamId,a.revision,a.taskId,a.attemptId,a.decision,a.note,a.nonValidationFailures));
nativeTool('finish_team','主会话完成最终项目验收后记录结论。检查证据标为 Leader 提供；不伪称插件自动验证，也不执行文件写回。',{...editTeam,note:z.string().min(1).max(3000),checks:z.array(z.object({name:z.string().min(1),status:z.enum(['PASS','FAIL','BLOCKED','NOT_RUN']),evidence:z.string().min(1).max(4000)})).min(1).max(50)},(a,o)=>leader.finish(o,a.teamId,a.revision,a.note,a.checks));
nativeTool('release_team_reservation','仅当 Leader 已确认宿主没有启动该 attempt 时释放未绑定预留。若启动结果不明，保留预留并核对，不得重派。',{...nativeAttempt,note:z.string().min(1).max(2000)},(a,o)=>leader.release(o,a.teamId,a.revision,a.taskId,a.attemptId,a.note));

registerAppTool(server, 'open_host_probe', {
  title: '宿主连接验证',
  description: '打开 Team Workspace 原型验证面板，读取已有实验状态；打开本身不会启动或恢复 Agent。',
  inputSchema: {}, annotations: readOnly,
  _meta: { ui: { resourceUri: URI }, 'openai/ui': { entrypoints: [{ type: 'thread' }] } }
}, async (_args, extra) => {
  let runs=[];
  if(extra?._meta?.threadId || extra?._meta?.thread_id) runs=await runtime.list(runtime.scope(extra._meta));
  return result({...snapshot(extra),runs});
});

registerAppTool(server, 'read_execution_probe', {
  description:'只读当前宿主会话的原型执行记录，不创建进程或恢复 Agent。',inputSchema:{},annotations:readOnly,
  _meta:{ui:{visibility:['app']}}
},async(_args,extra)=>result({observedAt:new Date().toISOString(),runs:await runtime.list(runtime.scope(extra._meta))}));

const mutations=[
  ['start_execution_probe','启动固定隔离 fixture 的真实 Agent 验证。仅在用户明确授权原型执行和账号用量后调用。','start'],
  ['message_execution_probe','向本会话测试成员发送固定的监督验证消息，正在运行时 steer，空闲时开启新轮次。','message'],
  ['begin_stop_trial','显式启动一个有时间和轮次上限的停止测试，随后应请求停止。','stopTrial'],
  ['stop_execution_probe','请求中断当前测试轮次；只有执行端完成事件才能确认中断。','stop']
];
for(const [name,description,method] of mutations) registerAppTool(server,name,{
  title:description,inputSchema:method==='start'?{}:{runId:z.string().uuid()},description,
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:method==='stop',openWorldHint:true},
  _meta:{ui:{resourceUri:URI}}
},async(args,extra)=>{
  try {return result({observedAt:new Date().toISOString(),runs:[await runtime[method](runtime.scope(extra._meta),args.runId)]});}
  catch(e){return {isError:true,content:[{type:'text',text:e.message}]};}
});

registerAppTool(server, 'probe_roundtrip', {
  title: '验证面板工具往返', description: '回传一次性随机标记及 MCP 客户端能力名称；不读写项目，不执行模型。',
  inputSchema: { nonce: z.string().regex(/^[a-f0-9-]{36}$/) }, annotations: readOnly,
  _meta: { ui: { resourceUri: URI, visibility: ['app'] } }
}, async ({ nonce }, extra) => result({ ...snapshot(extra), nonce }));

registerAppResource(server, 'host-probe', URI, {}, async () => ({ contents: [{
  uri: URI, mimeType: RESOURCE_MIME_TYPE,
  text: await readFile(join(__dirname, 'host.html'), 'utf8'),
  _meta: {
    ui: { csp: { connectDomains: [], resourceDomains: [] } },
    'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['fullscreen'] }
  }
}] }));

server.connect(new StdioServerTransport()).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
// No listeners/autostart. Only explicit start creates the owned app-server child.
// EOF requests interruption and closes that child. Never resume on reload.
let closing=false;
async function shutdown(){if(closing)return;closing=true;try{await hostContext.close();await leader.close();await engine.close();await runtime.close();await server.close();}finally{process.exit(0);}}
process.stdin.once('end',()=>void shutdown());
process.once('SIGTERM',()=>void shutdown());
