# Generic MCP client

MindPlan exposes a **stdio MCP server**. Any client that supports MCP over stdin/stdout can connect.

## Server command

```bash
npx mindplan-mcp
```

That runs the copy pinned in your dev dependencies (`npm install -D mindplan-mcp`). Without a `package.json`, use `npx -y mindplan-mcp@0.7`. From a source checkout: `node /absolute/path/to/mindplan/dist/index.js`.

## Environment

| Variable | Purpose |
|----------|---------|
| `MINDPLAN_ROOT` | Project root containing `mindplan/` (defaults to process cwd) |

## Agent instructions

MCP `instructions` already require `get_project` before answering or writing code. That call returns the dialect plus the project brief. If tools are hidden, use root `AGENTS.md` and host-installed skill copies — do not read or edit `mindplan/**` with host file tools.

Many agents auto-read root **`AGENTS.md`** — `init` creates the stub there when missing. Skills (`define-entities`, `plan-project`) load on demand.

## Verify connection

Once registered, the agent should be able to call:

```
get_mindplan_graph
```

A successful response confirms the server is wired correctly.

## Config snippet

See `mindplan/agent/mcp.json.example` for a portable JSON fragment to merge into your client's MCP configuration.
