---
name: mindplan-plan-project
description: >-
  Plan-only MindPlan sessions: model or restructure the product graph (Journeys,
  Foundations, Workflows, Bugs, edges, territory) without writing application
  code. Use when the user wants to plan, architect, greenfield the product model,
  map capabilities, or reshape the mindplan — not implement features.
---

# Plan a MindPlan Project (no code)

Use this skill when the session’s job is **only** to create or reshape MindPlan territory. Application code under `src/workflows/` and `src/foundations/` (or the project’s existing layout when `implementation_packages` is `off`) is out of scope until a later execution session under `mindplan/agent/playbook.md`.

Prerequisite: MindPlan MCP is registered. Normative reference: `SPEC.md`. Entity create/link details: `mindplan/agent/skills/define-entities/SKILL.md`. Always-on execution process (build pipeline, bugs, shipping): `mindplan/agent/playbook.md`.

## When to use

| User intent | Use this skill? |
|-------------|-----------------|
| “Let’s plan / model / map the product” | Yes |
| Greenfield: define Journeys → Foundations → Workflows | Yes |
| Restructure edges, enrich PRDs, rewrite Atomic Ops | Yes |
| “Implement / build / fix / ship this Workflow” | No — playbook build or Bug loop |
| Mixed “plan then code” in one ask | Plan first with this skill; **stop** and confirm before any implementation session |

## Hard rules (plan-only)

- **No application code** — do not create, edit, or delete files under `src/workflows/<id>/` or `src/foundations/<id>/` (except ignoring empty `.gitkeep` scaffolds that `create_node` already made when packages are `required`). When packages are `off`, do not start implementing in the existing app layout either — plan-only means graph/territory only.
- **No implementation pipeline** — do not move Foundations/Workflows to `in-progress`, `in-review`, or `ship`. Do not move Bugs to `fixing` / `in-review` / `resolved`.
- **Allowed states** — leave new or reshaped nodes in `draft`. When the user wants the plan “shipped” / build-ready, finish links, PRD, and unchecked Atomic Ops at `draft`, then **stop** and hand off for Plan Review (`mindplan/agent/skills/review-work/`). Do not self-advance to `ready`. See **Shipping a plan** below.
- **Never check off Atomic Ops** as done — checkboxes stay open until real implementation completes in an execution session.
- Mutate graph state only through MindPlan MCP. Treat every `Blocked: <reason>` as a hard failure — fix the plan, do not retry blindly.

## Session loop

### 1. Orient

```
orient_for_work({ query: "<user ask>" })
```

For empty or unknown graphs, also call `get_mindplan_graph` once. Prefer `export_mindplan_view` when the user wants a diagram.

### 2. Classify scope

Decide what the plan session must produce: new Journeys, Foundations (with roles), Workflows, Bugs, edge rewires, territory enrichment, or `open_next` drafts for shipped nodes (territory/spec only — still no code).

### 3. Define and link entities

Follow `mindplan/agent/skills/define-entities/`:

1. Journeys first (refuse Workflows with no matching Journey)
2. Foundations with role tags in `description`
3. Workflows with `belongs_to` + `depends_on`
4. Bugs with `affects` only when filing defects into the plan (stay at `open` or `triaged` — do not `fixing`)

Greenfield order:

```
Journey(s) → Foundation(s) → Workflow(s) → link_nodes → enrich territory → stop at draft → Plan Review handoff
```

### 4. Enrich territory (full contracts)

Prefer host file tools on `current_path` / `next_path` for body / title / description (so humans see native diffs). `patch_node_territory` is an optional fallback. Replace scaffold stubs with real Purpose, PRD / Execution Logic / Shared Substrate Spec, Acceptance Criteria, and **unchecked** PR-sized Atomic Ops.

Territory Completeness still applies: bodies describe the full intended contract, not a changelog. For shipped nodes, call `get_blast_radius` then `open_next` before changing live scope; edit the `next` slot into a complete proposed successor — still without implementing code or advancing `next` past `draft` (Plan Review owns `draft` → `ready`).

### 5. Validate after every mutation

After each `create_node`, `link_nodes`, `unlink_nodes`, `open_next`, `discard_next`, or `update_node_status` (and after material prose edits):

1. Re-read focus via `find_related_nodes` / `get_node_context` (full `get_mindplan_graph` after multi-node restructuring)
2. Confirm ids, states (including `next.state`), and edges match intent; surface `changed_files` from graph tools when narrating MCP writes
3. Confirm the visualization with `export_mindplan_view` or a fresh neighborhood read
4. On `Blocked:` or mismatch — stop and fix; do not continue

### 6. Hand off

End the plan session when:

- The graph matches the user’s product model
- Territory is a full contract (not stubs)
- Nodes sit at `draft` (or Bugs at `open` / `triaged`), ready for Plan Review
- You have shown or offered `export_mindplan_view` so humans can review the map

Tell the user the plan is ready for a **Plan Review** session (`mindplan/agent/skills/review-work/`). After Plan Review advances nodes to `ready`, a later **execution session** runs under the always-on playbook (`in-progress` → implement → `in-review`). Do not start either of those in the same plan-only session unless they explicitly switch modes.

## Shipping a plan (hand off for Plan Review)

When the user says **“ship the plan”**, **“ship it”** (in a plan-only session), or otherwise wants the modeled graph build-ready — that means finish at `draft` and hand off for Plan Review, not self-advance to `ready`, and not the build-pipeline `ship` transition.

Requirements before handoff:

- Links complete (Workflows: at least one `belongs_to` + one `depends_on`; Bugs past `open`: `affects`)
- Territory is a full contract with **unchecked** Atomic Ops
- Nodes remain at `draft` — do not call `update_node_status` → `ready`
- **No** application code under `src/`
- **No** `in-progress` / `in-review` / `ship` / `stable`
- **No** checking off checklist boxes

Then **stop**. Hand off for Plan Review (`mindplan/agent/skills/review-work/`). Do not interpret “ship” here as `update_node_status` → `ship` or as permission to advance to `ready` yourself.

## Never do (this skill)

- Write or “just scaffold” real implementation in `src/workflows/` / `src/foundations/`
- Advance to `ready` / `in-progress` / `in-review` / `ship`, or Bug `fixing` / `resolved`
- Treat “ship the plan” as build-pipeline `ship` / `stable`, as self-advance to `ready`, or as permission to check Atomic Ops
- Check off Atomic Ops without implementation
- Create a Workflow with no matching Journey
- Hand-edit server-owned frontmatter (`state`, timestamps, edge arrays)
- Set Journey, `stable`, or `unstable` manually
- Treat `mindplan/map.md` as graph authority
- Skip post-mutation validation
