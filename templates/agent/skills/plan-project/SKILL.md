---
name: mindplan-plan-project
description: >-
  Model and evolve a MindPlan graph: break an ask into Capabilities,
  Interactions, Interfaces, Foundations, and Bugs; choose between a new node and
  a revision; evolve shipped nodes (blast radius, revisions, conflicts, planned
  wiring); self-ready a plan; and run one change across parallel git worktrees.
---

# Plan and evolve a MindPlan graph

Reference for graph work: load it when you model a product or a feature, or change shipped nodes. Creating and linking single nodes, and the required sections per type, are in `define-entities` (`get_skill({ name: "define-entities" })`). Normative reference: `SPEC.md` (`get_spec({ topic })`).

The goal behind every step here: the product grows by addition. A good graph lets the next feature be built by adding nodes and links, without reopening shipped ones; judge a plan by that, not by how complete it looks or how fast the first version ships.

The duty this skill serves, from the playbook: **a new behavior is a new node.** When you plan it (before the code, or after it and before handoff) is your call; the merge gate Blocks a shipped node whose files changed while its territory did not, and Coverage Blocks a file no node claims.

## 1. Orient

```
orient_for_work({ query: "<the ask>" })   // ranked rows; a clear winner comes back in full
orient_for_work({ node_id: "<row id>" })  // its rules, decisions, body, files; depth: "full" adds the blast radius
orient_for_work({ change: "<change>" })   // every member of a change in one reply
```

A write on an existing node needs a full reply on it first (`Blocked: Orientation` otherwise). For an empty or unfamiliar graph, `get_mindplan_graph({ fields: ["id", "type", "title"] })` once; `export_mindplan_view` when the user wants a diagram.

### 2. Classify scope

Run the breakdown recipe in `define-entities` Step 0 before inventing nodes: one sentence per ask, reuse before create, brief and rules edits instead of nodes, Capability first, and the inversion of nodes that must know every feature. Then:

- **Decisions.** A choice between viable designs (a data shape, an ordering guarantee, which system owns a fact) is a `record_decision` call on the node it shapes: the decision, the alternative you rejected, and why. One choice that shapes several nodes is one record that lists them in `nodes` (`record_decision({ node_id, nodes: [...], … })`); it clears the decision gate of each listed node's revision. Each record is its own file, never rewritten; changing an earlier decision is a new record with `supersedes`. A shipped Foundation's revision, a new migration or schema file, a wide blast radius, or a `depends_on` change is `Blocked:` at `in-review` without one, and `run_check` warns from `draft` on.
- **Prefer additive over reopening.** Before `open_next` on a shipped node, read its `stability` in `orient_for_work({ node_id, depth: "full" })` (`rate` against `median_rate`: how often it shipped lately compared with the rest of the project; `fan_in`: nodes that depend on it directly) and any `hotspot:` warning from `run_check`. Every revision records why it happens (`reason`: `behavior`, `wiring`, `fix`, `platform`, `text`, `refactor`); only `behavior` and `wiring` count toward the rate, and the hotspot's diagnosis reads them. **Invert** (mostly `wiring`: each feature reopened it to add one edge): move those per-node edges onto one registry Foundation it depends on, which `depends_on` each new node and is kept whole; a split would not help. **Split** (mostly `behavior`): add a new node that `depends_on` it instead, or split the part this feature changes out of it (the node keeps importing the part; a part never imports the node to register itself). Mark the split on the node's open revision with `patch_node_territory({ node_id, split_into: [parts] })` (a Foundation's parts are Foundations it `depends_on`; an Interaction's are Interactions in one of its Capabilities; an Interface's are the Interactions it exposes), ship the parts first, then the revision: that ship records the split (`split_at`, `split_into`) and restarts its rate from zero. A node that should stay whole gets a decision with `keep_whole: true`, which silences the hotspot. `open_next` with `behavior` or `wiring` on a hotspot returns a `Warning:`, its `diagnosis`, and a `decision_prompt`: do the diagnosed refactor (a revision with reason `refactor`), or record why revising it as it is right, naming the refactor you rejected. `get_blast_radius({ change })` returns `additivity`: aim for "purely additive", or a few revised nodes with low fan-in.

Then decide what the session must produce: new nodes (Foundations with roles), edge rewires (`belongs_to` / `depends_on` / `exposes` / `leads_to` / `affects`), territory, brief edits (`patch_project_description`, `patch_project_rules`), node rules (`patch_node_rules`), or `open_next` drafts for shipped nodes (territory only — still no code).

### 3. Define and link entities

Follow `define-entities`: Capability first, then its definition order (Capabilities → Interactions at `draft` → Interfaces → Foundations derived from those drafts → links → territory → self-ready), under its Gate facts. Bugs filed into a plan get `affects` and stay at `open` or `triaged`.

### 4. Enrich territory and evolve shipped nodes

Write every contract with `patch_node_territory` (`define-entities` Step 6): real sections in place of scaffold stubs, following its section guidance and the ownership split (an Interaction owns its mountable view or handler; an Interface only mounts it), with **unchecked** PR-sized Atomic Ops.

**Source, neighbor, unaffected.** Territory Completeness applies to sources: a body describes the full intended contract, not a changelog. For a shipped node, call `get_blast_radius` and classify each node:

- A **source** (its contract changes) gets `open_next({ node_id, change, reason })`.
- A **neighbor** (files change, behavior doesn't) is edited in place later, with no revision and no change id (`change` on a shipped node with no open revision is `Blocked:`). The check gives it every stale-text signal once its files change against the base, so update its body when its files no longer match it. A neighbor that needs a new file beside its own, in a folder no other node claims into, claims it in place with `set_implementation_files({ node_id, add: [file] })` (no `open_next`) and names it in its body, or `run_check` warns `stale:`.
- An **unaffected** node gets nothing.

The parent self-readies when the contracts are written.

**Several revisions on one node.** A shipped node may already hold another change's open revision; open your own anyway (`open_next({ node_id, change, reason })` is `Blocked:` only when that same change is already open). Each revision is judged against live plus its own change, so other changes' revisions never block yours. On a node with more than one, pass `change` to every call that reads or writes it (`patch_node_territory`, `set_implementation_files`, `link_nodes`, `record_decision`, `update_node_status`, `orient_for_work`, …); without it the call is `Blocked:` and lists them, except `set_test_files`, which then writes live (pass `change` to link a revision's tests). On a revision, edges, claims, and tests are deltas against live: edit claims and tests with `add` / `remove` (`files` with `replace: true` replaces the whole list). When a sibling ships first, your revision is rebased onto the new live (`rebased` in their ship result): text only you changed is kept, text only they changed comes in, and a section or field both changed becomes a conflict (`revisions[].conflicts`). Resolve each with `resolve_conflict({ node_id, change, section | field | claim, take: "revision" | "live" | "text", text? })` before `in-review`.

**Planned wiring.** When the plan only needs **wiring** on a shipped node (a new Interaction its shipped Interface will expose, a new `depends_on` on a shipped Foundation), plan the edge instead of opening a revision: `link_nodes({ source_id, target_id, edge_type, change })`, or `link_nodes({ edges: [...], change })` for many at once (one exposes per shipped Interface, say). A planned link orients its source itself. On a node that has not shipped, pass no other change than its own: its edges are its own plan, so a different `change` is `Blocked:`. It is checked like a link, `run_check({ change })` validates it, and `open_next({ node_id, change, reason })` applies it when the build session opens the node; the live graph does not change until then. When a revision adds a file in another node's folder (a migration in the composition root's migrations folder), name it with `set_implementation_files({ node_id, attributed: [...] })` so the decision gate counts it for that revision.

### 4b. Parallel work in git worktrees

When several agents build one change at once, each in its own git worktree, the graph travels with the branches. One MindPlan server serves every worktree through `root`:

1. **Plan on the integration branch.** The orchestrator creates the change there with this skill: the nodes, the revisions (`open_next({ node_id, change, reason })`), and the decisions, and commits them before the worktrees branch off.
2. **Build in the worktree.** Each agent passes `root: "<absolute path of its worktree>"` to every MindPlan tool (`get_project`, `orient_for_work`, every write, `run_check`). The project rules gate and orientation are per root, so call `get_project` and orient in your own worktree. Fill your revisions, claim your files (`set_implementation_files({ node_id, add, root })`), link your tests (`set_test_files({ node_id, change, add, root })`; without `change` it writes live), and move them to `in-review`. A result from another root carries `root`; a `Blocked:` from one ends with `(root: <path>)`.
3. **Merge.** Merging the branches brings the graph along with the code. Run `run_check({ after_merge: true })` (CLI `mindplan-mcp check --after-merge`) on the merged checkout and fix each `Blocked: after-merge:` line; a `Warning: after-merge:` on a revision whose base moved names `rebase_revision({ node_id, change })`, then `resolve_conflict` for any conflict it reports.
4. **Ship.** The orchestrator ships from the integration branch with one scoped walk, `update_node_status({ scope: "change", change, new_status: "ship" })`; `nodes: [...]` ships only the finished members while the rest keep building.

Two changes must not each add half of a `depends_on` cycle: `link_nodes` and `open_next` are `Blocked:` on an edge that closes a cycle across changes. Move the shared part into a Foundation both depend on.

## 5. Ready and ship

- **Extension check, before self-ready.** The graph exists so the next feature is added, not reopened. For each Foundation in the plan, name two plausible future features (from the growth directions in the project description when it lists them) and say whether each would reopen it: a new edge, a new section, a new rule every dependent must remember. If both would, split or invert it now (*Prefer additive over reopening* in §2; `define-entities` Step 0, item 5), or record why it stays whole with `record_decision` (`keep_whole: true`). Check the same for any node with many dependents (`fan_in` in `orient_for_work({ node_id, depth: "full" })`). A pre-ship Foundation with more direct dependents than `decisions.blast_radius` gets a `fan-in:` warning that groups them by Capability (`stability.fan_in_groups`): those groups are usually the split. A decision about anything else does not clear it; only the split or `keep_whole` does.
- A plan is build-ready when `run_check` passes, links are complete (an Interaction: one `belongs_to` and one Foundation `depends_on`; an Interface: one `exposes`; a Bug past `open`: `affects`), and every required section is written. Self-ready it in one call: `update_node_status({ revisions: [...] })` (the server orders Foundations, Interactions, Interfaces), or `scope: "change"` for a change.
- Any later edit to a `ready` slot's text, claims, or links sends it back to `draft` (`readiness_reset`); self-ready it again.
- Atomic Ops are ticked when the work they name is done, by `id` with `toggle_checkboxes` (`note` / `not_applicable` when done differently); a `review` or `deploy` item waits on a person.
- When the implementation is done and a merge is requested, walk the change to `ship`: `update_node_status({ scope: "change", change, new_status: "ship" })`. `run_check({ merge: true })` is the merge gate.
- A plan that will not ship is dropped with `discard_change({ change })`: one call removes its open revisions, its never-shipped nodes, and its planned edges (`orient_for_work({ change })` first shows what goes; one revision alone is `discard_next`). It refuses while a node that stays points at one that goes, and keeps what already shipped. Never restore `mindplan/` with git instead.

## Never

- Edit `mindplan/**` with host file tools, or hand-edit server-owned frontmatter (`state`, timestamps, edge arrays)
- Claim a new behavior's files onto an existing node to avoid creating one
- Set Capability state, `stable`, or `unstable` by hand
- Treat `mindplan/map.md` as graph authority
- Anything in the `define-entities` Common mistakes table
