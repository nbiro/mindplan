### d-record-optional-id

- Decision: record_decision takes an optional id and otherwise generates one from the decision's first words (carried over from d-optional-decision-id on the deprecated i-steer-plan).
- Alternatives:
  - Require an id (more friction for every record)
  - Always generate (no stable, readable names like d-capacity-on-booking)
- Why: Readable ids matter for supersedes, but a missing id should not block recording the reason.
- Change: hotspot-splits
- Date: 2026-10-31
