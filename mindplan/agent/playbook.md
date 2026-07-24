# MindPlan Agent Playbook

**Always apply.** For any software work in this repository, follow MindPlan. Orient on the graph before coding. Mutate graph state only through the **MindPlan MCP server**. Treat every `Blocked: <reason>` as a hard failure — read it, fix the plan, then retry. Do not retry blindly.

Normative reference: `SPEC.md` (in the mindplan-mcp package or repo). Entity scaffolding (create/link nodes, Journey-first): `mindplan/agent/skills/define-entities/SKILL.md`. Plan-only sessions (model the product graph with no application code): `mindplan/agent/skills/plan-project/SKILL.md`. Plan Review and Implementation review (orchestrated Reviewer-subagent loop): `mindplan/agent/skills/review-work/SKILL.md`.

## Authority model

| Layer | Location | Who writes |
|-------|----------|------------|
| **Node record** | `mindplan/<type>s/<id>/current.mdx` frontmatter | Server owns **state**, **updated_at**, **shipped_at**, **belongs_to**, **depends_on**, **affects** via MCP |
| **title / description** | `current.mdx` frontmatter scalars (or `next.mdx` while evolving) | **Agent file tools** (preferred) on `current_path` / `next_path` from MCP orientation; `patch_node_territory` is an optional fallback |
| **Territory body** | `current.mdx` body (or `next.mdx` while evolving) | **Agent file tools** (preferred) — edit body below the closing `---` so host “changed files” UIs show the write; `patch_node_territory` optional fallback |
| **Attachments** | `mindplan/<type>s/<id>/attachments/` (`next-attachments/` while evolving) | Normal file tools |

A node's id is stable forever — Foundations and Workflows never get a new id to evolve; they open an optional `next.mdx` next to `current.mdx` instead.

**Never edit** server-owned frontmatter fields (`state`, `updated_at`, `shipped_at`, edge arrays) by hand.

## Territory access (MCP = graph; file tools = prose)

Orient and mutate **graph structure** only through MCP. Write **territory prose** with host file tools so humans see native diffs. `.cursorignore` (via `mindplan-mcp init`) ignores `mindplan/map.md` and `mindplan/agent/**` — it does **not** block `current.mdx` / `next.mdx`.

- **Orient via MCP** — `orient_for_work` / `find_related_nodes` / `get_node_context`. Do not invent graph state by grepping territory folders.
- **Never** trust `state`, edge arrays, or `shipped_at` except from MCP tool responses (`record` in `get_node_context` / `orient_for_work`)
- **Never** read `mindplan/map.md` as graph authority — call `export_mindplan_view` or re-call `find_related_nodes` after mutations
- **Graph mutations (MCP only):** `create_node`, `link_nodes`, `unlink_nodes`, `update_node_status`, `force_unship`, `open_next`, `discard_next`
- **Prose edits (file tools preferred):** after orientation, Write/StrReplace `title` / `description` scalars and the body below frontmatter at `current_path` or `next_path`. Toggle checklist boxes the same way. Never rewrite server-owned frontmatter fields.
- **`patch_node_territory`:** optional fallback (automation, hosts with weak file tools). Prefer file tools in interactive coding agents so the host “changed files” strip shows the edit.
- After graph MCP tools succeed, narrate what changed using `changed_files` (and states/edges) from the tool result — MCP FS writes do not appear in many hosts’ native edit UIs; review those paths via Source Control or by opening the cited file.

## Taxonomy (quick map)

| Type | Purpose | States |
|------|---------|--------|
| **Journey** | Domain capability the architecture screams; permanent use-case container | Computed only: `draft`, `incubation`, `stable`, `evolving` |
| **Foundation** | Shared substrate by role (Assembler, Infra, Design system, Adapter) — no standalone use case | `draft` → `ready` → `in-progress` → `in-review` → `ship` → `stable`/`unstable` (or `cancelled` pre-ship) |
| **Workflow** | Concrete use case / feature (may span Journeys; may depend on other Workflows) | Same build pipeline as Foundation |
| **Bug** | Defect on a Workflow or Foundation | `open` → `triaged` → `fixing` → `in-review` → `resolved` \| `wontfix` |

**IDs:** `^[a-z0-9][a-z0-9-_]*$`. Prefer prefixes: `j-`, `f-`, `wf-`, `bug-`. IDs never change — evolution happens in place via `next.mdx`, not by minting a new id.

**Edges:** `belongs_to` (Workflow → Journey), `depends_on` (Workflow/Foundation → Foundation or Workflow → Workflow), `affects` (Bug → Workflow/Foundation). No other edge types exist.

**Foundation roles** (docs convention only — not NodeTypes or frontmatter). Agents SHOULD tag the role at the start of the Foundation `description` (e.g. `"Assembler — Next.js app shell"`):

| Role | Owns | Examples |
|------|------|----------|
| **Assembler** | External framework/runtime that mounts Workflow packages | `f-nextjs`, `f-vercel-cron` |
| **Infra** | Persistence, messaging, storage, observability | `f-db`, `f-queue`, `f-auth` |
| **Design system** | Tokens + dumb presentational UI | `f-design-system` |
| **Adapter** | Third-party / protocol SDKs | `f-stripe`, `f-resend` |

A Journey's assembler(s) are derived from member Workflows' `depends_on` — Journeys still have no outgoing edges. Different Journeys MAY use different assemblers.

## Definition order (use-case-first)

Greenfield entity creation follows use-case-first order — derive Foundations from drafted Workflows:

```
Journey(s) → Workflow(s) at draft → Foundation(s) derived from those drafts → link_nodes → enrich territory → Plan Review Foundations → Plan Review Workflows → ready
```

Gate facts:

- Journey MUST exist before `create_node` for a Workflow.
- A Workflow MAY sit at `draft` without links; `belongs_to` + `depends_on` are required only to leave `draft` (No Ghost Workflows).
- Foundation `ready` before Workflow `ready` is sequencing preference; Infrastructure First at Workflow `ship` still requires Foundations `stable`.

Details: `mindplan/agent/skills/define-entities/` and `mindplan/agent/skills/plan-project/`.

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
| **Plan / model / architect only** (greenfield product map, reshape the graph, enrich PRDs — no application code) | Follow `mindplan/agent/skills/plan-project/` — finish at `draft`, run the **Plan Review loop**, then stop at `ready`; do not enter `in-progress` or edit `src/` |
| **Ship the plan** / “ship it” after planning (no code) | Leave modeled nodes at `draft` with links/PRD/Atomic Ops complete; run the **Plan Review loop** until `ready` (or escalate) — see **Shipping a plan** below. Never self-advance to `ready`, never `ship` / `stable`, never check Atomic Ops, never write `src/` |
| A Workflow or Foundation at `draft` needing `ready` | Parent spawns Reviewer for Plan Review (`review-work`) — do not self-advance |
| A node at `in-review` needing ship / resolved | Parent spawns Reviewer for Implementation review (`review-work`) — do not self-`ship` / self-`resolved` |
| New Journey, Foundation, Workflow, or Bug (as part of execution, or a small add while building) | Follow `mindplan/agent/skills/define-entities/` (Journey must exist before any Workflow; refuse Workflow creation when no matching Journey is in the graph) |
| Implement or advance an existing Foundation/Workflow | **Build pipeline loop** below |
| Report or fix a defect | **Bug lifecycle loop** below |
| Change to a **shipped** Foundation/Workflow | `get_blast_radius` → `open_next` → if the ask is plan/spec only, use **plan-project** on the `next` slot; if implementing, run the **build pipeline loop** against `next.mdx` until `ship` promotes it over `current.mdx` (same id) |

Do not invent tickets outside MindPlan. Do not start substantial implementation until the owning node is `in-progress` (or Bug is `fixing`) — for shipped nodes, until the `next` slot is `in-progress`. When the user asked only to plan, do not “helpfully” continue into implementation in the same session — stop after Plan Review reaches `ready`.

### Shipping a plan

In a **plan-only** session (or when the user says “ship the plan” / “ship it” meaning the MindPlan graph, not product code), **shipping the plan** means finishing the model at `draft` and running the **Plan Review loop** until `ready` (or escalate after 3 rejects) — not advancing to `ready` yourself, and not build-pipeline `ship`. `draft` → `ready` is the Reviewer’s transition (see **Review loop** below).

| Do | Do not |
|----|--------|
| Leave modeled nodes at `draft` once links, PRD, and Atomic Ops are complete, then spawn Plan Review | Advance a node to `ready` yourself — that's the Reviewer's transition |
| Leave all Atomic Ops unchecked | Check off checklist items (that means implementation happened) |
| After `ready`, stop if plan-only | Write or “just scaffold” code under `src/`, or call `ship` / `in-progress` / `in-review` / `stable` in a plan-only session |

`update_node_status` → `ship` is the **build pipeline** promotion after real work and Implementation review — never the meaning of “ship the plan.”

### Review loop (Plan Review + Implementation review)

Both gates use the same orchestration. Parent (author/implementer) **never** self-approves. Reviewer is a **fresh** independent subagent each round (Cursor `Task` or host equivalent) — never `resume` a prior Reviewer for a re-review; never same-session self-`ready` / self-`ship` / self-`resolved`.

Skill: `mindplan/agent/skills/review-work/`.

| Gate | Entry | Approve | Reject |
|------|-------|---------|--------|
| **Plan Review** | Territory complete at `draft` | `update_node_status → ready` | Leave at `draft` |
| **Implementation review** | All Atomic Ops `[x]`, then parent → `in-review` (Bug: checklist complete → `in-review`) | `→ ship` or Bug `→ resolved` | `→ in-progress` or Bug `→ fixing` |

**Why Plan Review exists.** Same Fit/Decomposition checks as Implementation review, applied before code exists — cheaper to fix as text. Mandatory for every Workflow/Foundation `draft → ready` (including a `next` slot).

#### Spawn

1. Prefer synchronous Reviewer Task (`run_in_background: false`). If the host forces background, do **not** advance until the Reviewer finishes and MCP state is re-read.
2. **Fixed prompt** (no leading for approve): node id, procedure (PlanReview or ImplementationReview), follow `review-work`, call `update_node_status` only on verdict, return a **structured verdict message**. Forbid soft language like “approve unless catastrophic.”
3. If `Read` on `mindplan/agent/**` fails (cursorignore), load the skill via shell/`cat`, or embed Procedure steps in the spawn prompt.
4. Reviewer inherits the parent’s git branch — does not re-run the main→feature-branch ritual mid-loop.

#### Structured verdict message (Reviewer → Parent)

Reviewer final message MUST include:

- `Verdict:` `Approve` | `Reject`
- `Procedure:` `PlanReview` | `ImplementationReview`
- `Node:` `<id>` (and `slot: next` when evolving)
- `Findings:` itemized list (`none` on clean Approve). Implementation Approve: short Evidence lines per Atomic Op + Fit (domain / dependency / decomposition). Reject: actionable gaps only.
- `StatusAttempted:` e.g. `ready` / `ship` / `in-progress` / `none`

**Do not** write `## Review Notes` (or equivalent) into `current.mdx` / `next.mdx`. Findings travel in the agent message only. Parent must not copy Review Notes into territory “for posterity.” Existing historical Review Notes on shipped nodes may remain; new reviews do not add more.

#### After Reviewer returns

1. Parent **re-reads MCP** (`get_node_context` / `find_related_nodes`) and confirms `record.state` / `next.state` matches the claimed verdict. Chat alone is insufficient.
2. **Approve + MCP confirms** → continue (`ready`: plan-only stops; execution may `in-progress`. `ship`/`resolved`: done).
3. **Reject + MCP confirms** → fix from **Findings in the message** → re-enter the gate → re-spawn:
   - Plan Review: still `draft` → fix → re-spawn.
   - Implementation: `in-progress`/`fixing` → fix → re-check Atomic Ops → parent advances to `in-review` again → **then** re-spawn.
4. **Approve claimed but state unchanged** (Blocked: Infra First / Completion Check / etc.) → **failed transition** — do not continue as Approve; fix the block if parent-owned, re-spawn, or escalate. Counts toward the reject/failure budget.
5. After **3** rejects/failed transitions at the same gate → escalate to the human with the latest verdict message. Do not self-approve.

Hosts without subagents: open an independent Reviewer chat (legacy). Still preferred over self-approve.

#### Reviewer checks (summary)

**Plan Review:** buildable PRD/AC; domain fit; dependency completeness; decomposition quality; scope (one use case). Mutation boundary: `update_node_status` only — never `link_nodes` / `create_node` / fix the plan yourself.

**Implementation review:** evidence line per checked Atomic Op; territory vs diff; domain fit; dependency accuracy; decomposition drift; **diff hygiene** (Reject scratch/patch/temp/unrelated files); **general code review** — host-native first (built-in skill/command e.g. Cursor `/code-review`), else community `code-review-skill`/`code-review`, else thin `mindplan/agent/skills/code-review/`. Same mutation boundary. Never implements.

Solo builders: spawning Reviewer yourself does not make the gate optional — the evidence/Findings in the verdict message are the gate. Approving without them is rubber-stamping.

## Validate after every plan change

After **each** MindPlan graph mutation — `create_node`, `open_next`, `discard_next`, `link_nodes`, `unlink_nodes`, `update_node_status`, `force_unship` — **and** after any material territory prose edit that changes checklist gates or intent, **validate before continuing**:

1. Re-read the changed focus with `find_related_nodes` (or `get_node_context` / `orient_for_work`). For multi-node restructuring, call `get_mindplan_graph` once and confirm the full picture.
2. Confirm the mutation stuck: expected `id`s, `state`s (including `next.state` when a next slot is open), and edges (`belongs_to` / `depends_on` / `affects`) match what you intended. Use `changed_files` from the tool result when narrating MCP writes to the human.
3. If the response is `Blocked: …` or the graph does not match intent, **stop** — fix the plan, then mutate again. Do not proceed to implementation or the next mutation on a known-bad graph.
4. **Confirm the visualization** — call `export_mindplan_view` or re-call `find_related_nodes` after graph mutations. Do not read `mindplan/map.md` as authority.

Compiler success on write is necessary but not sufficient — always re-read via MCP and confirm the graph matches intent.

## Build pipeline loop (Foundation / Workflow)

```
draft → ready → in-progress → in-review → ship → stable/unstable
```

For a shipped node evolving via `open_next`, this same pipeline runs against the `next.mdx` slot — `update_node_status` applies to `next` automatically while it exists (see Versioning shipped work below). The live node keeps serving under `current.mdx` for the whole loop; only `ship` promotes `next` over `current`.

1. **Orient** — `orient_for_work` or `find_related_nodes` to resolve the owning node and links, then `get_node_context` for the focus. Call `get_blast_radius` on the focus node before substantial implementation; note transitive dependents and `journeys_at_risk`. Read PRD, Acceptance Criteria, and Atomic Ops from `body` (or `next.body` when a next slot is open).
2. **Pre-flight (leave `draft`)** — Workflows need at least one `belongs_to` and at least one `depends_on` before `ready`/`in-progress` (draft Workflows may exist unlinked while Foundations are derived — see **Definition order**). Foundations may optionally `depends_on` other Foundations. Use `link_nodes` (or the define-entities skill if nodes/links are missing).
3. **Commit to work** — Node must already be `ready` (after Plan Review). Then `update_node_status` → `in-progress` **before** substantial implementation. Do not code under `draft`/`ready` as if the work were underway; do not self-advance `draft` → `ready`.
4. **Execute** — When `implementation_packages` is `required` (default), implement in the node's prescribed package (`src/workflows/<id>/` or `src/foundations/<id>/`). When `off` (layout-free / `mindplan-mcp init --layout free`), implement in the project's existing layout instead — still keep territory in sync. Keep territory updated with **file tools** on `current_path` / `next_path`: update PRD body, toggle Atomic Ops checkboxes. Never check a box without doing the work. (`patch_node_territory` remains an optional fallback.) Query architecture with `get_node_implementation` plus the graph (`root` is null when packages are off).
5. **Review gate** — When all Atomic Ops are `[x]`, `update_node_status` → `in-review`. Unchecked boxes → `Blocked: Completion Check`. Do not immediately `ship`. Run the **Review loop** (Implementation review): spawn a fresh Reviewer subagent.
6. **Ship** — Only after Reviewer Approve + MCP confirms. The **Reviewer** (not the implementer session) calls `update_node_status` → `ship` from `in-review` (or from `next` `in-review` when evolving). Server sets `shipped_at` and computes `stable` or `unstable`; if a `next` slot was open, ship promotes it over `current` and deletes `next.mdx`.
   - **External Review (loop):** the implementing agent MUST NOT `ship` (or Bug `resolved`) their own work. Spawn Implementation review via `review-work`; iterate on Findings until Approve or escalate.
   - **Infrastructure First:** a Workflow cannot ship until every direct `depends_on` Foundation and Workflow is `stable`. Ship Foundations (and prerequisite Workflows) first.
   - Never set Journey, `stable`, or `unstable` manually — they are computed.

Retreat when needed: `in-progress` ↔ `ready`, `in-review` → `in-progress` (same rules apply to a `next` slot). Production nodes only move to `deprecated`, or evolve in place via `open_next`.

## Scope-change description updates

When implementation reveals different scope on a **pre-ship Workflow** (`draft`, `ready`, `in-progress`, `in-review`):

1. Edit `description` (and PRD `body` when intent changes materially) via file tools on `current_path` — do not touch server-owned frontmatter fields
2. Re-call `find_related_nodes` to validate
3. If scope changes materially during `in-review`, retreat to `in-progress` before large checklist/PRD rewrites — description alone does not satisfy Completion Check

**Never** change `description` or `title` on the `current.mdx` of a shipped Workflow (`stable`/`unstable`/`deprecated`) — call `open_next` first, then edit the `next` slot with file tools.

## Bug lifecycle loop

```
open → triaged → fixing → in-review → resolved
         ↘ wontfix (from open)
```

1. If the Bug does not exist yet, create it via define-entities (starts `open`).
2. `link_nodes` with `affects` → target Workflow or Foundation **before** leaving `open`. Open Bugs flip the target to `unstable` after it has shipped.
3. `update_node_status` → `triaged` → `fixing`.
4. Fix in application code; check off Fix Checklist items via file tools on the Bug's `current_path` (or `patch_node_territory` fallback).
5. `in-review` only when the checklist is complete; then run the **Review loop** (Implementation review) — same as Foundations/Workflows.
6. After Reviewer Approve + MCP confirms, the **Reviewer** transitions to `resolved` (or `wontfix` from `open` when closing without a fix). The implementing agent MUST NOT resolve their own Bug fix.
7. Resolving the last open Bug affecting a shipped node restores `stable`.

Bugs do not change Journey states.

## Versioning shipped work

Foundations and Workflows keep one stable id forever — there is no new node id for an evolution. Do **not** reset a shipped Foundation/Workflow back to `draft`.

1. `get_blast_radius` on the live node — note dependents and `journeys_at_risk` before opening an evolution.
2. `open_next` — opens `next.mdx` on the **same** node id, seeded from `current.mdx` (`draft` state, inherited outgoing `belongs_to`/`depends_on`, optional new `title`/`description`). The live node keeps serving unchanged under `current.mdx`; `get_node_context` / `orient_for_work` surface the live `record` plus a `next` slot.
3. **Territory Completeness** — edit `next` into a **complete proposed successor** of the live contract (Purpose, PRD/Execution Logic/Shared Substrate Spec, Acceptance Criteria). Seed is the starting point; do not replace the body with a changelog, “diff vs current,” or “this evolution only” narrative. Atomic Ops / checklist items on `next` MAY be evolution-scoped (reset for this build); spec sections MUST stay a full post-ship document. `current.mdx` MUST always describe full repo state for the node — never only the latest change.
4. Run the **build pipeline loop** against the next slot — Plan Review loop at `draft → ready` (spawn Reviewer via `review-work`), then `in-progress` → `in-review` in an execution session; edit `next.mdx` prose with file tools at `next_path` (or `patch_node_territory`, which defaults to `next` while a next slot is open — pass `slot: "current"` to explicitly target the live file instead). Do not self-advance `next` from `draft` to `ready`.
5. Before `next` → `in-review`, **verify Territory Completeness**: if you removed the full contract and left only evolution work items or a changelog, stop and restore a full successor body.
6. `update_node_status` → `ship` is only legal from `next` `in-review`. It re-checks **Infrastructure First** against the next slot's `depends_on`, promotes `next.mdx` over `current.mdx` (title, description, body, edges), deletes `next.mdx`, sets `shipped_at`, and recomputes `stable`/`unstable` — same id throughout.
7. `discard_next` abandons an in-flight evolution at any point — deletes `next.mdx` (and `next-attachments/`); `current.mdx` is untouched. Only one `next.mdx` may be open per node at a time — `open_next` is blocked while one already exists; discard or ship it first.

## Territory rules during execution

- Atomic Ops are the definition of done, read from `current.mdx` (or `next.mdx` while a next slot is open). Recognized syntax: `- [ ]` / `- [x]` (also `*` / `+` list markers).
- Checkbox state on disk gates `in-review`, `ship`, and Bug `in-review`/`resolved` — checked against whichever file is active (`current.mdx`, or `next.mdx` when evolving).
- Enrich or replace scaffold checklist placeholders during `draft` / triage with real PR-sized work items.
- Attachments live under `attachments/` (`next-attachments/` while evolving); reference them from the body with relative links.
- Workflow/Foundation implementation: under `src/workflows/<id>/` or `src/foundations/<id>/` when packages are `required` (scaffolded by `create_node`); when `implementation_packages` is `off`, implement in the existing project layout. Query with `get_node_implementation`. Journeys have no code package — derive architecture from member Workflows via `belongs_to`.

## Compiler rules

| Rule | Gate | Fix |
|------|------|-----|
| **No Ghost Workflows** | `ready`/`in-progress` (incl. `next` slot) | At least one `belongs_to` + at least one `depends_on` via `link_nodes` |
| **No Ghost Bugs** | `triaged`/`fixing` | `link_nodes` with `affects` first |
| **Infrastructure First** | Workflow `ship` (current or `next`) | Ship linked Foundations and dependent Workflows to `stable` first |
| **Plan Review** | Workflow/Foundation `draft → ready` | Parent spawns Reviewer for Plan Review loop (`review-work`); parent never self-`ready` — playbook + skill; not a server gate |
| **External Review** | Workflow/Foundation ship, Bug resolved | Parent spawns Reviewer for Implementation review loop (`review-work`); parent never self-`ship`/`resolved` — playbook + skill; not a server gate |
| **Completion Check** | `in-review`, `ship`, Bug `in-review`/`resolved` | Check off all `- [ ]` in `current.mdx` / `next.mdx` |
| **Computed Journeys** | manual Journey status | Never set — server computes from Workflows |
| **Computed Stability** | manual `stable`/`unstable` | Never set — use `ship` from `in-review`; Bugs drive `unstable` via `affects` |
| **Taxonomy** | illegal edge shape | Use correct edge type and node pairing |
| **Dependency Closure** | `belongs_to` Workflow → Journey | Link dependent Workflows to the same Journey first, or pass `link_dependent: true` |
| **Next Evolution** | `open_next` | Only `stable`/`unstable` nodes; blocked while a `next.mdx` already exists — `discard_next` or ship it first |
| **Force Unship** | `force_unship` | Mistaken ship only; requires user yes + `confirm: "unship:<id>"`; blocked while `next` open or shipped dependents exist |
| **Shipped scope freeze** | Hand-edit or `patch_node_territory` title/description on the `current` slot of a shipped Workflow | Call `open_next` first, then edit the `next` slot |

## MCP tools

| Tool | When to use |
|------|-------------|
| `orient_for_work` | **Start here** — query + focus neighborhood + context + blast radius (Foundation/Workflow) |
| `find_related_nodes` | Orient — rank by query, return focus + 1-hop links (prefer over full graph) |
| `export_mindplan_view` | Human diagram — Mermaid/DOT on demand (full or focus); do not read `mindplan/map.md` as authority |
| `get_mindplan_graph` | Full graph dump — greenfield, multi-node plan validation, or rare full audits |
| `get_blast_radius` | Before substantial implementation — transitive dependents (reverse `depends_on`) and `journeys_at_risk` |
| `get_node_context` | Read territory — prefer `record` + `body`; includes `next` slot when evolving; `raw_context` is deprecated |
| `get_node_implementation` | Package info for Workflow/Foundation; when packages `required`: `src/…/<id>` root + exists/entries; when `off`: `root: null` / `exists: false` (not applicable — check `implementation_packages` first) |
| `patch_node_territory` | Optional fallback for body/checkboxes/title/description; defaults to `next` when evolving a shipped node — prefer host file tools for prose |
| `create_node` | New Journey, Foundation, Workflow, or Bug (prefer define-entities; for plan-only sessions use plan-project); returns `changed_files` |
| `open_next` | Open `next.mdx` on a shipped Foundation/Workflow (same id) to evolve it in place; returns `changed_files` |
| `discard_next` | Abandon an in-flight `next.mdx` evolution; `current.mdx` unchanged; returns `changed_files` |
| `link_nodes` | Add `belongs_to`, `depends_on`, or `affects`; optional `link_dependent: true` for Journey closure; writes to `next` while a next slot is open; returns `changed_files` |
| `unlink_nodes` | Remove all edges between two nodes; returns `changed_files` |
| `update_node_status` | Advance build pipeline (current or `next` slot), Bug lifecycle, or `ship` (promotes `next` over `current` when open); returns `changed_files` |
| `force_unship` | **Recovery only.** Ask the user first; pass `confirm: "unship:<node_id>"` after an explicit yes. Clears `shipped_at` and sets a pre-ship state. Never invent `confirm`. |

## Git delivery (always PR)

Agents MUST land work via a **feature branch + pull request**. Never push to `main`/`master`. Leave `main`/`master` **before any repo writes**, not only before commit. Applies to plan-only, Reviewer, and implementation sessions alike.

**Repo writes** include host file-tool edits **and** MCP graph mutations that write files (`create_node`, `open_next`, `link_nodes`, `update_node_status`, etc. via `changed_files`).

**When already on the correct feature branch** for this session’s owning work: do **not** re-run the startup ritual — continue on that branch. Do not checkout `main` mid-session if it would abandon or conflict with in-flight WIP. Re-run only when starting work that should **not** land on the current branch (new owning node id, or the user asked for a fresh branch from latest main).

**When HEAD is on `main`/`master` (or detached), or starting work that should not land on the current branch:**

1. If the working tree is dirty in a way that blocks checkout/pull: **stop** — ask the user how to proceed (stash, commit on a branch, or discard). Do not invent destructive resets.
2. `git checkout main` (or `master`)
3. `git pull --ff-only` — if this fails (diverged history, conflicts): **stop** and report; do not create merge commits on main
4. Create or switch to a **feature branch** (prefer naming from the owning node id, e.g. `wf-integrity-check`)
5. **Only then** perform repo writes (file tools or MCP mutations)

Then deliver:

1. Push the feature branch with `-u`, then open a PR (`gh pr create`).
2. On the feature branch, run `mindplan-mcp check` as day-to-day hygiene (when packages are `required`: dirty-src ownership — uncommitted real `src/` needs `in-progress`; committed diffs vs base also allow `in-review` / shipped so PRs stay green through review; `create_node` `.gitkeep` scaffolds alone are allowed at `draft`/`ready` so plan-only PRs can merge). When packages are `off`, check still loads the graph but skips package/dirty-src ownership.
3. Before merge, run `mindplan-mcp check --for-main`. If it fails (any Foundation/Workflow `in-progress`/`in-review`, open `next` in those states, or Bug `fixing`/`in-review`): do not merge — ship, `cancelled`, or retreat to `draft`/`ready` first.
4. If the user asks to push or commit directly to `main`/`master`, **refuse** and offer a branch + PR instead — even when they say “just push it.”

Rationale: reduces the risk that concurrent agent sessions both write on `main`.

Pre-ship dead ends: `update_node_status(..., "cancelled")` — not `deprecated` (production only) and not `discard_next` (evolution only).

## Never do

- Implement Workflow/Foundation code outside its prescribed `src/workflows/<id>/` or `src/foundations/<id>/` package when `implementation_packages` is `required` (layout-free/`off` projects use the existing app layout instead)
- Start substantial coding without `orient_for_work` / `find_related_nodes` (or an explicit `node_id`) and a clear owning node
- Start substantial implementation on a Foundation or Workflow without `get_blast_radius` on the owning node
- Treat on-disk frontmatter or `mindplan/map.md` as graph authority — use MCP `record` / `export_mindplan_view`
- Mutate the plan and continue without validating (re-read focus / graph via MCP after mutations)
- Implement under `draft`/`ready` instead of moving to `in-progress` (or Bug `fixing`) first
- Treat “ship the plan” / plan-only “ship it” as `ship` / `stable`, or self-advance `draft` → `ready` — that phrase means finish at `draft` and run the Plan Review loop (see **Shipping a plan**)
- Approve `draft` → `ready` or `in-review` → `ship` / `resolved` in the same session that authored the plan or implementation — spawn a fresh Reviewer via `review-work` instead
- Write `## Review Notes` (or equivalent review feedback) into `current.mdx` / `next.mdx` — findings stay in the Reviewer’s structured verdict message to the parent
- Leave scratch helpers, one-off patch scripts (e.g. `_patch_*.py`), or other files outside the owning node’s Atomic Ops in the working tree / PR diff
- Check off Atomic Ops without completing the work
- Create a Workflow when no matching Journey exists — refuse; ask the user to define the Journey first
- Hand-edit frontmatter `state`, `updated_at`, `shipped_at`, or edge arrays
- Change shipped Workflow `title` or `description` on the `current` slot — call `open_next`, then edit the `next` slot instead
- Set Journey, `stable`, or `unstable` states manually
- Move a Workflow past `ready` without both required links
- Move a Bug past `open` without an `affects` link
- Ship a Workflow while linked Foundations or prerequisite Workflows are not `stable`
- `ship` a Foundation/Workflow (or `resolved` a Bug) that this same agent session implemented — spawn Implementation review instead
- Transition to gated states with unchecked `- [ ]` items in `current.mdx` / `next.mdx`
- Reset a shipped node to `draft` via normal status transitions — use `open_next` to evolve, or `force_unship` only after explicit user confirmation for mistaken ships
- Call `force_unship` without an explicit human yes in the conversation, or invent the `confirm` token
- Open a second `next.mdx` while one is already in flight — `discard_next` or ship it first
- Rewrite `next.mdx` as a delta/changelog only, or promote a body that would leave `current.mdx` describing only the latest change instead of the node's full repo contract (Territory Completeness)
- Write on `main`/`master` (file tools or MCP mutations) — run the Git delivery startup ritual first; never use main as a working branch
- Push, force-push, or merge commits **directly to `main`/`master`**
- Commit implementation work while checked out on `main`/`master` — switch branches first
- Merge a PR while `mindplan-mcp check --for-main` would fail
- Bypass the PR path because the user said “just push it” — refuse and explain