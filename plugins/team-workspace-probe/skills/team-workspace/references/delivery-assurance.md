# Reliable delivery and contract-linked independent review

New compiled reviews carry `reviewEvidencePolicy: "contract-linked-v1"`; historical verdicts keep their original gates. The read-only reviewer independently checks each exact target attempt and unchanged candidate. The plugin validates registration, identities, scope, required command outcomes and finding coverage; it does not decide that an arbitrary textual claim is true.

Each current criterion has exactly one factual check. All supported defects are reported together. A blocking finding uses this shape:

```json
{"id":"invalid-input","severity":"medium","status":"open","criterionId":"AC-input","basis":"source","evidence":"src/keys.py:7 performs set membership before validating list inputs","expected":"Invalid input raises ValueError","actual":"A list raises TypeError on this source path","description":"Required invalid-input error mapping is incorrect"}
```

`basis` is `source`, `saved-command`, `reproduction` or `missing-evidence`. Cite the actual inspected source or original log. Source-derived findings do not claim execution. Missing required proof stays BLOCKED/NOT_RUN with an explicit finding; uncertainty is not PASS. Do not run an already completed test merely to populate these fields.

Optional medium/low suggestions use `scope: "advisory"` and do not force repair. Every recorded contract finding, including medium/low, must later be included under its stable ID with `status: "resolved"` and concrete `resolutionEvidence`; dropping it from the next verdict or relabelling its scope does not close it. Correct formatting in the same bound reviewer turn during delivery preflight, before emitting the authenticated final receipt. A genuinely completed reviewer cannot rewrite its bound terminal turn.

Repairs carry bounded focus references, preserve the complete original criteria/commands and unrelated accepted upstream work, and reuse only authenticated results whose complete inputs remain unchanged. Changed/unknown inputs still need affected validation. Existing reports, command logs, rejected drafts, interrupted rounds and reviewer history remain immutable history.

Explicit `executionMode: "auto"` also requires `complexity: "low" | "medium" | "high"`. A single standard low/medium executable unit in Codex can use Leader execution plus distinct native independent QA. Explicit member model/provider routes, strict/risk scopes, multiple units and high complexity retain native executors. Auto selection never changes scope, quality gates or model routing. The result includes the decision and its reasons.

`workflow.idleBlockers` means no active reservation/member and no executable transition exists. Its task IDs and unmet prerequisites are displayed in the panel and compact coordination. Resolve the named exception once or end the turn with that blocker; no polling continuation is provided. It never infers completion or restarts work.

`qualityMetrics.deliveryQuality` reports saved independent first-review outcomes, accepted work, repair decisions, finding closure and saved goal duration. An accepted negative review is a registered verdict, not accepted implementation. Cancelled/superseded work is excluded from current work completion. Unknown rates/timings stay null. Correctness uplift and false-positive rate require a separately adjudicated comparative audit; these metrics alone do not establish either.

## 同轮登记补正和审核额度（0.40.43 新编译任务）

成员提交前，必需条件不能以“代码未改动”为由写成 NOT_RUN。先按当前合同核对原始源码和已有验证，对真实缺口保留 FAIL/BLOCKED。预检不通过时，在同一 attempt 中用新 requestId 修正报告，原草稿、真实命令和失败记录全部保留；不另起修复任务或审核轮次。

prepare_team_command 返回 mustReuse=true 时，执行参数为空，reuseEvidence 引用原生退出码和原始日志；只能在同一轮次、同一工作目录、完整预执行输入未变且最新结果成功时复用。最新失败、未知退出码、输入变化或输入范围扩张都不能复用历史 PASS。主会话 submissionInvocation 同样复用已有结果，登记补正不会二次运行测试。

新编译任务采用 code-rework-v1：maxReviewRounds 包括初审，代码修复最多 maxReviewRounds−1 次。PASS、草稿补正、工具重试不收费；独立审查明确只有 missing-evidence 的补证据修复另受 maxAttempts 限制。混合代码/证据问题按代码修复计数，不自动增加任何用户额度。旧团队保留原规则和全部审查证据。联合验收路由到代码责任人时携带完整发现证据，后续联合复审关闭原发现。额度不足只阻塞未通过的后续项，保留上游有效验收；返回责任人、分类、已用/上限和明确决策动作，禁止空转轮询。
