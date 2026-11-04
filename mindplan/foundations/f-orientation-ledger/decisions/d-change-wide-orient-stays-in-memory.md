### d-change-wide-orient-stays-in-memory

- Decision: A reconnect is covered by orient_for_work({ change }), which returns the rules of every member of a change once per source and records them all; the ledger stays in memory per process, and an orientation Block names every unoriented node at once.
- Alternatives:
  - Persist the ledger per working directory with rules fingerprints (a new conversation would inherit orientation whose rules never reached it)
  - Both persist and add the change-wide orient (keeps the persistence risk for a case one call already covers)
- Why: Orientation is a property of what reached this conversation; one call per change makes a reconnect cheap without letting rules be skipped.
- Consequences: After a reconnect an agent makes one orient call per change (or per node outside a change) before writing.
- Change: agent-guidance
- Date: 2026-10-30
