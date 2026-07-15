# MindPlan Agent Playbook

**Always apply.** For any software work in this repository, follow MindPlan. Orient on the graph before coding. Mutate graph state only through the **MindPlan MCP server**. Treat every `Blocked: <reason>` as a hard failure — read it, fix the plan, then retry. Do not retry blindly.

Normative reference: `SPEC.md` (in the mindplan-mcp package or repo). Entity scaffolding (create/link nodes, Journey-first): `mindplan/agent/skills/define-entities/SKILL.md`.

## Authority model

| Layer | Location | Who writes |
|-------|----------|------------|
| **Node record** | `mindplan/<type>s/<id>/context.mdx` frontmatter | Server owns **state**, **updated_at**, **shipped_at**, **belongs_to**, **depends_on**, **affects**, **supersedes** via MCP |
| **title / description** | `context.mdx` frontmatter scalars | Pre-ship Workflows: `patch_node_territory`; other types: `patch_node_territory` or file tools until `.cursorignore` blocks reads |
| **Territory body** | `context.mdx` body | `patch_node_territory` (preferred) or file tools on `context_path` from MCP |
| **Attachments** | `mindplan/<type>s/<id>/attachments/` | Normal file tools |

**Never edit** server-owned frontmatter fields (`state`, `updated_at`, `shipped_at`, edge arrays) by hand.

## Territory access (MCP-first)

When `.cursorignore` is installed (via `mindplan-mcp init`), agent file tools cannot read `mindplan/**/context.mdx` or `mindplan/map.md`. Use MCP for all territory reads and prefer MCP for territory writes.

- **Never** `Read` / `Grep` / `Glob` under `mindplan/journeys|foundations|workflows|bugs/` for orientation — use MCP read tools only
- **Never** trust `state`, edge arrays, or `shipped_at` except from MCP tool responses (`record` in `get_node_context` / `orient_for_work`)
- **Never** read `mindplan/map.md` as graph authority — call `export_mindplan_view` or re-call `find_related_nodes` after mutations
- **Never** use terminal commands (`cat`, `type`, `Get-Content`, etc.) to read ignored territory paths
- Territory edits: use `patch_node_territory` on the `node_id` returned by orientation; for body-only work until fully on MCP, edit only the body below frontmatter at `context_path` from `get_node_context`

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
orient_for_work({ query: "<user ask>" })
```

Or, when you already know the node:

```
find_related_nodes({ query: "<user ask>" })
```

Use the returned `focus` and 1-hop `nodes`/`edges`. Call `get_node_context` (or use `context` from `orient_for_work`) on the focus before executing. Before substantial implementation on a Foundation or Workflow, call `get_blast_radius` on that node (included in `orient_for_work` for Foundation/Workflow focus) to see transitive dependents and `journeys_at_risk`. Use `get_mindplan_graph` only for greenfield / empty graphs or rare full audits — not on every turn. When the user asks to “show the map”, for a PR architecture diagram, or for a Mermaid/DOT visualization, call `export_mindplan_view` (optionally with `focus`) — do not dump `get_mindplan_graph` JSON as a diagram.

Then classify:

| If the user wants… | Do this |
|--------------------|---------|
| New Journey, Foundation, Workflow, or Bug | Follow `mindplan/agent/skills/define-entities/` (Journey must exist before any Workflow; refuse Workflow creation when no matching Journey is in the graph) |
| Implement or advance an existing Foundation/Workflow | **Build pipeline loop** below |
| Report or fix a defect | **Bug lifecycle loop** below |
| Breaking change to a **shipped** Foundation/Workflow | `get_blast_radius` → `create_node_version` → treat the new draft successor as build-pipeline work |

Do not invent tickets outside MindPlan. Do not start substantial implementation until the owning node is `in-progress` (or Bug is `fixing`).

## Validate after every plan change

After **each** MindPlan mutation — `create_node`, `create_node_version`, `link_nodes`, `unlink_nodes`, `update_node_status`, `patch_node_territory` — **and** after any material territory edit that changes checklist gates or intent, **validate before continuing**:

1. Re-read the changed focus with `find_related_nodes` (or `get_node_context` / `orient_for_work`). For multi-node restructuring, call `get_mindplan_graph` once and confirm the full picture.
2. Confirm the mutation stuck: expected `id`s, `state`s, and edges (`belongs_to` / `depends_on` / `affects` / `supersedes`) match what you intended.
3. If the response is `Blocked: …` or the graph does not match intent, **stop** — fix the plan, then mutate again. Do not proceed to implementation or the next mutation on a known-bad graph.
4. **Confirm the visualization** — call `export_mindplan_view` or re-call `find_related_nodes` after graph mutations. Do not read `mindplan/map.md` as authority.

Compiler success on write is necessary but not sufficient — always re-read via MCP and confirm the graph matches intent.

## Build pipeline loop (Foundation / Workflow)

```
draft → ready → in-progress → in-review → ship → stable/unstable
```

1. **Orient** — `orient_for_work` or `find_related_nodes` to resolve the owning node and links, then `get_node_context` for the focus. Call `get_blast_radius` on the focus node before substantial implementation; note transitive dependents and `journeys_at_risk`. Read PRD, Acceptance Criteria, and Atomic Ops from `body`.
2. **Pre-flight (leave `draft`)** — Workflows need at least one `belongs_to` and at least one `depends_on` before `ready`/`in-progress`. Foundations may optionally `depends_on` other Foundations. Use `link_nodes` (or the define-entities skill if nodes/links are missing).
3. **Commit to work** — `update_node_status` → `ready`, then `in-progress` **before** substantial implementation. Do not code under `draft`/`ready` as if the work were underway.
4. **Execute** — Implement in application code. Keep territory in sync via `patch_node_territory`: toggle checkboxes (`toggle_checkboxes`), append `## Affected Files` (`append_affected_files`), update PRD (`body`). Never check a box without doing the work.
5. **Review gate** — When all Atomic Ops are `[x]`, `update_node_status` → `in-review`. Unchecked boxes → `Blocked: Completion Check`. Then **stop**. Do not immediately `ship`. Hand off for review by a human or a different agent (not the same session that implemented the work).
6. **Ship** — Only after that external review approves. The **reviewer** (human or another agent) calls `update_node_status` → `ship` from `in-review`. Server sets `shipped_at` and computes `stable` or `unstable`.
   - **External Review:** the implementing agent MUST NOT `ship` (or Bug `resolved`) their own work. Wait for a human or a different agent to review and perform the ship/resolve transition.
   - **Infrastructure First:** a Workflow cannot ship until every direct `depends_on` Foundation and Workflow is `stable`. Ship Foundations (and prerequisite Workflows) first.
   - Never set Journey, `stable`, or `unstable` manually — they are computed.

Retreat when needed: `in-progress` ↔ `ready`, `in-review` → `in-progress`. Production nodes only move to `deprecated` (or are superseded via versioning).

## Scope-change description updates

When implementation reveals different scope on a **pre-ship Workflow** (`draft`, `ready`, `in-progress`, `in-review`):

1. `patch_node_territory({ node_id, description: "…" })` — also update PRD `body` when intent changes materially
2. Re-call `find_related_nodes` to validate
3. If scope changes materially during `in-review`, retreat to `in-progress` before large checklist/PRD rewrites — description alone does not satisfy Completion Check

**Never** change `description` or `title` on a shipped Workflow (`stable`/`unstable`/`deprecated`) — use `create_node_version` for live scope changes.

## Bug lifecycle loop

```
open → triaged → fixing → in-review → resolved
         ↘ wontfix (from open)
```

1. If the Bug does not exist yet, create it via define-entities (starts `open`).
2. `link_nodes` with `affects` → target Workflow or Foundation **before** leaving `open`. Open Bugs flip the target to `unstable` after it has shipped.
3. `update_node_status` → `triaged` → `fixing`.
4. Fix in application code; check off Fix Checklist items via `patch_node_territory` (`toggle_checkboxes`).
5. `in-review` only when the checklist is complete; then **stop** and hand off for external review (same rule as Foundations/Workflows).
6. After review approval, the **reviewer** transitions to `resolved` (or `wontfix` from `open` when closing without a fix). The implementing agent MUST NOT resolve their own Bug fix.
7. Resolving the last open Bug affecting a shipped node restores `stable`.

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
- Workflow `## Affected Files` lists project paths touched during implementation; query with `get_workflow_files`, append with `patch_node_territory`.

## Compiler rules

| Rule | Gate | Fix |
|------|------|-----|
| **No Ghost Workflows** | `ready`/`in-progress` | At least one `belongs_to` + at least one `depends_on` via `link_nodes` |
| **No Ghost Bugs** | `triaged`/`fixing` | `link_nodes` with `affects` first |
| **Infrastructure First** | Workflow `ship` | Ship linked Foundations and dependent Workflows to `stable` first |
| **External Review** | Workflow/Foundation `ship`, Bug `resolved` | Implementing agent parks at `in-review`; a human or different agent reviews then ships/resolves (playbook; not a server gate) |
| **Completion Check** | `in-review`, `ship`, Bug `in-review`/`resolved` | Check off all `- [ ]` in `context.mdx` |
| **Computed Journeys** | manual Journey status | Never set — server computes from Workflows |
| **Computed Stability** | manual `stable`/`unstable` | Never set — use `ship` from `in-review`; Bugs drive `unstable` via `affects` |
| **Taxonomy** | illegal edge shape | Use correct edge type and node pairing |
| **Dependency Closure** | `belongs_to` Workflow → Journey | Link dependent Workflows to the same Journey first, or pass `link_dependent: true` |
| **Version Lineage** | `create_node_version` | Only `stable`/`unstable` nodes; no existing successor |
| **Shipped scope freeze** | `patch_node_territory` title/description on shipped Workflow | Use `create_node_version` instead |

## MCP tools

| Tool | When to use |
|------|-------------|
| `orient_for_work` | **Start here** — query + focus neighborhood + context + blast radius (Foundation/Workflow) |
| `find_related_nodes` | Orient — rank by query, return focus + 1-hop links (prefer over full graph) |
| `export_mindplan_view` | Human diagram — Mermaid/DOT on demand (full or focus); do not read `mindplan/map.md` as authority |
| `get_mindplan_graph` | Full graph dump — greenfield, multi-node plan validation, or rare full audits |
| `get_blast_radius` | Before substantial implementation — transitive dependents (seeds via `supersedes` for version successors) and journeys at risk |
| `get_node_context` | Read territory — prefer `record` + `body`; `raw_context` is deprecated |
| `get_workflow_files` | List project files recorded in a Workflow's `## Affected Files` section |
| `patch_node_territory` | Territory body edits, checkboxes, affected files, pre-ship Workflow title/description |
| `create_node` | New Journey, Foundation, Workflow, or Bug (prefer define-entities skill) |
| `create_node_version` | New draft version of a shipped Workflow or Foundation |
| `link_nodes` | Add `belongs_to`, `depends_on`, or `affects`; optional `link_dependent: true` for Journey closure |
| `unlink_nodes` | Remove all edges between two nodes |
| `update_node_status` | Advance build pipeline, Bug lifecycle, or `ship` |

## Never do

- Start substantial coding without `orient_for_work` / `find_related_nodes` (or an explicit `node_id`) and a clear owning node
- Start substantial implementation on a Foundation or Workflow without `get_blast_radius` on the owning node
- Read or grep `mindplan/**/context.mdx` or `mindplan/map.md` when `.cursorignore` is installed — use MCP read tools
- Use terminal commands to bypass `.cursorignore` on territory paths
- Mutate the plan and continue without validating (re-read focus / graph via MCP after mutations)
- Implement under `draft`/`ready` instead of moving to `in-progress` (or Bug `fixing`) first
- Check off Atomic Ops without completing the work
- Create a Workflow when no matching Journey exists — refuse; ask the user to define the Journey first
- Hand-edit frontmatter `state`, `updated_at`, `shipped_at`, or edge arrays
- Change shipped Workflow `title` or `description` — use `create_node_version`
- Set Journey, `stable`, or `unstable` states manually
- Move a Workflow past `ready` without both required links
- Move a Bug past `open` without an `affects` link
- Ship a Workflow while linked Foundations or prerequisite Workflows are not `stable`
- `ship` a Foundation/Workflow (or `resolved` a Bug) that this same agent session implemented — leave `in-review` for a human or another agent
- Transition to gated states with unchecked `- [ ]` items in `context.mdx`
- Reset a shipped node to `draft` — use `create_node_version` instead
