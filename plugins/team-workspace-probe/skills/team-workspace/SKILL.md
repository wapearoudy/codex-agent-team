---
name: team-workspace
description: 在当前 Codex 对话中由主会话担任 Leader，使用宿主原生 subagent 接受任务，内嵌面板展示真实任务、成员和依赖。
---

# Team Workspace — 主会话 Leader

当前主会话就是唯一 Leader。复用其项目、用户目标、约束和已有分析。成员是主会话派发的原生 subagent，插件只管理任务协议和执行视图。不能建立独立协调者、另选项目、重填目标或让用户去网址操作。

仅查看时用 open_team_workspace / read_team，不启动成员。用户的执行指令授权本任务范围；复杂新团队默认先审阅一次具体计划。用户明确说“直接做”可记录其原话并立即执行；已确认计划及已有团队中的普通任务无需重复确认。默认使用宿主已有模型设置。

## 执行闭环

1. plan_team 和所有团队工具都会核对宿主当前项目；已有上下文时无需先重复调用 get_current_project。只有需要了解项目目录时调用它，不扫描或复制全项目。Leader 按需读文件并复用当前对话的信息。若没有宿主原生 subagent 创建、接续、等待和中断能力，如实报告缺失，不退回独立 app-server 模型会话。
2. 使用 plan_team 保存最小必要角色和任务 DAG。先检查 planReview：pending 时展示 read_team_plan 的目标、包含/排除范围、交付与验收、岗位理由、模型/并发/预算，等待用户确认，不创建或初始化成员。用户之后在聊天说“按这个做”等，即以实际用户原话调用 approve_team_plan，传当前 planVersion、planHash 和稳定 requestId；不再要求点面板。不要把首次“执行”请求当成尚未展示计划的批准。approved 后默认 memberStartup=on-demand：先 claim 就绪任务，首次用完整任务包创建其负责成员，再 bind；没有就绪任务的岗位暂不创建，不发送仅回复 ready 的额外轮次。后续任务复用同一原生线程。memberStartup=eager 或升级前已有团队保留先初始化路径：按 initializations 创建并绑定成员，完成后派发；追加岗位只影响自己的任务。初始化被停止后，resume 会保留旧初始化记录并返回同线程的 followup 提示和新 marker，不能另建成员。绑定回执未落盘时保留关联并重读，未知启动结果不重复 spawn/followup。每项 work 有不同成员的 review，review 的 writeScopes=[]，依赖目标的 submitted。只有下游需要通过验收的结果时才依赖 accepted。task.context 填必要需求、接口契约、用户约束；完整的验收条件不可省略。execute=true 仅允许 Leader 派发，插件不会启动模型。
3. 对本次可同时执行的就绪任务一次调用 claim_team_tasks（taskIds），使用最新 revision。返回 dispatches 是预留，不能报告成员已启动。它逐项检查依赖、并发、共享资源和写范围冲突，全部通过才一次提交。单项也可用 claim_team_task。不要为每项任务重复读全历史；控制回执已经返回最新 revision、readiness 和 recovery。
4. 由主会话调用宿主原生 spawn_agent（首次）或 followup_task（已绑定成员接续），使用返回的 prompt 和 spawnOptions，保留 TEAM_WORKSPACE_ATTEMPT 标记，要求成员先发仅含该标记的公开 commentary，最终交付首行也包含该标记；JSON 交付/审查用 attemptMarker 字段。某些宿主会加密派发输入，公开回执用于关联本轮，不解密输入。不同 attempt 不可复用标记；已启动而未落盘时等待观察，不能重复 spawn。不要用 create_thread 创建侧栏聊天。向成员说明共同工作区、文件责任，禁止覆盖他人修改。首次默认 fork_turns=none，以派发包传递必要背景；模型/推理档位仅使用明确配置的 route。接续不能清空已有原生线程上下文，不为省 token 静默换成员。
5. 使用原生工具返回的真实 thread ID 或成员路径（例如 /root/reader）调用 bind_team_member。插件会从本 Leader 的宿主活动记录解析路径，不要求用户查 ID。插件核对该成员的 Leader、cwd 和本轮 marker。若宿主记录尚未落盘，保留返回的 ID 并稍后重试绑定，不再 spawn。启动结果不明时先查宿主成员状态，不重派、不释放预留。只有明确未启动时使用 release_team_reservation。
6. 用宿主原生等待/消息能力管理成员。完成通知后调用 settle_team_task，插件读取真实终态和公开输出，任务变为 submitted。read_team 只观察，不派发、不代替 Leader 接收结果。
7. 派发独立 review，成员返回 JSON：summary、decision（accept/rework）、reason、checks（name/status/evidence/criterionId）、findings（severity/status/description，无问题用 []）。任务可以用 acceptanceCriteria [{id,description}] 定义逐项条件，审查必须覆盖所有 ID。只有相关检查实际 PASS 才能 accept，静态审阅必须写明边界。Leader 收到审查后 settle，再调用 accept_team_review。每项 PASS 必须有证据，存在未解决 blocker/high 问题不能接受。非零命令默认阻止通过；仅对 rg 无匹配、非 Git 目录的 git 探测等非验收命令，Leader 核实公开记录后可在 accept_team_review 的 nonValidationFailures [{commandIndex,reason}] 中明确解释，保留来源审计；禁止借此把真正失败的验收检查改为 PASS。失败返工保留历史，同一成员接续新 attempt。重新验收下游旧结论。
8. 所有任务独立验收后，Leader 检查最终项目状态，运行本次需求所需的整体验证，并用 finish_team 记录 checks 和证据。插件把这些明确标为 Leader 提供，不宣称自动证明文件内容。多项单测通过不能代替最终集成验收。

面板只显示团队、成员、任务、依赖和公开证据。它读取宿主持久化快照，可能滞后；未知、待绑定、已结束、已提交、已验收不能混用。插件不会自动发现所有未登记 subagent，也不会读取隐藏推理。

## 低延迟与 Token 使用（0.8.0）

复用固定成员与已有 Leader 上下文，不反复组队、全量读取历史或生成重复计划。能够并行的宿主成员初始化/接续操作一起执行；宿主返回真实路径后，一次 bind_team_roster_members（初始化 assignments: memberId/threadId）或 bind_team_members（任务 assignments: taskId/attemptId/threadId）。每个目标仍独立核对父会话、项目和标记，全部成功后提交。只有部分宿主调用成功时，仅绑定成功部分；失败预留保持原记录，核对后再决定，不重派已启动成员。绑定返回 titleActions，已正确命名的线程不用重复改名。不得把有依赖、写冲突或共享资源冲突的任务硬凑成并行批次。

read_team 默认 summary，仅返回当前成员、任务、就绪和恢复信息；控制工具返回 team-update 精简回执，不再次观察无关成员，observationMode=saved 明确表示沿用已保存观察。要核对实时状态用 summary/state 读取；需要审查原始交付、命令、历史轮次或完整记录时显式 view=full，或 read_team_handoff 按任务读取。不能用精简回执代替原始验收证据。派发提示只携带一次任务条件、当前前置证据和最近检查点，完整验收条件保持原文。面板首次与详情变更时读取 view=panel 有界预览（最多 256 KiB），不自动读取完整历史。预览最多 80 项任务、每任务最近 10 轮、40 条执行快照，优先未完成任务与当前执行，省略处明确标记；不能代替原始验收证据。state 轻量刷新；状态先显示，详情独立加载并合并重复请求，保留历史选择。panel/full 可携带最近 state 的 detailToken 复用同一已核对快照，observationMode=cached，保留原观察时间，项目授权和 revision 仍每次核对。实际成员执行中轮询目标间隔 250ms，已结束待接收、空闲/空面板 1s，隐藏 10s；读取耗时不另加整个间隔，且不重叠请求，切回可见立即同步。宿主持久化、实际读取、模型和工具执行仍有自身耗时。

## 暂停、停止和恢复

pause_team_dispatch 只阻止新预留。stop_team 必须传 reason 和稳定 requestId，先保存 stopping 并返回全部绑定成员（包括初始化）和未知预留。Leader 调用宿主原生 interrupt；已启动的预留先 bind，明确未启动的预留才能 release_team_reservation。使用 reconcile_team_stop 核对每个成员最新宿主轮次终态；未知仍为 stopping，全部核实后为 halted。绑定但未发出的派发仅在 Leader 已核实后以 unstartedTaskIds 和 note 记录释放。完成停止核实后结束 Leader 当前工作轮次，不继续实现或派发。resume_team 仅从 halted 恢复，必须写 reason；retryTaskIds 明确选中的停止/失败任务才转为 waiting，不自动恢复取消任务，也不重置预算。start_team 不能绕过停止状态。面板保存请求后通知主会话，通知失败保留记录并提示回主会话接续；按钮成功不代表宿主已停止。message_team_member 先持久保存消息，再返回 Leader 操作提示；传入稳定 requestId，重试不会追加或自动重发。同一 requestId 不可换正文。实际消息由宿主原生消息工具发送，原样保留 TEAM_WORKSPACE_MESSAGE 标记，要求成员发该标记的独立公开 commentary 回执。发送工具成功后用 record_team_message_delivery 记录 host-accepted；结果不明记录 unknown，不确定时不能重发。host-accepted 只是 Leader 记录的宿主接收结果，不等于成员确认。reconcile_team_message 只在原始线程、轮次和公开回执精确匹配时记录 acknowledged；旧轮次消息不能转投新任务。read_team 返回 messages，面板只展示，不提供发送按钮。

read_team 同时返回 readiness（具体依赖/并发/资源/范围阻塞）和 recovery（现有 attempt 应如何核对）；这是建议，不会自动执行。未启动预留释放保留历史但不扣实际重试额度。仅重新审查可对 review 任务调用 rework_team_task，保留实现提交、撤销下游验收并复用审查成员。

0.8.1：成员关联中可保存 turnId=null 的早期消息，身份仍固定在原任务、attempt、成员和线程；后续绑定或终态接收不代表消息已确认。先核对并绑定原 attempt 的真实轮次，再 reconcile_team_message；只有该轮次的精确公开消息标记匹配，才补全消息 turnId 并保存审计。非空轮次不匹配仍拒绝，不把旧消息转投新轮次，不因空消息 ID 重建团队或重发。

重启不自动创建或接续成员。先 read_team/reconcile_team，再核对宿主成员状态；失联保持未知，不伪造运行或重新启动。任务修改使用最新 revision。插件没有权限替用户批准扩大范围、安装依赖或切换执行宿主。

## 工作区与历史版本

原生成员共用当前项目，按任务读取文件；启动没有 16MB/128MB 项目快照上限，不复制 node_modules、历史日志或整个项目。writeScopes 是责任边界和派发冲突检查，不是操作系统写入沙箱。审查与写入保守串行；Leader 同时修改成员负责的文件前必须协调。

0.0.x 隔离团队保留原始记录、停止和写回恢复能力，但禁止再次由旧调度器启动。需要接续工作时，Leader 从旧记录读取未完成目标、证据和约束，建立 host-leader 计划；确认旧执行已终止，再派发原生成员。不得修改旧历史来伪装成新执行。

宿主/插件版本未刷新时，报告实际工具版本，不让用户重复重建业务团队。0.2.0 的原生执行必须使用 claim/bind/settle/accept 工具；旧工具连接不能冒充新路径。

只读观察进程可能把尚在运行的未加载轮次投影为 interrupted。插件只在看到匹配 session/turn 的明确 turn_aborted 事件时确认中断；未确认显示 unknown，不能报告停止成功。

0.3.0 的观察连接会在轮询间复用，30 秒空闲后关闭；每次仍向宿主重新核对当前项目，未缓存项目授权。读取或重连不会启动模型。0.9.0 在 Leader 发件箱之外增加同一团队的成员收件箱，仍不提供跨宿主消息服务。

## 长任务检查点与交接（0.4.0）

在阶段性交付、重要决策或准备接续前，由 Leader 调用 record_team_checkpoint，传当前 taskId/attemptId、稳定 requestId、summary、decisions、remainingWork、validation（name/status/evidence）和 evidence。只接受已绑定且 running/submitted 的当前轮次。重试同 requestId 必须保留相同正文；旧 revision 先读取，不能覆盖他人新记录。record_team_checkpoint 的来源为 Leader；成员自己的 report_member_team_task 来源为 authenticated-member。两者都不代替宿主终态或独立验收。PASS 只用于真正执行通过的检查，未执行写 NOT_RUN。

read_team_handoff 只读返回该任务目标、约束、职责、验收条件、当前前置证据与最近检查点，以及 currentExecution 中本轮保存的原始公开交付与命令。独立审查提交后按任务读取原始审查结果，避免为验收单项重复读取整队历史；observationMode=saved 不表示重新观察了运行成员。claim 的派发包也包含交接。检查点 stale=true 代表历史轮次，Leader 必须重新核对，不能直接当作本轮已完成工作或测试。不复制完整项目、不自动创建成员、不自动恢复轮次。面板仅展示检查点、剩余工作和验证证据；指令继续留在当前主会话。

继承上下文的成员记录可能含父会话元信息；生命周期核对以文件第一条 session_meta 确认身份，再精确匹配成员 turn ID。继承的父元信息不会改变文件身份，父轮次的结束事件不能证明子轮次结束。

## 固定成员与动态执行（0.5.0）

成员名称统一为“项目-角色”，例如 `agent-team-前端开发`、`TPAV5-测试`。项目取宿主当前项目文件夹名，角色取固定岗位，不使用任务编号、随机名称或版本号。初始化包和派发包返回 `displayName`、`threadTitle` 和 `taskName`；首次原生 spawn 使用返回的 `taskName`。本宿主 `task_name` 仅允许小写 ASCII、数字和下划线，该值是内部路径标识；用户看到的原生会话标题必须使用 `threadTitle` 的“项目-角色”名称。绑定成功后按 `titleAction` 用宿主 `set_thread_title` 设置已验证 threadId 的标题；标题已正确时无需重复。旧成员升级只改原线程标题，不改 ID/agentPath、不重建或重新 spawn，不因为接到新任务改名。同名岗位用成员 ID 作为角色后缀区分。没有改标题能力时如实保留边界，不创建替代成员；面板仍统一显示 `displayName`。

团队岗位与原生 subagent 一对一。初始化角色与执行任务是不同轮次：TEAM_WORKSPACE_MEMBER 关联固定成员，TEAM_WORKSPACE_ATTEMPT 关联单次任务。plan 的 initializations 提供唯一成员标记；每个成员先初始化，bind_team_roster_member 验证本 Leader、项目、真实线程和回执。初始化只有 ready，不擅自执行等待依赖的任务。claim 必须在所有成员完成初始化后使用；派发返回现有线程及路径，使用 followup_task。禁止把一个原生线程绑定给两个岗位或为同一岗位静默换线程。查看旧团队保留历史模式，新团队启用 fixedRoster。

任务开始后立即 bind_team_member；公开 attempt 尚未落盘也保存已验证的原生身份，显示正在关联，不必等最终交付。read 会继续核对同一个成员，不启动替代者。面板显示成员路径与线程、当前任务和最近公开活动；收到最终完成通知后 settle，独立验收另行进行。

只读观察进程可能将活跃未加载轮次显示为 interrupted。0.5.0 在明确子线程/turn的 task_started、公开消息、命令和文件活动仍新鲜时显示执行中（最长60秒）；过期明确未知，明确完成/中断优先。不读取或展示隐藏推理。UI计数、成员和任务使用同一活动规则。默认面板跟随最新团队；用户手动选择历史团队后保持选择。

## 每个项目一个固定团队（0.6.0）

先 open_team_workspace / read_team。已有团队时直接复用成员：为新工作生成唯一 task ID 和独立 review，使用 add_team_tasks 追加；即使上一批已 finish，仍可追加，旧验收进入 acceptanceHistory。不要每次重新 plan 或 spawn 成员。plan_team 在已有项目团队时返回 reused=true 与现有团队，不创建替代者；按返回提示追加任务。已有岗位不足以处理用户目标时使用 add_team_members 追加所需岗位，不能自动重建。

只有用户明确要求“重新组建团队”时调用 rebuild_project_team，并使用稳定 requestId。先停止并接收旧执行和初始化轮次；重建将旧团队归入历史。历史团队不能 start/claim 再派发，允许只读和必要停止/接收终态清理。open_team_workspace 主视图只返回一个当前项目团队，旧记录保留，不提供多个并行团队选择。

同一项目在其他 Leader 对话已有固定团队时保持归属并说明需在原 Leader 接续；插件不能把无宿主句柄的旧成员伪装成新主会话可控。禁止为了绕过这一边界自动创建第二个团队。

## 追加岗位（0.9.3）

用户要求新增岗位，或已授权任务需要当前团队尚不具备的职责时，调用 `add_team_members`，传当前 `teamId`、最新 `revision`、稳定 UUID `requestId` 和 `members`。每个岗位有唯一 `id`、`role`、`responsibility`、`reason`、`writeScopes`，仅在用户明确配置时传 `route`。团队总人数最多 8；审查岗位 `writeScopes=[]`。使用唯一岗位 ID，不通过改旧成员 ID、覆盖原线程或重建团队腾位置。

工具仅登记新岗位，不启动模型、不追加业务任务，也不解除已有暂停或撤销之前的验收。`memberAddition.memberIds` 标识本次新增岗位。按 `initializations` 只为尚未绑定的新岗位创建原生 subagent（只回复 ready），立即 `bind_team_roster_members` 保存真实路径，并按 titleActions 设置名称。已存在 `threadId` 或 action=observe-existing-member 时继续核对原成员，禁止再次 spawn。完成初始化后使用 `add_team_tasks` 追加任务与独立 review，再 claim/followup 原成员线程。

同一请求重试保留原 `requestId` 与配置；已提交的请求即使携带旧 revision 也会返回原岗位和标记。相同 `requestId` 改配置会被拒绝。并发扩岗造成 revision 冲突时先读取最新状态再重试原请求，不能改 ID 重复追加。批量失败不登记部分岗位。原成员执行、任务历史、固定团队身份和项目归属保持；新增岗位未初始化只阻止分配给它的任务，初始团队仍须先全员初始化。

## 原生会话导航与任务回看（0.7.0）

面板的导航按钮只查看现有成员。点击后 request_team_navigation 持久保存已验证的固定成员、任务、轮次与目标，使用宿主 ui/message 将 TEAM_WORKSPACE_NAVIGATION:<requestId> 发送到当前 Leader。这不是新的业务任务，也不是对成员的消息授权，不得 spawn、followup 或更换团队。

收到该标记时，使用消息给出的 teamId/requestId 调用 read_team_navigation。仅 status=requested 且返回 leaderAction 时调用宿主 navigate_to_codex_page，传 leaderAction.threadId。必须使用刚读取的目标，不能从用户文本猜测或替换线程。过期、取消或被新请求替换时不跳转。宿主返回 navigated=true 后用 record_team_navigation(status=opened,note=真实结果)；异常或能力缺失记录 failed 并说明原因。该记录是 Leader 观察到的宿主工具回执，不是插件直接控制宿主，也不证明已滚动到指定轮次。先完成导航请求，再继续当前工作。

destination=leader 表示回到原 Leader；面板通过当前项目、Leader 与团队隔离的本地状态恢复所选任务、成员、轮次、展开项和阅读位置。原生会话工具目前只接受线程，不提供任务轮次锚点；旧轮次的公开输出和命令应在面板内精确回看。无 ui/message 通道时显示失败和重试，不退回网址或创建替代会话。当前宿主只支持工具提供的线程入口，不宣称拥有其他插件的原生聊天头部或轮次尾卡槽位。


## 0.9.0 协作补强

- advance_team_workflow 返回有限动作和明确决策的结果；原生接续/消息/中断继续由 Leader 调用。不得循环读取完整历史、自动接受审查或超出 maxAttempts 重试。批量派发与绑定后等待实际进展。
- 成员仅在当前已绑定任务内用 send_team_peer_message 发给登记队友或 Leader，稳定 requestId 去重。本技能授权任务范围内的队友协调；使用返回的 nativeAction 调用原生 send_message，再 record_team_peer_sender_delivery 记录实际结果。不得向其他聊天或外部人员发送消息。结果未知不重发；读自己的 read_team_inbox 后对原消息 acknowledge_team_peer_message。Leader 保持派发和验收权。保存、host-accepted、acknowledged 分开记录。
- configure_team_policy 配置 tokenLimit/contextChars/maxAttempts；read_team_usage 显式核对原生历史用量。未知数据不记零，预算仅阻止新派发，不虚报费用或自动中断成员。摘要压缩不得改写目标、接口契约和验收条件；超出 contextChars 明确报告，完整前置证据用 read_team_handoff/read_team_context 检索。
- save_team_profile / plan_team_from_profile 保存与使用角色、任务、模型路线及预算。已有项目仍复用固定团队，模板不能成为自动重建或更换成员入口。
- prepare_team_worktree 为闲置写入成员配置隔离目录，保留同一原生线程及 Leader cwd。成员所有命令和写入使用 workspace.path；审查者独立读取候选目录，不能将主目录旧代码当候选。交付独立验收且成员停止写入后，integrate_team_worktree 仅预检并暂存合并；Leader 完整验证后明确提交。失败保留工作区/日志，不清理、强制重置或重复合并。
- read_team_recovery 核对原记录并给出交接；Leader 用实际原生工具回执 record_team_recovery_control。只读记录不等于句柄可控。跨 Leader 用 read_project_team_takeover 返回原 Leader 入口；宿主不能转移原生父关系，不能改 owner 冒充移交。
- 搜索用 query_team_tasks，后续页传 nextCursor；版本或筛选改变须从首页重查。export_team_report 只导出公开数据。校验分卷保留总历史，当前未完成任务 40/成员 8 是调度限制。0.9.0 首次写入旧团队备份原文并拒绝旧连接写入；不要降级、删除分卷或因旧连接报错重建业务团队。安装版本和驻留连接版本分别核对。

## 0.10.0 质量合同与成员生命周期

新计划可声明 goalCriteria [{id,description}]，任务用 contract {stage,inScope,outOfScope,verify,coverageOf} 关联目标与检查。stage 为 requirements/implementation/verification/review/repair/integration；仍用 kind=work/review 保持独立审查。合同任务必须有 acceptanceCriteria；实施/修复的 inScope 不得超出成员 writeScopes，execute 模式须声明验证命令，source-only 不得宣称执行命令。已登记需求阶段全部独立验收后才能派发其他合同工作。目标覆盖仅核对已声明条目，不能替代 Leader 从用户需求判断是否遗漏。

合同工作交付 JSON：attemptMarker、summary、changedPaths、acceptanceResults [{criterionId,status,evidence}]、commandsRun、limitations。每个验收 ID 都要有实际结果；verify 的原样命令必须通过宿主命令工具执行，模型写在 commandsRun 中不能算成功。失败/未运行结果可提交供审查，但不能接受。范围核对的是申报路径，Leader 仍须检查实际 diff，特别是共享目录里的并发修改。

configure_team_policy 可设置 autoRepair=true、maxReviewRounds=3（含首次审查，1–10）。仅在 Leader 接收并确认结构化 rework 后创建修复与不同成员的复审，不自动启动模型。原任务/审查置为被替代的历史，supersededBy 指向新任务，下游依赖指向新修复/复审；旧证据不作废删除。findings 用稳定 id/severity/status/description；resolved 还须 resolutionEvidence。严重问题不能遗漏或降低严重度绕过，独立复审必须按同一 ID 明确关闭。轮次超限暂停并升级给 Leader；不要用改派重置 attempts 或自动无限返工。

reassign_team_task 用 taskId/memberId/note/稳定 requestId 改派 waiting/blocked 任务。running 先停止并 settle；submitted/accepted 先显式 rework。原执行身份固化到 attempt.memberId，原消息、检查点和用量保持归属；旧结果不能接收到新轮次。改派不复制或合并旧 worktree 修改，必要时先由 Leader 核对交接与候选。remove_team_member 只移除无未完成任务且宿主最新轮次确认空闲的成员，不删除原生线程或历史。移除释放活跃岗位名额（最多 8），旧 ID 不复用；不能给移除岗位分配任务或继续发送协调消息。升级后重启宿主再控制团队，勿让旧驻留连接操作新版状态。

## 0.11.0 计划确认与范围变更

- plan_team / rebuild_project_team / plan_team_from_profile 使用 approvalMode=auto（默认）/required/immediate。auto 对有质量合同或目标覆盖、多个写入岗位、至少三个交付任务或至少四个成员的新团队先确认；简单明确任务沿用已有执行授权。execute=false 始终只保存草案；required 始终等待。immediate 必须来自用户明确要求直接执行，并将实际指令记录为 executionAuthorization。
- read_team_plan 按需读完整配置和版本摘要。revise_team_plan 原子修改未启动初始草案，或替换待确认扩展配置，保留最近 20 版原文，递增版本与内容 hash。每项 work 仍须一个独立 review；不能绕过依赖、岗位或范围校验。面板可编辑目标、职责、验收，完整 JSON 可增删岗位、调整依赖、模型和预算。
- approve_team_plan / cancel_team_plan 绑定当前 planVersion、planHash、revision 和稳定 requestId，拒绝过期确认，重试不重复派发。聊天确认由 Leader 如实记录为 leader-recorded-user-confirmation；面板点击记录为 panel-user-action。此来源是协议审计记录，工具本身不独立验证用户聊天原文。确认仅授权执行，不是验收。
- 待确认初始计划没有 initializations，不允许 start/claim/bind/worktree 准备。取消保留草案和版本历史；普通 plan_team 不会静默重建。用户明确要求重新组建时才用 rebuild_project_team。
- 原团队内明确、在原授权范围内的新增任务、普通调度和独立复审沿用授权。新增岗位、目标/范围实质扩大、提高并发或执行预算用 propose_team_change；add_team_members 和提高额度的 configure_team_policy 自动暂存提案。add_team_tasks 的 scopeChange=true 或分配给待批准岗位时也暂存。语义上的目标扩展由 Leader 识别并明确标注，不能用普通追加绕过确认。
- 待确认扩展不应用成员、任务或额度变化，原成员仍可继续。可继续把新岗位任务加入该提案；每次编辑递增版本，旧确认失效。批准后原子应用；取消只丢弃该提案。不会因普通修复重复打断用户。
- 面板确认先持久保存，再向主会话发送继续请求。通知失败不会撤销确认或自动重发；返回主会话继续即可。插件不直接启动模型，Leader 须核对版本确认仍有效后用原生成员工具继续。
- 带确认流程的记录最低版本为 0.11.0，0.10.0 连接会在写入前拒绝。既有团队普通任务保持原授权；首次提出岗位、范围或预算扩展时建立既有授权基线并暂存提案，仍不改变原成员身份或正在执行的任务。

## 0.12.0 合同修订、动态模板与成员自主推进

amend_team_task_contract 仅由 Leader 使用，传 taskId、稳定 requestId、reason 和 patch（goal/acceptance/acceptanceCriteria/contract）。运行中先停止并接收终态，已提交先 rework；已通过独立验收的合同冻结，需要新需求时增加新交付。修订记录旧值、新值和递增版本，旧下游证据失效并暂停派发；重新核对范围后显式 start/resume。不得用修订弱化用户要求或绕过扩大范围的确认。原证据与尝试预算全部保留。完整修订历史在 read_team(view=full) 中。

read_team_model_catalog 从宿主 model/list 读取实际模型及支持档位，不使用静态猜测；显式路由在计划保存和确认时核对。显式选模型但未选档位时，计划保存其当时默认档位，纳入用户审阅的 hash；完全未配置 route 时沿用宿主，实际绑定时记录模型，无法观察的档位保留未知。面板先点“读取宿主模型目录”再选择模型和档位。修改计划的岗位、任务、负责人、依赖和预算均有表单，保存后产生新版本，旧确认失效。

save_team_profile 的 taskPlanning=seed 保存完整任务模板；taskPlanning=leader 只保存 members、constraints 和 policy，不保存固定 tasks。plan_team_from_profile 未传 tasks 时只返回规划请求，不创建空团队；Leader 根据当前目标设计含独立审查的 DAG，再传 tasks 建立可审阅计划。不得忽略模板 constraints；它们随实际任务规划和初始 brief 保留。

真实成员可 read_member_team_work 查看自己的分配。Leader 已完成上一轮 settle 并唤醒该成员后，成员可 claim_member_team_task（只限自己的就绪任务，稳定 UUID 去重），公开发出 marker，再 bind_member_team_task 绑定当前原生线程，直接在当前轮次工作，不自行 spawn/followup。report_member_team_task 保存自己的进度与可选交付草稿，来源标为 authenticated-member；最终仍须公开输出交付。报告不直接改为 submitted：只有宿主真实终态经 Leader settle 后提交，再由另一名成员独立审查，Leader 决定验收。没有常驻后台模型或自动验收器；跨轮唤醒继续由宿主和 Leader 负责。
