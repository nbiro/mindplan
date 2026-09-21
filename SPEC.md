# MindPlan Framework Specification

**Version:** 0.1.0
**Status:** Unreleased
**Reference implementation:** repository root (TypeScript MCP server, stdio transport)

The key words MUST, MUST NOT, SHALL, SHOULD, and MAY in this document are to be interpreted as described in RFC 2119.

---

## 0. Abstract

MindPlan is a strictly deterministic Software Development Life Cycle (SDLC) framework designed **AI-first**: autonomous agents (and human teams) work from a **persistent, machine-queryable architectural model** of the product — not from chat history or an external ticket list. Planning state lives inside the repository as tickets-as-code. Every mutation is validated like a compile step; illegal moves are rejected with a machine-parsable `Blocked: …` error. Architecture and requirements stay synchronized with the code they describe.

The model is **Interaction-centric**. Agents query *what the system does* (Journeys → Interactions), *how actors enter those behaviors* (Interfaces), and *what shared substrate those behaviors stand on* (Foundations), composed by an Assembler — instead of reconstructing architecture from source on every task.

MindPlan is exposed exclusively through a Model Context Protocol (MCP) server — the single write path to graph state. Direct file edits to server-owned frontmatter are out of contract (§9.3). Consumer projects receive an always-on agent playbook at `mindplan/agent/playbook.md` (installed by `mindplan-mcp init` from `templates/agent/playbook.md`). Entity scaffolding lives in `define-entities`; plan-only modeling in `plan-project`; Plan Review (`draft → ready`) and Implementation review (`in-review → ship` / Bug `resolved`) live in `review-work` as an orchestrated independent-Reviewer loop (playbook gates; not server-enforced). Many agents also read root `AGENTS.md`, which `init` creates when missing.

`GRAPH_VERSION` remains `1`. This Interaction-centric taxonomy is a **breaking** change accepted while the package is unreleased — there is no consumer compatibility layer for the former Workflow-centric schema.

---

## 1. Core Architecture: Territory

MindPlan persists all planning state as **tickets-as-code** under `mindplan/`. Each node owns a folder containing a `current.mdx` file and an `attachments/` directory. The `current.mdx` YAML frontmatter is the **node record** — identity, state, timestamps, and outgoing edge arrays; it is the live, stable id for the node's entire lifetime (§3.6). The body contains Purpose / PRD / Execution Logic / Shared Substrate Spec, Acceptance Criteria, and Atomic Operations.

A shipped Foundation, Interaction, or Interface (`stable`/`unstable`) MAY additionally hold a `next.mdx` — an in-flight evolution of that same node, built in place under the same id while `current.mdx` keeps serving. `next.mdx` and its sibling `next-attachments/` directory exist only for Foundations, Interactions, and Interfaces (§3.6) and are never present on Journeys or Bugs.

Context files are MDX: standard Markdown plus optional JSX components (§6.4). Markdown remains the load-bearing syntax — every compiler rule operates on Markdown constructs only, and a context file containing no JSX at all is fully compliant.

The territory MUST live in the repository alongside the source code and MUST be versioned with it. A commit therefore captures code, architecture, and requirements in one atomic snapshot.

### 1.1 Directory layout

MindPlan prescribes a **dual tree**: planning under `mindplan/`, and **implementation packages** under `src/` for Interactions, Interfaces, and Foundations. Journeys and Bugs have no code package — Journeys are graph containers (Interactions may belong to many Journeys), and Bugs are a defect layer whose fixes land in the affected node's package.

```
<project-root>/
├── mindplan/
│   ├── components/                    # Project-specific MDX components (§6.4) — opaque to the compiler
│   ├── journeys/
│   │   └── <node-id>/
│   │       ├── current.mdx           # Plan only — no src/ package
│   │       └── attachments/
│   ├── foundations/
│   │   └── <node-id>/
│   │       ├── current.mdx
│   │       ├── next.mdx              # Optional — in-flight evolution (§3.6)
│   │       ├── attachments/
│   │       └── next-attachments/
│   ├── interactions/
│   │   └── <node-id>/
│   │       ├── current.mdx
│   │       ├── next.mdx
│   │       ├── attachments/
│   │       └── next-attachments/
│   ├── interfaces/
│   │   └── <node-id>/
│   │       ├── current.mdx
│   │       ├── next.mdx
│   │       ├── attachments/
│   │       └── next-attachments/
│   └── bugs/
│       └── <node-id>/
│           ├── current.mdx
│           └── attachments/
└── src/
    ├── interactions/<interaction-id>/   # Behavior implementation package (§1.2)
    ├── interfaces/<interface-id>/       # Entry-surface implementation package (§1.2)
    └── foundations/<foundation-id>/     # Shared-substrate implementation package (§1.2)
```

Rules:

- The planning root is `<MINDPLAN_ROOT>/mindplan`, where `MINDPLAN_ROOT` is an environment variable resolving to the target project root. If unset, the server's working directory is used. Implementation packages are rooted at `<MINDPLAN_ROOT>/src`.
- Each entity folder name under `mindplan/` MUST equal the node `id`.
- The subdirectory per type is fixed: `journeys/`, `foundations/`, `interactions/`, `interfaces/`, `bugs/`.
- `next.mdx` and `next-attachments/` MUST NOT exist for Journeys or Bugs; they are legal only under `foundations/<id>/`, `interactions/<id>/`, and `interfaces/<id>/`, and only while an evolution is open (§3.6).
- `attachments/` MAY contain arbitrary files. Attachments SHOULD be referenced from `current.mdx` with relative links (e.g. `![flow](attachments/flow.png)`); `next-attachments/` is referenced the same way from `next.mdx` and is merged into `attachments/` when the evolution ships (§3.6).
- `components/` MAY contain project-specific MDX components (§6.4.3). It is created by the server but never read by it.
- The server MUST create missing directories on demand; a fresh project requires no manual scaffolding.

### 1.2 Implementation packages (prescribed architecture)

By default (and when `mindplan/config.json` is missing), Interaction, Interface, and Foundation nodes own a **derived** filesystem package whose path is fixed by type and id (not a graph edge — targets are directories, not MindPlan nodes):

| Node type | Implementation root | Purpose |
|---|---|---|
| Interaction | `src/interactions/<id>/` | Self-contained behavior: domain/view-model **and** the exportable surface (UI: mountable view; CLI/MCP/Webhook/Cron: handler/module). Shared across Journeys via `belongs_to` in the graph only |
| Interface | `src/interfaces/<id>/` | How an actor enters/accesses one or more Interactions (Page, CLI, MCP tool, Webhook, Cron, …). **Mounts or wires** Interaction packages — MUST NOT own screen bodies or core domain |
| Foundation | `src/foundations/<id>/` | Shared substrate by role (assembler, infra, design system, adapter) — not Journey-specific screen flows |
| Journey | *(none)* | Plan container — architecture for a Journey is the union of member Interaction packages plus the Interfaces that expose them |
| Bug | *(none)* | Fixes land in the affected Interaction/Interface/Foundation package |

Rules (when `implementation_packages` is `required`):

- Package folder name MUST equal the node `id` (e.g. `i-checkout-split` → `src/interactions/i-checkout-split/`).
- `create_node` for Interaction, Interface, or Foundation MUST scaffold the package directory with a `.gitkeep` (§6.3).
- Agents MUST implement that node's code **only** inside its package. Cross-cutting reuse MUST go through Foundation packages — not Interaction→Interaction `depends_on` (illegal; §2.2, §5.9) and not ad-hoc junk-drawer folders outside the prescribed roots.
- Agents query architecture via the MindPlan graph **plus** `get_node_implementation` (§8.1). For a Journey, derive member packages by resolving `belongs_to` Interactions, then calling `get_node_implementation` on each (and on Interfaces that `exposes` those Interactions when entry surfaces matter).

#### 1.2.1 Layout-free adoption (`implementation_packages: "off"`)

Existing (brownfield) projects MAY opt out of prescribed packages via `mindplan/config.json`:

```json
{
  "implementation_packages": "off"
}
```

`mindplan-mcp init --layout free` writes that config; `--layout prescribed` (or default init when missing) writes `"required"`. Missing config MUST be treated as `"required"` so greenfield and this reference repo keep screaming-architecture checks. A **present but invalid** `mindplan/config.json` (bad JSON, non-object, or `implementation_packages` not exactly `"required"`|`"off"`) MUST hard-fail with `Blocked: invalid mindplan/config.json: …` — tools (`create_node`, `get_node_implementation`, …), `mindplan-mcp check`, and bare `init` (preserve path) MUST NOT silently fall back to `"required"`. Fix the file or overwrite with `mindplan-mcp init --layout free|prescribed`.

When packages are `off`:

- `create_node` MUST NOT scaffold `src/foundations|interactions|interfaces/<id>/`
- `get_node_implementation` MUST report `implementation_packages: "off"` with `root: null` (not an integrity failure)
- `mindplan-mcp check` MUST skip package presence, orphan, and dirty-src ownership checks; graph load still applies. Opt-in `--for-main` mid-pipeline bans still apply when requested.
- Agents implement in the project's existing layout; they still advance MindPlan states and MUST NOT invent tickets outside the graph

Graph compiler gates (Ghost Interactions/Interfaces/Bugs, Infrastructure First, Behavior First, Completion Check, Interaction Independence) are unchanged in both modes. Playbook gates (Plan Review for `draft → ready`, External Review for ship / Bug `resolved` — orchestrated Reviewer-subagent loops) also apply in both modes — they are not server-enforced.

#### 1.2.2 Package ownership (Interaction owns the body; Interface mounts)

**Interaction owns the behavior surface. Interface only mounts or wires it.**

- **Interaction package** owns domain logic, view-model, and the exportable surface for that behavior (Page/UI: mountable `*-view` / equivalent; CLI/MCP/Webhook/Cron: handler/module). It MUST NOT own app routing, device/staff shell chrome, or cross-Interaction navigation. It MUST NOT import `src/interfaces/…`.
- **Interface package** owns routes/entry, providers, guards, thin mounts/wiring, shared shell chrome, and nav callbacks. It MAY compose multiple exposed Interactions (e.g. a badge from pickup on floor chrome). It MUST NOT reimplement order/checkout/floor/etc. behavior UI or domain rules that belong in an `exposes` target.
- **Interface `ui/`** (when present) is chrome wrappers only — not feature screen bodies. Agents MUST NOT dump screens under `interfaces/…/ui/` as if that were the Interaction view.
- **One Interface per actor surface**, not one Interface per screen/tab. A Waiter POS (or equivalent console) remains one Interface that `exposes` many Interactions; each route/tab mounts the matching Interaction package.
- Layout-free projects (`implementation_packages: "off"`) follow the same ownership split in the existing app layout.

**Build order (per exposed Interaction):** Interaction `in-progress` → implement domain + exportable surface → only then Interface thin mount/wire for that entry (pass shell/nav or call the handler; no reimplementation).

Default Atomic Ops templates (§6.3) and playbook/review-work gates encode this split. Taxonomy edges (`exposes`, `leads_to`, Interaction Independence) are unchanged.

### 1.3 Screaming architecture

A glance at the territory MUST scream what the product *is*, not which frameworks or delivery mechanisms it uses:

| Layer | Screams |
|---|---|
| **Journeys** | Domain capabilities the product is about |
| **Interactions** | Behaviors the system performs (initiated by any actor) |
| **Interfaces** | How actors enter those behaviors |
| **Foundations** | Shared substrate at the edges |
| **Assembler** | Foundation role that composes Journeys + Interactions + Interfaces + Foundations into a deployable surface |

Tech layers (`Frontend`, `API`, `Database`) MUST NOT be Journeys. Delivery mechanisms (pages, CLIs, MCP tools, webhooks, crons) are **Interfaces**, not Interactions.

### 1.4 Roadmap (not implemented)

**Source-file / symbol mapping** — linking territory nodes to concrete source files or symbols for finer-grained blast radius — is **not** part of this specification version. Architecture is the graph plus prescribed package roots (`get_node_implementation`). Implementations MUST NOT claim file/symbol mapping as a v0.1 feature.

---

## 2. Entity Taxonomy

The framework separates **build taxonomy** (Journey, Interaction, Interface, Foundation) from a **defect layer** (Bug) to eliminate scope creep and prevent spaghetti dependencies.

MindPlan tracks **architecture and delivery together**. The build taxonomy is Interaction-first (screaming architecture): Journeys name capabilities; Interactions name self-contained behaviors; Interfaces name entry surfaces; Foundations hold shared substrate so behaviors stay independent of each other.

| Entity | Definition | Routing rules |
|---|---|---|
| **Journey** | A named **domain capability** — a permanent architectural boundary for related behaviors (e.g. "Table Ordering", "Billing", "Agency Site Generator"). The set of Journey titles is the product's scream. Journeys are continuous containers, not closable epics, sprints, or technical layers. | Permanent container. MUST NOT execute code directly. MUST NOT have outgoing edges. State is computed, never set manually (§4). MUST be named in domain language. |
| **Interaction** | A **self-contained behavior** initiated by any actor — user, system, scheduler, external service, CLI, or MCP client. Examples: "Split the check", "Orient on the plan", "Check integrity", "Process payment webhook payload". An Interaction is **not** a page, route, CLI, MCP toolset, or other **entry surface** — those are Interfaces. When the behavior has a UI, the Interaction package owns the **screen body** (domain + mountable view). When the behavior is CLI/MCP/Webhook/Cron, the Interaction package owns the handler/module the Interface wires. | MUST belong to one or more Journeys via `belongs_to`. MUST `depends_on` at least one Foundation. MUST NOT `depends_on` another Interaction (§5.9 Interaction Independence). MAY `leads_to` other Interactions (navigation only; not a ship gate). MUST NOT import Interface packages. **Agents MUST define the Journey before creating an Interaction** — if the user requests an Interaction that cannot be mapped to an existing Journey, the agent MUST refuse and ask the user to define the Journey first. |
| **Interface** | **How an actor enters or accesses** one or more Interactions. Examples: Page, CLI command, MCP tool surface, Webhook endpoint, Cron trigger, publish script. Interfaces have the **full build pipeline** and own `src/interfaces/<id>/`. They **mount or wire** Interaction packages; they MUST NOT own core domain logic or screen bodies. One Interface per actor surface (e.g. Waiter POS), not one Interface per screen/tab. | MUST `exposes` at least one Interaction before leaving `draft` (§5.3). MAY `depends_on` Foundations (e.g. Assembler, Adapter). MUST NOT `belongs_to` a Journey (membership is on Interactions). Ship is gated by **Behavior First** (§5.4): every exposed Interaction MUST be `stable`. Spec boilerplate: App Router (or CLI/MCP) mounts Interaction packages; Interface does not own core domain logic or screen bodies. |
| **Foundation** | **Shared substrate** with no standalone behavior: infrastructure *and* reusable product platform, organized by **role** (assembler, infra, design system, adapter — see §2.0.1). Examples: Next.js app shell, database schemas, auth, Stripe SDK, design tokens. Behaviors consume Foundations via `depends_on` without becoming them. Shared state between Interactions MUST live in Foundations. | Exists solely to be consumed by Interactions, Interfaces, or other Foundations. MUST be shipped (`stable`) before dependent Interactions can ship (Infrastructure First). MAY depend on other Foundations. MUST NOT own stakeholder-recognizable product behavior — that belongs in Interactions. Foundations are not Journey members. |
| **Bug** | A defect afflicting one or more Interactions, Interfaces, or Foundations. | MUST link to targets via `affects` (Bug → Interaction\|Interface\|Foundation). Dedicated defect lifecycle (§3.2). Does not affect Journey computation. |

### 2.0 Classification litmus (agents)

Agents MUST classify new work with these checks, in order:

1. Domain capability the product *is about*? → **Journey**
2. Self-contained behavior initiated by an actor (user/system/scheduler/CLI/MCP/…)? → **Interaction**
3. How an actor *enters* an Interaction (page, CLI, MCP tool, webhook, cron, …)? → **Interface**
4. Shared code/UI with **no** standalone behavior, only consumed by Interactions/Interfaces? → **Foundation** (then pick a **role** per §2.0.1)
5. Broken behaviour on an existing node? → **Bug**

**Litmus examples:**

- Primary button / design tokens → Foundation, Design system role. Not an Interaction.
- Next.js / Vercel Cron / Supabase Functions app shell → Foundation, Assembler role. Not a Journey named "Frontend".
- Stripe / Resend / Slack SDK wrappers → Foundation, Adapter role. Checkout/billing behaviour stays in Interactions.
- "Split the check" behaviour → Interaction (`i-checkout-split`) owns domain + mountable view. A phone page that hosts it → Interface (`if-checkout-page`) that `exposes` the Interaction and **only mounts** that view.
- MCP tools that orient / mutate the plan → Interactions (`i-orient-plan`, `i-steer-plan`) own the handlers; one Interface (`if-mcp-tools`) wires those exports.
- User-picker *behaviour* (search/select flow) → Interaction (view lives in the Interaction package); expose it from the same ordering/POS Interface rather than minting one Interface per screen. A dumb combobox with no product behaviour MAY live under the design-system Foundation instead.
- Waiter POS with floor / checkout / pickup tabs → **one** Interface exposing many Interactions. Not one Interface per tab.

**Two axes** (keep distinct):

1. **Membership** — `belongs_to`: an Interaction is part of one or more Journeys.
2. **Entry** — `exposes`: an Interface surfaces one or more Interactions to an actor.
3. **Shared substrate** — `depends_on`: Interactions and Interfaces stand on Foundations; Foundations may layer on Foundations. **Never** Interaction → Interaction.
4. **Navigation** — `leads_to`: optional Interaction → Interaction flow hints for agents and humans; cycles allowed; **not** a compiler ship gate.

### 2.0.1 Foundation roles (documentation convention)

Foundations remain a single NodeType. Agents SHOULD classify each Foundation into one **role**. Roles are **not** NodeTypes, edge types, frontmatter fields, or compiler enums — they sort substrate without polluting Journeys with tech layers.

| Role | Owns | Examples | Does not own |
|------|------|----------|--------------|
| **Assembler** | External framework/runtime that **composes** Journeys, Interactions, Interfaces, and Foundations into a deployable surface | `f-nextjs`, `f-vercel-cron`, `f-supabase-functions` | Product behaviors (Interactions), entry wiring beyond mount conventions (Interfaces) |
| **Infra** | Persistence, messaging, storage, compute plumbing, observability — including **shared state** Interactions must not own pairwise | `f-db`, `f-queue`, `f-blob-store`, `f-otel` | Product features that happen to use a DB |
| **Design system** | Tokens, typography, theme, layout primitives, and dumb presentational UI | `f-design-system` (tokens + Button, Input, Stack) | Journey-specific screen bodies (Interaction packages) and page/CLI/MCP entry (Interfaces) |
| **Adapter** | Third-party / boundary SDKs and protocol wrappers | `f-stripe`, `f-resend`, `f-slack-api` | Checkout/billing Interactions on top |

**Role discoverability:** agents SHOULD write the role as the leading tag of the Foundation's `description` — e.g. `"Assembler — Next.js app shell composing interactions and interfaces"`. This is the only place the role lives; it surfaces in `find_related_nodes`, `export_mindplan_view` labels, and graph dumps without a schema change. Missing role tags are not compiler violations (SHOULD, never MUST).

**Auth / identity:** model as **Infra** (e.g. `f-auth`) unless it is clearly a vendor adapter (`f-clerk` → Adapter). Do not invent a fifth role for it by default.

**Design system vs UI components:** keep as **one role**. If a project later needs two packages, both stay Design system role (`f-tokens` + `f-ui-kit`).

**Assembler specifics:**

- Different Journeys MAY use different assemblers (UI → Next.js; jobs → Vercel Cron / Supabase Functions).
- A Journey's assembler(s) are **derived** from member Interactions' (and their Interfaces') `depends_on` Foundations that play the Assembler role — Journeys still MUST NOT have outgoing edges.
- Interactions and Interfaces that run on a given backbone SHOULD `depends_on` that Assembler Foundation; this is guidance, not a compiler gate (Ghost Interactions still only require any Foundation `depends_on`).
- Assembler territory + thin `src/foundations/<id>/` document entrypoints, mount conventions, and env/deploy constraints — not product behaviour.

**Role litmus** (after classifying as Foundation):

1. External app/runtime that **assembles** Interactions + Interfaces into a deployable surface? → **Assembler**
2. Vendor/protocol boundary only? → **Adapter**
3. Visual language / dumb UI primitives? → **Design system**
4. Otherwise shared platform plumbing (including shared state)? → **Infra**

### 2.1 Node identifiers

Node ids MUST match the pattern `^[a-z0-9][a-z0-9-_]*$` (lowercase slug style). Ids are globally unique across all types. Recommended convention: prefix by type (`j-`, `f-`, `i-`, `if-`, `bug-`), e.g. `j-ordering`, `f-db-core`, `i-checkout-split`, `if-mcp-tools`, `bug-race`.

### 2.2 Edge taxonomy

Exactly five edge types exist. An edge is a directed triple `(source, target, type)`. There is no version-lineage edge type: a Foundation, Interaction, or Interface evolves in place under its **stable id** via the `next.mdx` slot (§3.6), so there is nothing for a graph edge to link.

| Edge type | Legal shape | Meaning |
|---|---|---|
| `belongs_to` | Interaction → Journey | Membership. An Interaction MAY have multiple `belongs_to` edges when the behaviour spans domain capabilities. |
| `depends_on` | Interaction → Foundation, Interface → Foundation, Foundation → Foundation | Composition / shared substrate. The source cannot ship without the target's Foundations being `stable` (Infrastructure First for Interactions; Behavior First also requires Foundation deps for Interfaces). **NEVER** Interaction → Interaction. |
| `exposes` | Interface → Interaction | Entry. The Interface is how an actor reaches the Interaction. |
| `leads_to` | Interaction → Interaction | Navigation / flow hint only. Cycles **allowed**. Not a ship gate; not implementation dependency. |
| `affects` | Bug → Interaction, Bug → Interface, Bug → Foundation | Affliction. Open Bugs drive `unstable` production posture (§3.5). |

All other shapes MUST be rejected, specifically including:

- Journey → anything (Journeys are containers; they have no outgoing edges)
- Interaction → Interaction via `depends_on` (Interaction Independence — §5.9)
- `depends_on` targeting a Journey, Interaction, Interface, or Bug (except Foundation → Foundation and Interaction/Interface → Foundation)
- `belongs_to` from a Foundation, Interface, Journey, or Bug
- `exposes` from anything other than an Interface, or targeting a non-Interaction
- `leads_to` from/to anything other than Interaction → Interaction
- `affects` from anything other than a Bug, or targeting a Journey
- `depends_on` from a Bug or Journey
- self-links (`source == target`) for any edge type except where explicitly allowed — self-links MUST be rejected for all types
- duplicate edges (same source, target, and type)

The `depends_on` subgraph MUST remain acyclic. Implementations MUST reject `depends_on` cycles at link time (Foundation→Foundation only, given Interaction Independence). The `leads_to` subgraph MAY contain cycles; cycle detection MUST NOT apply to `leads_to`.

While a Foundation, Interaction, or Interface has an open `next.mdx`, edge writes from that node (`belongs_to` / `depends_on` / `exposes` / `leads_to` as applicable) MUST target the `next` slot's proposed edges rather than the live `current.mdx` edge arrays (§6.2, §8.2 `link_nodes`) — the live node keeps serving its existing edges until the evolution ships and promotes.

There is **no Dependency Closure** rule and **no** `link_dependent` flag. Linking an Interaction into a Journey does not auto-link other Interactions; Navigation (`leads_to`) and membership are independent decisions.

---

## 3. State Machines

### 3.1 Build pipeline (Foundation / Interaction / Interface)

Foundations, Interactions, and Interfaces move through a manual build pipeline, then enter production via `ship`:

| # | State | Meaning |
|---|---|---|
| 1 | `draft` | Ideation; scope written in `current.mdx` (or `next.mdx` while evolving, §3.6) |
| 2 | `ready` | Pre-flight passed (Interaction: Journey + Foundation linked; Interface: at least one `exposes`) |
| 3 | `in-progress` | Active execution; Atomic Ops checked off |
| 4 | `in-review` | Frozen pending external review (human or another agent), PR approval, or CI gate |
| 5 | `stable` / `unstable` | Computed production posture; entered via `ship`, never set manually (§3.5) |
| 6 | `cancelled` | Pre-ship abandon (from `draft`/`ready`/`in-progress`/`in-review` only); terminal |
| 7 | `deprecated` | Retired (from `stable`/`unstable` only) |

**Ship transition:** `update_node_status(..., "ship")` from `in-review` sets `shipped_at` and computes `stable` or `unstable` (§3.5). There is no manual `active` state. Agent playbooks MUST treat `in-review` as an **External Review gate**: the implementing agent MUST NOT call `ship` (or Bug `resolved`) on its own work — an independent Reviewer agent (spawned subagent or separate session) reviews first, typically via an orchestrated Review loop. Findings travel in the Reviewer’s structured message to the parent; playbooks MUST NOT require writing review feedback into territory files. The server does not enforce reviewer identity.

**Cancel transition:** `update_node_status(..., "cancelled")` abandons a Foundation, Interaction, or Interface that never shipped. It is blocked while `next.mdx` is open, or while any **active** (non-`cancelled`/`deprecated`/`resolved`/`wontfix`) node still `depends_on` this node (or, for Interactions, while an active Interface still `exposes` it — implementations SHOULD reject cancel when active dependents of either edge kind exist). Packages and territory folders are left on disk. There is no uncancel in v1 — cancelled is terminal like `deprecated`.

| From \ To | draft | ready | in-progress | in-review | stable/unstable | cancelled | deprecated |
|---|---|---|---|---|---|---|---|
| **draft** | — | ✔ | ✘ | ✘ | ✘ | ✔ | ✘ |
| **ready** | ✔ | — | ✔ | ✘ | ✘ | ✔ | ✘ |
| **in-progress** | ✘ | ✔ | — | ✔ | ✘ | ✔ | ✘ |
| **in-review** | ✘ | ✘ | ✔ | — | ✔ | ✔ | ✘ |
| **stable/unstable** | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✔ |
| **cancelled** | ✘ | ✘ | ✘ | ✘ | ✘ | — | ✘ |
| **deprecated** | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | — |

**Exception — `force_unship` (Rule 11):** a dedicated recovery tool may clear `shipped_at` and move a `stable`/`unstable` Foundation/Interaction/Interface to `draft`/`ready`/`in-progress`/`in-review` only when the caller passes `confirm: "unship:<node_id>"` after explicit human confirmation. This is not a normal transition and MUST NOT be used as a substitute for `open_next` evolution.

### 3.2 Bug lifecycle

| State | Meaning |
|---|---|
| `open` | Reported; repro in `current.mdx` |
| `triaged` | Validated; linked via `affects`; severity optional |
| `fixing` | Fix in progress |
| `in-review` | Fix PR open |
| `resolved` | Fix verified and shipped — terminal |
| `wontfix` | Closed without fix — terminal |

| From \ To | triaged | fixing | in-review | resolved | wontfix | open (retreat) |
|---|---|---|---|---|---|---|
| **open** | ✔ | ✘ | ✘ | ✘ | ✔ | — |
| **triaged** | — | ✔ | ✘ | ✘ | ✘ | ✔ |
| **fixing** | ✘ | — | ✔ | ✘ | ✘ | ✔ |
| **in-review** | ✘ | ✔ | — | ✔ | ✘ | ✘ |
| **resolved/wontfix** | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |

### 3.3 Atomic Operations

An Atomic Operation is a PR-sized unit of work expressed as a Markdown task-list item in `current.mdx` (or `next.mdx` while a Foundation/Interaction/Interface evolution is open, §3.6):

```markdown
- [ ] Implement POST /orders endpoint
- [x] Write migration for orders table
```

Recognized syntax: a list item beginning with `-`, `*`, or `+`, followed by `[ ]` (open) or `[x]` (complete). Checkbox state is parsed from the relevant file (`current.mdx`, or `next.mdx` when evolving) at validation time — the file on disk is the source of truth for completion, not the graph.

JSX in the file is invisible to this check (§6.4.4): only Markdown task-list syntax gates completion.

### 3.4 Bug initial state

Bugs are created in state `open`. All other node types start in `draft`.

### 3.5 Computed production states (`stable` / `unstable`)

After `ship`, a Foundation, Interaction, or Interface's `state` field holds a **computed** production posture:

| State | Condition |
|---|---|
| `stable` | `shipped_at` is set and zero **open** Bugs `affects` this node |
| `unstable` | `shipped_at` is set and at least one open Bug `affects` this node |

**Open bug** = Bug in `open`, `triaged`, `fixing`, or `in-review`.

Recomputed after: Bug status changes, `affects` link/unlink, and `ship`. Never set manually.

### 3.6 Versioning

MindPlan uses a **stable-id evolution model**: a Foundation, Interaction, or Interface's `id` never changes across its lifetime, and there is no successor node, no `supersedes` edge, and no dependent relinking. A node's history — including every past evolution — lives in the git history of its `current.mdx`, which **is** the version lineage; there is nothing else to consult.

Shipped Foundations, Interactions, and Interfaces (`stable`/`unstable`) are never reset to `draft` in place, and they are never replaced by a new node. To evolve one, call `open_next`, which:

1. verifies the node is `stable` or `unstable` and has no existing `next.mdx` (§5.11),
2. copies `current.mdx`'s body (and, for `attachments/`, nothing automatically — new assets go in a fresh `next-attachments/`) into a new `next.mdx` in pipeline state `draft`,
3. proposes the node's current outgoing edges (`belongs_to` / `depends_on` / `exposes` / `leads_to` as applicable) as the next slot's starting edges (mutable independently of `current`'s edges from this point on, §2.2).

The **live `current.mdx` keeps serving** (`stable`/`unstable`, same id, same edges) for the entire duration of the build on `next`. Dependents' edges continue to resolve to the same id throughout — there is nothing to relink, because the id never moves.

`next.mdx` runs through the same manual build pipeline as a first build (`draft → ready → in-progress → in-review`, §3.1), scoped to the `next` slot: Ghost Interaction / Ghost Interface and Completion Check are evaluated against `next.mdx`'s proposed edges and checkboxes, not `current.mdx`'s.

When `next` is `in-review` and the caller calls `update_node_status(..., "ship")`:

1. Infrastructure First / Behavior First (as applicable) are evaluated against **`next`'s** proposed edges,
2. Completion Check is evaluated against **`next.mdx`**,
3. on success, the server **promotes `next` over `current`**: it copies `next.mdx`'s body, title, description, and proposed edges onto `current.mdx` (same `id`, same `type`, fresh `updated_at`/`shipped_at`), merges `next-attachments/` into `attachments/`, computes `stable`/`unstable` from open Bugs (§3.5), and deletes `next.mdx` and `next-attachments/`.

The node's `id` and production posture continue uninterrupted — dependents never see a different id and never need relinking. To abandon an in-flight evolution without shipping it, call `discard_next`: it deletes `next.mdx`/`next-attachments/` and leaves `current.mdx` completely untouched.

A node MUST NOT have more than one open `next.mdx` at a time (§5.11). `get_blast_radius` on a node with an open evolution reports the **live** `current.mdx`'s dependents and (for Interactions) live reachability — the same set regardless of whether `next` exists, since the id never changes.

#### Territory Completeness

`current.mdx` MUST describe the **complete** contract of what the node *is* in the repository now — purpose, living spec (PRD / Execution Logic / Shared Substrate Spec), and durable acceptance criteria that match shipped (or in-flight pre-ship) reality. It MUST NOT be reduced to a changelog, a “what changed last” narrative, or a stub that only points at a package path.

When `open_next` seeds `next.mdx` from `current.mdx`, authors MUST edit `next` into a **complete proposed successor** of that same contract: add, change, or remove sections in place until the body describes the desired post-ship state. Because `ship` promotes `next` over `current` wholesale, a delta-only or changelog-only `next` body is illegal — it would leave `current.mdx` describing only the latest change instead of the repository’s full state for that node.

Atomic Operations / checklist items on `next.mdx` MAY be scoped to the current evolution (reset or replaced when opening `next`). Spec sections (Purpose, PRD, Execution Logic, Shared Substrate Spec, Acceptance Criteria, and equivalents) MUST remain a full successor document, not an evolution-only diff.

Agents MUST verify Territory Completeness before transitioning `next` to `in-review` (playbook review check). There is no automated compiler gate for this rule.

---

## 4. Computed Journey States

Journeys are continuous and never technically "finished." Their states MUST NOT be set manually; the server derives them from the states of the Interactions linked to the Journey via `belongs_to`, and recomputes them after **every** mutation that can affect the result (status updates, linking, and unlinking).

For a given Journey, let:

- `S` = count of member Interactions with `shipped_at` set (state `stable` or `unstable`)
- `P` = count of member Interactions that are **actively building**, where an Interaction counts toward `P` if either:
  - it has no `shipped_at` and its `current.mdx` state is `in-progress` or `in-review`, **or**
  - it is shipped (`stable`/`unstable`) and has an open `next.mdx` whose pipeline state is `in-progress` or `in-review` (§3.6)

| State | Condition | Reading |
|---|---|---|
| `evolving` | `S > 0` and `P > 0` | Live and actively being expanded — includes shipped Interactions whose `next` evolution is mid-build. |
| `stable` | `S > 0` and `P = 0` | Live and untouched. |
| `incubation` | `S = 0` and `P > 0` | The V1 build phase. |
| `draft` | `S = 0` and `P = 0` | Resting state. |

Notes:

- **Bugs do not affect Journey states.** An Interaction flipping `stable` → `unstable` does not change its Journey.
- Interfaces do not contribute to Journey computation — only member Interactions do.
- `in-review` counts toward `P`, whether on `current.mdx` (unshipped Interaction) or `next.mdx` (evolution of a shipped Interaction).
- A shipped Interaction with no open `next.mdx`, or whose `next.mdx` is still `draft`/`ready`, contributes to `S` but not `P`.
- Interactions in `draft`, `ready`, `cancelled`, or `deprecated` (and not evolving) contribute to neither count.
- Any attempt to set a Journey's state through the status-update tool MUST be rejected.
- When a recomputation changes a Journey's state, the server MUST persist the new state to the Journey's `current.mdx` frontmatter, and SHOULD report the change in the tool response (`journeys_recomputed`).

---

## 5. Architectural Guardrails (The Compiler Rules)

The MCP server enforces deterministic rules **before** any state mutation is written to disk, physically blocking the AI (or developer) from executing out of bounds. Validation is fail-fast: the first violated rule aborts the mutation and nothing is persisted.

### 5.1 Error contract

Every rejection MUST be surfaced as a tool error whose text begins with the exact prefix:

```
Blocked: <reason>
```

The reason MUST name the violated rule, the offending node(s) and state(s), and — where applicable — the remediation (e.g. which tool call to make first). Agents MUST treat `Blocked:` responses as hard failures: fix the plan, do not retry blindly.

### 5.2 Rule 1 — No Ghost Interactions

An Interaction MUST NOT transition to `ready` or `in-progress` unless, at validation time:

1. it has at least one `belongs_to` edge to a Journey, **and**
2. it has at least one `depends_on` edge to a Foundation.

Rationale: behaviour that belongs to no capability and stands on no infrastructure is unroutable and unreviewable — it must not enter execution.

### 5.3 Rule 2 — No Ghost Interfaces

An Interface MUST NOT transition to `ready` or `in-progress` unless, at validation time, it has at least one `exposes` edge to an Interaction.

Rationale: an entry surface with nothing to enter is hollow. Foundation `depends_on` on an Interface is optional (Assembler/Adapter wiring) and is **not** required by this gate.

### 5.4 Rule 3 — Infrastructure First

An Interaction MUST NOT `ship` (transition from `in-review` to production) unless **every** Foundation reachable via its direct `depends_on` edges is in state `stable`. The rejection message MUST enumerate each non-stable dependency with its current state.

Rationale: concrete must be poured before the roof is built. A behaviour cannot go live on substrate that is not stable in production.

(There are no Interaction→Interaction `depends_on` edges; Infrastructure First does not walk other Interactions.)

### 5.5 Rule 4 — Behavior First

An Interface MUST NOT `ship` unless:

1. **every** Interaction reachable via its direct `exposes` edges is in state `stable`, **and**
2. **every** Foundation reachable via its direct `depends_on` edges (if any) is in state `stable`.

The rejection message MUST enumerate each non-stable exposed Interaction and/or Foundation dependency with its current state.

Rationale: an entry surface must not go live while the behaviours it exposes (or the substrate it mounts on) are unfinished.

### 5.6 Rule 5 — The Completion Check

A Foundation, Interaction, or Interface MUST NOT transition to `ship` while its active territory file (`current.mdx`, or `next.mdx` while evolving) contains one or more unchecked Atomic Operations (`[ ]`). A Bug MUST NOT transition to `resolved` while unchecked items remain. The rejection message MUST include the count of open checkboxes.

`in-review` MUST NOT require a complete checklist. Agents enter `in-review` with open DoD items, then tick them while in review.

**Open Checklist While Building.** A territory body patch or checkbox toggle that would leave at least one checkbox and zero unchecked boxes MUST be rejected while the active slot is `draft`, `ready`, or `in-progress` (Bug: `open`, `triaged`, or `fixing`). The rejection MUST tell the agent to leave an Atomic Op open or call `update_node_status` → `in-review` first. The server MUST NOT auto-advance state.

Rationale: all boxes checked means build is done — that posture belongs in `in-review` or later. Completing the checklist while still “building” is an invalid state (either DoD is incomplete, or the agent forgot to request review).

### 5.7 Rule 6 — No Ghost Bugs

A Bug MUST NOT transition to `triaged` or `fixing` unless it has at least one `affects` edge to an Interaction, Interface, or Foundation at validation time.

### 5.8 Rule 7 — Computed Journeys

Manual status mutation of a Journey MUST be rejected (§4). This is a compiler rule, not a convention.

### 5.9 Rule 8 — Computed Stability

Manual mutation of a Foundation, Interaction, or Interface to `stable` or `unstable` MUST be rejected. Production posture is computed per §3.5 after `ship` and whenever open Bugs change.

### 5.10 Rule 9 — Taxonomy enforcement and Interaction Independence

Edge creation MUST validate:

- both node ids exist in territory,
- the edge shape is legal per §2.2,
- the edge is not a self-link and not a duplicate,
- **Interaction Independence:** `depends_on` from an Interaction MUST NOT target another Interaction — share state through Foundations instead,
- `depends_on` edges do not create a cycle (§2.2). Cycle detection MUST use the **effective** `depends_on` set for each node: `next.depends_on` while that node has an open `next.mdx`, otherwise live `depends_on`. Ship from next `in-review` MUST re-assert effective acyclicity before promoting.
- `leads_to` MUST NOT be subjected to cycle rejection.

There is **no Dependency Closure** rule. Implementations MUST NOT accept or document a `link_dependent` parameter on `link_nodes`.

### 5.11 Rule 10 — Version Lineage (stable-id evolution)

`open_next` MUST validate:

- the node exists and is type `Foundation`, `Interaction`, or `Interface`,
- the node is in state `stable` or `unstable` (shipped) — Journeys, Bugs, and unshipped pipeline nodes MUST be rejected,
- the node has no existing `next.mdx` — at most one open evolution per node at a time; the rejection message MUST name the `next` slot's current pipeline state and point to `ship` (from `next` in-review) or `discard_next` as the way to clear it.

`discard_next` MUST validate:

- the node has an existing `next.mdx` to delete.

While `next.mdx` is open, the manual build pipeline transitions (`draft → ready → in-progress → in-review`) and Ghost / Completion rules apply to the `next` slot's own state, checkboxes, and proposed edges — not to `current.mdx`, which is untouched and keeps serving. A node with an open `next.mdx` MUST NOT be transitioned to `deprecated`; `discard_next` (or shipping the evolution) MUST run first.

On successful `update_node_status(..., "ship")` for a node whose `next.mdx` is `in-review`, the server MUST:

1. re-validate Infrastructure First / Behavior First and Completion Check against `next`'s proposed edges and checkboxes,
2. **promote**: copy `next.mdx`'s body, title, description, and proposed edges onto `current.mdx` under the unchanged `id`, merge `next-attachments/` into `attachments/`, compute the new `stable`/`unstable` from open Bugs (§3.5), and delete `next.mdx`/`next-attachments/`.

There is no successor id, no relinking step, and no predecessor to auto-deprecate: the `id` never changes, so every existing edge that already targets this node continues to resolve correctly through and after the promotion.

Rationale: versioning models replacement without downtime during the build, without ever forcing dependents to discover and re-point at a new id. Git history of `current.mdx` — not a graph edge — is the audit trail for what a node's evolution changed at each ship.

### 5.12 Rule 11 — Force Unship (mistaken ship recovery)

`force_unship` MAY reverse a mistaken Foundation/Interaction/Interface ship. It is the only legal path from `stable`/`unstable` back to a pre-ship execution state. The server MUST:

1. require `confirm` exactly equal to `unship:<node_id>` — any other value MUST be rejected with a message that tells the agent to ask the user and not invent confirmation,
2. accept only Foundation/Interaction/Interface nodes currently in `stable` or `unstable`,
3. reject while `next.mdx` is open (`discard_next` first),
4. reject while any **direct** `depends_on` dependent is itself `stable` or `unstable` (enumerate them; force-unship or deprecate dependents first so Infrastructure First remains coherent),
5. accept `new_status` only in `draft | ready | in-progress | in-review` (default `ready` when omitted),
6. apply Ghost Interaction / Ghost Interface / Completion Check gates appropriate to the target state (same as a normal transition into that state),
7. clear `shipped_at` on `current.mdx`, set `state` to the target, recompute Journey states, and refresh `mindplan/map.md`.

Agents MUST obtain an explicit human yes in the conversation before calling `force_unship`. Agents MUST NOT invent or “helpfully” supply `confirm`. Journeys and Bugs MUST be rejected. Manual `stable`/`unstable` remains forbidden (§5.9).

### 5.13 Enforcement ordering

For a status mutation the compiler MUST evaluate, in order:

1. node exists → 2. node is not a Journey → 3. resolve the active slot (`next.mdx` if open, else `current.mdx`) → 4. target state is valid for that slot → 5. transition is legal per §3 (or §3.6 next-pipeline transitions) → 6. Rules 1–6 (type-specific, evaluated against the active slot) → **write** → 7. on `ship` from `next` in-review, promote `next` over `current` per Rule 10 (§5.11) → 8. recompute stability (§3.5) → 9. recompute Journey states (§4) → 10. synchronize frontmatter.

For `force_unship`: validate Rule 11 (§5.12), clear `shipped_at`, write pre-ship `state`, recompute Journey states, synchronize frontmatter.

For `link_nodes` / `unlink_nodes` involving `affects`: validate §5.10, write edge, recompute stability for affected targets, recompute Journeys if applicable, mirror frontmatter.

For `link_nodes` involving `belongs_to`, `depends_on`, `exposes`, or `leads_to`: validate §5.10 (including Interaction Independence and `depends_on` cycle check where applicable), write edge to the active slot (`next` if open, else `current`), recompute Journey states when membership changes, mirror frontmatter.

For `open_next`: validate Rule 10 (§5.11), copy `current.mdx` body and outgoing edges into a new `next.mdx` in `draft`; `current.mdx` and its edges are unchanged.

For `discard_next`: validate Rule 10 (§5.11), delete `next.mdx`/`next-attachments/`; `current.mdx` is unchanged.

---

## 6. Territory File Format

### 6.1 `current.mdx` structure

Every entity's `current.mdx` MUST begin with YAML frontmatter followed by an MDX body (Markdown plus optional JSX per §6.4). An open `next.mdx` (Foundation/Interaction/Interface only, §3.6) uses the same frontmatter+body shape, scoped to the fields in the table below marked "also on `next.mdx`":

```mdx
---
id: i-checkout-split
type: Interaction
title: "Split & pay checkout"
description: "Diner splits and pays the bill from their phone"
state: in-progress
created_at: 2026-07-14T06:00:00.000Z
updated_at: 2026-07-14T07:00:00.000Z
belongs_to:
  - j-ordering
depends_on:
  - f-db-core
leads_to:
  - i-tip-selection
---

# Split & pay checkout

Diner splits and pays the bill from their phone.

<StateBadge />

## Execution Logic

Step-by-step behaviour…

## Checklist

- [x] Domain API against Foundations (no Interaction→Interaction `depends_on`)
- [ ] Mountable view exported from package
- [ ] View accepts shell/nav as props/callbacks — does not import Interface packages

## Attachments

![wireframe](attachments/checkout-wireframe.png)
<Attachment file="checkout-flow.pdf" caption="Full payment flow" />
```

Frontmatter fields:

| Field | Type | Written by | Notes |
|---|---|---|---|
| `id` | string | server, at creation | Immutable for the node's lifetime, including every evolution. MUST equal folder name. Also on `next.mdx`. |
| `type` | `Journey \| Foundation \| Interaction \| Interface \| Bug` | server, at creation | Immutable. Also on `next.mdx`. |
| `title` | string (JSON-quoted) | territory | Human-readable. Stored only in frontmatter. Also on `next.mdx` (proposed title, promoted on ship). |
| `description` | string (JSON-quoted) | territory | Short summary. Stored only in frontmatter. Also on `next.mdx` (proposed description, promoted on ship). |
| `state` | string | **server only** | On `current.mdx`: build pipeline, computed production, or Bug lifecycle. On `next.mdx`: the pipeline sub-state of the evolution (`draft \| ready \| in-progress \| in-review`, §3.6) — never `stable`/`unstable`/`deprecated`. Patched by MCP on accepted transitions. |
| `created_at` | ISO-8601 | server, at creation | Immutable; present only on `current.mdx` and never rewritten by an evolution. |
| `updated_at` | ISO-8601 | **server only** | Touched on every accepted state or edge mutation to that slot. Also on `next.mdx`. |
| `shipped_at` | ISO-8601 | **server only** | `current.mdx` only. Optional; set on `ship` (first build or promotion of `next`, §3.6). |
| `severity` | `low \| medium \| high \| critical` | optional | Bug nodes only; informational in v1. |
| `belongs_to` | string[] | **server only** | Interaction only. Target Journey ids. Omitted when empty. On `next.mdx`: proposed edges, applied to `current.mdx` on ship. |
| `depends_on` | string[] | **server only** | Interaction, Interface, or Foundation. Target Foundation ids only (never Interaction). Omitted when empty. On `next.mdx`: proposed edges. |
| `exposes` | string[] | **server only** | Interface only. Target Interaction ids. Omitted when empty. On `next.mdx`: proposed edges. |
| `leads_to` | string[] | **server only** | Interaction only. Target Interaction ids (navigation). Omitted when empty. On `next.mdx`: proposed edges. |
| `affects` | string[] | **server only** | Bug only. Target Interaction, Interface, or Foundation ids. Omitted when empty. |

The body is free-form and owned by humans and agents. Frontmatter `title:` and `description:` are territory-owned and MAY be edited after creation (on `current.mdx` pre-ship, or on `next.mdx` at any next-pipeline state). Server-owned frontmatter fields (`state`, `updated_at`, `shipped_at`, edge arrays) MUST be written only via MCP tools.

**Shipped scope freeze:** hand-editing or `patch_node_territory` of `title`/`description` on the `current` slot of a shipped Interaction or Interface MUST be rejected — call `open_next` first. (Same freeze applies to shipped Foundations for material scope changes via playbook; Interaction/Interface freeze is the hard gate.)

Frontmatter delimiters (`---`) MUST appear before any JSX. MDX comments use `{/* ... */}` syntax; HTML comments (`<!-- -->`) are not valid MDX and MUST NOT be used in the body.

### 6.2 Frontmatter mirroring

After any accepted mutation, the server MUST rewrite server-owned fields in each affected node's territory frontmatter:

- **Status mutations:** `state:` and `updated_at:` on the transitioned node's active slot (`current.mdx`, or `next.mdx` while an evolution is open) plus every Journey whose computed state changed; `shipped_at:` on `current.mdx` when a first build or a `next` promotion ships.
- **Link/unlink:** the appropriate outgoing edge array (`belongs_to`, `depends_on`, `exposes`, `leads_to`, or `affects`) on the source node's active slot, plus `updated_at:`.
- **Opening an evolution (`open_next`):** creates `next.mdx` with `state: draft`, copied/overridden `title:`/`description:`, and proposed edge arrays from `current.mdx` at open time.
- **Discarding an evolution (`discard_next`):** deletes `next.mdx` and `next-attachments/`; `current.mdx` is untouched.
- **Ship / promotion (`update_node_status(..., "ship")`):** on a first build, writes `state:`, `updated_at:`, and `shipped_at:` on `current.mdx`. When promoting an open `next.mdx`, copies `next.mdx`'s `title:`, `description:`, and proposed edge arrays onto `current.mdx`, sets `state:` to the computed `stable`/`unstable`, refreshes `updated_at:`/`shipped_at:`, and deletes `next.mdx`/`next-attachments/`. There is no other node's frontmatter to update — the `id` never changes.

Edge arrays use YAML block-list syntax. Empty arrays MUST be omitted from the file. If the file is missing or has no frontmatter, mirroring is skipped silently.

### 6.3 Scaffolding templates

`create_node` MUST scaffold the entity folder with a type-appropriate `current.mdx` and an empty `attachments/` directory (with `.gitkeep` so the folder is versionable). `next.mdx` and `next-attachments/` are never scaffolded by `create_node` — they are created only by `open_next` on an already-shipped Foundation/Interaction/Interface (§3.6, §8.2):

- **Journey** — Overview section (domain capability + behaviors it owns), Linked Interactions note, Attachments note. No checklist (Journeys have no completion gate). No implementation package.
- **Foundation** — Shared Substrate Spec section (role tag belongs in frontmatter `description` at create time — Assembler | Infra | Design system | Adapter), Checklist (3 default Atomic Ops), Attachments note. Also scaffolds `src/foundations/<id>/` (§1.2).
- **Interaction** — Purpose / Actor & Trigger / Inputs & Outputs / PRD, Checklist. Default Atomic Ops (Kind-aware): Domain API against Foundations; exportable behavior surface (UI: mountable view; CLI/MCP/Webhook/Cron: handler/module); surface does not import Interface packages. Also scaffolds `src/interactions/<id>/` (§1.2).
- **Interface** — Kind / Exposed Interactions / Spec (boilerplate: App Router or CLI/MCP mounts Interaction packages; Interface does not own core domain or screen bodies), Checklist. Default Atomic Ops (Kind-aware): thin wiring for each `exposes` target; no duplicated domain/behavior UI; Page/UI only — shell chrome under `ui/`. Also scaffolds `src/interfaces/<id>/` (§1.2).
- **Bug** — Summary, Repro Steps, Expected/Actual, Fix Checklist (3 default Atomic Ops), Attachments note. Created in state `open` (§3.4). No implementation package.

Default checklist items are Kind-aware package-ownership placeholders (§1.2.2); teams SHOULD replace them with real PR-sized Atomic Ops during `draft` or triage, but MUST keep the Interaction-owns-surface / Interface-mounts split.

#### 6.3.1 Implementation packages

`create_node` for Interaction, Interface, and Foundation MUST create the prescribed implementation package (§1.2) with a `.gitkeep` so the folder is versionable — **unless** `implementation_packages` is `off` (§1.2.1), in which case only territory is scaffolded. The package path is derived — it is not stored in frontmatter and is not an edge.

Agents MUST place all implementation for that node under its package. Agents query the package via `get_node_implementation` (§8.1). There is no per-file affected-files list in territory — architecture is the graph plus package roots (§1.4).

Scaffolded bodies include an MDX comment noting which standard components are available. `create_node` MUST also ensure `mindplan/components/` exists at the planning root.

### 6.4 MDX Component Contract

Context files are MDX, which allows JSX components inside the Markdown body. This section defines who provides components, how names resolve, and what the compiler is allowed to depend on.

#### 6.4.1 Two component tiers

| Tier | Provided by | Purpose | Compiler visibility |
|---|---|---|---|
| **Standard library** | MindPlan (versioned with the server/spec) | Semantic elements whose meaning is identical in every MindPlan project | Reserved names; semantics defined here |
| **Project components** | Host project, in `mindplan/components/` | Domain-specific presentation (e.g. a restaurant floor-plan diagram) | Opaque — never interpreted |

Host projects MUST NOT implement or shadow standard-library components. MindPlan does not depend on the host project's stack: a project that never uses JSX is fully compliant, and the standard library requires nothing from the host `package.json`.

#### 6.4.2 Standard component set (reserved names)

The following component names are reserved across all MindPlan projects. Implementations are currently contract-only (no renderer ships with the reference implementation); a future viewer MUST implement them with these props.

| Component | Props | Semantics |
|---|---|---|
| `<AtomicOp>` | `done: boolean`, children: description | Renders an Atomic Operation. Presentation only — the gating source of truth remains the Markdown checkbox (§6.4.4). |
| `<AcceptanceCriteria>` | children: Markdown/JSX | Marks the acceptance-criteria block of the PRD for extraction by viewers and sync parsers. |
| `<Attachment>` | `file: string` (relative to `attachments/`), `caption?: string` | Typed reference to an attachment; viewers render a preview or download link. |
| `<StateBadge>` | `state?: NodeState` (defaults to the frontmatter `state`) | Renders the node's pipeline state as a badge. |
| `<DependsOn>` | `id: string` (Foundation id) | Inline reference to a Foundation dependency; viewers link to that node. Informational — `depends_on` in frontmatter is the authority. |
| `<BelongsTo>` | `id: string` (Journey id) | Inline reference to a parent Journey. Informational — `belongs_to` in frontmatter is the authority (multiple allowed). |
| `<Exposes>` | `id: string` (Interaction id) | Inline reference to an Interaction an Interface exposes. Informational — `exposes` in frontmatter is the authority. |
| `<LeadsTo>` | `id: string` (Interaction id) | Inline reference to navigation. Informational — `leads_to` in frontmatter is the authority. |
| `<Affects>` | `id: string` (Interaction, Interface, or Foundation id) | Inline reference to an afflicted node. Informational — `affects` in frontmatter is the authority. |
| `<ReproSteps>` | children | Marks repro steps for viewers. |
| `<Severity>` | `level: low \| medium \| high \| critical` | Renders bug severity. |
| `<ExpectedActual>` | `expected`, `actual` strings | Expected vs actual behaviour. |

Future spec versions MAY extend this set; they MUST NOT change the semantics of existing names.

#### 6.4.3 Project components

- Live in `mindplan/components/` at the planning root (any file layout inside is the project's business; `.tsx`/`.jsx` recommended).
- MAY be referenced from any `current.mdx`/`next.mdx` in that project.
- MUST NOT use reserved names from §6.4.2.
- Are ignored entirely by the MCP server and the compiler rules. A missing or broken project component MUST NOT block any state transition.

#### 6.4.4 Compiler independence (normative)

The compiler MUST NOT parse, resolve, or evaluate JSX. All guardrails operate exclusively on:

1. YAML frontmatter (state mirroring, §6.2), and
2. Markdown task-list syntax (Completion Check, §3.3/§5.6).

Consequences:

- JSX anywhere in the body — known or unknown, well-formed or broken — has no effect on any accept/reject decision.
- `<AtomicOp done={false} />` does not count as an open checkbox. Work items that must gate `in-review`/`ship` (pipeline nodes) or `in-review`/`resolved` (Bugs) MUST be expressed as `- [ ]` Markdown items.
- Determinism (§9.1) is preserved: rule evaluation never depends on component resolution, a renderer, or the host project's toolchain.

#### 6.4.5 Rendering

Rendering MDX is out of scope for the MCP server. Viewers (docs sites, dashboards, IDE previews) resolve reserved names to the standard library and all other names to `mindplan/components/`. Until a viewer exists, agents and humans read context files as plain text; the JSX reads as self-describing markup.

---

## 7. Graph Assembly

There is no central graph file. At runtime the server scans `mindplan/<type>s/<id>/current.mdx` frontmatter to assemble nodes and expands outgoing edge arrays into flat edge triples. When a Foundation/Interaction/Interface folder also has a `next.mdx`, the server additionally parses it into that node's `next` slot (§3.6); `next.mdx`'s proposed edges are **not** expanded into graph edges — only `current.mdx`'s edges are live.

### 7.1 Runtime graph shape

`get_mindplan_graph` returns:

```jsonc
{
  "version": 1,
  "nodes": [ /* from frontmatter §6.1, each optionally carrying a "next" slot */ ],
  "edges": [
    { "source": "i-checkout-split", "target": "j-ordering", "type": "belongs_to" },
    { "source": "i-checkout-split", "target": "f-db-core", "type": "depends_on" },
    { "source": "if-checkout-page", "target": "i-checkout-split", "type": "exposes" },
    { "source": "i-checkout-split", "target": "i-tip-selection", "type": "leads_to" },
    { "source": "bug-race", "target": "i-checkout-split", "type": "affects" }
  ]
}
```

`version` identifies the schema generation (currently `1`). It is a constant reported by the server — not persisted to disk. Breaking Interaction-centric changes keep `GRAPH_VERSION` at `1` while the package is unreleased.

### 7.2 Edge persistence rule

Outgoing edges are stored **only on the source node** in frontmatter:

| Edge type | Source type | Frontmatter field |
|---|---|---|
| `belongs_to` | Interaction | `belongs_to: [journey-id, …]` |
| `depends_on` | Interaction, Interface, Foundation | `depends_on: [foundation-id, …]` |
| `exposes` | Interface | `exposes: [interaction-id, …]` |
| `leads_to` | Interaction | `leads_to: [interaction-id, …]` |
| `affects` | Bug | `affects: [interaction-or-interface-or-foundation-id, …]` |

Journeys have no outgoing edges. Incoming relationships are derived at scan time (e.g. a Journey discovers member Interactions by scanning all Interaction `belongs_to` arrays). A `next.mdx`'s edge arrays are proposed edges scoped to that node's evolution (§3.6) — they live in the same frontmatter shape but are not part of the assembled graph's edge triples until promoted onto `current.mdx` at ship time.

### 7.3 Invariants

- Every edge endpoint MUST reference an existing territory node (folder + `current.mdx`).
- Edge triples are unique per `(source, target, type)`.
- Edge arrays MUST only appear on node types permitted by §7.2.
- `next.mdx` MUST only exist alongside a `current.mdx` for the same Foundation/Interaction/Interface id and MUST NOT introduce a new `id`.

---

## 7.4 Graph views (projections)

Exporters MAY render a deterministic typed-graph projection of the assembled graph for humans (PRs, docs, local preview). Views MUST NOT become a second write path for node records or edges — frontmatter remains the sole graph authority (§7, §9.3).

**Exception — auto-persisted Mermaid snapshot:** after every successful graph mutation (`create_node`, `link_nodes`, `unlink_nodes`, `open_next`, `discard_next`, `update_node_status`, `force_unship`), the server MUST write a full Mermaid projection to `mindplan/map.md`. That file is derived output (regenerated, not hand-edited); it MUST NOT be read back as graph state. On-demand projections via MCP `export_mindplan_view` (§8.1) and CLI `mindplan-mcp view` remain available and do not replace `map.md` unless the caller writes a file explicitly.

Reference formats: Mermaid (`flowchart`) and Graphviz DOT.

### Layout conventions

| Element | Rendering |
|---|---|
| Journey | Cluster / subgraph (container; no outgoing edges) |
| Interaction | Node inside every Journey it `belongs_to` (multi-membership: one instance per Journey in Mermaid; DOT places the node in the lexicographically first Journey and annotates others) |
| Interface | Entry-surface nodes (often outside Journey clusters or linked via `exposes`) |
| Foundation | Shared infrastructure cluster |
| Bug | Overlay node; `affects` drawn dashed |
| `depends_on` | Solid dependency arrow |
| `exposes` | Distinct arrow (e.g. dashed or labeled) from Interface → Interaction |
| `leads_to` | Navigation arrow between Interactions (cycles OK) |
| `belongs_to` | Encoded by clustering — omitted as an edge in diagrams |
| Node label | `id · title · state` |

A node with an open `next.mdx` renders once, at its `current.mdx` state and id — `next` is an in-flight territory slot, not a second node, and has no dedicated diagram representation in v1.

Interactions with no `belongs_to` into a Journey present in the view appear under an **Unassigned interactions** band.

### Filters

By default, views MUST exclude:

- nodes in state `deprecated` or `cancelled`
- Bugs in terminal states `resolved` or `wontfix`

Pass `include_retired: true` (MCP) or `--include-retired` (CLI) to include them.

Optional `focus` limits the view to that node plus its 1-hop linked neighborhood (same neighborhood definition as `find_related_nodes`).

MDX component rendering (§6.4) and external board sync (§10) remain separate concerns and are out of scope for graph-view exporters.

---

## 8. MCP Tool Contract

The server exposes exactly fifteen tools over stdio. All inputs are validated with zod; all failures follow the §5.1 error contract. Responses are JSON text payloads.

### 8.1 Read tools

#### `get_mindplan_graph`

- **Input:** none.
- **Output:** `{ version, nodes, edges }` assembled from territory frontmatter (§6.1, §7).
- **Errors:** none beyond I/O failures.

#### `export_mindplan_view`

Exports a deterministic typed-graph projection (§7.4) as Mermaid or DOT. Prefer `find_related_nodes` for agent orientation JSON; use this when a human diagram / architecture map is needed. Note: successful graph mutations also auto-write the full Mermaid projection to `mindplan/map.md` (§7.4); this tool does not itself write that file.

- **Input:**
  - `format` (`mermaid` \| `dot`, optional, default `mermaid`)
  - `focus` (slug, optional) — when set, export focus + 1-hop neighborhood only
  - `include_retired` (boolean, optional, default `false`) — include deprecated/cancelled nodes and closed bugs
- **Output:**

```jsonc
{
  "format": "mermaid",
  "focus": null,           // or node id when focus was requested
  "include_retired": false,
  "node_count": 12,
  "edge_count": 15,
  "diagram": "flowchart TB\n..."
}
```

- **Errors:** unknown `focus` node_id.

#### `find_related_nodes`

Scoped orientation for agents: rank nodes by a text query and return the focus node plus its 1-hop linked neighborhood. Does not load full `current.mdx`/`next.mdx` bodies. Does not include transitive blast radius (use `get_blast_radius`).

- **Input:**
  - `query` (string, optional) — free text; tokenized for ranking.
  - `node_id` (slug, optional) — force focus to this node when it exists.
  - `type` (`Journey|Foundation|Interaction|Interface|Bug`, optional) — filter candidates before ranking.
  - `limit` (integer 1–20, optional, default `5`) — max ranked matches returned.
  - At least one of non-empty `query` or `node_id` is required.
- **Ranking:** scan territory via `loadGraph()` each call (no in-memory cache, no embeddings). Tokenize `query` on non-alphanumeric characters (lowercase). Score: exact `id` match ≫ `id` substring ≫ title token hits ≫ description token hits. Sort by score descending, then `id` ascending. Nodes with score `0` are omitted from `matches`.
- **Focus selection:** if `node_id` is provided, `focus` is that id (after existence check). Otherwise `focus` is the highest-scoring match, or `null` when there are no matches.
- **Neighborhood:** all edges where `source` or `target` is `focus` (all five edge types); `nodes` includes the focus and every endpoint of those edges. Summaries only: `id`, `type`, `state`, `title`, `description`.
- **Output:**

```jsonc
{
  "query": "checkout split payment",
  "matches": [
    { "id": "i-checkout-split", "type": "Interaction", "state": "in-progress", "title": "...", "description": "...", "score": 12 }
  ],
  "focus": "i-checkout-split",
  "nodes": [ /* focus + 1-hop neighbors */ ],
  "edges": [ /* edges incident to focus */ ]
}
```

- **Errors:** neither `query` nor `node_id`; unknown `node_id`. Empty matches with a valid query and no `node_id` is success: `focus: null`, empty `nodes`/`edges`.

#### `get_blast_radius`

- **Input:** `node_id` (slug).
- **Output:**

```jsonc
{
  "node_id": "i-checkout-split",
  "affected": [
    { "id": "if-checkout-page", "type": "Interface", "state": "ready", "distance": 1 }
  ],
  "journeys_at_risk": ["j-ordering"],
  // present when focus is an Interaction:
  "reachability": {
    "exposing_interfaces": [{ "id": "if-checkout-page", "type": "Interface", "state": "ready", "title": "...", "description": "..." }],
    "containing_journeys": [{ "id": "j-ordering", "type": "Journey", "state": "incubation", "title": "...", "description": "..." }],
    "leads_to_downstream": [{ "id": "i-tip-selection", "type": "Interaction", "state": "draft", "title": "...", "description": "...", "distance": 1 }]
  }
}
```

Where:

- `affected` is the transitive reverse-`depends_on` closure (BFS) from `node_id` (distance 0 seed omitted from results) — Interfaces and Foundations that depend on this node, etc.,
- `journeys_at_risk` lists Journey ids linked via `belongs_to` from affected **Interactions** (and from the focus Interaction when applicable),
- `reachability` MUST be included when the focus node is an **Interaction**:
  - `exposing_interfaces` — Interfaces with an `exposes` edge to this Interaction,
  - `containing_journeys` — Journeys this Interaction `belongs_to`,
  - `leads_to_downstream` — transitive forward closure via `leads_to` (BFS; cycles truncated by visited set), each with `distance`.

- **Errors:** unknown `node_id`.
- **Rationale:** calling this before substantial implementation or `open_next` surfaces both substrate dependents and Interaction-centric reachability (who exposes this behaviour, which Journeys contain it, where navigation flows next). The stable-id model means an evolution never changes what depends on the node.

#### `get_node_context`

- **Input:** `node_id` (slug).
- **Output:** always includes the live `current.mdx` slice; when the node has an open `next.mdx` (Foundation/Interaction/Interface only), also includes a `next` object with that slot's record, body, and paths:

```jsonc
{
  "folder": "mindplan/interactions/i-checkout-split",
  "context_path": "mindplan/interactions/i-checkout-split/current.mdx", // deprecated alias; prefer current_path
  "current_path": "mindplan/interactions/i-checkout-split/current.mdx",
  "attachments_path": "mindplan/interactions/i-checkout-split/attachments",
  "attachments": ["checkout-wireframe.png"],
  "record": {
    "id": "i-checkout-split",
    "type": "Interaction",
    "state": "in-progress",
    "title": "Split & pay checkout",
    "description": "Diner splits and pays the bill from their phone",
    "created_at": "...",
    "updated_at": "...",
    "belongs_to": ["j-ordering"],
    "depends_on": ["f-db"],
    "leads_to": ["i-tip-selection"]
  },
  "body": "# Split & pay checkout\n\n...",
  "title": "Split & pay checkout",
  "description": "Diner splits and pays the bill from their phone",
  "raw_context": "---\nid: i-checkout-split\n...", // deprecated; prefer record + body
  "next": null
  // when next.mdx exists, the payload also carries:
  //   "next_path": ".../next.mdx", "next_attachments_path": ".../next-attachments",
  //   "next": { "record": { state, title, description, updated_at, belongs_to?, depends_on?, exposes?, leads_to? }, "body": "...", "raw": "..." }
}
```

- **Errors:** unknown `node_id`; missing `current.mdx`.

#### `orient_for_work`

Composite orientation for agents: `find_related_nodes` plus full territory for the focus node and `get_blast_radius` when the focus is a Foundation, Interaction, or Interface.

- **Input:** same as `find_related_nodes` (`query`, `node_id`, `type`, `limit`).
- **Output:** `{ query, matches, focus, nodes, edges, context, blast_radius }` where `context` matches `get_node_context` (without `raw_context`) when `focus` is set, else `null`; `blast_radius` matches `get_blast_radius` for Foundation/Interaction/Interface focus (including `reachability` when focus is an Interaction), else `null`.
- **Errors:** same as `find_related_nodes`.

#### `get_node_implementation`

Returns the prescribed implementation package for an Interaction, Interface, or Foundation (§1.2), or a packages-off result when layout-free (§1.2.1).

- **Input:** `node_id` (slug; must be an Interaction, Interface, or Foundation).
- **Output (packages required):**

```jsonc
{
  "node_id": "i-checkout-split",
  "root": "src/interactions/i-checkout-split",
  "exists": true,
  "implementation_packages": "required",
  "entries": [".gitkeep"]
}
```

- **Output (packages off):**

```jsonc
{
  "node_id": "i-checkout-split",
  "root": null,
  "exists": false,
  "implementation_packages": "off",
  "entries": []
}
```

`root` is the derived project-relative package path when `implementation_packages` is `required`. When packages are `off`, `root` is always `null` and `exists` is always `false` — that means packages are **not applicable**, not that a package is missing. Agents MUST read `implementation_packages` before interpreting `exists`/`root`. When packages are `required` and `exists` is true, `entries` lists **top-level** names in the package (sorted); otherwise `entries` is omitted or empty.

- **Errors:** unknown `node_id`; node is a Journey or Bug (`Blocked: … only applies to Interaction, Interface, and Foundation nodes`).

#### `patch_node_territory`

Patches territory-owned content on `current.mdx` or `next.mdx`. Server-owned frontmatter (`state`, edge arrays, `shipped_at`) is never modified.

- **Input:**
  - `node_id` (slug, required)
  - `title` (string, optional) — pre-ship Interaction/Interface (`current`) or an open `next` slot only
  - `description` (string, optional) — pre-ship Interaction/Interface (`current`) or an open `next` slot only
  - `body` (string, optional) — replaces entire body below frontmatter
  - `toggle_checkboxes` (array of `{ contains, checked }`, optional) — match checkbox lines by substring
  - `slot` (`current` \| `next`, optional) — explicitly select the territory file to patch; errors if `next` is requested but no `next.mdx` exists
  - At least one patch field is required.
- **Slot resolution:** when `slot` is omitted, the server patches `next.mdx` if the node is a shipped (`stable`/`unstable`) Foundation/Interaction/Interface with an open evolution, otherwise `current.mdx`.
- **Effect:** writes territory body and/or `title`/`description` scalars on the resolved slot; touches `updated_at` in that slot's frontmatter.
- **Output:** `{ node_id, patched_fields: ["description", ...], slot: "current" | "next", path, changed_files: string[] }` — `path` is the repo-relative MDX written; `changed_files` lists that path. Interactive agents SHOULD prefer host file tools for prose; this tool is an optional fallback.
- **Errors:** unknown `node_id`; empty patch; no matching checkbox line; explicit `slot: "next"` with no `next.mdx`; shipped Interaction/Interface `title`/`description` change on `current` (`Use open_next for material scope changes on live work.`).

### 8.2 Mutation tools

#### Territory write authority (graph vs prose)

| Concern | Who writes |
|---------|------------|
| Create node, edges, pipeline/Bug state, `open_next` / `discard_next` / `ship` / `force_unship` | **MCP only** (`create_node`, `link_nodes`, `unlink_nodes`, `update_node_status`, `force_unship`, `open_next`, `discard_next`) |
| `title`, `description`, body (PRD / Atomic Ops), checkbox toggles | **Host file tools** preferred on `current_path` / `next_path` from orientation (so native “changed files” UIs show the edit); `patch_node_territory` is an optional fallback |
| Server-owned frontmatter (`state`, `updated_at`, `shipped_at`, edge arrays) | **MCP only** — agents MUST NOT hand-edit these fields |
| `mindplan/map.md` | Server after graph mutations — derived snapshot, not graph authority |

Orient and trust graph state via MCP `record` responses. Do not treat on-disk frontmatter as authoritative for `state` or edges.

Successful graph mutations MUST include `changed_files: string[]` — repo-relative paths written or deleted (territory MDX, optional scaffolds / attachment paths, and `mindplan/map.md` when the map is refreshed). Agents SHOULD surface these paths to humans because many hosts do not list MCP subprocess writes in their native “edited files” UI.

#### `create_node`

- **Input:** `id` (slug), `type` (`Journey|Foundation|Interaction|Interface|Bug`), `title` (non-empty), `description`.
- **Effect:** scaffolds the entity folder with a full-frontmatter `current.mdx` (§6.3). For Interaction, Interface, and Foundation, when `implementation_packages` is `required`, also scaffolds the prescribed implementation package under `src/` (§1.2, §6.3.1); when `off`, only territory is created (§1.2.1). Does not write edge fields — those are added by `link_nodes`. Never creates a `next.mdx`.
- **Output:** `{ created: <node from frontmatter>, folder, current, context, attachments, implementation?, implementation_packages?, changed_files }` (project-relative paths; `context` is a deprecated alias for `current`; `implementation` is the package root when scaffolded; `implementation_packages: "off"` is set when packages are disabled).
- **Errors:** duplicate `id`.

#### `open_next`

- **Input:** `node_id` (shipped Foundation, Interaction, or Interface), `title` (optional), `description` (optional).
- **Effect:** validates Rule 10 (§5.11), copies `current.mdx`'s body and outgoing edges into a new `next.mdx` in pipeline state `draft` (overriding `title`/`description` when provided) and creates an empty `next-attachments/`. `current.mdx`, its state, and its edges are completely unchanged — the live node keeps serving.
- **Output:** `{ node_id, live_state, next: { state, title, description, updated_at, belongs_to?, depends_on?, exposes?, leads_to? }, folder, current, next_path, changed_files }`.
- **Errors:** unknown `node_id`; wrong type (not Foundation/Interaction/Interface); node not shipped (`stable`/`unstable`); node already has an open `next.mdx`.

#### `discard_next`

- **Input:** `node_id` (Foundation, Interaction, or Interface with an open `next.mdx`).
- **Effect:** deletes `next.mdx` and `next-attachments/`, abandoning the in-flight evolution. `current.mdx` is untouched.
- **Output:** `{ node_id, discarded: true, live_state, changed_files }`.
- **Errors:** unknown `node_id`; node has no `next.mdx` to discard.

#### `link_nodes`

- **Input:** `source_id`, `target_id`, `edge_type` (`depends_on|belongs_to|exposes|leads_to|affects`).
- **Effect:** validates §5.10, then appends the target id to the source node's outgoing edge array — on `current.mdx`, or on the proposed edges of an open `next.mdx` when the source is a Foundation/Interaction/Interface currently evolving (§2.2). Recomputes stability (§3.5) and Journey states (§4) from the live graph (`next`-slot edges never affect these computations until promoted), patches affected frontmatter fields.
- **Output:** `{ linked: {source, target, type}, slot: "current" | "next", journeys_recomputed: [...], stability_recomputed: [{id, state}], changed_files }`.
- **Errors:** unknown ids; illegal shape; Interaction Independence violation; self-link; duplicate edge (on the resolved slot); `depends_on` dependency cycle.
- **Note:** there is no `link_dependent` parameter and no Dependency Closure cascade.

#### `unlink_nodes`

- **Input:** `source_id`, `target_id`.
- **Effect:** removes **all** edges from `source_id` to `target_id` (any type) from the source node's `current.mdx` frontmatter and, when present, from an open `next.mdx`'s proposed edges; recomputes stability and Journey states; mirrors frontmatter.
- **Output:** `{ removed: <count>, journeys_recomputed: [...], stability_recomputed: [...], changed_files }`.
- **Errors:** unknown ids; no edge exists between the pair (on either slot).
- **Note:** unlinking does not retroactively demote a node already past a gate; guardrails are evaluated at transition time only (§9.2).

#### `update_node_status`

- **Input:** `node_id`, `new_status` (string; build/Bug state name, or `ship` for Foundation/Interaction/Interface production entry).
- **Effect:** runs the full §5.13 pipeline. When the node has no open `next.mdx`, mutations apply to `current.mdx` exactly as in a first build. When `next.mdx` is open, `draft`/`ready`/`in-progress`/`in-review` transitions apply to the `next` slot only; `ship` (only legal from `next` in-review) **promotes**: copies `next.mdx`'s body/title/description/proposed edges onto `current.mdx`, merges non-`.gitkeep` files from `next-attachments/` into `attachments/`, computes `stable`/`unstable` from open Bugs, sets `shipped_at`, and deletes `next.mdx`/`next-attachments/` (§3.6, §5.11). Recomputes stability and Journey states, persists, mirrors frontmatter.
- **Output:** `{ node_id, previous_state, new_state, next_state, shipped_at, promoted_next: boolean, journeys_recomputed: [...], stability_recomputed: [...], changed_files }`. On promote, `changed_files` includes `current.mdx`, deleted `next.mdx` / `next-attachments/` paths, and any `attachments/<file>` copies from the next slot.
- **Errors:** unknown id; Journey target; invalid state name; illegal transition (on the active slot); Rule 1–6 violations; manual `stable`/`unstable` attempt; `ship` attempted while `next.mdx` is not in-review; `deprecated` attempted while `next.mdx` is open. Illegal production retreats SHOULD mention `force_unship` and the `unship:<node_id>` confirm shape.

#### `force_unship`

- **Input:** `node_id`, `confirm` (exact string `unship:<node_id>`), optional `new_status` (`draft|ready|in-progress|in-review`, default `ready`).
- **Effect:** runs Rule 11 (§5.12): clears `shipped_at`, sets pre-ship `state` on `current.mdx`, recomputes Journey states, refreshes `mindplan/map.md`.
- **Output:** `{ node_id, previous_state, new_state, shipped_at: null, force_unship: true, journeys_recomputed: [...], stability_recomputed: [...], changed_files }`.
- **Errors:** wrong/missing confirm; not Foundation/Interaction/Interface; not `stable`/`unstable`; open `next.mdx`; shipped direct dependents; invalid target; Ghost Interaction / Ghost Interface / Completion Check failures for the target state.
- **Playbook:** agents MUST ask the human and wait for an explicit yes before calling; MUST NOT invent `confirm`.

### 8.3 Attachments

Attachments are managed through the ordinary file system (IDE, agent file tools, or scripts) — the MCP surface intentionally does not proxy binary uploads. `get_node_context` reports the attachment inventory so agents can discover and read files directly from `attachments_path`.

---

## 9. Operational Semantics

### 9.1 Determinism

Given identical `mindplan/` contents and an identical tool call, the server MUST produce an identical accept/reject decision and identical resulting state (timestamps excepted). There is no hidden state, no database, and no network dependency.

### 9.2 Validation-at-transition

Guardrails are evaluated at the moment of transition, against the graph and Territory as they exist on disk at that moment. MindPlan does not run continuous invariant enforcement; a graph made temporarily inconsistent by out-of-band edits is corrected the next time a gated transition is attempted.

### 9.3 Out-of-band edits

- `current.mdx`/`next.mdx` **body** and frontmatter **`title:`** / **`description:`** edits are a first-class part of the process.
- `current.mdx`/`next.mdx` server-owned frontmatter (`state`, `updated_at`, `shipped_at`, `belongs_to`, `depends_on`, `exposes`, `leads_to`, `affects`) MUST be written only via MCP tools. Hand-editing voids the framework's guarantees. Manually creating, editing, or deleting `next.mdx` outside `open_next`/`update_node_status`/`discard_next` is likewise out of contract.

### 9.4 Concurrency

The reference implementation assumes a single writer (one MCP server instance per project). Deployments requiring concurrent writers MUST serialize mutations externally.

### 9.5 Deprecation, cancel, and orphans

Transitioning an Interaction or Interface to `deprecated` (post-ship) or `cancelled` (pre-ship) SHOULD be followed by an orphan review: any Foundation whose only consumers are now retired is a candidate for deprecation or cancel itself. When change is due to a **replacement of scope on live work** rather than retirement, use `open_next` instead — the node keeps its id and edges and simply gains new territory and state under the same folder until the evolution ships (§3.6); there is no predecessor to auto-deprecate in the stable-id model. Implementations MAY automate orphan checks; the reference implementation leaves it to the operator (the graph query is trivial via `get_mindplan_graph` or `get_blast_radius`).

### 9.6 Offline integrity check (`mindplan-mcp check`)

The package binary exposes an offline CLI (same entry as MCP stdio, no stdio session required) that audits territory without mutating it. Behavior depends on `mindplan/config.json` `implementation_packages` (missing → `required`):

| Mode | Command | Checks |
|------|---------|--------|
| Default (`required`) | `mindplan-mcp check` | Graph load; every non-retired Foundation/Interaction/Interface has `src/{foundations\|interactions\|interfaces}/<id>/`; no orphan package dirs. Does **not** run dirty-src. |
| Default (`off`) | `mindplan-mcp check` | Graph load only — skips package presence and orphans (layout-free / brownfield) |
| Dirty-src (opt-in) | `mindplan-mcp check --base <ref>` | Default checks plus dirty `src/` ownership vs `<ref>`: **uncommitted** paths require `in-progress` (or `next` in-progress, or Bug `fixing`/`in-review`); **committed** paths vs `base...HEAD` allow `in-progress`/`in-review`/`stable`/`unstable`/`cancelled`/`deprecated`, but when `next.mdx` is open only `next` in `in-progress`/`in-review` counts (not draft/ready). Explicit `--base` fails closed on git errors. Skipped when packages are `off`. |
| Invalid config | any check mode | Fail immediately if `mindplan/config.json` exists but is invalid (bad JSON / mode); do not treat as `required` |
| Local hygiene (opt-in) | `mindplan-mcp check --for-main` | Graph load; package checks only when `required`; fail if any Foundation/Interaction/Interface is `in-progress`/`in-review` (or `next` in those states), or any Bug is `fixing`/`in-review`. Does **not** run dirty-src. Optional local tool — **must not** be required by CI to merge unfinished work. |

Exit code `0` on success, `1` with `Blocked: …` lines on failure. This repo’s CI builds from source and runs default `node dist/index.js check` only (graph + packages). Consumer repos SHOULD use the published bin after npm release.

---

## 10. External UI Synchronization (GitOps Integration)

MindPlan supports one-way mirroring into standard project-management platforms (Jira, Linear, GitHub Projects) so stakeholders retain their dashboards without reintroducing drift.

### 10.1 Principles

1. **Execution in Git.** Developers and agents work entirely within the IDE: states move via MCP tools, Atomic Ops are checked off in Markdown. The repository is the write side.
2. **Read-only UI mirror.** The external board is a projection. Humans MUST NOT move tickets there; any manual board change is overwritten by the next sync. This is what eliminates "Jira Drift" — there is nothing to drift *from*, because the board has no authority.

### 10.2 Sync pipeline

On every merge to the main branch (or on a schedule), a CI step runs a lightweight parser that:

1. scans territory frontmatter for node states and outgoing edge arrays;
2. expands edge arrays into flat edge triples;
3. reads each node's `current.mdx` checklist (and, informationally, an open `next.mdx` checklist) to compute completion percentages;
4. fires idempotent API payloads to the external tracker: create missing tickets (keyed by node `id`), move tickets to the column mapped from the node state, update checklist progress as a comment or custom field.

Suggested state→column mapping:

| MindPlan state | Board column |
|---|---|
| `draft` | Backlog |
| `ready` | To Do |
| `in-progress` | In Progress |
| `in-review` | In Review |
| `stable` | Done (healthy) |
| `unstable` | Done (degraded) |
| `deprecated` | Archived |
| Bug `open` / `triaged` | Bug Backlog / Triaged |
| Bug `fixing` / `in-review` | In Progress / In Review |
| Bug `resolved` / `wontfix` | Closed |
| Journey `incubation`/`evolving`/`stable` | Epic status field |

### 10.3 Implementation status

The sync parser is deliberately outside the MCP server (it is a CI concern, not an agent concern) and is **not included** in the reference implementation. The stable interfaces it consumes — §6.1 (frontmatter + checklist syntax) and §7 (graph assembly) — are the compatibility contract for building one.

---

## 11. Compliance Checklist

An implementation is MindPlan-compliant if and only if:

- [ ] All state lives under `mindplan/` per §1.1; no external database.
- [ ] Build taxonomy (Journey, Interaction, Interface, Foundation) + defect layer and all five edge types are enforced per §2.
- [ ] Build pipeline, Bug lifecycle, and computed `stable`/`unstable` are enforced per §3.
- [ ] The stable-id evolution model (`open_next` / `next.mdx` / promote-on-ship / `discard_next`) is enforced per §3.6, with no version-lineage edge and no dependent relinking.
- [ ] Journey states are computed from member Interactions, never settable, per §4 (including `next`-slot activity); Bugs and Interfaces do not affect Journeys.
- [ ] Rules 1–11 are enforced pre-write, fail-fast, per §5 (including Interaction Independence, Behavior First, no Dependency Closure; Rule 10 as `open_next`/`ship`-promotes/`discard_next`; Rule 11 as `force_unship`).
- [ ] Every rejection message starts with `Blocked: ` per §5.1.
- [ ] `current.mdx`/`next.mdx` frontmatter is server-mirrored per §6 (state and edge arrays).
- [ ] The MDX component contract holds per §6.4: reserved names respected, project components opaque, no guardrail parses JSX.
- [ ] Edges persist in source-node `current.mdx` frontmatter and assemble at runtime per §7; `next.mdx` proposed edges are not live graph edges.
- [ ] The fifteen-tool MCP surface matches §8 (names, inputs, outputs, errors), including Interaction `reachability` on blast radius / orient.
- [ ] Mutations are deterministic and atomic per §9.
- [ ] Source-file/symbol mapping is absent (§1.4) — package roots only.

---

## Appendix A — Canonical error catalog

| Rule | Example message |
|---|---|
| Unknown node | `Blocked: node "i-x" does not exist in mindplan territory.` |
| Duplicate node | `Blocked: node "i-checkout" already exists.` |
| Illegal edge shape | `Blocked: belongs_to edges must go Interaction -> Journey. Got Foundation "f-db" -> Journey "j-ordering".` |
| Journey dependency | `Blocked: a Journey cannot depend on a Foundation. Journeys are permanent containers with no direct code execution.` |
| Duplicate edge | `Blocked: edge i-checkout -depends_on-> f-db already exists.` |
| Manual Journey state | `Blocked: Journey states are computed automatically from their Interactions and cannot be set manually.` |
| Manual stability | `Blocked: stable/unstable are computed from open Bugs and cannot be set manually. Use ship from in-review.` |
| Invalid state name | `Blocked: "active" is not a valid state. Valid build states: draft -> ready -> in-progress -> in-review -> ship -> stable/unstable -> deprecated.` |
| Illegal transition | `Blocked: illegal transition "in-progress" -> "stable" for node "i-tips". Allowed from "in-progress": in-review, ready.` |
| Rule 1 (Ghost Interaction) | `Blocked: Ghost Interaction. "i-checkout" has no belongs_to edge to a Journey. Link it with link_nodes before moving it to "ready".` |
| Rule 1 (Ghost Interaction, no Foundation) | `Blocked: Ghost Interaction. "i-checkout" has no depends_on edge to a Foundation. Link it with link_nodes before moving it to "ready".` |
| Rule 2 (Ghost Interface) | `Blocked: Ghost Interface. "if-checkout-page" has no exposes edge to an Interaction. Link it with link_nodes before moving it to "ready".` |
| Rule 3 (Infra First) | `Blocked: Infrastructure First. Interaction "i-checkout" cannot ship while linked Foundations are not stable: "f-db" (in-review).` |
| Rule 4 (Behavior First) | `Blocked: Behavior First. Interface "if-checkout-page" cannot ship while exposed Interactions are not stable: "i-checkout" (in-progress).` |
| Interaction Independence | `Blocked: Interaction Independence. Interactions must not depend_on each other. Share state through a Foundation instead. Got Interaction "i-a" -> Interaction "i-b".` |
| Dependency cycle | `Blocked: depends_on edge f-a -> f-b would create a dependency cycle.` |
| open_next: not shipped | `Blocked: only shipped Foundations/Interactions/Interfaces (stable or unstable) can open next. "i-checkout" is currently "in-progress".` |
| open_next: already open | `Blocked: "i-checkout" already has a next.mdx evolution in state "in-progress". Ship or discard_next before opening another.` |
| ship: next not in-review | `Blocked: ship is only allowed from next in-review. "i-checkout" next is currently "in-progress".` |
| discard_next: nothing to discard | `Blocked: node "i-checkout" has no next.mdx to discard.` |
| deprecate while evolving | `Blocked: cannot deprecate "i-checkout" while next.mdx exists. Call discard_next first, or ship the evolution.` |
| Rule 5 (Completion) | `Blocked: Completion Check. 3 unchecked checkbox(es) remain in i-checkout/current.mdx. All [ ] items must be [x] before moving to "ship".` |
| Rule 5 (Open checklist) | `Blocked: Checklist Complete. All checkboxes are checked while "i-checkout" is "in-progress". Leave at least one Atomic Op open while building, or call update_node_status → "in-review" first (then complete the checklist; Completion Check applies at ship/resolved).` |
| Rule 6 (Ghost Bug) | `Blocked: Ghost Bug. "bug-race" has no affects edge. Link it to an Interaction, Interface, or Foundation before moving it to "triaged".` |
| Stability flip | (informational) `stability_recomputed: [{ "id": "i-checkout", "state": "unstable" }]` in tool response |
| No edge to remove | `Blocked: no edge exists between "i-tips" and "f-db".` |
| Shipped scope freeze | `Blocked: Use open_next for material scope changes on live work.` |

## Appendix B — Reference lifecycle walkthrough

```
create_node(j-ordering, Journey)              → j-ordering: draft (computed)
create_node(f-db, Foundation)                 → f-db: draft
create_node(i-checkout, Interaction)          → i-checkout: draft
create_node(if-checkout-page, Interface)      → if-checkout-page: draft
update_node_status(i-checkout, ready)         → Blocked: Ghost Interaction (no Journey link)
link_nodes(i-checkout, j-ordering, belongs_to)
link_nodes(i-checkout, f-db, depends_on)
update_node_status(i-checkout, ready)         → ok
update_node_status(i-checkout, in-progress)   → ok; j-ordering → incubation
… agent implements Interaction, checks off Atomic Ops …
update_node_status(i-checkout, in-review)     → ok (all [x])
update_node_status(i-checkout, ship)          → Blocked: Infrastructure First (f-db is in-review)
… f-db: draft → ready → in-progress → in-review → ship → stable …
update_node_status(i-checkout, ship)          → ok; i-checkout: stable; j-ordering → stable

link_nodes(if-checkout-page, i-checkout, exposes)
update_node_status(if-checkout-page, ready)   → ok (exposes present)
… implement Interface package …
update_node_status(if-checkout-page, in-review) → ok
update_node_status(if-checkout-page, ship)    → ok (Behavior First: i-checkout stable)

create_node(bug-race, Bug)                    → bug-race: open
update_node_status(bug-race, triaged)         → Blocked: Ghost Bug (no affects edge)
link_nodes(bug-race, i-checkout, affects)     → i-checkout: unstable (stability recomputed)
update_node_status(bug-race, triaged)         → ok; j-ordering unchanged (still stable)
… fix bug, check off Fix Checklist …
update_node_status(bug-race, resolved)        → ok; i-checkout: stable

link_nodes(i-a, i-b, depends_on)              → Blocked: Interaction Independence
link_nodes(i-checkout, i-tip, leads_to)       → ok (navigation; not a gate)

… months later, checkout gains split-payment support (same id, no new node) …
open_next(i-checkout)                          → i-checkout: still stable (current.mdx untouched); next.mdx created in draft
update_node_status(i-checkout, ready)          → applies to next slot: next.mdx → ready
update_node_status(i-checkout, in-progress)    → next.mdx → in-progress; j-ordering → evolving
… agent implements, checks off Atomic Ops in next.mdx …
update_node_status(i-checkout, in-review)      → ok (all [x] in next.mdx)
update_node_status(i-checkout, ship)           → ok; next promoted over current.mdx (same id "i-checkout"); next.mdx deleted;
                                                  i-checkout: stable; j-ordering → stable
```
