### d-frontmatter-body-separator

- Decision: Territory writes keep the newline after the closing frontmatter fence as they found it; a whole-body write puts one blank line above a body that starts with text and keeps the blank lines a body already starts with; promote keeps the next file's layout and line endings.
- Alternatives:
  - Normalize every write to exactly one blank line (each unrelated patch would silently rewrite a file's layout, and the clean-up would spread across unrelated diffs)
  - Write a whole body right after the fence, verbatim (a body that starts with its heading would lose the blank line every scaffolded file has)
- Why: A patch should change only what it names, and a whole-body write should match the scaffold layout without discarding blank lines the caller sent; existing runs are collapsed once, on purpose, not as a side effect.
- Consequences: Files with long runs keep them until a whole-body write collapses them; get_node_context bodies round-trip byte for byte.
- Date: 2026-10-20
