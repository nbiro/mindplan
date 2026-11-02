### d-export-refuses-over-budget

- Decision: Over MCP, a diagram longer than an 80,000-character budget is refused with the fix (focus or output) instead of returned; output writes it to a file; the CLI never applies the budget.
- Alternatives:
  - Return the first N characters with a truncated flag (a cut Mermaid diagram renders nothing, so the partial result has no use)
  - Page the diagram (a diagram is one document; pages of it cannot be rendered separately)
  - Apply the budget on the CLI too (stdout and files have no limit, and CI uses the CLI for the full map)
- Why: The host would truncate the result silently; a refusal that names the two working paths costs the agent one more call, a damaged diagram costs it the task.
- Consequences: output is restricted to the project root outside mindplan/, since the MCP server is the only writer of that tree.
- Change: mcp-audit-fixes
- Date: 2026-10-20
