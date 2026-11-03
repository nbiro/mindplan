### d-orient-active-slot-default

- Decision: orient_for_work returns only the active slot's body by default (next while a revision is open) and its decisions only in the top-level block; get_node_context keeps both slots by default and both take slot and section.
- Alternatives:
  - Add slot and section but keep both bodies by default in orient_for_work (every orient on an evolving node still pays for two near-identical bodies)
  - Default get_node_context to the active slot too (it is the full read; comparing live with next is what it is for)
  - Page a body by character offset (a cut can split a section or a checkbox line; headings are the unit agents edit by)
- Why: Orientation runs before every action and nearly every edit targets the active slot; a reply that repeats the body and the decisions doubled its size and could exceed the host's result limit on a large node.
- Consequences: A client that read the live body from orient_for_work while a revision is open must pass slot: "current"; a client that read context.decisions must read the decisions block.
- Change: lean-node-replies
- Date: 2026-10-29
