---
name: mindplan-define-entities
description: >-
  Defines MindPlan SDLC entities (Journey, Foundation, Interaction, Interface,
  Bug) via MCP — taxonomy selection, Foundation roles (Assembler/Infra/Design
  system/Adapter), ID naming, edge linking (belongs_to, depends_on, exposes,
  leads_to, affects), and current.mdx territory. Journey MUST exist before
  Interaction; refuses Interaction creation when no matching Journey is in the
  graph. Use when creating planning nodes, scaffolding behavior and surfaces,
  mapping domain capabilities, adding shared substrate, filing bugs, or
  structuring a MindPlan graph.
---

# Define MindPlan Entities

Use this skill when adding or restructuring nodes in `mindplan/`. All graph mutations go through the **MindPlan MCP server** — never edit server-owned frontmatter fields directly.

Prerequisite: MindPlan MCP is registered and `get_mindplan_graph` works. Normative reference: `SPEC.md`. For executing work through the build pipeline and Bug lifecycle (always-on process), follow `mindplan/agent/playbook.md`. For plan-only sessions that must not write application code, follow `mindplan/agent/skills/plan-project/SKILL.md` (it calls this skill for create/link steps).

## Step 1 — Orient

```
get_mindplan_graph
```

Note existing Journeys, Foundations, Interactions, Interfaces, Bugs, and edges before creating duplicates.

## Journey first (mandatory)

**A Journey MUST exist before any Interaction is created. An Interaction may belong to **one or more** Journeys.**

When the user asks for an Interaction (behavior, use case, actor-triggered flow — **not** a UI page by itself):

1. Run `get_mindplan_graph` and inspect existing Journeys
2. Decide whether the request maps to an **existing** Journey (by title, description, or user-stated parent Journey id)
3. If **no** matching Journey exists → **stop and refuse**. Do **not** call `create_node` for the Interaction. Do **not** silently create a Journey on the user's behalf unless they explicitly ask to define one

**Refusal message** (use verbatim):

> I cannot define this Interaction yet — every Interaction must belong to a Journey, and no matching Journey exists in the graph. Please define the Journey first (the domain capability this behavior belongs to). Once the Journey exists, I can create the Interaction and link it with `belongs_to`.

If the user names a Journey that is not in the graph, same refusal — define that Journey first.

**Allowed without a Journey:** Foundation, Interface, and Bug creation (Interfaces link via `exposes`; Bugs via `affects`). Prefer defining the Interaction before its Interface so `exposes` has a target.

## Step 2 — Pick the entity type

| If the work is… | Type | Why |
|-----------------|------|-----|
| A domain capability the product is about (e.g. "Table ordering", "Billing") | **Journey** | Architecture scream; permanent container; state computed from Interactions |
| Shared substrate with no standalone behavior (assembler, DB, auth, design system, adapters) | **Foundation** | Pick a role (§ below); consumed via `depends_on`; must ship before dependent Interactions |
| Self-contained **behavior** by any actor — human, system, or agent — independent of how it is surfaced (e.g. "Split & pay", "Orient on plan", "Check integrity") | **Interaction** | Behavior unit; `belongs_to` Journeys; `depends_on` Foundations only; MAY `leads_to` other Interactions |
| A **surface** that exposes Interactions — Page, CLI, MCP toolset, Webhook, Cron, script (e.g. "Checkout page", "mindplan-mcp CLI", "MCP tools") | **Interface** | Exposure unit; `exposes` Interactions; optional Foundation `depends_on` |
| A defect on shipped or in-flight substrate/behavior/surface | **Bug** | Dedicated lifecycle; links via `affects` only |

**Classification litmus** (in order):
1. Domain capability the product *is about*? → Journey
2. Self-contained behavior (what happens), reusable across surfaces? → Interaction (**not** UI)
3. How that behavior is reached (page/CLI/MCP/cron/…)? → Interface
4. Shared code/UI substrate with **no** standalone behavior, only consumed? → Foundation (then pick a **role**)
5. Broken behaviour on an existing node? → Bug

**Do not** model a screen/page as an Interaction. The page is an Interface that `exposes` one or more Interactions. The Interaction still owns the **screen body** (domain + mountable view) when Kind is Page; the Interface only mounts it. Do not invent one Interface per screen/tab.

**File ownership** (playbook + SPEC §1.2.2) — declare with `set_implementation_files`:

| Owner | Owns | Must not own |
| --- | --- | --- |
| Interaction | Domain/view-model, exportable surface (UI: `*-view`; CLI/MCP: handler) | App routing, device/staff shell chrome, cross-Interaction nav |
| Interface | Routes/entry, providers, guards, thin mounts, shared shell, nav callbacks | Feature screen bodies and domain rules |
| Foundation | Shared substrate (store, tokens, dumb primitives) | Journey-specific screen flows |

Interactions MUST NOT import Interface-owned files (import matrix). Foundations use server-owned `role`: assembler | infra | design-system | adapter (`create_node` requires it).

**Foundation roles.** After classifying as Foundation, pick one:

| Role | When | Description tag example |
|------|------|-------------------------|
| **Assembler** | External framework/runtime that **composes** Journeys, Interactions, Interfaces, and Foundations into a deployable surface | `"Assembler — Next.js app shell composing interactions and interfaces"` |
| **Adapter** | Vendor/protocol boundary SDK only | `"Adapter — Stripe SDK wrapper"` |
| **Design system** | Tokens + dumb presentational UI | `"Design system — tokens and Button/Input primitives"` |
| **Infra** | Persistence, messaging, storage, observability, homegrown auth | `"Infra — Postgres schema and migrations"` |

Role litmus: Assembler → Adapter → Design system → otherwise Infra. Auth is Infra unless it is a vendor adapter (`f-clerk` → Adapter). Keep tokens and UI kit as Design system (one role).

**Assembler linking:** Interactions/Interfaces that run on a given backbone SHOULD `depends_on` that Assembler Foundation (e.g. page Interfaces → `f-nextjs`; cron Interfaces → `f-vercel-cron`). This is guidance, not a compiler gate — Ghost Interactions still only require any Foundation `depends_on`. A Journey's assembler(s) are derived from member Interactions' and Interfaces' `depends_on` — never give Journeys outgoing edges. Different Journeys MAY use different assemblers. Assemblers may import Interfaces/Interactions that depend_on them.

**Reuse rule:** Before inventing shared UI or shared state inside an Interaction, find or create the right Foundation and link `depends_on`. Membership across Journeys uses multiple `belongs_to` edges — not a new node. Cross-Interaction flow uses `leads_to`, never `depends_on` (Interaction Independence).

**Anti-patterns:**
- Journey named after tech (`API`, `Frontend`, `Database`) — wrong; use domain language
- Primary button / design tokens as an Interaction — wrong; that is Foundation (Design system)
- Next.js / cron runtime as a Journey — wrong; that is Foundation (Assembler)
- A checkout **page** as an Interaction — wrong; that is Interface (`if-…`); the pay/split **behavior** (including the screen body) is the Interaction
- One Interface per POS tab/screen — wrong; one surface `exposes` many Interactions and mounts each package
- Fat UI screens inside `src/interfaces/<id>/screens/` with Interactions as thin store wrappers — inverted; move the body to the Interaction
- Character editor / user-picker **behavior** as a Foundation — wrong; that is Interaction
- Interaction → Interaction `depends_on` — illegal; share via Foundation or navigate via `leads_to`
- Business behavior living only in a Foundation — move it to an Interaction

## Step 3 — Name the node

Pattern: `^[a-z0-9][a-z0-9-_]*$` (globally unique across all types).

| Type | Prefix | Example |
|------|--------|---------|
| Journey | `j-` | `j-ordering` |
| Foundation | `f-` | `f-db-core`, `f-nextjs` |
| Interaction | `i-` | `i-checkout-split` |
| Interface | `if-` | `if-checkout-page`, `if-mcp-tools`, `if-cli` |
| Bug | `bug-` | `bug-double-charge` |

**Title:** short human-readable name. **Description:** one sentence. For Foundations, agents SHOULD lead with the role tag (`"Assembler — …"`, `"Infra — …"`, `"Design system — …"`, `"Adapter — …"`). Both are written to `current.mdx` frontmatter at creation. Change them afterward with host file tools on `current_path` / `next_path` (preferred) or `patch_node_territory({ node_id, title?, description? })` as a fallback. For a shipped Interaction, Interface, or Foundation, call `open_next` first — then edit the `next` slot.

## Step 4 — Create via MCP

**Interaction gate:** only call `create_node` for an Interaction after confirming a matching Journey exists (see Journey first above).

```
create_node({ id, type, title, description })
```

Server scaffolds `mindplan/<type>s/<id>/current.mdx` with the node record in frontmatter (`id`, `type`, `title`, `description`, `state`, timestamps; Foundations also `role`). Does **not** scaffold `src/` packages — declare files later with `set_implementation_files`. Journeys and Bugs have no code ownership. Edge arrays are added by `link_nodes`. This id is permanent — Foundations, Interactions, and Interfaces never get a new id later; they evolve in place via `open_next`/`next.mdx` (see "Evolving a shipped node" below).

Query the package with `get_node_implementation({ node_id })` (`root` is null when packages are off). When packages are `required`, implement **only** inside that package; reuse across behaviors via Foundation packages. When packages are `off`, implement in the project's existing layout.

## Step 5 — Link edges (before advancing state)

| Type | Required links | MCP call |
|------|----------------|----------|
| **Interaction** | `belongs_to` → one or more Journeys; `depends_on` → Foundation(s) only | `link_nodes` per Journey + per Foundation |
| **Interface** | `exposes` → one or more Interactions; optional `depends_on` → Foundation | `link_nodes` |
| **Foundation** | optional `depends_on` → other Foundation | `link_nodes` if layered |
| **Bug** | `affects` → Interaction, Interface, or Foundation (before `triaged`) | `link_nodes` |
| **Journey** | none (Interactions link to it) | — |

Optional navigation:

```
link_nodes({ source_id: "i-orient-plan", target_id: "i-steer-plan", edge_type: "leads_to" })
```

`leads_to` is navigation only — not a ship gate and not a substitute for sharing state. Cycles are allowed.

Multiple `belongs_to` edges from the same Interaction are allowed — membership reuse across Journeys.

**Interaction Independence:** an Interaction MUST NOT `depends_on` another Interaction. The compiler rejects that shape. Share state through Foundations; model flow with `leads_to`.

There is **no** `link_dependent` parameter and **no** Dependency Closure rule.

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

- **Overview** — domain capability this Journey owns and which Interactions belong inside it (Journey titles alone should scream the product purpose)
- **Linked Interactions** — note which Interactions will `belongs_to` here
- No checklist (Journeys have no completion gate)

### Foundation

- **Shared Substrate Spec** — schemas, adapters, design system, contracts (not behavior). Put the role tag in frontmatter `description` at create time, not here.
- **Implementation** — code under `src/foundations/<id>/` only
- **Checklist** — PR-sized Atomic Ops (`- [ ]` / `- [x]`):
  - Spec written
  - Implementation complete
  - Verified in target environment

### Interaction

- **Purpose** — one-sentence behavior outcome
- **Actor & Trigger** — who/what starts it (human, system, agent, schedule)
- **Inputs & Outputs** — data in/out (not UI layout)
- **PRD / Execution Logic** — step-by-step behavior. When a Page/UI Interface will `exposes` this Interaction, name the **mountable view**. When Kind is CLI/MCP/Webhook/Cron, name the **exportable handler/module** (not a `*-view.tsx`).
- **Implementation** — code in files declared via `set_implementation_files` (domain + view/handler). MUST NOT import Interface-owned files.
- **Checklist** — Atomic Ops MUST include (Kind-gated):
  - Domain API against Foundations (no Interaction→Interaction `depends_on`)
  - Exportable behavior surface in this package (UI: mountable view; CLI/MCP/Webhook/Cron: handler/module)
  - Behavior surface does not import Interface packages (UI: view accepts shell/nav as props/callbacks)

### Interface

- **Kind** — Page | CLI | MCP | Webhook | Cron | Script | …
- **Exposed Interactions** — which Interactions this surface `exposes` and how (one surface, many Interactions — not one Interface per screen)
- **Spec** — routing, commands, tool names, schedules, auth boundaries of the surface. Boilerplate: **App Router (or CLI/MCP) mounts Interaction packages; Interface does not own core domain logic or screen bodies.**
- **Implementation** — code under `src/interfaces/<id>/` only. Thin mounts/wiring + shell chrome under `ui/` (Page). No duplicated domain/behavior UI.
- **Checklist** — Atomic Ops MUST include:
  - Thin wiring for each `exposes` target (Page: screen file wires Shell + guards + nav only; CLI/MCP/Webhook/Cron: command/tool/job calls the Interaction export only)
  - No duplicated domain logic / behavior UI that belongs in an exposed Interaction
  - Page/UI only: shell chrome under `ui/` only — not feature screen bodies

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

Confirm edges, folder paths, and territory content. Leave Foundations/Interactions/Interfaces at `draft` until Plan Review. When a node is about to leave `draft`, run one Plan Review loop for **that** node (spawn Reviewer via `review-work`) — do not self-advance to `ready`, and do not batch-rubber-stamp multiple nodes in one Reviewer pass.

## Definition order (greenfield project)

Behavior-first: draft Interactions so Foundations and Interfaces are derived from real behavior, not invented ahead of them.

```
1. create_node Journey              ← always first; required before any Interaction
2. create_node Interaction(s)       ← only after step 1; may stay at draft with no links yet
3. create_node Interface(s)         ← surfaces that will expose those Interactions
4. create_node Foundation(s)        ← derive from drafted Interaction PRDs; role-tag descriptions
5. link_nodes Interaction → Journey (belongs_to)
6. link_nodes Interaction → Foundation (depends_on)   ← Foundations only
7. link_nodes Interface → Interaction (exposes)
8. link_nodes Interface → Foundation (depends_on)     ← optional
9. link_nodes Interaction → Interaction (leads_to)    ← navigation only, as needed
10. Edit each node body (and title/description if needed) via file tools at `current_path` / `next_path`
11. Stop at `draft` with links + territory complete; run Plan Review loop per
    node (`mindplan/agent/skills/review-work/`) — Foundations first, then
    Interactions, then Interfaces — Reviewer advances to `ready`
```

Gate facts:

- Journey MUST exist before `create_node` for an Interaction (refusal rule above).
- An Interaction MAY sit at `draft` without links; `belongs_to` + Foundation `depends_on` are required only to leave `draft` (No Ghost Interactions).
- An Interface MAY sit at `draft` without links; ≥1 `exposes` is required to leave `draft` (No Ghost Interfaces).
- Foundation `ready` before Interaction `ready` is sequencing preference; Infrastructure First at Interaction `ship` still requires Foundations `stable`. Behavior First at Interface `ship` requires exposed Interactions `stable`.

Ship order: Foundations → `stable` before Interaction `ship`; Interactions → `stable` before Interface `ship`. Plan Review owns `draft → ready`.

## Evolving a shipped node

Foundations, Interactions, and Interfaces keep one id forever — there is no `-v2` node. When a shipped node needs a change:

```
get_blast_radius({ node_id: "i-checkout-split" })   // dependents + reachability first
open_next({
  node_id: "i-checkout-split",
  title: "Split & pay checkout v2",              // optional
  description: "Revised checkout with new split rules"  // optional
})
```

`open_next` writes `next.mdx` next to `current.mdx` on the **same** node: `draft` state, seeded with the current body and inherited outgoing `belongs_to`/`depends_on`/`exposes`/`leads_to`. The live node keeps serving unchanged under `current.mdx` — dependents still see the live record. Enrich the `next` slot to a full successor contract, then run the Plan Review loop (`mindplan/agent/skills/review-work/`) — do not self-advance `next` to `ready`. After Plan Review, an execution session runs `in-progress` → `in-review`; Implementation review loop then `ship`s, which promotes `next.mdx` over `current.mdx` (title, description, body, edges), deletes `next.mdx`, and recomputes `stable`/`unstable` — same id throughout. `discard_next` abandons the evolution at any point without touching `current.mdx`. Only one `next.mdx` may be open at a time.

## Common mistakes

| Mistake | Result |
|---------|--------|
| Create Interaction with no Journey in graph | **Refuse** — ask user to define the Journey first |
| Interaction → `ready` without links | `Blocked: Ghost Interaction` |
| Interface → `ready` without `exposes` | `Blocked: Ghost Interface` |
| Interaction → Interaction `depends_on` | `Blocked: Interaction Independence` — use Foundation or `leads_to` |
| Bug → `triaged` without `affects` | `Blocked: Ghost Bug` |
| Modeling a Page as an Interaction | Wrong taxonomy — Interface exposes Interaction(s); Interaction still owns the screen body |
| One Interface per screen/tab | Wrong — one surface exposes many Interactions; each route mounts the matching package |
| Fat screens in `src/interfaces/<id>/` | Inverted packages — move domain + view to the Interaction; Interface only mounts |
| Foundation described as user behavior | Scope creep — split into Foundation (substrate) + Interaction (behavior) |
| Business behavior in a Foundation node | Wrong taxonomy — move logic to Interaction |
| Inventing a new primary button inside an Interaction | Reuse — depend on `f-design-system` (or create that Foundation first) |
| Implementing Interaction code outside its `implements` claims | Wrong architecture — declare files with `set_implementation_files` and query via `get_node_implementation` |
| Manual Journey / `stable` / `unstable` status | Rejected — computed only |
| Editing edge arrays or server-owned frontmatter by hand | Out of contract — use MCP tools |
| `open_next` on an unshipped node | `Blocked` — only `stable`/`unstable` can open a next evolution |
| `open_next` while a `next.mdx` is already open | `Blocked` — `discard_next` or ship it first |
| Expecting `link_dependent` / Dependency Closure | Removed — Interactions do not depend on each other |

## Examples

See [examples.md](examples.md) for full greenfield and bug-filing walkthroughs.
