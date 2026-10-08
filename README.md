# codex-agent-team

Team Workspace：当前 Codex 主会话担任 Leader，原生 subagent 作为固定团队成员，内嵌面板集中展示任务、执行、进度和依赖。

源码版本 **0.11.1**。这是实验性插件，能力与验证边界见 [能力清单](docs/CAPABILITIES.md)。

## 工作方式

- 计划确认：复杂新团队先审阅一次目标、岗位和任务，支持面板编辑或聊天确认；修改后旧确认失效。明确“直接做”可立即执行，普通追加沿用授权；新增岗位、扩大范围和提高预算单独确认，原团队继续运行。
- 同一项目保留一个团队，新任务追加给现有成员；需要新岗位时直接追加成员，重建由用户主动触发。
- 使用 `add_team_members` 追加岗位（活跃人数最多 8），按返回提示只初始化新成员，再用 `add_team_tasks` 分配任务。空闲且无未完成任务的成员可 `remove_team_member`，记录仍保留；`reassign_team_task` 改派等待/阻塞任务，旧轮次归属和重试预算不变。
- 成员与原生 subagent 一对一，命名采用「项目-角色」，接续使用已有线程。
- Leader 拆解、派发、停止与验收；面板展示任务和查看现有成员。
- 成员共享当前项目，按任务按需读取，不复制完整项目，没有 128MB 快照启动门槛。
- 任务预留、执行、提交、独立审查、最终验收分别记录，历史轮次不会冒充当前交付。
- 可声明阶段、写入/排除范围、验证命令与目标覆盖合同；需求独立验收后再实施。合同验收要求逐项 PASS 和宿主记录的成功命令；改动范围根据成员申报核对，不宣称自动发现所有文件改动。
- 可选择 `autoRepair`，由 Leader 确认退回后生成修复任务和独立复审，重定向下游依赖并保留原证据。问题 ID 跨轮追踪，严重问题需独立证据关闭；审查轮次超限暂停并升级给 Leader。
- 状态先显示、详情后台加载；面板预览限制 256 KiB，完整证据按需读取。实际执行中轮询目标间隔 250ms，已结束待接收的执行降为 1s。任务标签统一编号，依赖卡片 160×76px。
- 原生会话导航依赖宿主消息能力，失效请求不会打开旧目标。
- 执行完成前显示公开进度、命令输出和按轮次统计的 token 用量；不会展示隐藏推理。
- 成员持久收件箱、接续包、重试上限和有界工作流由 Leader 控制，工具回执与已读分别记录。
- 保存角色/模型/预算模板；压缩前置交付摘要，完整验收条件保留。
- 写入成员可选择 Git worktree；已独立验收候选经冲突预检后暂存合并，由 Leader 验证并提交。
- 任务号/状态搜索、公开报告导出、时延诊断和校验分卷保留长团队历史。

## 开发

需要 Node.js 22+，打包需要 Python 3，浏览器检查使用 Chrome。

```powershell
git clone https://github.com/wapearoudy/codex-agent-team.git
cd codex-agent-team
npm ci
npm run build
npx playwright install chrome
npm test
npm run validate
npm run package
```

构建输出到 `plugins/team-workspace-probe/dist/`，ZIP 输出到 `artifacts/`，生成文件不提交。GitHub Actions 在 Windows 上执行构建、回归、校验和打包。

## 本地使用

插件身份为 `team-workspace-probe`。构建并通过检查后运行 `node scripts/install-plugin.mjs`，登记本地来源并调用官方安装命令。已有来源会保留备份，不直接修改缓存或强制重启宿主。详细步骤见 [开发与安装说明](docs/DEVELOPMENT.md)。

Windows 默认发现当前用户安装的官方 Codex Desktop 可执行文件；自定义安装位置可设置 `TEAM_WORKSPACE_CODEX_BINARY`。仓库不包含开发者本机路径、登录信息或真实团队记录。

## 实际边界

执行由 Leader 所持有的原生协作工具控制，MCP 服务不能替代这些工具。视图读取宿主持久化快照，轮询间隔不是端到端时延承诺。成员写入范围属于任务约束和冲突调度，不替代文件系统沙箱。

浏览器/协议检查与真实 Desktop 原生执行分别验证；自动检查通过不代表未执行的宿主联调已经通过。原生会话导航不支持指定轮次锚点，历史轮次在面板中回看。

见 [架构与数据边界](docs/ARCHITECTURE.md)、[开发与安装说明](docs/DEVELOPMENT.md) 和 [插件使用协议](plugins/team-workspace-probe/skills/team-workspace/SKILL.md)。
