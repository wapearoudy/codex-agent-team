# Cross-host bridge contract (0.33.0)

The main host conversation remains Leader. A native plugin/hook supplies the
actual caller session and project; the MCP model arguments cannot choose them.
Codex paths and behavior stay compatible. Other hosts use separate data roots.

`src/host-bridge.mjs` exports `HostBridge({host, root?})`, with canonical host IDs
`deepseek-harness`, `claude-code`, `opencode`. `root` is the bridge directory,
default `TEAM_WORKSPACE_BRIDGE_ROOT` or `~/.agent-team/bridge/<host>`.

- `file`: shared durable registry path; `ensure()` initializes its directory.
- `putThread(thread)`: save a normalized host snapshot (never a model claim).
- `readThread(id)`: return an exact snapshot, or throw. Claude may refresh only
  registered transcript files whose root/identity was checked by native hooks.
- `setModels(rows)`, `readModels()`: model/list-shaped rows, observed source
  explicit. No synthetic Codex models and no invented effort support.
- `issueContext(threadId, toolName)`: random expiring single-use ticket bound
  to an existing native session and exact tool; returns ticket string.
- `authenticate(ticket, toolName)`: atomically consume matching unexpired
  ticket and return `{threadId}`. Fail closed on absence, replay or mismatch.

Normalized thread: `{id,cwd,parentThreadId,model?,modelProvider?,reasoningEffort?,
createdAt?,turns:[{id,status,items,usage?,activity?,statusEvidence?}]}`. IDs and
turn boundaries come from host events. `items` uses existing observer vocabulary:
`userMessage/content`, `agentMessage/text/phase`, `commandExecution` with actual
`commandId,cwd,command,exitCode,status,aggregatedOutput`. Include public text,
commands and token counters only; exclude reasoning, request headers, secrets.
An uncompleted turn stays `inProgress`/`unknown`, never guessed completed.
Interrupted turns need `{status:'interrupted',source:'persisted-turn-aborted'}`
from a native cancellation terminal event, not an abort request receipt.

Native plugin distribution is in `integrations/{deepseek-harness,claude-code,
opencode}`. Each launcher uses this same bundled MCP engine, passes tickets
through `_hostTicket`, and preserves the six compact model tools. No secondary
coordinator model. No automatic main-chat messages. MCP App UI stays available
where supported; unsupported hosts use native tool results honestly.
