# MindPlan

This repository is modeled as a MindPlan graph (`mindplan/`).

- Before answering any questions or writing any code, call `get_project` and follow the playbook plus the project description and rules it returns. If tools are unavailable, use the init-installed host copies (`.cursor/rules`, `.cursor/skills`, and this `AGENTS.md` stub) — do not read or edit `mindplan/**` with host file tools (MCP is the only writer).
- Before planning or changing code, call `orient_for_work` and place the work on the graph.
- Skills load on demand: `define-entities`, `plan-project`.
