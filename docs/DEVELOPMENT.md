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
