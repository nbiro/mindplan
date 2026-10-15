# MindPlan — think in systems

MindPlan draws the boundaries your agent won’t. Plan and change code **through the graph**, not around it. Skills load on demand: `define-entities`, `plan-project`. Normative reference: `SPEC.md`.

## Dialect

1. **Orient.** Call `get_project` before the first answer or code change in a session. Before **each** action, call `get_rules`, then `orient_for_work`; its `rules` block holds the rules of the node you work on. An earlier call does not cover the next action. Do not invent architecture from chat or `src/` greps. After a mutation, trust the response `anchor` and `changed_files`.
2. **Place work on the graph.** Every change belongs to a Journey, Interaction, Interface, Foundation, or Bug. MCP is the only writer of `mindplan/` (nodes, attachments, `project.md`, `config.json`). Use `patch_node_territory`, `patch_node_rules`, `patch_project_description`, `patch_project_rules`, `patch_config`, and attachment tools — never host file tools on that tree.
3. **New features are graph-first.** Before any code change for a new feature, consult the graph. Update the nodes the feature changes. If no corresponding node exists, create it. Do not start the feature code until that graph work is done. Creating or patching the graph always follows the `plan-project` skill (`define-entities` for create/link). Status moves (`update_node_status`, `force_unship`) stay on the build pipeline.
4. **`Blocked:` is hard.** Name the cause (structure, lifecycle, completion, confirmation, unstable dependency) and fix it before retrying.
5. **Claim files before writing them** with `set_implementation_files`.
6. **Changing shipped work is a blast-radius question.** `get_blast_radius`, then classify each node: **source** (its contract changes → `open_next`, full successor), **neighbor** (files change, behavior doesn't → edit in place), **unaffected** (leave alone).
7. **Handoff matches the graph.** Before self-`ready`, `in-review`, `ship` / Bug `resolved`, or telling the user the work is done, update the graph so it matches the implementation and make the default check exit 0. Fix every `Blocked:` first. Do not wait until `ship`. When the implementation is done and a merge is requested, `ship` the node (Bug: `resolved`). The host typecheck is not a MindPlan gate. Code review is outside this dialect — customize via host process or `mindplan/project.md` rules if desired.
8. **Project brief.** Agents receive this dialect as `get_project.playbook`. Rules in `mindplan/project.md` are **mandatory** — call `get_rules` before each action. The description is the product summary, not a rule. Neither overrides a compiler `Blocked:`. Edit the description with `patch_project_description` and the rules with `patch_project_rules`; call `get_project` again after a description change, and `get_rules` after a rules change. A rule that applies everywhere goes in the brief; a rule about one area goes on that node with `patch_node_rules` and arrives through `orient_for_work` (the node's own, its Journey's, its Foundations'; a Bug gets those of the nodes it affects). Node rules are mandatory too, and changing a Foundation's rules is a blast-radius question (`rules_impact`).

## Taxonomy

Each type answers one question (plain words from SPEC §2.0.0; type names stay for tools):

| Type | Plain word | Question |
|---|---|---|
| **Journey** | area | What does the product do? |
| **Interaction** | action | What can someone do? |
| **Interface** | entry point | Where do they do it? (one per app or channel, not per page) |
| **Foundation** | building block | What does it all run on? (role: Assembler / Infra / Design system / Adapter) |
| **Bug** | bug | What's broken? |

**Edges:** `belongs_to` (is part of), `depends_on` (needs — substrate only), `exposes` (shows), `leads_to` (then goes to), `affects` (breaks). An Interaction owns its body; an Interface only mounts it. One Interface per actor surface, not per screen.

## Breaking down work

1. Rewrite the ask as: *"<who> can <verb> <object> in <area>, from <entry point>, using <building blocks>."*
2. Each distinct verb + object is one Interaction candidate (size: one behavior).
3. **Reuse before create** — `find_related_nodes` for each piece. Same action from a new entry point → new `exposes`, not a new Interaction.
4. Titles are stable names; descriptions say what the node does *now*; revision notes stay in `<id>.next.mdx` body.
5. Then create what's missing via `define-entities` / `plan-project`.

## Talking to the user

Use the plain words (area, action, entry point, building block, bug) with the user. Keep type names and ids for tool calls and graph talk with other agents. Translate every `Blocked:` into one plain sentence plus the next step. Example: "I'll add *split the check* as a new action in the Billing area and show it on the checkout page."

## Never

- Invent tickets outside the graph
- Add `depends_on` between Interactions, or put feature screen bodies in an Interface
- Start new-feature code before updating or creating the matching nodes through `plan-project`
- Hand off work (ready, in-review, ship, or "done") while default check fails
- Hand off while the graph still describes the previous behavior
- Merge finished work without shipping the node
