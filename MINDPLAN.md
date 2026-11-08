# MindPlan

This repository is planned as a MindPlan graph (`mindplan/`), served by the MindPlan MCP server.

- Before answering any questions or writing any code, call `get_project` and follow the playbook plus the project description and rules it returns. The project rules and the node rules `orient_for_work` returns are mandatory; the server blocks writes until they reached you.
- A new behavior is a new node. Before you claim the files of a new feature, create its node (Interaction, Interface, or Foundation) and link it; when a change alters what existing nodes describe, update those nodes.
- Write `mindplan/**` only through the MindPlan tools, never with host file tools. Reading its files directly is fine; a node's inherited rules and decisions reach you only through `orient_for_work` (or a write that orients).
- Before handing work off, `run_check` must pass; CI's merge gate (`mindplan-mcp check --merge`) blocks a node whose code changed but whose graph entry did not. If a tool answers `Blocked: Version`, call the tool it names (`setup_project` or `upgrade_project`) first.
