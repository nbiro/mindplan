# Any MCP client

MindPlan is a stdio MCP server. Register this command, started in the project root (or set `MINDPLAN_ROOT` to it):

```bash
npx mindplan-mcp
```

From a source checkout, use `node /absolute/path/to/mindplan/dist/index.js`. As JSON (the package ships it as `templates/agent/mcp.json.example`):

```json
{
  "mcpServers": {
    "mindplan": { "command": "npx", "args": ["mindplan-mcp"] }
  }
}
```

The connection works when the agent can call `get_project`.

Without a `package.json` that pins `mindplan-mcp` (`npm install -D mindplan-mcp`), run `npx -y mindplan-mcp@0.18` (in JSON config: `"args": ["-y", "mindplan-mcp@0.18"]`). Then reload MCP servers and ask your agent to **set up MindPlan** ([what happens next](README.md)).
