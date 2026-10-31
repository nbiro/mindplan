# MindPlan

This repository is planned as a MindPlan graph (`mindplan/`), served by the MindPlan MCP server.

- Before answering any questions or writing any code, call `get_project` and follow the playbook plus the project description and rules it returns. Do not read or edit `mindplan/**` with host file tools: the MCP server is its only writer.
- Before each action, call `get_rules` (pass `known_version` only while you still hold the rules text it tags; `unchanged: true` means that text still applies), then `orient_for_work`. An earlier call does not cover the next action. Project rules from `mindplan/project.md` and the `rules` block of `orient_for_work` (node rules) are mandatory; they must not override a compiler `Blocked:`.
- Before any code change for a new feature, consult the graph and update the nodes that feature changes. If no corresponding node exists, create it. Do that graph work with the `plan-project` skill (`define-entities` for create/link); load each with `get_skill`. Do not start the feature code until the graph matches.
- If a tool answers `Blocked: Version`, call the tool it names (`setup_project` or `upgrade_project`) first.
