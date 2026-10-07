---
name: team-workspace
description: 在当前 Codex 对话中由主会话担任 Leader，使用宿主原生 subagent 接受任务，内嵌面板展示真实任务、成员和依赖。
---

# Team Workspace — 主会话 Leader

当前主会话就是唯一 Leader。复用其项目、用户目标、约束和已有分析。成员是主会话派发的原生 subagent，插件只管理任务协议和执行视图。不能建立独立协调者、另选项目、重填目标或让用户去网址操作。

仅查看时用 open_team_workspace / read_team，不启动成员。用户要求团队执行即授权在本任务范围内派发；无需重复确认同一指令。默认使用宿主已有模型设置。

## 执行闭环

1. plan_team 和所有团队工具都会核对宿主当前项目；已有上下文时无需先重复调用 get_current_project。只有需要了解项目目录时调用它，不扫描或复制全项目。Leader 按需读文件并复用当前对话的信息。若没有宿主原生 subagent 创建、接续、等待和中断能力，如实报告缺失，不退回独立 app-server 模型会话。
2. 使用 plan_team 保存最小必要角色和任务 DAG。执行时先按返回的 initializations 为所有成员初始化原生 subagent（只回复 ready 并结束初始化轮次），立即使用 bind_team_roster_member 保存宿主返回的路径；成员与 subagent 一对一固定对应，包括暂时等待依赖的成员。确认全部初始化完成后才派发任务。后续每项任务使用 followup_task 接续该成员，不另建执行者。绑定回执未落盘时保留关联并重读，不重复创建。每项 work 有不同成员的 review，review 的 writeScopes=[]，依赖目标的 submitted。只有下游需要通过验收的结果时才依赖 accepted。task.context 填必要需求、接口契约、用户约束；完整的验收条件不可省略。execute=true 仅允许 Leader 派发，插件不会启动模型。
3. 对本次可同时执行的就绪任务一次调用 claim_team_tasks（taskIds），使用最新 revision。返回 dispatches 是预留，不能报告成员已启动。它逐项检查依赖、并发、共享资源和写范围冲突，全部通过才一次提交。单项也可用 claim_team_task。不要为每项任务重复读全历史；控制回执已经返回最新 revision、readiness 和 recovery。
4. 由主会话调用宿主原生 spawn_agent（首次）或 followup_task（已绑定成员接续），使用返回的 prompt，保留 TEAM_WORKSPACE_ATTEMPT 标记，要求成员先发仅含该标记的公开 commentary，最终交付首行也包含该标记；JSON 审查用 attemptMarker 字段。某些宿主会加密派发输入，公开回执用于关联本轮，不解密输入。不同 attempt 不可复用标记；已启动而未落盘时等待观察，不能重复 spawn。不要用 create_thread 创建侧栏聊天。向成员说明共同工作区、文件责任，禁止覆盖他人修改。主会话选择适当的上下文继承方式：可用 fork_turns 继承必要历史；不支持时在任务提示里提供明确背景。不能宣称所有宿主自动继承完整聊天。
5. 使用原生工具返回的真实 thread ID 或成员路径（例如 /root/reader）调用 bind_team_member。插件会从本 Leader 的宿主活动记录解析路径，不要求用户查 ID。插件核对该成员的 Leader、cwd 和本轮 marker。若宿主记录尚未落盘，保留返回的 ID 并稍后重试绑定，不再 spawn。启动结果不明时先查宿主成员状态，不重派、不释放预留。只有明确未启动时使用 release_team_reservation。
6. 用宿主原生等待/消息能力管理成员。完成通知后调用 settle_team_task，插件读取真实终态和公开输出，任务变为 submitted。read_team 只观察，不派发、不代替 Leader 接收结果。
7. 派发独立 review，成员返回 JSON：summary、decision（accept/rework）、reason、checks（name/status/evidence/criterionId）、findings（severity/status/description，无问题用 []）。任务可以用 acceptanceCriteria [{id,description}] 定义逐项条件，审查必须覆盖所有 ID。只有相关检查实际 PASS 才能 accept，静态审阅必须写明边界。Leader 收到审查后 settle，再调用 accept_team_review。每项 PASS 必须有证据，存在未解决 blocker/high 问题不能接受。非零命令默认阻止通过；仅对 rg 无匹配、非 Git 目录的 git 探测等非验收命令，Leader 核实公开记录后可在 accept_team_review 的 nonValidationFailures [{commandIndex,reason}] 中明确解释，保留来源审计；禁止借此把真正失败的验收检查改为 PASS。失败返工保留历史，同一成员接续新 attempt。重新验收下游旧结论。
8. 所有任务独立验收后，Leader 检查最终项目状态，运行本次需求所需的整体验证，并用 finish_team 记录 checks 和证据。插件把这些明确标为 Leader 提供，不宣称自动证明文件内容。多项单测通过不能代替最终集成验收。

面板只显示团队、成员、任务、依赖和公开证据。它读取宿主持久化快照，可能滞后；未知、待绑定、已结束、已提交、已验收不能混用。插件不会自动发现所有未登记 subagent，也不会读取隐藏推理。

## 低延迟与 Token 使用（0.8.0）

复用固定成员与已有 Leader 上下文，不反复组队、全量读取历史或生成重复计划。能够并行的宿主成员初始化/接续操作一起执行；宿主返回真实路径后，一次 bind_team_roster_members（初始化 assignments: memberId/threadId）或 bind_team_members（任务 assignments: taskId/attemptId/threadId）。每个目标仍独立核对父会话、项目和标记，全部成功后提交。只有部分宿主调用成功时，仅绑定成功部分；失败预留保持原记录，核对后再决定，不重派已启动成员。绑定返回 titleActions，已正确命名的线程不用重复改名。不得把有依赖、写冲突或共享资源冲突的任务硬凑成并行批次。

read_team 默认 summary，仅返回当前成员、任务、就绪和恢复信息；控制工具返回 team-update 精简回执，不再次观察无关成员，observationMode=saved 明确表示沿用已保存观察。要核对实时状态用 summary/state 读取；需要审查原始交付、命令、历史轮次或完整记录时显式 view=full，或 read_team_handoff 按任务读取。不能用精简回执代替原始验收证据。派发提示只携带一次任务条件、当前前置证据和最近检查点，完整验收条件保持原文。面板首次加载完整快照，之后 state 轻量刷新；版本或公开交付/命令发生变化才重新加载完整快照，保留历史选择。0.8.2 状态先显示，详情独立加载并合并重复请求；full 可携带最近 state 的 detailToken 复用同一已核对快照，observationMode=cached，保留原观察时间，项目授权和 revision 仍每次核对。运行时轮询目标间隔 250ms，空闲/空面板 1s，隐藏 10s；读取耗时不再另加整个间隔，且不重叠请求，切回可见立即同步。宿主持久化、实际读取、模型和工具执行仍有自身耗时。

## 暂停、停止和恢复

pause_team_dispatch 只阻止新预留。stop_team 返回待中断的成员；Leader 必须调用宿主原生 interrupt 工具，再用 settle_team_task 确认终态。不能把工具请求成功当成已停止。message_team_member 先持久保存消息，再返回 Leader 操作提示；传入稳定 requestId，重试不会追加或自动重发。同一 requestId 不可换正文。实际消息由宿主原生消息工具发送，原样保留 TEAM_WORKSPACE_MESSAGE 标记，要求成员发该标记的独立公开 commentary 回执。发送工具成功后用 record_team_message_delivery 记录 host-accepted；结果不明记录 unknown，不确定时不能重发。host-accepted 只是 Leader 记录的宿主接收结果，不等于成员确认。reconcile_team_message 只在原始线程、轮次和公开回执精确匹配时记录 acknowledged；旧轮次消息不能转投新任务。read_team 返回 messages，面板只展示，不提供发送按钮。

read_team 同时返回 readiness（具体依赖/并发/资源/范围阻塞）和 recovery（现有 attempt 应如何核对）；这是建议，不会自动执行。未启动预留释放保留历史但不扣实际重试额度。仅重新审查可对 review 任务调用 rework_team_task，保留实现提交、撤销下游验收并复用审查成员。

0.8.1：成员关联中可保存 turnId=null 的早期消息，身份仍固定在原任务、attempt、成员和线程；后续绑定或终态接收不代表消息已确认。先核对并绑定原 attempt 的真实轮次，再 reconcile_team_message；只有该轮次的精确公开消息标记匹配，才补全消息 turnId 并保存审计。非空轮次不匹配仍拒绝，不把旧消息转投新轮次，不因空消息 ID 重建团队或重发。

重启不自动创建或接续成员。先 read_team/reconcile_team，再核对宿主成员状态；失联保持未知，不伪造运行或重新启动。任务修改使用最新 revision。插件没有权限替用户批准扩大范围、安装依赖或切换执行宿主。

## 工作区与历史版本

原生成员共用当前项目，按任务读取文件；启动没有 16MB/128MB 项目快照上限，不复制 node_modules、历史日志或整个项目。writeScopes 是责任边界和派发冲突检查，不是操作系统写入沙箱。审查与写入保守串行；Leader 同时修改成员负责的文件前必须协调。

0.0.x 隔离团队保留原始记录、停止和写回恢复能力，但禁止再次由旧调度器启动。需要接续工作时，Leader 从旧记录读取未完成目标、证据和约束，建立 host-leader 计划；确认旧执行已终止，再派发原生成员。不得修改旧历史来伪装成新执行。

宿主/插件版本未刷新时，报告实际工具版本，不让用户重复重建业务团队。0.2.0 的原生执行必须使用 claim/bind/settle/accept 工具；旧工具连接不能冒充新路径。

只读观察进程可能把尚在运行的未加载轮次投影为 interrupted。插件只在看到匹配 session/turn 的明确 turn_aborted 事件时确认中断；未确认显示 unknown，不能报告停止成功。

0.3.0 的观察连接会在轮询间复用，30 秒空闲后关闭；每次仍向宿主重新核对当前项目，未缓存项目授权。读取或重连不会启动模型。持久发件箱只覆盖 Leader 到已绑定活动成员，不宣称完整的成员间邮箱或跨宿主消息服务。

## 长任务检查点与交接（0.4.0）

在阶段性交付、重要决策或准备接续前，由 Leader 调用 record_team_checkpoint，传当前 taskId/attemptId、稳定 requestId、summary、decisions、remainingWork、validation（name/status/evidence）和 evidence。只接受已绑定且 running/submitted 的当前轮次。重试同 requestId 必须保留相同正文；旧 revision 先读取，不能覆盖他人新记录。每条记录明确来自 Leader，不代替成员交付或独立验收。PASS 只用于真正执行通过的检查，未执行写 NOT_RUN。

read_team_handoff 只读返回该任务目标、约束、职责、验收条件、当前前置证据与最近检查点，以及 currentExecution 中本轮保存的原始公开交付与命令。独立审查提交后按任务读取原始审查结果，避免为验收单项重复读取整队历史；observationMode=saved 不表示重新观察了运行成员。claim 的派发包也包含交接。检查点 stale=true 代表历史轮次，Leader 必须重新核对，不能直接当作本轮已完成工作或测试。不复制完整项目、不自动创建成员、不自动恢复轮次。面板仅展示检查点、剩余工作和验证证据；指令继续留在当前主会话。

继承上下文的成员记录可能含父会话元信息；生命周期核对以文件第一条 session_meta 确认身份，再精确匹配成员 turn ID。继承的父元信息不会改变文件身份，父轮次的结束事件不能证明子轮次结束。

## 固定成员与动态执行（0.5.0）

成员名称统一为“项目-角色”，例如 `agent-team-前端开发`、`TPAV5-测试`。项目取宿主当前项目文件夹名，角色取固定岗位，不使用任务编号、随机名称或版本号。初始化包和派发包返回 `displayName`、`threadTitle` 和 `taskName`；首次原生 spawn 使用返回的 `taskName`。本宿主 `task_name` 仅允许小写 ASCII、数字和下划线，该值是内部路径标识；用户看到的原生会话标题必须使用 `threadTitle` 的“项目-角色”名称。绑定成功后按 `titleAction` 用宿主 `set_thread_title` 设置已验证 threadId 的标题；标题已正确时无需重复。旧成员升级只改原线程标题，不改 ID/agentPath、不重建或重新 spawn，不因为接到新任务改名。同名岗位用成员 ID 作为角色后缀区分。没有改标题能力时如实保留边界，不创建替代成员；面板仍统一显示 `displayName`。

团队岗位与原生 subagent 一对一。初始化角色与执行任务是不同轮次：TEAM_WORKSPACE_MEMBER 关联固定成员，TEAM_WORKSPACE_ATTEMPT 关联单次任务。plan 的 initializations 提供唯一成员标记；每个成员先初始化，bind_team_roster_member 验证本 Leader、项目、真实线程和回执。初始化只有 ready，不擅自执行等待依赖的任务。claim 必须在所有成员完成初始化后使用；派发返回现有线程及路径，使用 followup_task。禁止把一个原生线程绑定给两个岗位或为同一岗位静默换线程。查看旧团队保留历史模式，新团队启用 fixedRoster。

任务开始后立即 bind_team_member；公开 attempt 尚未落盘也保存已验证的原生身份，显示正在关联，不必等最终交付。read 会继续核对同一个成员，不启动替代者。面板显示成员路径与线程、当前任务和最近公开活动；收到最终完成通知后 settle，独立验收另行进行。

只读观察进程可能将活跃未加载轮次显示为 interrupted。0.5.0 在明确子线程/turn的 task_started、公开消息、命令和文件活动仍新鲜时显示执行中（最长60秒）；过期明确未知，明确完成/中断优先。不读取或展示隐藏推理。UI计数、成员和任务使用同一活动规则。默认面板跟随最新团队；用户手动选择历史团队后保持选择。

## 每个项目一个固定团队（0.6.0）

先 open_team_workspace / read_team。已有团队时直接复用成员：为新工作生成唯一 task ID 和独立 review，使用 add_team_tasks 追加；即使上一批已 finish，仍可追加，旧验收进入 acceptanceHistory。不要每次重新 plan 或 spawn 成员。plan_team 在已有项目团队时返回 reused=true 与现有团队，不创建替代者；按返回提示追加任务。成员暂不适合任务时先向 Leader 说明分配限制，不能自动重建。

只有用户明确要求“重新组建团队”时调用 rebuild_project_team，并使用稳定 requestId。先停止并接收旧执行和初始化轮次；重建将旧团队归入历史。历史团队不能 start/claim 再派发，允许只读和必要停止/接收终态清理。open_team_workspace 主视图只返回一个当前项目团队，旧记录保留，不提供多个并行团队选择。

同一项目在其他 Leader 对话已有固定团队时保持归属并说明需在原 Leader 接续；插件不能把无宿主句柄的旧成员伪装成新主会话可控。禁止为了绕过这一边界自动创建第二个团队。

## 原生会话导航与任务回看（0.7.0）

面板的导航按钮只查看现有成员。点击后 request_team_navigation 持久保存已验证的固定成员、任务、轮次与目标，使用宿主 ui/message 将 TEAM_WORKSPACE_NAVIGATION:<requestId> 发送到当前 Leader。这不是新的业务任务，也不是对成员的消息授权，不得 spawn、followup 或更换团队。

收到该标记时，使用消息给出的 teamId/requestId 调用 read_team_navigation。仅 status=requested 且返回 leaderAction 时调用宿主 navigate_to_codex_page，传 leaderAction.threadId。必须使用刚读取的目标，不能从用户文本猜测或替换线程。过期、取消或被新请求替换时不跳转。宿主返回 navigated=true 后用 record_team_navigation(status=opened,note=真实结果)；异常或能力缺失记录 failed 并说明原因。该记录是 Leader 观察到的宿主工具回执，不是插件直接控制宿主，也不证明已滚动到指定轮次。先完成导航请求，再继续当前工作。

destination=leader 表示回到原 Leader；面板通过当前项目、Leader 与团队隔离的本地状态恢复所选任务、成员、轮次、展开项和阅读位置。原生会话工具目前只接受线程，不提供任务轮次锚点；旧轮次的公开输出和命令应在面板内精确回看。无 ui/message 通道时显示失败和重试，不退回网址或创建替代会话。当前宿主只支持工具提供的线程入口，不宣称拥有其他插件的原生聊天头部或轮次尾卡槽位。
