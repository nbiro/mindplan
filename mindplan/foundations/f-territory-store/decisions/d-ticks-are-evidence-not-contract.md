### d-ticks-are-evidence-not-contract

- Decision: Ticking or unticking an existing checklist item (toggle_checkboxes) is not a contract write: patchNodeTerritory no longer sends a ready slot back to draft for it, on live or on a revision; adding items and editing text still do.
- Alternatives:
  - Keep resetting on every checkbox write (ticking one item on 30 ready nodes sent each back to draft and cost three extra batch walks, for a write that changed no requirement)
  - A new node that depends_on "f-territory-store", or a split or inversion of it: the rule for which fields count as contract is one line inside patchNodeTerritory, the store's own writer; moving that judgment to a new Foundation or to the caller would reopen the store just the same to remove it, and split one write's fields across two owners
  - Reset only on untick (an untick takes back evidence, but the contract readiness was judged on is the item list and the text, which neither direction changes; the build-item guard already Blocks an untick that a shipped dependent relies on)
- Why: Readiness is a judgment about the contract: the text and the list of items. A tick records progress against that list and leaves both as they were, so resetting on it made honest progress marking expensive and taught agents to skip it.
- Consequences: A ready slot can hold items ticked or unticked after it was judged ready; gates that count ticks (in-review, ship) still run when the node moves. Reworded or added items still reset, so a tick cannot smuggle in a contract change.
- Change: lighter-edits
- Date: 2026-11-11
- Nodes: i-edit-territory
