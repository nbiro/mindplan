### d-gate-blocks-on-unseen-rule-text

- Decision: The ledger stays in the server's memory (one process is one session); a fetch is stored as the rule sources that reach the node with a tag of each one's text, and the gate Blocks a write only when a source reaching the node now carries text this session has not received.
- Alternatives:
  - Keep one fingerprint over the ordered list of reaching rules: an edge that only brought a source closer, or brought a Foundation the agent had already read, Blocked the next write, and the orient that cleared it returned every source as unchanged
  - Keep the fingerprint and re-record it after every link: fixes several links from one node, not the dependents of a node that gained an edge
  - A new Foundation that depends_on the ledger (or on f-plan-writes) and wraps the gate: the comparison is the ledger's own record, so a wrapper would need that record exported and leave two gates to keep in step
  - Name a newly reaching source on the write reply when its text is already held: one more field on write results for an edge the agent usually added itself
  - Persist fetches under mindplan/ or the cache: a new session would inherit an orientation it never read
- Why: The gate exists so rule text reaches the agent before it writes. A Block that an orient answers with nothing new costs two calls per node and teaches the agent that the gate is noise.
- Consequences: When another session adds an edge that brings a Foundation this session already read, the write passes without saying those rules now apply to the node; the next orient on the node shows it. Restarting the server forgets every fetch; MINDPLAN_ORIENT_GATE=off turns the gate off for a process.
- Supersedes: d-ledger-in-memory-per-process
- Change: planning-friction
- Date: 2026-11-12
- Nodes: f-plan-writes, i-shape-graph
