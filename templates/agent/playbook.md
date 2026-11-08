# MindPlan — think in systems

MindPlan draws the boundaries your agent won’t. The graph under `mindplan/` describes what the code does; you keep it true. You receive this as `get_project.playbook`. Rules are looked up, not guessed: `get_spec({ topic })` serves one section of SPEC or one tool's entry; `get_skill({ name })` serves `plan-project` (modeling and evolving a graph) and `define-entities` (creating and linking nodes).

## Your duties

1. **A new behavior is a new node.** Before you claim the files of a new feature, create its node (Interaction, Interface, or Foundation) and link it; when a change alters what existing nodes describe, update those nodes.
2. **`mindplan/` is written through the tools only.** Never edit it with host file tools; reading its files is fine. A file alone lacks a node's inherited rules and decisions (orient for those), and a revision's frontmatter holds only its changes against live. For a `replace` edit, `find_in_node` returns a snippet that occurs exactly once.
3. **Hand off on a green check.** Before `ready`, `in-review`, `ship` / Bug `resolved`, or saying the work is done, `run_check` (CLI `mindplan-mcp check`) must pass. When the implementation is done and a merge is requested, `ship` the node (Bug: `resolved`); `run_check({ merge: true })` (CLI `mindplan-mcp check --merge`) is the merge gate CI runs.

How and when you plan is up to you: sketch nodes first, or code first and update the graph before handoff. The gates below hold either way.

## What the server enforces

| `Blocked:` | When | Clear it |
|---|---|---|
| `Version` | the graph needs setup or an upgrade | the tool it names (`setup_project`, `upgrade_project`) |
| `Rules` | a write before the project rules reached this session, or after they changed | `get_project`, or `get_rules` |
| `Orientation` | a write on a node whose rules have not reached you, or changed | `orient_for_work({ node_id })`, `({ node_ids })` for several, or `({ change })` for a whole change; `open_next`, `patch_node_territory`, and `set_implementation_files` orient a node not yet oriented on themselves (its rules ride on the reply) |
| `Coverage` | a source file no node claims | the node the line names, or a new one: `create_node`, then `set_implementation_files` |
| `Merge` | at merge: a node still in review, or a shipped node whose files changed but whose territory did not | ship the change; `open_next` + ship, `patch_node_territory` in place, or `confirm_territory({ node_id, note })` when its text still holds |
| shape, links, imports, decisions, tests, checklist | moves along `draft → ready → in-progress → in-review → ship` | the fix in the line; `get_spec({ topic })` for the rule |
| `Rule` | `run_check`: a rule's `check:` line fails | fix the code the line names |

The default checklist items `spec` and `impl` close at ship; `verify` closes once `run_check({ run_tests: true, change })` (or `nodes`) passes the node's linked tests. Tick the rest yourself.

A `Blocked:` is hard: fix the cause, never retry blindly. Tell the user in one plain sentence what blocked and the next step. Replies that orient carry `project_rules` when the project rules changed; after a context summary, `get_rules` re-reads them, and `orient_for_work({ node_id, resend_rules: true })` returns node rule text that came back as `unchanged`. Project rules (`mindplan/project.md`) and node rules (in `orient_for_work`) are mandatory and never override a `Blocked:`.

## Taxonomy

These type names are the only words for node types, in tool calls and with the user. The last column is the nearest established term, not a synonym:

| Type | Question | Closest established term |
|---|---|---|
| **Capability** | What does the product do? | Business capability, bounded context |
| **Interaction** | What can someone do? | Use case |
| **Interface** | Where do they do it? (one per app or channel, not per page) | Driving adapter, C4 container |
| **Foundation** | What does it all run on? (role: Assembler / Infra / Design system / Adapter) | Composition root / infrastructure / UI kit / driven adapter |
| **Bug** | What's broken? | Defect |

**Edges:** `belongs_to` (is part of), `depends_on` (needs — Foundations only), `exposes` (shows), `leads_to` (then goes to), `affects` (breaks), `mounts` (Foundation → Interface it may import). An Interaction owns its behavior and view; an Interface only mounts it. Never `depends_on` between Interactions.

## Working on the graph

- **Find before you create:** `orient_for_work({ query })` ranks nodes; `find_related_nodes` checks reuse. The same Interaction on a new Interface is a new `exposes`, not a new Interaction.
- **New node:** `create_node`, `link_nodes`, write its sections with `patch_node_territory` (`shape` lists them), claim its files with `set_implementation_files`, link tests with `set_test_files`.
- **Shipped node:** its contract changes → `open_next({ node_id, change, reason })` and ship the revision; only its files change → edit in place and keep its text true. One feature across several nodes shares one `change` id; `get_blast_radius` shows who it reaches.
- **Rules and decisions:** a rule for one node's work is `patch_node_rules`, a rule for everything `patch_project_rules`; a choice between viable designs is `record_decision` on the node it shapes.

## Never

- Invent tickets or plans outside the graph
- Claim a new behavior's files onto an existing node to avoid creating one
- Hand off while `run_check` fails or the graph still describes the previous behavior
- Reword a checklist item so it can be ticked: tick it by `id`, with `note` or `not_applicable`
