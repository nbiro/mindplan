### d-check-hotspot-line-points-to-spec

- Decision: run_check prints each hotspot as one short line that names the diagnosis and points to get_spec({ topic: "open-closed" }); the registry and split paragraphs stay in the open_next warning and the full orient reply.
- Alternatives:
  - Print the advice once per run as an Info line: compact output would have to tie an info line to the warnings it lists, and the text is already in the spec topic and in the open_next reply
  - Keep the paragraph on every line: five hotspots filled the 8 KB reply and pushed the change's own warnings off the page
- Why: The check's job is to say which hotspots under work are unanswered. How to refactor is needed once, at the moment of reopening, where open_next gives it with the decision prompt.
- Change: planning-friction
- Date: 2026-11-12
- Nodes: f-compiler-rules
