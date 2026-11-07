---
name: mindplan-define-entities
description: >-
  Defines MindPlan graph entities (Capability, Foundation, Interaction, Interface,
  Bug) via MCP — taxonomy selection, Foundation roles (Assembler/Infra/Design
  system/Adapter), ID naming, edge linking (belongs_to, depends_on, exposes,
  leads_to, affects), and <id>.mdx territory. Capability MUST exist before
  Interaction; refuses Interaction creation when no matching Capability is in the
  graph. Use when creating planning nodes, scaffolding behavior and surfaces,
  mapping domain capabilities, adding shared substrate, filing bugs, or
  structuring a MindPlan graph.
---

# Define MindPlan Entities

Use this skill when adding or restructuring nodes in `mindplan/`. Every graph write goes through a **MindPlan MCP** tool; never edit `mindplan/**` with host file tools.

The server serves this skill (`get_skill({ name: "define-entities" })`) and its examples (`get_skill({ name: "define-entities", file: "examples.md" })`). Modeling a whole feature and evolving shipped nodes are in the `plan-project` skill; the duties and gates are in `get_project.playbook`. Normative reference: `SPEC.md` (type glossary §2.0.0).

## Step 0 — Break the request down

Before creating any node, rewrite the user's ask as one or more sentences:

> *"<who> can <verb> <object> in <Capability>, from <Interface>, using <Foundations>."*

| Slot | Becomes |
|------|---------|
| verb + object | Interaction |
| Capability | Capability (must exist first) |
| Interface | Interface |
| Foundations | Foundation(s) |
| what's broken | Bug |

1. Each distinct *verb + object* is one Interaction candidate. Size: one behavior; two behaviors are two Interactions (optionally linked with `leads_to`).
2. **Reuse before create.** Run `find_related_nodes` (or inspect `get_mindplan_graph`) for each Capability, Interaction, Interface, and Foundation. Same Interaction on a new Interface → new `exposes` (and mount), **not** a new Interaction.
3. State which nodes you will add, by type name. Example: "I'll add *split the check* as a new Interaction in the Billing Capability and expose it from the back-office Interface."
4. Not every ask is a node. A **product summary** is a `patch_project_description` call. A **standing rule** is a `patch_project_rules` call when it applies everywhere, or a `patch_node_rules` call on the node whose work it is about (it reaches that node and every node that inherits from it: a Foundation's dependents, a Capability's Interactions, and Bugs that affect them; read the `rules_impact` it returns). Neither is a new Capability. Call `get_project` again to re-read the brief.
5. **Invert nodes that must know every feature.** When one node has to handle every feature of a kind (erase a site, export an account, index for search, check a permission), do not add a `depends_on` per feature. Define the contract once on the Foundation those features already use: a schema convention (every per-site table cascades from the site) or a record they react to (a deleted/restored state). State it there as a node rule with `patch_node_rules`, so every dependent sees it in `orient_for_work`, and link the test that enforces it with `set_test_files`. The node then depends only on that Foundation. `run_check` warns `fan-out:` when a pre-ship node's `depends_on` reaches `fan_out.warn_at` (default 3) other unshipped changes (the full `orient_for_work` reply shows the count in `stability.fan_out`); a decision with `keep_whole: true` keeps the edges on purpose and silences it.
6. Then create what's missing, in the definition order below.

## Step 1 — Orient

```
get_mindplan_graph({ type: ["Capability", "Foundation"], fields: ["id", "type", "title", "change"] })
```

Note the existing nodes and edges before creating duplicates. For a question about part of the graph, filter and project (`state`, `type`, `change`, `fields`) instead of reading it whole. Prefer `find_related_nodes` to check reuse for one Interaction or Interface, and `orient_for_work` for one piece of work.

## Capability first (mandatory)

**A Capability MUST exist before any Interaction is created. An Interaction may belong to one or more Capabilities.**

When the user asks for an Interaction (a behavior or actor-triggered flow — **not** a UI page by itself):

1. Run `get_mindplan_graph({ type: "Capability", fields: ["id", "title", "description"] })` and inspect the existing Capabilities.
2. Decide whether the request maps to an **existing** Capability (by title, description, or a Capability id the user names).
3. If **no** matching Capability exists → **stop and refuse**. Do **not** call `create_node` for the Interaction, and do not create a Capability on the user's behalf unless they explicitly ask to define one.

**Refusal message:**

> This needs a **Capability** first — every Interaction belongs to one. Is it part of an existing Capability (e.g. Billing), or something new? Once the Capability exists, I can create the Interaction and link it with `belongs_to`.

A Capability the user names that is not in the graph gets the same refusal. Foundations, Interfaces, and Bugs need no Capability (Interfaces link via `exposes`, Bugs via `affects`). Define the Interaction before its Interface so `exposes` has a target.

## Step 2 — Pick the entity type

| If the work is… | Type | Why |
|-----------------|------|-----|
| Something the product does, named in domain language (e.g. "Table ordering", "Billing") | **Capability** | Architecture scream; permanent container; state computed from Interactions |
| Shared substrate with no standalone behavior (assembler, DB, auth, design system, adapters) | **Foundation** | Pick a role (below); consumed via `depends_on`; gates its dependents' ship (Gate facts) |
| Self-contained **behavior** by any actor — human, system, or agent — independent of how it is surfaced (e.g. "Split & pay", "Orient on plan", "Check integrity") | **Interaction** | `belongs_to` Capabilities; `depends_on` Foundations only; MAY `leads_to` other Interactions |
| An **actor + delivery mechanism** that exposes Interactions — console web app, Waiter POS, CLI, MCP toolset, Webhook, Cron, script — **not** one node per page/tab/command | **Interface** | `exposes` Interactions; optional Foundation `depends_on` |
| A defect on shipped or in-flight substrate/behavior/surface | **Bug** | Dedicated lifecycle; links via `affects` only |

**Classification litmus** (in order):
1. Something the product *does*, named in domain language? → Capability
2. Self-contained behavior (what happens), reusable across surfaces? → Interaction (**not** UI)
3. How that behavior is reached (app/channel: page shell, CLI, MCP, cron, …)? → Interface
4. Shared code/UI substrate with **no** standalone behavior, only consumed? → Foundation (then pick a **role**)
5. Broken behaviour on an existing node? → Bug

**Interface grain test:** one Interface per *actor + delivery mechanism*. Ask: "Would a user call this a different app or channel?" If no → same Interface; pages, tabs, commands, and tools inside it are mounts/routes, not separate Interfaces. A console with five pages is one Interface exposing many Interactions.

**A page is not an Interaction.** The page is a route mounted by an Interface that `exposes` one or more Interactions. The Interaction still owns the **screen body** (domain + mountable view) when Kind is Page; the Interface only mounts it.

**File ownership** (SPEC §1.2.2, `get_spec({ topic: "imports" })`) — declare with `set_implementation_files`:

| Owner | Owns | Must not own |
| --- | --- | --- |
| Interaction | Domain/view-model, exportable surface (UI: `*-view`; CLI/MCP: handler) | App routing, device/staff shell chrome, cross-Interaction nav |
| Interface | Routes/entry, providers, guards, thin mounts, shared shell, nav callbacks | Feature screen bodies and domain rules |
| Foundation | Shared substrate (store, tokens, dumb primitives) | Capability-specific screen flows |

Interactions MUST NOT import Interface-owned files (import matrix). Foundations carry a server-owned `role`: assembler | infra | design-system | adapter (`create_node` requires it).

**Foundation roles.** After classifying as Foundation, pick one:

| Role | When | Description tag example |
|------|------|-------------------------|
| **Assembler** | External framework/runtime that **composes** Capabilities, Interactions, Interfaces, and Foundations into a deployable surface | `"Assembler — Next.js app shell composing interactions and interfaces"` |
| **Adapter** | Vendor/protocol boundary SDK only | `"Adapter — Stripe SDK wrapper"` |
| **Design system** | Tokens + dumb presentational UI | `"Design system — tokens and Button/Input primitives"` |
| **Infra** | Persistence, messaging, storage, observability, homegrown auth | `"Infra — Postgres schema and migrations"` |

Role litmus: Assembler → Adapter → Design system → otherwise Infra. Auth is Infra unless it is a vendor adapter (`f-clerk` → Adapter). Tokens and UI kit are one Design system. Assembler is **only** a runtime that composes and runs nodes (app framework, cron host, function host); docs, CI config, and other misfits are **Infra**. Pick exactly one role, never a hybrid tag like `"Assembler/docs"`; when unsure between Assembler and Infra, choose Infra.

**Assembler linking:** Interactions and Interfaces that run on a given backbone SHOULD `depends_on` that Assembler (page Interfaces → `f-nextjs`; cron Interfaces → `f-vercel-cron`). This is guidance, not a compiler gate: a Ghost Interaction check only needs some Foundation `depends_on`. A Capability's assemblers are derived from its members' `depends_on`; never give a Capability outgoing edges. Different Capabilities MAY use different assemblers. An Assembler may import the Interfaces and Interactions that `depends_on` it.

**Shared routes (multi-template apps):** a route that exists for every template and dispatches to the active one (e.g. `app/sites/[site]/[lang]/blog/*`) belongs to the **Assembler**; a template's Interface owns only routes that exist for that template alone. Keep one owner per route family — the check warns when one is split. An Interaction whose views live in every template may claim them with one glob: `src/templates/*/actions/i-read-post/`.

**Reuse rule:** before inventing shared UI or state inside an Interaction, find or create the right Foundation and link `depends_on`.

## Step 3 — Name the node

Pattern: `^[a-z0-9][a-z0-9-_]*$` (globally unique across all types).

| Type | Prefix | Example |
|------|--------|---------|
| Capability | `c-` | `c-ordering` |
| Foundation | `f-` | `f-db-core`, `f-nextjs` |
| Interaction | `i-` | `i-checkout-split` |
| Interface | `if-` | `if-waiter-pos`, `if-mcp-tools`, `if-cli` |
| Bug | `bug-` | `bug-double-charge` |

- **Title** is the stable name of the thing: a verb phrase for an Interaction ("Split the check"), a noun phrase for the other types.
- **Description** says what the node is or does **now**, in one or two sentences under 300 characters: it is the row search ranks and orientation shows; detail goes in the body. For an Interaction, say who does what ("Visitor sends …"). For a Foundation, lead with its one role tag (`"Assembler — …"`, `"Infra — …"`, `"Design system — …"`, `"Adapter — …"`). `run_check` warns on an empty, title-repeating, over-300-character, actor-less (Interaction), or revision-worded description. Revision notes and "what changed" asides go in the revision body (or Atomic Ops), never in title or description.
- **Aliases:** add `aliases` for the words users will say that title and description lack (`quote` for an enquiry form, the product's other-language terms such as `ofertă`), at `create_node` or later with `patch_node_territory({ node_id, aliases })`; aliases never need `open_next`.
- Change title or description later with `patch_node_territory({ node_id, title?, description? })`. On a shipped Interaction, Interface, or Foundation, call `open_next({ node_id, change })` first and patch that revision.

## Step 4 — Create via MCP

```
create_node({ id, type, title, description })        // Foundations also pass role
```

An Interaction only after Capability first (above). The server scaffolds `mindplan/<folder>/<id>/<id>.mdx` (`<folder>` is `capabilities`, `foundations`, `interactions`, `interfaces`, or `bugs`) with the node record in frontmatter; `link_nodes` adds the edges. It does **not** scaffold application code: after create, declare a pipeline node's owned paths with `set_implementation_files` (exact files, or directories ending in `/`) and implement only there; `get_node_implementation({ node_id })` expands them. Capabilities and Bugs own no code, and there is no prescribed `src/<type>/<id>/` tree. The id is permanent: a Foundation, Interaction, or Interface evolves in place through revisions (Evolving a shipped node, below).

## Step 5 — Link edges (before advancing state)

| Type | Required links | MCP call |
|------|----------------|----------|
| **Interaction** | `belongs_to` → one or more Capabilities; `depends_on` → Foundation(s) only | `link_nodes` per Capability + per Foundation |
| **Interface** | `exposes` → one or more Interactions; optional `depends_on` → Foundation | `link_nodes` |
| **Foundation** | optional `depends_on` → other Foundation; `mounts` → Interface(s) when it is a composition root | `link_nodes` if layered or mounting |
| **Bug** | `affects` → Interaction, Interface, or Foundation (before `triaged`) | `link_nodes` |
| **Capability** | none (Interactions link to it) | — |

```
link_nodes({ source_id, target_id, edge_type })
link_nodes({ source_id: "i-orient-plan", target_id: "i-steer-plan", edge_type: "leads_to" })
```

- `leads_to` is navigation only — not a ship gate and not a substitute for sharing state. Cycles are allowed.
- Several `belongs_to` edges from one Interaction reuse it across Capabilities.
- **Interaction Independence:** an Interaction MUST NOT `depends_on` another Interaction. Share state through Foundations; model flow with `leads_to`.
- Every other edge shape is `Blocked:` (SPEC §2.2).

### Composition roots (`mounts`)

A Foundation may not import an Interface, so a module whose job is to import several Interfaces — a template registry, a route dispatcher, a redirect list — has no legal home on `depends_on` alone. Put it on a Foundation and declare what it mounts:

```
link_nodes({ source_id: "f-registry", target_id: "if-template-a", edge_type: "mounts" })
link_nodes({ source_id: "f-registry", target_id: "if-template-b", edge_type: "mounts" })
```

`mounts` permits exactly those imports and nothing else; the same import without the edge is `Blocked:`. `set_implementation_files` on the registry returns each missing `link_nodes` call in `import_violations`. Multi-template platform: one Interface per template, each `exposes` the shared Interactions; one Foundation owns `registry.ts` and `mounts` them all. The registry is neither an Interface (it has no actor surface) nor an Interaction.

## Step 6 — Enrich territory

Write territory only with `patch_node_territory`. MCP is the only writer of `mindplan/`: never edit `mindplan/**` with host file tools, and change server-owned frontmatter (`state`, timestamps, edge arrays) only through its tools.

```
patch_node_territory({ node_id, section: "## Purpose", text: "…" })        // one section; the rest untouched
patch_node_territory({ node_id, replace: { find: "…", with: "…" } })      // one exact piece of the body
patch_node_territory({ node_id, body: "…" })                              // the whole body
patch_node_territory({ node_id, title?, description?, aliases? })         // record fields
patch_node_territory({ node_id, toggle_checkboxes: [{ id: "impl", checked: true }] })
```

Use `section` or `replace` for small edits so you do not resend the body. On a node with several open revisions, pass `change`.

**Checklist items.** `toggle_checkboxes` names an item by `id` (its `{#id}` tag; the default items are `spec`, `impl`, `verify`) or by its exact text without tag or annotation (`contains`); a substring is `Blocked:` and lists the items, and text several items share needs `all: true`. Close an item done differently with `{ id, note: "…" }`, or one that does not apply with `{ id, not_applicable: "<reason>" }` — never reword an item to make it tickable. Every item is a `build` item (the agent closes it) unless tagged `{#id review}` or `{#id deploy}`: a person closes those. Add items with `add_checklist_items: [{ text, id?, kind? }]`. Open review and deploy items show in `orient_for_work` as `open_items` and in `run_check` as `Info: waiting on people:`; say they wait instead of ticking them.

Replace scaffold placeholders with real content. The gate checks these sections on every listed move, and `create_node` returns `shape` with each one's status (`present`, `missing`, or `stub`):

<!-- shape-table:start -->
| Type | Required sections | Checked when moving to |
|---|---|---|
| Foundation | `## Purpose`, `## Shared Substrate Spec`, `## Acceptance Criteria`, `## Atomic Ops` (or `## Checklist`) with a checkbox, and a `role` (frontmatter, or a role tag starting the description) | `ready`, `in-review`, `ship` |
| Interaction | `## Purpose`, `## Actor & Trigger`, `## PRD / Execution Logic` (or `## Execution Logic` / `## PRD`), `## Acceptance Criteria`, `## Atomic Ops` with a checkbox | `ready`, `in-review`, `ship` |
| Interface | `## Purpose`, `## Kind`, `## Spec`, `## Acceptance Criteria`, `## Atomic Ops` with a checkbox | `ready`, `in-review`, `ship` |
| Bug | `## Summary`, `## Repro Steps`, `## Fix Checklist` with a checkbox | `in-review`, `resolved` |

A prose section must not be empty or hold only `create_node` placeholder text. An optional `## Impact` must not be a stub. Capabilities have no required sections. `create_node` and `orient_for_work` return `shape`: each required section marked `present`, `missing`, or `stub`.
<!-- shape-table:end -->

Section guidance:

### Capability

- **Overview** — what the product does in this Capability and which Interactions belong inside it (Capability titles alone should scream the product purpose)
- **Linked Interactions** — note which Interactions will `belongs_to` here
- No checklist (Capabilities have no completion gate)

### Foundation

- **Purpose** — what shared substrate it owns and why other nodes depend on it
- **Shared Substrate Spec** — schemas, adapters, design system, contracts (not behavior). The role tag goes in `description`, not here.
- **Implementation** — code in paths declared via `set_implementation_files`
- **Acceptance Criteria** — checkable outcomes of the substrate contract
- **Atomic Ops** (or **Checklist**) — PR-sized items (`- [ ]` / `- [x]`):
  - Spec written
  - Implementation complete
  - Verified in target environment

### Interaction

- **Purpose** — one sentence: what the Interaction does, and the constraint a later session would otherwise simplify away. If there is no such constraint, the outcome sentence is enough.
- **Actor & Trigger** — who/what starts it (human, system, agent, schedule)
- **Inputs & Outputs** — data in/out (not UI layout)
- **PRD / Execution Logic** — step-by-step behavior. When a Page/UI Interface will `exposes` this Interaction, name the **mountable view**. When Kind is CLI/MCP/Webhook/Cron, name the **exportable handler/module** (not a `*-view.tsx`).
- **Implementation** — code in files declared via `set_implementation_files` (domain + view/handler). MUST NOT import Interface-owned files.
- **Acceptance Criteria** — checkable outcomes of the behavior
- **Atomic Ops** — MUST include (Kind-gated):
  - Domain API against Foundations (no Interaction→Interaction `depends_on`)
  - Exportable behavior surface in claimed paths (UI: mountable view; CLI/MCP/Webhook/Cron: handler/module)
  - Behavior surface does not import Interface-owned files (UI: view accepts shell/nav as props/callbacks)

### Interface

- **Purpose** — which actor surface it is and which Interactions it mounts or wires
- **Kind** — Page | CLI | MCP | Webhook | Cron | Script | …
- **Exposed Interactions** — which Interactions this surface `exposes` and how (one surface, many Interactions — not one Interface per screen)
- **Spec** — routing, commands, tool names, schedules, auth boundaries of the surface. Boilerplate: **App Router (or CLI/MCP) mounts Interaction surfaces; Interface does not own core domain logic or screen bodies.**
- **Implementation** — code in paths declared via `set_implementation_files`. Thin mounts/wiring + shell chrome (Page). No duplicated domain/behavior UI.
- **Acceptance Criteria** — checkable outcomes of the surface
- **Atomic Ops** — MUST include:
  - Thin wiring for each `exposes` target (Page: screen file wires Shell + guards + nav only; CLI/MCP/Webhook/Cron: command/tool/job calls the Interaction export only)
  - No duplicated domain logic / behavior UI that belongs in an exposed Interaction
  - Page/UI only: shell chrome only — not feature screen bodies

### Bug

- **Summary** — one-line defect description
- **Repro Steps** — numbered reproduction
- **Expected / Actual** — behaviour contrast
- **Fix Checklist** — root cause, fix, regression test

Unchecked `- [ ]` boxes block `ship` and Bug `resolved` (Completion Check). Atomic Ops are the record you confirm before ship, not progress narration. Ship removes the section from the shipped node, and `open_next` starts a revision with fresh unticked defaults that you rewrite into its ops. Attachments go through `put_attachment` / `remove_attachment`, under `attachments/` (or the open revision's; pass `change` when several are open).

## Step 7 — Verify graph

```
get_mindplan_graph
get_node_context({ node_id })
```

Confirm edges, folder paths, and territory content. When the contracts are real, run `mindplan-mcp check`, then self-`ready` in one ordered call.

## Definition order (greenfield project)

Behavior-first: draft Interactions so Foundations and Interfaces are derived from real behavior, not invented ahead of them.

```
1. create_node Capability              ← always first; required before any Interaction
2. create_node Interaction(s)       ← only after step 1; may stay at draft with no links yet
3. create_node Interface(s)         ← surfaces that will expose those Interactions
4. create_node Foundation(s)        ← derive from drafted Interaction PRDs; role-tag descriptions
5. link_nodes Interaction → Capability (belongs_to)
6. link_nodes Interaction → Foundation (depends_on)   ← Foundations only
7. link_nodes Interface → Interaction (exposes)
8. link_nodes Interface → Foundation (depends_on)     ← optional
9. link_nodes Interaction → Interaction (leads_to)    ← navigation only, as needed
10. Write each node body (and title/description if needed) with patch_node_territory
11. Stop with links + territory complete; mindplan-mcp check; self-ready in one ordered call
    (Foundations, then Interactions, then Interfaces)
```

Gate facts:

- An Interaction MAY sit at `draft` without links; `belongs_to` + a Foundation `depends_on` are required to leave `draft` (No Ghost Interactions). An Interface needs ≥1 `exposes` to leave `draft` (No Ghost Interfaces).
- **Ready for dependents:** a dependency counts once it is `stable`, or `in-review` with at least one checklist item and every `build` item ticked and its own dependencies ready the same way, transitively. It still ships itself only with every item ticked.
- **Infrastructure First:** an Interaction ships only when every Foundation it `depends_on` is ready for dependents. **Behavior First:** an Interface ships only when every Interaction it `exposes`, and every Foundation it `depends_on`, is ready for dependents. Details: SPEC §5.4–§5.5.
- Foundation `ready` before Interaction `ready` is only a sequencing preference.
- The parent self-readies (`draft` → `ready`) after a green `mindplan-mcp check`; the implementer ships after the check when the gates allow.

## Evolving a shipped node

Foundations, Interactions, and Interfaces keep one id forever — there is no `-v2` node. When a shipped node's contract changes:

```
get_blast_radius({ node_id: "i-checkout-split" })   // dependents + reachability first
open_next({
  node_id: "i-checkout-split",
  change: "split-rules",                         // required: the change id this revision belongs to
  title: "Split & pay checkout v2",              // optional
  description: "Revised checkout with new split rules"  // optional
})
```

`open_next` writes `revisions/<change>/<id>.mdx` in `draft` with fresh unticked Atomic Ops to rewrite; the live `<id>.mdx` keeps serving. Shipping the revision writes live ⊕ the revision to `<id>.mdx` under the same id, deletes the revision folder, and recomputes `stable` / `unstable`. `discard_next({ node_id, change })` deletes one revision folder without touching `<id>.mdx` or the other revisions. Which nodes get a revision (source, neighbor, unaffected), several revisions on one node, deltas, and conflicts: `plan-project` §4.

## Common mistakes

| Mistake | Result |
|---------|--------|
| Create Interaction with no Capability in graph | **Refuse** — ask for the Capability first |
| Interaction → `ready` without links | `Blocked: Ghost Interaction` |
| Interface → `ready` without `exposes` | `Blocked: Ghost Interface` |
| Bug → `triaged` without `affects` | `Blocked: Ghost Bug` |
| Interaction → Interaction `depends_on` | `Blocked: Interaction Independence` — share via a Foundation or navigate with `leads_to` |
| Capability named after tech (`API`, `Frontend`, `Database`) | Wrong — name it in domain language |
| Design tokens or a primary button as an Interaction; a Next.js or cron runtime as a Capability | Wrong — Foundation (Design system / Assembler) |
| Behavior (a character editor, a user picker) or business logic in a Foundation | Wrong — that is an Interaction; keep the Foundation to substrate |
| A page as an Interaction | Wrong — an Interface exposes the Interaction; the Interaction still owns the screen body |
| One Interface per screen, tab, or page | Wrong — one Interface per actor + channel; each route mounts the matching Interaction surface |
| A second Interaction for a new Interface (e.g. MCP steer + console steer) | Wrong — reuse the Interaction; add `exposes` from the new Interface |
| Fat screens owned by an Interface, Interactions as thin store wrappers | Inverted — move domain + view to the Interaction; the Interface only mounts |
| A new primary button inside an Interaction | Reuse — `depends_on` `f-design-system` (or create that Foundation first) |
| An exposed Interaction's PRD without its mountable view (Page/UI) or handler/module (CLI/MCP/Webhook/Cron) | Incomplete — name it in PRD / Execution Logic |
| Interaction code outside its claimed files | Declare files with `set_implementation_files`; query with `get_node_implementation` |
| Changelog titles / descriptions (e.g. "Orient (slim context…)") | Wrong — title is the stable name; revision notes go in the revision body |
| Hybrid or forced role tags (`"Assembler/docs"`) | Wrong — Assembler only for runtimes; misfits → Infra |
| Setting Capability state, `stable`, or `unstable` | Rejected — computed only |
| Editing `mindplan/**` with host file tools, or server-owned frontmatter by hand | Out of contract — use `patch_node_territory` and the other MCP tools |
| `open_next` on an unshipped node | `Blocked` — only `stable`/`unstable` nodes open revisions |
| `open_next` without `change`, or for a change already open on the node | `Blocked` — pass a change id; edit, ship, or `discard_next` the open revision of that change |
| A call on a node with several open revisions and no `change` | `Blocked` — the error lists them; pass `change` |
| `set_implementation_files` / `set_test_files` with `files` and no `replace: true` | `Blocked` — use `add` / `remove`; `files` + `replace: true` only to replace the whole list |
| One decision recorded once per node it shapes | Noise — record it once with `nodes: [...]` |
| A `depends_on` per feature on a node that must know every feature | `fan-out:` warning in `run_check` — invert onto a Foundation contract (Step 0) |

## Examples

See [examples.md](examples.md) (`get_skill({ name: "define-entities", file: "examples.md" })`) for full greenfield and bug-filing walkthroughs.
