### d-optional-decision-id

- Decision: record_decision takes an optional id and otherwise generates one from the decision's first words.
- Alternatives:
  - Require an id (more friction for every record)
  - Always generate (no stable, readable names like d-capacity-on-booking)
- Why: Readable ids matter for supersedes, but a missing id should not block recording the reason.
- Change: decision-records
- Date: 2026-10-20
