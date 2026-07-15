# MindPlan

**MindPlan is the product plan AI agents work from.**  
Software cannot be written without knowing what the system is. MindPlan keeps that knowledge in the repo — capabilities, infrastructure, dependencies, and what's allowed to ship — so agents build against a real model of the project instead of guessing from tickets and chat.

Plan state lives next to the code. Every change to it is checked; illegal moves are rejected.

## The problem

How can AI agents write software if they do not know what the project is about? Without a durable model of the product — what capabilities exist, what infrastructure is ready, what is legal to build next — agents improvise from chat history and stale tickets. They build on unfinished plumbing, ship over unstable dependencies, or mark work done while checklist items are still open.

External trackers (Jira, Linear, GitHub Projects) do not fix that: they list intent, but they do not give agents a living picture of the system, and nothing refuses an illegal move when the ticket says "ship."

## A plan that can refuse

Traditional issue trackers answer: *what should someone work on?*

MindPlan answers:

- What **is** this project — which capabilities and infrastructure exist?
- What **can** be worked on next?
- Is this change **architecturally valid**?
- What will this **break**?
- Is this feature even **allowed to ship**?

That plan is not advisory. Every mutation is validated like a compile step for planning — guardrails reject violations with a machine-parsable error:

```
Blocked: Infrastructure First. Workflow "wf-checkout" cannot ship while
linked Foundations or Workflows are not stable: "f-payments" (in-progress).
```

No ghost workflows without a capability and foundation, no shipping on unstable deps, no review while Atomic Ops are unchecked. Agents get a focus node, its links, and blast radius *before* they touch code — not after something breaks.

## How it's built

Plan state lives in the repository as `context.mdx` files under `mindplan/` (Journeys, Foundations, Workflows, Bugs). An MCP server is the single write path: it mutates frontmatter, validates plan mutations against architectural rules, and exposes a queryable graph (`find_related_nodes`, `get_blast_radius`, `export_mindplan_view`). Consumer projects commit territory next to application code so the product plan and the implementation share one history.

- **[SPEC.md](SPEC.md)** — full framework specification (taxonomy, state machines, compiler rules, file formats, tool contract)
- **`src/`** — TypeScript MCP server (stdio transport)

This repository also keeps its own `mindplan/` territory to dogfood the framework.

## The mindplan for mindplan

This repository dogfoods MindPlan. Live territory: [`mindplan/`](mindplan/).

**Map:** [mindplan/map.md](mindplan/map.md) — auto-generated Mermaid chart, refreshed after every graph mutation. Open that file on GitHub to render the diagram.

## Who is this for

MindPlan is built for people who ship **with AI agents** and need those agents to know what the project is — a living product plan, not a stale ticket list.

It works best for **indie developers and small teams** working solo or in tight sync — the kind of project where one person (or one agent) touches `mindplan/` at a time. Because planning state is plain-text `context.mdx` files in git, it inherits git's concurrency model: no built-in locking or conflict resolution. That tradeoff is a good fit when:

- You're a solo builder or a small team working on one branch at a time
- You want planning and code to live and merge together
- Your agents need a queryable source of truth that can refuse illegal moves

It's a poor fit today for:

- Larger teams with many contributors mutating the same nodes concurrently — simultaneous edits to the same `context.mdx` frontmatter (state, edges) can produce git conflicts the rules engine doesn't help you resolve
- Organizations that need multi-user permissions, audit trails, or sync with existing PM tools (Jira, Linear, GitHub Projects) — MindPlan intentionally has no external sync

## Quick start

**Not yet published to npm — install from source.**

1. Clone and build the server:

```bash
git clone https://github.com/nbiro/mindplan.git
cd mindplan
npm install && npm run build
```

2. From your project's root directory, run `init` against the built server to scaffold `mindplan/` and install agent instructions:

```bash
node /absolute/path/to/mindplan/dist/index.js init
```

`init` uses the current working directory as the project root (override with `MINDPLAN_ROOT`) and installs:

- `mindplan/agent/playbook.md` — always-on SDLC execution process for all software work
- `mindplan/agent/skills/define-entities/` — guide for defining Journey, Foundation, Workflow, and Bug nodes
- `mindplan/agent/mcp.json.example` — MCP server config snippet
- `mindplan/agent/integrations/` — setup guides for Cursor, Claude Code, Copilot, Windsurf, Cline, Continue, and generic MCP clients
- `AGENTS.md` at the project root — created only when missing (many agents auto-read this file)

3. Register the MCP server with your coding agent — pick the guide that matches your tool:

```
mindplan/agent/integrations/
```

See [integrations README](templates/agent/integrations/README.md) in this repo for the full list.

4. Reload MCP servers in your agent after config changes.

## File system layout (consumer project)

```
<project-root>/
├── AGENTS.md                        # Agent instructions (optional; created by init when missing)
└── mindplan/
    ├── agent/                       # Agent integration assets (installed by init)
    │   ├── playbook.md
    │   ├── mcp.json.example
    │   ├── integrations/            # Per-agent MCP setup guides
    │   └── skills/
    │       └── define-entities/
    ├── components/                # Project-specific MDX components (optional)
    ├── journeys/<id>/
    │   ├── context.mdx
    │   └── attachments/
    ├── foundations/<id>/
    │   ├── context.mdx
    │   └── attachments/
    ├── workflows/<id>/
    │   ├── context.mdx
    │   └── attachments/
    └── bugs/<id>/
        ├── context.mdx            # Repro, expected/actual, fix checklist
        └── attachments/           # Logs, screenshots
```

Context files are MDX. Node records and outgoing edge arrays (`belongs_to`, `depends_on`, `affects`, `supersedes`) live in YAML frontmatter. See SPEC.md §6.1 and §7.

## Taxonomy

| Type | What it is | States |
|------|------------|--------|
| **Journey** | An ongoing product surface or user capability you keep shipping into (e.g. "Table ordering", "Onboarding"). Not a project with an end date — a permanent container for related Workflows. | Computed (`draft`, `incubation`, `stable`, `evolving`) |
| **Foundation** | Plumbing with no direct user value (e.g. auth, DB schema, payment provider). Exists so Workflows can depend on it; must be stable before those Workflows can ship. | Build pipeline + computed production (`stable` / `unstable`) |
| **Workflow** | A concrete feature or piece of business logic users actually hit (e.g. "Split the check", "Process payment"). Belongs to one or more Journeys; depends on Foundations (and sometimes other Workflows). | Build pipeline + computed production (`stable` / `unstable`) |
| **Bug** | A defect on a Workflow or Foundation. The only type with a real closed end (`resolved` / `wontfix`). | Dedicated: `open → triaged → fixing → in-review → resolved \| wontfix` |

Journeys hold the map · Workflows are the work · Foundations are what that work runs on.

**Build pipeline** (Foundation/Workflow): `draft → ready → in-progress → in-review → ship` (sets `shipped_at`, computes `stable` or `unstable`).

**Production posture** (`stable` / `unstable`) is computed from open Bugs via `affects` edges — never set manually. Open bug = `open`, `triaged`, `fixing`, or `in-review`.

In traditional trackers, epics close when a milestone ships — then drop out of the living product map even though the same flows keep getting developed. MindPlan doesn't do that: Journeys stay permanent and move between `incubation`, `stable`, and `evolving`; Workflows stay `stable`/`unstable` and evolve via versioning instead of closing. Only Bugs close.

## Compiler Rules

Every violation throws an error starting with `Blocked: `.

1. **No Ghost Workflows** — Workflow cannot reach `ready`/`in-progress` without at least one `belongs_to` + at least one `depends_on`.
2. **No Ghost Bugs** — Bug cannot reach `triaged`/`fixing` without at least one `affects` edge.
3. **Infrastructure First** — Workflow cannot `ship` unless all linked Foundations and Workflows are `stable`.
4. **Completion Check** — unchecked `[ ]` in `context.mdx` block `in-review`, `ship`, and Bug `in-review`/`resolved`.
5. **Computed Journey States** — from shipped + in-progress Workflows only; Bugs do not affect Journeys.
6. **Computed Stability** — shipped nodes flip `stable` ↔ `unstable` when open Bugs are linked, unlinked, or resolved.
7. **Taxonomy Enforcement** — edge creation must use a legal shape/type pairing, no self-links or duplicates, no `depends_on` cycles.
8. **Dependency Closure** — linking a Workflow to a Journey is rejected when transitively depended-on Workflows are not already in that Journey; pass `link_dependent: true` to auto-link them.
9. **Version Lineage** — only shipped nodes can be versioned; predecessor auto-deprecates when the new version ships.

## MCP Tools

| Tool | Kind | Description |
|------|------|-------------|
| `find_related_nodes` | read | Rank nodes by text query; return focus + 1-hop linked neighborhood (summaries) |
| `get_mindplan_graph` | read | Nodes and edges assembled from territory frontmatter |
| `export_mindplan_view` | read | Mermaid or DOT typed-DAG projection (full map or focus + 1-hop) |
| `get_blast_radius` | read | Transitive dependents of a node (reverse depends_on) and journeys_at_risk |
| `get_node_context` | read | Returns `title`, `description`, `context.mdx`, attachment paths, and filenames |
| `create_node` | mutation | Creates Journey, Foundation, Workflow, or Bug folder + `context.mdx` |
| `create_node_version` | mutation | New draft version of a shipped Workflow/Foundation; inherits outgoing edges; duplicates incoming depends_on onto dependents; predecessor stays live until successor ships |
| `link_nodes` | mutation | `belongs_to`, `depends_on` (Foundation or Workflow), or `affects`; optional `link_dependent` for journey closure; writes to source-node frontmatter; recomputes Journey + stability |
| `unlink_nodes` | mutation | Removes edge(s) from source-node frontmatter; recomputes Journey + stability |
| `update_node_status` | mutation | Transitions + `ship`; auto-deprecates predecessor on version ship; recomputes stability and Journey states |

## CLI

| Command | Description |
|---------|-------------|
| `mindplan-mcp` | Start the MCP server (stdio) |
| `mindplan-mcp init` | Scaffold `mindplan/`, agent playbook, skills, integrations, and `AGENTS.md` |
| `mindplan-mcp view` | Print a Mermaid/DOT projection of the territory graph (`export` is an alias) |
| `mindplan-mcp help` | Show usage |

`view` options: `--format mermaid|dot`, `--focus <node-id>`, `--include-retired`, `--output <file>`.

Set `MINDPLAN_ROOT` to override the project root (defaults to `process.cwd()`).

Graph views are read-only projections of the assembled graph (see SPEC §7.4). They do not replace MDX viewers or external board sync.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm install
npm run build
npm test
```

## License

[MIT](LICENSE)
