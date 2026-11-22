### d-stop-hook-dirty-tree

- Decision: The Stop hook runs the default check only when the working tree has a changed path in the source universe or under mindplan/, blocks at most once per stop, and sends back only the Blocked: lines.
- Alternatives:
  - Run the check on every stop (about 2.5 s on this repository at the end of every question-and-answer turn, and a repository already red would send every turn back)
  - Run the merge gate (in-review is legal on a branch, so it would block normal mid-feature turns)
  - Exit 2 with the full check output on stderr (warnings and info would bury the Blocked lines the agent has to fix)
- Why: The duty it enforces is 'hand off on a green check' after changing files. A clean tree means nothing was handed off, and one block per stop guarantees an agent that cannot fix the cause can still end its turn and say why.
- Consequences: A repository that was red before the turn, where the agent touched files, sends the turn back once even if the agent did not cause the failure. Changes outside the source universe and mindplan/ never trigger it.
- Change: claude-plugin
- Date: 2026-11-22
