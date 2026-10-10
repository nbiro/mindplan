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

Prerequisite: MindPlan MCP is registered and `get_mindplan_graph` works. Normative reference: `SPEC.md` (plain-language glossary §2.0.0). For executing work through the build pipeline and Bug lifecycle (always-on process), follow `mindplan/agent/playbook.md`. For plan-only sessions that must not write application code, follow `mindplan/agent/skills/plan-project/SKILL.md` (it calls this skill for create/link steps).

## Step 0 — Break the request down

Before creating any node, rewrite the user's ask as one or more sentences:

> *"<who> can <verb> <object> in <area>, from <entry point>, using <building blocks>."*

| Slot | Becomes | Plain word |
|------|---------|------------|
| area | Journey | area |
| verb + object | Interaction | action |
| entry point | Interface | entry point |
| building blocks | Foundation(s) | building block |
| what's broken | Bug | bug |

Rules:

1. Each distinct *verb + object* is one Interaction candidate.
2. **Reuse before create.** Run `find_related_nodes` (or inspect `get_mindplan_graph`) for each area, action, entry point, and building block. Same action on a new entry point → new `exposes` (and mount/wire), **not** a new Interaction.
3. State which nodes you will add, in plain words. Example: "I'll add *split the check* as a new action in the Billing area and show it from the back-office app."
4. Then create what's missing, in the definition order below.

## Step 1 — Orient

```
get_mindplan_graph
```

Note existing Journeys, Foundations, Interactions, Interfaces, Bugs, and edges before creating duplicates. Prefer `find_related_nodes` when checking reuse for a specific action or surface.

## Journey first (mandatory)

**A Journey MUST exist before any Interaction is created. An Interaction may belong to **one or more** Journeys.**

When the user asks for an Interaction (behavior, use case, actor-triggered flow — **not** a UI page by itself):

1. Run `get_mindplan_graph` and inspect existing Journeys
2. Decide whether the request maps to an **existing** Journey (by title, description, or user-stated parent Journey id)
3. If **no** matching Journey exists → **stop and refuse**. Do **not** call `create_node` for the Interaction. Do **not** silently create a Journey on the user's behalf unless they explicitly ask to define one

**Refusal message** (plain words with the user; keep type names when talking graph):

> This needs an **area** first — every action belongs to one. Is it part of an existing area (e.g. Billing), or something new? Once the Journey exists, I can create the Interaction and link it with `belongs_to`.

If the user names a Journey that is not in the graph, same refusal — define that Journey first.

**Allowed without a Journey:** Foundation, Interface, and Bug creation (Interfaces link via `exposes`; Bugs via `affects`). Prefer defining the Interaction before its Interface so `exposes` has a target.

## Step 2 — Pick the entity type

| If the work is… | Type | Why |
|-----------------|------|-----|
| A domain capability the product is about (e.g. "Table ordering", "Billing") | **Journey** | Area; architecture scream; permanent container; state computed from Interactions |
| Shared substrate with no standalone behavior (assembler, DB, auth, design system, adapters) | **Foundation** | Building block; pick a role (§ below); consumed via `depends_on`; must ship before dependent Interactions |
| Self-contained **behavior** by any actor — human, system, or agent — independent of how it is surfaced (e.g. "Split & pay", "Orient on plan", "Check integrity") | **Interaction** | Action; `belongs_to` Journeys; `depends_on` Foundations only; MAY `leads_to` other Interactions |
| An **actor + delivery mechanism** that exposes Interactions — console web app, Waiter POS, CLI, MCP toolset, Webhook, Cron, script — **not** one node per page/tab/command | **Interface** | Entry point; `exposes` Interactions; optional Foundation `depends_on` |
| A defect on shipped or in-flight substrate/behavior/surface | **Bug** | Dedicated lifecycle; links via `affects` only |

**Classification litmus** (in order):
1. Domain capability the product *is about*? → Journey
2. Self-contained behavior (what happens), reusable across surfaces? → Interaction (**not** UI)
3. How that behavior is reached (app/channel: page shell, CLI, MCP, cron, …)? → Interface
4. Shared code/UI substrate with **no** standalone behavior, only consumed? → Foundation (then pick a **role**)
5. Broken behaviour on an existing node? → Bug

**Interaction size test:** one behavior. If the ask is two behaviors, split into two Interactions (optionally linked with `leads_to`).

**Interface grain test:** one Interface per *actor + delivery mechanism*. Ask: "Would a user call this a different app or channel?" If no → same Interface; pages, tabs, commands, and tools inside it are mounts/routes, not separate Interfaces. Console with five pages → one console Interface exposing many Interactions.

**Do not** model a screen/page as an Interaction. The page is a route mounted by an Interface that `exposes` one or more Interactions. The Interaction still owns the **screen body** (domain + mountable view) when Kind is Page; the Interface only mounts it.

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

**Role fallback:** Assembler applies **only** to runtimes that compose and run nodes (app framework, cron host, function host). Docs, CI config, and other misfits → **Infra**. Never write hybrid tags like `"Assembler/docs"` or `"Assembler/shell"` — pick exactly one role; when unsure between Assembler and Infra, choose Infra unless the Foundation is clearly the external runtime that mounts Interactions and Interfaces.

**Assembler linking:** Interactions/Interfaces that run on a given backbone SHOULD `depends_on` that Assembler Foundation (e.g. page Interfaces → `f-nextjs`; cron Interfaces → `f-vercel-cron`). This is guidance, not a compiler gate — Ghost Interactions still only require any Foundation `depends_on`. A Journey's assembler(s) are derived from member Interactions' and Interfaces' `depends_on` — never give Journeys outgoing edges. Different Journeys MAY use different assemblers. Assemblers may import Interfaces/Interactions that depend_on them.

**Reuse rule:** Before inventing shared UI or shared state inside an Interaction, find or create the right Foundation and link `depends_on`. Membership across Journeys uses multiple `belongs_to` edges — not a new node. Cross-Interaction flow uses `leads_to`, never `depends_on` (Interaction Independence).

**Anti-patterns:**
- Journey named after tech (`API`, `Frontend`, `Database`) — wrong; use domain language
- Primary button / design tokens as an Interaction — wrong; that is Foundation (Design system)
- Next.js / cron runtime as a Journey — wrong; that is Foundation (Assembler)
- A checkout **page** as an Interaction — wrong; that is Interface (`if-…`); the pay/split **behavior** (including the screen body) is the Interaction
- One Interface per POS tab/screen — wrong; one surface `exposes` many Interactions and mounts each package
- Fat UI screens owned by an Interface (e.g. under that Interface's claimed paths) with Interactions as thin store wrappers — inverted; move the body to the Interaction
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
| Interface | `if-` | `if-waiter-pos`, `if-mcp-tools`, `if-cli` |
| Bug | `bug-` | `bug-double-charge` |

**Naming rule:** the **title** is the stable name of the thing — an action phrase for Interactions (e.g. "Split the check"), a noun or short noun phrase for Journeys, Interfaces, Foundations, and Bugs. The **description** says what the node is or does **now**. Revision notes, changelog fragments, and parenthetical "what changed this PR" asides belong in the `next.mdx` body (or Atomic Ops), never in title or description. For Foundations, agents SHOULD lead the description with the role tag (`"Assembler — …"`, `"Infra — …"`, `"Design system — …"`, `"Adapter — …"`) — one role only, no hybrids. Both title and description are written to `current.mdx` frontmatter at creation. Change them afterward with host file tools on `current_path` / `next_path` (preferred) or `patch_node_territory({ node_id, title?, description? })` as a fallback. For a shipped Interaction, Interface, or Foundation, call `open_next` first — then edit the `next` slot.

## Step 4 — Create via MCP

**Interaction gate:** only call `create_node` for an Interaction after confirming a matching Journey exists (see Journey first above).

```
create_node({ id, type, title, description })
```

Server scaffolds `mindplan/<type>s/<id>/current.mdx` with the node record in frontmatter (`id`, `type`, `title`, `description`, `state`, timestamps; Foundations also `role`). Does **not** scaffold application code — declare owned paths later with `set_implementation_files` (exact files or directories ending in `/`). Journeys and Bugs have no code ownership. Edge arrays are added by `link_nodes`. This id is permanent — Foundations, Interactions, and Interfaces never get a new id later; they evolve in place via `open_next`/`next.mdx` (see "Evolving a shipped node" below).

After create, call `set_implementation_files` for pipeline nodes. Implement **only** in claimed paths; query expanded files with `get_node_implementation({ node_id })` (or path → owner lookup). Reuse across behaviors via Foundation claims, not Interaction→Interaction `depends_on`. There is no prescribed `src/<type>/<id>/` tree.

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
- **Implementation** — code in paths declared via `set_implementation_files`
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
  - Exportable behavior surface in claimed paths (UI: mountable view; CLI/MCP/Webhook/Cron: handler/module)
  - Behavior surface does not import Interface-owned files (UI: view accepts shell/nav as props/callbacks)

### Interface

- **Kind** — Page | CLI | MCP | Webhook | Cron | Script | …
- **Exposed Interactions** — which Interactions this surface `exposes` and how (one surface, many Interactions — not one Interface per screen)
- **Spec** — routing, commands, tool names, schedules, auth boundaries of the surface. Boilerplate: **App Router (or CLI/MCP) mounts Interaction surfaces; Interface does not own core domain logic or screen bodies.**
- **Implementation** — code in paths declared via `set_implementation_files`. Thin mounts/wiring + shell chrome (Page). No duplicated domain/behavior UI.
- **Checklist** — Atomic Ops MUST include:
  - Thin wiring for each `exposes` target (Page: screen file wires Shell + guards + nav only; CLI/MCP/Webhook/Cron: command/tool/job calls the Interaction export only)
  - No duplicated domain logic / behavior UI that belongs in an exposed Interaction
  - Page/UI only: shell chrome only — not feature screen bodies

### Bug

- **Summary** — one-line defect description
- **Repro Steps** — numbered reproduction
- **Expected / Actual** — behaviour contrast
- **Fix Checklist** — root cause, fix, regression test

Use `- [ ]` syntax for gates — unchecked boxes block `ship` and Bug `resolved` (Completion Check). Treat Atomic Ops as the record you confirm before ship, not as progress narration. Attachments still use normal file tools under `attachments/` (or `next-attachments/` while evolving).

## Step 7 — Verify graph

```
get_mindplan_graph
get_node_context({ node_id })
```

Confirm edges, folder paths, and territory content. When the revision’s contracts are real, run default `mindplan-mcp check`, then self-`ready` in one ordered call. Do not spawn a Plan Reviewer; `review-work` decides at ship time whether a Reviewer is due.

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
11. Stop with links + territory complete; mindplan-mcp check; self-ready in one ordered call
    (Foundations, then Interactions, then Interfaces)
```

Gate facts:

- Journey MUST exist before `create_node` for an Interaction (refusal rule above).
- An Interaction MAY sit at `draft` without links; `belongs_to` + Foundation `depends_on` are required only to leave `draft` (No Ghost Interactions).
- An Interface MAY sit at `draft` without links; ≥1 `exposes` is required to leave `draft` (No Ghost Interfaces).
- Foundation `ready` before Interaction `ready` is sequencing preference; Infrastructure First at Interaction `ship` still requires Foundations `stable`. Behavior First at Interface `ship` requires exposed Interactions `stable`.

Ship order: Foundations → `stable` before Interaction `ship`; Interactions → `stable` before Interface `ship`. The parent owns `draft` → `ready` after a green `mindplan-mcp check`. When a Reviewer is due, that Reviewer owns `ship`; otherwise the implementer ships after check.

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

`open_next` writes `next.mdx` next to `current.mdx` on the **same** node: `draft` state, seeded with the current body and inherited outgoing `belongs_to`/`depends_on`/`exposes`/`leads_to`, and resets checkboxes to `[ ]`. The live node keeps serving unchanged under `current.mdx` — dependents still see the live record. Classify the revision first (`review-work`). A **source** edits `next` into a full successor contract. A **neighbor** (files change, behavior doesn't) is edited in place and gets no `next`; neither do unaffected blast-radius nodes. Then default `mindplan-mcp check`, then self-`ready`. Do not spawn a Plan Reviewer. An execution session runs `in-progress` → `in-review`; `review-work` decides whether a Reviewer is due, and `ship` runs in one ordered `revisions` call, which promotes `next.mdx` over `current.mdx` (title, description, body, edges), deletes `next.mdx`, and recomputes `stable`/`unstable` — same id throughout. `discard_next` abandons the evolution at any point without touching `current.mdx`. Only one `next.mdx` may be open at a time.

## Common mistakes

| Mistake | Result |
|---------|--------|
| Create Interaction with no Journey in graph | **Refuse** — ask for the area first in plain words |
| Interaction → `ready` without links | `Blocked: Ghost Interaction` |
| Interface → `ready` without `exposes` | `Blocked: Ghost Interface` |
| Interaction → Interaction `depends_on` | `Blocked: Interaction Independence` — use Foundation or `leads_to` |
| Bug → `triaged` without `affects` | `Blocked: Ghost Bug` |
| Modeling a Page as an Interaction | Wrong taxonomy — Interface exposes Interaction(s); Interaction still owns the screen body |
| One Interface per screen/tab/page | Wrong — one Interface per actor + channel; each route mounts the matching Interaction surface |
| Duplicate Interaction per entry point (e.g. MCP steer + console steer) | Wrong — reuse the Interaction; add `exposes` from the new Interface |
| Changelog titles / descriptions (e.g. "Orient (slim context…)") | Wrong — title is the stable name; revision notes go in `next.mdx` body |
| Hybrid or forced role tags (`"Assembler/docs"`) | Wrong — Assembler only for runtimes; misfits → Infra |
| Fat screens owned by an Interface | Inverted ownership — move domain + view to the Interaction; Interface only mounts |
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
