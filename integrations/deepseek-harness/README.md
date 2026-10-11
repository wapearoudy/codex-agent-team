# Team Workspace for DeepSeek Harness

The current DSH conversation is Leader. This Cordis plugin registers the same
six compact Team Workspace tools, forwards their calls to `dist/server.cjs`,
and supplies identity from `exec.agent.id` and the exact live `ctx.sessions`
entry. It does not start a second coordinator.

Load the staged package as a Cordis plugin in the DSH profile, with dependencies
`tools`, `sessions`, and `agents` available. For DSH 0.1.7-rc.2, the profile's
native delegation tool normally defaults to `subagent`; its exact tool schema
comes from the active native request header. Team execution requires a profile
with native subagent delegation and the `send_message` / `interrupt_agent`
controls. Use the host's configured provider and model defaults.

The native package manifest declares `dsh.bundle.patch: ./cordis.patch.yml`.
The overlay uses the installed DSH `insert` grammar. The installer rewrites its
plugin name to the staged `dist/index.mjs` absolute path. Activate that overlay:

```text
dsh --profile <existing-profile> --patch <staged-package>/cordis.patch.yml
```

To verify composition without starting a model, add `--dump-config`. For manual
staging, first replace the template's `name: './dist/index.mjs'` with the absolute
entry path; profile-relative resolution cannot locate an unrelated staged folder.

`dist/index.mjs` has no DSH runtime package imports. MCP and Node dependencies
are bundled. `TEAM_WORKSPACE_SERVER_PATH` can override the bundled server;
`TEAM_WORKSPACE_NODE_BINARY` selects the Node executable. `bridgeRoot` is an
optional plugin configuration field; the same path is passed to the MCP child.

Public progress uses `session/event`, coalesced for 100 ms; terminal events and
tool calls flush immediately. Only native `turn/end` establishes a terminal
turn. An interrupt receipt remains a request. A session mounted after its
historical events have occurred reports unknown history until live events arrive.

There is no MCP App dashboard in this integration. Native tool results provide
the team view. No project URL, Codex session, or automatic chat message is used.

Protocol tests do not invoke paid models. Native model delegation and full
interactive workflow require validation in the user's configured DSH profile.
