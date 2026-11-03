### d-decisions-slot-bound

- Decision: Decisions belong to a slot: a revision records them on its next file and they ship or are discarded with it.
- Alternatives:
  - Write them to live and next like node rules (a discarded revision would leave its reasoning on the live node)
- Why: A decision explains one revision's design; if the revision never ships, neither does its reasoning.
- Change: decision-records
- Date: 2026-10-20
