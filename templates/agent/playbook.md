# MindPlan — think in systems

MindPlan draws the boundaries your agent won’t. Plan and change code **through the graph**, not around it. Skills load on demand with `get_skill({ name })`: `define-entities`, `plan-project`. Normative reference: `SPEC.md`; `get_spec({ topic })` returns one section of it, or one tool's entry by tool name, from the running server (`get_spec()` lists the topics), so look a rule up instead of guessing.

## Dialect

1. **Orient.** Call `get_project` before the first answer or code change in a session. Before **each** action, call `get_rules`, then `orient_for_work`; an earlier call does not cover the next action. `orient_for_work({ query })` returns ranked rows (a clear winner in full, `auto_focus: true`); `orient_for_work({ node_id })` returns the node you will work on: its rules, decisions, body, files, and blast radius (`depth: "rules"`: rules and record only). Unsure where work lands: `list_areas`, then `orient_for_work({ query, area })`. A write on a node is `Blocked: Orientation` until you oriented on that node in this session, and again after the rules that reach it changed (`create_node` never is); after a reconnect, `orient_for_work({ change })` orients on a whole change in one call. Pass `known_version` / `known_rules_versions` only for rules text you still hold (`get_spec({ topic: "get_rules" })`). Do not invent architecture from chat or `src/` greps. After a mutation, trust the result's `state`, `next_state`, and `changed_files`. When `get_project` returns `version`, tell the user and call the tool it names (`setup_project` or `upgrade_project`); until then every other tool is `Blocked: Version`.
2. **Place work on the graph.** Every change belongs to a Capability, Interaction, Interface, Foundation, or Bug. MCP is the only writer of `mindplan/` (nodes, attachments, `project.md`, `config.json`). Use `patch_node_territory` (`section` or `replace` for small fixes, so you do not resend the body), `patch_node_rules`, `patch_project_description`, `patch_project_rules`, `patch_config`, and attachment tools — never host file tools on that tree.
3. **New features are graph-first.** Before any code change for a new feature, consult the graph. Update the nodes the feature changes. If no corresponding node exists, create it. Do not start the feature code until that graph work is done. Creating or patching the graph always follows the `plan-project` skill (`define-entities` for create/link). One feature that touches several nodes gets one **change id**: pass `change` to `open_next` (required) / `create_node`; then `scope: "change"`, `get_blast_radius({ change })`, and `run_check({ change })` act on the whole group. A neighbor (rule 6) takes no change id; `record_decision`'s `change` tags only the decision. Status moves (`update_node_status`, `force_unship`) stay on the build pipeline: walk to `in-review`, review, then `ship` (shipping from before `in-review` needs `skip_review: true`); `dry_run` lists every transition. A scoped walk is all-or-nothing: one blocked member and nothing moves, unless `skip_blocked: true` walks the members that pass and lists the rest in `blocked`; `nodes` and `revisions` batches: `get_spec({ topic: "update_node_status" })`.
   - **Ready means reviewed.** Editing a `ready` slot's contract (territory text, checkboxes, claims, links) sends it back to `draft` (`readiness_reset`). Self-ready it again after review.
   - **One revision per change.** A shipped node may hold one open revision per change id, each judged against live plus its own change. On a node with several, pass `change` to every call on it. Shipping one rebases the others; `resolve_conflict` a conflict before `in-review`.
   - **Parallel worktrees.** Each agent passes `root: "<its worktree>"` to every MindPlan tool; the orchestrator plans and ships the change on the integration branch (recipe: `plan-project` §4b).
4. **`Blocked:` is hard.** Name the cause (structure, lifecycle, completion, confirmation, unstable dependency) and fix it before retrying.
5. **Claim files before writing them** with `set_implementation_files({ node_id, add: [...] })` (`remove` drops entries; `files` with `replace: true` only to replace the whole list). A file in the configured sources that no node claims is `Blocked: Coverage` with the call that claims it. Claims may be globs (`src/templates/*/actions/i-read-post/`) when one Interaction owns the same folder in every template.
6. **Changing shipped work is a blast-radius question.** `get_blast_radius`, then classify each node: **source** (its contract changes → `open_next`, full successor), **neighbor** (files change, behavior doesn't → edit in place; a new file beside its own, in a folder no other node claims into, can be claimed in place), **unaffected** (leave alone). Editing a node's rules (`patch_node_rules`) needs no `open_next`, but read the `rules_impact` it returns: it lists whose work those rules reach.
7. **Handoff matches the graph.** Before self-`ready`, `in-review`, `ship` / Bug `resolved`, or telling the user the work is done, update the graph so it matches the implementation and make the check exit 0: call `run_check` (the CLI is `mindplan-mcp check`; same output). Fix every `Blocked:` first; read each `Warning:` for territory text that no longer matches the code, and `acknowledge_warning` one you accept. A compact `run_check` lists each warning once per session: a later check counts repeats in `unchanged` instead of listing them, so a missing warning is not a fixed one (`compact: false` lists all; `get_spec({ topic: "run_check" })`). Moves to `in-review` and `ship` also run the check's import and ownership rules on the node's files. Before `in-review`, link the tests that verify the node with `set_test_files` (`add` / `remove`; pass `change` for a revision, or the call writes live): tests are evidence, not claims, so they need no `open_next` and keep readiness; `get_blast_radius` lists the tests a change should run. Do not wait until `ship`. When the implementation is done and a merge is requested, `ship` the node (Bug: `resolved`). A PR is merged only after its change is shipped (or moved back to `in-progress`); `run_check({ merge: true })` (CLI `mindplan-mcp check --merge`) is the gate, so run it before saying a PR is ready. The host typecheck is not a MindPlan gate. Code review is outside this dialect — customize via host process or `mindplan/project.md` rules if desired.
8. **Project brief.** Agents receive this dialect as `get_project.playbook`. Rules in `mindplan/project.md` are **mandatory** — call `get_rules` before each action. The description is the product summary, not a rule. Neither overrides a compiler `Blocked:`. Edit the description with `patch_project_description` and the rules with `patch_project_rules`; call `get_project` again after a description change, and `get_rules` after a rules change.
9. **Node rules.** A rule about one node's work goes on that node with `patch_node_rules`; the brief keeps only rules that apply everywhere. `orient_for_work` returns the rules for the node you work on, each labeled with its source: the node's own, its Capability's, its Foundations', and for a Bug those of the nodes it affects. Never downward or across siblings. They are mandatory like the brief rules.
10. **Decisions.** Record a decision when you choose between viable designs; MindPlan blocks in-review on shared-contract, schema, or wide-radius changes without one. `record_decision` on the node the choice shapes (one decision that shapes several nodes: list them in `nodes`, once). `orient_for_work` returns your node's own decisions and names the inherited ones (`inherited_decisions`); read them before reshaping a design someone else chose. Pass `include_inherited_decisions: true` when the change reaches a Capability's or Foundation's design, and use `list_decisions` for any node's full records.

## Taxonomy

Each type answers one question (SPEC §2.0.0). These names are the vocabulary, in tool calls and with the user alike; never a synonym for a type. The last column is the closest established term, to map each type onto what you know; it is not a synonym (SPEC §2.0.0 says where each differs):

| Type | Question | Closest established term |
|---|---|---|
| **Capability** | What does the product do? | Business capability, bounded context |
| **Interaction** | What can someone do? | Use case |
| **Interface** | Where do they do it? (one per app or channel, not per page) | Driving adapter, C4 container |
| **Foundation** | What does it all run on? (role: Assembler / Infra / Design system / Adapter) | Composition root / infrastructure / UI kit / driven adapter |
| **Bug** | What's broken? | Defect |

**Edges:** `belongs_to` (is part of), `depends_on` (needs — substrate only), `exposes` (shows), `leads_to` (then goes to), `affects` (breaks), `mounts` (Foundation → Interface: a composition root such as a template registry may import exactly the Interfaces it mounts). An Interaction owns its body; an Interface only mounts it. One Interface per actor surface, not per screen.

**Required sections.** Each type has sections that every move checks (Minimum Territory Shape). `create_node` and `orient_for_work` return `shape`, each section marked `present`, `missing`, or `stub`, and `run_check` warns `shape:` while a draft misses one: write them before the first move. The table is in the `define-entities` skill and `get_spec({ topic: "territory-shape" })`.

## Breaking down work

1. Rewrite the ask as: *"<who> can <verb> <object> in <Capability>, from <Interface>, using <Foundations>."*
2. Each distinct verb + object is one Interaction candidate (size: one behavior).
3. **Reuse before create** — `find_related_nodes` for each piece. Same Interaction from a new Interface → new `exposes`, not a new Interaction.
4. Titles are stable names; descriptions say what the node does *now*, in one or two sentences; revision notes stay in the revision's body. Give a node `aliases` for the words users will say that its text lacks.
5. **Invert nodes that must know every feature** (erase a site, export an account, index for search, check a permission): define the contract once on the Foundation those features already use, as a node rule with a linked test, and depend only on that Foundation, not on each feature (`define-entities` Step 0).
6. Then create what's missing via `define-entities` / `plan-project`.

## Talking to the user

Use the type names (Capability, Interaction, Interface, Foundation, Bug) and node ids with the user, as in tool calls; never a synonym for a type. Translate every `Blocked:` into one plain sentence plus the next step. Example: "I'll add *split the check* as a new Interaction in the Billing Capability and expose it on the checkout Interface."

## Never

- Invent tickets outside the graph
- Add `depends_on` between Interactions, or put feature screen bodies in an Interface
- Start new-feature code before updating or creating the matching nodes through `plan-project`
- Hand off work (ready, in-review, ship, or "done") while `run_check` fails or was never run
- Reword a checklist item so it can be ticked: tick it by `id` with `toggle_checkboxes`, `note` (done differently) or `not_applicable` (with the reason); a `review` or `deploy` item (`open_items`) waits on a person, so say so instead
- Hand off while the graph still describes the previous behavior
- Put rules about one node's work in the project brief
- Merge finished work without shipping the node
