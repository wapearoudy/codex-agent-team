# Quality policy and goal batches (0.37.0)

The current host conversation remains Leader. One project keeps one fixed team;
new goals append batches rather than creating replacement teams. Historical
attempts, failures, findings and approvals retain their original meaning.

## Policy selected before dispatch

| Mode | Delivery acceptance | Final goal acceptance |
| --- | --- | --- |
| `light` | Leader calls `accept_team_delivery`; exact native completion, current candidate and required criteria still checked | No invented integration requirement |
| `standard` (new batch default) | One independent read-only reviewer may cover several related deliveries | All current batch deliveries and declared goal criteria accepted |
| `strict` | Separate independent review for each key delivery | Valid accepted integration evidence, not a free-form PASS assertion |

`riskFlags`: `security`, `data-migration`, `concurrency`, `execution-protocol`,
`publication`. Any declared risk raises its task to strict. Leader must assess
semantic risk; file count alone is not a sufficient classifier. User scope,
model route and permission approvals remain authoritative. Policies are frozen
on dispatch, and old teams without these fields keep legacy review semantics.

## Append a goal through `add_team_tasks`

Provide `batch: {id, title, goal, qualityMode, goalCriteria, integrationRequired}`.
Reuse that ID only for the same unfinished goal and policy. Tasks receive its
`batchId`; contract `coverageOf` refers to its goal criteria. A completed batch
cannot silently be reopened or have its policy replaced.
When a current goal is still active, ordinary append without `batch` inherits
that goal and its mode. After closure a new batch is required; unknown or foreign
batch IDs cannot silently hide tasks from dispatch and final acceptance.

For a standard batch reviewer, provide both `reviewOfTaskId` (first target) and
`reviewOfTaskIds` (all targets), with a `submitted` dependency on every target.
Each target must belong to this same batch and use a different member from the
read-only reviewer. Within a batch, use `when: delivered` for implementation
dependencies: native completion and required delivery checks must pass, but the
joint review need not run early. Use `accepted` for a true review barrier and
split batches when that barrier would otherwise form a deadlock.

Batch review reports contain `attemptMarker`, `summary`, overall `decision`, and
`targets: [{taskId, attemptId, summary, decision, reason, checks, findings}]`.
Exactly one verdict is required for each current target attempt. Overall decision
is accept only when all targets accept. Registration is atomic; a stale target
cannot partially pass the batch. Each passed target receives its own receipt.

## Blocking and advisory evidence

Every required criterion and validation command must pass. Known unchained
read-only `rg` no-match exit 1 is a diagnostic observation, unless that command
is itself declared mandatory. Exit 2, unknown failures and shell chains remain
exceptions. Classification and raw host records are retained.

An extra check may use `scope: advisory`; it cannot satisfy or waive a required
criterion, and must retain its actual FAIL/BLOCKED/NOT_RUN status. Unknown check
scope must be resolved, not guessed. Open high/blocker findings always block;
reviewers should report concrete impact and evidence, leaving stylistic
suggestions non-blocking. Existing downstream NOT_RUN association remains valid.

Reuse successful host evidence on unchanged declared inputs. File fingerprints
cover declared project inputs, not undeclared external systems. A changed input
requires appropriate fresh verification; metadata registration errors do not
justify respawning or rerunning already valid work.

## Repair and final closure

A mixed batch review retains its passed branches and creates scoped repair plus
one re-review when `autoRepair` is enabled. Otherwise Leader explicitly calls
`plan_team_repair`. Repair limits stop that branch and escalate to Leader; they
do not grant permission to ignore a defect or pause unrelated branches.

`finish_team({batchId, ...})` closes that goal only, keeping the project team
available. Historical blockers/findings outside that batch are preserved and
excluded from its closure. Current relevant findings and goal coverage still
block. Strict/integration-required batches require reusable accepted integration
receipts. Ordinary source research has no artificial integration test.

The task view defaults to the active goal, with a history toggle. Execution
completion and acceptance are separate labels. Recorded metrics count review
dispatches separately from reservations, registration exceptions, diagnostic
observations, verification reuse and repeated successful verification on the
same recorded candidate. Duration is summed only for attempts with known bind
and terminal timestamps; concurrent durations can overlap. They are not a
billing calculation or a speed benchmark.
