### d-missing-path-stale-signal-ignores

- Decision: The missing-path stale signal ignores ticked checklist lines; open lines and prose still count.
- Alternatives:
  - Add a superseded marker to toggle_checkboxes so agents can strike a ticked line (new tool contract for a case the skip already clears)
  - Keep scanning ticked lines (a moved path leaves a warning the playbook forbids clearing by rewording)
- Why: A ticked line records what was done at the time; a later move of that path does not make the record wrong, and the playbook forbids rewording a closed item, so the warning could never be cleared.
- Consequences: A ticked line can name a path that no longer exists without any signal; prose and open items remain the current claims.
- Change: stale-closed-checklist
- Date: 2026-10-26
