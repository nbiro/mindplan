---
name: mindplan-plan-project
description: >-
  Create or patch the MindPlan graph (Journeys, Foundations, Interactions,
  Interfaces, Bugs, edges, territory) without writing application code. Use
  whenever you create_node, link/unlink, patch territory or project brief/config,
  open_next, or discard_next — including before any new-feature code change when
  nodes must be updated or created. Also use for plan-only / greenfield sessions.
---

# Plan a MindPlan Project (no code)

Use this skill whenever you create or patch MindPlan territory. That includes plan-only sessions and the graph work that must finish **before** any new-feature code change. Application code (files claimed via `implements` / `set_implementation_files`) is out of scope until a later execution session under `get_project.playbook`.

Prerequisite: MindPlan MCP is registered. Normative reference: `SPEC.md`. Entity create/link details: the `define-entities` skill. Always-on execution process (build pipeline, bugs, shipping): `get_project.playbook`. Before each action in this skill, call `get_rules`, then `orient_for_work`.

## When to use

| User intent | Use this skill? |
|-------------|-----------------|
| “Let’s plan / model / map the product” | Yes |
| Greenfield: define Journeys → draft Interactions → Interfaces → derive Foundations | Yes |
| Restructure edges, enrich PRDs, rewrite Atomic Ops | Yes |
| Before new-feature code: update or create the matching nodes | Yes — finish this skill, then implement |
| Any `create_node` / link / territory / brief / config / `open_next` / `discard_next` | Yes |
| “Implement / build / fix / ship this Interaction” (code already on the graph) | No — playbook build or Bug loop |
| Mixed “plan then code” in one ask | Plan first with this skill; **stop** and confirm before any implementation session |

## Hard rules (plan-only)

- **No application code** — do not create, edit, or delete implementation files claimed by nodes. Plan-only means graph/territory only (including `set_implementation_files` only when declaring intended boundaries — prefer leaving that to the build session unless the user asks).
- **No implementation pipeline** — do not move Foundations/Interactions/Interfaces to `in-progress`, `in-review`, or `ship`. Do not move Bugs to `fixing` / `in-review` / `resolved`.
- **Allowed states** — write contracts at `draft`. When the contracts are real, self-`ready` the revision in one ordered `revisions` call. See **Shipping a plan** below.
- **Never check off Atomic Ops** as done — checkboxes stay open until real implementation completes in an execution session.
- Mutate graph state only through MindPlan MCP. Treat every `Blocked: <reason>` as a hard failure — fix the plan, do not retry blindly.
- **Interaction Independence** — never model Interaction → Interaction `depends_on`; use Foundations for shared state and `leads_to` for navigation.

## Session loop

### 1. Orient

```
orient_for_work({ query: "<user ask>" })   // ranked rows; pick the node you will work on
orient_for_work({ node_id: "<row id>" })   // its rules, decisions, body, files, blast radius
```

A query alone returns summary rows (and the full node only for a clear winner, `auto_focus: true`). A write on an existing node is `Blocked: Orientation` until you oriented on that node with `node_id` in this session, and again after the rules that reach it changed; `create_node` is never blocked.

For empty or unknown graphs, also call `get_mindplan_graph` once. Prefer `export_mindplan_view` when the user wants a diagram.

### 2. Classify scope

Run the **breakdown recipe** from `define-entities` Step 0 before inventing nodes:

1. Rewrite the ask as: *"<who> can <verb> <object> in <area>, from <entry point>, using <building blocks>."*
2. Each distinct verb + object → one Interaction candidate (size: one behavior).
3. **Reuse before create** — `find_related_nodes` / graph inspect for each area, action, entry point, and building block. Same action from a new entry point → new `exposes`, not a new Interaction. One Interface per actor + channel (not per page/tab).
4. State which nodes you will add, **in plain words**. Example: "I'll add *split the check* as a new action in the Billing area and show it from the back-office app."
5. Missing area → polite refuse: "This needs an area first; is it part of Billing or something new?" Do not silently mint a Journey.
6. A **product summary** is a `patch_project_description` call. A **standing rule** is a `patch_project_rules` call when it applies everywhere, or a `patch_node_rules` call on the node when it is about one area (it reaches that node, its dependents, and its Journey's Interactions; check `rules_impact`). Neither is a new Journey. Call `get_project` again to re-read the brief.

7. A **choice between viable designs** (a data shape, an ordering guarantee, which system owns a fact) is a `record_decision` call on the node it shapes: the decision, the alternative you rejected, and why. Changing an earlier decision is a new record with `supersedes`, never an edit. A shipped Foundation's revision, a new migration or schema file, a wide blast radius, or a `depends_on` change is Blocked at `in-review` without one, and `run_check` warns from draft on.

Then decide what the plan session must produce: new Journeys, Foundations (with roles), Interactions, Interfaces, Bugs, edge rewires (`belongs_to` / `depends_on` / `exposes` / `leads_to` / `affects`), territory enrichment, project-brief edits via `patch_project_description` and `patch_project_rules`, node rules via `patch_node_rules`, or `open_next` drafts for shipped nodes (territory/spec only — still no code).

### 3. Define and link entities

Follow the `define-entities` skill:

1. Journeys first (refuse Interactions with no matching Journey — plain-word refusal)
2. Interactions at `draft` (behavior / PRD thinking; links not required yet)
3. Interfaces that will `exposes` those Interactions
4. Foundations derived from those drafts (role tags in `description`)
5. Link: Interaction `belongs_to` + Foundation `depends_on`; Interface `exposes` (+ optional Foundation deps); `leads_to` for navigation
6. Bugs with `affects` only when filing defects into the plan (stay at `open` or `triaged` — do not `fixing`)

Greenfield order:

```
Journey(s) → Interaction(s) at draft → Interface(s) → Foundation(s) derived from those drafts → link_nodes → enrich territory → self-ready → stop if plan-only
```

Gate facts: Journey before any Interaction create; draft Interactions may lack links until leaving `draft`; Interfaces need `exposes` before leaving `draft`; Foundation `ready` before Interaction `ready` is preference — Infrastructure First at Interaction `ship` still requires Foundations `stable`; Behavior First at Interface `ship` requires exposed Interactions `stable`.

### 4. Enrich territory (full contracts)

Use `patch_node_territory` for body / title / description (MCP is the only writer of `mindplan/`). Replace scaffold stubs with real Purpose, Actor & Trigger / Kind / PRD / Shared Substrate Spec, Acceptance Criteria, and **unchecked** PR-sized Atomic Ops.

Interaction Purpose is one sentence: what the action does, and the constraint a later session would otherwise simplify away. If there is no such constraint, the outcome sentence is enough.

Apply **package ownership** (SPEC §1.2.2) while enriching:

- Interaction PRDs: when a Page/UI Interface will `exposes` this behavior, include a mount/view surface. When Kind is CLI/MCP/Webhook/Cron, name the exportable handler/module — not a `*-view.tsx`.
- Interface Spec: “App Router (or CLI/MCP) mounts Interaction packages; Interface does not own core domain logic or screen bodies.” Do not write territory that implies screen bodies live under `interfaces/…/ui/` or `screens/`.
- One Interface per actor surface, not one Interface per screen/tab.
- Keep Interaction/Interface Atomic Ops templates from `define-entities`.

Territory Completeness still applies to **sources**: bodies describe the full intended contract, not a changelog. For shipped nodes, call `get_blast_radius`, classify source / neighbor / unaffected, and `open_next` only for sources. Neighbors (files change, behavior doesn't) are edited in place later; do not plan `next` slots for them. Label each neighbor with the revision's change id (`patch_node_territory({ node_id, change })`) so `get_blast_radius({ change })` and `run_check({ change })` include it; the label clears when the change's last revision ships or is discarded. A neighbor that needs a new file beside its own, in a folder no other node claims into, claims it in place with `set_implementation_files` (no `open_next`); name the file in its body, or `run_check` warns `stale:`. The parent self-readies when the contracts are written.

When the plan only needs **wiring** on a shipped node (a new Interaction its shipped Interface will expose, a new `depends_on` on a shipped Foundation), plan the edge instead of opening a revision: `link_nodes({ source_id, target_id, edge_type, change })`. It is checked like a link, `run_check({ change })` validates it, and `open_next({ node_id, change })` applies it when the build session opens the node; the live graph does not change until then. When a revision adds a file in another node's folder (a migration in the composition root's migrations folder), name it with `set_implementation_files({ node_id, attributed: [...] })` so the decision gate counts it for that revision.

### 5. On `Blocked:`

On `Blocked:` or a mismatch after a mutation — stop and fix; do not continue. The server already writes `mindplan/map.md`. Do not require `export_mindplan_view` after every write.

### 6. Self-ready, then stop

When the graph matches the user’s product model and territory is a full contract (not stubs), with nodes at `draft` (or Bugs at `open` / `triaged`):

1. `run_check` (CLI `mindplan-mcp check`) returns ok. Fix every `Blocked:` first.
2. Self-`ready` the revision in one `update_node_status` `revisions` call (Foundations, then Interactions, then Interfaces). When the revision spans several nodes, give them one change id (`change` on `open_next` / `create_node`, or `patch_node_territory({ node_id, change })`) and use `scope: "change"` instead.
3. Any later edit to a `ready` node's text, claims, or links sends it back to `draft` (`readiness_reset`); self-ready it again.
4. After MCP confirms `ready`, **stop** if this is still a plan-only session. A later **execution session** runs `in-progress` → implement → one Implementation review that judges these contracts and the diff together. Do not start implementation unless the user explicitly switches modes.

## Shipping a plan (self-ready)

When the user says **“ship the plan”**, **“ship it”** (in a plan-only session), or otherwise wants the modeled graph build-ready — that means self-`ready` and stop. It is not the build-pipeline `ship` transition.

Requirements before self-ready:

- `run_check` returns ok (same as `mindplan-mcp check` exiting `0`)
- Links complete (Interactions: at least one `belongs_to` + one Foundation `depends_on`; Interfaces: at least one `exposes`; Bugs past `open`: `affects`)
- Territory is a full contract with **unchecked** Atomic Ops
- Call `update_node_status` → `ready` yourself, one `revisions` call for the set
- **No** application code under `src/`
- **No** `in-progress` / `in-review` / `ship` / `stable`
- **No** checking off checklist boxes
- **No** Interaction→Interaction `depends_on`

Then self-ready. Do not interpret “ship” here as `update_node_status` → `ship`. The build-pipeline `ship` happens in the execution session, before the PR merges: `run_check({ merge: true })` (CLI `mindplan-mcp check --merge`) is the merge gate and fails while any node is still `in-review`; plan-only PRs (`draft` / `ready`) pass it.

## Never do (this skill)

- Write or “just scaffold” real application implementation (claimed `implements` paths) in a plan-only session
- Advance to `in-progress` / `in-review` / `ship`, or Bug `fixing` / `resolved`, in a plan-only session
- Treat “ship the plan” as build-pipeline `ship` / `stable`, or as permission to check Atomic Ops
- Check off Atomic Ops without implementation
- Create an Interaction with no matching Journey
- Link Interaction → Interaction with `depends_on`
- Write Interface territory as if it owns feature screen bodies, or mint one Interface per screen/tab
- Omit mount/view (Page/UI) or handler/module (CLI/MCP/Webhook/Cron) from Interaction PRDs that an Interface will expose
- Hand-edit server-owned frontmatter (`state`, timestamps, edge arrays)
- Set Journey, `stable`, or `unstable` manually
- Treat `mindplan/map.md` as graph authority
- Self-`ready` or claim done while default `mindplan-mcp check` fails
