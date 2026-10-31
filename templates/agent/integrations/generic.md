# Generic MCP client

MindPlan exposes a **stdio MCP server**. Any client that supports MCP over stdin/stdout can connect.

## Server command

```bash
npx mindplan-mcp
```

That runs the copy pinned in your dev dependencies (`npm install -D mindplan-mcp`). Without a `package.json`, use `npx -y mindplan-mcp@0.13`. From a source checkout: `node /absolute/path/to/mindplan/dist/index.js`.

## Config snippet

A portable JSON fragment to merge into your client's MCP configuration (the package ships it as `templates/agent/mcp.json.example`):

```json
{
  "mcpServers": {
    "mindplan": {
      "command": "npx",
      "args": ["mindplan-mcp"]
    }
  }
}
```

## Environment

| Variable | Purpose |
|----------|---------|
| `MINDPLAN_ROOT` | Project root containing `mindplan/` (defaults to process cwd) |

## Verify connection

Once registered, the agent should be able to call:

```
get_project
```

A successful response confirms the server is wired correctly.

## Set up MindPlan

Ask your agent to set up MindPlan in the repository. It calls `setup_project`, which creates `mindplan/`, and follows the guide that call returns: it writes `MINDPLAN.md` at the root, points the files your agent reads at it (`@MINDPLAN.md` in `CLAUDE.md`, a line in `AGENTS.md`, or the host's own rules file if it reads neither), adds the ignores, and proposes moving your standing rules into the project brief.

## Agent instructions

MCP `instructions` already require `get_project` before answering or writing code. That call returns the dialect plus the project brief. Skills (`define-entities`, `plan-project`) are served by the server: the agent loads them with `get_skill`. Do not read or edit `mindplan/**` with host file tools.
