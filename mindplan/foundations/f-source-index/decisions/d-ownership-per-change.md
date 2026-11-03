### d-ownership-per-change

- Decision: Claim exclusivity is judged per change: revisions of different changes may claim one file (a warning, and the second to ship gets a claim conflict); two claims in one change stay Blocked.
- Alternatives:
  - Keep one global next owner per file (two parallel features moving code into one file could never both be open)
- Why: Parallel changes must be able to plan against live independently; ship order resolves who keeps the file.
- Change: multi-revisions
- Date: 2026-11-02
