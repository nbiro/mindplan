### d-reads-free-writes-through-tools

- Decision: Agents may read mindplan/ with host tools; only writes must go through the MindPlan tools, and the opt-in Claude Code hook denies host Edit/Write there and nothing else.
- Alternatives:
  - Keep reads through MCP only (agents grepped node files anyway because it was cheapest; enforcing the ban took find_in_node, search_graph, and a hook, and the hook still missed whole-repo greps and false-denied unrelated mindplan/ folders)
  - Allow host writes too (writes are where the guarantees live: the store keeps frontmatter, revisions, decisions, and claims consistent, and the orientation gate gets rules to the agent before it writes)
- Why: Every guarantee hangs on the write path (orientation gate, store-only writes, merge gate), so reads add no risk to it; what a raw read lacks (inherited rules and decisions, a revision's full record) is stated in the pointer, playbook, and server instructions, and orientation still delivers it before any write.
- Consequences: An agent can act on a raw file read without a node's inherited rules until it orients or writes; find_in_node stays for snippets guaranteed unique. A hook installed with the older, wider matcher answers reads with no output, so no reinstall is needed.
- Change: read-node-files
- Date: 2026-11-08
- Nodes: f-agent-hook, f-mcp-runtime
