### d-revision-reasons-diagnose-hotspots

- Decision: open_next requires a reason from a closed set (behavior, wiring, fix, platform, text, refactor); only behavior and wiring (and legacy unrecorded ships) count toward the rate; each ship keeps decayed per-reason parts (churn_behavior, churn_wiring) beside churn; a hotspot's diagnosis is invert when wiring dominates the recorded parts, split when behavior does, unknown when unrecorded ships dominate; run_check lists a hotspot only while it has an open revision.
- Alternatives:
  - Free-text reasons on each revision (cannot be counted, so the warning still could not tell an inversion from a split)
  - Infer the kind from the revision's diff, e.g. edge-only revisions are wiring (cannot tell a framework upgrade or a fix from a behavior change, and a wiring revision often touches body text too)
  - Keep a per-revision log of reasons on the node (history in node territory; git keeps history, and a decayed counter per reason is current state, like churn)
  - Keep printing every hotspot on every check (the evidence: 15 lines per call that agents learned to skip)
- Why: The evidence showed two different fixes behind the same warning: nodes reopened only to add an edge per new template needed an inversion, while i-edit-page needed a split; and framework upgrades and text fixes inflated the rate. A closed set lets the server count and interpret, and decayed per-reason counters keep the rate's existing semantics without storing history.
- Consequences: Every open_next call must pass reason. Nodes whose rate predates reasons diagnose as unknown until new revisions record them or the old rate decays. A hotspot nobody is changing no longer appears in run_check; it shows in open_next and in orient_for_work at depth full.
- Change: revision-reasons
- Date: 2026-11-07
- Nodes: f-compiler-rules, f-domain-model, f-territory-store, i-revise-node, i-check-integrity, i-orient-plan
