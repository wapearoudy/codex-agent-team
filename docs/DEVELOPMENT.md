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

运行 `node scripts/install-plugin.mjs`。脚本保留其他目录条目，核对来源身份，备份已有插件来源，再通过官方 `plugin marketplace add` / `plugin add` 安装。来源冲突时拒绝覆盖；备份保留在来源目录旁。安装结果与当前驻留连接版本是两项证据，安装成功不会证明旧连接已重新加载。

已登记本地来源后，可通过官方 `codex plugin add team-workspace-probe@fusion-local` 安装；marketplace 名称须替换为本机登记名称。不要编辑已安装缓存。

Windows 自动发现当前用户安装的官方 Codex Desktop。自定义安装位置使用 `TEAM_WORKSPACE_CODEX_BINARY`，不把个人路径写入公共清单。主会话必须具有原生协作工具，缺少能力时不能换执行宿主冒充接入成功。

## 升级与验证

修改源文件后构建，更新版本、资源 URI 和相关断言，运行受影响检查。`scripts/stage-upgrade.py` 先核对已登记来源与上一版 ZIP 一致，再更新来源并验证宿主配置未变；运行前保留上一版 ZIP，不覆盖其他流程修改过的来源。

0.9.0 首次写入旧团队时备份原 JSON，以 `.v2.json` 为新版权威文件，将旧文件设为升级保护标记。旧服务拒绝写入，不能用旧版本继续该团队；新版即使在迁移中断后也能核对原始备份恢复。不要删除分卷或降级写入团队文件。只读加载不自动恢复模型。

打包生成 ZIP 与 SHA256 文件。标签发布流程在 Windows 上完整验证后上传构建包；公开包不包含真实团队记录、宿主会话或账户信息。未验收宿主能力见 [能力清单](CAPABILITIES.md)。

`scripts/verify-installed-current.mjs` 需要真实当前 Leader ID，验证安装文件、工具发现和项目元数据；它不验证 Desktop 视觉显示。安装版本与实际驻留连接版本分别记录。

不要提交真实日志、会话 ID、团队数据、个人配置或生成包。补丁保留原团队、历史轮次与验收条件；fixtures 明确标为受控数据，原生联调证据留在本机。
