### d-annotations-from-tool-kind

- Decision: MCP annotations are derived from one read / write / destructive kind per tool, the same kind that drives drift and verbose, and openWorldHint is always false.
- Alternatives:
  - Hand-write an annotations object on each of the twenty-seven registrations (a new tool can be added with a kind and no hint, and two tables drift)
  - Mark every write destructiveHint: true to be safe (every patch would prompt like a delete, and the host could not tell discard_next from patch_node_territory)
- Why: The host decides from the hints which calls need a per-call confirmation; one kind keeps the hint and the envelope behavior in one place so they cannot disagree.
- Consequences: A destructive tool is one that removes data or edges no undo restores (unlink_nodes, remove_attachment, discard_next, force_unship); a replace-with-empty write stays write. Adding a tool means naming its kind.
- Change: mcp-audit-fixes
- Date: 2026-10-20
