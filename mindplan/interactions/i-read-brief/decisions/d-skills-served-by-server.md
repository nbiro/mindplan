### d-skills-served-by-server

- Decision: The MindPlan skills are served by the running server through get_skill (SKILL.md, plus a named supporting file), and the playbook and server instructions tell the agent when to load each; no host skill copies are installed.
- Alternatives:
  - Copy skills into .claude/skills and .cursor/skills (host auto-triggers them, but copies drift from the server and need the version stamp and a refresh step)
  - Serve them as MCP prompts (user-invoked only in most hosts, so the agent cannot load one when it needs it)
- Why: A served skill always matches the server that enforces it, and the playbook already routes agents to get_spec the same way; the owner accepted less reliable auto-triggering for that.
- Consequences: An agent loads a skill only when the playbook or instructions tell it to; skill names stay stable ids (plan-project, define-entities).
- Change: setup-upgrade
- Date: 2026-10-31
