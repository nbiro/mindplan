### d-checklist-tag-syntax

- Decision: A checklist item's stable id and kind are a trailing tag on the line ({#id} or {#id kind}); default ops carry {#spec}, {#impl}, {#verify} for every type; toggles match by id or exact text only.
- Alternatives:
  - Frontmatter list of item metadata (separates the item from its kind and breaks when lines move)
  - Keep substring matching (ambiguous and needed a lookup before every tick)
- Why: The tag keeps id and kind on the line they describe, survives edits and rebases, and stays readable in plain markdown.
- Change: checklist-kinds
- Date: 2026-11-03
- Nodes: f-compiler-rules, i-edit-territory
