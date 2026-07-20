# MindPlan Framework Specification

**Version:** 0.1.0
**Status:** Unreleased
**Reference implementation:** repository root (TypeScript MCP server, stdio transport)

The key words MUST, MUST NOT, SHALL, SHOULD, and MAY in this document are to be interpreted as described in RFC 2119.

---

## 0. Abstract

MindPlan is a strictly deterministic Software Development Life Cycle (SDLC) framework designed natively for autonomous AI agents and human engineering teams. It operates as a compiler-style state machine and a "GitOps for Issue Tracking" system: all planning state lives inside the repository, every state mutation is validated against architectural guardrails before it is persisted, and any violation is rejected with a machine-parsable error. The result is that software architecture and project requirements remain perfectly synchronized with the code they describe — there is no external tracker to drift from reality.

MindPlan is exposed to agents exclusively through a Model Context Protocol (MCP) server. The server is the single write path to MindPlan state. Direct file edits to the graph are out of contract (see §9.3). Consumer projects receive an operational always-on agent playbook at `mindplan/agent/playbook.md` (installed by `mindplan-mcp init` from `templates/agent/playbook.md`) — the playbook is the SDLC execution process agents MUST follow for all software work; entity scaffolding lives in the separate `define-entities` skill; plan-only product-modeling sessions (no application code) live in the `plan-project` skill. Many agents also read root `AGENTS.md`, which `init` creates when missing.

---

## 1. Core Architecture: Territory

MindPlan persists all planning state as **tickets-as-code** under `mindplan/`. Each node owns a folder containing a `current.mdx` file and an `attachments/` directory. The `current.mdx` YAML frontmatter is the **node record** — identity, state, timestamps, and outgoing edge arrays; it is the live, stable id for the node's entire lifetime (§3.6). The body contains PRD, Acceptance Criteria, and Atomic Operations.

A shipped Foundation or Workflow (`stable`/`unstable`) MAY additionally hold a `next.mdx` — an in-flight evolution of that same node, built in place under the same id while `current.mdx` keeps serving. `next.mdx` and its sibling `next-attachments/` directory exist only for Foundations and Workflows (§3.6) and are never present on Journeys or Bugs.

Context files are MDX: standard Markdown plus optional JSX components (§6.4). Markdown remains the load-bearing syntax — every compiler rule operates on Markdown constructs only, and a context file containing no JSX at all is fully compliant.

The territory MUST live in the repository alongside the source code and MUST be versioned with it. A commit therefore captures code, architecture, and requirements in one atomic snapshot.

### 1.1 Directory layout

MindPlan prescribes a **dual tree**: planning under `mindplan/`, and **implementation packages** under `src/` for Workflows and Foundations. Journeys and Bugs have no code package — Journeys are graph containers (Workflows may belong to many Journeys), and Bugs are a defect layer whose fixes land in the affected node's package.

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
│   ├── workflows/
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
    ├── workflows/<workflow-id>/       # Use-case implementation package (§1.2)
    └── foundations/<foundation-id>/   # Shared-substrate implementation package (§1.2)
```

Rules:

- The planning root is `<MINDPLAN_ROOT>/mindplan`, where `MINDPLAN_ROOT` is an environment variable resolving to the target project root. If unset, the server's working directory is used. Implementation packages are rooted at `<MINDPLAN_ROOT>/src`.
- Each entity folder name under `mindplan/` MUST equal the node `id`.
- The subdirectory per type is fixed: `journeys/`, `foundations/`, `workflows/`, `bugs/`.
- `next.mdx` and `next-attachments/` MUST NOT exist for Journeys or Bugs; they are legal only under `foundations/<id>/` and `workflows/<id>/`, and only while an evolution is open (§3.6).
- `attachments/` MAY contain arbitrary files. Attachments SHOULD be referenced from `current.mdx` with relative links (e.g. `![flow](attachments/flow.png)`); `next-attachments/` is referenced the same way from `next.mdx` and is merged into `attachments/` when the evolution ships (§3.6).
- `components/` MAY contain project-specific MDX components (§6.4.3). It is created by the server but never read by it.
- The server MUST create missing directories on demand; a fresh project requires no manual scaffolding.

### 1.2 Implementation packages (prescribed architecture)

By default (and when `mindplan/config.json` is missing), Workflow and Foundation nodes own a **derived** filesystem package whose path is fixed by type and id (not a graph edge — targets are directories, not MindPlan nodes):

| Node type | Implementation root | Purpose |
|---|---|---|
| Workflow | `src/workflows/<id>/` | Use-case code; shared across Journeys via `belongs_to` in the graph only |
| Foundation | `src/foundations/<id>/` | Shared substrate by role (assembler, infra, design system, adapter) |
| Journey | *(none)* | Plan container — architecture for a Journey is the union of member Workflow packages |
| Bug | *(none)* | Fixes land in the affected Workflow/Foundation package |

Rules (when `implementation_packages` is `required`):

- Package folder name MUST equal the node `id` (e.g. `wf-user-picker` → `src/workflows/wf-user-picker/`).
- `create_node` for Workflow or Foundation MUST scaffold the package directory with a `.gitkeep` (§6.3).
- Agents MUST implement that node's code **only** inside its package. Cross-cutting reuse MUST go through Foundation packages or `depends_on` Workflow packages — not ad-hoc junk-drawer folders outside the prescribed roots.
- Agents query architecture via the MindPlan graph **plus** `get_node_implementation` (§8.1). For a Journey, derive member packages by resolving `belongs_to` Workflows, then calling `get_node_implementation` on each.

#### 1.2.1 Layout-free adoption (`implementation_packages: "off"`)

Existing (brownfield) projects MAY opt out of prescribed packages via `mindplan/config.json`:

```json
{
  "implementation_packages": "off"
}
```

`mindplan-mcp init --layout free` writes that config; `--layout prescribed` (or default init when missing) writes `"required"`. Missing config MUST be treated as `"required"` so greenfield and this reference repo keep screaming-architecture checks. A **present but invalid** `mindplan/config.json` (bad JSON, non-object, or `implementation_packages` not exactly `"required"`|`"off"`) MUST hard-fail with `Blocked: invalid mindplan/config.json: …` — tools (`create_node`, `get_node_implementation`, …), `mindplan-mcp check`, and bare `init` (preserve path) MUST NOT silently fall back to `"required"`. Fix the file or overwrite with `mindplan-mcp init --layout free|prescribed`.

When packages are `off`:

- `create_node` MUST NOT scaffold `src/foundations|workflows/<id>/`
- `get_node_implementation` MUST report `implementation_packages: "off"` with `root: null` (not an integrity failure)
- `mindplan-mcp check` MUST skip package presence, orphan, and dirty-src ownership checks; graph load and `--for-main` mid-pipeline bans still apply
- Agents implement in the project's existing layout; they still advance MindPlan states and MUST NOT invent tickets outside the graph

Graph compiler gates (Ghost Workflows/Bugs, Infrastructure First, Completion Check, External Review) are unchanged in both modes.

---

## 2. Entity Taxonomy

The framework separates **build taxonomy** (Journey, Foundation, Workflow) from a **defect layer** (Bug) to eliminate scope creep and prevent spaghetti dependencies.

MindPlan tracks **architecture and delivery together**. The build taxonomy is deliberately use-case-first (screaming architecture): a glance at the Journeys — and the Workflows that belong to them — MUST scream what the product *is*, not which frameworks, databases, or delivery mechanisms it uses. Foundations hold **shared substrate** at the edges (infra and reusable product platform) so use cases stay primary.

| Entity | Definition | Routing rules |
|---|---|---|
| **Journey** | A named **domain capability** — a permanent architectural boundary for related use cases (e.g. "Table Ordering", "Billing", "Agency Site Generator"). The set of Journey titles is the product's scream: reading only those titles SHOULD reveal the business purpose of the system. Journeys are continuous containers, not closable epics, sprints, or technical layers (`API`, `Frontend`, `Database`). | Permanent container. MUST NOT execute code directly. MUST NOT have outgoing edges. State is computed, never set manually (§4). MUST be named in domain language. |
| **Foundation** | **Shared substrate** with no standalone use case: infrastructure *and* reusable product platform, organized by **role** (assembler, infra, design system, adapter — see §2.0.1). Examples: Next.js app shell, database schemas, auth, Stripe SDK, design tokens, primary button. Use cases consume Foundations via `depends_on` without becoming them. | Exists solely to be consumed by Workflows (or other Foundations). MUST be shipped (`stable`) before dependent Workflows can ship. MAY depend on other Foundations (layered substrate). MUST NOT own stakeholder-recognizable use-case behaviour — that belongs in Workflows. Foundations are not Journey members. |
| **Workflow** | A concrete **use case** — application-specific business logic or end-user feature that realizes part of one or more Journeys (e.g. "Split the check", "Process Payment", "User picker", "Character editor"). This is where execution work lives, including shared screens that are themselves use cases. | MUST belong to one or more Journeys via `belongs_to` (multiple edges allowed — membership reuse across Journeys). MUST depend on at least one Foundation via `depends_on`. MAY `depends_on` other Workflows (composition reuse). Contains the actual execution work. **Agents MUST define the Journey before creating a Workflow** — if the user requests a Workflow that cannot be mapped to an existing Journey, the agent MUST refuse and ask the user to define the Journey first. |
| **Bug** | A defect afflicting one or more Foundations or Workflows. | MUST link to targets via `affects` (Bug → Workflow|Foundation). Dedicated defect lifecycle (§3.2). Does not affect Journey computation. |

### 2.0 Classification litmus (agents)

Agents MUST classify new work with these checks, in order:

1. Domain capability the product *is about*? → **Journey**
2. Stakeholder-recognizable use case / screen with its own behaviour (even if many features embed it)? → **Workflow**
3. Shared code/UI with **no** standalone use case, only consumed by use cases? → **Foundation** (then pick a **role** per §2.0.1)
4. Broken behaviour on an existing node? → **Bug**

**Shared-screen examples:**

- Primary button / design tokens → Foundation, Design system role (e.g. `f-design-system`). Not a use case.
- Next.js / Vercel Cron / Supabase Functions app shell → Foundation, Assembler role (e.g. `f-nextjs`). Not a Journey named "Frontend".
- Stripe / Resend / Slack SDK wrappers → Foundation, Adapter role (e.g. `f-stripe`). Checkout/billing behaviour stays in Workflows.
- User picker screen → Workflow (e.g. `wf-user-picker`) when it is a real pick/search/select flow; other Workflows `depends_on` it and/or it `belongs_to` multiple Journeys. If it collapses to a dumb combobox with no product behaviour, it MAY live under the design-system Foundation instead.
- Character editor → Workflow (e.g. `wf-character-editor`). Domain behaviour; reuse via `depends_on` and/or multi-Journey `belongs_to`, not Foundation.

**Two reuse axes** (keep distinct):

1. **Membership reuse** — `belongs_to`: the same Workflow is part of multiple Journeys when the use case spans domain capabilities.
2. **Composition reuse** — `depends_on`: one Workflow builds on another use case, or on Foundations (assembler, design system, DB, auth, adapters).

Before inventing shared UI or a shared screen inside a Workflow, agents MUST find or create the right Foundation (substrate) or Workflow (use case) and link `depends_on` (and `belongs_to` when the shared Workflow must sit in the consuming Journey — see Rule 8).

### 2.0.1 Foundation roles (documentation convention)

Foundations remain a single NodeType. Agents SHOULD classify each Foundation into one **role**. Roles are **not** NodeTypes, edge types, frontmatter fields, or compiler enums — they sort substrate without polluting Journeys with tech layers (`Frontend`, `Database`, etc.).

| Role | Owns | Examples | Does not own |
|------|------|----------|--------------|
| **Assembler** | External framework/runtime that mounts Workflow packages into a deployable surface | `f-nextjs`, `f-vercel-cron`, `f-supabase-functions` | Use-case screens, business rules |
| **Infra** | Persistence, messaging, storage, compute plumbing, observability | `f-db`, `f-queue`, `f-blob-store`, `f-otel` | Product features that happen to use a DB |
| **Design system** | Tokens, typography, theme, layout primitives, and dumb presentational UI | `f-design-system` (tokens + Button, Input, Stack) | Screens with product behaviour (those are Workflows) |
| **Adapter** | Third-party / boundary SDKs and protocol wrappers | `f-stripe`, `f-resend`, `f-slack-api` | Checkout/billing use cases (Workflows on top) |

**Role discoverability:** agents SHOULD write the role as the leading tag of the Foundation's `description` — e.g. `"Assembler — Next.js app shell mounting workflow packages"`. This is the only place the role lives; it surfaces in `find_related_nodes`, `export_mindplan_view` labels, and graph dumps without a schema change. Missing role tags are not compiler violations (SHOULD, never MUST).

**Auth / identity:** model as **Infra** (e.g. `f-auth`) unless it is clearly a vendor adapter (`f-clerk` → Adapter). Do not invent a fifth role for it by default.

**Design system vs UI components:** keep as **one role**. Splitting tokens from components recreates a tech split agents over-use. If a project later needs two packages, both stay Design system role (`f-tokens` + `f-ui-kit`).

**Assembler specifics:**

- Different Journeys MAY use different assemblers (UI → Next.js; jobs → Vercel Cron / Supabase Functions).
- A Journey's assembler(s) are **derived** from member Workflows' `depends_on` Foundations that play the Assembler role — Journeys still MUST NOT have outgoing edges.
- Workflows that run on a given backbone SHOULD `depends_on` that Assembler Foundation; this is guidance, not a compiler gate (Ghost Workflows still only require any Foundation `depends_on`).
- Assembler territory + thin `src/foundations/<id>/` document entrypoints, mount conventions, and env/deploy constraints — not use-case behaviour.

**Role litmus** (after classifying as Foundation):

1. External app/runtime that **assembles** Workflow packages? → **Assembler**
2. Vendor/protocol boundary only? → **Adapter**
3. Visual language / dumb UI primitives? → **Design system**
4. Otherwise shared platform plumbing? → **Infra**

### 2.1 Node identifiers

Node ids MUST match the pattern `^[a-z0-9][a-z0-9-_]*$` (lowercase slug style). Ids are globally unique across all types. Recommended convention: prefix by type (`j-`, `f-`, `wf-`, `bug-`), e.g. `j-ordering`, `f-db-core`, `wf-checkout-split`, `bug-race`.

### 2.2 Edge taxonomy

Exactly three edge types exist. An edge is a directed triple `(source, target, type)`. There is no version-lineage edge type: a Foundation or Workflow evolves in place under its **stable id** via the `next.mdx` slot (§3.6), so there is nothing for a graph edge to link.

| Edge type | Legal shape | Meaning |
|---|---|---|
| `belongs_to` | Workflow → Journey | Membership. A Workflow MAY have multiple `belongs_to` edges to different Journeys when the use case spans domain capabilities. |
| `depends_on` | Workflow → Foundation, Workflow → Workflow, Foundation → Foundation | Composition. The source cannot ship without the target's shared substrate or prerequisite use case. |
| `affects` | Bug → Workflow, Bug → Foundation | Affliction. The Bug impairs the target; open Bugs drive `unstable` production posture (§3.5). |

All other shapes MUST be rejected, specifically including:

- Journey → anything (Journeys are containers; they have no outgoing edges)
- `depends_on` targeting a Journey
- `depends_on` from a Foundation, Bug, or Journey targeting a Workflow
- `belongs_to` from a Foundation, Journey, or Bug
- `affects` from anything other than a Bug, or targeting a Journey
- `depends_on` from a Bug or Journey
- self-links (`source == target`)
- duplicate edges (same source, target, and type)

The graph MUST remain acyclic. Implementations MUST reject `depends_on` cycles at link time (Foundation→Foundation and Workflow→Workflow).

While a Foundation or Workflow has an open `next.mdx`, `belongs_to`/`depends_on` writes from that node MUST target the `next` slot's proposed edges rather than the live `current.mdx` edge arrays (§6.2, §8.2 `link_nodes`) — the live node keeps serving its existing edges until the evolution ships and promotes.

---

## 3. State Machines

### 3.1 Build pipeline (Foundation / Workflow)

Foundations and Workflows move through a manual build pipeline, then enter production via `ship`:

| # | State | Meaning |
|---|---|---|
| 1 | `draft` | Ideation; scope written in `current.mdx` (or `next.mdx` while evolving, §3.6) |
| 2 | `ready` | Pre-flight passed (Workflow: at least one Journey + Foundation linked) |
| 3 | `in-progress` | Active execution; Atomic Ops checked off |
| 4 | `in-review` | Frozen pending external review (human or another agent), PR approval, or CI gate |
| 5 | `stable` / `unstable` | Computed production posture; entered via `ship`, never set manually (§3.5) |
| 6 | `cancelled` | Pre-ship abandon (from `draft`/`ready`/`in-progress`/`in-review` only); terminal |
| 7 | `deprecated` | Retired (from `stable`/`unstable` only) |

**Ship transition:** `update_node_status(..., "ship")` from `in-review` sets `shipped_at` and computes `stable` or `unstable` (§3.5). There is no manual `active` state. Agent playbooks MUST treat `in-review` as a handoff: the implementing agent MUST NOT call `ship` (or Bug `resolved`) on its own work — a human or a different agent reviews first. The server does not enforce reviewer identity.

**Cancel transition:** `update_node_status(..., "cancelled")` abandons a Foundation or Workflow that never shipped. It is blocked while `next.mdx` is open, or while any **active** (non-`cancelled`/`deprecated`/`resolved`/`wontfix`) node still `depends_on` this node. Packages and territory folders are left on disk. There is no uncancel in v1 — cancelled is terminal like `deprecated`.

| From \ To | draft | ready | in-progress | in-review | stable/unstable | cancelled | deprecated |
|---|---|---|---|---|---|---|---|
| **draft** | — | ✔ | ✘ | ✘ | ✘ | ✔ | ✘ |
| **ready** | ✔ | — | ✔ | ✘ | ✘ | ✔ | ✘ |
| **in-progress** | ✘ | ✔ | — | ✔ | ✘ | ✔ | ✘ |
| **in-review** | ✘ | ✘ | ✔ | — | ✔ | ✔ | ✘ |
| **stable/unstable** | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✔ |
| **cancelled** | ✘ | ✘ | ✘ | ✘ | ✘ | — | ✘ |
| **deprecated** | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | — |

**Exception — `force_unship` (Rule 10):** a dedicated recovery tool may clear `shipped_at` and move a `stable`/`unstable` Foundation/Workflow to `draft`/`ready`/`in-progress`/`in-review` only when the caller passes `confirm: "unship:<node_id>"` after explicit human confirmation. This is not a normal transition and MUST NOT be used as a substitute for `open_next` evolution.

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

An Atomic Operation is a PR-sized unit of work expressed as a Markdown task-list item in `current.mdx` (or `next.mdx` while a Foundation/Workflow evolution is open, §3.6):

```markdown
- [ ] Implement POST /orders endpoint
- [x] Write migration for orders table
```

Recognized syntax: a list item beginning with `-`, `*`, or `+`, followed by `[ ]` (open) or `[x]` (complete). Checkbox state is parsed from the relevant file (`current.mdx`, or `next.mdx` when evolving) at validation time — the file on disk is the source of truth for completion, not the graph.

JSX in the file is invisible to this check (§6.4.4): only Markdown task-list syntax gates completion.

### 3.4 Bug initial state

Bugs are created in state `open`. All other node types start in `draft`.

### 3.5 Computed production states (`stable` / `unstable`)

After `ship`, a Foundation or Workflow's `state` field holds a **computed** production posture:

| State | Condition |
|---|---|
| `stable` | `shipped_at` is set and zero **open** Bugs `affects` this node |
| `unstable` | `shipped_at` is set and at least one open Bug `affects` this node |

**Open bug** = Bug in `open`, `triaged`, `fixing`, or `in-review`.

Recomputed after: Bug status changes, `affects` link/unlink, and `ship`. Never set manually.

### 3.6 Versioning

MindPlan uses a **stable-id evolution model**: a Foundation or Workflow's `id` never changes across its lifetime, and there is no successor node, no `supersedes` edge, and no dependent relinking. A node's history — including every past evolution — lives in the git history of its `current.mdx`, which **is** the version lineage; there is nothing else to consult.

Shipped Foundations and Workflows (`stable`/`unstable`) are never reset to `draft` in place, and they are never replaced by a new node. To evolve one, call `open_next`, which:

1. verifies the node is `stable` or `unstable` and has no existing `next.mdx` (§5.10),
2. copies `current.mdx`'s body (and, for `attachments/`, nothing automatically — new assets go in a fresh `next-attachments/`) into a new `next.mdx` in pipeline state `draft`,
3. proposes the node's current outgoing `belongs_to`/`depends_on` as the next slot's starting edges (mutable independently of `current`'s edges from this point on, §2.2).

The **live `current.mdx` keeps serving** (`stable`/`unstable`, same id, same edges) for the entire duration of the build on `next`. Dependents' `depends_on` edges continue to resolve to the same id throughout — there is nothing to relink, because the id never moves.

`next.mdx` runs through the same manual build pipeline as a first build (`draft → ready → in-progress → in-review`, §3.1), scoped to the `next` slot: Rule 1 (Ghost Workflow) and Rule 3 (Completion Check) are evaluated against `next.mdx`'s proposed edges and checkboxes, not `current.mdx`'s.

When `next` is `in-review` and the caller calls `update_node_status(..., "ship")`:

1. Rule 2 (Infrastructure First) is evaluated against **`next`'s** proposed `depends_on` targets,
2. Rule 3 (Completion Check) is evaluated against **`next.mdx`**,
3. on success, the server **promotes `next` over `current`**: it copies `next.mdx`'s body, title, description, and proposed edges onto `current.mdx` (same `id`, same `type`, fresh `updated_at`/`shipped_at`), merges `next-attachments/` into `attachments/`, computes `stable`/`unstable` from open Bugs (§3.5), and deletes `next.mdx` and `next-attachments/`.

The node's `id` and production posture continue uninterrupted — dependents never see a different id and never need relinking. To abandon an in-flight evolution without shipping it, call `discard_next`: it deletes `next.mdx`/`next-attachments/` and leaves `current.mdx` completely untouched.

A node MUST NOT have more than one open `next.mdx` at a time (§5.10). `get_blast_radius` on a node with an open evolution reports the **live** `current.mdx`'s dependents — the same set regardless of whether `next` exists, since the id never changes.

#### Territory Completeness

`current.mdx` MUST describe the **complete** contract of what the node *is* in the repository now — purpose, living spec (PRD / Execution Logic / Shared Substrate Spec), and durable acceptance criteria that match shipped (or in-flight pre-ship) reality. It MUST NOT be reduced to a changelog, a “what changed last” narrative, or a stub that only points at a package path.

When `open_next` seeds `next.mdx` from `current.mdx`, authors MUST edit `next` into a **complete proposed successor** of that same contract: add, change, or remove sections in place until the body describes the desired post-ship state. Because `ship` promotes `next` over `current` wholesale, a delta-only or changelog-only `next` body is illegal — it would leave `current.mdx` describing only the latest change instead of the repository’s full state for that node.

Atomic Operations / checklist items on `next.mdx` MAY be scoped to the current evolution (reset or replaced when opening `next`). Spec sections (Purpose, PRD, Execution Logic, Shared Substrate Spec, Acceptance Criteria, and equivalents) MUST remain a full successor document, not an evolution-only diff.

Agents MUST verify Territory Completeness before transitioning `next` to `in-review` (playbook review check). There is no automated compiler gate for this rule.

---

## 4. Computed Journey States

Journeys are continuous and never technically "finished." Their states MUST NOT be set manually; the server derives them from the states of the Workflows linked to the Journey via `belongs_to`, and recomputes them after **every** mutation that can affect the result (status updates, linking, and unlinking).

For a given Journey, let:

- `S` = count of member Workflows with `shipped_at` set (state `stable` or `unstable`)
- `P` = count of member Workflows that are **actively building**, where a Workflow counts toward `P` if either:
  - it has no `shipped_at` and its `current.mdx` state is `in-progress` or `in-review`, **or**
  - it is shipped (`stable`/`unstable`) and has an open `next.mdx` whose pipeline state is `in-progress` or `in-review` (§3.6)

| State | Condition | Reading |
|---|---|---|
| `evolving` | `S > 0` and `P > 0` | Live and actively being expanded — includes shipped Workflows whose `next` evolution is mid-build. |
| `stable` | `S > 0` and `P = 0` | Live and untouched. |
| `incubation` | `S = 0` and `P > 0` | The V1 build phase. |
| `draft` | `S = 0` and `P = 0` | Resting state. |

Notes:

- **Bugs do not affect Journey states.** A Workflow flipping `stable` → `unstable` does not change its Journey.
- `in-review` counts toward `P`, whether on `current.mdx` (unshipped Workflow) or `next.mdx` (evolution of a shipped Workflow).
- A shipped Workflow with no open `next.mdx`, or whose `next.mdx` is still `draft`/`ready`, contributes to `S` but not `P`.
- Workflows in `draft`, `ready`, `cancelled`, or `deprecated` (and not evolving) contribute to neither count.
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

### 5.2 Rule 1 — No Ghost Workflows

A Workflow MUST NOT transition to `ready` or `in-progress` unless, at validation time:

1. it has at least one `belongs_to` edge to a Journey, **and**
2. it has at least one `depends_on` edge to a Foundation.

Rationale: work that belongs to no capability and stands on no infrastructure is unroutable and unreviewable — it must not enter execution.

### 5.3 Rule 2 — Infrastructure First

A Workflow MUST NOT `ship` (transition from `in-review` to production) unless **every** Foundation and **every** Workflow reachable via its direct `depends_on` edges is in state `stable`. The rejection message MUST enumerate each non-stable dependency with its current state.

Rationale: concrete must be poured before the roof is built. A feature cannot go live on infrastructure or prerequisite workflows that are not stable in production.

### 5.4 Rule 3 — The Completion Check

A Workflow MUST NOT transition to `in-review` or `ship` while its active territory file (`current.mdx`, or `next.mdx` while evolving) contains one or more unchecked Atomic Operations (`[ ]`). A Bug MUST NOT transition to `in-review` or `resolved` while unchecked items remain. The rejection message MUST include the count of open checkboxes.

Rationale: review is a gate on *finished* work. The checklist in the Territory is the definition of done.

### 5.5 Rule 4 — No Ghost Bugs

A Bug MUST NOT transition to `triaged` or `fixing` unless it has at least one `affects` edge to a Workflow or Foundation at validation time.

### 5.6 Rule 5 — Computed Journeys

Manual status mutation of a Journey MUST be rejected (§4). This is a compiler rule, not a convention.

### 5.7 Rule 6 — Computed Stability

Manual mutation of a Foundation or Workflow to `stable` or `unstable` MUST be rejected. Production posture is computed per §3.5 after `ship` and whenever open Bugs change.

### 5.8 Rule 7 — Taxonomy enforcement at link time

Edge creation MUST validate:

- both node ids exist in territory,
- the edge shape is legal per §2.2,
- the edge is not a self-link and not a duplicate,
- `depends_on` edges do not create a cycle (§2.2).

### 5.9 Rule 8 — Dependency Closure

When linking a Workflow to a Journey via `belongs_to`, the server MUST verify that **every** Workflow in the transitive `depends_on` closure of the source Workflow already has a `belongs_to` edge to the same Journey.

If any dependency Workflow is missing from the Journey, the link MUST be rejected unless the caller passes `link_dependent: true` on `link_nodes`. When `link_dependent` is true, the server MUST automatically add `belongs_to` edges from each missing dependency Workflow to the same Journey before persisting the requested link.

The rejection message MUST enumerate each missing dependency Workflow id and mention the `link_dependent` flag.

Rationale: a Journey is a coherent domain capability. A Workflow that depends on another Workflow implicitly requires that prerequisite use case to be part of the same Journey.

### 5.10 Rule 9 — Version Lineage (stable-id evolution)

`open_next` MUST validate:

- the node exists and is type `Workflow` or `Foundation`,
- the node is in state `stable` or `unstable` (shipped) — Journeys, Bugs, and unshipped Foundations/Workflows MUST be rejected,
- the node has no existing `next.mdx` — at most one open evolution per node at a time; the rejection message MUST name the `next` slot's current pipeline state and point to `ship` (from `next` in-review) or `discard_next` as the way to clear it.

`discard_next` MUST validate:

- the node has an existing `next.mdx` to delete.

While `next.mdx` is open, the manual build pipeline transitions (`draft → ready → in-progress → in-review`) and Rules 1/3 apply to the `next` slot's own state, checkboxes, and proposed edges — not to `current.mdx`, which is untouched and keeps serving. A node with an open `next.mdx` MUST NOT be transitioned to `deprecated`; `discard_next` (or shipping the evolution) MUST run first.

On successful `update_node_status(..., "ship")` for a node whose `next.mdx` is `in-review`, the server MUST:

1. re-validate Rule 2 (Infrastructure First) and Rule 3 (Completion Check) against `next`'s proposed `depends_on` and checkboxes,
2. **promote**: copy `next.mdx`'s body, title, description, and proposed `belongs_to`/`depends_on` onto `current.mdx` under the unchanged `id`, merge `next-attachments/` into `attachments/`, compute the new `stable`/`unstable` from open Bugs (§3.5), and delete `next.mdx`/`next-attachments/`.

There is no successor id, no relinking step, and no predecessor to auto-deprecate: the `id` never changes, so every existing `depends_on`/`belongs_to`/`affects` edge that already targets this node continues to resolve correctly through and after the promotion.

Rationale: versioning models replacement without downtime during the build, without ever forcing dependents to discover and re-point at a new id. Git history of `current.mdx` — not a graph edge — is the audit trail for what a node's evolution changed at each ship.

### 5.11 Rule 10 — Force Unship (mistaken ship recovery)

`force_unship` MAY reverse a mistaken Foundation/Workflow ship. It is the only legal path from `stable`/`unstable` back to a pre-ship execution state. The server MUST:

1. require `confirm` exactly equal to `unship:<node_id>` — any other value MUST be rejected with a message that tells the agent to ask the user and not invent confirmation,
2. accept only Foundation/Workflow nodes currently in `stable` or `unstable`,
3. reject while `next.mdx` is open (`discard_next` first),
4. reject while any **direct** `depends_on` dependent is itself `stable` or `unstable` (enumerate them; force-unship or deprecate dependents first so Infrastructure First remains coherent),
5. accept `new_status` only in `draft | ready | in-progress | in-review` (default `ready` when omitted),
6. apply Ghost Workflow / Completion Check gates appropriate to the target state (same as a normal transition into that state),
7. clear `shipped_at` on `current.mdx`, set `state` to the target, recompute Journey states, and refresh `mindplan/map.md`.

Agents MUST obtain an explicit human yes in the conversation before calling `force_unship`. Agents MUST NOT invent or “helpfully” supply `confirm`. Journeys and Bugs MUST be rejected. Manual `stable`/`unstable` remains forbidden (§5.7).

### 5.12 Enforcement ordering

For a status mutation the compiler MUST evaluate, in order:

1. node exists → 2. node is not a Journey → 3. resolve the active slot (`next.mdx` if open, else `current.mdx`) → 4. target state is valid for that slot → 5. transition is legal per §3 (or §3.6 next-pipeline transitions) → 6. Rules 1–4 (type-specific, evaluated against the active slot) → **write** → 7. on `ship` from `next` in-review, promote `next` over `current` per Rule 9 (§5.10) → 8. recompute stability (§3.5) → 9. recompute Journey states (§4) → 10. synchronize frontmatter.

For `force_unship`: validate Rule 10 (§5.11), clear `shipped_at`, write pre-ship `state`, recompute Journey states, synchronize frontmatter.

For `link_nodes` / `unlink_nodes` involving `affects`: validate §5.8, write edge, recompute stability for affected targets, recompute Journeys if applicable, mirror frontmatter.

For `link_nodes` involving `belongs_to` (Workflow → Journey): validate §5.8, evaluate Rule 8 (Dependency Closure), write edge(s) to the active slot (`next` if open, else `current`), recompute Journey states, mirror frontmatter.

For `link_nodes` involving `depends_on`: validate §5.8 including cycle check, write edge to the active slot (`next` if open, else `current`), mirror frontmatter.

For `open_next`: validate Rule 9 (§5.10), copy `current.mdx` body and outgoing edges into a new `next.mdx` in `draft`; `current.mdx` and its edges are unchanged.

For `discard_next`: validate Rule 9 (§5.10), delete `next.mdx`/`next-attachments/`; `current.mdx` is unchanged.

---

## 6. Territory File Format

### 6.1 `current.mdx` structure

Every entity's `current.mdx` MUST begin with YAML frontmatter followed by an MDX body (Markdown plus optional JSX per §6.4). An open `next.mdx` (Foundation/Workflow only, §3.6) uses the same frontmatter+body shape, scoped to the fields in the table below marked "also on `next.mdx`":

```mdx
---
id: wf-checkout-split
type: Workflow
title: "Split & pay checkout"
description: "Diner splits and pays the bill from their phone"
state: in-progress
created_at: 2026-07-14T06:00:00.000Z
updated_at: 2026-07-14T07:00:00.000Z
belongs_to:
  - j-ordering
depends_on:
  - f-db-core
---

# Split & pay checkout

Diner splits and pays the bill from their phone.

<StateBadge />

## Execution Logic

Step-by-step business behaviour…

## Checklist

- [x] Requirements defined
- [ ] Implementation complete
- [ ] Tests passing

## Attachments

![wireframe](attachments/checkout-wireframe.png)
<Attachment file="checkout-flow.pdf" caption="Full payment flow" />
```

Frontmatter fields:

| Field | Type | Written by | Notes |
|---|---|---|---|
| `id` | string | server, at creation | Immutable for the node's lifetime, including every evolution. MUST equal folder name. Also on `next.mdx`. |
| `type` | `Journey \| Foundation \| Workflow \| Bug` | server, at creation | Immutable. Also on `next.mdx`. |
| `title` | string (JSON-quoted) | territory | Human-readable. Stored only in frontmatter. Also on `next.mdx` (proposed title, promoted on ship). |
| `description` | string (JSON-quoted) | territory | Short summary. Stored only in frontmatter. Also on `next.mdx` (proposed description, promoted on ship). |
| `state` | string | **server only** | On `current.mdx`: build pipeline, computed production, or Bug lifecycle. On `next.mdx`: the pipeline sub-state of the evolution (`draft \| ready \| in-progress \| in-review`, §3.6) — never `stable`/`unstable`/`deprecated`. Patched by MCP on accepted transitions. |
| `created_at` | ISO-8601 | server, at creation | Immutable; present only on `current.mdx` and never rewritten by an evolution. |
| `updated_at` | ISO-8601 | **server only** | Touched on every accepted state or edge mutation to that slot. Also on `next.mdx`. |
| `shipped_at` | ISO-8601 | **server only** | `current.mdx` only. Optional; set on `ship` (first build or promotion of `next`, §3.6). |
| `severity` | `low \| medium \| high \| critical` | optional | Bug nodes only; informational in v1. |
| `belongs_to` | string[] | **server only** | Workflow only. Target Journey ids (outgoing `belongs_to` edges). Omitted when empty. On `next.mdx`: proposed edges, applied to `current.mdx` on ship. |
| `depends_on` | string[] | **server only** | Workflow or Foundation. Target Foundation or Workflow ids (outgoing `depends_on` edges). Omitted when empty. On `next.mdx`: proposed edges, applied to `current.mdx` on ship. |
| `affects` | string[] | **server only** | Bug only. Target Workflow or Foundation ids (outgoing `affects` edges). Omitted when empty. |

The body is free-form and owned by humans and agents. Frontmatter `title:` and `description:` are territory-owned and MAY be edited after creation (on `current.mdx` pre-ship, or on `next.mdx` at any next-pipeline state). Server-owned frontmatter fields (`state`, `updated_at`, `shipped_at`, `belongs_to`, `depends_on`, `affects`) MUST be written only via MCP tools.

Frontmatter delimiters (`---`) MUST appear before any JSX. MDX comments use `{/* ... */}` syntax; HTML comments (`<!-- -->`) are not valid MDX and MUST NOT be used in the body.

### 6.2 Frontmatter mirroring

After any accepted mutation, the server MUST rewrite server-owned fields in each affected node's territory frontmatter:

- **Status mutations:** `state:` and `updated_at:` on the transitioned node's active slot (`current.mdx`, or `next.mdx` while an evolution is open) plus every Journey whose computed state changed; `shipped_at:` on `current.mdx` when a first build or a `next` promotion ships.
- **Link/unlink:** the appropriate outgoing edge array (`belongs_to`, `depends_on`, or `affects`) on the source node's active slot, plus `updated_at:`.
- **Opening an evolution (`open_next`):** creates `next.mdx` with `state: draft`, copied/overridden `title:`/`description:`, and `belongs_to:`/`depends_on:` proposed from `current.mdx`'s edges at open time.
- **Discarding an evolution (`discard_next`):** deletes `next.mdx` and `next-attachments/`; `current.mdx` is untouched.
- **Ship / promotion (`update_node_status(..., "ship")`):** on a first build, writes `state:`, `updated_at:`, and `shipped_at:` on `current.mdx`. When promoting an open `next.mdx`, copies `next.mdx`'s `title:`, `description:`, `belongs_to:`, and `depends_on:` onto `current.mdx`, sets `state:` to the computed `stable`/`unstable`, refreshes `updated_at:`/`shipped_at:`, and deletes `next.mdx`/`next-attachments/`. There is no other node's frontmatter to update — the `id` never changes, so no dependent's `depends_on`/`belongs_to`/`affects` array needs rewriting.

Edge arrays use YAML block-list syntax. Empty arrays MUST be omitted from the file. If the file is missing or has no frontmatter, mirroring is skipped silently.

### 6.3 Scaffolding templates

`create_node` MUST scaffold the entity folder with a type-appropriate `current.mdx` and an empty `attachments/` directory (with `.gitkeep` so the folder is versionable). `next.mdx` and `next-attachments/` are never scaffolded by `create_node` — they are created only by `open_next` on an already-shipped Foundation/Workflow (§3.6, §8.2):

- **Journey** — Overview section (domain capability + use cases it owns), Linked Workflows note, Attachments note. No checklist (Journeys have no completion gate). No implementation package.
- **Foundation** — Shared Substrate Spec section (role tag belongs in frontmatter `description` at create time — Assembler | Infra | Design system | Adapter; body covers schemas, adapters, design system, contracts — not use-case behaviour), Checklist (3 default Atomic Ops), Attachments note. Also scaffolds `src/foundations/<id>/` (§1.2).
- **Workflow** — Execution Logic section (use-case steps), Checklist (3 default Atomic Ops), Attachments note. Also scaffolds `src/workflows/<id>/` (§1.2).
- **Bug** — Summary, Repro Steps, Expected/Actual, Fix Checklist (3 default Atomic Ops), Attachments note. Created in state `open` (§3.4). No implementation package.

Default checklist items are placeholders; teams SHOULD replace them with real Atomic Ops during `draft` or triage.

#### 6.3.1 Implementation packages

`create_node` for Workflow and Foundation MUST create the prescribed implementation package (§1.2) with a `.gitkeep` so the folder is versionable — **unless** `implementation_packages` is `off` (§1.2.1), in which case only territory is scaffolded. The package path is derived — it is not stored in frontmatter and is not an edge.

Agents MUST place all implementation for that node under its package. Agents query the package via `get_node_implementation` (§8.1). There is no per-file affected-files list in territory — architecture is the graph plus package roots.

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
| `<Affects>` | `id: string` (Workflow or Foundation id) | Inline reference to an afflicted node. Informational — `affects` in frontmatter is the authority. |
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
2. Markdown task-list syntax (Completion Check, §3.3/§5.4).

Consequences:

- JSX anywhere in the body — known or unknown, well-formed or broken — has no effect on any accept/reject decision.
- `<AtomicOp done={false} />` does not count as an open checkbox. Work items that must gate `in-review`/`ship` (Workflows) or `in-review`/`resolved` (Bugs) MUST be expressed as `- [ ]` Markdown items.
- Determinism (§9.1) is preserved: rule evaluation never depends on component resolution, a renderer, or the host project's toolchain.

#### 6.4.5 Rendering

Rendering MDX is out of scope for the MCP server. Viewers (docs sites, dashboards, IDE previews) resolve reserved names to the standard library and all other names to `mindplan/components/`. Until a viewer exists, agents and humans read context files as plain text; the JSX reads as self-describing markup.

---

## 7. Graph Assembly

There is no central graph file. At runtime the server scans `mindplan/<type>s/<id>/current.mdx` frontmatter to assemble nodes and expands outgoing edge arrays into flat edge triples. When a Foundation/Workflow folder also has a `next.mdx`, the server additionally parses it into that node's `next` slot (§3.6); `next.mdx`'s proposed `belongs_to`/`depends_on` are **not** expanded into graph edges — only `current.mdx`'s edges are live.

### 7.1 Runtime graph shape

`get_mindplan_graph` returns:

```jsonc
{
  "version": 1,
  "nodes": [ /* from frontmatter §6.1, each optionally carrying a "next" slot */ ],
  "edges": [
    { "source": "wf-checkout-split", "target": "j-ordering", "type": "belongs_to" },
    { "source": "wf-checkout-split", "target": "f-db-core", "type": "depends_on" },
    { "source": "bug-race", "target": "wf-checkout-split", "type": "affects" }
  ]
}
```

`version` identifies the schema generation (currently `1`). It is a constant reported by the server — not persisted to disk.

### 7.2 Edge persistence rule

Outgoing edges are stored **only on the source node** in frontmatter:

| Edge type | Source type | Frontmatter field |
|---|---|---|
| `belongs_to` | Workflow | `belongs_to: [journey-id, …]` |
| `depends_on` | Workflow, Foundation | `depends_on: [foundation-or-workflow-id, …]` |
| `affects` | Bug | `affects: [workflow-or-foundation-id, …]` |

Journeys have no outgoing edges. Incoming relationships are derived at scan time (e.g. a Journey discovers member Workflows by scanning all Workflow `belongs_to` arrays). A `next.mdx`'s `belongs_to`/`depends_on` are proposed edges scoped to that node's evolution (§3.6) — they live in the same frontmatter shape but are not part of the assembled graph's edge triples until promoted onto `current.mdx` at ship time.

### 7.3 Invariants

- Every edge endpoint MUST reference an existing territory node (folder + `current.mdx`).
- Edge triples are unique per `(source, target, type)`.
- Edge arrays MUST only appear on node types permitted by §7.2.
- `next.mdx` MUST only exist alongside a `current.mdx` for the same Foundation/Workflow id and MUST NOT introduce a new `id`.

---

## 7.4 Graph views (projections)

Exporters MAY render a deterministic typed-DAG projection of the assembled graph for humans (PRs, docs, local preview). Views MUST NOT become a second write path for node records or edges — frontmatter remains the sole graph authority (§7, §9.3).

**Exception — auto-persisted Mermaid snapshot:** after every successful graph mutation (`create_node`, `link_nodes`, `unlink_nodes`, `open_next`, `discard_next`, `update_node_status`, `force_unship`), the server MUST write a full Mermaid projection to `mindplan/map.md`. That file is derived output (regenerated, not hand-edited); it MUST NOT be read back as graph state. On-demand projections via MCP `export_mindplan_view` (§8.1) and CLI `mindplan-mcp view` remain available and do not replace `map.md` unless the caller writes a file explicitly.

Reference formats: Mermaid (`flowchart`) and Graphviz DOT.

### Layout conventions

| Element | Rendering |
|---|---|
| Journey | Cluster / subgraph (container; no outgoing edges) |
| Workflow | Node inside every Journey it `belongs_to` (multi-membership: one instance per Journey in Mermaid; DOT places the node in the lexicographically first Journey and annotates others) |
| Foundation | Shared infrastructure cluster |
| Bug | Overlay node; `affects` drawn dashed |
| `depends_on` | Solid dependency arrow |
| `belongs_to` | Encoded by clustering — omitted as an edge in diagrams |
| Node label | `id · title · state` |

A node with an open `next.mdx` renders once, at its `current.mdx` state and id — `next` is an in-flight territory slot, not a second node, and has no dedicated diagram representation in v3.

Workflows with no `belongs_to` into a Journey present in the view appear under an **Unassigned workflows** band.

### Filters

By default, views MUST exclude:

- nodes in state `deprecated` or `cancelled`
- Bugs in terminal states `resolved` or `wontfix`

Pass `include_retired: true` (MCP) or `--include-retired` (CLI) to include them.

Optional `focus` limits the view to that node plus its 1-hop linked neighborhood (same neighborhood definition as `find_related_nodes`).

MDX component rendering (§6.4) and external board sync (§10) remain separate concerns and are out of scope for graph-view exporters.

---

## 8. MCP Tool Contract

The server exposes exactly fourteen tools over stdio. All inputs are validated with zod; all failures follow the §5.1 error contract. Responses are JSON text payloads.

### 8.1 Read tools

#### `get_mindplan_graph`

- **Input:** none.
- **Output:** `{ version, nodes, edges }` assembled from territory frontmatter (§6.1, §7).
- **Errors:** none beyond I/O failures.

#### `export_mindplan_view`

Exports a deterministic typed-DAG projection (§7.4) as Mermaid or DOT. Prefer `find_related_nodes` for agent orientation JSON; use this when a human diagram / architecture map is needed. Note: successful graph mutations also auto-write the full Mermaid projection to `mindplan/map.md` (§7.4); this tool does not itself write that file.

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
  - `type` (`Journey|Foundation|Workflow|Bug`, optional) — filter candidates before ranking.
  - `limit` (integer 1–20, optional, default `5`) — max ranked matches returned.
  - At least one of non-empty `query` or `node_id` is required.
- **Ranking:** scan territory via `loadGraph()` each call (no in-memory cache, no embeddings). Tokenize `query` on non-alphanumeric characters (lowercase). Score: exact `id` match ≫ `id` substring ≫ title token hits ≫ description token hits. Sort by score descending, then `id` ascending. Nodes with score `0` are omitted from `matches`.
- **Focus selection:** if `node_id` is provided, `focus` is that id (after existence check). Otherwise `focus` is the highest-scoring match, or `null` when there are no matches.
- **Neighborhood:** all edges where `source` or `target` is `focus` (all three edge types); `nodes` includes the focus and every endpoint of those edges. Summaries only: `id`, `type`, `state`, `title`, `description`.
- **Output:**

```jsonc
{
  "query": "checkout split payment",
  "matches": [
    { "id": "wf-checkout-split", "type": "Workflow", "state": "in-progress", "title": "...", "description": "...", "score": 12 }
  ],
  "focus": "wf-checkout-split",
  "nodes": [ /* focus + 1-hop neighbors */ ],
  "edges": [ /* edges incident to focus */ ]
}
```

- **Errors:** neither `query` nor `node_id`; unknown `node_id`. Empty matches with a valid query and no `node_id` is success: `focus: null`, empty `nodes`/`edges`.

#### `get_blast_radius`

- **Input:** `node_id` (slug).
- **Output:** `{ node_id, affected: [{ id, type, state, distance }], journeys_at_risk: [journey-id, …] }` where:
  - `affected` is the transitive reverse-`depends_on` closure (BFS) from `node_id` (distance 0 seed omitted from results),
  - `journeys_at_risk` lists Journey ids linked via `belongs_to` from affected Workflows.
- **Errors:** unknown `node_id`.
- **Rationale:** calling this before `open_next` — or on a node with an open `next.mdx` — surfaces the same live dependents either way: the stable-id model means an evolution never changes what depends on the node, so there is nothing analogous to `via_supersedes` to seed from.

#### `get_node_context`

- **Input:** `node_id` (slug).
- **Output:** always includes the live `current.mdx` slice; when the node has an open `next.mdx` (Foundation/Workflow only), also includes a `next` object with that slot's record, body, and paths:

```jsonc
{
  "folder": "mindplan/workflows/wf-checkout-split",
  "context_path": "mindplan/workflows/wf-checkout-split/current.mdx", // deprecated alias; prefer current_path
  "current_path": "mindplan/workflows/wf-checkout-split/current.mdx",
  "attachments_path": "mindplan/workflows/wf-checkout-split/attachments",
  "attachments": ["checkout-wireframe.png"],
  "record": {
    "id": "wf-checkout-split",
    "type": "Workflow",
    "state": "in-progress",
    "title": "Split & pay checkout",
    "description": "Diner splits and pays the bill from their phone",
    "created_at": "...",
    "updated_at": "...",
    "belongs_to": ["j-ordering"],
    "depends_on": ["f-db"]
  },
  "body": "# Split & pay checkout\n\n...",
  "title": "Split & pay checkout",
  "description": "Diner splits and pays the bill from their phone",
  "raw_context": "---\nid: wf-checkout-split\n...", // deprecated; prefer record + body
  "next": null
  // when next.mdx exists, the payload also carries:
  //   "next_path": ".../next.mdx", "next_attachments_path": ".../next-attachments",
  //   "next": { "record": { state, title, description, updated_at, belongs_to?, depends_on? }, "body": "...", "raw": "..." }
}
```

- **Errors:** unknown `node_id`; missing `current.mdx`.

#### `orient_for_work`

Composite orientation for agents: `find_related_nodes` plus full territory for the focus node and `get_blast_radius` when the focus is a Foundation or Workflow.

- **Input:** same as `find_related_nodes` (`query`, `node_id`, `type`, `limit`).
- **Output:** `{ query, matches, focus, nodes, edges, context, blast_radius }` where `context` matches `get_node_context` (without `raw_context`) when `focus` is set, else `null`; `blast_radius` matches `get_blast_radius` for Foundation/Workflow focus, else `null`.
- **Errors:** same as `find_related_nodes`.

#### `get_node_implementation`

Returns the prescribed implementation package for a Workflow or Foundation (§1.2), or a packages-off result when layout-free (§1.2.1).

- **Input:** `node_id` (slug; must be a Workflow or Foundation).
- **Output (packages required):**

```jsonc
{
  "node_id": "wf-checkout-split",
  "root": "src/workflows/wf-checkout-split",
  "exists": true,
  "implementation_packages": "required",
  "entries": [".gitkeep"]
}
```

- **Output (packages off):**

```jsonc
{
  "node_id": "wf-checkout-split",
  "root": null,
  "exists": false,
  "implementation_packages": "off",
  "entries": []
}
```

`root` is the derived project-relative package path when `implementation_packages` is `required`. When packages are `off`, `root` is always `null` and `exists` is always `false` — that means packages are **not applicable**, not that a package is missing. Agents MUST read `implementation_packages` before interpreting `exists`/`root`. When packages are `required` and `exists` is true, `entries` lists **top-level** names in the package (sorted); otherwise `entries` is omitted or empty.

- **Errors:** unknown `node_id`; node is a Journey or Bug (`Blocked: … only applies to Workflow and Foundation nodes`).

#### `patch_node_territory`

Patches territory-owned content on `current.mdx` or `next.mdx`. Server-owned frontmatter (`state`, edge arrays, `shipped_at`) is never modified.

- **Input:**
  - `node_id` (slug, required)
  - `title` (string, optional) — pre-ship Workflow (`current`) or an open `next` slot only
  - `description` (string, optional) — pre-ship Workflow (`current`) or an open `next` slot only
  - `body` (string, optional) — replaces entire body below frontmatter
  - `toggle_checkboxes` (array of `{ contains, checked }`, optional) — match checkbox lines by substring
  - `slot` (`current` \| `next`, optional) — explicitly select the territory file to patch; errors if `next` is requested but no `next.mdx` exists
  - At least one patch field is required.
- **Slot resolution:** when `slot` is omitted, the server patches `next.mdx` if the node is a shipped (`stable`/`unstable`) Foundation/Workflow with an open evolution, otherwise `current.mdx`.
- **Effect:** writes territory body and/or `title`/`description` scalars on the resolved slot; touches `updated_at` in that slot's frontmatter.
- **Output:** `{ node_id, patched_fields: ["description", ...], slot: "current" | "next", path, changed_files: string[] }` — `path` is the repo-relative MDX written; `changed_files` lists that path. Interactive agents SHOULD prefer host file tools for prose; this tool is an optional fallback.
- **Errors:** unknown `node_id`; empty patch; no matching checkbox line; explicit `slot: "next"` with no `next.mdx`; shipped Workflow `title`/`description` change on `current` (`Use open_next for material scope changes on live work.`).

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

- **Input:** `id` (slug), `type` (`Journey|Foundation|Workflow|Bug`), `title` (non-empty), `description`.
- **Effect:** scaffolds the entity folder with a full-frontmatter `current.mdx` (§6.3). For Workflow and Foundation, when `implementation_packages` is `required`, also scaffolds the prescribed implementation package under `src/` (§1.2, §6.3.1); when `off`, only territory is created (§1.2.1). Does not write edge fields — those are added by `link_nodes`. Never creates a `next.mdx`.
- **Output:** `{ created: <node from frontmatter>, folder, current, context, attachments, implementation?, implementation_packages?, changed_files }` (project-relative paths; `context` is a deprecated alias for `current`; `implementation` is the package root when scaffolded; `implementation_packages: "off"` is set when packages are disabled).
- **Errors:** duplicate `id`.

#### `open_next`

- **Input:** `node_id` (shipped Foundation or Workflow), `title` (optional), `description` (optional).
- **Effect:** validates Rule 9 (§5.10), copies `current.mdx`'s body and outgoing `belongs_to`/`depends_on` into a new `next.mdx` in pipeline state `draft` (overriding `title`/`description` when provided) and creates an empty `next-attachments/`. `current.mdx`, its state, and its edges are completely unchanged — the live node keeps serving.
- **Output:** `{ node_id, live_state, next: { state, title, description, updated_at, belongs_to?, depends_on? }, folder, current, next_path, changed_files }`.
- **Errors:** unknown `node_id`; wrong type (not Workflow/Foundation); node not shipped (`stable`/`unstable`); node already has an open `next.mdx`.

#### `discard_next`

- **Input:** `node_id` (Foundation or Workflow with an open `next.mdx`).
- **Effect:** deletes `next.mdx` and `next-attachments/`, abandoning the in-flight evolution. `current.mdx` is untouched.
- **Output:** `{ node_id, discarded: true, live_state, changed_files }`.
- **Errors:** unknown `node_id`; node has no `next.mdx` to discard.

#### `link_nodes`

- **Input:** `source_id`, `target_id`, `edge_type` (`depends_on|belongs_to|affects`), optional `link_dependent` (boolean; only applies to `belongs_to` Workflow → Journey).
- **Effect:** validates §5.8 and §5.9 (Dependency Closure for `belongs_to`), then appends the target id to the source node's outgoing edge array — on `current.mdx`, or on the proposed `belongs_to`/`depends_on` of an open `next.mdx` when the source is a Foundation/Workflow currently evolving (§2.2) — plus any cascaded `belongs_to` edges when `link_dependent` is true. Recomputes stability (§3.5) and Journey states (§4) from the live graph (`next`-slot edges never affect these computations until promoted), patches affected frontmatter fields.
- **Output:** `{ linked: {source, target, type}, slot: "current" | "next", dependents_linked: [...], journeys_recomputed: [...], stability_recomputed: [{id, state}], changed_files }`.
- **Errors:** unknown ids; illegal shape; self-link; duplicate edge (on the resolved slot); dependency cycle; Dependency Closure violation (missing workflow dependencies not in Journey).

#### `unlink_nodes`

- **Input:** `source_id`, `target_id`.
- **Effect:** removes **all** edges from `source_id` to `target_id` (any type) from the source node's `current.mdx` frontmatter and, when present, from an open `next.mdx`'s proposed edges; recomputes stability and Journey states; mirrors frontmatter.
- **Output:** `{ removed: <count>, journeys_recomputed: [...], stability_recomputed: [...], changed_files }`.
- **Errors:** unknown ids; no edge exists between the pair (on either slot).
- **Note:** unlinking does not retroactively demote a Workflow already past a gate; guardrails are evaluated at transition time only (§9.2).

#### `update_node_status`

- **Input:** `node_id`, `new_status` (string; build/Bug state name, or `ship` for Foundation/Workflow production entry).
- **Effect:** runs the full §5.11 pipeline. When the node has no open `next.mdx`, mutations apply to `current.mdx` exactly as in a first build. When `next.mdx` is open, `draft`/`ready`/`in-progress`/`in-review` transitions apply to the `next` slot only; `ship` (only legal from `next` in-review) **promotes**: copies `next.mdx`'s body/title/description/proposed edges onto `current.mdx`, merges non-`.gitkeep` files from `next-attachments/` into `attachments/`, computes `stable`/`unstable` from open Bugs, sets `shipped_at`, and deletes `next.mdx`/`next-attachments/` (§3.6, §5.10). Recomputes stability and Journey states, persists, mirrors frontmatter.
- **Output:** `{ node_id, previous_state, new_state, next_state, shipped_at, promoted_next: boolean, journeys_recomputed: [...], stability_recomputed: [...], changed_files }`. On promote, `changed_files` includes `current.mdx`, deleted `next.mdx` / `next-attachments/` paths, and any `attachments/<file>` copies from the next slot.
- **Errors:** unknown id; Journey target; invalid state name; illegal transition (on the active slot); Rule 1–4 violations; manual `stable`/`unstable` attempt; `ship` attempted while `next.mdx` is not in-review; `deprecated` attempted while `next.mdx` is open. Illegal production retreats SHOULD mention `force_unship` and the `unship:<node_id>` confirm shape.

#### `force_unship`

- **Input:** `node_id`, `confirm` (exact string `unship:<node_id>`), optional `new_status` (`draft|ready|in-progress|in-review`, default `ready`).
- **Effect:** runs Rule 10 (§5.11): clears `shipped_at`, sets pre-ship `state` on `current.mdx`, recomputes Journey states, refreshes `mindplan/map.md`.
- **Output:** `{ node_id, previous_state, new_state, shipped_at: null, force_unship: true, journeys_recomputed: [...], stability_recomputed: [...], changed_files }`.
- **Errors:** wrong/missing confirm; not Foundation/Workflow; not `stable`/`unstable`; open `next.mdx`; shipped direct dependents; invalid target; Ghost Workflow / Completion Check failures for the target state.
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

- `current.mdx`/`next.mdx` **body** and frontmatter **`title:`** / **`description:`** edits are a first-class part of the workflow.
- `current.mdx`/`next.mdx` server-owned frontmatter (`state`, `updated_at`, `shipped_at`, `belongs_to`, `depends_on`, `affects`) MUST be written only via MCP tools. Hand-editing voids the framework's guarantees. Manually creating, editing, or deleting `next.mdx` outside `open_next`/`update_node_status`/`discard_next` is likewise out of contract.

### 9.4 Concurrency

The reference implementation assumes a single writer (one MCP server instance per project). Deployments requiring concurrent writers MUST serialize mutations externally.

### 9.5 Deprecation, cancel, and orphans

Transitioning a Workflow to `deprecated` (post-ship) or `cancelled` (pre-ship) SHOULD be followed by an orphan review: any Foundation whose only consumers are now retired is a candidate for deprecation or cancel itself. When change is due to a **replacement of scope on live work** rather than retirement, use `open_next` instead — the node keeps its id and edges and simply gains new territory and state under the same folder until the evolution ships (§3.6); there is no predecessor to auto-deprecate in the stable-id model. Implementations MAY automate orphan checks; the reference implementation leaves it to the operator (the graph query is trivial via `get_mindplan_graph` or `get_blast_radius`).

### 9.6 Offline integrity check (`mindplan-mcp check`)

The package binary exposes an offline CLI (same entry as MCP stdio, no stdio session required) that audits territory without mutating it. Behavior depends on `mindplan/config.json` `implementation_packages` (missing → `required`):

| Mode | Command | Checks |
|------|---------|--------|
| Default (`required`) | `mindplan-mcp check [--base <ref>]` | Graph load; every non-retired Foundation/Workflow has `src/{foundations\|workflows}/<id>/`; no orphan package dirs; dirty `src/` ownership: **uncommitted** paths require `in-progress` (or `next` in-progress, or Bug `fixing`/`in-review`); **committed** paths vs `base...HEAD` allow `in-progress`/`in-review`/`stable`/`unstable`/`cancelled`/`deprecated`, but when `next.mdx` is open only `next` in `in-progress`/`in-review` counts (not draft/ready). Explicit `--base` fails closed on git errors. |
| Default (`off`) | `mindplan-mcp check [--base <ref>]` | Graph load only — skips package presence, orphans, and dirty-src ownership (layout-free / brownfield) |
| Invalid config | any check mode | Fail immediately if `mindplan/config.json` exists but is invalid (bad JSON / mode); do not treat as `required` |
| Main gate | `mindplan-mcp check --for-main` | Graph load; package checks only when `required`; fail if any Foundation/Workflow is `in-progress`/`in-review` (or `next` in those states), or any Bug is `fixing`/`in-review`. Does **not** run dirty-src |

Exit code `0` on success, `1` with `Blocked: …` lines on failure. This repo’s CI builds from source (`node dist/index.js check …`). Consumer repos SHOULD use the published bin after npm release.

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
- [ ] Build taxonomy + defect layer and all three edge types are enforced per §2.
- [ ] Build pipeline, Bug lifecycle, and computed `stable`/`unstable` are enforced per §3.
- [ ] The stable-id evolution model (`open_next` / `next.mdx` / promote-on-ship / `discard_next`) is enforced per §3.6, with no version-lineage edge and no dependent relinking.
- [ ] Journey states are computed, never settable, per §4 (including `next`-slot activity); Bugs do not affect Journeys.
- [ ] Rules 1–10 are enforced pre-write, fail-fast, per §5 (Rule 9 as `open_next`/`ship`-promotes/`discard_next`, §5.10; Rule 10 as `force_unship`, §5.11).
- [ ] Every rejection message starts with `Blocked: ` per §5.1.
- [ ] `current.mdx`/`next.mdx` frontmatter is server-mirrored per §6 (state and edge arrays).
- [ ] The MDX component contract holds per §6.4: reserved names respected, project components opaque, no guardrail parses JSX.
- [ ] Edges persist in source-node `current.mdx` frontmatter and assemble at runtime per §7; `next.mdx` proposed edges are not live graph edges.
- [ ] The fourteen-tool MCP surface matches §8 (names, inputs, outputs, errors).
- [ ] Mutations are deterministic and atomic per §9.

---

## Appendix A — Canonical error catalog

| Rule | Example message |
|---|---|
| Unknown node | `Blocked: node "wf-x" does not exist in mindplan territory.` |
| Duplicate node | `Blocked: node "wf-checkout" already exists.` |
| Illegal edge shape | `Blocked: belongs_to edges must go Workflow -> Journey. Got Foundation "f-db" -> Journey "j-ordering".` |
| Journey dependency | `Blocked: a Journey cannot depend on a Foundation. Journeys are permanent containers with no direct code execution.` |
| Duplicate edge | `Blocked: edge wf-checkout -depends_on-> f-db already exists.` |
| Manual Journey state | `Blocked: Journey states are computed automatically from their Workflows and cannot be set manually.` |
| Manual stability | `Blocked: stable/unstable are computed from open Bugs and cannot be set manually. Use ship from in-review.` |
| Invalid state name | `Blocked: "active" is not a valid state. Valid build states: draft -> ready -> in-progress -> in-review -> ship -> stable/unstable -> deprecated.` |
| Illegal transition | `Blocked: illegal transition "in-progress" -> "stable" for node "wf-tips". Allowed from "in-progress": in-review, ready.` |
| Rule 1 (Ghost Workflow) | `Blocked: Ghost Workflow. "wf-checkout" has no belongs_to edge to a Journey. Link it with link_nodes before moving it to "ready".` |
| Rule 2 (Infra First) | `Blocked: Infrastructure First. Workflow "wf-checkout" cannot ship while linked Foundations or Workflows are not stable: "f-db" (in-review).` |
| Rule 8 (Dependency Closure) | `Blocked: Dependency Closure. "wf-checkout" depends on workflow(s) not linked to journey "j-ordering": "wf-auth". Link them first, or retry with link_dependent: true.` |
| Dependency cycle | `Blocked: depends_on edge wf-a -> wf-b would create a dependency cycle.` |
| open_next: not shipped | `Blocked: only shipped Foundations/Workflows (stable or unstable) can open next. "wf-checkout" is currently "in-progress".` |
| open_next: already open | `Blocked: "wf-checkout" already has a next.mdx evolution in state "in-progress". Ship or discard_next before opening another.` |
| ship: next not in-review | `Blocked: ship is only allowed from next in-review. "wf-checkout" next is currently "in-progress".` |
| discard_next: nothing to discard | `Blocked: node "wf-checkout" has no next.mdx to discard.` |
| deprecate while evolving | `Blocked: cannot deprecate "wf-checkout" while next.mdx exists. Call discard_next first, or ship the evolution.` |
| Rule 3 (Completion) | `Blocked: Completion Check. 3 unchecked checkbox(es) remain in wf-checkout/current.mdx. All [ ] items must be [x] before moving to "in-review".` |
| Rule 4 (Ghost Bug) | `Blocked: Ghost Bug. "bug-race" has no affects edge. Link it to a Workflow or Foundation before moving it to "triaged".` |
| Stability flip | (informational) `stability_recomputed: [{ "id": "wf-checkout", "state": "unstable" }]` in tool response |
| No edge to remove | `Blocked: no edge exists between "wf-tips" and "f-db".` |

## Appendix B — Reference lifecycle walkthrough

```
create_node(j-ordering, Journey)            → j-ordering: draft (computed)
create_node(f-db, Foundation)               → f-db: draft
create_node(wf-checkout, Workflow)          → wf-checkout: draft
update_node_status(wf-checkout, ready)      → Blocked: Ghost Workflow (no Journey link)
link_nodes(wf-checkout, j-ordering, belongs_to)
link_nodes(wf-checkout, f-db, depends_on)
update_node_status(wf-checkout, ready)      → ok
update_node_status(wf-checkout, in-progress)→ ok; j-ordering → incubation
… agent implements, checks off Atomic Ops in current.mdx …
update_node_status(wf-checkout, in-review)  → ok (all [x])
update_node_status(wf-checkout, ship)       → Blocked: Infrastructure First (f-db is in-review)
… f-db: draft → ready → in-progress → in-review → ship → stable …
update_node_status(wf-checkout, ship)       → ok; wf-checkout: stable; j-ordering → stable
create_node(bug-race, Bug)                  → bug-race: open
update_node_status(bug-race, triaged)       → Blocked: Ghost Bug (no affects edge)
link_nodes(bug-race, wf-checkout, affects)  → wf-checkout: unstable (stability recomputed)
update_node_status(bug-race, triaged)       → ok; j-ordering unchanged (still stable)
… fix bug, check off Fix Checklist …
update_node_status(bug-race, resolved)      → ok; wf-checkout: stable

… months later, checkout gains split-payment support (same id, no new node) …
open_next(wf-checkout)                       → wf-checkout: still stable (current.mdx untouched); next.mdx created in draft
update_node_status(wf-checkout, ready)       → applies to next slot: next.mdx → ready (next inherited belongs_to/depends_on)
update_node_status(wf-checkout, in-progress) → next.mdx → in-progress; j-ordering → evolving (S>0 shipped, P>0 next building)
… agent implements, checks off Atomic Ops in next.mdx …
update_node_status(wf-checkout, in-review)   → ok (all [x] in next.mdx)
update_node_status(wf-checkout, ship)        → ok; next promoted over current.mdx (same id "wf-checkout"); next.mdx deleted;
                                                 wf-checkout: stable (or unstable if bug-race were still open); j-ordering → stable
```
