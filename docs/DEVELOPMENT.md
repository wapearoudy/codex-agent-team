# 开发与安装

需要 Node.js 22+、Python 3。浏览器回归使用 Chrome；Windows 是当前完整自动验证的平台。

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

`scripts/register-probe.ps1` 面向已经存在本地 marketplace 配置的 Windows 宿主，会备份配置并保留原条目。插件已经登记或来源不一致时拒绝覆盖；它不是任意宿主的一键安装器。

已登记本地来源后，可通过官方 `codex plugin add team-workspace-probe@fusion-local` 安装；marketplace 名称须替换为本机登记名称。不要编辑已安装缓存。

Windows 自动发现当前用户安装的官方 Codex Desktop。自定义安装位置使用 `TEAM_WORKSPACE_CODEX_BINARY`，不把个人路径写入公共清单。主会话必须具有原生协作工具，缺少能力时不能换执行宿主冒充接入成功。

## 升级与验证

修改源文件后构建，更新版本、资源 URI 和相关断言，运行受影响检查。`scripts/stage-upgrade.py` 先核对已登记来源与上一版 ZIP 一致，再更新来源并验证宿主配置未变；运行前保留上一版 ZIP，不覆盖其他流程修改过的来源。

`scripts/verify-installed-current.mjs` 需要真实当前 Leader ID，验证安装文件、工具发现和项目元数据；它不验证 Desktop 视觉显示。安装版本与实际驻留连接版本分别记录。

不要提交真实日志、会话 ID、团队数据、个人配置或生成包。补丁保留原团队、历史轮次与验收条件；fixtures 明确标为受控数据，原生联调证据留在本机。
