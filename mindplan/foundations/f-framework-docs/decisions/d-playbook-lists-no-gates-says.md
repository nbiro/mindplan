### d-playbook-lists-no-gates-says

- Decision: The playbook lists no gates: it says how to act on a Blocked reply, and each reply names its kind and the call that clears it.
- Alternatives:
  - Keep the gate table (it repeats what each Blocked reply says, drifts with every gate change, and keeps the brief over the Claude Code session-start hook's 9,500-character budget)
  - Move the playbook into each project's rules (each project forks framework text that then drifts on upgrade; it is no smaller)
  - A new node for the trimmed text (the playbook is one file this node owns; a wording revision is the honest home)
- Why: Enforce, don't prescribe: the server's replies are the authority on the gates, so prose that restates them only adds a copy to keep in sync, and the shorter playbook fits the session-start brief whole.
- Change: trim-playbook
- Date: 2026-11-23
