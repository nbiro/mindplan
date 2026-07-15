# MindPlan

Normative specification and reference MCP server for the **MindPlan** SDLC framework — a compiler-style state machine and GitOps issue-tracking system for AI agents and engineering teams.

## The problem

When AI agents (and humans) plan software work today, they either skip planning entirely or bolt on an external tracker such as Jira, Linear, or GitHub Projects. External trackers drift from the codebase: a ticket says "done" while the code says otherwise, dependencies between work items are informal or unenforced, and nothing stops an agent from marking a feature `ready` when it has no owning capability, no infrastructure to run on, or unfinished work. There is no single source of truth an agent can query before acting, and no automatic way to know what breaks when a piece of infrastructure or a workflow changes.

## The solution

MindPlan makes planning state **part of the repository** and puts a strict compiler in front of every mutation. Journeys, Foundations, Workflows, and Bugs live as `context.mdx` files under `mindplan/`, committed alongside the code they describe. All state changes go through an MCP server that enforces architectural guardrails — no "ghost" workflows with no capability or infrastructure, no shipping on unstable dependencies, no marking work reviewed while checklist items are unchecked — and rejects any violation with a machine-parsable `Blocked: ` error. Because the graph is queryable (`get_mindplan_graph`, `get_blast_radius`), agents can reason about dependencies and blast radius before making a change, instead of finding out after something breaks. The result: architecture, requirements, and code stay perfectly synchronized, with nothing external to drift from.

- **[SPEC.md](SPEC.md)** — full framework specification (taxonomy, state machines, compiler rules, file formats, tool contract)
- **`src/`** — TypeScript MCP server (stdio transport)

Planning data (`mindplan/`) lives in **consumer projects**, not in this repo. Commit `mindplan/` to version control alongside application code.

## Quick start

**Not yet published to npm — install from source.**

1. Clone and build the server:

```bash
git clone https://github.com/mindplan-io/mindplan.git
cd mindplan
npm install && npm run build
```

2. From your project's root directory, run `init` against the built server to scaffold `mindplan/` and install agent instructions:

```bash
node /absolute/path/to/mindplan/dist/index.js init
```

`init` uses the current working directory as the project root (override with `MINDPLAN_ROOT`) and installs:

- `mindplan/agent/playbook.md` — agent playbook (MCP workflow, compiler rules)
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

| Type | Purpose | States |
|------|---------|--------|
| **Journey** | Macro user flows. Permanent containers. | Computed (`draft`, `incubation`, `stable`, `evolving`) |
| **Foundation** | Pure infrastructure. | Build pipeline + computed production (`stable` / `unstable`) |
| **Workflow** | Business logic / features. | Build pipeline + computed production (`stable` / `unstable`) |
| **Bug** | Defect afflicting a Workflow or Foundation. | Dedicated: `open → triaged → fixing → in-review → resolved \| wontfix` |

**Build pipeline** (Foundation/Workflow): `draft → ready → in-progress → in-review → ship` (sets `shipped_at`, computes `stable` or `unstable`).

**Production posture** (`stable` / `unstable`) is computed from open Bugs via `affects` edges — never set manually. Open bug = `open`, `triaged`, `fixing`, or `in-review`.

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
| `get_mindplan_graph` | read | Nodes and edges assembled from territory frontmatter |
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
| `mindplan-mcp help` | Show usage |

Set `MINDPLAN_ROOT` to override the project root (defaults to `process.cwd()`).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm install
npm run build
npm test
```

## License

[MIT](LICENSE)
