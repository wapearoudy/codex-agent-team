---
name: team-workspace
description: 在当前 Codex 对话中运行或查看原生 subagent 团队，由主会话担任 Leader，管理计划确认、依赖、独立审查和真实执行面板。
---

# Team Workspace 0.15.1

当前主会话是 Leader，沿用当前项目、用户目标和已有授权。每个项目一个固定团队，岗位身份固定，同一时刻仅有一个当前执行会话。已结算任务的下一次派发使用独立原生会话，旧线程保留为只读历史；活动或未知轮次不能替换。插件保存业务协议并观察原生记录，不启动另一个协调模型。只查看时调用 open_team_workspace / read_team，不派发工作。

## 工具入口

模型常用入口为 open_team_workspace、get_current_project、read_team、team_command、team_leader 和 team_member。其他业务工具名保留兼容，但在模型工具目录中收敛为两个按角色使用的入口。

- Leader：team_leader(operation="describe", toolName="plan_team") 按需获取单个参数 schema；随后 team_leader(operation="plan_team", arguments={...}) 调用。同一方法适用于下文所有 Leader 业务工具名称。directory 返回操作目录，不要一次读取所有 schema。
- 成员：team_member 按相同方法调用自身任务、检查点和队友通信操作。成员不能调用 Leader 操作、验收结果或扩大范围；运行时会校验原生身份。
- 用户明确输入 `/agent-teams [--profile NAME] GOAL` 时可用 team_command 解析并读取现有团队/模板。该协议入口不是宿主已注册的斜杠菜单，不能宣称提供原生命令槽位。
- 不为正常团队工作调用开发 probe、独立执行器或原型模型工具。

## 规划与确认

先读取当前项目团队。已有团队用 add_team_tasks 追加范围内的工作；岗位不足用 add_team_members，不重建团队。仅用户明确要求重组时使用 rebuild_project_team，先停止并接收旧成员终态。跨 Leader 不修改 owner 冒充接管，使用 read_project_team_takeover 返回原 Leader 入口。

为每项交付配置一项由不同成员执行的独立 review，审查岗位 writeScopes=[]，review 依赖原交付 submitted，后续业务依赖独立验收 accepted。职责/写范围用于调度和冲突检查，不是操作系统沙箱。默认 on-demand：首个就绪任务直接创建对应岗位，后续按任务隔离执行上下文；不先创建整队空闲成员。

plan_team 保存完整目标、岗位、任务图、验收和预算。复杂新团队先确认具体计划；用户明确授权“直接做”可用 immediate 并记录原话。required 始终先审阅。read_team_plan 展示完整计划，revise_team_plan 修改草案并产生新版本；approve_team_plan / cancel_team_plan 必须绑定用户实际审阅的 version/hash 和稳定 UUID。初始待确认时不得初始化、领取、启动成员或准备 worktree。已有确认和普通任务授权不用重复询问。

新增岗位、扩大范围或提高并发/预算用 propose_team_change 暂存，批准前不应用；原已授权工作继续。语义范围扩大由 Leader 识别，不可用普通追加绕过确认。面板批准后核对保存的版本，再继续，不要求再次批准。

收到 TEAM_WORKSPACE_PLAN_FEEDBACK 或 read_team_plan.review.feedback 时，保留当前待确认草案，结束当前规划，询问需要修改的内容并等待用户回复。不得自行批准、创建替代团队或继续扩写方案。取消草案后等待新的明确请求。

## 执行与自动推进

claim_team_tasks 批量预留当前就绪任务；使用返回的 prompt、taskName、spawnOptions 调用宿主原生 spawn_agent 或 followup_task。严格按照 action 和 taskName 执行：spawn-native-member 使用返回的唯一 taskName 与 fork_turns=none；followup-native-member 只用于该派发包指向的现有会话。contextIsolation.generation 标识同一岗位的会话代次，不得把新任务发给 contextHistory 中已退役线程。保存稳定 attemptId，返回真实 ID/路径后立即 bind_team_members；标题按 titleActions 设置。结果未知先核对，不重复启动；只有确认未启动才能 release_team_reservation。宿主批量调用部分成功时只绑定成功部分。

模型与档位来自实际宿主目录。显式配置和宿主默认继承的 model/provider/effort 快照纳入计划；未知字段保留未知。spawnOptions 是本次真实创建参数，记录 provider 不等于宿主支持任意 provider 切换。备用模型只可使用计划中已批准的 fallbackRoute；本宿主不能原地修改已有会话的模型；任务隔离创建的新会话仍沿用已批准路由，不能借隔离绕过模型变更确认。

收到成员完成通知后，用 advance_team_workflow 一次接收观察到的终态；dispatchReady=true 可预留下一批。接续仍调用宿主原生工具。独立审查和最终验收必须由 Leader 明确判断，禁止自动接受。

新版计划获批后默认启用面板 coordinate_team 通知桥，用户可关闭；旧团队保持原设置。收到 TEAM_WORKSPACE_WORKFLOW:<id> 时先 coordinate_team(operation="consume", notificationId=id) 核对；stale/replayed 不重复执行。有效时读取返回 revision，调用 advance_team_workflow，处理必要独立审查并派发就绪批次，随后使用宿主等待能力让出轮次。通知只代表需要协调，不代表完成或用户批准。不要忙轮询，不重复转述已交付结果。

通知桥依赖面板打开及宿主 ui/message；面板关闭继续依赖宿主成员通知。unknown 不自动重发；投递途中关闭面板留下的 reserved 超时后可核对状态，用户显式重试时使用原通知 ID，旧通知失效。consume 是收到通知的回执，不是业务执行成功；中断接续仍读取真实工作流。

## 审查、停止与恢复

成员公开输出必须包含当前 TEAM_WORKSPACE_ATTEMPT 标记。report_member_team_task 只存草稿/检查点；Leader 核对宿主终态后 settle，交付才能 submitted。审查返回结构化 decision、checks、findings，所有条目有实际证据。存在 blocker/high、未覆盖目标或失败的验收命令时不能 accept。accept_team_review 保留明确判断，失败后返工保留全部尝试、用量和历史。autoRepair 只生成修复/复审任务，受轮次上限控制，不自动启动或验收。

合同修订必须带原因、稳定 UUID 和 patch，保存前后值及版本。运行中先停止并核实，已提交先返工；通过独立验收的合同冻结，扩大需求另建交付并确认范围。成员申报 changedPaths 不能代替 Leader 检查实际 diff。

stop_team(reason,requestId) 先保存 stopping，随后 Leader 原生 interrupt 全部绑定成员，包括初始化。未知预留先核对，已启动先 bind，明确未启动才 release。reconcile_team_stop 核对最新轮次，未知保持 stopping，全部核实才 halted；随后结束本轮工作。resume_team 必须记录明确恢复原因，retryTaskIds 仅重试选择的停止/失败任务，保留预算，不恢复取消任务。start 不能绕过停止。

read_team_recovery 只读取恢复包。原生成员控制能力需用宿主真实工具验证，再 record_team_recovery_control；失去句柄时暂停派发。完整重启后的控制恢复、跨 Leader 转移、直接中断主会话受宿主公开接口限制；不另建执行器或伪造可控状态。

## 组建后调整角色目标

用户可通过成员卡片的铅笔图标或管理入口直接修改角色目标（responsibility）。聊天中明确要求修改时，先 manage_team(operation="member-goal", teamId, memberId) 读取完整当前目标与 goalRevision，再 update_team_member_goal 带 team revision、goalRevision、稳定 requestId 和用户修改说明保存。不得自行改写用户目标；目标调整不改岗位名称/身份、写范围、任务目标、验收条件或当前执行会话，不自动启动成员或发送通知。扩大任务范围仍使用原有范围变更协议。

新目标从后续派发生效；已有预留或执行中的 attempt 保留原目标快照。保存结果未知时用原 requestId 与相同内容核对重试；目标版本冲突先保留草稿并重新读取，不覆盖他人修改。查看目标仅返回该岗位的当前原文及最近 10 次修订，不批量读取所有岗位历史。首次调整后数据最低版本为 0.15.0。

## 记录、模板与面板

contextChars 限制完整派发提示，包含固定指令、目标、验收、合同与历史摘要；超限不会保存预留，不可手工截断要求后继续。历史依赖/检查点按引用读取，任务完成后输出最终交付并结束，不在旧上下文领取下一项工作。

read_team 默认有界摘要，面板使用 state/panel，完整交付和历史按任务 read_team_handoff/read_team_context 或显式 full。精简回执不是原始验收证据。保持任务、成员、轮次和阅读位置，不自动全量加载日志。query_team_tasks 使用版本绑定游标；manage_team 的 history 只读浏览同一项目和当前 Leader 的归档，不切换控制权。

save_team_profile 支持 seed 固定任务图和 leader 岗位/约束动态规划。动态模板先返回规划请求，设计带独立审查的 DAG 再提交待审计划；constraints 随任务保留。模板使用不能替换已有固定团队。删除模板绑定已读取的 updatedAt，冲突先刷新。

所有交付独立验收后运行本任务所需的整体验证，用 finish_team 记录真实 checks/证据。用户要求“最后统一验收”时，先完成实现和工程必要检查，将整体验收放到功能补齐后，不以未验证状态宣称完成。

0.14.3 可核对标准 shell 包装的完整验证命令。已有 submitted 交付因旧版命令匹配被拒时，保留当前 attempt，在核对原独立审查后重试 accept_team_review；验收会重新检查该 attempt 保存的宿主命令，不需要重新 settle、返工或重派。仍缺少成功命令、独立审查或后续验证时保持待验收，不修改历史证据绕过门禁。

仅在需要检查点字段、消息回执、worktree 集成、导航或旧数据迁移时读取 [详细协议](references/protocol-details.md) 的相关部分。外部消息授权仍限用户任务范围，禁止把团队内部协调扩展为给他人聊天或外部服务发消息。
