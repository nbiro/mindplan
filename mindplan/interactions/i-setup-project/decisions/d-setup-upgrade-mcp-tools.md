### d-setup-upgrade-mcp-tools

- Decision: Setup and upgrade are two MCP tools (setup_project, upgrade_project) with no CLI init command: each runs its deterministic part in code and returns a guide for the judgment part (wiring CLAUDE.md / AGENTS.md, moving rules into the brief with the user's approval, the product description), and the server writes nothing outside mindplan/ except the merge-gate workflow when asked.
- Alternatives:
  - Keep mindplan-mcp init (or a deprecated alias): an extra install step, and it either skips or overwrites repo-owned files like CLAUDE.md because it cannot judge them
  - A setup skill only: an agent cannot create mindplan/ (MCP is its only writer) and must not hand-run the git-history backfill
  - One tool for setup and upgrade: the Block message would point at a tool whose behavior depends on state, and setup's interview has no place in an upgrade
- Why: Registering the MCP server is already a manual step, and its instructions route every session to get_project, which can name the right tool; code keeps migrations exact, the agent and user keep the decisions about their own files.
- Consequences: Projects without an agent (CI only) cannot migrate; the check fails until an agent runs upgrade_project. Every "run mindplan-mcp init" message becomes a setup_project or upgrade_project call. Host skill copies and mindplan/agent/ are no longer installed.
- Change: setup-upgrade
- Date: 2026-10-31
