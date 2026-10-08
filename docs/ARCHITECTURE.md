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
| `src/native-public.mjs` | 已授权原生记录的增量公开事件、精确轮次 token 基线 |
| `src/team-peer-mailbox.mjs`、`src/team-recovery.mjs` | 任务限定的成员收件箱、恢复交接与真实控制回执 |
| `src/team-policy.mjs`、`src/team-workflow.mjs` | 模板/路由/预算/摘要与有上限的 Leader 动作建议 |
| `src/team-worktrees.mjs` | 可选 Git 隔离、操作日志、验收提交绑定及暂存集成 |
| `src/team-control.mjs`、`src/team-version.mjs` | 停止请求、最新宿主终态核实、明确恢复及最低读取版本 |
| `src/team-contracts.mjs` | 合同修订审计、版本与旧证据失效、通过合同冻结 |
| `src/model-catalog.mjs`、`src/member-work.mjs` | 宿主模型目录/档位验证与成员自身任务权限 |
| `src/team-diagnostics.mjs` | 版本绑定分页、公开报告与原始时间诊断 |
| `src/team-document.mjs`、`src/team-archive.mjs` | v2 事务、旧写入保护、原始备份、不可变校验分卷 |

旧隔离团队模块保留兼容读取、停止及必要的历史写回/恢复；主路径禁止重新启动旧调度器。

任务原标识稳定，视图任务号按登记顺序生成。任务、attempt、成员、线程和 turnId 共同核对身份，不能用新轮次确认旧消息或旧交付。执行结束不会自动变成已验收。

控制操作先核对真实项目与 Leader，公开快照不包含隐藏推理或登录信息。`read_team` 提供 summary/state/full；详情缓存匹配 owner/team/revision/token，保留原观察时间，返回前重新授权。

运行数据存放在当前用户 Codex 数据目录，源码仓库不追踪该数据。原团队记录、截图和私有项目证据不作为公共测试样本。

0.9 系列在事务内保存 worktree 候选提交；审查接受和集成必须核对该提交，验收后的额外修改不能沿用旧结论。Git 副作用的操作日志独立落盘，记录提交失败时通过身份/HEAD/索引核对既有结果，不重复合并。

分卷先写入并同步，再提交清单；固定段边界避免每次追加都生成历史尾卷。业务读取仍完整还原并验证团队，以保留依赖、attempt、requestId 去重和旧证据语义。summary 返回未完成及最近已完成任务，其他历史按任务检索；这不是无限历史常数内存承诺。

0.12 新计划默认按需启动：岗位先登记，首项任务就绪后才由 Leader 以任务交接包创建原生成员；原有团队保留初始化方式。停止使用 stopping/halted，与独立审查升级分开；停止核实必须检查宿主最新轮次，不能用旧初始化的 completed 冒充空闲。成员报告保存来源与原始草稿，只有真实宿主终态接收才产生 submitted，独立审查和最终验收保持 Leader 权限。
