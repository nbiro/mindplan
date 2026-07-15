# Cline

1. **Register MCP** — in Cline extension settings, open **MCP Servers** and add a stdio server:

| Field | Value |
|-------|-------|
| Name | `mindplan` |
| Command | `node` |
| Args | `/absolute/path/to/mindplan/dist/index.js` |

Or merge the JSON from `mindplan/agent/mcp.json.example` into Cline's MCP settings file.

2. **Instructions** — add to `.clinerules` or root `AGENTS.md`:

```
Follow mindplan/agent/playbook.md for MindPlan SDLC workflow. All graph mutations via MindPlan MCP tools only.
```

3. Enable the server in Cline and verify `get_mindplan_graph` is available.
