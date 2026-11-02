### d-orientation-write-gate

- Decision: Writes that act on a node are Blocked: Orientation until the node had a full reply in this MCP session (orient_for_work with node_id or auto_focus, get_node_context, its create_node, or a link result that returned its new rules), and again once the rules that reach it changed; create_node is never blocked; the CLI is never gated.
- Alternatives:
  - No gate (summary-first orientation would let an agent write without ever seeing a node's rules, making node rules optional)
  - Gate create_node too (the owner ruled it out: a new node has no rules yet beyond the ones its result returns)
- Why: Node rules are mandatory and used to arrive with every orient; once orient returns rows first, only a gate keeps them from being skipped.
- Consequences: A fresh session must orient on each node before writing it, and a rules change on a Journey or Foundation sends its dependents back to orient; the author of a rules change stays oriented.
- Change: summary-orient
- Date: 2026-10-25
