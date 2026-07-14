# MindPlan

Normative specification and reference MCP server for the **MindPlan** SDLC framework — a compiler-style state machine and GitOps issue-tracking system for AI agents and engineering teams.

- **[SPEC.md](SPEC.md)** — full framework specification (taxonomy, state machines, compiler rules, file formats, tool contract)
- **`src/`** — TypeScript MCP server (stdio transport)

Planning data (`mindplan/`) lives in **consumer projects**, not in this repo. Commit `mindplan/` to version control alongside application code.

## Quick start

In your project:

```bash
npx mindplan-mcp init
```

Add to `.cursor/mcp.json` in that project:

```json
{
  "mcpServers": {
    "mindplan": {
      "command": "npx",
      "args": ["-y", "mindplan-mcp"]
    }
  }
}
```

Reload MCP servers in Cursor. The server uses the opened workspace as the project root, so `MINDPLAN_ROOT` is usually unnecessary.

`init` also installs:

- `.cursor/rules/mindplan.mdc` — always-on agent playbook (MCP workflow, compiler rules)
- `.cursor/skills/mindplan-define-entities/` — skill for defining Journey, Foundation, Workflow, and Bug nodes

Reload Cursor after init if rules/skills are not picked up immediately.

To install manually:
- Copy `templates/mindplan-agent.mdc` → `.cursor/rules/mindplan.mdc`
- Copy `templates/mindplan-define-entities/` → `.cursor/skills/mindplan-define-entities/`

To pin a version:

```json
"args": ["-y", "mindplan-mcp@0.1.0"]
```

### Before npm publish (from source)

```bash
git clone https://github.com/mindplan-io/mindplan.git
cd mindplan
npm install && npm run build
```

```json
{
  "mcpServers": {
    "mindplan": {
      "command": "node",
      "args": ["/absolute/path/to/mindplan/dist/index.js"]
    }
  }
}
```

## File system layout (consumer project)

```
<project-root>/
└── mindplan/
    ├── mindplan.json              # The Map — a DAG of nodes and edges
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

Context files are MDX. See SPEC.md §6.4 for the component contract.

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
3. **Infrastructure First** — Workflow cannot `ship` unless all linked Foundations are `stable`.
4. **Completion Check** — unchecked `[ ]` in `context.mdx` block `in-review`, `ship`, and Bug `in-review`/`resolved`.
5. **Computed Journey States** — from shipped + in-progress Workflows only; Bugs do not affect Journeys.
6. **Computed Stability** — shipped nodes flip `stable` ↔ `unstable` when open Bugs are linked, unlinked, or resolved.

## MCP Tools

| Tool | Kind | Description |
|------|------|-------------|
| `get_mindplan_graph` | read | Full parsed `mindplan.json` |
| `get_node_context` | read | Returns `context.mdx`, attachment paths, and filenames |
| `create_node` | mutation | Creates Journey, Foundation, Workflow, or Bug folder + `context.mdx` |
| `link_nodes` | mutation | `belongs_to`, `depends_on`, or `affects`; recomputes Journey + stability |
| `unlink_nodes` | mutation | Removes edge(s); recomputes Journey + stability |
| `update_node_status` | mutation | Transitions + `ship`; recomputes stability and Journey states |

## CLI

| Command | Description |
|---------|-------------|
| `mindplan-mcp` | Start the MCP server (stdio) |
| `mindplan-mcp init` | Scaffold `mindplan/`, install agent rule, and define-entities skill |
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
