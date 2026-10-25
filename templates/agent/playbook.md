# MindPlan — think in systems

MindPlan draws the boundaries your agent won’t. Plan and change code **through the graph**, not around it. Skills load on demand: `define-entities`, `plan-project`. Normative reference: `SPEC.md`.

## Dialect

1. **Orient.** Call `get_project` before the first answer or code change in a session. Before **each** action, call `get_rules`, then orient: `orient_for_work({ query })` returns ranked rows, pick the node you will work on, `orient_for_work({ node_id })` returns its rules, decisions, body, files, and blast radius, then act. A clear winner (its exact id, or twice the next score) comes back in full at once (`auto_focus: true`). Its `rules` block holds the rules of the node you work on. A write on a node is `Blocked: Orientation` until you oriented on that node in this session, and again after the rules that reach it changed; `create_node` is never blocked. While you still hold the rules text in context, pass its `rules_version` (from `get_project` or `get_rules`) as `known_version`: `unchanged: true` means that text still applies; anything else carries the new text. If you no longer have the text (a new session, a summarized context), pass nothing. `orient_for_work` takes `known_rules_versions` (node id → `version`) the same way, only for node rules you still hold. An earlier call does not cover the next action. Do not invent architecture from chat or `src/` greps. After a mutation, trust the response `state`, `next_state`, and `changed_files`; pass `verbose: true` only when you need the record and neighborhood. Orient with `depth: "rules"` when you only need the rules and record. When `get_project` returns `version`, the installed agent files or graph are out of date with the server: tell the user and run the init command it names before graph work.
2. **Place work on the graph.** Every change belongs to a Journey, Interaction, Interface, Foundation, or Bug. MCP is the only writer of `mindplan/` (nodes, attachments, `project.md`, `config.json`). Use `patch_node_territory` (`section` or `replace` for small fixes, so you do not resend the body), `patch_node_rules`, `patch_project_description`, `patch_project_rules`, `patch_config`, and attachment tools — never host file tools on that tree.
3. **New features are graph-first.** Before any code change for a new feature, consult the graph. Update the nodes the feature changes. If no corresponding node exists, create it. Do not start the feature code until that graph work is done. Creating or patching the graph always follows the `plan-project` skill (`define-entities` for create/link). Status moves (`update_node_status`, `force_unship`) stay on the build pipeline; `update_node_status` with `scope` walks every open update to a target in one call, and `dry_run` lists every transition. A walk to `ship` from before `in-review` is `Blocked:` unless you pass `skip_review: true`; prefer walking to `in-review`, reviewing, then shipping. One feature that touches several nodes gets one **change id**: pass `change` to `open_next` / `create_node`, then `scope: "change"`, `get_blast_radius({ change })`, and `run_check({ change })` act on the whole group. Pass the same `change` on a neighbor's in-place writes (`patch_node_territory`, `record_decision`, `set_implementation_files`) so it joins the group.
   - **Ready means reviewed.** Editing a `ready` revision's contract (territory text, checkboxes, claims, links) sends it back to `draft`, and the result says `readiness_reset`. Self-ready it again after review.
4. **`Blocked:` is hard.** Name the cause (structure, lifecycle, completion, confirmation, unstable dependency) and fix it before retrying.
5. **Claim files before writing them** with `set_implementation_files`. A file in the configured sources that no node claims is `Blocked: Coverage` with the call that claims it. Claims may be globs (`src/templates/*/actions/i-read-post/`) when one action owns the same folder in every template.
6. **Changing shipped work is a blast-radius question.** `get_blast_radius`, then classify each node: **source** (its contract changes → `open_next`, full successor), **neighbor** (files change, behavior doesn't → edit in place; a new file beside its own, in a folder no other node claims into, can be claimed in place), **unaffected** (leave alone). Editing a node's rules (`patch_node_rules`) needs no `open_next`, but read the `rules_impact` it returns: it lists whose work those rules reach.
7. **Handoff matches the graph.** Before self-`ready`, `in-review`, `ship` / Bug `resolved`, or telling the user the work is done, update the graph so it matches the implementation and make the check exit 0: call `run_check` (the CLI is `mindplan-mcp check`; same output). Fix every `Blocked:` first, and read `Warning:` lines for territory text that no longer matches the code. Moves to `in-review` and `ship` run the check's import and ownership rules on the node's files, so an illegal import is `Blocked:` with its fix. Link the tests that verify the node with `set_test_files` before `in-review`: the list is evidence, not a claim, so it needs no `open_next` and keeps readiness; a linked test missing on disk is `Blocked:` once the node is in review or shipped, and `get_blast_radius` lists the tests a change should run. Do not wait until `ship`. When the implementation is done and a merge is requested, `ship` the node (Bug: `resolved`). The host typecheck is not a MindPlan gate. Code review is outside this dialect — customize via host process or `mindplan/project.md` rules if desired.
8. **Project brief.** Agents receive this dialect as `get_project.playbook`. Rules in `mindplan/project.md` are **mandatory** — call `get_rules` before each action. The description is the product summary, not a rule. Neither overrides a compiler `Blocked:`. Edit the description with `patch_project_description` and the rules with `patch_project_rules`; call `get_project` again after a description change, and `get_rules` after a rules change.
9. **Node rules.** A rule about one area goes on that node with `patch_node_rules`; the brief keeps only rules that apply everywhere. `orient_for_work` returns the rules for the node you work on, each labeled with its source: the node's own, its Journey's, its Foundations', and for a Bug those of the nodes it affects. Never downward or across siblings. They are mandatory like the brief rules.
10. **Decisions.** Record a decision when you choose between viable designs; MindPlan blocks in-review on shared-contract, schema, or wide-radius changes without one. `record_decision` on the node the choice shapes; `orient_for_work` returns your node's own decisions and names the inherited ones (`inherited_decisions`: count and nodes). Read them before reshaping a design someone else chose; pass `include_inherited_decisions: true` when the change reaches a Journey's or Foundation's design, and `list_decisions` for any node's full records.

## Taxonomy

Each type answers one question (plain words from SPEC §2.0.0; type names stay for tools):

| Type | Plain word | Question |
|---|---|---|
| **Journey** | area | What does the product do? |
| **Interaction** | action | What can someone do? |
| **Interface** | entry point | Where do they do it? (one per app or channel, not per page) |
| **Foundation** | building block | What does it all run on? (role: Assembler / Infra / Design system / Adapter) |
| **Bug** | bug | What's broken? |

**Edges:** `belongs_to` (is part of), `depends_on` (needs — substrate only), `exposes` (shows), `leads_to` (then goes to), `affects` (breaks), `mounts` (Foundation → Interface: a composition root such as a template registry may import exactly the Interfaces it mounts). An Interaction owns its body; an Interface only mounts it. One Interface per actor surface, not per screen.

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
- Hand off work (ready, in-review, ship, or "done") while `run_check` fails or was never run
- Reword a checklist item so it can be ticked: close it with `toggle_checkboxes` `note` (done differently) or `not_applicable` (with the reason)
- Hand off while the graph still describes the previous behavior
- Put area-specific rules in the project brief
- Merge finished work without shipping the node
