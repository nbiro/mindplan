# Cline

1. **Register MCP** — in Cline extension settings, open **MCP Servers** and add a stdio server:

| Field | Value |
|-------|-------|
| Name | `mindplan` |
| Command | `npx` |
| Args | `mindplan-mcp` (or `-y mindplan-mcp@0.4` without a `package.json` dev dependency) |

Or merge the JSON from `mindplan/agent/mcp.json.example` into Cline's MCP settings file.

2. **Instructions** — MCP already requires `get_project` (dialect + project brief). `init` writes that stub to `AGENTS.md` when missing. Add it to `.clinerules` if this host does not read `AGENTS.md`. All graph mutations go through MindPlan MCP tools.

3. Enable the server in Cline and verify `get_mindplan_graph` is available.
