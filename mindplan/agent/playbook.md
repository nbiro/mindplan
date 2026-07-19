# MindPlan Agent Playbook

**Always apply.** For any software work in this repository, follow MindPlan. Orient on the graph before coding. Mutate graph state only through the **MindPlan MCP server**. Treat every `Blocked: <reason>` as a hard failure — read it, fix the plan, then retry. Do not retry blindly.

Normative reference: `SPEC.md` (in the mindplan-mcp package or repo). Entity scaffolding (create/link nodes, Journey-first): `mindplan/agent/skills/define-entities/SKILL.md`.

## Authority model

| Layer | Location | Who writes |
|-------|----------|------------|
| **Node record** | `mindplan/<type>s/<id>/current.mdx` frontmatter | Server owns **state**, **updated_at**, **shipped_at**, **belongs_to**, **depends_on**, **affects** via MCP |
| **title / description** | `current.mdx` frontmatter scalars (or `next.mdx` while evolving) | Pre-ship Workflows: `patch_node_territory`; evolving shipped Foundations/Workflows: `patch_node_territory` (defaults to `next`); other types: `patch_node_territory` or file tools until `.cursorignore` blocks reads |
| **Territory body** | `current.mdx` body (or `next.mdx` while evolving) | `patch_node_territory` (preferred) or file tools on `current_path`/`next_path` from MCP (`context_path` is a deprecated alias for `current_path`) |
| **Attachments** | `mindplan/<type>s/<id>/attachments/` (`next-attachments/` while evolving) | Normal file tools |

A node's id is stable forever — Foundations and Workflows never get a new id to evolve; they open an optional `next.mdx` next to `current.mdx` instead.

**Never edit** server-owned frontmatter fields (`state`, `updated_at`, `shipped_at`, edge arrays) by hand.

## Territory access (MCP-first)

When `.cursorignore` is installed (via `mindplan-mcp init`), agent file tools cannot read `mindplan/**/current.mdx`, `mindplan/**/next.mdx`, or `mindplan/map.md`. Use MCP for all territory reads and prefer MCP for territory writes.

- **Never** `Read` / `Grep` / `Glob` under `mindplan/journeys|foundations|workflows|bugs/` for orientation — use MCP read tools only
- **Never** trust `state`, edge arrays, or `shipped_at` except from MCP tool responses (`record` in `get_node_context` / `orient_for_work`)
- **Never** read `mindplan/map.md` as graph authority — call `export_mindplan_view` or re-call `find_related_nodes` after mutations
- **Never** use terminal commands (`cat`, `type`, `Get-Content`, etc.) to read ignored territory paths
- Territory edits: use `patch_node_territory` on the `node_id` returned by orientation; for body-only work until fully on MCP, edit only the body below frontmatter at `current_path` (or `next_path` when a next slot is open) from `get_node_context`

## Taxonomy (quick map)

| Type | Purpose | States |
|------|---------|--------|
| **Journey** | Domain capability the architecture screams; permanent use-case container | Computed only: `draft`, `incubation`, `stable`, `evolving` |
| **Foundation** | Shared substrate (DB, auth, design system, adapters) — no standalone use case | `draft` → `ready` → `in-progress` → `in-review` → `ship` → `stable`/`unstable` |
| **Workflow** | Concrete use case / feature (may span Journeys; may depend on other Workflows) | Same build pipeline as Foundation |
| **Bug** | Defect on a Workflow or Foundation | `open` → `triaged` → `fixing` → `in-review` → `resolved` \| `wontfix` |

**IDs:** `^[a-z0-9][a-z0-9-_]*$`. Prefer prefixes: `j-`, `f-`, `wf-`, `bug-`. IDs never change — evolution happens in place via `next.mdx`, not by minting a new id.

**Edges:** `belongs_to` (Workflow → Journey), `depends_on` (Workflow/Foundation → Foundation or Workflow → Workflow), `affects` (Bug → Workflow/Foundation). No other edge types exist.

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
| Change to a **shipped** Foundation/Workflow | `get_blast_radius` → `open_next` → run the **build pipeline loop** against the `next.mdx` slot until `ship` promotes it over `current.mdx` (same id) |

Do not invent tickets outside MindPlan. Do not start substantial implementation until the owning node is `in-progress` (or Bug is `fixing`) — for shipped nodes, until the `next` slot is `in-progress`.

## Validate after every plan change

After **each** MindPlan mutation — `create_node`, `open_next`, `discard_next`, `link_nodes`, `unlink_nodes`, `update_node_status`, `patch_node_territory` — **and** after any material territory edit that changes checklist gates or intent, **validate before continuing**:

1. Re-read the changed focus with `find_related_nodes` (or `get_node_context` / `orient_for_work`). For multi-node restructuring, call `get_mindplan_graph` once and confirm the full picture.
2. Confirm the mutation stuck: expected `id`s, `state`s (including `next.state` when a next slot is open), and edges (`belongs_to` / `depends_on` / `affects`) match what you intended.
3. If the response is `Blocked: …` or the graph does not match intent, **stop** — fix the plan, then mutate again. Do not proceed to implementation or the next mutation on a known-bad graph.
4. **Confirm the visualization** — call `export_mindplan_view` or re-call `find_related_nodes` after graph mutations. Do not read `mindplan/map.md` as authority.

Compiler success on write is necessary but not sufficient — always re-read via MCP and confirm the graph matches intent.

## Build pipeline loop (Foundation / Workflow)

```
draft → ready → in-progress → in-review → ship → stable/unstable
```

For a shipped node evolving via `open_next`, this same pipeline runs against the `next.mdx` slot — `update_node_status` and `patch_node_territory` apply to `next` automatically while it exists (see Versioning shipped work below). The live node keeps serving under `current.mdx` for the whole loop; only `ship` promotes `next` over `current`.

1. **Orient** — `orient_for_work` or `find_related_nodes` to resolve the owning node and links, then `get_node_context` for the focus. Call `get_blast_radius` on the focus node before substantial implementation; note transitive dependents and `journeys_at_risk`. Read PRD, Acceptance Criteria, and Atomic Ops from `body` (or `next.body` when a next slot is open).
2. **Pre-flight (leave `draft`)** — Workflows need at least one `belongs_to` and at least one `depends_on` before `ready`/`in-progress`. Foundations may optionally `depends_on` other Foundations. Use `link_nodes` (or the define-entities skill if nodes/links are missing).
3. **Commit to work** — `update_node_status` → `ready`, then `in-progress` **before** substantial implementation. Do not code under `draft`/`ready` as if the work were underway.
4. **Execute** — Implement in the node's prescribed package (`src/workflows/<id>/` or `src/foundations/<id>/`). Keep territory in sync via `patch_node_territory`: toggle checkboxes (`toggle_checkboxes`), update PRD (`body`). Never check a box without doing the work. Query architecture with `get_node_implementation` plus the graph.
5. **Review gate** — When all Atomic Ops are `[x]`, `update_node_status` → `in-review`. Unchecked boxes → `Blocked: Completion Check`. Then **stop**. Do not immediately `ship`. Hand off for review by a human or a different agent (not the same session that implemented the work).
6. **Ship** — Only after that external review approves. The **reviewer** (human or another agent) calls `update_node_status` → `ship` from `in-review` (or from `next` `in-review` when evolving). Server sets `shipped_at` and computes `stable` or `unstable`; if a `next` slot was open, ship promotes it over `current` and deletes `next.mdx`.
   - **External Review:** the implementing agent MUST NOT `ship` (or Bug `resolved`) their own work. Wait for a human or a different agent to review and perform the ship/resolve transition.
   - **Infrastructure First:** a Workflow cannot ship until every direct `depends_on` Foundation and Workflow is `stable`. Ship Foundations (and prerequisite Workflows) first.
   - Never set Journey, `stable`, or `unstable` manually — they are computed.

Retreat when needed: `in-progress` ↔ `ready`, `in-review` → `in-progress` (same rules apply to a `next` slot). Production nodes only move to `deprecated`, or evolve in place via `open_next`.

## Scope-change description updates

When implementation reveals different scope on a **pre-ship Workflow** (`draft`, `ready`, `in-progress`, `in-review`):

1. `patch_node_territory({ node_id, description: "…" })` — also update PRD `body` when intent changes materially
2. Re-call `find_related_nodes` to validate
3. If scope changes materially during `in-review`, retreat to `in-progress` before large checklist/PRD rewrites — description alone does not satisfy Completion Check

**Never** change `description` or `title` on the `current.mdx` of a shipped Workflow (`stable`/`unstable`/`deprecated`) — call `open_next` first, then `patch_node_territory` (defaults to `next`) for live scope changes.

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

Foundations and Workflows keep one stable id forever — there is no new node id for an evolution. Do **not** reset a shipped Foundation/Workflow back to `draft`.

1. `get_blast_radius` on the live node — note dependents and `journeys_at_risk` before opening an evolution.
2. `open_next` — opens `next.mdx` on the **same** node id, seeded from `current.mdx` (`draft` state, inherited outgoing `belongs_to`/`depends_on`, optional new `title`/`description`). The live node keeps serving unchanged under `current.mdx`; `get_node_context` / `orient_for_work` surface the live `record` plus a `next` slot.
3. Run the **build pipeline loop** against the next slot: `update_node_status` transitions `next.state` through `draft → ready → in-progress → in-review`; `patch_node_territory` defaults to `next` for a shipped node with a next slot open (pass `slot: "current"` to explicitly target the live file instead).
4. `update_node_status` → `ship` is only legal from `next` `in-review`. It re-checks **Infrastructure First** against the next slot's `depends_on`, promotes `next.mdx` over `current.mdx` (title, description, body, edges), deletes `next.mdx`, sets `shipped_at`, and recomputes `stable`/`unstable` — same id throughout.
5. `discard_next` abandons an in-flight evolution at any point — deletes `next.mdx` (and `next-attachments/`); `current.mdx` is untouched. Only one `next.mdx` may be open per node at a time — `open_next` is blocked while one already exists; discard or ship it first.

## Territory rules during execution

- Atomic Ops are the definition of done, read from `current.mdx` (or `next.mdx` while a next slot is open). Recognized syntax: `- [ ]` / `- [x]` (also `*` / `+` list markers).
- Checkbox state on disk gates `in-review`, `ship`, and Bug `in-review`/`resolved` — checked against whichever file is active (`current.mdx`, or `next.mdx` when evolving).
- Enrich or replace scaffold checklist placeholders during `draft` / triage with real PR-sized work items.
- Attachments live under `attachments/` (`next-attachments/` while evolving); reference them from the body with relative links.
- Workflow/Foundation implementation lives under `src/workflows/<id>/` or `src/foundations/<id>/` (scaffolded by `create_node`). Query with `get_node_implementation`. Journeys have no code package — derive architecture from member Workflows via `belongs_to`.

## Compiler rules

| Rule | Gate | Fix |
|------|------|-----|
| **No Ghost Workflows** | `ready`/`in-progress` (incl. `next` slot) | At least one `belongs_to` + at least one `depends_on` via `link_nodes` |
| **No Ghost Bugs** | `triaged`/`fixing` | `link_nodes` with `affects` first |
| **Infrastructure First** | Workflow `ship` (current or `next`) | Ship linked Foundations and dependent Workflows to `stable` first |
| **External Review** | Workflow/Foundation `ship`, Bug `resolved` | Implementing agent parks at `in-review`; a human or different agent reviews then ships/resolves (playbook; not a server gate) |
| **Completion Check** | `in-review`, `ship`, Bug `in-review`/`resolved` | Check off all `- [ ]` in `current.mdx` / `next.mdx` |
| **Computed Journeys** | manual Journey status | Never set — server computes from Workflows |
| **Computed Stability** | manual `stable`/`unstable` | Never set — use `ship` from `in-review`; Bugs drive `unstable` via `affects` |
| **Taxonomy** | illegal edge shape | Use correct edge type and node pairing |
| **Dependency Closure** | `belongs_to` Workflow → Journey | Link dependent Workflows to the same Journey first, or pass `link_dependent: true` |
| **Next Evolution** | `open_next` | Only `stable`/`unstable` nodes; blocked while a `next.mdx` already exists — `discard_next` or ship it first |
| **Shipped scope freeze** | `patch_node_territory` title/description on the `current` slot of a shipped Workflow | Call `open_next` first, then patch the `next` slot |

## MCP tools

| Tool | When to use |
|------|-------------|
| `orient_for_work` | **Start here** — query + focus neighborhood + context + blast radius (Foundation/Workflow) |
| `find_related_nodes` | Orient — rank by query, return focus + 1-hop links (prefer over full graph) |
| `export_mindplan_view` | Human diagram — Mermaid/DOT on demand (full or focus); do not read `mindplan/map.md` as authority |
| `get_mindplan_graph` | Full graph dump — greenfield, multi-node plan validation, or rare full audits |
| `get_blast_radius` | Before substantial implementation — transitive dependents (reverse `depends_on`) and `journeys_at_risk` |
| `get_node_context` | Read territory — prefer `record` + `body`; includes `next` slot when evolving; `raw_context` is deprecated |
| `get_node_implementation` | Prescribed package root for a Workflow/Foundation (`src/workflows/<id>` or `src/foundations/<id>`) |
| `patch_node_territory` | Territory body edits, checkboxes, title/description; defaults to `next` when evolving a shipped node |
| `create_node` | New Journey, Foundation, Workflow, or Bug (prefer define-entities skill) |
| `open_next` | Open `next.mdx` on a shipped Foundation/Workflow (same id) to evolve it in place |
| `discard_next` | Abandon an in-flight `next.mdx` evolution; `current.mdx` unchanged |
| `link_nodes` | Add `belongs_to`, `depends_on`, or `affects`; optional `link_dependent: true` for Journey closure; writes to `next` while a next slot is open |
| `unlink_nodes` | Remove all edges between two nodes |
| `update_node_status` | Advance build pipeline (current or `next` slot), Bug lifecycle, or `ship` (promotes `next` over `current` when open) |

## Never do

- Implement Workflow/Foundation code outside its prescribed `src/workflows/<id>/` or `src/foundations/<id>/` package
- Start substantial coding without `orient_for_work` / `find_related_nodes` (or an explicit `node_id`) and a clear owning node
- Start substantial implementation on a Foundation or Workflow without `get_blast_radius` on the owning node
- Read or grep `mindplan/**/current.mdx`, `mindplan/**/next.mdx`, or `mindplan/map.md` when `.cursorignore` is installed — use MCP read tools
- Use terminal commands to bypass `.cursorignore` on territory paths
- Mutate the plan and continue without validating (re-read focus / graph via MCP after mutations)
- Implement under `draft`/`ready` instead of moving to `in-progress` (or Bug `fixing`) first
- Check off Atomic Ops without completing the work
- Create a Workflow when no matching Journey exists — refuse; ask the user to define the Journey first
- Hand-edit frontmatter `state`, `updated_at`, `shipped_at`, or edge arrays
- Change shipped Workflow `title` or `description` on the `current` slot — call `open_next`, then patch the `next` slot instead
- Set Journey, `stable`, or `unstable` states manually
- Move a Workflow past `ready` without both required links
- Move a Bug past `open` without an `affects` link
- Ship a Workflow while linked Foundations or prerequisite Workflows are not `stable`
- `ship` a Foundation/Workflow (or `resolved` a Bug) that this same agent session implemented — leave `in-review` for a human or another agent
- Transition to gated states with unchecked `- [ ]` items in `current.mdx` / `next.mdx`
- Reset a shipped node to `draft` — use `open_next` to evolve it in place instead
- Open a second `next.mdx` while one is already in flight — `discard_next` or ship it first
