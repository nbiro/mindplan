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
| Greenfield: define Journeys → draft Workflows → derive Foundations | Yes |
| Restructure edges, enrich PRDs, rewrite Atomic Ops | Yes |
| “Implement / build / fix / ship this Workflow” | No — playbook build or Bug loop |
| Mixed “plan then code” in one ask | Plan first with this skill; **stop** and confirm before any implementation session |

## Hard rules (plan-only)

- **No application code** — do not create, edit, or delete files under `src/workflows/<id>/` or `src/foundations/<id>/` (except ignoring empty `.gitkeep` scaffolds that `create_node` already made when packages are `required`). When packages are `off`, do not start implementing in the existing app layout either — plan-only means graph/territory only.
- **No implementation pipeline** — do not move Foundations/Workflows to `in-progress`, `in-review`, or `ship`. Do not move Bugs to `fixing` / `in-review` / `resolved`.
- **Allowed states** — leave new or reshaped nodes in `draft`. When the user wants the plan “shipped” / build-ready, finish links, PRD, and unchecked Atomic Ops at `draft`, then run the **Plan Review loop** (spawn Reviewer via `review-work`) until `ready` or escalate. Do not self-advance to `ready`. See **Shipping a plan** below.
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
2. Workflows at `draft` (use-case / PRD thinking; links not required yet)
3. Foundations derived from those drafts (role tags in `description`)
4. Link Workflows (`belongs_to` + `depends_on`) once substrate is clear
5. Bugs with `affects` only when filing defects into the plan (stay at `open` or `triaged` — do not `fixing`)

Greenfield order:

```
Journey(s) → Workflow(s) at draft → Foundation(s) derived from those drafts → link_nodes → enrich territory → Plan Review Foundations → Plan Review Workflows → ready (then stop if plan-only)
```

Gate facts: Journey before any Workflow create; draft Workflows may lack links until leaving `draft`; Foundation `ready` before Workflow `ready` is preference — Infrastructure First at Workflow `ship` still requires Foundations `stable`.

### 4. Enrich territory (full contracts)

Prefer host file tools on `current_path` / `next_path` for body / title / description (so humans see native diffs). `patch_node_territory` is an optional fallback. Replace scaffold stubs with real Purpose, PRD / Execution Logic / Shared Substrate Spec, Acceptance Criteria, and **unchecked** PR-sized Atomic Ops.

Territory Completeness still applies: bodies describe the full intended contract, not a changelog. For shipped nodes, call `get_blast_radius` then `open_next` before changing live scope; edit the `next` slot into a complete proposed successor — still without implementing code or advancing `next` past `draft` (Plan Review owns `draft` → `ready`).

### 5. Validate after every mutation

After each `create_node`, `link_nodes`, `unlink_nodes`, `open_next`, `discard_next`, or `update_node_status` (and after material prose edits):

1. Re-read focus via `find_related_nodes` / `get_node_context` (full `get_mindplan_graph` after multi-node restructuring)
2. Confirm ids, states (including `next.state`), and edges match intent; surface `changed_files` from graph tools when narrating MCP writes
3. Confirm the visualization with `export_mindplan_view` or a fresh neighborhood read
4. On `Blocked:` or mismatch — stop and fix; do not continue

### 6. Plan Review loop, then stop

When the graph matches the user’s product model and territory is a full contract (not stubs), with nodes at `draft` (or Bugs at `open` / `triaged`):

1. For each Foundation/Workflow that should leave `draft`, run the **Plan Review loop** (playbook): spawn a fresh Reviewer (`review-work` Procedure A); fix from Findings in the verdict message; re-spawn up to 3 rejects; escalate to the human if still blocked. Prefer Plan Review on Foundations **before** their dependent Workflows so Workflows do not leave `draft` against missing substrate.
2. Do **not** self-call `update_node_status → ready`.
3. After MCP confirms `ready`, **stop** if this is still a plan-only session. A later **execution session** runs `in-progress` → implement → Implementation review loop. Do not start implementation unless the user explicitly switches modes.
4. Show or offer `export_mindplan_view` so humans can review the map.

## Shipping a plan (Plan Review loop → ready)

When the user says **“ship the plan”**, **“ship it”** (in a plan-only session), or otherwise wants the modeled graph build-ready — that means finish at `draft` and run the Plan Review loop until `ready` (or escalate), not self-advance to `ready`, and not the build-pipeline `ship` transition.

Requirements before spawning Plan Review:

- Links complete (Workflows: at least one `belongs_to` + one `depends_on`; Bugs past `open`: `affects`)
- Territory is a full contract with **unchecked** Atomic Ops
- Nodes remain at `draft` until the Reviewer advances them — do not call `update_node_status` → `ready` yourself
- **No** application code under `src/`
- **No** `in-progress` / `in-review` / `ship` / `stable`
- **No** checking off checklist boxes

Then run the Plan Review loop. Do not interpret “ship” here as `update_node_status` → `ship`.

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
