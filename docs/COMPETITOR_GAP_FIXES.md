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

DSH's dedicated native team tab and chat-header entry are not included in this
release. Claude/OpenCode still use their existing native tool/session entrypoints.
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
