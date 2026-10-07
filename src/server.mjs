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

const URI = 'ui://team-workspace-probe/0.8.6/host.html';
const bootId = randomUUID();
const startedAt = new Date().toISOString();
const server = new McpServer({ name: 'team-workspace-probe', version: '0.8.6' });
const runtime = new PrototypeRuntime();
const engine=new TeamEngine({root:process.env.TEAM_WORKSPACE_DATA_ROOT});
const leader=new LeaderEngine({root:process.env.TEAM_WORKSPACE_DATA_ROOT,store:engine.store});
const projectTeams=new ProjectTeams(leader);
const navigation=new TeamNavigation({root:leader.root,store:engine.store,observer:leader.observer});
const panelSnapshot=new PanelSnapshot();
const readTeam=async(o,id)=>(await engine.store.get(id,o)).mode==='host-leader'?leader.read(o,id):engine.read(o,id);
async function route(method,o,id,revision,...rest){
 const t=await engine.store.get(id,o);
 if(t.revision!==revision)throw new Error('Team changed; refresh before controlling members');
 if(!['stop','pause','reconcile','recoverIntegration'].includes(method)){const current=await projectTeams.current(o,{cwd:t.projectPath});if(current&&current.id!==id)throw new Error('Historical team is read-only; assign work to the project’s current team');}
 if(t.mode!=='host-leader'){if(method==='start')throw new Error('旧隔离团队已停用启动；保留记录和停止/恢复能力。请由当前 Leader 创建原生成员计划。');return engine[method](o,id,revision,...rest);}
 if(method==='reconcile')return leader.receipt(o,id);
 if(['integrate','recoverIntegration'].includes(method))throw new Error('原生成员直接在当前项目工作，无副本写回操作；请完成独立审查与 Leader 最终验收。');
 if(['edit','cancel'].includes(method)){await engine[method](o,id,revision,...rest);return leader.receipt(o,id);}
 return leader[method](o,id,revision,...rest);
}
const owner=extra=>runtime.scope(extra?._meta);
// Only field names, never metadata values, credentials, prompts or file content.
function snapshot(extra) {
  const peer = server.server.getClientVersion();
  return {
    kind: 'host-connection-probe', pluginVersion:'0.8.6', productReady: false,
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
  return {content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};
};
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const guarded=fn=>async(args,extra)=>requestContext.run(async()=>{try{return result(await fn(args,extra));}catch(error){return {isError:true,content:[{type:'text',text:error.message}]};}});
const teamId={teamId:z.string().uuid()};
const editTeam={...teamId,revision:z.number().int().positive()};
const id=z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const planSchema=z.object({members:z.array(z.object({id,role:z.string().min(1).max(100),responsibility:z.string().min(1).max(2000),reason:z.string().min(1).max(1000),writeScopes:z.array(z.string().min(1).max(300)).max(30)})).min(1).max(8),tasks:z.array(z.object({id,title:z.string().min(1).max(200),goal:z.string().min(1).max(3000),context:z.string().max(12000).optional(),acceptance:z.string().min(1).max(3000),acceptanceCriteria:z.array(z.object({id,description:z.string().min(1).max(2000)})).min(1).max(30).optional(),memberId:id,priority:z.number().int().min(1).max(5),kind:z.enum(['work','review']).default('work'),validationMode:z.enum(['execute','source-only']).default('execute'),reviewOfTaskId:id.optional(),parentTaskId:id.optional(),resources:z.array(z.string().min(1).max(100)).max(20).default([]),dependencies:z.array(z.object({taskId:id,when:z.enum(['submitted','accepted'])})).max(40)})).min(1).max(40)});
const hostContext=new HostContext();
const requestContext=new RequestContext(meta=>hostContext.resolve(meta));
const currentProject=extra=>requestContext.project(extra);
async function assertCurrentTeam(extra,teamId){return authorizeTeam({owner:owner(extra),context:await currentProject(extra),store:engine.store,teamId});}
registerAppTool(server,'open_team_workspace',{title:'团队',description:'打开当前 Codex 项目、当前会话关联的团队监管面板。项目来自宿主线程元数据，不要求重新选择项目或填写目标，不启动成员。',inputSchema:{},annotations:readOnly,_meta:{ui:{resourceUri:URI},'openai/ui':{entrypoints:[{type:'thread'}]}}},guarded(async(_,extra)=>{
  const context=await currentProject(extra),current=await projectTeams.current(owner(extra),context),teams=current?[current]:[];
  return{kind:'team-workspace',version:'0.8.6',context,teams:teams.map(t=>({id:t.id,goal:t.goal,state:t.state,revision:t.revision,updatedAt:t.updatedAt})),observedAt:new Date().toISOString(),productReady:false};
}));
registerAppTool(server,'get_current_project',{title:'读取当前项目上下文',description:'自动读取触发此工具的 Codex 会话项目目录及必要说明。协调者直接沿用当前对话目标；不得要求用户去面板重选项目或重填需求。不会启动模型成员。',inputSchema:{},annotations:readOnly,_meta:{ui:{visibility:['model']}}},guarded(async(_,extra)=>({context:await currentProject(extra),executionMode:'host-leader',projectScan:false,instructions:'当前主会话就是 Leader。使用当前项目和已有对话上下文；按任务读取必要文件。'})));
registerAppTool(server,'plan_team',{title:'组建当前项目团队',description:'直接用当前对话中用户已给出的目标和当前 Codex 项目组队。先调用 get_current_project 了解项目，再按实际需要生成成员和任务图。每项交付有独立审查。用户明确要求执行时设置 execute=true，保存后由当前主会话通过原生 subagent 工具派发，插件本身不启动模型；只要求计划时 execute=false。不要再要求选项目、重填目标或重复点开始。',inputSchema:{goal:z.string().min(8).max(2000),plan:planSchema,maxParallel:z.number().int().min(1).max(8).default(3),execute:z.boolean().default(false),requestId:z.string().uuid().optional()},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true},_meta:{ui:{resourceUri:URI}}},guarded(async(args,extra)=>{
  const o=owner(extra),context=await currentProject(extra),{team,reused}=await projectTeams.plan(o,context,args);
  return {kind:'team-detail',...await leader.receipt(o,team.id),reused,requestedGoal:args.goal,leaderAction:reused?'Reuse this fixed project team. Add the new work and its independent review with add_team_tasks, then assign tasks to the existing members. Rebuild only at the user’s explicit request.':args.execute?'Initialize every fixed member using initializations and bind_team_roster_members, then claim ready tasks together and follow up the same native members. No model has been launched by plan_team.':null};
}));
registerAppTool(server,'rebuild_project_team',{description:'仅在用户明确要求重新组建团队时调用。要求旧成员全部停止并接收终态；归档旧团队并创建替代固定成员团队。普通新任务应 add_team_tasks 复用现有团队。',inputSchema:{goal:z.string().min(8).max(2000),plan:planSchema,maxParallel:z.number().int().min(1).max(8).default(3),execute:z.boolean().default(true),requestId:z.string().uuid()},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{resourceUri:URI,visibility:['model']}}},guarded(async(args,extra)=>{const o=owner(extra),context=await currentProject(extra),{team}=await projectTeams.rebuild(o,context,args);return {kind:'team-detail',...await leader.read(o,team.id)};}));
registerAppTool(server,'read_team',{description:'只读团队状态。默认 summary 返回当前成员、任务、就绪与恢复建议；state 用于面板轻量刷新；需要完整历史、公开交付或命令时明确传 full。面板可传最近 state 的 detailToken 读取同一已核对快照；当前项目授权和 revision 仍每次重新核对。不启动模型或恢复执行。',inputSchema:{...teamId,view:z.enum(['summary','state','full']).default('summary'),detailToken:z.string().regex(/^[a-f0-9]{64}$/).optional()},annotations:readOnly,_meta:{ui:{visibility:['app','model']}}},guarded(async(args,extra)=>{
 const o=await assertCurrentTeam(extra,args.teamId);
 if(args.view==='full'&&args.detailToken){
   const saved=await engine.store.get(args.teamId,o),cached=panelSnapshot.read(o,args.teamId,saved.revision,args.detailToken);
   if(cached)return teamResponse(cached,'full');
 }
 const data=await readTeam(o,args.teamId);
 if(data.team.mode!=='host-leader')return {kind:'team-detail',...data,detailToken:'legacy-full'};
 const projected=teamResponse(data,args.view);if(args.view==='state')panelSnapshot.save(o,data,projected.detailToken);return projected;
}));
registerAppTool(server,'request_team_navigation',{title:'定位原生成员会话',description:'保存用户点击的原生成员查看请求，核对当前Leader、项目、固定成员和指定任务轮次；返回主会话宿主导航操作，不创建或启动成员。',inputSchema:{...teamId,memberId:id,taskId:id.optional(),attemptId:z.string().uuid().optional(),destination:z.enum(['member','leader']).default('member'),requestId:z.string().uuid()},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{visibility:['app','model']}}},guarded(async(a,e)=>navigation.request(await assertCurrentTeam(e,a.teamId),await currentProject(e),a)));
registerAppTool(server,'read_team_navigation',{description:'核对面板导航请求仍为当前项目、最新有效目标；过期/替换的请求不能执行。只读，不启动模型。',inputSchema:{...teamId,requestId:z.string().uuid()},annotations:readOnly,_meta:{ui:{visibility:['app','model']}}},guarded(async(a,e)=>navigation.read(await assertCurrentTeam(e,a.teamId),await currentProject(e),a.teamId,a.requestId)));
registerAppTool(server,'cancel_team_navigation',{description:'用户离开所选任务或成员时取消尚未执行的导航请求；不停止团队或成员。',inputSchema:{...teamId,requestId:z.string().uuid()},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{visibility:['app','model']}}},guarded(async(a,e)=>navigation.cancel(await assertCurrentTeam(e,a.teamId),await currentProject(e),a.teamId,a.requestId)));
registerAppTool(server,'record_team_navigation',{description:'Leader实际调用宿主导航工具后记录成功或失败；成功是宿主工具回执，不伪称已定位到任务轮次。面板不能自行报告宿主已打开。',inputSchema:{...teamId,requestId:z.string().uuid(),status:z.enum(['opened','failed']),note:z.string().min(1).max(2000)},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{visibility:['model']}}},guarded(async(a,e)=>navigation.record(await assertCurrentTeam(e,a.teamId),await currentProject(e),a)));
for(const [name,method,title] of [['start_team','start','开始执行计划'],['pause_team_dispatch','pause','暂停新任务派发'],['stop_team','stop','请求停止团队轮次'],['integrate_team','integrate','将全部已验收候选写回项目'],['reconcile_team','reconcile','核对已保存的执行状态，不恢复轮次'],['recover_team_integration','recoverIntegration','回退中断的写回；保留外部新改动，不自动重新写回']])registerAppTool(server,name,{title,description:`${title}。原生团队由当前主会话控制；开始仅允许 Leader 派发，不启动后台调度。仅在用户通过当前对话明确授权后执行；旧版本号请求拒绝，未知状态不自动重试。`,inputSchema:editTeam,annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true},_meta:{ui:{resourceUri:URI,visibility:['model']}}},guarded(async(args,extra)=>({kind:'team-detail',...await route(method,await assertCurrentTeam(extra,args.teamId),args.teamId,args.revision)})));
registerAppTool(server,'message_team_member',{description:'原生团队持久保存消息并返回 Leader 原生发送提示；requestId 重试去重。保存不是送达，未知结果不自动重发。旧团队沿用其执行端。',inputSchema:{...editTeam,taskId:id,text:z.string().min(1).max(3000),requestId:z.string().uuid().optional()},annotations:{readOnlyHint:false,openWorldHint:true},_meta:{ui:{visibility:['model']}}},guarded(async(a,e)=>({kind:'team-detail',...await route('message',await assertCurrentTeam(e,a.teamId),a.teamId,a.revision,a.taskId,a.text,a.requestId)})));
registerAppTool(server,'edit_team_task',{description:'修改尚未开工任务的分配、优先级或依赖，保留历史并重新校验任务图。',inputSchema:{...editTeam,taskId:id,patch:z.object({memberId:id.optional(),priority:z.number().int().min(1).max(5).optional(),dependencies:z.array(z.object({taskId:id,when:z.enum(['submitted','accepted'])})).optional()})},annotations:{readOnlyHint:false,openWorldHint:false},_meta:{ui:{visibility:['model']}}},guarded(async(a,e)=>({kind:'team-detail',...await route('edit',await assertCurrentTeam(e,a.teamId),a.teamId,a.revision,a.taskId,a.patch)})));
registerAppTool(server,'add_team_tasks',{description:'新任务追加到项目固定团队并分配给已有成员；保留历史和独立审查，允许已交付团队接受新任务。',inputSchema:{...editTeam,tasks:planSchema.shape.tasks},annotations:{readOnlyHint:false,openWorldHint:false},_meta:{ui:{visibility:['model']}}},guarded(async(a,e)=>({kind:'team-detail',...await route('addTasks',await assertCurrentTeam(e,a.teamId),a.teamId,a.revision,a.tasks)})));
registerAppTool(server,'cancel_team_task',{description:'取消尚未开工的任务及其尚未开工下游，保留历史；已有执行记录时拒绝伪装取消。',inputSchema:{...editTeam,taskId:id,note:z.string().min(1).max(1000)},annotations:{readOnlyHint:false,openWorldHint:false},_meta:{ui:{visibility:['model']}}},guarded(async(a,e)=>({kind:'team-detail',...await route('cancel',await assertCurrentTeam(e,a.teamId),a.teamId,a.revision,a.taskId,a.note)})));
registerAppTool(server,'rework_team_task',{description:'用户明确要求返工时调用；保留所有历史和预算，使下游结论失效。仍运行或未知的相关成员必须先停止并核对。不会自动开工。',inputSchema:{...editTeam,taskId:id,note:z.string().min(1).max(2000)},annotations:{readOnlyHint:false,openWorldHint:false},_meta:{ui:{visibility:['model']}}},guarded(async(a,e)=>({kind:'team-detail',...await route('rework',await assertCurrentTeam(e,a.teamId),a.teamId,a.revision,a.taskId,a.note)})));

const nativeAttempt={...editTeam,taskId:id,attemptId:z.string().uuid()};
const checkpointText=z.string().trim().min(1).max(2000);
registerAppTool(server,'read_team_handoff',{description:'只读当前任务的目标、职责、前置证据和最新检查点，明确历史轮次；不启动或恢复成员。',inputSchema:{...teamId,taskId:id},annotations:readOnly,_meta:{ui:{visibility:['model']}}},guarded(async(a,e)=>{const {team,handoff}=await leader.handoff(await assertCurrentTeam(e,a.teamId),a.teamId,a.taskId);return {kind:'team-handoff',team:{id:team.id,revision:team.revision,projectPath:team.projectPath,leaderThreadId:team.leaderThreadId},handoff};}));
const nativeTool=(name,description,inputSchema,fn)=>registerAppTool(server,name,{description,inputSchema,annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{visibility:['model']}}},guarded(async(a,e)=>{const o=await assertCurrentTeam(e,a.teamId),t=await engine.store.get(a.teamId,o),current=await projectTeams.current(o,{cwd:t.projectPath});if(current&&current.id!==a.teamId&&!['settle_team_task','release_team_reservation','reconcile_team_message'].includes(name))throw new Error('Historical team is read-only; use the project’s current team');return {kind:'team-detail',...await fn(a,o)};}));
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
