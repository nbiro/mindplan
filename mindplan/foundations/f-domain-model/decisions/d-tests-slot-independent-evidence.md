### d-tests-slot-independent-evidence

- Decision: A node's `tests` list is slot-independent evidence, like its rules: one writer sets it on live and on an open next alike, a shipped node changes it in place without open_next, and the write never resets readiness.
- Alternatives:
  - Treat tests like implements: a contract write that needs open_next on a shipped node and sends a ready revision back to draft (linking an existing test to a shipped node would cost a full revision)
  - Keep tests only on the active slot (a discarded revision would drop links that still hold for the live code)
- Why: Linking a test records how a contract is verified; it does not change the contract, so it should neither cost a revision nor undo a review.
- Consequences: A revision cannot propose a different tests list from live; promote keeps the list it finds on next, which equals live.
- Change: node-tests
- Date: 2026-10-25
