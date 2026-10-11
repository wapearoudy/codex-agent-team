# Team Workspace for OpenCode

Install the staged package and import its single default export from a file in
`.opencode/plugins/`. The installer creates that wrapper. The package bundles
its tool schemas and MCP client; it does not require an SDK npm package to
resolve from global host installation directories.

The plugin supplies native custom tools for the six compact MCP operations.
`context.sessionID`, native session metadata, messages, and status supply the
verified current project and public evidence. Native `task` creates direct
children under the current Leader. Its configured `general` agent model is
inherited; this integration does not claim a per-task model override.

`team_workspace_control({action:"abort",sessionId})` checks that the target is
an exact direct child in the Leader's project before calling native session
abort. Its receipt says requested. Settlement waits for committed message state;
an idle status or receipt alone cannot prove completion or cancellation.

The MCP server is `dist/server.cjs`. In the embedded Bun host it is launched
with Node from PATH, not with the OpenCode executable. Set
`TEAM_WORKSPACE_NODE_BINARY` when Node is not on PATH. Optional
`TEAM_WORKSPACE_SERVER_PATH` overrides the bundled server path.

The native plugin has no URL or static dashboard. Public results are returned
through native tools. Real model calls, model-specific delegation, and cancellation
completion must be validated in a configured OpenCode session.
