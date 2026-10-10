---
name: team-workspace
description: 在当前 Codex 对话中运行或查看原生 subagent 团队，由主会话担任 Leader，管理计划确认、依赖、独立审查和真实执行面板。
---

# Team Workspace 0.32.0

当前主会话担任 Leader，沿用项目、用户目标和已有授权。插件只保存协议、校验证据和观察原生执行，不启动协调模型。只查看时调用 open_team_workspace / read_team，不派发。普通工作按下文推进；仅操作恢复、补登记、合同、模板、归档等功能时按标题读取 [协议细则](references/protocol-details.md)，不预先加载整份参考。

## 入口与确认

模型入口为 open_team_workspace、get_current_project、read_team、team_command、team_leader、team_member。Leader/成员用对应 router 的 operation=<业务工具名>、arguments={...}。操作回执默认只含协调状态和受影响任务；需要显示预览才显式 responseView=summary，完整证据仍按任务读取。模型入口返回以 structuredContent 为正文，content 仅作回执；调用方输出 result.structuredContent ?? result.content 一次，不复制两份。参数未知才 describe(toolName)，同一 operation/pluginVersion 复用 schema；需核对缓存时带 schemaHash，相同指纹返回 unchanged。上下文已丢失则不带 hash 重新取 schema，不能假设缓存存在；directory 仅列目录。不调用开发 probe 或原型执行器。

每个项目一个固定团队；已有团队追加任务，岗位不足按变更流程新增，不自行重建或跨 Leader 接管。初次 plan_team 的 plan.tasks 留空，只确认团队目标、成员、职责、写范围和模型设置。用户明确“直接做”可 immediate 并保存原话；否则保存 required/auto 草案后展示 read_team_plan 并等待用户确认。approve/cancel 绑定实际审阅的 version/hash 和稳定 UUID，不能自行批准。待确认不启动成员或准备 worktree；修改产生新版本。feedback 保留草案并等待用户说明，不创建替代团队。

确认后 workflow.stage=task-planning：add_team_tasks 在确认范围内拆解交付与独立 review，不逐项要求用户确认 task。review 由不同成员执行，writeScopes=[]，依赖目标 submitted；后续业务依赖 accepted。空任务团队不能结项。新增岗位、扩大范围或提高并发/预算用 propose_team_change 暂存等待确认，原授权工作继续；普通追加不重复确认。

## 派发与内部通信

claim_team_tasks 或 advance_team_workflow(dispatchReady=true) 批量预留。按返回的 action、taskName、prompt、spawnOptions 调用原生 spawn_agent/followup_task，保存 attemptId，拿到真实 ID/路径立即 bind_team_members；标题按 titleActions 设置。spawn 使用 fork_turns=none。已结算任务的下一任务使用独立上下文与新 generation，不能发给 contextHistory 退役线程；活动、未知或中断续跑保持原 attempt/会话。面板“执行记录待更新”仅表示公开记录延迟，不证明中断或空闲；核对现有原生成员，不重新派发。结果未知先核对，不重复启动，只有确认未启动才 release_team_reservation；批量部分成功只绑定成功部分。

严格沿用已批准模型/档位及备用路由，不为省 token 自动降档或换模型。宿主能力以真实目录为准；写范围是调度约定，不是文件系统沙箱。worktree 包指定目录时所有写入/命令在该目录执行，不自行写回 Leader 项目。

内部通信走原生 send_message、完成通知和 wait_team_event。成员 send_team_peer_message 仅对问题、阻塞和必要完成通知按 nativeAction 送达，记录真实回执；一般进度写检查点或 kind=progress，仅持久保存不触发投递。consume_team_inbox 一次读取并确认当前收件轮次的新消息，沿用 after/cursor；hasMore 时继续取页，不重复读取已确认历史。未知投递不自动重发。不得用 app.sendMessage、send_message_to_thread、thread/injectItems 或用户角色聊天条目协调；主窗口仅给用户必要进度、问题和结果。coordinate_team 的旧通知不授权推进，reserve 不返回聊天发送机会。

## 推进与等待

完成通知后 advance_team_workflow 一次接收真实终态、校验审核、预留下一批。默认回执包含 advancement.changes、最新 revision、动作和完整 dispatches；成功后直接执行包/处理异常/等待，不重复读取团队或收件箱。普通审核 PASS 且插件校验通过，同一事务直接登记 target/review accepted 并解锁后续任务。Leader 只处理 review-exception 与团队最终结项，不重复审查或重跑相同测试。相同轮次的接收、已登记审核和最终结项可幂等重试；新增范围或有证据的返工才重执行。

成员工作期间保持 Leader 当前轮次，优先单独 wait_team_event(timeoutMs=55000)，同时等待人工控制、必要消息和原生终态，不交替 wait_agent + 零时探测。普通进度/用量保存合并在同一等待内，不唤醒模型；面板持续正常更新。插件没有唤醒已结束 Leader 轮次的内部接口，不能退回聊天桥或伪称已执行。

- unchanged/timeout：复用返回 continuationArgs（teamId/revision/waitCursor/timeoutMs=55000），再次单独等待，不配套状态/收件箱/schema 查询或重复进度。functions.exec 设置 yield_time_ms=60000，避免等待未结束就多一次模型往返。waitCursor 按业务变化比较，跨两次等待之间的普通进度保存不会唤醒。
- changed/member-terminal：回执内已含 coordination 与准确 attempt IDs，直接按动作处理；终态 advance_team_workflow，不再先 read_team。仅 inbox.readRequired=true 用 consume_team_inbox；stopping 优先处理。
- 句柄失效：等待已登记原生终态，不重建；用户暂停/取消结束等待。无活动 Leader 的面板操作只保存为待处理。

## 证据与恢复边界

公开输出包含当前 TEAM_WORKSPACE_ATTEMPT 标记；report_member_team_task 是草稿/检查点，真实终态经 settle 才提交。审核返回 decision、逐项 checks 和 findings；不得通过 blocker/high、失败命令、缺失条件或过期证据。插件核对独立会话、当前目标 attempt/合同、宿主命令和声明输入指纹；失败保留 submitted 与具体异常。只为异常读取 read_team_context(view=evidence, taskId, attemptId, section)，分页 hasMore 时读取所需完整内容；不默认 read_team(full) 拉全队历史。

源码使用 read_team_source 的选定行分页（默认4000字符，最多6000），cursor 防止混用修改前后内容。长测试/构建先 prepare_team_command，再通过原生命令工具执行返回的 nativeCommand；输出上限1200 token，完整日志留盘，失败或需摘要时 read_team_command_log 分页（默认2000字符）。准备日志不代表执行或 PASS；保留宿主真实退出码/会话。直接使用原生工具也遵守输出预算，单批向模型转发最多6000字符，禁止整文件/长日志输出。成功测试返回短摘要、原命令/退出码和完整日志路径。复用适用于当前候选的已有证据；源代码审查不是测试已运行。交付 changedPaths、verificationInputs 用于输入指纹，不能证明外部环境或未声明输入不变；真实变化需要必要验证，补记录不重跑。

本轮必须项由当前合同决定。额外 NOT_RUN 仅在带 criterionId 且能唯一关联到依赖当前验收的后续 work 合同时保留为未来检查；多义时使用报告中的 futureTaskId 指定已有合同，不创建假 PASS。当前必需项、FAIL/BLOCKED、未知归属不能延期，未来项不算已执行。

已完成审核的 PASS 被插件拒绝登记并回退 waiting 时，reconcile_team_review 先 dryRun：读取原轮次、一次列出的失败 commandIndex、未变候选和后续检查归属，再用稳定 requestId/revision 原位登记。可补充有既有独立证据的非验证失败说明；不能把真实测试失败解释掉。复用已有报告，不重新派发审核。真正缺失必需检查、严重问题未关闭或 reviewer rework 仍走返工；不可把它们当格式恢复。细节见 [保存审核原位登记](references/protocol-details.md#保存审核原位登记0310)。

advance 的 advancement.errors/partial 与 changes 一起核对：部分已提交不会因另一项失败回滚，不重复做成功部分。settlement-exception 保存原终态报告，输入未变不自动重试；按具体交付/合同异常处理后显式重试登记，不因面板未 accepted 重跑测试。停止期间仅收集已完成的真实终态，不能因登记恢复团队执行或派发；stopping/halted 的保存审核恢复先走原控制流程。

命令工作目录或中断历史验证缺少关联时，用 reconcile_team_verification 先预览，核对明确 commandId、真实 cwd/退出码和未变输入后补登记；操作细节按需读取 [历史验证关联](references/protocol-details.md#历史验证关联与结果复用)。不重跑已完成检查，不覆盖旧报告、null 退出码或审查结论。

长任务达到约60000当前输入 token 或30次命令时，在有意义的阶段边界考虑交接，不在执行中强制重置。成员 report_member_team_task(handoff=true) 保存完整 decisions/remainingWork/evidence/validation 与 verificationInputs，不含最终 delivery；将返回 finalReceipt JSON 作为最终公开答复并结束轮次。Leader 仅在确切 completed + 检查点回执验证后，将同一 task 置 waiting，下一派发生成 fork_turns=none 的干净上下文并保留阶段链。续接前 read_team_context(view=evidence, section=checkpoint, attemptId=前阶段) 分页读取完整决策与剩余工作；阶段交接不是提交/验收，不解锁下游。每任务最多3次，不消耗失败重试额度；审核任务不使用阶段交接。仅成功宿主命令和声明输入内容指纹不变可复用；改变输入即失效，最终审查仍独立。连接失败/未知不能触发轮换。

中断续跑保持原 attempt/标记；仅连续且所有前序均有宿主持久中断证据时关联最新完成轮次，保留逐轮历史。多个完成结果或混入其他任务不能按“最新”猜测。合同修订、停止核对、source-only 延期说明、控制恢复需读取协议对应段落；不能通过扩大范围、放松条件或修改 owner 绕过门禁。

registrationGap 表示已验证原生会话缺少任务关联，不能推断任务没做。先 read_team_usage(view=full) 核对是否为本目标，属于当前目标才 register_team_native_attempts：dryRun 预览明确原任务、子会话、顺序 turnIds、逐轮审查目标，再稳定 requestId/revision 提交。不重跑、不重建已完成成员，不相关会话只记成本；用户已补齐的不重复登记。

stop_team 先保存 stopping，再原生 interrupt 全部绑定成员并 reconcile_team_stop；未知预留先核对。宿主未核实空闲保持 stopping；有效完成保留 submitted 与历史，不能降为 stopped 强迫重派。halted 后明确恢复原因，resume_team 仅重试指定任务，保留预算与取消状态。

## 结项与管理

所有任务 accepted/cancelled 且真实目标完成后，Leader finish_team 记录最终结项。默认复用有效的已验收 integration 合同证据，单项测试/source-only 不替代整体验证；声明输入变化或证据失效时处理具体异常。finish 成功且 workflow.stage=completed 后给最终交付；用户暂停、取消或真实阻塞可提前结束并说明。

角色目标调整 update_team_member_goal 影响后续派发，当前执行保留原快照与修订历史；改路由、加岗/扩大范围不能借目标编辑绕过确认。任务详情在面板查看；成员会话用已验证 open-link 直达，不发导航聊天。归档仅在用户明确要求且最终结项、空闲已核实后 archive_team，完整保留历史、释放项目给无关目标；不自动归档或归档 Codex 会话。模板、历史与跨 Leader 只读入口见协议对应段落。

用量包含本团队期间 Leader 与经父级/项目验证的直接子会话，未登记会话只计成本。累计处理量含缓存输入，新增输入/缓存/输出不是账单或限额的直接计量；未知计数保留未知。已有预算在新派发前实时核对，耗尽只挡新任务。高思考档位按规划复杂度建议用户选择，不自动修改现有授权。回执 pluginVersion 与面板版本不符时重新加载插件连接，不强制重启正在工作的宿主。

通过 functions.exec 调用55秒等待时，使用首行 `// @exec: {"yield_time_ms": 60000}`，避免30秒提前返回再加一轮模型往返。原生命令仍在执行时等待同一 session，沿用 prepare_team_command.waitOptions（55秒/1200 token），不做高频短轮询；取消/暂停优先处理。

交付格式：结构化报告包含当前 attemptMarker，可直接输出 JSON 或单个 JSON 代码块；第一行可重复该任务标记，但必须与 JSON 内标记和当前绑定一致。交付、审核、阶段交接使用同一规则。格式兼容不改变独立审查、命令、范围和证据门禁，原报告保留。
