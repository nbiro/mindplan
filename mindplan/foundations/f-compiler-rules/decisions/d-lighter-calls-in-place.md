### d-lighter-calls-in-place

- Decision: The lighter-calls change adds its parts as new modules inside the existing Foundations (auto-items.ts and the glob fan-in in f-compiler-rules, the new config keys and shared git probes in f-source-index, confirmations.ts in f-territory-store) instead of splitting them out.
- Alternatives:
  - New Foundations for checklist auto-closing, reply settings, and confirmations (each would be a few dozen lines that the Completion Check, config loader, and node-folder reader must call straight back into; the split would add edges without closing these nodes to the next change)
  - Invert through a registry Foundation (the rate is mostly unrecorded behavior, not per-node wiring, so a registry would not remove the reasons these nodes reopen)
- Why: Each addition belongs to the rule or store it extends: the Completion Check decides which items count, the config loader validates every key, and the store owns every file in a node folder. Keeping them there keeps one owner per concern.
- Consequences: These three stay hotspots by rate; the next change that reopens one should look at splitting by concern (for f-compiler-rules: open–closed signals vs. transition gates).
- Change: lighter-calls
- Date: 2026-11-08
- Nodes: f-source-index, f-territory-store
