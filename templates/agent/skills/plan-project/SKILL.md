---
name: mindplan-plan-project
description: >-
  Plan-only MindPlan sessions: model or restructure the product graph (Journeys,
  Foundations, Interactions, Interfaces, Bugs, edges, territory) without writing
  application code. Use when the user wants to plan, architect, greenfield the
  product model, map capabilities, or reshape the mindplan — not implement
  features.
---

# Plan a MindPlan Project (no code)

Use this skill when the session’s job is **only** to create or reshape MindPlan territory. Application code (files claimed via `implements` / `set_implementation_files`) is out of scope until a later execution session under `mindplan/agent/playbook.md`.

Prerequisite: MindPlan MCP is registered. Normative reference: `SPEC.md`. Entity create/link details: `mindplan/agent/skills/define-entities/SKILL.md`. Always-on execution process (build pipeline, bugs, shipping): `mindplan/agent/playbook.md`.

## When to use

| User intent | Use this skill? |
|-------------|-----------------|
| “Let’s plan / model / map the product” | Yes |
| Greenfield: define Journeys → draft Interactions → Interfaces → derive Foundations | Yes |
| Restructure edges, enrich PRDs, rewrite Atomic Ops | Yes |
| “Implement / build / fix / ship this Interaction” | No — playbook build or Bug loop |
| Mixed “plan then code” in one ask | Plan first with this skill; **stop** and confirm before any implementation session |

## Hard rules (plan-only)

- **No application code** — do not create, edit, or delete implementation files claimed by nodes. Plan-only means graph/territory only (including `set_implementation_files` only when declaring intended boundaries for Plan Review — prefer leaving that to the build session unless the user asks).
- **No implementation pipeline** — do not move Foundations/Interactions/Interfaces to `in-progress`, `in-review`, or `ship`. Do not move Bugs to `fixing` / `in-review` / `resolved`.
- **Allowed states** — leave new or reshaped nodes in `draft`. When the user wants the plan “shipped” / build-ready, finish links, PRD, and unchecked Atomic Ops at `draft`, then run the **Plan Review loop** (spawn Reviewer via `review-work`) until `ready` or escalate. Do not self-advance to `ready`. See **Shipping a plan** below.
- **Never check off Atomic Ops** as done — checkboxes stay open until real implementation completes in an execution session.
- Mutate graph state only through MindPlan MCP. Treat every `Blocked: <reason>` as a hard failure — fix the plan, do not retry blindly.
- **Interaction Independence** — never model Interaction → Interaction `depends_on`; use Foundations for shared state and `leads_to` for navigation.

## Session loop

### 1. Orient

```
orient_for_work({ query: "<user ask>" })
```

For empty or unknown graphs, also call `get_mindplan_graph` once. Prefer `export_mindplan_view` when the user wants a diagram.

### 2. Classify scope

Decide what the plan session must produce: new Journeys, Foundations (with roles), Interactions, Interfaces, Bugs, edge rewires (`belongs_to` / `depends_on` / `exposes` / `leads_to` / `affects`), territory enrichment, or `open_next` drafts for shipped nodes (territory/spec only — still no code).

### 3. Define and link entities

Follow `mindplan/agent/skills/define-entities/`:

1. Journeys first (refuse Interactions with no matching Journey)
2. Interactions at `draft` (behavior / PRD thinking; links not required yet)
3. Interfaces that will `exposes` those Interactions
4. Foundations derived from those drafts (role tags in `description`)
5. Link: Interaction `belongs_to` + Foundation `depends_on`; Interface `exposes` (+ optional Foundation deps); `leads_to` for navigation
6. Bugs with `affects` only when filing defects into the plan (stay at `open` or `triaged` — do not `fixing`)

Greenfield order:

```
Journey(s) → Interaction(s) at draft → Interface(s) → Foundation(s) derived from those drafts → link_nodes → enrich territory → Plan Review Foundations → Plan Review Interactions → Plan Review Interfaces → ready (then stop if plan-only)
```

Gate facts: Journey before any Interaction create; draft Interactions may lack links until leaving `draft`; Interfaces need `exposes` before leaving `draft`; Foundation `ready` before Interaction `ready` is preference — Infrastructure First at Interaction `ship` still requires Foundations `stable`; Behavior First at Interface `ship` requires exposed Interactions `stable`.

### 4. Enrich territory (full contracts)

Prefer host file tools on `current_path` / `next_path` for body / title / description (so humans see native diffs). `patch_node_territory` is an optional fallback. Replace scaffold stubs with real Purpose, Actor & Trigger / Kind / PRD / Shared Substrate Spec, Acceptance Criteria, and **unchecked** PR-sized Atomic Ops.

Apply **package ownership** (SPEC §1.2.2) while enriching:

- Interaction PRDs: when a Page/UI Interface will `exposes` this behavior, include a mount/view surface. When Kind is CLI/MCP/Webhook/Cron, name the exportable handler/module — not a `*-view.tsx`.
- Interface Spec: “App Router (or CLI/MCP) mounts Interaction packages; Interface does not own core domain logic or screen bodies.” Do not write territory that implies screen bodies live under `interfaces/…/ui/` or `screens/`.
- One Interface per actor surface, not one Interface per screen/tab.
- Keep Interaction/Interface Atomic Ops templates from `define-entities`.

Territory Completeness still applies: bodies describe the full intended contract, not a changelog. For shipped nodes, call `get_blast_radius` then `open_next` before changing live scope; edit the `next` slot into a complete proposed successor — still without implementing code or advancing `next` past `draft` (Plan Review owns `draft` → `ready`).

### 5. Validate after every mutation

After each `create_node`, `link_nodes`, `unlink_nodes`, `open_next`, `discard_next`, or `update_node_status` (and after material prose edits):

1. Re-read focus via `find_related_nodes` / `get_node_context` (full `get_mindplan_graph` after multi-node restructuring)
2. Confirm ids, states (including `next.state`), and edges match intent; surface `changed_files` from graph tools when narrating MCP writes
3. Confirm the visualization with `export_mindplan_view` or a fresh neighborhood read
4. On `Blocked:` or mismatch — stop and fix; do not continue

### 6. Plan Review loop, then stop

When the graph matches the user’s product model and territory is a full contract (not stubs), with nodes at `draft` (or Bugs at `open` / `triaged`):

1. For each Foundation/Interaction/Interface that should leave `draft`, run the **Plan Review loop** (playbook): spawn a fresh Reviewer (`review-work` Procedure A); fix from Findings in the verdict message; re-spawn up to 3 rejects; escalate to the human if still blocked. Prefer Plan Review on Foundations **before** their dependent Interactions, and Interactions **before** Interfaces that expose them.
2. Do **not** self-call `update_node_status → ready`.
3. After MCP confirms `ready`, **stop** if this is still a plan-only session. A later **execution session** runs `in-progress` → implement → Implementation review loop. Do not start implementation unless the user explicitly switches modes.
4. Show or offer `export_mindplan_view` so humans can review the map.

## Shipping a plan (Plan Review loop → ready)

When the user says **“ship the plan”**, **“ship it”** (in a plan-only session), or otherwise wants the modeled graph build-ready — that means finish at `draft` and run the Plan Review loop until `ready` (or escalate), not self-advance to `ready`, and not the build-pipeline `ship` transition.

Requirements before spawning Plan Review:

- Links complete (Interactions: at least one `belongs_to` + one Foundation `depends_on`; Interfaces: at least one `exposes`; Bugs past `open`: `affects`)
- Territory is a full contract with **unchecked** Atomic Ops
- Nodes remain at `draft` until the Reviewer advances them — do not call `update_node_status` → `ready` yourself
- **No** application code under `src/`
- **No** `in-progress` / `in-review` / `ship` / `stable`
- **No** checking off checklist boxes
- **No** Interaction→Interaction `depends_on`

Then run the Plan Review loop. Do not interpret “ship” here as `update_node_status` → `ship`.

## Never do (this skill)

- Write or “just scaffold” real implementation in `src/interactions/` / `src/interfaces/` / `src/foundations/`
- Advance to `ready` / `in-progress` / `in-review` / `ship`, or Bug `fixing` / `resolved`
- Treat “ship the plan” as build-pipeline `ship` / `stable`, as self-advance to `ready`, or as permission to check Atomic Ops
- Check off Atomic Ops without implementation
- Create an Interaction with no matching Journey
- Link Interaction → Interaction with `depends_on`
- Write Interface territory as if it owns feature screen bodies, or mint one Interface per screen/tab
- Omit mount/view (Page/UI) or handler/module (CLI/MCP/Webhook/Cron) from Interaction PRDs that an Interface will expose
- Hand-edit server-owned frontmatter (`state`, timestamps, edge arrays)
- Set Journey, `stable`, or `unstable` manually
- Treat `mindplan/map.md` as graph authority
- Skip post-mutation validation
