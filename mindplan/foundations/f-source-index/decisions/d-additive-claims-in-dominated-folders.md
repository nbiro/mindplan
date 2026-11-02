### d-additive-claims-in-dominated-folders

- Decision: A shipped node with no open next may add claims in place only when no claimed file is lost and each new entry is a file in, or the directory of, a folder it dominates (it owns a file directly there and no other node claims anything under it); globs, removals and moves still need open_next.
- Alternatives:
  - Always require open_next for any claim change (agents misplace files into folders the node already claims, splitting code for ownership reasons)
  - Allow any additive claim on a shipped node (a new file in a shared folder can belong to a dependent's contract)
- Why: A file in a folder nobody else can own affects no dependent's contract, which is the files-change-behavior-doesn't case the playbook already treats as an in-place edit.
- Consequences: The live file records added entries in added_claims and run_check warns stale until the body names each one, so the addition stays visible in review without a revision.
- Change: shipped-claims-and-neighbors
- Date: 2026-10-23
