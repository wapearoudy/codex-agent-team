已明确授权的新团队优先使用主 SKILL.md 的 start_team_goal 一次启动；无需先调用 context/doctor/plan/compile。该入口不用于待确认目标或替换现有团队。合同 readPaths 在真实关联后提供当前源码页；按 hasMore/cursor 续读，完整页不再重复取证。下列分步操作仍供已有团队与兼容流程使用。

Codex 路由说明：本文列出的业务 API 名称（包括兼容操作 `wait_team_event`）通过实际暴露的 `team_leader` 工具的 `operation` 调用，不要求在 ALL_TOOLS 中单独发现同名工具。等待优先执行返回的 `waitInvocation`；冷缓存用返回的 `waitCall`，均走 `next_team_step` 与 `wait:true`。缺少独立别名不等于缺少能力；真实错误仍保留并停止，不重新派发或为登记重跑测试。

---
name: team-workspace
description: 在当前 Codex 对话中运行或查看原生 subagent 团队，由主会话担任 Leader，管理计划确认、依赖、独立审查和真实执行面板。
---

# Team Workspace 0.40.22

当前主会话是 Leader。插件只保存合同、校验证据、观察真实原生成员，不执行模型或唤醒已结束 Leader。只查看用 open_team_workspace/read_team，不启动任务。主窗口只给用户必要进度、问题和结果；内部协调用原生 send_message、完成事件和保存的成员检查点，禁止聊天注入。

## 正常路径

入口是 team_leader/team_member router：operation=<工具名>, arguments={...}。未知参数才 describe(toolName)；已知版本/schema 复用，不反复读目录或整份协议。结果只输出 structuredContent ?? content 一次。完整 dispatch 保存到文件传给指定成员，Leader 只看 revision/actions/changes；不打印整个外壳或双份内容。

1. 初次 plan_team 的 plan.tasks=[]，只确认目标、成员、职责、写范围和模型。明确“直接做”的授权可 immediate 并保存用户原话；否则 required/auto 草案等待真实用户批准。任务无需逐项确认。每项目一个固定团队，不为清上下文重建；范围、预算或模型扩展仍需原批准流程。fixedRoster 可保留岗位，memberStartup=on-demand 按实际任务启动。
2. 确认后优先 compile_team_tasks：{teamId,revision,requestId,commit,reviewerId,batch:{id,title,goal,qualityMode},units:[{id,title,goal,memberId,criteria:[{id,description}],writePaths,verifyCommands,stage?,validationMode?,dependencies?,context?,riskFlags?}]}。commit=false 无副作用集中预检；commit=true 预检成功后原子保存，稳定 UUID 可幂等恢复。verifyCommands 是实际 shell 字符串，不是“运行测试”说明。程序生成审查合同与 submitted 依赖。标准同目标交付共享一次独立批次审查；strict/风险交付各自独立审查并有 integration 验证。风险不因省 token 降级。严格沿用批准模型与思考档位。
3. 强耦合的标准工作先作为一个业务单元；显式 combineGroups:[{id,unitIds}] 可合并尚未执行的同成员/阶段单元，保留所有原目标和条件，改接依赖。严格/高风险单元不能合并。历史任务不改写。工作路径与成员范围一致；只读 reviewer.writeScopes=[]，其 contract.inScope=[]，待读源文件写在 context。依赖默认 delivered；必须先独立审查的门禁用 accepted；避免共享审查的 accepted 死锁。旧 add_team_tasks 仍兼容。
4. next_team_step({teamId,revision,dispatchReady:true}) 一次接收已核实终态、登记有效审核、预留就绪任务。Leader 使用 dispatches.nativeAction.arguments 原样调用对应 spawn_agent/followup_task，包括精确 task_name，不按角色自己命名。完整包与引用包都包含相同的先行认证步骤，成员必须先成功 start 再写入；失败保持原活动轮次，不 followup 已完成轮次补登记。spawn 使用 fork_turns=none 与 exact spawnOptions；新任务新上下文。新版 Codex dispatch.memberBootstrap 由成员先公开准确 marker，再调用 start_member_team_task，程序核实当前子线程、父线程、项目、计划路径、冻结合同和当前活动轮次，readyForWork=true 后直接开工。不再发送就绪/BIND_READY，不由 Leader 绑定或轮询成员列表。成员 reportArguments 保留到最终提交；其他成员的进度 revision 不要求重读。无 memberBootstrap 的旧包/其他宿主保留原 bind_team_members 流程；不缩写 marker、不重启。完整包传给成员；已保存包可复用 knownDispatchHashes / knownPromptHash，缓存未知不传 hash。
5. 成员先公开当前 TEAM_WORKSPACE_ATTEMPT 标记，遵守包内任务、合同、写范围、上下文和 deliveryTemplate。保持同一活动轮次完成工作。最终结构化草稿先 report_member_team_task；deliveryPreflight.valid=false 时按返回 revision 在同一轮次修正字段，保留原草稿与验证，不重跑测试。错误返回准确字段和 repairTemplate：只修正错误字段，保留原报告中有效检查、问题和证据，不改成另一种封装。有效草稿返回 finalReceipt；将它原样输出为最终公开 JSON 并结束。插件将回执绑定真实终态、同一 turn、marker、合同版本和内容哈希，再用完整原报告做证据门禁。旧完整公开 JSON 仍兼容。不得给已经完成的轮次 followup 补报告。
6. 审核成员独立核对精确目标 attempt、当前候选、逐项条件和已有验证。read_team_context(view=evidence,taskId,attemptId,section) 只取所需完整页；禁止默认全队历史。报告 decision/checks/findings，稳定问题 ID 与关闭证据。scope:advisory 观察保留实际状态，不能替代本轮条件；后续检查由明确后续合同承接。审核通过且插件校验通过，同事务登记 target/review accepted 并解锁下游。Leader 仅处理真实异常和最终结项，不再审同一候选或重复测试。审核任务依据其检查结论与插件门禁关闭，不再生成无限审查链。
7. 等待用 next_team_step({teamId,revision,wait:true,waitCursor?,timeoutMs:55000,dispatchReady:true})，原样复用前次返回的 continuationArgs（含 waitCursor），不手工抄写 UUID、revision 或重新 describe，一次等待后直接推进。程序在内部吸收自行绑定/普通进度并动态订阅新绑定成员，只有业务终态、异常和控制唤起编排。无变化只复用 continuationArgs 等待，不配套 read_team/schema/inbox 或高频探测。functions.exec 设置 yield_time_ms=60000；期间保持 Leader 活动轮次。当前宿主不能内部唤醒结束 Leader；如实保留待接续。旧 wait_team_event/advance_team_workflow 兼容。取消和停止优先，停止期间不派发。
8. 本批所有目标验收、覆盖齐全、严重问题已关闭后 finish_team(batchId,note,reuseEvidence:true)。standard 不新增未声明集成门槛；strict/integrationRequired 复用已验收且输入未变的 integration 证据，缺证据不得结项。使用模型精简响应中 final-validation 返回的 finalizationArguments 原样一次结项；不要 describe 或先读已验收命令列表再拼检查，不能为保存历史再默认读取或导出整队证据；历史已自动保存。只有用户明确要求才 export_team_report。保存成本与质量记录。团队保留可追加批次；仅用户明确要求、结项且核实空闲后 archive_team，历史和原生会话不删除。

## 证据和成本纪律

Codex 成员把已授权的 prepare_team_command → tools.exec_command 串在一个 functions.exec 内；准备失败不得执行，返回真实退出码/同一 session。审查所需独立源代码和证据页可在一个 functions.exec 内批量读取，逐个检查结果；不是让 Leader 二次审查。

长测试先 prepare_team_command（必须保存完整 verificationInputs，包括配置、测试、环境初始化所引用文件），再原生执行返回 nativeCommand；准备不是执行或 PASS。所有写入/命令使用包内工作目录；原生输出上限1200 token，模型单批最多6000字符，完整日志留盘。命令未结束沿用原 session 等待55秒，不重跑。只读源代码和日志按选定页；rg 先定位，截断后缩小范围，不重复大查询。未知退出码、失败或未验证记录保持未知/FAIL/BLOCKED，不能伪造。

复用只能基于真实成功宿主命令、完整输入指纹和未变候选。独立审查复用已有测试，不意味着已有审查结论自动适用修改后的代码。工作交付必须有每个 criterionId 的真实状态和证据；审查 checks 名称/条件唯一、目标 attempt 明确。当前必需项不能延期或豁免。原报告、中断轮次、格式拒绝和审查记录全部保留。

analyze_team_cost 可读取真实团队窗口成本、显式估算和分组建议。未知计数不是0；估算不得冒充实测省 token。团队成本包含 Leader、所有已核实子会话及失败/恢复；团队窗口可能不含组建前工作，fresh-root 对比必须从根会话开始统计。缓存计入处理量，另报未缓存输入+输出；不是账单或账号限额。

约60000当前输入 token 或30次命令仅是阶段交接候选。先比较剩余请求可能避免的旧输入与新上下文/交接成本；未知不自动换会话。有意义的未完成边界才能 handoff，完整 checkpoint 与真实 completed 回执后干净续接；每任务最多3次。完成任务、review、连接未知都不轮换。中断续跑保持原 attempt 与历史，不用新 attempt 代替。

## 异常按需读取

真实异常只读取相关段落，保留原团队、任务、轮次和历史；禁止为登记重跑业务工作。manage_team(operation=doctor) 核对安装/runtime，leader-brief 取最多8项活跃摘要（无执行/验收授权）。任务详情在面板，成员用已核实 open-link 直达，不通知 Leader 跳转。

- 中断续跑、原位验证/审查登记、阶段交接、停止/恢复、合同修订、角色目标和历史关联：读 [完整兼容流程](references/workflow-compatibility.md) 对应标题及 [协议细则](references/protocol-details.md) 对应段落。
- 可复用模板、版本化验收知识和宿主差异：读 [完整兼容流程](references/workflow-compatibility.md) 对应标题；历史知识不是当前测试或执行授权。
- 普通进度不唤醒模型；未知、保存记录延迟和 registrationGap 都不证明没做。先核对真实原生成员，用户已补齐的记录不重复登记。

已验收的依赖若需独立审查来源，读取该依赖任务的 `read_team_context(view=evidence, section=acceptance)`；只返回该交付对应的原始审查结论和验收回执。检查 `savedEvidenceMatchesReceipt`，核对完整输入未变后才复用，历史回执不等于当前候选通过。`section=delivery` 会将已认证最终回执解析为完整原报告，原回执仍保留。

0.40.11 编译可传 commit=true, dispatchReady=true, dispatchView=reference，同次调用返回首批精确派发参数与 continuationArgs，省去首次 next_team_step。保存计划与预留是两次有 revision 门禁的事务；中间停止/编辑会保留计划并阻止旧状态派发。同 requestId 重试只返回已保存计划，不派发、不新增轮次；先核对原预留及原生启动，不重复 spawn。命令准备返回 executionArguments 与 logReadArguments：一次 functions.exec 串联准备→真实执行→已退出后的选定结果页；未退出沿用同 session，不能用运行中的日志声称成功。

0.40.11 成员 reportArguments 只含 teamId/bootstrapToken，提交工具参数不再抄写 taskId/attemptId；程序基于已自行绑定的真实原生成员唯一解析当前轮次，再校验父线程、工作区、当前合同和精确原生轮次。目标审查 IDs 仅在 delivery JSON 内；显式错误 IDs 仍拒绝，不能静默改派、跨成员提交或从旧轮次复用 token。旧 revision 流程保留必需双 IDs。

0.40.11 派发保留完整不可变 JSON 审计件，成员正常只读取同内容的纯文本 prompt，一次取得全部合同与交付模板，避免读取含多重转义的包装和重复模板。预检成功后的最终公开回执为固定 JSON `{"kind":"team-saved-delivery"}`；程序只解析同一已认证原生轮次、当前合同、格式已校验且摘要完整的最新草稿。原始草稿、旧回执和全部异常保留；错误旧回执仍拒绝，真实终态、候选、命令退出与独立审查门禁不变。原生 fork 的父日志前缀只有在规范子身份和宿主父身份一致时识别，直到子 thread_settings_applied 边界才读取事件/用量；父验证和计数不能成为子证据，缺失边界仍未知，并明确暴露上下文继承。

0.40.11 提供 verify_team_candidate {teamId,taskId,attemptId?}，Leader 可核对拥有的团队，成员仅能核对当前任务及依赖。程序只按该轮已保存 workspace/roots 核对当前完整输入、合同和验收原文完整性，不运行命令、不改验收、不重审。不同范围的指纹不能直接比较相等；acceptance 历史读取中的 currentCandidateVerified=false 表示“本次尚未检查当前文件”，不等于文件已改变。结果未知、文件变化、合同变化或验收记录被修改均不能复用旧 PASS。

The active original Leader panel synchronizes observed terminal deliveries using app-only sync_team_progress. This invokes existing settlement and independent review gates with dispatchReady=false and no explicit decisions. It does not start models, execute commands, dispatch downstream work or close the team. Pending approval, pause, stops, archived teams, unknown native status and unchanged registration errors stay preserved. Stale revisions return current state; a concurrent stop wins. The panel coalesces an identical registration request and continues state polling independently.

启动合同：plan_team 默认 startupProtocol=task-bound、memberStartup=on-demand；不要先创建只回复 ready 的成员。eager 仅适用于显式 startupProtocol=roster-bound 的旧初始化/Leader 绑定流程，不能与任务自行绑定指令混用。冲突在团队保存前拒绝。startupBlockers/waitBlocked 返回时先处理具体阻塞，不调用等待、不创建替代成员，不把未执行任务结项。旧团队的真实初始化和绑定历史保持原样。

验证命令优先在文件修改后单独执行。若原生记录为字面量 `python3 -c ... && 合同验证命令` / `node -e ... && 合同验证命令`，插件只识别最后一个独立命令及真实退出码，保留完整命令和前置修改；不从脚本正文提取测试。当前提交轮次可用未变化的完整提交候选补关联，不能把修改前的 prepare 指纹伪装成测试时输入；中断历史仍须原有 at-run 输入证明。已有独立 PASS 只重试登记门禁，不重新审核或跑测试。

0.40.17 审核成员通过认证启动时同步取得 reviewInputs（目标原始交付页、真实命令元数据和当前声明输入核对），已完整提供的页无需再次读取；hasMore/cursor 和 remainingTargets 必须按需补齐，实际源码仍需独立审查。结项响应 completion 自带登记摘要、验证退出码、原生身份和产物路径，直接用于用户总结。它是验收时的历史回执，不证明后来修改的候选有效；不默认导出或重读全队历史。所有原始证据保留，审核和结项门禁不变。

0.40.18 结项摘要优先保留最终集成验证，并将必要的命令与真实退出码放在不会随预览裁剪丢失的 validation.finalVerification 中。逐项历史仍可显式读取；不重跑测试或补做审查。0.40.17 的真实 Luna 对照记录继续保留，不冒充新版实测。

A returned requiresLeaderAction=true omits routine wait continuation: handle that explicit exception/repair using existing evidence. Unchanged rejected terminal evidence never triggers another settlement wake. In-scope fixes for a real independent-review finding remain part of the approved goal; use plan_team_repair and preserve history, do not request new approval merely because the frozen original plan had no repair task. Real scope/role/write-authority expansion still requires confirmation.
