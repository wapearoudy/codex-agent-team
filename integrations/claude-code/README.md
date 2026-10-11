# Team Workspace for Claude Code

Run Claude Code with `--plugin-dir` pointing at the staged package root. The
package includes `.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`,
the bundled `hooks/bridge.mjs`, and `dist/server.cjs`. Node must be on PATH.

The current Claude conversation is Leader. PreToolUse supplies an expiring,
single-use `_hostTicket` to each of the six Team Workspace MCP tools. Native
session ID, agent ID, parent ID, and cwd originate in hook input. Model arguments
cannot choose them. SubagentStart records real direct-child identity.

SubagentStop records public final text. Stop hooks can be blocked, so observing
a stop hook does not establish committed completion. Settlement needs a
structured Agent or TaskOutput receipt for that exact child. A background Agent
receipt must supply both its real task ID and agent ID; the bridge stores that
mapping. TaskOutput must return that mapped task's completed or failed status.
If the host omits a structured identity/terminal receipt, status remains unknown;
do not invent task IDs or accept the work from final text alone. TaskStop records
only a request and never marks the agent stopped.

Transcript files are read only after native hooks register their checked
identity and authorized Claude project-storage path. `CLAUDE_CONFIG_DIR` is
supported. Late transcript data, hidden reasoning, request headers, and credentials
do not become lifecycle authority. Public final JSON reports retain their text.

There is no supported native MCP App panel here. Use the six compact native
MCP tool results. The plugin creates no Codex session, URL dashboard, or separate
coordinator model. Real Agent/TaskOutput receipt shapes must be validated in a
configured Claude Code session before claiming end-to-end completion.
