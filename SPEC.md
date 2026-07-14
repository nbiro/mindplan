# MindPlan Framework Specification

**Version:** 1.1.0
**Status:** Stable
**Reference implementation:** repository root (TypeScript MCP server, stdio transport)

The key words MUST, MUST NOT, SHALL, SHOULD, and MAY in this document are to be interpreted as described in RFC 2119.

---

## 0. Abstract

MindPlan is a strictly deterministic Software Development Life Cycle (SDLC) framework designed natively for autonomous AI agents and human engineering teams. It operates as a compiler-style state machine and a "GitOps for Issue Tracking" system: all planning state lives inside the repository, every state mutation is validated against architectural guardrails before it is persisted, and any violation is rejected with a machine-parsable error. The result is that software architecture and project requirements remain perfectly synchronized with the code they describe — there is no external tracker to drift from reality.

MindPlan is exposed to agents exclusively through a Model Context Protocol (MCP) server. The server is the single write path to MindPlan state. Direct file edits to the graph are out of contract (see §9.3). Consumer projects receive an operational agent playbook at `.cursor/rules/mindplan.mdc` (installed by `mindplan-mcp init` from `templates/mindplan-agent.mdc`).

---

## 1. Core Architecture: Map vs. Territory

MindPlan separates the macro-architectural state from micro-execution details to maintain a verifiable source of truth.

### 1.1 The Map — `mindplan.json`

A centralized Directed Acyclic Graph (DAG) stored in the planning directory at the project root. It tracks the identity, type, exact status, and dependency edges of every architectural node. The Map answers: *what exists, what state is it in, and what does it depend on?*

The Map MUST be the only authority on node state and node relationships. Any tool, script, or UI that needs graph state MUST derive it from `mindplan.json`.

### 1.2 The Territory — entity folders

"Tickets-as-Code." Each node owns a folder containing a `context.mdx` file and an `attachments/` directory. The `context.mdx` contains the Product Requirements Document (PRD), Acceptance Criteria, and the Atomic Operations (execution checklists) required to complete the node. The Territory answers: *what exactly must be done, and how do we know it is done?*

Context files are MDX: standard Markdown plus optional JSX components (§6.4). Markdown remains the load-bearing syntax — every compiler rule operates on Markdown constructs only, and a context file containing no JSX at all is fully compliant.

The Territory MUST live in the repository alongside the source code and MUST be versioned with it. A commit therefore captures code, architecture, and requirements in one atomic snapshot.

### 1.3 Directory layout

All MindPlan state lives under a `mindplan/` directory at the project root. This directory is versioned with the repository and MUST be committed.

```
<project-root>/
└── mindplan/
    ├── mindplan.json                  # The Map
    ├── components/                    # Project-specific MDX components (§6.4) — opaque to the compiler
    ├── journeys/
    │   └── <node-id>/
    │       ├── context.mdx            # The Territory for this node
    │       └── attachments/           # Binary/reference assets (images, PDFs, diagrams)
    ├── foundations/
    │   └── <node-id>/
    │       ├── context.mdx
    │       └── attachments/
    ├── workflows/
    │   └── <node-id>/
    │       ├── context.mdx
    │       └── attachments/
    └── bugs/
        └── <node-id>/
            ├── context.mdx
            └── attachments/
```

Rules:

- The planning root is `<MINDPLAN_ROOT>/mindplan`, where `MINDPLAN_ROOT` is an environment variable resolving to the target project root. If unset, the server's working directory is used.
- Each entity folder name MUST equal the node `id`.
- The subdirectory per type is fixed: `journeys/`, `foundations/`, `workflows/`, `bugs/`.
- `attachments/` MAY contain arbitrary files. Attachments SHOULD be referenced from `context.mdx` with relative links (e.g. `![flow](attachments/flow.png)`).
- `components/` MAY contain project-specific MDX components (§6.4.3). It is created by the server but never read by it.
- The server MUST create missing directories on demand; a fresh project requires no manual scaffolding.

---

## 2. Entity Taxonomy

The framework separates **build taxonomy** (Journey, Foundation, Workflow) from a **defect layer** (Bug) to eliminate scope creep and prevent spaghetti dependencies.

| Entity | Definition | Routing rules |
|---|---|---|
| **Journey** | A macro-level business capability or continuous user experience (e.g. "Table Ordering", "Agency Site Generator"). | Permanent container. MUST NOT execute code directly. MUST NOT have outgoing edges. State is computed, never set manually (§4). |
| **Foundation** | Pure infrastructure and plumbing (e.g. database schemas, API integrations, auth). | Has zero direct business value; exists solely to be consumed by Workflows. MUST be shipped (`stable`) before dependent Workflows can ship. MAY depend on other Foundations (layered infrastructure). |
| **Workflow** | Self-contained business logic or an end-user feature (e.g. "Compile HTML", "Process Payment"). | MUST belong to one or more Journeys via `belongs_to` (multiple edges allowed). MUST depend on at least one Foundation via `depends_on`. Contains the actual execution work. **Agents MUST define the Journey before creating a Workflow** — if the user requests a Workflow that cannot be mapped to an existing Journey, the agent MUST refuse and ask the user to define the Journey first. |
| **Bug** | A defect afflicting one or more Foundations or Workflows. | MUST link to targets via `affects` (Bug → Workflow|Foundation). Dedicated defect lifecycle (§3.2). Does not affect Journey computation. |

### 2.1 Node identifiers

Node ids MUST match the pattern `^[a-z0-9][a-z0-9-_]*$` (lowercase slug style). Ids are globally unique across all types. Recommended convention: prefix by type (`j-`, `f-`, `wf-`, `bug-`), e.g. `j-ordering`, `f-db-core`, `wf-checkout-split`, `bug-race`.

### 2.2 Edge taxonomy

Exactly three edge types exist. An edge is a directed triple `(source, target, type)`.

| Edge type | Legal shape | Meaning |
|---|---|---|
| `belongs_to` | Workflow → Journey | Membership. A Workflow MAY have multiple `belongs_to` edges to different Journeys when the feature spans macro capabilities. |
| `depends_on` | Workflow → Foundation, Foundation → Foundation | Consumption. The source cannot ship without the target's infrastructure. |
| `affects` | Bug → Workflow, Bug → Foundation | Affliction. The Bug impairs the target; open Bugs drive `unstable` production posture (§3.5). |

All other shapes MUST be rejected, specifically including:

- Journey → anything (Journeys are containers; they have no outgoing edges)
- `depends_on` targeting a Journey or a Workflow
- `belongs_to` from a Foundation, Journey, or Bug
- `affects` from anything other than a Bug, or targeting a Journey
- `depends_on` from a Bug or Journey
- self-links (`source == target`)
- duplicate edges (same source, target, and type)

The graph MUST remain acyclic. (Workflow→Foundation and Foundation→Foundation edges cannot form cycles with `belongs_to` edges; implementations SHOULD additionally reject Foundation→Foundation cycles at link time.)

---

## 3. State Machines

### 3.1 Build pipeline (Foundation / Workflow)

Foundations and Workflows move through a manual build pipeline, then enter production via `ship`:

| # | State | Meaning |
|---|---|---|
| 1 | `draft` | Ideation; scope written in `context.mdx` |
| 2 | `ready` | Pre-flight passed (Workflow: at least one Journey + Foundation linked) |
| 3 | `in-progress` | Active execution; Atomic Ops checked off |
| 4 | `in-review` | Frozen pending PR approval or CI gate |
| 5 | `deprecated` | Retired (from `stable`/`unstable` only) |

**Ship transition:** `update_node_status(..., "ship")` from `in-review` sets `shipped_at` and computes `stable` or `unstable` (§3.5). There is no manual `active` state.

| From \ To | draft | ready | in-progress | in-review | ship | deprecated |
|---|---|---|---|---|---|---|
| **draft** | — | ✔ | ✘ | ✘ | ✘ | ✘ |
| **ready** | ✔ | — | ✔ | ✘ | ✘ | ✘ |
| **in-progress** | ✘ | ✔ | — | ✔ | ✘ | ✘ |
| **in-review** | ✘ | ✘ | ✔ | — | ✔ | ✘ |
| **stable/unstable** | ✘ | ✘ | ✘ | ✘ | ✘ | ✔ |
| **deprecated** | ✘ | ✘ | ✘ | ✘ | ✘ | — |

### 3.2 Bug lifecycle (dedicated)

| State | Meaning |
|---|---|
| `open` | Reported; repro in `context.mdx` |
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

An Atomic Operation is a PR-sized unit of work expressed as a Markdown task-list item in `context.mdx`:

```markdown
- [ ] Implement POST /orders endpoint
- [x] Write migration for orders table
```

Recognized syntax: a list item beginning with `-`, `*`, or `+`, followed by `[ ]` (open) or `[x]` (complete). Checkbox state is parsed from `context.mdx` at validation time — the file on disk is the source of truth for completion, not the graph.

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

---

## 4. Computed Journey States

Journeys are continuous and never technically "finished." Their states MUST NOT be set manually; the server derives them from the states of the Workflows linked to the Journey via `belongs_to`, and recomputes them after **every** mutation that can affect the result (status updates, linking, and unlinking).

For a given Journey, let:

- `S` = count of member Workflows with `shipped_at` set (state `stable` or `unstable`)
- `P` = count of member Workflows without `shipped_at` in `in-progress` or `in-review`

| State | Condition | Reading |
|---|---|---|
| `evolving` | `S > 0` and `P > 0` | Live and actively being expanded. |
| `stable` | `S > 0` and `P = 0` | Live and untouched. |
| `incubation` | `S = 0` and `P > 0` | The V1 build phase. |
| `draft` | `S = 0` and `P = 0` | Resting state. |

Notes:

- **Bugs do not affect Journey states.** A Workflow flipping `stable` → `unstable` does not change its Journey.
- `in-review` counts toward `P`.
- Workflows in `draft`, `ready`, or `deprecated` contribute to neither count.
- Any attempt to set a Journey's state through the status-update tool MUST be rejected.
- When a recomputation changes a Journey's state, the server MUST persist the new state to the Map and synchronize the Journey's `context.mdx` frontmatter, and SHOULD report the change in the tool response (`journeys_recomputed`).

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

A Workflow MUST NOT `ship` (transition from `in-review` to production) unless **every** Foundation reachable via its direct `depends_on` edges is in state `stable`. The rejection message MUST enumerate each non-stable Foundation with its current state.

Rationale: concrete must be poured before the roof is built. A feature cannot go live on infrastructure that is not stable in production.

### 5.4 Rule 3 — The Completion Check

A Workflow MUST NOT transition to `in-review` or `ship` while its `context.mdx` contains one or more unchecked Atomic Operations (`[ ]`). A Bug MUST NOT transition to `in-review` or `resolved` while unchecked items remain. The rejection message MUST include the count of open checkboxes.

Rationale: review is a gate on *finished* work. The checklist in the Territory is the definition of done.

### 5.5 Rule 4 — No Ghost Bugs

A Bug MUST NOT transition to `triaged` or `fixing` unless it has at least one `affects` edge to a Workflow or Foundation at validation time.

### 5.6 Rule 5 — Computed Journeys

Manual status mutation of a Journey MUST be rejected (§4). This is a compiler rule, not a convention.

### 5.7 Rule 6 — Computed Stability

Manual mutation of a Foundation or Workflow to `stable` or `unstable` MUST be rejected. Production posture is computed per §3.5 after `ship` and whenever open Bugs change.

### 5.8 Rule 7 — Taxonomy enforcement at link time

Edge creation MUST validate:

- both node ids exist in the Map,
- the edge shape is legal per §2.2,
- the edge is not a self-link and not a duplicate.

### 5.9 Enforcement ordering

For a status mutation the compiler MUST evaluate, in order:

1. node exists → 2. node is not a Journey → 3. target state is valid → 4. transition is legal per §3 → 5. Rules 1–4 (type-specific) → **write** → 6. recompute stability (§3.5) → 7. recompute Journey states (§4) → 8. synchronize frontmatter.

For `link_nodes` / `unlink_nodes` involving `affects`: validate §5.8, write edge, recompute stability for affected targets, recompute Journeys if applicable, mirror frontmatter.

---

## 6. Territory File Format

### 6.1 `context.mdx` structure

Every entity's `context.mdx` MUST begin with YAML frontmatter followed by an MDX body (Markdown plus optional JSX per §6.4):

```mdx
---
id: wf-checkout-split
type: Workflow
title: "Split & pay checkout"
state: in-progress
created_at: 2026-07-14T06:00:00.000Z
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
| `id` | string | server, at creation | Immutable. MUST equal folder name and Map entry. |
| `type` | `Journey \| Foundation \| Workflow \| Bug` | server, at creation | Immutable. |
| `title` | string (JSON-quoted) | server, at creation | Human-readable. |
| `state` | string | **server only** | Mirror of the Map; re-synced on every accepted transition, stability recomputation, and Journey recomputation. Humans/agents MUST NOT edit it by hand. |
| `created_at` | ISO-8601 | server, at creation | Immutable. |
| `severity` | `low \| medium \| high \| critical` | optional | Bug nodes only; informational in v1. |

The body is free-form and owned by humans and agents: PRD, acceptance criteria, execution logic, and the checklist all live here and are edited directly in the IDE. Only the frontmatter `state:` field is server-owned.

Frontmatter delimiters (`---`) MUST appear before any JSX. MDX comments use `{/* ... */}` syntax; HTML comments (`<!-- -->`) are not valid MDX and MUST NOT be used in the body.

### 6.2 State mirroring

After any accepted mutation, the server MUST rewrite the `state:` line inside the frontmatter block of each affected node's `context.mdx` (the transitioned node plus every Journey whose computed state changed). If the file is missing or has no frontmatter, mirroring is skipped silently — the Map remains authoritative.

### 6.3 Scaffolding templates

`create_node` MUST scaffold the entity folder with a type-appropriate `context.mdx` and an empty `attachments/` directory (with `.gitkeep` so the folder is versionable):

- **Journey** — Overview section, Linked Workflows note, Attachments note. No checklist (Journeys have no completion gate).
- **Foundation** — Infrastructure Spec section, Checklist (3 default Atomic Ops), Attachments note.
- **Workflow** — Execution Logic section, Checklist (3 default Atomic Ops), Attachments note.
- **Bug** — Summary, Repro Steps, Expected/Actual, Fix Checklist (3 default Atomic Ops), Attachments note. Created in state `open` (§3.4).

Default checklist items are placeholders; teams SHOULD replace them with real Atomic Ops during `draft` or triage.

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
| `<DependsOn>` | `id: string` (Foundation id) | Inline reference to a Foundation dependency; viewers link to that node. Informational — edges in the Map are the authority. |
| `<BelongsTo>` | `id: string` (Journey id) | Inline reference to a parent Journey. Informational — `belongs_to` edges in the Map are the authority (multiple allowed). |
| `<Affects>` | `id: string` (Workflow or Foundation id) | Inline reference to an afflicted node. Informational — `affects` edges in the Map are the authority. |
| `<ReproSteps>` | children | Marks repro steps for viewers. |
| `<Severity>` | `level: low \| medium \| high \| critical` | Renders bug severity. |
| `<ExpectedActual>` | `expected`, `actual` strings | Expected vs actual behaviour. |

Future spec versions MAY extend this set; they MUST NOT change the semantics of existing names.

#### 6.4.3 Project components

- Live in `mindplan/components/` at the planning root (any file layout inside is the project's business; `.tsx`/`.jsx` recommended).
- MAY be referenced from any `context.mdx` in that project.
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

## 7. The Map File Format

### 7.1 Schema

```jsonc
{
  "version": 1,
  "nodes": [
    {
      "id": "wf-checkout-split",
      "type": "Workflow",                       // "Journey" | "Foundation" | "Workflow" | "Bug"
      "title": "Split & pay checkout",
      "description": "Diner splits and pays the bill",
      "state": "in-progress",                    // build pipeline, computed production, or Bug lifecycle
      "shipped_at": "2026-07-14T10:00:00.000Z",  // optional; set on ship (Foundation/Workflow)
      "severity": "high",                        // optional; Bug nodes only
      "created_at": "2026-07-14T06:00:00.000Z",  // ISO-8601, immutable
      "updated_at": "2026-07-14T09:12:33.101Z"   // ISO-8601, touched on every accepted mutation
    }
  ],
  "edges": [
    { "source": "wf-checkout-split", "target": "j-ordering", "type": "belongs_to" },
    { "source": "wf-checkout-split", "target": "f-db-core", "type": "depends_on" },
    { "source": "bug-race", "target": "wf-checkout-split", "type": "affects" }
  ]
}
```

### 7.2 Invariants

- `version` identifies the schema generation (currently `1`).
- Node `id` values are unique. Every edge endpoint MUST reference an existing node.
- `state` for Journeys is always one of the computed states (§4); for Foundations/Workflows one of the build pipeline states or computed `stable`/`unstable`; for Bugs one of the Bug lifecycle states (§3.2).
- `shipped_at` is set only by the `ship` transition; when present, `state` MUST be `stable` or `unstable` unless the node is `deprecated`.
- The file is written atomically per mutation, pretty-printed (2-space indent), with a trailing newline. A missing file reads as the empty graph `{ version: 1, nodes: [], edges: [] }`.

---

## 8. MCP Tool Contract

The server exposes exactly six tools over stdio. All inputs are validated with zod; all failures follow the §5.1 error contract. Responses are JSON text payloads.

### 8.1 Read tools

#### `get_mindplan_graph`

- **Input:** none.
- **Output:** the full parsed `mindplan.json` (§7.1).
- **Errors:** none beyond I/O failures.

#### `get_node_context`

- **Input:** `node_id` (slug).
- **Output:**

```jsonc
{
  "folder": "mindplan/workflows/wf-checkout-split",
  "context_path": "mindplan/workflows/wf-checkout-split/context.mdx",
  "attachments_path": "mindplan/workflows/wf-checkout-split/attachments",
  "attachments": ["checkout-wireframe.png"],   // filenames, sorted, .gitkeep excluded
  "context": "---\nid: wf-checkout-split\n..." // raw context.mdx content
}
```

- **Errors:** unknown `node_id`; missing `context.mdx`.

### 8.2 Mutation tools

#### `create_node`

- **Input:** `id` (slug), `type` (`Journey|Foundation|Workflow|Bug`), `title` (non-empty), `description`.
- **Effect:** appends the node to the Map with initial state (`draft` for build entities, `open` for Bugs), scaffolds the entity folder (§6.3), persists.
- **Output:** `{ created: <node>, folder, context, attachments }` (project-relative paths).
- **Errors:** duplicate `id`.

#### `link_nodes`

- **Input:** `source_id`, `target_id`, `edge_type` (`depends_on|belongs_to|affects`).
- **Effect:** validates §5.8, appends the edge, recomputes stability (§3.5) and Journey states (§4), persists, mirrors frontmatter.
- **Output:** `{ linked: {source, target, type}, journeys_recomputed: [...], stability_recomputed: [{id, state}] }`.
- **Errors:** unknown ids; illegal shape; self-link; duplicate edge.

#### `unlink_nodes`

- **Input:** `source_id`, `target_id`.
- **Effect:** removes **all** edges between the pair (any type), recomputes stability and Journey states, persists, mirrors frontmatter.
- **Output:** `{ removed: <count>, journeys_recomputed: [...], stability_recomputed: [...] }`.
- **Errors:** unknown ids; no edge exists between the pair.
- **Note:** unlinking does not retroactively demote a Workflow already past a gate; guardrails are evaluated at transition time only (§9.2).

#### `update_node_status`

- **Input:** `node_id`, `new_status` (string; build/Bug state name, or `ship` for Foundation/Workflow production entry).
- **Effect:** runs the full §5.9 pipeline. On success: writes the new state (and `shipped_at` on `ship`), touches `updated_at`, recomputes stability and Journey states, persists, mirrors frontmatter for the node and every affected node.
- **Output:** `{ node_id, previous_state, new_state, journeys_recomputed: [...], stability_recomputed: [...] }`.
- **Errors:** unknown id; Journey target; invalid state name; illegal transition; Rule 1–4 violations; manual `stable`/`unstable` attempt.

### 8.3 Attachments

Attachments are managed through the ordinary file system (IDE, agent file tools, or scripts) — the MCP surface intentionally does not proxy binary uploads. `get_node_context` reports the attachment inventory so agents can discover and read files directly from `attachments_path`.

---

## 9. Operational Semantics

### 9.1 Determinism

Given identical `mindplan/` contents and an identical tool call, the server MUST produce an identical accept/reject decision and identical resulting state (timestamps excepted). There is no hidden state, no database, and no network dependency.

### 9.2 Validation-at-transition

Guardrails are evaluated at the moment of transition, against the graph and Territory as they exist on disk at that moment. MindPlan does not run continuous invariant enforcement; a graph made temporarily inconsistent by out-of-band edits is corrected the next time a gated transition is attempted.

### 9.3 Out-of-band edits

- `context.mdx` **body** edits (PRD, checklists) are a first-class part of the workflow — checking off Atomic Ops is done by editing the file.
- `context.mdx` **frontmatter `state:`** and `mindplan.json` are server-owned. Editing them by hand voids the framework's guarantees. If the Map and frontmatter disagree, the Map wins.

### 9.4 Concurrency

The reference implementation assumes a single writer (one MCP server instance per project). Deployments requiring concurrent writers MUST serialize mutations externally.

### 9.5 Deprecation and orphans

Transitioning a Workflow to `deprecated` SHOULD be followed by an orphan review: any Foundation whose only consumers are now deprecated is a candidate for deprecation itself. Implementations MAY automate this check; the reference implementation leaves it to the operator (the graph query is trivial via `get_mindplan_graph`).

---

## 10. External UI Synchronization (GitOps Integration)

MindPlan supports one-way mirroring into standard project-management platforms (Jira, Linear, GitHub Projects) so stakeholders retain their dashboards without reintroducing drift.

### 10.1 Principles

1. **Execution in Git.** Developers and agents work entirely within the IDE: states move via MCP tools, Atomic Ops are checked off in Markdown. The repository is the write side.
2. **Read-only UI mirror.** The external board is a projection. Humans MUST NOT move tickets there; any manual board change is overwritten by the next sync. This is what eliminates "Jira Drift" — there is nothing to drift *from*, because the board has no authority.

### 10.2 Sync pipeline

On every merge to the main branch (or on a schedule), a CI step runs a lightweight parser that:

1. reads `mindplan.json` for node states and edges;
2. reads each `context.mdx` frontmatter and checklist to compute completion percentages;
3. fires idempotent API payloads to the external tracker: create missing tickets (keyed by node `id`), move tickets to the column mapped from the node state, update checklist progress as a comment or custom field.

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

The sync parser is deliberately outside the MCP server (it is a CI concern, not an agent concern) and is **not included** in the reference implementation. The stable interfaces it consumes — §7 (Map schema) and §6.1 (frontmatter + checklist syntax) — are the compatibility contract for building one.

---

## 11. Compliance Checklist

An implementation is MindPlan-compliant if and only if:

- [ ] All state lives under `mindplan/` per §1.3; no external database.
- [ ] Build taxonomy + defect layer and all three edge types are enforced per §2.
- [ ] Build pipeline, Bug lifecycle, and computed `stable`/`unstable` are enforced per §3.
- [ ] Journey states are computed, never settable, per §4; Bugs do not affect Journeys.
- [ ] Rules 1–7 are enforced pre-write, fail-fast, per §5.
- [ ] Every rejection message starts with `Blocked: ` per §5.1.
- [ ] `context.mdx` frontmatter is server-mirrored per §6.
- [ ] The MDX component contract holds per §6.4: reserved names respected, project components opaque, no guardrail parses JSX.
- [ ] The Map schema and invariants hold per §7 (including `shipped_at`).
- [ ] The six-tool MCP surface matches §8 (names, inputs, outputs, errors).
- [ ] Mutations are deterministic and atomic per §9.

---

## Appendix A — Canonical error catalog

| Rule | Example message |
|---|---|
| Unknown node | `Blocked: node "wf-x" does not exist in mindplan.json.` |
| Duplicate node | `Blocked: node "wf-checkout" already exists.` |
| Illegal edge shape | `Blocked: belongs_to edges must go Workflow -> Journey. Got Foundation "f-db" -> Journey "j-ordering".` |
| Journey dependency | `Blocked: a Journey cannot depend on a Foundation. Journeys are permanent containers with no direct code execution.` |
| Duplicate edge | `Blocked: edge wf-checkout -depends_on-> f-db already exists.` |
| Manual Journey state | `Blocked: Journey states are computed automatically from their Workflows and cannot be set manually.` |
| Manual stability | `Blocked: stable/unstable are computed from open Bugs and cannot be set manually. Use ship from in-review.` |
| Invalid state name | `Blocked: "active" is not a valid state. Valid build states: draft -> ready -> in-progress -> in-review -> ship -> stable/unstable -> deprecated.` |
| Illegal transition | `Blocked: illegal transition "in-progress" -> "stable" for node "wf-tips". Allowed from "in-progress": in-review, ready.` |
| Rule 1 (Ghost Workflow) | `Blocked: Ghost Workflow. "wf-checkout" has no belongs_to edge to a Journey. Link it with link_nodes before moving it to "ready".` |
| Rule 2 (Infra First) | `Blocked: Infrastructure First. Workflow "wf-checkout" cannot ship while linked Foundations are not stable: "f-db" (in-review).` |
| Rule 3 (Completion) | `Blocked: Completion Check. 3 unchecked checkbox(es) remain in wf-checkout/context.mdx. All [ ] items must be [x] before moving to "in-review".` |
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
… agent implements, checks off Atomic Ops in context.mdx …
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
```
