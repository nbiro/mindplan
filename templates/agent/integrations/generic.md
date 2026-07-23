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

Point your agent at these files (installed by `mindplan-mcp init`):

- **`mindplan/agent/playbook.md`** — always-on SDLC execution process for all software work
- **`mindplan/agent/skills/define-entities/`** — step-by-step entity creation (scaffolding)
- **`mindplan/agent/skills/plan-project/`** — plan-only product modeling (no application code)
- **`mindplan/agent/skills/review-work/`** — Plan Review and Implementation review (separate Reviewer session)

Many agents auto-read root **`AGENTS.md`** — `init` creates one when missing.

## Verify connection

Once registered, the agent should be able to call:

```
get_mindplan_graph
```

A successful response confirms the server is wired correctly.

## Config snippet

See `mindplan/agent/mcp.json.example` for a portable JSON fragment to merge into your client's MCP configuration.
