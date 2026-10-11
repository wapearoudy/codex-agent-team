# Team Workspace 0.32.1 协议细则

当前主会话是 Leader，沿用当前项目、用户目标和已有授权。每个项目一个固定团队，岗位身份固定，同一时刻仅有一个当前执行会话。已结算任务的下一次派发使用独立原生会话，旧线程保留为只读历史；活动或未知轮次不能替换。插件保存业务协议并观察原生记录，不启动另一个协调模型。只查看时调用 open_team_workspace / read_team，不派发工作。

## 工具入口

模型常用入口为 open_team_workspace、get_current_project、read_team、team_command、team_leader 和 team_member。其他业务工具名保留兼容，但在模型工具目录中收敛为两个按角色使用的入口。

- Leader：team_leader(operation="describe", toolName="plan_team") 仅在参数未知时获取单个 schema，同一 operation 和 pluginVersion 复用，缓存核对带 schemaHash，相同则只返回 unchanged；参数说明已丢失不带 hash 获取完整 schema，重试前不要再次 describe；随后 team_leader(operation="plan_team", arguments={...}) 调用。同一方法适用于下文所有 Leader 业务工具名称。directory 返回操作目录，不要一次读取所有 schema。
- 成员：team_member 按相同方法调用自身任务、检查点和队友通信操作。成员不能调用 Leader 操作、直接修改验收状态或扩大范围；审核角色输出结论，由插件校验登记；运行时会校验原生身份。
- 用户明确输入 `/agent-teams [--profile NAME] GOAL` 时可用 team_command 解析并读取现有团队/模板。该协议入口不是宿主已注册的斜杠菜单，不能宣称提供原生命令槽位。
- 不为正常团队工作调用开发 probe、独立执行器或原型模型工具。

已授权原生兜底工作的登记缺口使用 `register_team_native_attempts`：先预览明确的原任务、实际子会话及顺序 turnIds，逐轮绑定审查目标，再以稳定 requestId 和最新 revision 提交。完整保留中断、返工和公开原文；完成仅形成提交，原有验收须提供既有 Leader 决定并经过原质量门禁。已完成上下文退休为历史；登记失败不能重跑或重建已完成成员。见下方“补登记原生执行”。

## 规划与确认

先读取当前项目团队。已有团队用 add_team_tasks 追加范围内的工作；岗位不足用 add_team_members，不重建团队。仅用户明确要求重组时使用 rebuild_project_team，先停止并接收旧成员终态。跨 Leader 不修改 owner 冒充接管，使用 read_project_team_takeover 返回原 Leader 入口。

为每项交付配置一项由不同成员执行的独立 review，审查岗位 writeScopes=[]，review 依赖原交付 submitted，后续业务依赖独立验收 accepted。职责/写范围用于调度和冲突检查，不是操作系统沙箱。默认 on-demand：首个就绪任务直接创建对应岗位，后续按任务隔离执行上下文；不先创建整队空闲成员。

plan_team 先保存团队目标、岗位、职责、写入范围、模型和执行设置，plan.tasks 留空；组建阶段只让用户确认成员和目标，不提前生成或要求逐项确认具体 task。auto/required 默认先确认团队；用户明确授权“直接做”可用 immediate 并记录原话。read_team_plan 展示组建草案，revise_team_plan 修改并产生新版本；approve_team_plan / cancel_team_plan 必须绑定用户实际审阅的 version/hash 和稳定 UUID。初始待确认时不得初始化、领取、启动成员或准备 worktree。已有确认和普通任务授权不用重复询问。

组建确认后，read_team.workflow.stage=task-planning，action=plan-tasks。Leader 在已确认目标、职责和写入范围内用 add_team_tasks 拆分具体工作和独立审查，再按需派发；不得再次要求用户逐项确认任务。拆分任务不更改组建批准的 version/hash；任务仍保留完整验收条件、依赖和证据。尚无任务不是完成，不能 finish_team 或归档。旧版尚未开工草案可在面板点击“改为只确认成员和目标”，或 revise_team_plan 设置 taskPlanning=leader、清空 plan.tasks 并保存；旧任务图保留在 planHistory，新版本必须重新确认。

新增岗位、扩大范围或提高并发/预算用 propose_team_change 暂存，批准前不应用；原已授权工作继续。语义范围扩大由 Leader 识别，不可用普通追加绕过确认。面板批准后核对保存的版本，再继续，不要求再次批准。

读取到 read_team_plan.review.feedback 时，保留当前待确认草案，结束当前规划，询问需要修改的内容并等待用户回复。不得自行批准、创建替代团队或继续扩写方案。取消草案后等待新的明确请求。

## 执行与自动推进

claim_team_tasks 批量预留当前就绪任务；使用返回的 prompt、taskName、spawnOptions 调用宿主原生 spawn_agent 或 followup_task。严格按照 action 和 taskName 执行：spawn-native-member 使用返回的唯一 taskName 与 fork_turns=none；followup-native-member 只用于该派发包指向的现有会话。contextIsolation.generation 标识同一岗位的会话代次，不得把新任务发给 contextHistory 中已退役线程。保存稳定 attemptId，返回真实 ID/路径后立即 bind_team_members；标题按 titleActions 设置。结果未知先核对，不重复启动；只有确认未启动才能 release_team_reservation。宿主批量调用部分成功时只绑定成功部分。

模型与档位来自实际宿主目录；打开待确认表单自动读取，失败时显示原因并可重试，保留未保存编辑。继承模型有真实快照时可直接调整其支持的思考档位，该修改保存为显式模型路由。显式配置和宿主默认继承的 model/provider/effort 快照纳入计划；未知字段保留未知。spawnOptions 是本次真实创建参数，记录 provider 不等于宿主支持任意 provider 切换。备用模型只可使用计划中已批准的 fallbackRoute；本宿主不能原地修改已有会话的模型；任务隔离创建的新会话仍沿用已批准路由，不能借隔离绕过模型变更确认。

收到成员完成通知后，用 advance_team_workflow 一次接收观察到的终态；dispatchReady=true 可预留下一批。默认最小回执包括 advancement.changes、最新 revision、动作与完整 dispatches，直接绑定或等待，不再为核对成功重读整队；view=summary 兼容旧摘要。接续仍调用宿主原生工具。独立审核通过后由插件在同一次 settle/advance 保存中校验当前轮次、合同版本、逐项 PASS、宿主验证命令、严重问题和交付输入；全部通过直接登记 target 与 review 为 accepted，解锁后续任务。Leader 不重复审查普通 PASS，仅处理 review-exception 和团队最终结项。已登记的同一 attempt 接收、已登记的同一审核轮次和相同最终结项可安全读取重试；重复回执不重新验证、不增加历史。已完成工作只因明确的新范围、合同变更或有证据的返工重新执行，不为补记录重复跑原任务。

团队内部通信只走宿主原生协作通道。Leader 用 send_message 向已绑定成员发送任务范围内的消息；followup_task 仅用于派发包明确指定的既有会话。成员使用 send_team_peer_message 保存消息，按返回的 nativeAction 用原生 send_message 发给真实父级或队友，再记录实际回执；缺少原生目标时保留待送达，不用聊天消息替代。成员终态由宿主内部完成通知交给 Leader，优先 wait_team_event 合并等待保存控制与原生终态。进度用检查点或 kind=progress 仅保存，必要问题/阻塞/完成通知才实际投递。consume_team_inbox 合并读取和确切收件轮次确认，超大消息 read_team_peer_message 分页读完再单独确认。不得使用 app.sendMessage、send_message_to_thread、thread/injectItems 或用户角色聊天条目传递团队协调指令；主聊天只展示给用户的必要进度、问题和结果。

面板确认、修改请求、停止、恢复和其他调整直接保存到原团队，保存不等于 Leader 已执行。展示待确认草案后，在当前 Leader 轮次使用 wait_team_event(teamId, revision, timeoutMs=45000) 等待保存事件；不要先结束轮次后依赖面板唤醒。该工具监听团队文件的原子保存及已登记成员的原生记录；记录变化只触发有界只读核对，不调用额外模型、不注入聊天。status=changed 或 member-terminal 回执内已包含 coordination，按最新动作推进已有授权，终态直接 advance_team_workflow；不再配套 read_team；timeout 不读状态、不读收件箱、不输出重复进度，直接继续有界等待。cancelled 不代表确认，也不自行续等。用户明确取消或暂停时停止等待。

已派发成员后，Leader 保持当前工作轮次，使用原生等待或 wait_team_event 让出计算。不得以“等待成员完成”为 final 结束轮次，留下运行中的任务依赖面板唤醒。任务全部独立验收、finish_team 已登记并且 workflow.stage=completed 后才能给出最终交付；用户明确暂停、取消或确有阻塞时按原流程停止。

成员工作期间优先单独 wait_team_event(timeoutMs=55000)，同时等待控制与终态，不交替 wait_agent 和零时探测。member-terminal 附准确 attempt IDs 与 coordination，直接 advance_team_workflow/settle 接收；有效审核由插件登记，Leader 处理异常。普通检查点、日志和用量更新在工具内部合并，面板照常更新。unchanged/timeout 沿用最新 revision 单独续等，不附加状态/收件箱读取或重复进度；必要待收件时 consume_team_inbox，沿用 cursor/after。先处理 stopping 并 reconcile_team_stop。未知投递不重发；不为轮询启动额外 agent。宿主没有唤醒已结束 Leader 的内部接口，有界等待超时仍需模型轮次，不能宣称零成本后台运行。

面板不再提供自动聊天通知开关或重试。coordinate_team 仅保留内部协作合同与旧通知的兼容读取，reserve 永远不返回发送机会；旧通知 consume 不授权推进。旧通知历史不删除。当前宿主未提供面板直接唤醒已结束 Leader 轮次的内部接口：没有活动 Leader 或事件等待时，操作保留为待处理，不能伪称已执行或退回聊天桥。重新加载新版插件连接后才采用该协议；不要让旧驻留 UI/技能继续发通知。

## 审查、停止与恢复

成员公开输出必须包含当前 TEAM_WORKSPACE_ATTEMPT 标记。report_member_team_task 只存草稿/检查点；Leader 核对宿主终态后 settle，交付才能 submitted。审查返回结构化 decision、checks、findings，所有条目有实际证据。存在 blocker/high、未覆盖目标或失败的验收命令时不能 accept。普通 PASS 不再调用 accept_team_review；仅对插件给出的 review-exception 读取所选轮次完整证据，处理真实返工或显式范围/非验证命令说明。缺失或无效证据保持 submitted 并显示具体异常，失败后返工保留全部尝试、用量和历史。autoRepair 只生成修复/复审任务，受轮次上限控制，不自动启动；修复交付仍须独立审核和插件校验。

同一任务在原会话中断续跑时继续使用原 attemptId/标记，不新建任务或替换会话。插件仅在同标记轮次连续、所有前置均有持久化中断证据时建立 turnAssociation，并在 bind / settle / reconcile_team_stop 的 revision 事务中关联最新轮次；旧 turnHistory、逐轮命令和用量保留。read_team 只观察，不修改关联。多份已完成结果、缺失中断证据或夹入其他任务时保持歧义，不按最新轮次猜测。默认只核对完成轮次的命令；旧中断轮次的成员 PASS 不能替代本轮验证，只有下文明确核对输入及宿主命令身份的补登记回执可复用。各轮完整证据按需 read_team_context(view=evidence, taskId, attemptId, section)，不复制全历史到成员提示。

## 历史验证关联与结果复用

0.30.0 保留原生命令 commandId、turnId 和实际 cwd。合同中的 `cd /绝对路径 && 命令` 可与在同目录直接执行的相同命令对应；不知道 cwd、目录不符、动态目录或额外脚本均不猜测匹配。prepare_team_command 在执行前保存声明输入指纹，verificationInputs 应包含合同范围之外的配置、测试、夹具与依赖文件。准备本身不执行命令，也不证明成功；同 requestId 重试保留首次指纹，不用当前文件覆盖它。

当前已提交 work 任务关联不足时，由原 Leader 使用 team_leader(operation=reconcile_team_verification)。参数包括 teamId/revision/taskId/attemptId、稳定 requestId/note、commands:[{turnId,commandId}]、inputProof，先 dryRun=true，核对后用相同参数 dryRun=false 保存。操作只重新读取已经存在的原生记录和输入文件，不启动模型、命令或测试，不使用主聊天桥。

inputProof 可选：

- `submitted-candidate`：仅补齐当前完成轮次的命令元数据，要求原提交输入指纹未变。
- `prepared-command`：提供 prepare_team_command 的 requestId；绑定其完整 nativeCommand、工作目录和执行前指纹，每份回执一条命令。
- `report-file-map`：field 指向原提交 JSON 内的路径→SHA256 表，例如 frozenInputs.sourceFiles；basePath 是此表相对项目的基目录，roots 是相对此基目录的完整验证输入范围。逐项核对全部文件及目录闭包，新增、缺失或改变的输入拒绝复用。
- `report-manifest`：额外提供 path、sha256、field；文件路径和 SHA256 必须都已声明在原提交报告中，先核对 manifest 未变，再校验其哈希表、basePath 与 roots。不能临时生成一份新 manifest 冒充旧证据。

中断历史只能使用后三类输入证明，且仅允许同一 attempt 的已保存连续中断链。原候选输入也必须未变；证明可扩展原输入闭包，不能替换已变化的提交或缩小范围。指定命令须有宿主持久 commandId、绝对 cwd、completed 与 exitCode=0；旧明确失败与新回执冲突时拒绝。新回执追加 verificationReconciliations，原 null、原输出、原报告、逐轮记录全部保留；read_team_context(view=evidence,section=verification) 分页读取。

插件按完整命令与实际目录匹配，不从包含 source、环境预热、动态日志路径等复杂脚本中提取一个被提及的子命令。外部环境和未声明依赖不由文件哈希证明。原报告中的当前条件 BLOCKED/FAIL/NOT_RUN 不自动改成 PASS；合同以外的未来 NOT_RUN 说明保留，不计入本轮或后续通过，未来任务仍独立验收。原审查失败、问题未关闭或候选改变继续保留异常。已有独立 PASS 且仅关联门禁失败时，保存后只重试插件校验，直接登记验收/解锁后续，不重复审查或重跑已有测试。验收及最终结项重新核对原提交和每份复用回执的完整输入指纹。

补登记数据要求 0.30.0，旧连接拒绝覆盖；已验收历史不可修改。跨 Leader、别的 attempt、新返工轮次或来源未知的结果不得自动套用。稳定 requestId 重放返回原回执，candidateUnchangedAtRecording 表示当时核对结果，不能当作重放时重新核实了当前文件。

合同修订必须带原因、稳定 UUID 和 patch，保存前后值及版本。运行中先停止并核实，已提交先返工；通过独立验收的合同冻结，扩大需求另建交付并确认范围。成员申报 changedPaths 不等于文件系统沙箱；独立审核负责检查实际 diff，插件核对其验收证据。交付可提供 verificationInputs，插件对声明的范围/输入保存内容指纹，在审核登记与最终复用时只读比对，不执行测试。外部环境、数据库、依赖或未声明输入变化不能由内容指纹保证；证据不再适用时按真实变化安排必要验证，不能仅因登记重复跑。

stop_team(reason,requestId) 先保存 stopping，随后 Leader 原生 interrupt 全部绑定成员，包括初始化。未知预留先核对，已启动先 bind，明确未启动才 release。reconcile_team_stop 独立核对最新轮次是否停止，空闲未知保持 stopping，全部核实才 halted。已明确关联且有效的 completed 交付保留 submitted，等待独立审查/Leader 判断，不改成 stopped 迫使重派；关联有歧义但宿主空闲已确认时可 halted，任务保留阻塞原因，不提交或验收。随后结束本轮工作。resume_team 必须记录明确恢复原因，retryTaskIds 仅重试选择的停止/失败任务，保留预算，不恢复取消任务。start 不能绕过停止。

read_team_recovery 只读取恢复包。原生成员控制能力需用宿主真实工具验证，再 record_team_recovery_control；失去句柄时暂停派发。完整重启后的控制恢复、跨 Leader 转移、直接中断主会话受宿主公开接口限制；不另建执行器或伪造可控状态。

## 组建后调整角色目标

用户可通过成员卡片的铅笔图标或管理入口直接修改角色目标（responsibility）。聊天中明确要求修改时，先 manage_team(operation="member-goal", teamId, memberId) 读取完整当前目标与 goalRevision，再 update_team_member_goal 带 team revision、goalRevision、稳定 requestId 和用户修改说明保存。不得自行改写用户目标；目标调整不改岗位名称/身份、写范围、任务目标、验收条件或当前执行会话，不自动启动成员或发送通知。扩大任务范围仍使用原有范围变更协议。

新目标从后续派发生效；已有预留或执行中的 attempt 保留原目标快照。保存结果未知时用原 requestId 与相同内容核对重试；目标版本冲突先保留草稿并重新读取，不覆盖他人修改。查看目标仅返回该岗位的当前原文及最近 10 次修订，不批量读取所有岗位历史。首次调整后数据最低版本为 0.15.0。

## 记录、模板与面板

contextChars 限制完整派发提示，包含固定指令、目标、验收、合同与历史摘要；超限不会保存预留，不可手工截断要求后继续。历史依赖/检查点按引用读取，任务完成后输出最终交付并结束，不在旧上下文领取下一项工作。

Leader 的日常协调使用 read_team(view=coordination, cursor=上次cursor)：changed 回包最多约6KB；team-unchanged 只返回继续等待。面板使用 state/panel，不能拿 state 或 full 当协调轮询。目标与验收原文按任务 read_team_handoff/read_team_context；交付、命令和输出用 read_team_context(view=evidence) 选中 attempt/section 分页，默认4000字符、最多8000。后续页必须带同一 cursor 与 nextOffset；hasMore=true 时继续读取所需完整证据，不能把片段当完整验收。full 仅显式取证，不反复复制团队历史。精简回执不是原始验收证据。保持任务、成员、轮次和阅读位置，不自动全量加载日志。query_team_tasks 使用版本绑定游标；manage_team 的 history 只读浏览同一项目和当前 Leader 的归档，不切换控制权。

save_team_profile 支持 seed 固定任务图和 leader 岗位/约束动态规划。两种模板均先确认成员和团队目标；确认后读取选中的模板，按当前目标调整 seed 或动态拆分带独立审查的 DAG，再 add_team_tasks。constraints 随实际任务保留。模板使用不能替换已有固定团队。删除模板绑定已读取的 updatedAt，冲突先刷新。

需求规格等 source-only 阶段审查若附带后续开发/浏览器/发布的 NOT_RUN 检查，先核对已确认的本轮范围、本轮各 criterion 的 PASS 和延期项的真实归属，再在 accept_team_review 中提供 deferredChecks [{checkIndex,reason}] 保存逐项范围理由。索引从原审查 checks 数组的 0 开始；不要改写原报告或 NOT_RUN，不请求用户批准绕过登记。未确认属于后续的检查仍不接受，FAIL/BLOCKED 和执行型任务不能豁免；延期项不能替代本轮条件覆盖，团队整体验证仍须完成。

关闭已有问题时保持原 finding ID 与严重性；独立审核的 resolutionEvidence 支持非空文字或非空文字数组，每项都须是具体、非空的证据说明。插件将合法数组按原顺序合为账本文字，保留审查原文和历史；空数组、混入空项或对象不能视为关闭证据。状态查询 query_team_tasks 仅返回摘要，原始交付与日志按指定 task/attempt 使用 read_team_context(view=evidence) 分页读取，不能为格式登记重复审核或测试。

所有交付独立验收后，由 Leader 用 finish_team 最终结项。已验收 integration 合同的当前交付与审核轮次、合同版本及声明输入内容仍有效时，finish_team 默认复用保存的整体验证证据，checks 可留空；不要为登记、重复通知或结项再次审查或重跑相同测试。缺少真实整体验证时才安排必要的新验证，单项实现测试或 source-only 审查不能冒充集成验证。已有其他有效最终验证可在 checks 引用，必要时显式 reuseEvidence=false。用户要求“最后统一验收”时，先完成实现和工程必要检查，将整体验收放到功能补齐后，不以未验证状态宣称完成。

0.14.3 可核对标准 shell 包装的完整验证命令。已有 submitted 交付因旧版命令匹配被拒时，保留当前 attempt，在核对原独立审查后重试 accept_team_review；验收会重新检查该 attempt 保存的宿主命令，不需要重新 settle、返工或重派。仍缺少成功命令、独立审查或后续验证时保持待验收，不修改历史证据绕过门禁。

0.21.0 修复中断续跑的检查点归属。旧检查点仍归原 turn，标为历史参考；本轮验收核对当前完成 turn 的真实证据。旧连接报 Checkpoint identity mismatch 时，重新加载连接并读取最新 revision 后，用原 taskId/attemptId 接收已完成轮次，不删除记录、不重派，也不要求用户批准绕过登记。新成员报告须先公开发出当前 attempt 标记；插件核对轮次后在同一事务关联与记录。

仅在需要检查点字段、消息回执、worktree 集成、导航或旧数据迁移时读取 [详细协议](references/protocol-details.md) 的相关部分。外部消息授权仍限用户任务范围，禁止把团队内部协调扩展为给他人聊天或外部服务发消息。

## 节制读取与用量

源码优先按函数、变更 diff 或约200行范围读取，执行工具 max_output_tokens 默认约2000；成功的测试/构建只返回摘要、真实命令/退出码和完整日志文件引用，失败时再读具体错误段。保持原目标、范围、合同和全部验收条件，不截断要求。完整日志和历史证据仍保存，只按需读取；functions.exec 只输出一次必要 structuredContent，避免重复打印整个 MCP 封装。

read_team_usage 默认返回成本摘要，分项按需 view=full。当前团队 createdAt 到最终验收/归档/替换期间，Leader 与经父级/项目确认的直接原生子会话按公开累计计数增量统计；同线程只计一次，区分输入、缓存输入与输出，未知不当作0。面板用量缓存最多10秒，派发前强制实时核对已配置的 tokenLimit；超限阻止新派发/初始化提示，保留已运行工作。兜底成员也纳入时间范围的保守成本统计，不能根据时间自动认领任务或通过验收；执行登记由原 Leader 保留原任务约定和真实关联证据后处理。插件预算不直接中断原生任务，也不能拦截绕过插件的宿主 spawn；原生兜底前仍需读取预算并遵守原授权。不能自行设置任意上限或改变已确认的模型/思考档位。

新且无关的目标在用户选择归档后使用新团队；旧成员已完成后新任务使用干净会话。中断续跑保留原任务上下文和证据，不为节省 token 重派。Leader 的旧聊天历史不能由插件原地清除；需要新主会话时须按宿主的用户授权规则交接，不自动新建聊天。

## 完成后的团队归档

目标完成、全部交付独立验收并登记 Leader 最终验收后，用户可显式选择归档团队。不要按任务相关性自行判断并自动归档；有关联的后续任务继续复用当前团队。

通过 `team_leader(operation=describe, toolName=archive_team)` 读取参数，再以 `team_leader(operation=archive_team, arguments=...)` 提交。必须绑定当前 teamId、revision、稳定 UUID requestId、归档说明及 source=leader-recorded-user-instruction；面板操作使用 panel-user-action。归档不调用模型、不停止或删除原生会话，也不清理 worktree。仍有待确认变更、预留或未结束成员时先处理原流程；不能用归档代替验收、停止或放弃目标。

归档保留全部成员、执行、修订、证据与最终验收，团队只读，从当前项目位置移至历史。后续 `plan_team` 可创建新团队；旧 UUID 重试只核对原归档，不能改变新团队。保存结果未知时保持原参数和 UUID 重试。归档后的数据最低版本为 0.16.0，旧插件连接拒绝写入。

## 0.21.0 source-only 阶段验收

当已确认的当前 task 只验收规格、设计或源码证据，原审查可能同时诚实列出后续工程/浏览器/发布尚未执行。accept_team_review 和 advance_team_workflow 的决定支持 deferredChecks [{checkIndex,reason}]，由原 Leader 核对已确认范围并明确分类；0-based checkIndex 绑定原 checks 数组，只有 NOT_RUN 可延期，状态及原文保持不变。当前每个 criterion 必须仍有独立 PASS；不允许豁免 FAIL/BLOCKED、执行型任务或缺失的条件覆盖，失败命令仍须原显式解释。deferredCheckExplanations 保存原 Leader 来源、理由、目标 attempt、合同版本和时间，数据最低版本为 0.21.0；最终 finish_team 的全 PASS 规则保持。不能自动分类或把阶段验收说成团队已完成。

## 0.22.0 小回包与成本范围

协调状态使用 read_team(view=coordination, cursor=上次cursor)。语义指纹覆盖目标、合同、控制、任务、真实轮次和必要待收件；仅 revision 递增、检查点/日志/非门槛用量跳动不重传。wait_team_event timeout 返回最新 revision 与 readRequired=false，直接再等；发生变化回执包含 coordination，终态直接 advance。停止优先，派发前预算强制实时读取。模型入口正文取 structuredContent ?? content 一次；content 只作短回执，不重复两份结果。

read_team_context(view=evidence) 的 section=delivery/commands/command/command-output；可选 attemptId，命令全文/输出用 commandIndex。offset=0 开始，默认 limit=4000，上限8000；后续请求带 cursor 和 nextOffset。hasMore 必须显式处理，不将片段当完整验证。命令列表仅给结果/索引/长度和全文引用，完整 command/output 与历史始终可读。

用量 summary 不复制所有历史任务，full 按需分项。当前团队期间的 Leader/已验证直接原生会话累计计数去重；兜底只计成本，不授予任务权限或自动验收。时间范围保守归属、遗漏/未知基线和间接成员边界见能力清单。tokenLimit 为空仍表示不限，不自动改变模型、档位或任意上限。
# 补登记原生执行（0.23.0）

原生兜底执行不会仅凭名称、时间或“完成”通知变成插件已验收任务。先读取现有交付和逐轮独立审查，明确原任务 ID、实际子会话 ID/路径、按顺序的 turnIds；返工追加到原任务，复审关联它实际审查的 targetKey/targetAttemptId。用 `team_leader` 查看 `register_team_native_attempts` 的 schema，先 `dryRun:true`，再使用相同 entries/requestId 和最新 revision 提交。补登记不能启动、重发或重跑任务。

中断前序必须连续且有宿主持久中断证明。原始公开交付、命令失败、检查点和逐轮审查保留；格式适配不把自定义状态转为 PASS。完成仅形成 submitted，已有 Leader 验收决定须显式恢复并通过全部既有质量门禁；后续 NOT_RUN 仅能在原 source-only 阶段解释，不能豁免最终验收。原本进行中的任务和新进度不得被历史导入覆盖。

补登记后的已完成会话退休为历史上下文，下一任务仍使用干净上下文。已登记的执行从原任务读取，不再创建“同名补跑”；若原生交付未结构化声明全部条件，Leader 从已有执行和独立审查证据补齐明确结论，不能以登记故障为由重跑已完成业务。每次导入有稳定请求回执，重复提交不增加轮次或消耗统计。


## 0.25.0 读取与记录同步

工具回执携带 pluginVersion，describe 带 schemaHash。同一操作在同版本内复用参数说明；版本变化或参数不兼容再读取。最小协调回执 registrationGap 仅提示已验证子会话缺少任务关联，不能推断这些会话的业务归属、验收或重跑。read_team_usage(view=full) 查看明细，确属当前目标才用补登记工具明确绑定原任务和顺序轮次。已绑定初始化会话按成员记成本，不误报为未登记。

用量拆分 cachedInputTokens、uncachedInputTokens、outputTokens，cacheRatio 仅在公开计数完整且一致时计算。累计处理量仍包括缓存，预算保持原口径，不能把新增输入视为账单或限额实际消耗。面板连接版本与资源版本不符时提示重新加载，不强制重启宿主。

## 长任务阶段交接与输出预算（0.29.0）

成员常用参数形状已在 dispatch 中给出。源码 read_team_source 按行分页，默认4000/最大6000字符并校验 cursor；长测试/构建 prepare_team_command 只准备日志与1200 token 输出上限，再执行返回 nativeCommand，保留宿主真实退出码/会话，read_team_command_log 按需分页（默认2000/最大6000字符）。不回传整文件、全部历史或成功长日志；原生工具仍由宿主控制，直接使用也遵守预算。

当前输入约60000 token 或30次命令后，成员可在明确阶段边界 report_member_team_task(handoff=true)，保存 summary/decisions/remainingWork/evidence/validation/verificationInputs，不含 delivery。将其 finalReceipt JSON 作为最终公开答复并结束。只有 exact completed + 检查点所有权 + 回执匹配，插件才置同 task waiting，新 generation 以 fork_turns=none 续接；未知、连接失败或中断不触发清空。每 task 最多3次，工作目标、独立审查与下游门禁保持，历史与失败额度保留。审核 task 不交接。续接先分页 read_team_context(view=evidence, section=checkpoint, attemptId=前阶段)，完整读取决策与剩余工作；所有原始记录可追溯。

续接包列出当前可复用的 contract.verify 索引；仅成功宿主命令且声明输入内容指纹未变可复用，提交前再次核对。输入改变、缺失或新合同均不能沿用旧验证；交付指纹包含复用输入，以阻挡提交后变化。显式合同修订保留旧阶段审计、沿用新范围，不能把旧合同证据视作新合同 PASS。交接不是提交或验收，最终独立审查仍由插件门禁登记。源路径与指纹不能证明未声明输入/外部环境不变。

通过 functions.exec 调用55秒等待时，使用首行 `// @exec: {"yield_time_ms": 60000}`，避免30秒提前返回再加一轮模型往返。原生命令仍在执行时等待同一 session，沿用 prepare_team_command.waitOptions（55秒/1200 token），不做高频短轮询；取消/暂停优先处理。

## 0.29.1 报告格式兼容修复

统一交付、审核与阶段交接的 JSON 接收规则，兼容首行任务标记和 JSON 代码块；首行、正文与绑定的当前任务标记须一致。保留旧纯 JSON、原始报告和全部历史，原范围、验证命令、独立审查、证据指纹门禁不变。旧格式拒绝缓存重新校验一次，不重跑成员或业务测试。数据最低版本仍按对应功能保存（阶段交接为0.29.0）。

## 保存审核原位登记（0.31.0）

`reconcile_team_review` 输入原 teamId/revision、taskId、attemptId、稳定 requestId、note；默认 dryRun=true。仅原 Leader 的当前完成独立审核适用：原 verdict=accept、目标仍 submitted、当前目标 attempt/合同一致、报告当前检查完整、严重问题有关闭证据。waiting 是插件登记失败的保留状态，不能当成审核未执行。先 preview，遇到 incidental failed command 用明确 commandIndex/reason 和已有纠正证据解释；真实验证失败、未知退出码不能补造成功。提交 dryRun=false 重新核对全部门禁，接受同一 review/target，不新增执行。原输出、命令、中断链、旧拒绝保存；`read_team_context(view=evidence,section=review-registration)` 分页读取映射和恢复审计。重复相同 UUID 返回原回执；变更内容、旧 revision、新候选或新目标不能借预览越权提交。

报告额外 NOT_RUN 的 criterionId 只从后续 work 的已确认合同解析，依赖链每条必须是 accepted。唯一所有者自动映射，存在多个所有者需在该 check 指定 futureTaskId。当前合同条件即使也出现在后续合同仍不可延期；未知项、FAIL/BLOCKED、空证据保留拒绝。映射保存原合同/依赖路径与报告摘要哈希，后续修订不改写旧证明。该规则与普通接收、显式审核和历史原生登记一致；后续任务仍 waiting，最终验收仍须真实 integration 证据。

验证命令按原生顺序使用最后一次匹配结果；后来的失败、执行中或未知退出码覆盖先前 PASS。不同目录或不同命令不互相覆盖；阶段复用记录位于当前命令之前。复审不对实施者的非合同辅助命令重复做一遍全命令审查，原命令和派生备注保留，合同验证和独立复审条件仍全部生效。

批量推进逐项登记；`advancement.changes/errors/partial/fromRevision/toRevision` 表示真实部分结果，不宣称跨多次持久事务的原子性。有异常的本批不继续自动预留。无效 completed 交付保存 settlementException，原输入未变不反复接收；纠正后显式重试或新证据变化才再校验，旧失败观察保留在历史。取消、停止、预算、真实返工和范围修改继续按原门禁处理，不能为清状态自动派新会话。


## 0.32.0 初始化链与旧准备记录恢复

环境初始化不靠匹配命令子串。reconcile_team_verification 的 commands 每项可明确 contractCommand（当前 contract.verify 原文）和 initializationCommands（按顺序完整列出 source/.、字面量 export/赋值或 node/python 文件初始化调用）。只支持以 && 串联并以原合同命令结束；参数、真实工作目录及退出码必须匹配。完整初始化链必须已在原始 commandsRun 声明，插件按原生 commandId 和宿主终态核对，保存绑定哈希与版本保护。管道、||、分号后续命令、动态参数、不透明脚本仍不能从中抽取一次 PASS。

旧 prepare_team_command 元数据若没有 inputSnapshot/nativeCommand，不得重新补造历史预执行指纹。改用原报告的文件哈希表，或已声明 path+SHA256 的 manifest。manifest 的 basePath 按原文件路径前缀填写，roots 选择原声明的源码/配置输入根，不使用项目根 '.' 扫描无关日志；全部 manifest 文件仍逐项校验，roots 内新增文件会阻止复用。提交候选原指纹、所有必验项和独立审查仍是门禁；声明输入不证明外部环境或未声明文件不变。先 dryRun，再使用同一稳定请求提交。保留原报告、未知退出码、中断与审查历史，补关联不启动模型或测试。
