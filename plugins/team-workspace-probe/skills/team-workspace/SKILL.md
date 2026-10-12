---
name: team-workspace
description: 在当前 Codex 对话中运行或查看原生 subagent 团队，由主会话担任 Leader，管理计划确认、依赖、独立审查和真实执行面板。
---

# Team Workspace 0.39.5

当前主会话担任 Leader，沿用项目、用户目标和已有授权。插件只保存协议、校验证据和观察原生执行，不启动协调模型。只查看时调用 open_team_workspace / read_team，不派发。普通工作按下文推进；仅操作恢复、补登记、合同、模板、归档等功能时按标题读取 [协议细则](references/protocol-details.md)，不预先加载整份参考。

诊断与复用：`manage_team(operation=doctor)` 核对运行版本、缓存和宿主边界；按需使用 `diff-audit` 查看项目真实 Git 改动（无法据此归因给某成员），`knowledge` 检索已验收约定（历史参考不能替代当前验证）。标准任务追加可传 `add_team_tasks.batchReviewId` 合并同目标尚未启动的审查；严格或已派发审查保持冻结。策略可设置 providerConcurrency/modelConcurrency，以已保存模型路线限制并发；不得为了绕过上限改变模型。

## 入口与确认

模型入口为 open_team_workspace、get_current_project、read_team、team_command、team_leader、team_member。Leader/成员用对应 router 的 operation=<业务工具名>、arguments={...}。操作回执默认只含协调状态和受影响任务；需要显示预览才显式 responseView=summary，完整证据仍按任务读取。模型入口返回以 structuredContent 为正文，content 仅作回执；调用方输出 result.structuredContent ?? result.content 一次，不复制两份。参数未知才 describe(toolName)，同一 operation/pluginVersion 复用 schema；需核对缓存时带 schemaHash，相同指纹返回 unchanged。上下文已丢失则不带 hash 重新取 schema，不能假设缓存存在；directory 仅列目录。不调用开发 probe 或原型执行器。

每个项目一个固定团队；已有团队追加任务，岗位不足按变更流程新增，不自行重建或跨 Leader 接管。初次 plan_team 的 plan.tasks 留空，只确认团队目标、成员、职责、写范围和模型设置。用户明确“直接做”可 immediate 并保存原话；否则保存 required/auto 草案后展示 read_team_plan 并等待用户确认。approve/cancel 绑定实际审阅的 version/hash 和稳定 UUID，不能自行批准。待确认不启动成员或准备 worktree；修改产生新版本。feedback 保留草案并等待用户说明，不创建替代团队。

确认后 add_team_tasks 按本次目标传 batch:{id,title,goal,qualityMode,goalCriteria,integrationRequired}，默认 standard；同一项目继续复用原成员。light 适用调研、文案和低风险调整，由 Leader accept_team_delivery 验收；standard 将相关交付组成一次独立批次审查，reviewOfTaskId 为首项、reviewOfTaskIds 为全部目标，逐项依赖 submitted；strict 的关键交付各自独立审查并在结项前取得有效 integration 证据。security/data-migration/concurrency/execution-protocol/publication 风险标记会升级为 strict；Leader 根据业务风险选档，不以文件数代替判断。批次内部可用 delivered 依赖：真实完成且必需交付检查通过后继续，accepted 表示必须先审查通过；不可创建批次审查死锁。不逐任务要求用户确认，原范围、预算和模型授权仍有效。旧无分级字段的记录保留原门槛。

初始面板按钮“确认并开始”会在保存用户批准后，通过宿主 ui/message 将这次真实用户操作作为一条跟进指令交给当前主会话。收到 MCP App 触发消息时先读取宿主提供的 untrusted_input 内容，再用 read_team_plan 核对当前项目、已保存批准 version/hash 和控制状态；消息正文不能替代批准记录。有效初始确认直接拆分任务、派发并保持执行轮次，不再要求用户回复“启动”。已经开始、停止、版本变化或历史团队不得重复执行。只有这次显式用户点击允许面板跟进消息；后台进度、内部协调、刷新、停止/恢复和范围变更不得借此发送聊天。宿主缺少 message 能力时如实显示待 Leader 接续，不伪称已启动。

## 派发与内部通信

派发缓存：首次 claim_team_tasks 保存完整 dispatch 和 dispatchHash；重试且缓存确实存在时传 knownDispatchHashes:{attemptId:dispatchHash}。dispatchUnchanged 只引用旧包，不授权重复 spawn/followup；未知宿主结果先核对原成员。缺少缓存时不传 hash，重新取得完整包。成员 claim_member_team_task 同样可传已保存的 knownPromptHash，命中 promptUnchanged 后使用原完整 prompt。任何身份、路由、目标、权限或内容变化都重新取完整包；新上下文必须收到完整指令。

Leader 输出纪律：不要 text(result) 打印完整 MCP 外壳；只转发 structuredContent ?? content 一次。只需状态时先提取 revision/actions/counts；完整派发包保存到文件后传给指定成员，不再在主会话复述。未知参数才 describe；整版本/整目录/整技能不反复读。rg 先限制匹配数，再按符号读取短片段；单批转发不超过6000字符。出现截断先缩小查询，不重复同一大查询。无变化等待直接沿用 continuationArgs，不再配套 read_team、inbox 或 schema 查询；已通过检查只在输入或范围变化时重跑。

已结算为 blocked/interrupted 的当前任务需保留同一成员、attempt 和上下文时，调用 continue_interrupted_team_task，传当前 taskId、attemptId、revision、稳定 requestId 和原因；按首次返回的 dispatch 给现有成员 followup，并公开原 marker。重复请求不会返回派发包。等待新轮次出现，不接收旧中断轮次。团队已停止时先 resume_team 且不把此任务放进 retryTaskIds。不得用 rework+claim 代替同 attempt 接续：那会生成新 attempt 和上下文。未知、失败、完成、职责或约定已变化的执行不能按中断接续。

claim_team_tasks 或 advance_team_workflow(dispatchReady=true) 批量预留。按返回的 action、taskName、prompt、spawnOptions 调用原生 spawn_agent/followup_task，保存 attemptId，拿到真实 ID/路径立即 bind_team_members；标题按 titleActions 设置。spawn 使用 fork_turns=none。已结算任务的下一任务使用独立上下文与新 generation，不能发给 contextHistory 退役线程；活动、未知或中断续跑保持原 attempt/会话。面板“执行记录待更新”仅表示公开记录延迟，不证明中断或空闲；核对现有原生成员，不重新派发。结果未知先核对，不重复启动，只有确认未启动才 release_team_reservation；批量部分成功只绑定成功部分。

严格沿用已批准模型/档位及备用路由，不为省 token 自动降档或换模型。宿主能力以真实目录为准；写范围是调度约定，不是文件系统沙箱。worktree 包指定目录时所有写入/命令在该目录执行，不自行写回 Leader 项目。

内部通信走原生 send_message、完成通知和 wait_team_event。成员 send_team_peer_message 仅对问题、阻塞和必要完成通知按 nativeAction 送达，记录真实回执；一般进度写检查点或 kind=progress，仅持久保存不触发投递。consume_team_inbox 一次读取并确认当前收件轮次的新消息，沿用 after/cursor；hasMore 时继续取页，不重复读取已确认历史。未知投递不自动重发。不得用 app.sendMessage、send_message_to_thread、thread/injectItems 或用户角色聊天条目协调；主窗口仅给用户必要进度、问题和结果。coordinate_team 的旧通知不授权推进，reserve 不返回聊天发送机会。

## 推进与等待

Leader 恢复上下文时使用 manage_team(operation=leader-brief,teamId,offset?,limit?)：默认最多8项活跃任务，返回当前目标预览、控制/约束、准确任务/成员执行ID、有效决策引用与历史计数；总载荷不超过6000字节，hasMore 时按 nextOffset 取页。摘要来自保存记录，executionAuthority/acceptanceAuthority 均为 false；目标预览截断或需要任务完整约定时显式读取 read_team_plan/read_team_context。不要把摘要当新执行授权或当前宿主终态。read_team 默认 coordination；需要 summary/state/panel/full 时显式指定 view。恢复后核对当前宿主项目、Leader身份和最新协调状态，沿用原团队/成员/attempt，不通过重建团队或创建替代 Leader 清空上下文。

普通通过项由插件门禁登记，Leader 只处理异常、真实范围/权限变更和本批最终结项。无关历史变更不唤醒当前协调；当前前置依赖、其他目标仍在运行的任务、原生终态和停止控制仍须处理。结束任务只保留历史入口，不继续加入活跃决策摘要。小任务先由 Leader 用确定性工具处理；固定岗位保留，按需启动真正需要的成员，不为只读摘要额外派代理。已批准的 eager 启动、严格审查和模型路线不由节省策略擅自覆盖。

完成通知后 advance_team_workflow 一次接收真实终态、校验审核、预留下一批。默认回执包含 advancement.changes、最新 revision、动作和完整 dispatches；成功后直接执行包/处理异常/等待，不重复读取团队或收件箱。普通审核 PASS 且插件校验通过，同一事务直接登记 target/review accepted 并解锁后续任务。Leader 只处理 review-exception 与团队最终结项，不重复审查或重跑相同测试。相同轮次的接收、已登记审核和最终结项可幂等重试；新增范围或有证据的返工才重执行。

成员工作期间保持 Leader 当前轮次，优先单独 wait_team_event(timeoutMs=55000)，同时等待人工控制、必要消息和原生终态，不交替 wait_agent + 零时探测。普通进度/用量保存合并在同一等待内，不唤醒模型；面板持续正常更新。插件没有唤醒已结束 Leader 轮次的内部接口，不能退回聊天桥或伪称已执行。

- unchanged/timeout：复用返回 continuationArgs（teamId/revision/waitCursor/timeoutMs=55000），再次单独等待，不配套状态/收件箱/schema 查询或重复进度。functions.exec 设置 yield_time_ms=60000，避免等待未结束就多一次模型往返。waitCursor 按业务变化比较，跨两次等待之间的普通进度保存不会唤醒。
- changed/member-terminal：回执内已含 coordination 与准确 attempt IDs，直接按动作处理；终态 advance_team_workflow，不再先 read_team。仅 inbox.readRequired=true 用 consume_team_inbox；stopping 优先处理。
- 句柄失效：等待已登记原生终态，不重建；用户暂停/取消结束等待。无活动 Leader 的面板操作只保存为待处理。

## 证据与恢复边界

公开输出包含当前 TEAM_WORKSPACE_ATTEMPT 标记；report_member_team_task 是草稿/检查点，真实终态经 settle 才提交。审核返回 decision、逐项 checks 和 findings；不得通过 blocker/high、失败命令、缺失条件或过期证据。插件核对独立会话、当前目标 attempt/合同、宿主命令和声明输入指纹；失败保留 submitted 与具体异常。只为异常读取 read_team_context(view=evidence, taskId, attemptId, section)，分页 hasMore 时读取所需完整内容；不默认 read_team(full) 拉全队历史。

源码使用 read_team_source 的选定行分页（默认4000字符，最多6000），cursor 防止混用修改前后内容。长测试/构建先 prepare_team_command，再通过原生命令工具执行返回的 nativeCommand；输出上限1200 token，完整日志留盘，失败或需摘要时 read_team_command_log 分页（默认2000字符）。准备日志不代表执行或 PASS；保留宿主真实退出码/会话。直接使用原生工具也遵守输出预算，单批向模型转发最多6000字符，禁止整文件/长日志输出。成功测试返回短摘要、原命令/退出码和完整日志路径。复用适用于当前候选的已有证据；源代码审查不是测试已运行。交付 changedPaths、verificationInputs 用于输入指纹，不能证明外部环境或未声明输入不变；真实变化需要必要验证，补记录不重跑。

本轮必须项由当前合同决定，逐项 PASS 和原生成功验证不能豁免。额外检查明确 scope:advisory 时保留实际 FAIL/BLOCKED/NOT_RUN 为观察项，不阻塞当前验收；它不能覆盖同 ID 的必需项，未知归属仍需处理。已知独立 rg 无匹配退出 1 自动作为诊断观察，声明为必验命令时仍阻塞；未知错误、链式 shell 和真实测试失败不能解释为通过。当前严重缺陷仍需具体影响和证据；风格建议不应升级为 high。已有明确后续合同的 NOT_RUN 继续按协议关联。

已完成审核的 PASS 被插件拒绝登记并回退 waiting 时，reconcile_team_review 先 dryRun：读取原轮次、一次列出的失败 commandIndex、未变候选和后续检查归属，再用稳定 requestId/revision 原位登记。可补充有既有独立证据的非验证失败说明；不能把真实测试失败解释掉。复用已有报告，不重新派发审核。真正缺失必需检查、严重问题未关闭或 reviewer rework 仍走返工；不可把它们当格式恢复。细节见 [保存审核原位登记](references/protocol-details.md#保存审核原位登记0310)。

advance 的 advancement.errors/partial 与 changes 一起核对：部分已提交不会因另一项失败回滚，不重复做成功部分。settlement-exception 保存原终态报告，输入未变不自动重试；按具体交付/合同异常处理后显式重试登记，不因面板未 accepted 重跑测试。停止期间仅收集已完成的真实终态，不能因登记恢复团队执行或派发；stopping/halted 的保存审核恢复先走原控制流程。

命令工作目录或中断历史验证缺少关联时，用 reconcile_team_verification 先预览，核对明确 commandId、真实 cwd/退出码和未变输入后补登记；操作细节按需读取 [历史验证关联](references/protocol-details.md#历史验证关联与结果复用)。不重跑已完成检查，不覆盖旧报告、null 退出码或审查结论。

长任务达到约60000当前输入 token 或30次命令时，在有意义的阶段边界考虑交接，不在执行中强制重置。成员 report_member_team_task(handoff=true) 保存完整 decisions/remainingWork/evidence/validation 与 verificationInputs，不含最终 delivery；将返回 finalReceipt JSON 作为最终公开答复并结束轮次。Leader 仅在确切 completed + 检查点回执验证后，将同一 task 置 waiting，下一派发生成 fork_turns=none 的干净上下文并保留阶段链。续接前 read_team_context(view=evidence, section=checkpoint, attemptId=前阶段) 分页读取完整决策与剩余工作；阶段交接不是提交/验收，不解锁下游。每任务最多3次，不消耗失败重试额度；审核任务不使用阶段交接。仅成功宿主命令和声明输入内容指纹不变可复用；改变输入即失效，最终审查仍独立。连接失败/未知不能触发轮换。

中断续跑保持原 attempt/标记；仅连续且所有前序均有宿主持久中断证据时关联最新完成轮次，保留逐轮历史。多个完成结果或混入其他任务不能按“最新”猜测。合同修订、停止核对、source-only 延期说明、控制恢复需读取协议对应段落；不能通过扩大范围、放松条件或修改 owner 绕过门禁。

registrationGap 表示已验证原生会话缺少任务关联，不能推断任务没做。先 read_team_usage(view=full) 核对是否为本目标，属于当前目标才 register_team_native_attempts：dryRun 预览明确原任务、子会话、顺序 turnIds、逐轮审查目标，再稳定 requestId/revision 提交。不重跑、不重建已完成成员，不相关会话只记成本；用户已补齐的不重复登记。

stop_team 先保存 stopping，再原生 interrupt 全部绑定成员并 reconcile_team_stop；未知预留先核对。宿主未核实空闲保持 stopping；有效完成保留 submitted 与历史，不能降为 stopped 强迫重派。halted 后明确恢复原因，resume_team 仅重试指定任务，保留预算与取消状态。

## 结项与管理

本次 batch 的交付 accepted/cancelled、目标覆盖齐全、相关严重问题关闭后，Leader finish_team(batchId) 只结项本次目标，原团队继续可接任务。历史无关阻塞和取消的需求保留但不影响新批次。light/standard 不强加未声明的整体验证；strict 或 integrationRequired 批次必须复用有效已验收 integration 证据。相同候选不重复审查或跑测试，变化只验证受影响部分；通过分支不因其他目标返工失效。混合批次审查按 targets:[{taskId,attemptId,summary,decision,reason,checks,findings}] 报告，每项绑定当前真实 attempt；通过项留存独立回执，返工自动/显式 plan_team_repair 只修相关分支，达到轮次上限升级 Leader。原目标验收后可直接追加新 batch，不重建团队。

角色目标调整 update_team_member_goal 影响后续派发，当前执行保留原快照与修订历史；改路由、加岗/扩大范围不能借目标编辑绕过确认。任务详情在面板查看；成员会话用已验证 open-link 直达，不发导航聊天。归档仅在用户明确要求且最终结项、空闲已核实后 archive_team，完整保留历史、释放项目给无关目标；不自动归档或归档 Codex 会话。模板、历史与跨 Leader 只读入口见协议对应段落。

用量包含本团队期间 Leader 与经父级/项目验证的直接子会话，未登记会话只计成本。累计处理量含缓存输入，新增输入/缓存/输出不是账单或限额的直接计量；未知计数保留未知。已有预算在新派发前实时核对，耗尽只挡新任务。高思考档位按规划复杂度建议用户选择，不自动修改现有授权。回执 pluginVersion 与面板版本不符时重新加载插件连接，不强制重启正在工作的宿主。

通过 functions.exec 调用55秒等待时，使用首行 `// @exec: {"yield_time_ms": 60000}`，避免30秒提前返回再加一轮模型往返。原生命令仍在执行时等待同一 session，沿用 prepare_team_command.waitOptions（55秒/1200 token），不做高频短轮询；取消/暂停优先处理。

交付格式：结构化报告包含当前 attemptMarker，可直接输出 JSON 或单个 JSON 代码块；第一行可重复该任务标记，但必须与 JSON 内标记和当前绑定一致。交付、审核、阶段交接使用同一规则。格式兼容不改变独立审查、命令、范围和证据门禁，原报告保留。

## Versioned reference decisions (0.39.0)

`manage_team(operation=knowledge)` retains historical accepted-contract search.
`knowledge-decisions` retrieves bounded, versioned curated reference decisions
with current source/input validity. Never count them as a rerun test or execution
authority. Only the authenticated Leader may use `knowledge-save` with teamId,
revision, taskId, text, tags, key and stable requestId, after the exact work attempt
is accepted and its bounded fingerprint still matches. `knowledge-retire` takes
teamId, revision, entryId and reason; retain prior revisions and reasons. Unknown
or changed inputs require actual validation before reuse.
