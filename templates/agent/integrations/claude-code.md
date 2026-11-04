# Claude Code

From the project root:

```bash
claude mcp add mindplan -- npx mindplan-mcp
```

Or commit it to `.mcp.json` so everyone who opens the repo gets it, cloud containers included ([Claude Code MCP docs](https://docs.anthropic.com/en/docs/claude-code/mcp)):

```json
{
  "mcpServers": {
    "mindplan": { "type": "stdio", "command": "npx", "args": ["mindplan-mcp"] }
  }
}
```

Without a `package.json` that pins `mindplan-mcp` (`npm install -D mindplan-mcp`), run `claude mcp add mindplan -- npx -y mindplan-mcp@0.19`, or use `"args": ["-y", "mindplan-mcp@0.19"]` in `.mcp.json`. Then reload MCP servers and ask your agent to **set up MindPlan** ([what happens next](README.md)).
