# Generic MCP client

MindPlan exposes a **stdio MCP server**. Any client that supports MCP over stdin/stdout can connect.

## Server command

```bash
node /absolute/path/to/mindplan/dist/index.js
```

Or after npm publish:

```bash
npx mindplan-mcp
```

## Environment

| Variable | Purpose |
|----------|---------|
| `MINDPLAN_ROOT` | Project root containing `mindplan/` (defaults to process cwd) |

## Agent instructions

MCP `instructions` already require `get_project` before answering or writing code. That call returns the dialect plus the project brief. `mindplan/agent/playbook.md` is the fallback if tools are hidden.

Many agents auto-read root **`AGENTS.md`** — `init` creates the stub there when missing. Skills (`define-entities`, `plan-project`) load on demand.

## Verify connection

Once registered, the agent should be able to call:

```
get_mindplan_graph
```

A successful response confirms the server is wired correctly.

## Config snippet

See `mindplan/agent/mcp.json.example` for a portable JSON fragment to merge into your client's MCP configuration.
