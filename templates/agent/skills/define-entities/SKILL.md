---
name: mindplan-define-entities
description: >-
  Defines MindPlan SDLC entities (Journey, Foundation, Workflow, Bug) via MCP —
  taxonomy selection, Foundation roles (Assembler/Infra/Design system/Adapter),
  ID naming, edge linking, and current.mdx territory. Journey MUST exist before
  Workflow; refuses Workflow creation when no matching Journey is in the graph.
  Use when creating planning nodes, scaffolding features, mapping domain
  capabilities and use cases, adding shared substrate (assembler/infra/design
  system/adapters), filing bugs, or structuring a MindPlan graph.
---

# Define MindPlan Entities

Use this skill when adding or restructuring nodes in `mindplan/`. All graph mutations go through the **MindPlan MCP server** — never edit server-owned frontmatter fields directly.

Prerequisite: MindPlan MCP is registered and `get_mindplan_graph` works. Normative reference: `SPEC.md`. For executing work through the build pipeline and Bug lifecycle (always-on process), follow `mindplan/agent/playbook.md`. For plan-only sessions that must not write application code, follow `mindplan/agent/skills/plan-project/SKILL.md` (it calls this skill for create/link steps).

## Step 1 — Orient

```
get_mindplan_graph
```

Note existing Journeys, Foundations, Workflows, Bugs, and edges before creating duplicates.

## Journey first (mandatory)

**A Journey MUST exist before any Workflow is created. A Workflow may belong to **one or more** Journeys.**

When the user asks for a Workflow (use case, feature, shared screen with its own behaviour):

1. Run `get_mindplan_graph` and inspect existing Journeys
2. Decide whether the request maps to an **existing** Journey (by title, description, or user-stated parent Journey id)
3. If **no** matching Journey exists → **stop and refuse**. Do **not** call `create_node` for the Workflow. Do **not** silently create a Journey on the user's behalf unless they explicitly ask to define one

**Refusal message** (use verbatim):

> I cannot define this Workflow yet — every Workflow must belong to a Journey, and no matching Journey exists in the graph. Please define the Journey first (the domain capability this use case belongs to). Once the Journey exists, I can create the Workflow and link it with `belongs_to`.

If the user names a Journey that is not in the graph, same refusal — define that Journey first.

**Allowed without a Journey:** Foundation and Bug creation (Bugs link via `affects`, not `belongs_to`).

## Step 2 — Pick the entity type

| If the work is… | Type | Why |
|-----------------|------|-----|
| A domain capability the product is about (e.g. "Table ordering", "Billing") | **Journey** | Architecture scream; permanent use-case container; state computed from Workflows |
| Shared substrate with no standalone use case (assembler, DB, auth, design system, adapters) | **Foundation** | Pick a role (§ below); consumed via `depends_on`; must ship before dependent Workflows |
| A stakeholder-recognizable use case / screen (e.g. "Split & pay", "User picker", "Character editor") | **Workflow** | Execution work; `belongs_to` one or more Journeys; `depends_on` Foundations and optionally other Workflows |
| A defect on shipped or in-flight substrate/use-case work | **Bug** | Dedicated lifecycle; links via `affects` only |

**Classification litmus** (in order):
1. Domain capability the product *is about*? → Journey
2. Stakeholder-recognizable use case / screen with its own behaviour (even if many features embed it)? → Workflow
3. Shared code/UI with **no** standalone use case, only consumed by use cases? → Foundation (then pick a **role**)
4. Broken behaviour on an existing node? → Bug

**Foundation roles** (docs convention — not NodeTypes). After classifying as Foundation, pick one:

| Role | When | Description tag example |
|------|------|-------------------------|
| **Assembler** | External framework/runtime that mounts Workflow packages into a deployable surface | `"Assembler — Next.js app shell mounting workflow packages"` |
| **Adapter** | Vendor/protocol boundary SDK only | `"Adapter — Stripe SDK wrapper"` |
| **Design system** | Tokens + dumb presentational UI | `"Design system — tokens and Button/Input primitives"` |
| **Infra** | Persistence, messaging, storage, observability, homegrown auth | `"Infra — Postgres schema and migrations"` |

Role litmus: Assembler → Adapter → Design system → otherwise Infra. Auth is Infra unless it is a vendor adapter (`f-clerk` → Adapter). Keep tokens and UI kit as Design system (one role).

**Assembler linking:** Workflows that run on a given backbone SHOULD `depends_on` that Assembler Foundation (e.g. UI workflows → `f-nextjs`; cron workflows → `f-vercel-cron`). This is guidance, not a compiler gate — Ghost Workflows still only require any Foundation `depends_on`. A Journey's assembler(s) are derived from member Workflows' `depends_on` — never give Journeys outgoing edges. Different Journeys MAY use different assemblers.

**Reuse rule:** Before inventing shared UI or a shared screen inside a Workflow, find or create the right Foundation (substrate) or Workflow (use case) and link `depends_on`. Membership across Journeys uses multiple `belongs_to` edges — not a new node.

**Anti-patterns:**
- Journey named after tech (`API`, `Frontend`, `Database`) — wrong; use domain language
- Primary button / design tokens as a Workflow — wrong; that is Foundation (Design system)
- Next.js / cron runtime as a Journey — wrong; that is Foundation (Assembler)
- Character editor / user-picker flow as a Foundation — wrong; that is Workflow (reuse via `depends_on` / multi-Journey `belongs_to`)
- Business use-case behaviour living only in a Foundation — move it to a Workflow

## Step 3 — Name the node

Pattern: `^[a-z0-9][a-z0-9-_]*$` (globally unique across all types).

| Type | Prefix | Example |
|------|--------|---------|
| Journey | `j-` | `j-ordering` |
| Foundation | `f-` | `f-db-core`, `f-nextjs` |
| Workflow | `wf-` | `wf-checkout-split` |
| Bug | `bug-` | `bug-double-charge` |

**Title:** short human-readable name. **Description:** one sentence. For Foundations, agents SHOULD lead with the role tag (`"Assembler — …"`, `"Infra — …"`, `"Design system — …"`, `"Adapter — …"`). Both are written to `current.mdx` frontmatter at creation. Change them afterward with host file tools on `current_path` / `next_path` (preferred) or `patch_node_territory({ node_id, title?, description? })` as a fallback. For a shipped Workflow or Foundation, call `open_next` first — then edit the `next` slot.

## Step 4 — Create via MCP

**Workflow gate:** only call `create_node` for a Workflow after confirming a matching Journey exists (see Journey first above).

```
create_node({ id, type, title, description })
```

Server scaffolds `mindplan/<type>s/<id>/current.mdx` with the node record in frontmatter (`id`, `type`, `title`, `description`, `state`, timestamps). For **Workflow** and **Foundation**, when `implementation_packages` is `required` (default), also scaffolds the prescribed implementation package: `src/workflows/<id>/` or `src/foundations/<id>/` (with `.gitkeep`). When `implementation_packages` is `off` (layout-free / `mindplan-mcp init --layout free`), only territory is created — no `src/` package. Journeys and Bugs have no code package. Edge arrays are added by `link_nodes`. This id is permanent — Foundations and Workflows never get a new id later; they evolve in place via `open_next`/`next.mdx` (see "Evolving a shipped node" below).

Query the package with `get_node_implementation({ node_id })` (`root` is null when packages are off). When packages are `required`, implement **only** inside that package; reuse across use cases via Foundation packages or `depends_on` Workflow packages. When packages are `off`, implement in the project's existing layout.

## Step 5 — Link edges (before advancing state)

| Type | Required links | MCP call |
|------|----------------|----------|
| **Workflow** | `belongs_to` → one or more Journeys, `depends_on` → Foundation or Workflow | `link_nodes` per Journey + per dependency |
| **Foundation** | optional `depends_on` → other Foundation | `link_nodes` if layered |
| **Bug** | `affects` → Workflow or Foundation (before `triaged`) | `link_nodes` |
| **Journey** | none (Workflows link to it) | — |

Multiple `belongs_to` edges from the same Workflow are allowed — membership reuse across Journeys.

Composition reuse: a Workflow MAY `depends_on` another Workflow (shared use case) or a Foundation (shared substrate). When a Workflow `depends_on` another Workflow, every dependency in the transitive chain must also `belongs_to` the same Journey. If not, `link_nodes(belongs_to)` is rejected unless you pass `link_dependent: true`, which auto-links the missing dependency Workflows to that Journey.

```
link_nodes({ source_id, target_id, edge_type })
```

Illegal shapes are rejected — see `mindplan/agent/playbook.md` for the full edge taxonomy.

## Step 6 — Enrich territory (file tools preferred)

Prefer **host file tools** for body, title, and description at `current_path` / `next_path` from orientation (so the host “changed files” UI shows the edit). Use `patch_node_territory` only as a fallback (automation / weak file tools). Never edit frontmatter `state:`, timestamps, or edge arrays by hand.

```
# Preferred: edit MDX body below --- and title/description scalars via Write/StrReplace
patch_node_territory({ node_id, body: "…" })                    // fallback — replace body
patch_node_territory({ node_id, title?, description? })         // fallback — territory scalars
patch_node_territory({ node_id, toggle_checkboxes: [...] })     // fallback — check off Atomic Ops
```

Replace scaffold placeholders with real content. Section guidance:

### Journey

- **Overview** — domain capability this Journey owns and which use cases belong inside it (Journey titles alone should scream the product purpose)
- **Linked Workflows** — note which Workflows will `belongs_to` here
- No checklist (Journeys have no completion gate)

### Foundation

- **Shared Substrate Spec** — schemas, adapters, design system, contracts (not use-case behaviour). Put the role tag in frontmatter `description` at create time, not here.
- **Implementation** — code under `src/foundations/<id>/` only
- **Checklist** — PR-sized Atomic Ops (`- [ ]` / `- [x]`):
  - Spec written
  - Implementation complete
  - Verified in target environment

### Workflow

- **Execution Logic** — step-by-step use-case behaviour
- **Implementation** — code under `src/workflows/<id>/` only (no Journey-owned folders — Workflows may belong to many Journeys)
- **Checklist** — Atomic Ops, e.g.:
  - Requirements defined
  - Implementation complete
  - Tests passing

### Bug

- **Summary** — one-line defect description
- **Repro Steps** — numbered reproduction
- **Expected / Actual** — behaviour contrast
- **Fix Checklist** — root cause, fix, regression test

Use `- [ ]` syntax for gates — unchecked boxes block `in-review`, `ship`, and Bug `in-review`/`resolved`. Attachments still use normal file tools under `attachments/` (or `next-attachments/` while evolving).

## Step 7 — Verify graph

```
get_mindplan_graph
get_node_context({ node_id })
```

Confirm edges, folder paths, and territory content. Leave Foundations/Workflows at `draft` until Plan Review. When a node is about to leave `draft`, run one Plan Review loop for **that** node (spawn Reviewer via `review-work`) — do not self-advance to `ready`, and do not batch-rubber-stamp multiple nodes in one Reviewer pass.

## Definition order (greenfield project)

```
1. create_node Journey          ← always first; required before any Workflow
2. create_node Foundation(s)
3. create_node Workflow(s)      ← only after step 1; link with belongs_to (repeat per Journey)
4. link_nodes Workflow → Journey (belongs_to)   ← once per Journey; multiple allowed
5. link_nodes Workflow → Foundation (depends_on)
6. Edit each node body (and title/description if needed) via file tools at `current_path` / `next_path`
7. Stop at `draft` with links + territory complete; run Plan Review loop per
   node (`mindplan/agent/skills/review-work/`) — Reviewer advances to `ready`
```

Ship order: Foundations → `stable` before Workflow `ship`. Plan Review owns `draft → ready`.

## Evolving a shipped node

Foundations and Workflows keep one id forever — there is no `-v2` node. When a shipped Workflow or Foundation needs a change:

```
get_blast_radius({ node_id: "wf-checkout-split" })   // find dependents first
open_next({
  node_id: "wf-checkout-split",
  title: "Split & pay checkout v2",              // optional
  description: "Revised checkout with new split rules"  // optional
})
```

`open_next` writes `next.mdx` next to `current.mdx` on the **same** node: `draft` state, seeded with the current body and inherited outgoing `belongs_to`/`depends_on`. The live node keeps serving unchanged under `current.mdx` — dependents still see the live record. Enrich the `next` slot to a full successor contract, then run the Plan Review loop (`mindplan/agent/skills/review-work/`) — do not self-advance `next` to `ready`. After Plan Review, an execution session runs `in-progress` → `in-review`; Implementation review loop then `ship`s, which promotes `next.mdx` over `current.mdx` (title, description, body, edges), deletes `next.mdx`, and recomputes `stable`/`unstable` — same id throughout. `discard_next` abandons the evolution at any point without touching `current.mdx`. Only one `next.mdx` may be open at a time.

## Common mistakes

| Mistake | Result |
|---------|--------|
| Create Workflow with no Journey in graph | **Refuse** — ask user to define the Journey first |
| Workflow → `ready` without links | `Blocked: Ghost Workflow` |
| Workflow → Journey with unlinked workflow dependencies | `Blocked: Dependency Closure` — link dependents first or use `link_dependent: true` |
| Bug → `triaged` without `affects` | `Blocked: Ghost Bug` |
| Foundation described as a user feature / use case | Scope creep — split into Foundation (substrate) + Workflow (use case) |
| Business use-case behaviour in a Foundation node | Wrong taxonomy — move logic to Workflow; keep design system / infra as Foundation |
| Inventing a new primary button inside a Workflow | Reuse — depend on `f-design-system` (or create that Foundation first) |
| Implementing Workflow code outside `src/workflows/<id>/` when packages are `required` | Wrong architecture — use the prescribed package (query via `get_node_implementation`); layout-free/`off` projects use the existing app layout |
| Manual Journey / `stable` / `unstable` status | Rejected — computed only |
| Editing edge arrays or server-owned frontmatter by hand | Out of contract — use MCP tools |
| `open_next` on an unshipped node | `Blocked` — only `stable`/`unstable` can open a next evolution |
| `open_next` while a `next.mdx` is already open | `Blocked` — `discard_next` or ship it first |

## Examples

See [examples.md](examples.md) for full greenfield and bug-filing walkthroughs.
