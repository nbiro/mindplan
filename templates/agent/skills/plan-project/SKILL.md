---
name: mindplan-plan-project
description: >-
  Create or patch the MindPlan graph (Capabilities, Foundations, Interactions,
  Interfaces, Bugs, edges, territory) without writing application code. Use
  whenever you create_node, link/unlink, patch territory or project brief/config,
  open_next, or discard_next — including before any new-feature code change when
  nodes must be updated or created. Also use for plan-only / greenfield sessions.
---

# Plan a MindPlan Project (no code)

Use this skill whenever you create or patch MindPlan territory: in plan-only sessions, and for the graph work that must finish **before** any new-feature code change. Application code (files claimed with `set_implementation_files`) waits for an execution session under `get_project.playbook`.

The server serves this skill (`get_skill({ name: "plan-project" })`). Create and link details: the `define-entities` skill (`get_skill({ name: "define-entities" })`). Normative reference: `SPEC.md`. Before each action in this skill, call `get_rules`, then `orient_for_work`.

## When to use

| User intent | Use this skill? |
|-------------|-----------------|
| “Let’s plan / model / map the product” | Yes |
| Greenfield: define Capabilities → draft Interactions → Interfaces → derive Foundations | Yes |
| Restructure edges, enrich PRDs, rewrite Atomic Ops | Yes |
| Before new-feature code: update or create the matching nodes | Yes — finish this skill, then implement |
| Any `create_node` / link / territory / brief / config / `open_next` / `discard_next` | Yes |
| “Implement / build / fix / ship this Interaction” (code already on the graph) | No — playbook build or Bug loop |
| Mixed “plan then code” in one ask | Plan first with this skill; **stop** and confirm before any implementation session |

## Hard rules (plan-only)

- **No application code** — do not create, edit, or delete files claimed by nodes. Use `set_implementation_files` only to declare intended boundaries, and prefer leaving that to the build session unless the user asks.
- **No implementation pipeline** — do not move Foundations, Interactions, or Interfaces to `in-progress`, `in-review`, or `ship`, or Bugs to `fixing`, `in-review`, or `resolved`.
- **Allowed states** — write contracts at `draft`; when they are real, self-`ready` them in one ordered call (§6).
- **Never tick Atomic Ops** — they stay open until an execution session implements them.
- Write only through MindPlan MCP. Every `Blocked: <reason>` is a hard failure: fix the plan, do not retry blindly.

## Session loop

### 1. Orient

```
orient_for_work({ query: "<user ask>" })   // ranked rows; pick the node you will work on
orient_for_work({ node_id: "<row id>" })   // its rules, decisions, body, files, blast radius
```

A write on an existing node needs that `node_id` orientation first (playbook rule 1). For an empty or unknown graph, also call `get_mindplan_graph` once; use `export_mindplan_view` when the user wants a diagram.

### 2. Classify scope

Run the breakdown recipe in `define-entities` Step 0 before inventing nodes: one sentence per ask, reuse before create, brief and rules edits instead of nodes, Capability first, and the inversion of nodes that must know every feature. Then:

- **Decisions.** A choice between viable designs (a data shape, an ordering guarantee, which system owns a fact) is a `record_decision` call on the node it shapes: the decision, the alternative you rejected, and why. One choice that shapes several nodes is one record that lists them in `nodes` (`record_decision({ node_id, nodes: [...], … })`); it clears the decision gate of each listed node's revision. Each record is its own file, never rewritten; changing an earlier decision is a new record with `supersedes`. A shipped Foundation's revision, a new migration or schema file, a wide blast radius, or a `depends_on` change is `Blocked:` at `in-review` without one, and `run_check` warns from `draft` on.
- **Prefer additive over reopening.** Before `open_next` on a shipped node, read its `stability` in the full `orient_for_work` reply (`rate` against `median_rate`: how often it shipped lately compared with the rest of the project; `fan_in`: nodes that depend on it directly) and any `hotspot:` warning from `run_check`. On a hotspot, add a new node that `depends_on` it instead, or split the part this feature changes out of it (the node keeps importing the part; a part never imports the node to register itself). Mark the split on the node's open revision with `patch_node_territory({ node_id, split_into: [parts] })` (a Foundation's parts are Foundations it `depends_on`; an Interaction's are Interactions in one of its Capabilities; an Interface's are the Interactions it exposes), ship the parts first, then the revision: that ship records the split (`split_at`, `split_into`) and restarts its rate from zero. A node that should stay whole gets a decision with `keep_whole: true`, which silences the hotspot. `open_next` on a hotspot returns a `Warning:` and a `decision_prompt`: record why revising it is right, naming the additive alternative you rejected. `get_blast_radius({ change })` returns `additivity`: aim for "purely additive", or a few revised nodes with low fan-in.

Then decide what the session must produce: new nodes (Foundations with roles), edge rewires (`belongs_to` / `depends_on` / `exposes` / `leads_to` / `affects`), territory, brief edits (`patch_project_description`, `patch_project_rules`), node rules (`patch_node_rules`), or `open_next` drafts for shipped nodes (territory only — still no code).

### 3. Define and link entities

Follow `define-entities`: Capability first, then its definition order (Capabilities → Interactions at `draft` → Interfaces → Foundations derived from those drafts → links → territory → self-ready), under its Gate facts. Bugs filed into a plan get `affects` and stay at `open` or `triaged`.

### 4. Enrich territory and evolve shipped nodes

Write every contract with `patch_node_territory` (`define-entities` Step 6): real sections in place of scaffold stubs, following its section guidance and the ownership split (an Interaction owns its mountable view or handler; an Interface only mounts it), with **unchecked** PR-sized Atomic Ops.

**Source, neighbor, unaffected.** Territory Completeness applies to sources: a body describes the full intended contract, not a changelog. For a shipped node, call `get_blast_radius` and classify each node:

- A **source** (its contract changes) gets `open_next({ node_id, change })`.
- A **neighbor** (files change, behavior doesn't) is edited in place later, with no revision and no change id (`change` on a shipped node with no open revision is `Blocked:`). The check gives it every stale-text signal once its files change against the base, so update its body when its files no longer match it. A neighbor that needs a new file beside its own, in a folder no other node claims into, claims it in place with `set_implementation_files({ node_id, add: [file] })` (no `open_next`) and names it in its body, or `run_check` warns `stale:`.
- An **unaffected** node gets nothing.

The parent self-readies when the contracts are written.

**Several revisions on one node.** A shipped node may already hold another change's open revision; open your own anyway (`open_next({ node_id, change })` is `Blocked:` only when that same change is already open). Each revision is judged against live plus its own change, so other changes' revisions never block yours. On a node with more than one, pass `change` to every call that reads or writes it (`patch_node_territory`, `set_implementation_files`, `link_nodes`, `record_decision`, `update_node_status`, `orient_for_work`, …); without it the call is `Blocked:` and lists them, except `set_test_files`, which then writes live (pass `change` to link a revision's tests). On a revision, edges, claims, and tests are deltas against live: edit claims and tests with `add` / `remove` (`files` with `replace: true` replaces the whole list). When a sibling ships first, your revision is rebased onto the new live (`rebased` in their ship result): text only you changed is kept, text only they changed comes in, and a section or field both changed becomes a conflict (`revisions[].conflicts`). Resolve each with `resolve_conflict({ node_id, change, section | field | claim, take: "revision" | "live" | "text", text? })` before `in-review`.

**Planned wiring.** When the plan only needs **wiring** on a shipped node (a new Interaction its shipped Interface will expose, a new `depends_on` on a shipped Foundation), plan the edge instead of opening a revision: `link_nodes({ source_id, target_id, edge_type, change })`. It is checked like a link, `run_check({ change })` validates it, and `open_next({ node_id, change })` applies it when the build session opens the node; the live graph does not change until then. When a revision adds a file in another node's folder (a migration in the composition root's migrations folder), name it with `set_implementation_files({ node_id, attributed: [...] })` so the decision gate counts it for that revision.

### 4b. Parallel work in git worktrees

When several agents build one change at once, each in its own git worktree, the graph travels with the branches. One MindPlan server serves every worktree through `root`:

1. **Plan on the integration branch.** The orchestrator creates the change there with this skill: the nodes, the revisions (`open_next({ node_id, change })`), and the decisions, and commits them before the worktrees branch off.
2. **Build in the worktree.** Each agent passes `root: "<absolute path of its worktree>"` to every MindPlan tool (`get_rules`, `orient_for_work`, every write, `run_check`). Orientation is per root, so orient in your own worktree. Fill your revisions, claim your files (`set_implementation_files({ node_id, add, root })`), link your tests (`set_test_files({ node_id, change, add, root })`; without `change` it writes live), and move them to `in-review`. A result from another root carries `root`; a `Blocked:` from one ends with `(root: <path>)`.
3. **Merge.** Merging the branches brings the graph along with the code. Run `run_check({ after_merge: true })` (CLI `mindplan-mcp check --after-merge`) on the merged checkout and fix each `Blocked: after-merge:` line; a `Warning: after-merge:` on a revision whose base moved names `rebase_revision({ node_id, change })`, then `resolve_conflict` for any conflict it reports.
4. **Ship.** The orchestrator ships from the integration branch with one scoped walk, `update_node_status({ scope: "change", change, new_status: "ship" })`; `nodes: [...]` ships only the finished members while the rest keep building.

Two changes must not each add half of a `depends_on` cycle: `link_nodes` and `open_next` are `Blocked:` on an edge that closes a cycle across changes. Move the shared part into a Foundation both depend on.

### 5. On `Blocked:`

On `Blocked:` or a mismatch after a mutation — stop and fix; do not continue. The server already writes `mindplan/map.md`; do not call `export_mindplan_view` after every write.

### 6. Self-ready, then stop

When the graph matches the user’s product model and territory is a full contract (not stubs), with nodes at `draft` (or Bugs at `open` / `triaged`):

1. `run_check` (CLI `mindplan-mcp check`) returns ok. Fix every `Blocked:` first.
2. Self-`ready` the revision in one `update_node_status` `revisions` call (Foundations, then Interactions, then Interfaces). Every item is tried; `results` says which moved, and the call is `Blocked:` only when none did. When the revision spans several nodes, give them one change id (`change` on `open_next` / `create_node`, or `patch_node_territory({ node_id, change })` before first ship) and use `scope: "change"` instead; a shipped node with several open revisions moves only through `scope: "change"` or a single call with `change`.
3. Any later edit to a `ready` node's text, claims, or links sends it back to `draft` (`readiness_reset`); self-ready it again.
4. After MCP confirms `ready`, **stop** if this is still a plan-only session. A later **execution session** runs `in-progress` → implement → one Implementation review that judges these contracts and the diff together. Do not start implementation unless the user explicitly switches modes.

## Shipping a plan (self-ready)

When the user says **“ship the plan”**, **“ship it”** (in a plan-only session), or otherwise wants the modeled graph build-ready, that means self-`ready` and stop — not the build-pipeline `ship` transition. Before self-ready:

- `run_check` returns ok (same as `mindplan-mcp check` exiting `0`)
- Links are complete (Interactions: at least one `belongs_to` + one Foundation `depends_on`; Interfaces: at least one `exposes`; Bugs past `open`: `affects`)
- Territory is a full contract with **unchecked** Atomic Ops; an item a person closes (a review sign-off, a deploy) is added with `patch_node_territory({ node_id, add_checklist_items: [{ text, id, kind: "review" | "deploy" }] })`
- No application code under `src/`, no state past `ready`, no ticked boxes

The build-pipeline `ship` happens in the execution session, before the PR merges: `run_check({ merge: true })` (CLI `mindplan-mcp check --merge`) is the merge gate and fails while any node is still `in-review`; plan-only PRs (`draft` / `ready`) pass it.

## Never do (this skill)

- Write or “just scaffold” application code (claimed paths) in a plan-only session
- Advance to `in-progress` / `in-review` / `ship`, or Bug `fixing` / `resolved`, in a plan-only session
- Treat “ship the plan” as build-pipeline `ship` / `stable`, or as permission to tick Atomic Ops
- Edit `mindplan/**` with host file tools, or hand-edit server-owned frontmatter (`state`, timestamps, edge arrays)
- Set Capability state, `stable`, or `unstable` manually
- Treat `mindplan/map.md` as graph authority
- Self-`ready` or claim done while `mindplan-mcp check` fails
- Anything in the `define-entities` Common mistakes table
