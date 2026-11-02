### d-spec-topics-by-heading-text

- Decision: get_spec serves the running package's SPEC.md through a fixed map of stable topic ids to SPEC headings, matched by heading text without section numbers; without a topic it lists the ids.
- Alternatives:
  - A spec field on get_project (every session start would pay for it, or get_project would grow a parameter it does not need)
  - Address sections by number (renumbering SPEC would silently change what a topic returns)
  - Serve the whole SPEC (about 1,700 lines, past what an agent should load for one answer)
- Why: Agents need one answer at a time from the version that is enforcing the rules; stable ids survive SPEC edits, and the npx cache can no longer hand them a stale copy.
- Consequences: A SPEC heading rename must update SPEC_TOPICS; a test resolves every topic so a rename fails the suite.
- Change: agent-guidance
- Date: 2026-10-30
