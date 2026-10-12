# 0.39.5 competitive continuation

The current conversation remains Leader. The existing fixed team performs SDK
research, native host implementation, independent review and integration checks.
No second team or background model coordinator is introduced.

## New implementation

- Release CI correction: the POSIX protocol test checks the formation-only
  persistence fence as 0.18.0; task planning and later role edits still assert
  0.37.0. These are distinct phases. No assertion was removed or relaxed.
  The failed v0.39.4 release workflow was stopped; its pushed tag is preserved.

- Leader weight reduction: `read_team` now defaults to `coordination`. Existing
  explicit summary/state/panel/full views remain available. Coordination replies
  link to `manage_team(operation=leader-brief)` rather than copying decision or
  execution history into every response.
- The authenticated Leader can page a derived decision brief with current-goal
  counts, unfinished tasks, all still-running native identities, current
  checkpoint decision references and explicit original-evidence access. Settled
  history stays in storage. Each page is capped at 6000 UTF-8 bytes; truncation and
  next offsets are explicit. Saved summaries never authorize execution or accept
  work and do not claim fresh native observations.
- Semantic waits ignore unrelated historical task and batch edits, while current
  dependency closure, other still-running tasks, global controls, permissions and
  actionable inbox changes remain relevant. Progress coalescing and plugin-gated
  ordinary acceptance are retained.
- The brief supports recovery after host-managed context compaction. This plugin
  does not erase the host's existing conversation context, create a replacement
  Leader or rebuild the team. No autonomous delegation threshold or model downgrade
  is introduced; existing startup/approval/review policies remain authoritative.

- Token optimization: complete initial dispatches carry `dispatchHash`; callers
  retaining that exact complete packet can opt into `knownDispatchHashes` on
  reservation retries. A hit returns a reference, never a native spawn/send
  action. Missing or changed digests return complete instructions. Member claims
  offer the equivalent `promptHash`/`knownPromptHash` protocol after participant
  authorization. Existing callers still receive full packets by default.
- Repeated fixed instructions are shorter without removing task/contract fields,
  identity markers, write scopes, independent review or evidence requirements.
  Local identical-task comparison against commit 59a3817: prompt 5231 to 4575
  characters (12.5% reduction); cached dispatch 5536 to 794 bytes (85.7%). This
  fixture starts no models and does not measure production token billing.
- Leader instructions explicitly require single-copy payload forwarding,
  selected source pages, semantic wait continuation, schema reuse and unchanged
  verification reuse. These govern caller behavior; arbitrary host tool output
  is not automatically truncated and required task instructions remain intact.

- Panel status totals include completed native turns awaiting Leader settlement.
  Member cards use that same pending-settlement state. Current-goal and historical
  attempt counts are labeled separately; panel/state responses compute exact
  member totals before preview truncation. A real Chromium regression reproduces
  the five-task case: four waiting plus one awaiting settlement, zero accepted;
  switching to all history changes every task denominator consistently.

- `continue_interrupted_team_task` explicitly resumes a settled interrupted
  attempt in its unchanged native member context. It preserves the attempt,
  marker, interruption evidence, contract and budget. Current native identity,
  latest persisted interruption, dependencies and concurrency are checked before
  one revision-fenced mutation. Replayed request IDs return no second dispatch.
  No model is started by the operation. An old interrupted turn cannot settle
  while the request awaits the new marked turn. Rework remains a new attempt.
- Pending first-turn bindings can record checkpoints after an exact public
  marker observation verifies the first turn; absent, ambiguous or foreign
  observations do not mutate the saved association.
- Actual packed Desktop shell tools may return `isError: false` even when the
  process exits nonzero. Explicit nonzero rendered SDK exit markers now produce
  failed command observations with advisory rendered-output provenance. Rendered
  zero markers never establish success.

## Actual Desktop verification, 2026-10-12

The local 0.39.0 tarball was installed and enabled through the actual DSH Desktop
0.2.0-rc.2 plugin manager. The isolated README-only workspace created exactly two
native child sessions. The own engine header showed the running task; its owner
link opened the exact reader child. Clicking native Stop persisted an interrupted
turn. The attempted continuation failed: rework/claim generated a new attempt and
context, and the existing child could not bind. This is retained failed evidence,
not a successful closed loop. The independent source-only reviewer returned
rework, with findings `DSH039-SAME-ATTEMPT-RESUME` and
`DSH039-INSTALLED-CANDIDATE-STALE`.

0.39.1 addresses the protocol defects and is a separate immutable local candidate.
Its installation and actual Desktop continuation verification remain pending.
Regression fixtures and local engine tests do not replace that step. Native
shell startup also failed once with Windows status 3221225794; subsequent
README-only model work used the native read tool and did not change shell,
subscription or model settings.

- DSH ships a public browser client export and a native conversation-header slot.
  Its separate `teamWorkspace` session projection carries the authenticated
  current Leader's fixed team and active-batch task records. Serial polling
  coalesces unchanged data; failed reads never renew freshness. Non-surface
  events do not add model-visible messages. Member/task navigation requires an
  exact verified child, a fresh snapshot and a retained native parent address.
  The official `agentTeam` fallback is explicitly labeled. Actual installed
  SDK projection tests pass; retained native UI mounting remains under review.
- Versioned Leader-curated reference decisions retain the exact accepted task,
  attempt, contract revision and bounded input fingerprint. `knowledge-save`
  requires the authenticated Leader and the current team revision. Repeated
  request identities are idempotent. New revisions retire old revisions without
  deleting history; `knowledge-retire` records a reason. `knowledge-decisions`
  performs bounded lexical retrieval and rechecks source identity and contents.
  Changed/inaccessible inputs, replaced attempts and amended contracts never
  count as fresh verification. This is reference memory, not vector RAG or an
  independent review of the Leader's wording. Existing `knowledge` stays compatible.
- Diff audit separates the shared Git inventory from exact native file-change
  operation receipts. Only verified thread/turn public rollout events identify
  an operation. Missing/truncated events stay incomplete; reported operations
  do not prove exclusive authorship of the current shared diff. Scope violations
  are advisory audit facts, not operating-system sandbox enforcement.
- Diagnostics separately record planning→reservation, reservation→binding,
  binding→first public activity, native completion→settlement and submission→
  acceptance. Unknown timestamps and panel render delay stay null. Observed
  tokens come from native usage records, never fabricated billing estimates.
- Nonempty textual evidence arrays are losslessly accepted as citations. A
  tool-free, consecutive, byte-equivalent structured report resend after a
  completed bound native turn cannot replace that execution or its commands.
  Changed evidence, commands, intervening turns or running resends still fail
  closed. Original public reports and native IDs remain in the audit trail.

## Verification and remaining boundaries

Verification logs and review results are retained locally under `evidence/`.
The real installed DSH Web runtime boots in an isolated temporary profile with
an empty credential snapshot and zero model turns. The browser client module
and navigation/status behavior are also checked using explicit public-SDK
fixtures; fixture evidence is not evidence of paid agent execution.

DSH's transport provider is not an arbitrary model-provider override. The
installed in-process implementation expressly does not inherit parent tool
restrictions or authority. Native host permissions must be configured and
verified separately. Claude/OpenCode continue using their existing native
interfaces; no undocumented cross-runtime transport or idle-Leader coordinator
is invented. Full automatic file-author attribution, OS sandbox enforcement,
vector RAG, comprehensive billed-token/model latency comparisons and new native
Claude/OpenCode UI contributions remain unsupported or unverified.

Public npm publication is blocked by `npm whoami: ENEEDAUTH`. The initial anonymous GitHub REST request was rate-limited. The authenticated
connector subsequently verified run 38147100761: Windows passed; Ubuntu and macOS
failed the same outdated protocol-test assertion (expected persistence fence
0.18.0, actual 0.37.0). This release corrects that assertion to the real quality
policy fence without weakening lifecycle/authorization checks. The new candidate
still requires an actual CI run. Neither a local tarball nor a configured CI
matrix is advertised as a public release or a three-platform PASS.

---

# 0.38.0 competitive gap repairs

The current conversation remains Leader. This release was implemented and tested
by the main session without starting any subagents or test models.

## Shipped

- Management UI supports light, standard and strict acceptance. High-risk work
  forces strict mode, explicit criteria and verification commands. Advanced scope
  fields are collapsed. A completed goal directs new requests to the main chat,
  which reuses the fixed team and establishes the next batch.
- `add_team_tasks.batchReviewId` atomically adds standard deliveries to an
  unstarted review in the same goal. Dispatched reviews, strict deliveries,
  self-review and unapproved scope expansions cannot be merged. Historical
  receipts are preserved. The persistence fence is 0.38.0 for expanded reviews.
- `manage_team(operation=doctor)` and `npm run doctor -- --registry` distinguish
  running version, newest verified local cache, host capabilities and unknown
  model access. Cache presence does not prove active host registration. Registry
  probing is explicit, read-only and performs no model requests or login.
- DSH processes each observed public event once instead of retaining and replaying
  the entire raw event array. Concurrent publications coalesce to one follow-up.
- OpenCode running-message updates use public native events after an SDK baseline;
  terminal events and plugin tool calls force an authoritative SDK read. Ambiguous
  deltas request a refresh. Events arriving during a full read are replayed so
  completion and tool output cannot be overwritten by an older baseline.
- Claude avoids re-reading and parsing unchanged transcript files. Replacement,
  truncation or append invalidates the cache. Path/identity checks and native
  lifecycle authority remain in place. Cache memory and entry count are bounded.
- Provider/model concurrency caps use saved member routes and are enforced during
  scheduling/reservation. Raising or removing an existing cap requires the normal
  policy expansion confirmation. Routing does not silently change models.
- `manage_team(operation=diff-audit, teamId=...)` inventories real Git changes,
  including renames and untracked paths, scope coverage and overlapping writers.
  Shared-project changes are explicitly unattributed, including pre-existing
  work. This is an audit, not an OS write sandbox or proof of a particular author.
- `manage_team(operation=knowledge, teamId=..., query=...)` retrieves accepted
  contracts and criteria with exact task/attempt/revision/fingerprint provenance.
  Historical knowledge never claims current verification or execution authority.
- CI covers Windows, Ubuntu and macOS, with browser suites serialized to avoid
  the observed parallel startup contention. Non-Windows results remain pending CI.
- Cross-host docs, manifests and MCP client version share 0.38.0.

## Verification boundaries and remaining competitive gaps

The browser UI check runs the shipping view against the real local engine in
Chrome. It is not a complete live Desktop UI or paid cross-host execution test.
The observer benchmark compares identical local event input and final evidence;
it excludes disk writes, model latency, host first-frame latency and billed tokens.

DSH's native chat-header entry is implemented and the 0.39.0 candidate was opened
in actual Desktop. A separate dedicated native team tab is not included.
Claude/OpenCode still use their existing native tool/session entrypoints.
Implementing a new browser contribution requires a versioned host UI contract and
actual host UI verification; Codex URLs must not be substituted for native links.
Some hosts still do not expose verified per-child provider/model overrides or
idle-Leader wake-up. No background coordinator, fabricated capability or silent
model downgrade is added to imitate those features.

Full automatic file-author attribution, OS sandbox enforcement, semantic decision
memory/RAG and task-wide comparable token/latency benchmarks remain open. The
shipped inventory and accepted-contract search are deliberately narrower.

Public npm distribution still requires authenticated publication. A locally
verified tarball is not a public npm release. `doctor --registry` reports the
actual public version state; installation documentation is conditional on it.
