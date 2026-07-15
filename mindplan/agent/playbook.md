# MindPlan Agent Playbook

**Always apply.** For any software work in this repository, follow MindPlan. Orient on the graph before coding. Mutate graph state only through the **MindPlan MCP server**. Treat every `Blocked: <reason>` as a hard failure — read it, fix the plan, then retry. Do not retry blindly.

Normative reference: `SPEC.md` (in the mindplan-mcp package or repo). Entity scaffolding (create/link nodes, Journey-first): `mindplan/agent/skills/define-entities/SKILL.md`.

## Authority model

| Layer | Location | Who writes |
|-------|----------|------------|
| **Node record** | `mindplan/<type>s/<id>/context.mdx` frontmatter | You edit **title**, **description**; server owns **state**, **updated_at**, **shipped_at**, **belongs_to**, **depends_on**, **affects**, **supersedes** via MCP |
| **Territory body** | `context.mdx` body | You edit PRD, checklists, attachment references |
| **Attachments** | `mindplan/<type>s/<id>/attachments/` | Normal file tools |

**Never edit** server-owned frontmatter fields (`state`, `updated_at`, `shipped_at`, edge arrays) by hand.

## Taxonomy (quick map)

| Type | Purpose | States |
|------|---------|--------|
| **Journey** | Macro user capability; permanent container | Computed only: `draft`, `incubation`, `stable`, `evolving` |
| **Foundation** | Pure infrastructure (DB, auth, APIs) | `draft` → `ready` → `in-progress` → `in-review` → `ship` → `stable`/`unstable` |
| **Workflow** | Business logic / feature | Same build pipeline as Foundation |
| **Bug** | Defect on a Workflow or Foundation | `open` → `triaged` → `fixing` → `in-review` → `resolved` \| `wontfix` |

**IDs:** `^[a-z0-9][a-z0-9-_]*$`. Prefer prefixes: `j-`, `f-`, `wf-`, `bug-`.

**Edges:** `belongs_to` (Workflow → Journey), `depends_on` (Workflow/Foundation → Foundation or Workflow → Workflow), `affects` (Bug → Workflow/Foundation), `supersedes` (via `create_node_version` only).

## Request routing

Every request starts the same way:

```
find_related_nodes({ query: "<user ask>" })
```

Use the returned `focus` and 1-hop `nodes`/`edges`. Call `get_node_context` on the focus before executing. Use `get_mindplan_graph` only for greenfield / empty graphs or rare full audits — not on every turn. When the user asks to “show the map”, for a PR architecture diagram, or for a Mermaid/DOT visualization, call `export_mindplan_view` (optionally with `focus`) — do not dump `get_mindplan_graph` JSON as a diagram.

Then classify:

| If the user wants… | Do this |
|--------------------|---------|
| New Journey, Foundation, Workflow, or Bug | Follow `mindplan/agent/skills/define-entities/` (Journey must exist before any Workflow; refuse Workflow creation when no matching Journey is in the graph) |
| Implement or advance an existing Foundation/Workflow | **Build pipeline loop** below |
| Report or fix a defect | **Bug lifecycle loop** below |
| Breaking change to a **shipped** Foundation/Workflow | `get_blast_radius` → `create_node_version` → treat the new draft successor as build-pipeline work |

Do not invent tickets outside MindPlan. Do not start substantial implementation until the owning node is `in-progress` (or Bug is `fixing`).

## Validate after every plan change

After **each** MindPlan mutation — `create_node`, `create_node_version`, `link_nodes`, `unlink_nodes`, `update_node_status` — **and** after any material territory edit that changes checklist gates or intent, **validate before continuing**:

1. Re-read the changed focus with `find_related_nodes` (or `get_node_context`). For multi-node restructuring, call `get_mindplan_graph` once and confirm the full picture.
2. Confirm the mutation stuck: expected `id`s, `state`s, and edges (`belongs_to` / `depends_on` / `affects` / `supersedes`) match what you intended.
3. If the response is `Blocked: …` or the graph does not match intent, **stop** — fix the plan, then mutate again. Do not proceed to implementation or the next mutation on a known-bad graph.
4. **Confirm the visualization** — the server refreshes `mindplan/map.md` automatically after every successful mutation. Confirm that file updated. Call `export_mindplan_view` when you need a focused or DOT projection, or when syncing a secondary copy (e.g. README-embedded diagram).

Compiler success on write is necessary but not sufficient — always re-read **and** confirm `mindplan/map.md` reflects the change.

## Build pipeline loop (Foundation / Workflow)

```
draft → ready → in-progress → in-review → ship → stable/unstable
```

1. **Orient** — `find_related_nodes` to resolve the owning node and links, then `get_node_context` for the focus. Read PRD, Acceptance Criteria, and Atomic Ops.
2. **Pre-flight (leave `draft`)** — Workflows need at least one `belongs_to` and at least one `depends_on` before `ready`/`in-progress`. Foundations may optionally `depends_on` other Foundations. Use `link_nodes` (or the define-entities skill if nodes/links are missing).
3. **Commit to work** — `update_node_status` → `ready`, then `in-progress` **before** substantial implementation. Do not code under `draft`/`ready` as if the work were underway.
4. **Execute** — Implement in application code. Keep territory in sync: as each Atomic Op is done, edit the `context.mdx` **body** only (`- [ ]` → `- [x]`). Never check a box without doing the work.
5. **Review gate** — When all Atomic Ops are `[x]`, `update_node_status` → `in-review`. Unchecked boxes → `Blocked: Completion Check`.
6. **Ship** — From `in-review`, `update_node_status` → `ship`. Server sets `shipped_at` and computes `stable` or `unstable`.
   - **Infrastructure First:** a Workflow cannot ship until every direct `depends_on` Foundation and Workflow is `stable`. Ship Foundations (and prerequisite Workflows) first.
   - Never set Journey, `stable`, or `unstable` manually — they are computed.

Retreat when needed: `in-progress` ↔ `ready`, `in-review` → `in-progress`. Production nodes only move to `deprecated` (or are superseded via versioning).

## Bug lifecycle loop

```
open → triaged → fixing → in-review → resolved
         ↘ wontfix (from open)
```

1. If the Bug does not exist yet, create it via define-entities (starts `open`).
2. `link_nodes` with `affects` → target Workflow or Foundation **before** leaving `open`. Open Bugs flip the target to `unstable` after it has shipped.
3. `update_node_status` → `triaged` → `fixing`.
4. Fix in application code; check off Fix Checklist items in the Bug `context.mdx` body.
5. `in-review` only when the checklist is complete; then `resolved` (or `wontfix` from `open` when closing without a fix).
6. Resolving the last open Bug affecting a shipped node restores `stable`.

Bugs do not change Journey states.

## Versioning shipped work

Do **not** reset a shipped Foundation/Workflow back to `draft`.

1. `get_blast_radius` on the live predecessor or its draft successor — note dependents and journeys at risk (successor seeds via `supersedes`).
2. `create_node_version` — new draft inherits outgoing edges; `supersedes` → predecessor; dependents keep the live predecessor until the successor ships (relink + deprecate happen together).
3. Run the **build pipeline loop** on the successor until `ship`. Predecessor stays live until then; it auto-deprecates when the successor ships.

## Territory rules during execution

- Atomic Ops in `context.mdx` are the definition of done. Recognized syntax: `- [ ]` / `- [x]` (also `*` / `+` list markers).
- Checkbox state on disk gates `in-review`, `ship`, and Bug `in-review`/`resolved`.
- Enrich or replace scaffold checklist placeholders during `draft` / triage with real PR-sized work items.
- Attachments live under `attachments/`; reference them from the body with relative links.

## Compiler rules

| Rule | Gate | Fix |
|------|------|-----|
| **No Ghost Workflows** | `ready`/`in-progress` | At least one `belongs_to` + at least one `depends_on` via `link_nodes` |
| **No Ghost Bugs** | `triaged`/`fixing` | `link_nodes` with `affects` first |
| **Infrastructure First** | Workflow `ship` | Ship linked Foundations and dependent Workflows to `stable` first |
| **Completion Check** | `in-review`, `ship`, Bug `in-review`/`resolved` | Check off all `- [ ]` in `context.mdx` |
| **Computed Journeys** | manual Journey status | Never set — server computes from Workflows |
| **Computed Stability** | manual `stable`/`unstable` | Never set — use `ship` from `in-review`; Bugs drive `unstable` via `affects` |
| **Taxonomy** | illegal edge shape | Use correct edge type and node pairing |
| **Dependency Closure** | `belongs_to` Workflow → Journey | Link dependent Workflows to the same Journey first, or pass `link_dependent: true` |
| **Version Lineage** | `create_node_version` | Only `stable`/`unstable` nodes; no existing successor |

## MCP tools

| Tool | When to use |
|------|-------------|
| `find_related_nodes` | Orient — rank by query, return focus + 1-hop links (prefer over full graph) |
| `export_mindplan_view` | Human diagram — Mermaid/DOT on demand (full or focus); full Mermaid also auto-persists to `mindplan/map.md` after every mutation |
| `get_mindplan_graph` | Full graph dump — greenfield, multi-node plan validation, or rare full audits |
| `get_blast_radius` | Transitive dependents (seeds via `supersedes` for version successors) and journeys at risk |
| `get_node_context` | Read territory for the node you are executing |
| `create_node` | New Journey, Foundation, Workflow, or Bug (prefer define-entities skill) |
| `create_node_version` | New draft version of a shipped Workflow or Foundation |
| `link_nodes` | Add `belongs_to`, `depends_on`, or `affects`; optional `link_dependent: true` for Journey closure |
| `unlink_nodes` | Remove all edges between two nodes |
| `update_node_status` | Advance build pipeline, Bug lifecycle, or `ship` |

## Never do

- Start substantial coding without `find_related_nodes` (or an explicit `node_id`) and a clear owning node
- Mutate the plan and continue without validating (re-read focus / graph, confirm edges and states, and confirm `mindplan/map.md` refreshed)
- Implement under `draft`/`ready` instead of moving to `in-progress` (or Bug `fixing`) first
- Check off Atomic Ops without completing the work
- Create a Workflow when no matching Journey exists — refuse; ask the user to define the Journey first
- Hand-edit frontmatter `state`, `updated_at`, `shipped_at`, or edge arrays
- Set Journey, `stable`, or `unstable` states manually
- Move a Workflow past `ready` without both required links
- Move a Bug past `open` without an `affects` link
- Ship a Workflow while linked Foundations or prerequisite Workflows are not `stable`
- Transition to gated states with unchecked `- [ ]` items in `context.mdx`
- Reset a shipped node to `draft` — use `create_node_version` instead
