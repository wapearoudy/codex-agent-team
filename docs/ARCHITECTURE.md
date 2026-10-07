# 架构与数据边界

当前主会话是 Leader。每个项目保留固定团队，每个岗位与一个原生 subagent 绑定。新任务追加到团队，执行由 Leader 的原生协作工具控制，插件不启动第二个模型调度器。

| 模块 | 职责 |
| --- | --- |
| `src/server.mjs` | stdio MCP 工具、宿主授权和视图资源 |
| `src/host-context.mjs`、`src/request-context.mjs` | 从真实宿主线程取得项目；仅在一次请求内复用授权元数据 |
| `src/project-teams.mjs`、`src/team-roster.mjs` | 项目固定团队、成员身份 |
| `src/leader-engine.mjs` | 任务预留、绑定、提交、返工、独立审查和最终验收 |
| `src/native-members.mjs`、`src/native-lifecycle.mjs` | 核对原生线程身份，观察公开执行与生命周期 |
| `src/team-mailbox.mjs`、`src/team-checkpoints.mjs` | 消息轮次隔离、确认和结构化检查点 |
| `src/team-navigation.mjs` | 有时限的用户导航请求和宿主回执 |
| `src/team-responses.mjs`、`src/panel-snapshot.mjs` | 轻量状态、完整历史和短期详情快照 |
| `src/team-view.mjs`、`src/team-projection.mjs`、`src/host.html` | 展示、依赖关系、轮次选择和阅读位置恢复 |

旧隔离团队模块保留兼容读取、停止及必要的历史写回/恢复；主路径禁止重新启动旧调度器。

任务原标识稳定，视图任务号按登记顺序生成。任务、attempt、成员、线程和 turnId 共同核对身份，不能用新轮次确认旧消息或旧交付。执行结束不会自动变成已验收。

控制操作先核对真实项目与 Leader，公开快照不包含隐藏推理或登录信息。`read_team` 提供 summary/state/full；详情缓存匹配 owner/team/revision/token，保留原观察时间，返回前重新授权。

运行数据存放在当前用户 Codex 数据目录，源码仓库不追踪该数据。原团队记录、截图和私有项目证据不作为公共测试样本。
