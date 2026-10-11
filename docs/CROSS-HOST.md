# Native hosts

Team Workspace 0.33.1 separates host integration from the existing team engine.
The current conversation is Leader in every host. Team persistence, role/task
identity, versioned approval, independent review, reservations, evidence and
unknown-state handling stay shared. Existing Codex teams and paths remain intact.

| Host | Native integration | Delegation/control | Display |
| --- | --- | --- | --- |
| Codex | Existing MCP plugin and app-server read-only observer | spawn/followup/interrupt | Existing embedded MCP App |
| DeepSeekHarness | Cordis native plugin, actual caller/session events | Continuable profile subagent; send_message/interrupt_agent | Native tool results |
| Claude Code | Native plugin, MCP server and Hooks | Agent; TaskOutput/TaskStop using actual task receipt | Native tool results and Agent task output |
| OpenCode | Native plugin SDK, actual caller/session API/events | task; verified child abort | Native tool results and native session IDs |

No unsupported host is given a fake Codex URL or a static external dashboard.
The Codex embedded panel is not currently reproduced as a native UI extension in
the three other hosts. Native tools provide task/member state in those hosts.

## Build and load

Run `npm ci`, `npm run build`, `npm test`, `npm run validate`, `npm run package`.
Build writes standalone packages to `artifacts/hosts/<host>` and packaging writes
one checksummed ZIP per host. Source entrypoints live in `integrations`.

Stage an existing built package with:

```
node scripts/install-host.mjs --host opencode --project /absolute/project
node scripts/install-host.mjs --host claude-code --project /absolute/project
node scripts/install-host.mjs --host deepseek-harness --project /absolute/project
```

OpenCode registers a project-local plugin wrapper. Claude Code stages a complete
native plugin: load the returned directory through `claude --plugin-dir PATH` or
its official plugin marketplace flow. DeepSeekHarness stages its native package
and Cordis overlay: select the intended profile explicitly and follow that package's
README. Staging is not reported as activation. Codex still uses the existing
official `node scripts/install-plugin.mjs` registration.

DSH fixed members require a `backgroundMode: continuable` profile exposing
`subagent`, `send_message`, and `interrupt_agent`. The adapter checks the installed
tool's declaration of reusable subagent IDs as well as those controls. Unknown
wording requires profile verification. It rejects one-shot profiles before
dispatch: their job IDs do not identify reusable member sessions. Binding still
requires the actual native `subagentId`, parent, project, and attempt marker.
The actual tool schema determines background support. Sibling messages are
saved for the Leader to relay; native DSH permits parent/child messaging only.

All packages require Node 22+. Hooks and native integrations use the same MCP
engine; they do not start a coordinator or use another provider as a fallback.
`TEAM_WORKSPACE_HOST` is explicit and rejects unknown values. Non-Codex team data
uses `~/.agent-team/<host>/team-workspace`; an explicit data root is additionally
namespaced under `hosts/<host>`. Shared bridge metadata uses
`~/.agent-team/bridge/<host>` (overridable for isolated verification).

## Identity and execution

A native plugin/hook issues an expiring, single-use ticket for the exact session
and compact MCP tool. Supplying a project or session ID in model arguments does
not authorize it. Snapshots preserve host parent/project/turn identities. The
existing observer checks parent, canonical directory and exact attempt marker
before binding, settlement, navigation or command verification.

Only public text, command records and token counters are retained. Reasoning,
credentials and request headers are excluded. Native terminal events determine
completion; an abort request alone never proves a member stopped. When events,
command exit codes or historical records are unavailable, their status/evidence
stays unknown. Transcript delay does not trigger another spawn.

OpenCode and DSH delegation inherit their native presets. Per-member model or
effort overrides are rejected unless that native tool exposes a verified route;
the actual model is recorded at binding. Claude Code can use observed models in
its Agent model argument, but no per-member effort argument is invented. No host
gets the Codex model catalog or an automatic downgrade.

## Verification boundary

Protocol fixtures are regression evidence, not proof of a paid model run.
`scripts/verify-hosts.mjs` records available runtime versions, package validation,
native registration/API smoke results and zero model starts separately. Actual
model delivery, permission prompts, provider quota and interactive UI require
their respective host; report these separately when not run.

For this release, installed Claude Code 2.1.290 passes native plugin validation;
DSH 0.1.7-rc.2 passes actual Cordis/ToolRuntime registration and overlay parsing;
OpenCode 1.18.3 passes native server registration and parent/child session events
through the bridge. Independent checks use the installed DSH tool schema and
lineage authorization, not a model run. Model delivery/resume/stop are NOT_RUN
in all three new hosts. Codex source/cache byte equality is checked separately;
an existing resident MCP connection is not silently replaced.

API references: [Claude Code Hooks](https://code.claude.com/docs/en/hooks),
[Claude plugin manifests](https://code.claude.com/docs/en/plugins-reference),
[OpenCode plugins](https://opencode.ai/docs/plugins/),
[OpenCode SDK](https://opencode.ai/docs/sdk/),
[DeepSeekHarness source and type contracts](https://github.com/deepseek-ai/deepseek-harness).
