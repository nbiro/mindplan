### d-purpose-stated-up-front

- Decision: State the graph's purpose (growth by addition) as prose at the top of the playbook, in the server instructions, and in the MINDPLAN.md pointer, and enforce it in planning through an extension-check step in plan-project, not a new gate.
- Alternatives:
  - A server gate that Blocks ready on a Foundation without a recorded extension check — rejected: whether a future feature would reopen a node is a judgment no gate can verify; the existing hotspot and fan-out warnings already cover what can be measured.
  - Purpose only in the playbook — rejected: the server instructions and the pointer load before get_project, so an agent that never reads past them would still treat the graph as documentation.
- Why: The failure was an agent judging the graph by completeness and MVP speed because nothing said what it is for; the fix is to say it where every session looks first, and give planners a concrete test to run before self-ready.
- Consequences: The purpose sentence lives in three places (playbook, instructions, pointer) and must stay worded alike; agent-guidance.test.mjs and smoke.mjs check the playbook and the instructions.
- Change: graph-purpose
- Date: 2026-11-09
- Nodes: f-mcp-runtime
