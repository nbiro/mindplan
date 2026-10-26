# MindPlan

**Everything works great until it doesn’t. MindPlan draws the boundaries your agent won’t.**

Without them you get a 5,000-line app file; MindPlan keeps your product’s structure in git and rejects any agent move that crosses it.

## In plain words

MindPlan names five kinds of thing. Type names stay for the graph and tools; plain words help humans and agents talk about them:

| Type | Plain word | Question | Example |
|------|------------|----------|---------|
| **Journey** | area | What does the product do? | Billing |
| **Interaction** | action | What can someone do? | Split the check |
| **Interface** | entry point | Where do they do it? | Checkout page, CLI, MCP tools |
| **Foundation** | building block | What does it all run on? | Database, design system, Stripe |
| **Bug** | bug | What's broken? | Double charge on split |

Links in plain words: `belongs_to` = is part of · `exposes` = shows · `depends_on` = needs · `leads_to` = then goes to · `affects` = breaks.

Rules in plain words: **Infrastructure First** — build the building blocks before the action that needs them. **Behavior First** — an action has to work before you put it on a page. **Completion Check** — finish the checklist before going live. **No Ghosts** — every action lives in an area and stands on a building block.

## Think in systems

Orient on the graph. Place each change on it. Respect the edges. Claim files. Classify shipped work by blast radius. That dialect plus this project's brief load through `get_project`. Before each action, call `get_rules` then `orient_for_work`. Before new-feature code, update or create nodes with the `plan-project` skill.

Without those boundaries, agents improvise from chat and tickets. The compiler refuses the illegal move:

```
Blocked: Infrastructure First. Interaction "i-checkout" cannot ship while
linked Foundations are not stable: "f-payments" (in-progress).
```

## Plans are made to be changed

The compiler refuses *illegal* moves; it does not freeze the plan.

- **Rewire** — `link_nodes` / `unlink_nodes` (`belongs_to`, `depends_on`, `exposes`, `leads_to`, `affects`, `mounts`)
- **Retreat** — `in-review` → `in-progress` when scope or checklist reality changes
- **Evolve** — shipped Foundations/Interactions/Interfaces keep the same id and a standing `<id>.next.mdx` twin (`state: mirror`); `open_next` flips it to `draft` → build → `ship` promotes over `<id>.mdx` and restores the twin
- **Revise together** — classify the blast radius. Sources get a full successor (`open_next`). Neighbors whose files changed but whose behavior did not are edited in place, with no `next` and no impact note. Nodes whose files did not change are left alone. Status then moves Foundations, then Interactions, then Interfaces, then Bugs, in one call, and stops on the first `Blocked:`
- **Ship after green check** — the implementer `ship`s when `run_check` (the CLI `mindplan-mcp check`) is green and legal transitions allow; moves to `in-review` and `ship` also run its import and ownership rules on the node's files, and `update_node_status` with `scope` walks every open update (or one change's revisions) through in-review to ship in one call — jumping past in-review needs `skip_review: true`, which is reported
- **Decide on the record** — when an agent chooses between viable designs, `record_decision` keeps the choice, the rejected alternative, and the reason on the node; the next agent gets it from `orient_for_work` before touching that design. A shipped Foundation's revision, a new migration, a wide blast radius, or a `depends_on` change cannot reach `in-review` without one
- **Retire** — production work to `deprecated` when intent is replaced (Journeys stay; only Bugs truly close)

## See what the agent sees

After every graph mutation, MindPlan refreshes [`mindplan/map.md`](mindplan/map.md) — Journeys, Interactions, Interfaces, Foundations, and Bugs. On demand: MCP `export_mindplan_view` or CLI `mindplan-mcp view`.

Today's map is an **architecture + state** projection. A richer status board is planned.

## Worked example: scrambled eggs

An **area** (make breakfast), a **building block** (the stove), **actions** (crack, whisk, cook), and an **entry point** (the breakfast CLI):

```mermaid
flowchart TB
  subgraph jBreakfast ["Journey: j-breakfast · Make breakfast · incubation"]
    iCrack["i-crack-eggs · Crack eggs · stable"]
    iWhisk["i-whisk · Whisk · stable"]
    iCook["i-cook-scramble · Cook scramble · in-progress"]
  end
  subgraph foundations ["Foundations"]
    fStove["f-stove · Stove · ready"]
  end
  subgraph interfaces ["Interfaces"]
    ifCli["if-breakfast-cli · Breakfast CLI · ready"]
  end
  iCrack -->|"leads_to"| iWhisk
  iWhisk -->|"leads_to"| iCook
  iCook -->|"depends_on"| fStove
  ifCli -->|"exposes"| iCook
```

- **Journey** `j-breakfast` — area: permanent capability (make breakfast)
- **Foundation** `f-stove` — building block; cook cannot ship until the stove is `stable`
- **Interactions** — actions (crack, whisk, cook); they share state via Foundations, never `depends_on` each other. `leads_to` is "then goes to" only (cycles allowed, not a ship gate)
- **Interface** `if-breakfast-cli` — entry point: how an actor starts cooking; ship needs exposed Interactions `stable` (**Behavior First**)

```
Blocked: Infrastructure First. Interaction "i-cook-scramble" cannot ship while
linked Foundations are not stable: "f-stove" (ready).
```

In plain words: you cannot go live with *cook scramble* while the *stove* building block is still only ready to build, not live.

## How it's built

Territory under `mindplan/` (Journeys, Foundations, Interactions, Interfaces, Bugs) plus optional `<id>.next.mdx` while a shipped node evolves. Nodes declare owned source files via `implements` / `set_implementation_files` (`mindplan/config.json` `sources`/`exclude` define the coverage universe). An MCP server is the single write path for server-owned frontmatter.

- **[SPEC.md](SPEC.md)** — graph, compiler rules, and tools
- **`src/`** — TypeScript MCP server (stdio)

## This repo's live plan

This repository dogfoods MindPlan. Live territory: [`mindplan/`](mindplan/). Map: [mindplan/map.md](mindplan/map.md).

## Who is this for

Built for people who ship **with AI agents** and need a living product architecture, not a stale ticket list. Best for indie developers and small teams where plan state is plain-text in git. Poor fit today for orgs that need multi-user permissions, audit trails, or sync with Jira/Linear.

## Quick start

Requires Node.js 22.13 or later (the first 22.x release with `node:sqlite` unflagged, which the search cache uses). No clone or build step: the package ships `dist/` and the agent templates.

1. Install it.

   - **A project with a `package.json`:** add it as a dev dependency so the lockfile pins the version for everyone, CI, and containers:

     ```bash
     npm install -D mindplan-mcp
     ```

   - **Any other project** (Python, Go, …): nothing to install; use `npx -y mindplan-mcp@0.4` (a version range) in the commands below.

2. From your project root, scaffold:

```bash
npx mindplan-mcp init --host claude   # or cursor (default) / all
```

`init` installs `mindplan/agent/` (playbook + skills), `mindplan/project.md` (a copy of `templates/agent/project.md` — description + rules, not the playbook) when missing, a short MindPlan stub in `AGENTS.md` when missing, and a `.mindplan-cache/` line in `.gitignore`. Host copies depend on `--host cursor|claude|all` (default `cursor`): Cursor gets `.cursorignore`, `.cursor/permissions.json`, `.cursor/rules/mindplan.mdc` and `.cursor/skills/`; Claude Code gets `CLAUDE.md` (an `@AGENTS.md` import) and `.claude/skills/`. It also renames legacy `current.mdx` / `next.mdx` territory files to `<id>.mdx` / `<id>.next.mdx`, and stamps `mindplan/version.json` with the package version. The stub requires `get_project` before planning or code, `get_rules` then `orient_for_work` before each action, and the `plan-project` skill before new-feature graph work; when tools are hidden, use the init-installed host copies under `.cursor/` or `.claude/` and `AGENTS.md`.

3. Register the MCP server. It runs over stdio, so the host starts it from the project root. For Claude Code, commit a `.mcp.json`:

```json
{
  "mcpServers": {
    "mindplan": { "type": "stdio", "command": "npx", "args": ["mindplan-mcp"] }
  }
}
```

With a dev dependency, `npx mindplan-mcp` runs the locked copy from `node_modules/.bin` (run `npm install` first in a fresh container). Without one, use `"args": ["-y", "mindplan-mcp@0.4"]`. Other hosts: `mindplan/agent/integrations/` (or [templates/agent/integrations/README.md](templates/agent/integrations/README.md)).

4. Reload MCP servers after config changes.

### Upgrading

Bump the package (`npm update mindplan-mcp`, Dependabot, or a new `npx` range), then rerun init with the same `--host`:

```bash
npx mindplan-mcp init --host claude
```

`mindplan/version.json` records the package version that last ran init. When it is missing or older than the running server, `get_project` returns a `version` warning and `mindplan-mcp check` prints `Warning: version: …` until init runs. Init then rewrites the package-owned files (playbook, skills, integrations, MCP example, host skill copies, Cursor rule) and applies graph migrations; it leaves `AGENTS.md`, `CLAUDE.md`, `.cursorignore`, `.cursor/permissions.json`, and `mindplan/project.md` alone unless `--force`. Read [CHANGELOG.md](CHANGELOG.md) for breaking changes before upgrading across a minor version while on 0.x. A stamp newer than the server (a teammate upgraded, you did not) warns too, and init refuses it until you upgrade or pass `--force`.

### From source (contributors)

```bash
git clone https://github.com/nbiro/mindplan.git
cd mindplan
npm install && npm run build
node /absolute/path/to/mindplan/dist/index.js init   # from your project root
```

## File system layout (consumer project)

```
<project-root>/
├── .mindplan-cache/               # derived search cache (gitignored, safe to delete)
├── mindplan/
│   ├── config.json                # { sources, exclude } — coverage universe; optional decisions, search
│   ├── project.md                 # description + rules only (playbook via get_project)
│   ├── version.json               # { package, graph } — written by init; drives the upgrade warning
│   ├── agent/                     # playbook + skills (installed by init)
│   ├── journeys/<id>/<id>.mdx
│   ├── foundations/<id>/<id>.mdx  # + optional <id>.next.mdx
│   ├── interactions/<id>/<id>.mdx # + optional <id>.next.mdx
│   ├── interfaces/<id>/<id>.mdx   # + optional <id>.next.mdx
│   └── bugs/<id>/<id>.mdx
└── …                              # app code wherever implements claims it
```

Owned files are declared with `set_implementation_files` (exact paths or directories ending in `/`) under the `sources`/`exclude` universe — there is no prescribed `src/<type>/<id>/` tree. This repo dogfoods that shape; consumers need not. Edge arrays in frontmatter: `belongs_to`, `depends_on`, `exposes`, `leads_to`, `affects`. See SPEC.md §1–§2.

## Taxonomy

| Type | What it is | States |
|------|------------|--------|
| **Journey** | Domain capability the architecture screams | Computed (`draft`, `incubation`, `stable`, `evolving`) |
| **Interaction** | Self-contained behavior (any actor) — **not** an entry surface; owns domain + mountable view/handler | Build pipeline + `stable`/`unstable` |
| **Interface** | How an actor enters an Interaction (Page, CLI, MCP, Webhook, Cron, …) — **mounts/wires only** | Build pipeline + `stable`/`unstable` |
| **Foundation** | Shared substrate by role (Assembler, Infra, Design system, Adapter) | Build pipeline + `stable`/`unstable` |
| **Bug** | Defect on Interaction, Interface, or Foundation | `open → triaged → fixing → in-review → resolved \| wontfix` |

Journeys scream the domain · Interactions are behaviors (they own the screen body / handler) · Interfaces are entry (they only mount) · Foundations are shared substrate · Assembler composes them.

**Build pipeline** (Foundation/Interaction/Interface): `draft → ready → in-progress → in-review → ship` → computed `stable`/`unstable`.

## Compiler Rules

Every violation starts with `Blocked: `.

1. **No Ghost Interactions** — need `belongs_to` + Foundation `depends_on` before `ready`/`in-progress`
2. **No Ghost Interfaces** — need `exposes` before `ready`/`in-progress`
3. **No Ghost Bugs** — need `affects` before `triaged`/`fixing`
4. **Infrastructure First** — Interaction `ship` needs all Foundation deps `stable`
5. **Behavior First** — Interface `ship` needs all exposed Interactions (and Foundation deps) `stable`
6. **Completion Check** — unchecked `[ ]` block `ship` (and Bug `resolved`)
7. **Interaction Independence** — no Interaction → Interaction `depends_on` (share state via Foundations)
8. **Computed Journeys / Stability** — never set manually
9. **Taxonomy** — legal edge shapes; `depends_on` acyclic; `leads_to` cycles allowed
10. **Next Evolution / Force Unship** — stable-id `open_next`; recovery only with explicit `confirm`

No Dependency Closure / `link_dependent`.

## Search

`find_related_nodes` and `orient_for_work` rank nodes with hybrid search: keyword (SQLite FTS5) and semantic (a small local embedding model) results merged by reciprocal rank fusion, plus a small boost for nodes linked to the best matches. An exact id always ranks first, and a file path ranks the node that claims it. A query saying "quote" can find a node that says "enquiry".

- **The cache.** `.mindplan-cache/index.db` at the project root is derived from the `.mdx` files, which stay the only source of truth. It is gitignored, re-synced on every search (so a `git pull` or branch switch is picked up on the next call), and safe to delete at any time.
- **The model.** `Xenova/bge-small-en-v1.5` (English, about 30 MB) runs locally through [transformers.js](https://huggingface.co/docs/transformers.js), an optional dependency: no API key, nothing leaves the machine. It downloads once per machine into `~/.cache/mindplan/models` (override with `MINDPLAN_MODEL_CACHE`) in the background when the server starts; a tool call never waits for it.
- **Fallback.** Until the model is ready, or when it cannot load (offline, a proxy, a sandbox, `npm install --omit=optional`), search is keyword-only and never fails; the reason is logged once to stderr. On a runtime without `node:sqlite` or FTS5 (Node 22.13's bundled SQLite has no FTS5) the keyword half runs the same BM25 in plain JS, which ranks the search test set as well as FTS5 does.
- **Settings.** `patch_config({ search: { enabled: false } })` turns semantic ranking off; `patch_config({ search: { model: "Xenova/all-MiniLM-L6-v2" } })` picks another model (the cache rebuilds). `MINDPLAN_SEARCH=keyword` turns it off for one process, and `MINDPLAN_SEARCH_OFFLINE=1` uses only an already-downloaded model.

## MCP Tools

The descriptions the MCP server sends to clients — each tool's `description` and each argument's `.describe()` — are registered in [`src/interfaces/if-mcp-tools/register.ts`](src/interfaces/if-mcp-tools/register.ts). Inputs, outputs, effects, and errors are specified in [SPEC.md §8](SPEC.md#8-mcp-tool-contract). Every tool carries MCP annotations derived from its kind (`readOnlyHint` on read tools, `destructiveHint` on `unlink_nodes`, `remove_attachment`, `discard_next`, and `force_unship`; `openWorldHint` always false), so a host can auto-approve reads and prompt on destructive calls. Results are compact JSON text plus `structuredContent`. Results that grow with the graph stay under the host's size limit: `get_mindplan_graph` pages (`offset` / `limit`, `next_offset`), and `export_mindplan_view` refuses a diagram over 80,000 characters unless you pass `focus` or `output`.

| Tool | Kind | Description |
|------|------|-------------|
| `orient_for_work` | read | find + `record`/`body` context + blast radius (grouped files; retired omitted; Interaction focus includes `reachability`); the `rules` and `decisions` that apply to the focus; `depth: rules\|body\|full` trims it |
| `run_check` | read | The same integrity check as `mindplan-mcp check` (`ok`, `output`, `failures`, `warnings`); unclaimed files and illegal imports come with their fix; `change` also gates every member of a change (revisions and labeled neighbors) |
| `find_related_nodes` | read | Hybrid search by query (keyword + semantic; exact id first); focus + 1-hop |
| `get_mindplan_graph` | read | One page of assembled nodes/edges (`version: 1`): `offset` / `limit` (default 200), totals, `next_offset` |
| `export_mindplan_view` | read | Mermaid or DOT; `decisions: true` labels decision counts; `output` writes to a file; over-budget diagrams are Blocked with the fix |
| `list_decisions` | read | Decision records of a node, a change, or the graph; superseded ones on request |
| `get_blast_radius` | read | Reverse-`depends_on` affected + grouped `affected_files` for a node or a whole `change`; cancelled/deprecated omitted unless `include_retired` |
| `get_node_context` | read | `record` + `body` + `decisions` (superseded only with `include_superseded`; + `next.record`/`next.body`/`next.decisions` when evolving) |
| `get_node_implementation` | read | Owned files for a node, or path → owner lookup |
| `set_implementation_files` | mutation | Set `implements` claims (files or directories ending in `/`); on a shipped node, adds a claim in place when it only grows into folders the node alone owns; `change` labels a neighbor |
| `set_test_files` | mutation | Link the test files (paths, directories ending in `/`, or globs) that verify a node; evidence, not a claim, written to live and an open `next` alike with no `open_next` and no readiness reset; `get_blast_radius` lists them as the tests to run |
| `patch_node_territory` | mutation | Required writer for territory prose (title/description/body/checkboxes) |
| `patch_node_rules` | mutation | Write one node's `## Rules`; `orient_for_work` delivers them to the node and everything that inherits from it |
| `record_decision` | mutation | Append a decision record (what was chosen, the alternatives, why) to the node it shapes; supersede instead of editing |
| `patch_project_description` | mutation | Write the `mindplan/project.md` description |
| `patch_project_rules` | mutation | Write the `mindplan/project.md` rules |
| `patch_config` | mutation | Write `mindplan/config.json` sources/exclude, decision-gate settings, and search settings |
| `put_attachment` / `remove_attachment` | mutation | Node attachment files |
| `create_node` | mutation | Journey, Foundation, Interaction, Interface, or Bug (territory only; no src scaffold) |
| `open_next` / `discard_next` | mutation | Flip mirror→draft / restore mirror twin |
| `link_nodes` / `unlink_nodes` | mutation | Five edge types; no `link_dependent` |
| `update_node_status` | mutation | One node, or a `revisions` list ordered Foundation → Interaction → Interface → Bug; stops on the first `Blocked:` |
| `force_unship` | mutation, destructive | Mistaken-ship recovery (`confirm: "unship:<id>"`) |

## CLI

| Command | Description |
|---------|-------------|
| `mindplan-mcp` | Start MCP server (stdio) |
| `mindplan-mcp init` | Scaffold territory + agent assets; stamp `mindplan/version.json`; rerun after upgrading |
| `mindplan-mcp view` | Print Mermaid/DOT (`export` alias) |
| `mindplan-mcp check` | Offline integrity (graph + file ownership + import matrix); `--base` opt-in dirty-src; also the `run_check` MCP tool |
| `mindplan-mcp help` | Usage |

Set `MINDPLAN_ROOT` to override the project root (default `process.cwd()`). Search reads `MINDPLAN_SEARCH`, `MINDPLAN_SEARCH_OFFLINE`, and `MINDPLAN_MODEL_CACHE` (see [Search](#search)).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm install
npm run build
npm test
```

## License

[MIT](LICENSE)
