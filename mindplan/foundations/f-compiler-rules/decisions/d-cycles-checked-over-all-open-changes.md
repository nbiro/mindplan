### d-cycles-checked-over-all-open-changes

- Decision: Cycles across changes are found on one depends_on graph that overlays every open change at once (revision adds, pre-ship edges, planned edges), and only cycles mixing two or more changes are reported.
- Alternatives:
  - Check each change against live alone (the ai-builder / platform-settings cycle only exists when both changes are overlaid)
- Why: A cross-change cycle means the two changes can never ship in any order; it is only visible with every open change applied together, while single-change cycles are already caught at link time.
- Change: change-cycles
- Date: 2026-11-03
