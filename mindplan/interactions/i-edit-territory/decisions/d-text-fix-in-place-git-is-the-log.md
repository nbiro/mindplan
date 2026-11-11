### d-text-fix-in-place-git-is-the-log

- Decision: A wording-only edit of a shipped node (patch_node_territory reason "text") is written to the live file in place with no revision, guarded by an unchanged set of ## headings and checklist items; its record is the live file's updated_at and git diff, not a log kept in the node.
- Alternatives:
  - Keep the revision cycle for wording (open_next, patch, a decision above the blast radius, ship: four calls and a made-up decision for a one-word fix, which happened twice in one day)
  - Append each text edit to a log file beside the node, like confirmed.json (a node holds current state only and git already keeps the diff and author; a second history would grow forever and drift from git)
  - Trust the reason with no guard (a body rewrite under reason text could add a section or drop a checklist item, a contract change with no revision or decision)
  - Refuse while a revision is open (the fix would wait for an unrelated change to ship; a ship already rebases every revision onto live)
- Why: The revision cycle exists to review contract changes; wording changes none, and a path that costs four calls gets skipped or faked. The structural guard is cheap and catches the edits that are not wording.
- Consequences: The guard cannot tell a reworded sentence from one whose meaning changed: that stays the agent's claim, visible in the git diff. Renaming a ## heading or rewording a checklist item needs a revision. No count of text edits exists outside git.
- Change: lighter-edits
- Date: 2026-11-11
