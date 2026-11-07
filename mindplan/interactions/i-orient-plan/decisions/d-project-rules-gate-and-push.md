### d-project-rules-gate-and-push

- Decision: Project rules are enforced by a once-per-session gate and a push, not by a per-action ritual: a write tool is Blocked: Rules until the project rules reached the session (get_project, get_rules, or a reply carrying project_rules), replies that orient and write results carry project_rules whenever the rules changed since they were served, and the playbook, skills, stub, and tool descriptions describe what the server enforces and leave when to plan and when to orient to the agent.
- Alternatives:
  - Keep the prose ritual (get_rules then orient_for_work before each action): two calls per action that no code checked, so the rules were as optional as they were repeated
  - Re-send the project rules in every reply that orients (keeps them in recent context across a context summary, but costs their full text on every action; an agent that lost them can call get_rules)
  - Gate every tool, reads included, on the rules (an agent could not orient or read the spec before get_project; the first orient now pushes the rules instead)
- Why: Node rules already had this shape (a session ledger, a gate, a push when they change) and it held; project rules were the only mandatory text with no enforcement, and the ritual that stood in for it was the heaviest part of the process. The owner chose to let the agent decide when to plan, provided the graph is forced to match the code before a merge.
- Consequences: A session reads the project rules once before its first write (get_project does it); an agent that wants them back after a context summary calls get_rules; prose may no longer promise what the server does not check, so graph-before-code is a recommendation and the merge gate's stale-territory Block is the guarantee.
- Change: lean-dialect
- Date: 2026-11-07
- Nodes: i-orient-plan, f-orientation-ledger, f-plan-writes, i-read-brief, f-mcp-runtime, f-framework-docs, if-mcp-tools
