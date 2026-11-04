### d-one-blank-line-below-frontmatter

- Decision: Every node file write puts exactly one blank line between the closing frontmatter fence and the body (none above an empty body), and splitContext returns the body from its first text, so reads never hand back leading blank lines.
- Alternatives:
  - Keep the layout as found (d-frontmatter-body-separator): runs left by releases before 0.2.0 never collapse, because get_node_context returns them and a body round-trip writes them back
  - Collapse only on whole-body writes (an agent that edits with section or replace patches, or only moves status, never cleans the file)
  - Strip leading blank lines on read only (the files keep the runs, and every diff and host editor still shows them)
- Why: Users hit the runs as dozens of empty lines above the heading; the scaffold always writes one blank line, so normalizing to it on every write is the only rule that makes old files converge without a migration.
- Consequences: The first write to an affected file also removes its extra blank lines, so that write's diff carries an unrelated layout change once; a file without a trailing newline and an empty body gains one.
- Supersedes: d-frontmatter-body-separator
- Change: body-blank-lines
- Date: 2026-10-26
