# 开发与安装

需要 Node.js 22+、Python 3。浏览器回归使用 Chrome；Windows CI 已配置；各版本的实际运行结果与 Desktop 联合验收状态见能力清单。

```powershell
npm ci
npm run build
npx playwright install chrome
npm test
npm run validate
npm run package
```

`schemas/` 保存公开 Agent Plugins 1.0 JSON schema；校验不依赖私有证据。`evidence/` 和 `artifacts/` 按需生成并被 Git 忽略。

## 本地安装

构建产物为 `plugins/team-workspace-probe`，包括标准清单、技能和自包含服务/视图。使用本机 Codex 支持的本地 marketplace 来源安装。

运行 `node scripts/install-plugin.mjs`。脚本保留其他目录条目，核对来源身份，备份已有插件来源，再通过官方 `plugin marketplace add` / `plugin add` 安装。来源冲突时拒绝覆盖；备份保留在来源目录旁。安装结果与当前驻留连接版本是两项证据，安装成功不会证明旧连接已重新加载。

已登记本地来源后，可通过官方 `codex plugin add team-workspace-probe@fusion-local` 安装；marketplace 名称须替换为本机登记名称。不要编辑已安装缓存。

macOS 自动发现系统或用户 Applications 中官方 Desktop 自带的 Codex 程序；Windows 自动发现当前用户安装的官方 Codex Desktop。自定义安装位置使用 `TEAM_WORKSPACE_CODEX_BINARY`，不把个人路径写入公共清单。主会话必须具有原生协作工具，缺少能力时不能换执行宿主冒充接入成功。

## 升级与验证

修改源文件后构建，更新版本、资源 URI 和相关断言，运行受影响检查。`scripts/stage-upgrade.py` 先核对已登记来源与上一版 ZIP 一致，再更新来源并验证宿主配置未变；运行前保留上一版 ZIP，不覆盖其他流程修改过的来源。

0.9.0 首次写入旧团队时备份原 JSON，以 `.v2.json` 为新版权威文件，将旧文件设为升级保护标记。旧服务拒绝写入，不能用旧版本继续该团队；新版即使在迁移中断后也能核对原始备份恢复。不要删除分卷或降级写入团队文件。只读加载不自动恢复模型。

打包生成 ZIP 与 SHA256 文件。标签发布流程在 Windows 上完整验证后上传构建包；公开包不包含真实团队记录、宿主会话或账户信息。未验收宿主能力见 [能力清单](CAPABILITIES.md)。

`scripts/verify-installed-current.mjs` 需要真实当前 Leader ID，验证安装文件、工具发现和项目元数据；它不验证 Desktop 视觉显示。安装版本与实际驻留连接版本分别记录。

不要提交真实日志、会话 ID、团队数据、个人配置或生成包。补丁保留原团队、历史轮次与验收条件；fixtures 明确标为受控数据，原生联调证据留在本机。

0.13.0 的模型入口收敛为 team_leader / team_member；用 describe 按需获取单项 schema。历史业务名称仅作为 app/兼容调用保留，操作鉴权、修订检查和审批不变。扩展技能参考文件必须一起打包。

0.14.0 使用固定岗位与按任务隔离的原生执行会话。task-context.mjs 核对历史所有权、退役代次和完整派发预算；预算预检必须位于 claimMany 的同一事务内。不要恢复跨任务 followup、复用退役路径、在观察进程 resume/compact 模型，或用删除验收要求的方式让提示符合预算。历史用量按真实 threadId 分组回读，导航按 attempt 的真实会话定位。

0.14.1 的控制区与计划摘要由 team-view.mjs 维护，轮询不得覆盖可选说明、重试选择与管理草稿。停止/恢复继续走 revision + UUID 协议，自动理由仅替代必填表单，不改变确认终态、预算或范围授权。首屏只保留工作进度、成员与操作入口，诊断与通知设置按需展开。

0.14.2 的任务列表与依赖图共用 filteredTasks，列表仅使用 data-list-task-id，不复用图的 data-task-id，防止选中链路混淆。列表打开详情需可见且支持键盘焦点，关闭回原任务；控件颜色不作跨主题背景渐变，以免切换瞬间产生低对比文字。


0.18.0 新组建团队使用 taskPlanning=leader 和 planReview.confirmation=team。planConfiguration 不含具体 tasks；待确认时任务必须为空，批准后 workflow 返回 plan-tasks，Leader 用 add_team_tasks 追加工作与独立审查，不产生第二次初始确认。finish 和 archive 拒绝空任务团队。遗留草案需显式 revise 转换，原版本历史保留。模型目录打开待确认表单时自动读取，异步完成只刷新 selects，不能重建表单覆盖输入或焦点。

0.19.0 全部面板通信路径禁止 app.sendMessage，不能用 thread/injectItems、send_message_to_thread 或另起模型轮次伪装内部通信。wait_team_event 在已有 Leader 调用内监听团队目录原子替换，只读紧凑 revision，最长 55 秒（默认 45 秒），并清理取消/超时的文件监听。低频文件回读仅补偿丢失事件，不读取原生会话或调用模型。Leader 在成员通知及最长 60 秒原生等待后核对控制状态；停止优先。旧 coordinate_team reserve 无发送机会，消费旧通知不能重新授权动作，历史保留。插件版本更新到 0.19.0，既有业务数据 schema 最低版本保持对应功能门槛（组建为 0.18.0）。

0.20.0：不要用返回时间替代样本时间，也不要让较新的业务 revision 携带的旧 run 覆盖现场观察。mergeRunObservation 按原生身份、时间及续跑链合并；UI 终态不代表业务已提交，settling 明确表示等 Leader 接收。相同请求的回执重试不得重复写入或重跑验证；不同决定、原 attempt/合同已变更仍拒绝。NativeMembers.inspect 只合并同时进行的完全相同只读观察，不缓存后续控制判断，且仍先核对父级和项目再加载轮次。wait_team_event 监听子记录仅触发只读核对，合并事件并限为每秒一次；团队文件的慢速回读不轮询成员日志。

0.21.0：checkpoint.turnId 是不可变的历史归属，不要求等于 attempt 当前 turnId；历史身份必须出现在通过验证的连续中断链内，不能只信任 turnHistory 的 ID 列表。关联后存在历史检查点时设置最低版本 0.21.0，所有数据功能校验须接受该版本。新检查点只观察目标成员，成员身份在观察前校验，当前轮次核实与写入在同一 revision 事务内完成；旧 requestId 原样回放，不重新观察或改绑。进度和旧 PASS 不参与正式验收。回归覆盖链损坏、无标记续跑、旧连接、原记录不变与完整归档路径。

阶段验收：accept_team_review/advance_team_workflow 提供 deferredChecks [{checkIndex,reason}]，只适用于 source-only 当前任务的额外后续 NOT_RUN；必须逐项明确，不按名称、状态或自然语言自动猜测。本轮验收条件的覆盖只计算 PASS。保存 deferredCheckExplanations，绑定目标 attempt 和合同版本并保护最低版本 0.21.0；校验历史原报告和延期索引，重试匹配延期说明，原证据不改写。执行型任务、FAIL/BLOCKED、未解释失败命令和 finish_team 仍要求真实通过。

0.22.0：coordination cursor 仅绑定身份、revision、控制、动作、终态和待收件；不要把 progress/observedAt/usage ticks 放进 cursor。超时继续 wait，不读 state/inbox；停止保存仍通过 FS 事件即时返回。evidencePage 游标绑定所选原生结果和合同，后续页必须带 cursor，不用全团队 revision 让稳定证据反复失效。

UsageWindow 只保存数字，基于累计计数去重与时间界限求增量；未知基线不置零，样本上限造成截断必须报告不完整。NativeMembers 先验证 Leader 项目、再发现公开子 ID，先验证子 metadata 父级/项目和创建范围再读计数；不加载子 transcript、解密或赋予兜底执行权限。展示缓存10秒/单飞，fresh 预算查询不复用展示中途请求。预算以去重线程 ledger 总数为准，attempt 明细仅归因，不相加两次。控制回执只用已有缓存，不能重读无关成员。文件变化对象/数组兼容，失败时重置解析位置确保下次不跳数据。

0.23.0：`register_team_native_attempts` 仅补登记既有执行。显式 task/thread/path/turnIds，元数据父级与项目先验证，连续中断链依赖宿主持久终态，原生自定义标记不得猜测关联。稳定请求回执及确定性 attempt ID 防止重试重复计数，TeamStore revision 保护新进度；dryRun 不写。逐轮审查必须绑定对应目标 attempt，rawDelivery 与格式适配摘要同时保留，非标准状态不转换为 PASS，历史验收仍走普通门禁。末轮已完成上下文退休，旧连接可以读取兼容的 0.21 生命周期字段，识别外部标记需要 0.23。局部维护脚本 `scripts/register-native-work.mjs` 要求保存明确人类修复授权并验证真实原 Leader/项目；不能构造跨会话 MCP _meta 或改变团队所有者。

## 0.29.0 执行成本优化

增加受限源码/日志分页、原生命令日志准备、明确完成的阶段交接与同任务干净续接、输入未变化的宿主验证复用、语义事件合并、等待内协调回执、合并收件确认、版本化 schema 指纹与 router 单份正文。进度保留在面板，正常进度不触发主会话消息。不会降低模型档位、强制重置执行中会话、重跑已完成工作。原生命令工具仍由宿主控制，输出预算在派发协议与插件助手中执行；最长55秒工具等待仍需要后续模型轮次，插件不能在 Leader 结束后静默启动模型。

## 0.29.1 报告格式兼容修复

统一交付、审核与阶段交接的 JSON 接收规则，兼容首行任务标记和 JSON 代码块；首行、正文与绑定的当前任务标记须一致。保留旧纯 JSON、原始报告和全部历史，原范围、验证命令、独立审查、证据指纹门禁不变。旧格式拒绝缓存重新校验一次，不重跑成员或业务测试。数据最低版本仍按对应功能保存（阶段交接为0.29.0）。

## 0.31.0 团队流程系统修复

统一当前合同与后续检查归属：普通审核、显式验收与历史原生登记共用范围规则；执行任务可保留有明确后续合同的 NOT_RUN 说明，不将当前失败或缺失检查放行。旧审核 PASS 的登记失败可通过 reconcile_team_review 预览并原位补登记，保留报告、检查、拒绝与中断历史，避免无意义的二次审核。

命令验证使用最后一次匹配的宿主结果，当前失败/未知不能被历史成功覆盖；阶段复用核对工作目录。停止期间登记不恢复执行状态；保存审核恢复要求原控制已恢复。批量推进返回真实部分成功与异常，失败的 terminal 交付缓存具体原因，不反复自动接收；原失败记录保留。场景回归覆盖正常执行、异常和恢复路径；真实业务核对记录仅保存在本地。
