---
name: mindplan-define-entities
description: >-
  Defines MindPlan SDLC entities (Journey, Foundation, Workflow, Bug) via MCP —
  taxonomy selection, ID naming, edge linking, and context.mdx territory.
  Journey MUST exist before Workflow; refuses Workflow creation when no matching
  Journey is in the graph. Use when creating planning nodes, scaffolding features,
  mapping user flows, adding infrastructure tickets, filing bugs, or structuring
  a MindPlan graph.
---

# Define MindPlan Entities

Use this skill when adding or restructuring nodes in `mindplan/`. All graph mutations go through the **MindPlan MCP server** — never edit `mindplan.json` directly.

Prerequisite: MindPlan MCP is registered and `get_mindplan_graph` works. Normative reference: `SPEC.md`.

## Step 1 — Orient

```
get_mindplan_graph
```

Note existing Journeys, Foundations, Workflows, Bugs, and edges before creating duplicates.

## Journey first (mandatory)

**A Journey MUST exist before any Workflow is created. A Workflow may belong to **one or more** Journeys.**

When the user asks for a Workflow (feature, business logic, end-user capability):

1. Run `get_mindplan_graph` and inspect existing Journeys
2. Decide whether the request maps to an **existing** Journey (by title, description, or user-stated parent Journey id)
3. If **no** matching Journey exists → **stop and refuse**. Do **not** call `create_node` for the Workflow. Do **not** silently create a Journey on the user's behalf unless they explicitly ask to define one

**Refusal message** (use verbatim):

> I cannot define this Workflow yet — every Workflow must belong to a Journey, and no matching Journey exists in the graph. Please define the Journey first (the macro user capability this feature belongs to). Once the Journey exists, I can create the Workflow and link it with `belongs_to`.

If the user names a Journey that is not in the graph, same refusal — define that Journey first.

**Allowed without a Journey:** Foundation and Bug creation (Bugs link via `affects`, not `belongs_to`).

## Step 2 — Pick the entity type

| If the work is… | Type | Why |
|-----------------|------|-----|
| A macro user capability or product surface (e.g. "Table ordering") | **Journey** | Permanent container; state is computed from Workflows |
| Pure infrastructure with no direct user value (DB schema, auth, API client) | **Foundation** | Consumed by Workflows; must ship before dependents |
| A feature or business-logic unit users interact with | **Workflow** | Execution work; must link to at least one Journey + at least one Foundation |
| A defect on shipped or in-flight infra/feature work | **Bug** | Dedicated lifecycle; links via `affects` only |

**Decision checks:**
- Does it execute business logic for users? → Workflow (not Foundation)
- Is it only plumbing other features need? → Foundation (not Workflow)
- Is it a container grouping features? → Journey (never executes code)
- Is it broken behaviour on an existing node? → Bug

## Step 3 — Name the node

Pattern: `^[a-z0-9][a-z0-9-_]*$` (globally unique across all types).

| Type | Prefix | Example |
|------|--------|---------|
| Journey | `j-` | `j-ordering` |
| Foundation | `f-` | `f-db-core` |
| Workflow | `wf-` | `wf-checkout-split` |
| Bug | `bug-` | `bug-double-charge` |

**Title:** short human-readable name. **Description:** one sentence for the Map entry.

## Step 4 — Create via MCP

**Workflow gate:** only call `create_node` for a Workflow after confirming a matching Journey exists (see Journey first above).

```
create_node({ id, type, title, description })
```

Server scaffolds `mindplan/<type>s/<id>/context.mdx` and `attachments/`. Initial states: `draft` (build entities), `open` (Bug).

## Step 5 — Link edges (before advancing state)

| Type | Required links | MCP call |
|------|----------------|----------|
| **Workflow** | `belongs_to` → one or more Journeys, `depends_on` → Foundation | `link_nodes` per Journey + per Foundation |
| **Foundation** | optional `depends_on` → other Foundation | `link_nodes` if layered |
| **Bug** | `affects` → Workflow or Foundation (before `triaged`) | `link_nodes` |
| **Journey** | none (Workflows link to it) | — |

Multiple `belongs_to` edges from the same Workflow are allowed — shared features can span Journeys.

```
link_nodes({ source_id, target_id, edge_type })
```

Illegal shapes are rejected — see agent rule for the full edge taxonomy.

## Step 6 — Enrich territory (`context.mdx` body)

Edit the **body only** — never frontmatter `state:`. Replace scaffold placeholders with real content.

### Journey

- **Overview** — macro user flow this Journey covers
- **Linked Workflows** — note which Workflows will `belongs_to` here
- No checklist (Journeys have no completion gate)

### Foundation

- **Infrastructure Spec** — schemas, contracts, integrations
- **Checklist** — PR-sized Atomic Ops (`- [ ]` / `- [x]`):
  - Spec written
  - Implementation complete
  - Verified in target environment

### Workflow

- **Execution Logic** — step-by-step feature behaviour
- **Checklist** — Atomic Ops, e.g.:
  - Requirements defined
  - Implementation complete
  - Tests passing

### Bug

- **Summary** — one-line defect description
- **Repro Steps** — numbered reproduction
- **Expected / Actual** — behaviour contrast
- **Fix Checklist** — root cause, fix, regression test

Use `- [ ]` syntax for gates — unchecked boxes block `in-review`, `ship`, and Bug `in-review`/`resolved`.

## Step 7 — Verify graph

```
get_mindplan_graph
get_node_context({ node_id })
```

Confirm edges, folder paths, and territory content before moving to `ready` or beyond.

## Definition order (greenfield project)

```
1. create_node Journey          ← always first; required before any Workflow
2. create_node Foundation(s)
3. create_node Workflow(s)      ← only after step 1; link with belongs_to (repeat per Journey)
4. link_nodes Workflow → Journey (belongs_to)   ← once per Journey; multiple allowed
5. link_nodes Workflow → Foundation (depends_on)
6. Enrich all context.mdx bodies
7. update_node_status when gates pass (Workflows: ready only after both links)
```

Ship order: Foundations → `stable` before Workflow `ship`.

## Common mistakes

| Mistake | Result |
|---------|--------|
| Create Workflow with no Journey in graph | **Refuse** — ask user to define the Journey first |
| Workflow → `ready` without links | `Blocked: Ghost Workflow` |
| Bug → `triaged` without `affects` | `Blocked: Ghost Bug` |
| Foundation described as a user feature | Scope creep — split into Foundation + Workflow |
| Business logic in a Foundation node | Wrong taxonomy — move logic to Workflow |
| Manual Journey / `stable` / `unstable` status | Rejected — computed only |
| Editing `mindplan.json` by hand | Out of contract — use MCP tools |

## Examples

See [examples.md](examples.md) for full greenfield and bug-filing walkthroughs.
