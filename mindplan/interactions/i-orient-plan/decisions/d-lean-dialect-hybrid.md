### d-lean-dialect-hybrid

- Decision: Ceremony goes, the planning duty stays: project rules are enforced by a once-per-session Blocked: Rules gate plus a push when they change (no get_rules before each action); skills are reference, not a mandated load; but the stub, server instructions, and playbook keep one mandatory duty in the same words: a new behavior is a new node, created before its files are claimed, and the nodes a change touches are updated. The merge gate and the Coverage fix enforce what the server can see of it.
- Alternatives:
  - Full lean: no planning duty in prose, only gates (an agent can claim a new feature's files onto the nearest node and pass every gate; the owner found the repeated duty is what makes agents plan)
  - Keep the per-action get_rules ritual and the mandated plan-project load (two calls per action and a skill load per write that no code checked)
- Why: The server cannot tell a new behavior from a helper file, so planning ahead rests on the prose; everything else the prose demanded either had a gate or was ceremony.
- Consequences: The planning duty must stay worded identically in the three always-loaded places; every other per-action instruction is removed from the docs.
- Supersedes: d-project-rules-gate-and-push
- Change: lean-dialect
- Date: 2026-11-07
- Nodes: i-orient-plan, f-orientation-ledger, f-plan-writes, i-read-brief, f-mcp-runtime, f-framework-docs, if-mcp-tools, i-check-integrity
