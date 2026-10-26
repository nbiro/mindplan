# MindPlan

This repository is modeled as a MindPlan graph (`mindplan/`).

- Before answering any questions or writing any code, call `get_project` and follow the playbook plus the project description and rules it returns. If tools are unavailable, use the init-installed host copies (`.cursor/rules` + `.cursor/skills`, or `CLAUDE.md` + `.claude/skills`, and this `AGENTS.md` stub) — do not read or edit `mindplan/**` with host file tools (MCP is the only writer).
- Before each action, call `get_rules` (pass `known_version` only while you still hold the rules text it tags; `unchanged: true` means that text still applies), then `orient_for_work`. An earlier call does not cover the next action. Project rules from `mindplan/project.md` and the `rules` block of `orient_for_work` (node rules) are mandatory; they must not override a compiler `Blocked:`.
- Before any code change for a new feature, consult the graph and update the nodes that feature changes. If no corresponding node exists, create it. Do that graph work with the `plan-project` skill (`define-entities` for create/link). Do not start the feature code until the graph matches.
- Skills load on demand: `define-entities`, `plan-project`.
