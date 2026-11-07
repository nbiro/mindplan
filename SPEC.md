# MindPlan Specification

**Version:** the `mindplan-mcp` package version (`get_spec` reports it as `version`)
**Status:** Released
**Reference implementation:** repository root (TypeScript MCP server, stdio transport)

The key words MUST, MUST NOT, SHALL, SHOULD, and MAY in this document are to be interpreted as described in RFC 2119.

---

## 0. Abstract

MindPlan keeps a product's architecture as a **persistent, machine-queryable graph** under `mindplan/`, versioned in git with the code. Its MCP server is the only writer of that graph (§8.2), and it rejects any agent move that crosses the graph's boundaries with a machine-parsable `Blocked: …` error.

The model is **Interaction-centric**. Agents query *what the system does* (Capabilities → Interactions), *how actors enter those behaviors* (Interfaces), and *what shared substrate those behaviors stand on* (Foundations, composed by an Assembler Foundation), instead of reconstructing the architecture from source on every task.

Agents receive the **systems dialect** (a playbook, the project brief, and on-demand skills) from the server (§1.1.1). `setup_project` and `upgrade_project` create and migrate the graph (§1.1.2). `GRAPH_VERSION` stays `1`; there is no compatibility layer for the former Workflow-centric schema.

---

## 1. Core Architecture: Territory

MindPlan persists the product graph under `mindplan/`. Each node owns a folder holding `<id>.mdx` and `attachments/`. The YAML frontmatter of `<id>.mdx` is the **node record**: identity, state, timestamps, and outgoing edge arrays. It is the live record under one stable id for the node's whole lifetime (§3.6). The body holds the node's spec, acceptance criteria, and Atomic Operations (§6.1).

Context files are MDX: Markdown plus optional JSX components (§6.4). Every compiler rule reads Markdown constructs only, so a file with no JSX is fully compliant.

The territory MUST live in the repository alongside the source code and MUST be versioned with it, so one commit captures code, architecture, and requirements.

### 1.1 Directory layout

MindPlan prescribes only the **planning tree** under `mindplan/`. Interactions, Interfaces, and Foundations claim code paths with `implements` (§1.2) anywhere in the project's `sources`/`exclude` universe (default `sources: ["src/**"]`). `create_node` scaffolds no code paths; ownership is declared with `set_implementation_files`. Capabilities own no code. Bugs own no code either: their fixes land in the affected node's claimed files.

```
<project-root>/
├── .mindplan-cache/                   # Derived graph and search caches, gitignored, safe to delete (§1.1.3, §8.1.1)
├── mindplan/
│   ├── config.json                    # { sources, exclude, … } — coverage universe and settings (§1.2.1)
│   ├── project.md                     # Project brief — description + rules (§1.1.1)
│   ├── version.json                   # { package, graph, migrations } — written by setup_project / upgrade_project (§1.1.2)
│   ├── map.md                         # Derived Mermaid snapshot (§7.4) — git-ignored, never in changed_files
│   ├── .gitignore                     # Lists map.md
│   ├── components/                    # Project-specific MDX components (§6.4) — opaque to the compiler
│   ├── capabilities/
│   │   └── <id>/
│   │       ├── <id>.mdx
│   │       ├── attachments/
│   │       └── decisions/             # One <decision-id>.md per decision (§6.1.2)
│   ├── foundations/
│   │   └── <id>/
│   │       ├── <id>.mdx
│   │       ├── attachments/
│   │       ├── decisions/
│   │       └── revisions/             # Open revisions only (§3.6)
│   │           └── <change>/          # One folder per open revision, named by its change id
│   │               ├── <id>.mdx
│   │               ├── attachments/
│   │               └── decisions/
│   ├── interactions/
│   │   └── <id>/                      # Same layout as foundations/<id>/
│   ├── interfaces/
│   │   └── <id>/                      # Same layout as foundations/<id>/
│   └── bugs/
│       └── <id>/
│           ├── <id>.mdx
│           └── attachments/
└── …                                  # Application code wherever implements claims it
```

Rules:

- The planning root is `<MINDPLAN_ROOT>/mindplan`. The environment variable `MINDPLAN_ROOT` names the project root; when unset, the server's working directory is used.
- The subdirectory per type is fixed: `capabilities/`, `foundations/`, `interactions/`, `interfaces/`, `bugs/`. Each entity folder name MUST equal the node `id`, and its live file MUST be named `<id>.mdx`, so a review diff shows which node changed. Legacy file names: §1.1.2.
- A shipped Foundation, Interaction, or Interface (`stable`/`unstable`) MAY hold several open **revisions** while `<id>.mdx` keeps serving: one per change id, each in `revisions/<change>/` (`<id>.mdx`, `attachments/`, `decisions/`). The folder name MUST equal the revision file's `change`, and the folder exists only while that revision is open (§3.6). `revisions/` MUST NOT exist for Capabilities or Bugs, and a pre-ship node has none.
- `attachments/` MAY hold arbitrary files, referenced from `<id>.mdx` with relative links (e.g. `![flow](attachments/flow.png)`). A revision's `attachments/` is referenced the same way from its own `<id>.mdx` and is copied into the node's `attachments/` when the revision ships (§3.6).
- `decisions/` holds one append-only file per decision record (§6.1.2), beside the live file or in a revision folder. A revision's decision files move to the node's `decisions/` when it ships.
- `map.md` is derived (§7.4): the server rewrites it after graph mutations, `mindplan/.gitignore` lists it, and no tool reports it in `changed_files`.
- `components/` is created by the server and never read by it (§6.4.3).
- The server MUST NOT create `mindplan/` at boot or on a gated call: `setup_project` (§8.2) creates the tree, and until then gated tools are `Blocked: Version` (§1.1.2). Once `mindplan/` exists, the server MUST create missing subdirectories on demand.
- A read, write, copy, or removal under `mindplan/` (node files, attachments, `project.md`, `version.json`, and the files the graph cache hashes) that fails with `EBUSY` or `UNKNOWN`, or on Windows with `EPERM` or `EACCES` (antivirus, an indexer, or a file watcher briefly holding the file), MUST be retried for about 0.3 s in all before the call fails with that error. Any other error fails the call at once; outside Windows, `EPERM` and `EACCES` are permission errors and are not retried.

#### 1.1.1 Project brief (`mindplan/project.md`)

The **project brief** at `mindplan/project.md` says what the product is and holds standing rules for every change. It is not a graph node, not frontmatter, and not a compiler rule. Agents MUST edit it only through `patch_project_description` and `patch_project_rules` (§8.2); no other tool overwrites an existing brief.

- `setup_project` MUST copy the package template `templates/agent/project.md` (`## Description` and `## Rules`) when `mindplan/project.md` is absent. The description starts empty; the rules start with the default requirement to list every `mindplan/` path in an MCP write's `changed_files`.
- A missing `project.md` is valid: `mindplan-mcp check` MUST NOT require it, and boot MUST NOT fail when it is absent or unreadable.
- **Two rule scopes.** Brief rules are **global**: they apply to every change, and every session reads them before its first write (§8.1.2), so they MUST stay short. A rule about one part of the code belongs on that part's node as **node rules** (§6.1.1), written with `patch_node_rules` and delivered by `orient_for_work` (§8.1). Both scopes are mandatory for agents and enforced by delivery: a write is Blocked until the rules that apply reached the session (§8.1.2). Neither is a compiler rule, and neither overrides a compiler `Blocked:`. The description is the product summary, not a rule.

**Dialect delivery.** The systems dialect reaches agents through four channels:

- **Server instructions.** On every MCP connect, the server `instructions` MUST be a short pointer that requires `get_project` before the first answer or code change, states the **planning duty** (a new behavior is a new node: before claiming the files of a new feature, create its node and link it; when a change alters what existing nodes describe, update those nodes), requires `mindplan/` to go through the tools, and requires `run_check` to pass before handoff. It prescribes no per-action calls. The instructions MUST NOT embed the playbook body, the project description, or the rules body.
- **Playbook.** `templates/agent/playbook.md` ships in the package. It is one screen: the agent's duties (the planning duty in the same words as the instructions and the pointer file; `mindplan/` through the tools; a green check before handoff, ship when a merge is requested), a table of what the server enforces (each `Blocked:` kind, when it fires, how to clear it), the taxonomy and edges, and how to work on the graph. When to plan is the agent's choice: the project rules and orientation gates (§8.1.2), Coverage (§1.2.1), and the merge gate (§9.6) hold whatever order it works in. Do not paste the playbook into `project.md`: `get_project` (§8.1) composes it with the brief at read time. Call `get_project` again after a description change; a rules change reaches each session through the push or the gate (§8.1.2).
- **Skills.** `get_skill` (§8.1) serves `define-entities` (creating and linking nodes, required sections) and `plan-project` (modeling and evolving a graph: breakdown, revisions, conflicts, planned wiring, worktrees) from the package, as reference the agent loads when it needs it. Nothing is copied into the repository.
- **Pointer file.** `setup_project` and `upgrade_project` return the pointer text `templates/agent/agents-stub.md` as `pointer`. The agent writes it to `MINDPLAN.md` at the repository root and wires that file into the host's agent files (`@MINDPLAN.md` in `CLAUDE.md`, a line in `AGENTS.md`, or the host's rules file), following the returned guide. It carries the instructions' points (the planning duty word for word), says the server blocks writes until the rules reached the agent, names the CI merge gate, tells agents to call the tool a `Blocked: Version` names, and never to read or edit `mindplan/**` with host file tools: the server is the only writer, and reads go through MCP because a raw node file lacks the rules inherited along `belongs_to` and `depends_on`, decision status, the active slot, and the orientation the write gate needs (§8.1.2). The server MUST NOT write these repo-owned files (`MINDPLAN.md`, `CLAUDE.md`, `AGENTS.md`, `.gitignore`, `.cursorignore`, host rules files).

#### 1.1.2 Version stamp (`mindplan/version.json`)

The stamp records which `mindplan-mcp` last set up or upgraded the tree, its graph format, and the **migration level** it reached: `{ "package": "<semver>", "graph": <GRAPH_VERSION>, "migrations": <level> }`.

- **Writers.** Only `setup_project` (when it creates the graph) and `upgrade_project` (after every migration succeeded) write the stamp, with the running package version, `GRAPH_VERSION`, and the server's `MIGRATION_LEVEL`. No other tool and no CLI command writes it.
- **Migration level.** `MIGRATION_LEVEL` is the integer level the server's migrations bring a graph to (`4`). A release MUST raise it by one when it adds a migration to `upgrade_project` and MUST NOT raise it otherwise, so a release without a new migration needs no upgrade step. The gate never compares package versions; `package` is informational except in the `server-behind` warning. A stamp whose `migrations` is missing or not a non-negative integer reads as level 0. A stamp is **unreadable** when it is not a JSON object with a SemVer `package` and an integer `graph`.
- **Status.** The server compares the tree with itself in this order. Each status but `current` has one warning sentence naming the fix:
  - `setup` — no `mindplan/`, or a `mindplan/` with no stamp and no node folder (for example a setup that stopped before its stamp, which `setup_project` finishes): `This project has no MindPlan graph (mindplan/). Call setup_project to create it, then follow the guide it returns.`
  - `server-behind` — a readable stamp whose `graph` is above `GRAPH_VERSION` or whose level is above `MIGRATION_LEVEL`: `This graph was upgraded by mindplan-mcp <package> (migration level <N>), newer than this server <version> (level <M>). Upgrade mindplan-mcp (npm install -D mindplan-mcp@<package>, or point npx at it) before using the graph.`
  - `upgrade` — a missing or unreadable stamp, a `graph` below `GRAPH_VERSION`, or a level below `MIGRATION_LEVEL`: `This graph needs an upgrade: <mindplan/version.json is missing | mindplan/version.json is unreadable | the graph is at migration level <N>>, and mindplan-mcp <version> needs level <M>. Call upgrade_project, then commit the upgrade on its own.` A stamp at the level is also `upgrade` when a merged branch brought back an old layout:
    - `mindplan/journeys/` holds a node folder (one with a live file; a folder there without one is not a node and blocks nothing): `This graph needs an upgrade: mindplan/journeys/ still holds a node folder, and mindplan-mcp <version> reads Capabilities only from mindplan/capabilities/. Call upgrade_project, then commit the upgrade on its own.`
    - a Foundation, Interaction, or Interface folder with a live `<id>.mdx` holds an `<id>.next.mdx` that is not a `state: mirror` leftover: `This graph needs an upgrade: <path> is an evolution file from before revisions/<change>/, and mindplan-mcp <version> reads open revisions only from revisions/. Call upgrade_project to move it, then commit the upgrade on its own.`
  - `current` — otherwise.

#### Version gate

While the status is not `current`, every MCP tool except nine fails with `Blocked: Version — <warning>` before it loads or writes the graph. The nine **ungated** tools are `get_project`, `get_rules`, `get_spec`, `get_skill`, `run_check`, `acknowledge_warning`, `doctor`, `setup_project`, and `upgrade_project`.

- `get_project` carries the warning as `version` (§8.1), so the first call of a session names the fix.
- `run_check` and `mindplan-mcp check` fail with the same `Blocked: Version — <warning>` line and run no other check, since the code may misread a graph it does not understand (§9.6).
- `setup_project` is Blocked in `upgrade` and `server-behind`. `upgrade_project` is Blocked in `server-behind`, and in `setup` when `mindplan/` does not exist (§8.2).
- `MINDPLAN_VERSION_GATE=off` turns the gate and the check's version failure off for one process (test fixtures that build a graph without a stamp), as `MINDPLAN_ORIENT_GATE=off` does for the orientation gate (§8.1.2).

**Legacy file names and folders.**

- A live file named `current.mdx` is read and written in place until `upgrade_project` renames it. When a legacy name and its id name are both regular files in one folder (`current.mdx` and `<id>.mdx`, or `next.mdx` and `<id>.next.mdx`), the server MUST delete the legacy file and keep the id-named one. It MUST NOT do so when both names are the same directory entry (id `current`, or a case-only difference). Each deletion is reported: MCP tool results list it in `removed_legacy_files` and, when present, `changed_files`; `check` and `view` print `Removed <legacy> (kept <id-named>)` on stderr.
- A Capability live file that says `type: Journey` fails to load: `Blocked: type "Journey" in <file> is the old name of Capability. Call upgrade_project, which rewrites it, then commit the upgrade on its own.`
- The store never loads an evolution file (`<id>.next.mdx` or `next.mdx`, with its `next-attachments/`) as a revision; the gate reports it as above and `upgrade_project` moves it (level 4). A live file named `next.mdx` because the id is `next` is not an evolution file. A leftover `state: mirror` next file is not a revision either: the check warns about it (§9.6) and `upgrade_project` removes it.
- A `mindplan/config.json` that still has `implementation_packages` is `Blocked:` (§1.2.1).

**Migrations.** Every migration MUST be idempotent, so `upgrade_project` runs all of them on every call: a graph already at the level is left as it is, and a node a stale branch merged in an older format is converted by the next call. They run in the order below; each names its key in the `migrations` result (§8.2).

- **Level 3 — Capability folders** (runs first, before any graph load). Every `mindplan/journeys/<id>/` that holds a live file moves, attachments included, to `mindplan/capabilities/<id>/`. Before the move, `type: Journey` in its live file becomes `type: Capability` and the old `create_node` scaffold stubs are replaced by the current ones; every run applies that rewrite to every `mindplan/capabilities/<id>/` live file, so a folder moved by hand is repaired. Ids and other body text are kept. `journeys/` is removed once it holds nothing but `.gitkeep` files and empty folders. An id present in both folders is `Blocked:` naming both paths, after the moves made before it. Key: `capabilitiesMoved` (ids, sorted).
- **Level 1 — base conversions:**
  - File names: inside each node folder, before any graph load, `current.mdx` becomes `<id>.mdx` and `next.mdx` becomes `<id>.next.mdx`; when both names exist, the legacy file is deleted. Any evolution file under `capabilities/` or `bugs/` (`next.mdx` or `<id>.next.mdx`) stops the upgrade before any rename and names the file to fix by hand. A rename the filesystem rejects stops the upgrade, names the file, and lists every rename or removal already applied in that call. A same-file pair (id `current`, including case-only folder names) is left in place. Key: `territoryFilenames`.
  - Config: `implementation_packages` becomes `{ sources, exclude }` (§1.2.1), seeding `implements` and Foundation `role`. Key: `config` (`{ migrated, sources, seeded_implements, seeded_roles }`).
  - Atomic Ops left on shipped nodes are removed (§3.3). Key: `atomicOpsDropped`.
  - Leftover `state: mirror` next files are deleted (§3.6). Keys: `mirrorTwinsRemoved`, `mirrorTwinSkips`.
  - Shipped Foundations, Interactions, and Interfaces that lack `revisions` / `churn` (and split fields) get them from git history (§5.15). Keys: `revisionsBackfilled`, `splitsFound`.
  - `mindplan/agent/` (copies of the playbook, skills, integrations, and MCP example) is deleted; the server serves these itself (§1.1.1). Key: `agentFilesRemoved`.
- **Level 2 — change labels.** The `change` and `change_ref` scalars are removed from the live file of every shipped, active Foundation, Interaction, or Interface, with or without open revisions; only a revision carries a change id (§3.7). Key: `staleChangeLabelsCleared` (`{ node_id, change }` each).
- **Level 4 — revision folders, decision files, ignored map** (§3.6, §6.1.2):
  - Every `<id>.next.mdx` (or `next.mdx`) of a Foundation, Interaction, or Interface moves to `revisions/<change>/<id>.mdx`, `<change>` being the file's `change`, else `rev-<id>`. Its edges, claims, and tests become add/remove deltas from the live file; its scalars, state, dates, `change_ref`, `attributed`, and `split_into` are kept; `base` hashes the live file as the decision split below leaves it, so the moved revision holds no conflict. Its body loses `## Rules` and `## Decisions`; each of its decisions the live file does not hold is copied verbatim to `revisions/<change>/decisions/<id>.md`. `next-attachments/` (except `.gitkeep`) moves to `revisions/<change>/attachments/`, the revision file is written atomically (last but one), and the next file and `next-attachments/` are deleted. A `state: mirror` leftover is skipped. A stopped run resumes: a `revisions/<change>/` with no revision file, or with exactly the file this move writes, is finished; one holding a different revision, an invalid change id, or a `###` entry whose id does not parse is `Blocked:`. Key: `revisionsMoved` (`{ node_id, change }` each).
  - Every live file's `## Decisions` section is split into `decisions/<id>.md` files, each entry's raw text copied verbatim (from its `###` heading to the next heading of any level) and removed from the body; every other byte and the line endings are kept. A decision file already holding the same entry is kept; one holding another entry is `Blocked:`, and so is a `###` entry whose id does not parse or that has no `- Decision:` line. Key: `decisionsSplit` (`{ node_id, count }` each).
  - `map.md` is added to `mindplan/.gitignore` (created when missing) and, inside git, untracked with `git rm --cached` (the working copy stays). Key: `mapIgnored` (true when this run changed the ignore file or the index).

Commit the upgrade on its own, the untracked `mindplan/map.md` included.

#### 1.1.3 Graph cache (`.mindplan-cache/graph.db`)

The server caches parsed node records, in memory per process and in `.mindplan-cache/graph.db` at the project root (Node's built-in `node:sqlite`; memory only where that is unavailable). The cache is derived: the `.mdx` files stay the only source of truth.

- **Freshness.** A load MUST return what parsing every file would return. Each node folder's records are re-checked against git status or file stamps (name, size, mtime), and a folder whose files change during its parse is not cached. Like git's own stat check, the cache cannot see an edit that keeps a file's size and restores its old mtime, nor, when it relies on git status, edits to files marked `assume-unchanged` or `skip-worktree`.
- **Invalidation.** A server reads only records its own build parsed, and a cache schema change drops every record. A corrupt file is deleted and rebuilt; any other open failure leaves the cache in memory only.
- **Outside the graph.** Like the search cache (§8.1.1), `.mindplan-cache/` is gitignored, never in `changed_files`, never part of the coverage universe, and safe to delete. It also holds `acks.json`, the warning ids `acknowledge_warning` stored for this checkout (§8.2), so deleting the folder also clears acknowledged warnings and they show again.
- `MINDPLAN_GRAPH_CACHE=off` turns the cache off for one process; `git` or `stamps` forces freshness checks through git status or file stamps only.

### 1.2 Declared file ownership

Interaction, Interface, and Foundation nodes declare the files they own in server-owned frontmatter `implements: string[]`, written only by `set_implementation_files`. Entries are repo-relative POSIX paths: exact files, directories ending in `/` that own everything beneath, or **glob claims**. Queries and `check` expand directories and globs to the files on disk. Paths MUST NOT contain `..` or lie under `mindplan/`. `.gitkeep` is ignored.

**Glob claims.** An entry containing `*`, `**`, or `?` is a glob. `*` and `?` match within one path segment; `**` matches any depth. `[` and `]` are literal, so App Router folders such as `[slug]` are plain paths. A glob ending in `/` owns every file beneath each matching directory: an Interaction that owns its views in every template claims `src/templates/*/actions/i-read-post/`. A glob exists on disk (presence, §9.6) when it matches at least one file. Exclusivity is judged per expanded file, glob or not. `get_node_implementation` lists the files a glob expands to, and a path lookup finds its owner through a glob.

| Node type | Ownership |
|---|---|
| Interaction | Declared files — domain/view-model **and** the exportable surface (UI: mountable view; CLI/MCP/Webhook/Cron: handler) |
| Interface | Declared files — mounts/wires Interactions; MUST NOT own screen bodies or core domain |
| Foundation | Declared files — shared substrate by `role` (assembler, infra, design-system, adapter) |
| Capability | *(none)* — architecture is the union of member Interaction files plus Interfaces that expose them |
| Bug | *(none)* — fixes land in affected targets' files |

Rules:

- Before `in-review` / `ship`, the claim list being judged (live, or live with the revision's delta) MUST be non-empty and every entry MUST exist on disk. While building, `implements` may name paths that do not exist yet.
- A revision holds its claims as a delta against live (`implements_add` / `implements_remove`, §6.1); its claim list is live with that delta applied, and `ship` writes it to live. A live entry is **released** under change C when C's revision removes it (another owner may claim it under C). Retired nodes (`cancelled`/`deprecated`) may only shrink their list.
- **Exclusivity.** A file has at most one owner in live, and at most one in each change's view (live plus that change's revisions, §3.6). Two claims on one file in the same view conflict, and `set_implementation_files` rejects the second.
  - A claim belongs to a change when it is a revision of that change or a pre-ship member of it. Two claims are judged in live when neither belongs to a change, and in change A's view when they belong to A and to A or to no change. So a pre-ship member may take a file its change's revision drops from a shipped node, and a node of no change that claims a member's file conflicts at the member's gate.
  - A node's gate judges it in its own view only (its change, or live for a node of no change). Another change's pending claim never Blocks it; the check reports that conflict under the other change.
  - Claims of different changes (pre-ship members, or revisions whose node does not claim the file live) may overlap. The check only warns: `ownership: "<file>" is claimed by "<a>" (revision "<c>" | change "<c>") and "<b>" (…)`. Whichever ships second meets the first one's live claim: a claim conflict when both are revisions of one node (§3.6), otherwise its exclusivity gate at `in-review` / `ship`.
  - At `ship`, the node's claims after the ship are judged against every other shipped node's live claims: a node may not ship onto a file another node claims live. When that other node has an open revision of the shipping node's change that drops the file, the Block says to ship the whole change in one walk or that revision first. A scoped walk (§3.7) writes nothing unless every step passes and judges the other nodes it ships by their claims after the walk, so a file moved between them ships in any order; a file two of them still claim at the end is `Blocked:` naming both. A single move and a `revisions` batch are judged against live.
- **In-place additive claims.** A shipped node's live list changes only through a revision (`open_next`), except an **additive** change that `set_implementation_files` writes in place (§8.2). A folder F is **dominated** by node N when:
  1. N's live claims include at least one existing file directly in F, and
  2. no other non-retired node claims F, claims a path under it, or covers a path under it (directory or glob), live or in any open revision.

  A change is additive when:
  1. every old entry is kept or covered by a new directory entry,
  2. each new entry is an exact file whose parent folder N dominates, or a directory `F/` that N dominates, and
  3. no new entry reaches a migration or schema file (config `decisions.schema_files`, §1.2.1): an exact file that matches, or `F/` where F is a schema folder or holds a matching file. Such a claim is decision-worthy (§5.13), and only a revision reaches the decision gate.

  Anything else (removing or moving a claim, a glob, a path outside a dominated folder, a schema entry) is `Blocked:` → `open_next`. Entries added in place are listed in the live file's `added_claims` (§6.1) until the body names them.
- *Rationale (non-normative):* a new file in a folder nobody else can own is a neighbor change (files change, behavior doesn't, §3.7), not a contract change; without the in-place path, agents would split related code across folders for ownership reasons.
- Agents MUST implement only in files their node claims. Cross-cutting reuse goes through Foundations, never an Interaction → Interaction `depends_on` (§2.2, §5.10). Agents find files with `get_node_implementation` and with `get_blast_radius`'s `affected_files` (§8.1).

#### 1.2.1 Source universe (`mindplan/config.json`)

```json
{
  "sources": ["src/**"],
  "exclude": []
}
```

- A missing config means `sources: ["src/**"]`, `exclude: []`. A brownfield project may start with `sources: []` and widen it over time.
- **Validation (all keys).** A present config MUST be a JSON object with `sources` and `exclude` arrays. Every settings block below is optional; an absent field in a block takes its default, and a config without the block is written back without it. Invalid JSON or shape, a missing `sources` or `exclude`, an unknown key or an invalid value inside a settings block, or a lingering `implementation_packages` key (convert it with `upgrade_project`, §1.1.2) makes the config invalid: loading it fails with `Blocked:`, and the check fails at once (§9.6). Any other top-level key is ignored. Agents change the config only with `patch_config` (§8.2), which rejects an unknown key inside a settings block rather than ignoring it.
- Default `mindplan-mcp check` enforces exclusivity, coverage, presence, leftovers, and the import matrix over the universe plus every claimed file; opt-in `--base` adds the dirty-src lifecycle (§9.6).

| Block | Key (default) | Valid value | Meaning |
|---|---|---|---|
| `decisions` (§5.13) | `blast_radius` (`5`) | non-negative integer | Dependents above which a revision is decision-worthy |
| | `schema_files` (`**/migrations/**`, `**/migration/**`, `**/*.prisma`, `**/schema.sql`, `**/structure.sql`, `**/db/schema.rb`) | list of non-empty globs | Migration and schema files a revision may not claim without a decision. The default matches database migrations and schema dumps only, so JSON Schema, zod, or GraphQL modules named `schema` do not gate a change; widen the list to include them |
| `hotspots` (§5.15) | `half_life_days` (`30`) | positive number | Days a node's recent ship rate takes to fade by half |
| | `outlier_ratio` (`3`) | positive number | Multiple of the graph's median rate that makes a node an outlier |
| | `min_rate` (`2`) | positive number | Lowest rate that can be an outlier |
| `fan_out` (§5.15) | `warn_at` (`3`) | positive integer | The check warns `fan-out:` when a pre-ship node's `depends_on` reaches at least this many other unshipped changes |
| `search` (§8.1.1) | `enabled` (`true`) | boolean | `false` turns semantic ranking off; keyword ranking always runs |
| | `model` (`Xenova/bge-small-en-v1.5`, English) | non-empty string | The transformers.js embedding model |

**Coverage.** Every file in the universe (`sources` minus `exclude`, git-visible, untracked included) MUST be claimed live or in an open revision of a non-retired node. An unclaimed file is `Blocked: Coverage: …`, naming the probable owner and the exact fix. The probable owner is the node whose claim shares the longest directory prefix with the file; a file two or more folders deep needs at least two shared folders, so sharing only `src/` names no owner. The fix is `set_implementation_files({ node_id, add: [file] })` on that node (with `change` naming its open revision when it has one), preceded by `open_next({ node_id, change })` when the owner is shipped with no open revision and either does not dominate the file's folder (§1.2) or the file is a migration or schema file; in a dominated folder the claim alone is the fix. When a node claims an exact file in the unclaimed file's folder, that node is the owner the fix names. When none does, the line leads with the planning duty instead: `No node has a file in its folder. A new behavior is a new node: create_node(…), link it, then set_implementation_files(…)`, followed by `If it extends "<owner>" instead: <fix>` when an owner exists. A retired node's claim covers nothing; such a file is reported once, by the leftovers rule (§9.6), not again as Coverage.

#### 1.2.2 Ownership split (Interaction owns the body; Interface mounts)

**Interaction owns the behavior surface. Interface only mounts or wires it.**

- **Interaction** owns domain logic, view-model, and the exportable surface. It MUST NOT own app routing, device/staff shell chrome, or cross-Interaction navigation.
- **Interface** owns routes/entry, providers, guards, thin mounts/wiring, shared shell chrome, and nav callbacks. It MUST NOT reimplement behavior that belongs in an `exposes` target.
- **One Interface per actor surface**, not one Interface per screen or tab.

**Import matrix.** A node's files may import another node's files only as below, judged in the view being checked (live, or live plus a change's revisions). Every other such import is illegal; the check and the `in-review` / `ship` gate (§5.10) report it with its fix (§9.6).

| Importer | May import files owned by |
|---|---|
| Interaction | Foundations it reaches through `depends_on` |
| Interface | Foundations it reaches through `depends_on`; Interactions it `exposes` |
| Foundation | Foundations it reaches through `depends_on`; Interfaces it `mounts`; if it is an Assembler, Interfaces and Interactions that `depends_on` it |

"Reaches through `depends_on`" is transitive, but the walk stops at an Assembler: a node reaches the Assembler, not the Assembler's own dependencies.

- **Assembler (implicit).** A Foundation whose role is `assembler` (frontmatter `role`, or a description starting with `Assembler`, §2.0.1) is a composition root for its dependents: it may import any Interface or Interaction that `depends_on` it, with no edge of its own.
- **Composition root (`mounts`, explicit).** Any Foundation may import exactly the Interfaces it `mounts` (§2.2). Use it for a module whose job is to import several Interfaces (a template registry, a route dispatcher, a redirect list) when the Assembler rule does not apply. `mounts` permits those imports and nothing else: it adds no `depends_on`, does not make the Interface depend on the Foundation, and does not gate ship.

  *Multi-template example.* A platform ships two site templates, each its own Interface (`if-template-a`, `if-template-b`; each `exposes` the shared Interactions and `depends_on` the Foundations it uses). One module, `src/foundations/f-registry/registry.ts`, imports both Interfaces to build the route dispatcher. Claim it on Foundation `f-registry` and link `f-registry -mounts-> if-template-a` and `f-registry -mounts-> if-template-b`. `set_implementation_files` on the registry returns the two `link_nodes` calls while the edges are missing; with both edges `check` passes; with only one, the other import stays Blocked.
- **Test files.** A test exercises its node where it is wired in. A file that node A's `tests` list covers (§6.1) **and** that looks like a test (a `*.test.*` or `*.spec.*` file name, or a `__tests__`, `test`, or `tests` path segment) MAY import files owned by A and by A's **direct dependents** (nodes with a `depends_on`, `exposes`, or `mounts` edge to A in the view being judged) with no edge of its own. Any other import from it follows the matrix. The check and the `in-review` / `ship` gates apply the same rule.

**Build order (per exposed Interaction):** Interaction `in-progress` → implement and declare files → only then the Interface's thin mount/wire.

#### 1.2.3 Shared app routes (Assembler vs template Interface)

A product with several templates (site themes, white-label shells) often has routes that exist for every template, for example `app/sites/[site]/[lang]/blog/*`. One route family has one owner:

- **The Assembler owns routes that dispatch to whichever template is active.** A template-agnostic route reads the active template and renders its Interface (through `mounts`, §1.2.2); that is composition, so it belongs to the Assembler Foundation.
- **A template's Interface owns only routes that exist for that template alone.**

A **router root** is an `app/` folder (at any depth) holding a root `layout` file, directly or in a route group (`app/(site)/layout.tsx`); an `app/` folder without one is not a router. A **route family** is a route folder below a router root, cut after its last static segment: the route files (`page`, `route`, `layout`, `template`, `loading`, `error`, `not-found`, `default`) of `app/sites/[site]/[lang]/blog/page.tsx` and `app/sites/[site]/[lang]/blog/[slug]/page.tsx` form one family, `app/sites/[site]/[lang]/blog/`. Dynamic (`[x]`), group (`(x)`), and slot (`@x`) segments do not start a new family. The check warns (§9.6), and never Blocks, when one family's route files have more than one owner; the warning names each owner and the rule.

### 1.3 Screaming architecture

A glance at the territory MUST scream what the product *is*, not which frameworks or delivery mechanisms it uses (types: §2, §2.0.0):

| Layer | Screams |
|---|---|
| **Capabilities** | What the product does |
| **Interactions** | Behaviors the system performs (initiated by any actor) |
| **Interfaces** | How actors enter those behaviors |
| **Foundations** | Shared substrate at the edges |
| **Assembler** | Foundation role that composes Capabilities + Interactions + Interfaces + Foundations into a deployable surface |

Tech layers (`Frontend`, `API`, `Database`) MUST NOT be Capabilities. Delivery mechanisms (pages, CLIs, MCP tools, webhooks, crons) are **Interfaces**, not Interactions.

### 1.4 Roadmap (not implemented)

Symbol-level mapping inside a file is out of scope. File ownership through `implements` (§1.2) is the unit that architecture queries and the check work on.

---
## 2. Entity Taxonomy

The build taxonomy (Capability, Interaction, Interface, Foundation) is kept apart from the defect layer (Bug). It is Interaction-first (screaming architecture): Capabilities name what the product does, Interactions name self-contained behaviors, Interfaces name how actors enter them, and Foundations hold the shared substrate that keeps behaviors independent of each other. The graph tracks architecture and delivery together.

The type names are the vocabulary in tool calls, in prose, and with the user. README, playbook, map legend, and skills MUST use them and no synonym for a type (no "area", "action", "entry point", or "building block").

| Entity | Definition | Routing rules |
|---|---|---|
| **Capability** | A business capability: what the product does, as a permanent boundary for related behaviors ("Table Ordering", "Billing", "Agency Site Generator"). The set of Capability titles is the product's scream. A continuous container, not a closable epic, sprint, or technical layer. | MUST be named in domain language. MUST NOT execute code. MUST NOT have outgoing edges. State is computed, never set (§4). |
| **Interaction** | A self-contained behavior initiated by any actor: user, system, scheduler, external service, CLI, or MCP client ("Split the check", "Check integrity", "Process payment webhook payload"). Not a page, route, CLI, MCP toolset, or other surface; those are Interfaces. For a UI behavior the Interaction package owns the screen body (domain + mountable view); for CLI, MCP, webhook, or cron it owns the handler the Interface wires. | MUST `belongs_to` one or more Capabilities and `depends_on` at least one Foundation. MUST NOT `depends_on` another Interaction (§5.10). MAY `leads_to` other Interactions. MUST NOT import Interface packages. Agents MUST define the Capability first: when a requested Interaction maps to no existing Capability, the agent MUST refuse and ask the user to define the Capability. Size test (guidance): one actor goal, nameable as verb + object without "and", shippable on its own. |
| **Interface** | How an actor enters one or more Interactions. One Interface per actor + delivery mechanism (Waiter POS, console web app, MCP tools, CLI), not per page, tab, command, or tool: those are routes it mounts. Grain test (guidance): would a user call it a different app or channel? Kinds: Page, CLI, MCP, Webhook, Cron, Script. Full build pipeline; claims its files via `implements`. | MUST `exposes` at least one Interaction before leaving `draft` (§5.3). MAY `depends_on` Foundations. MUST NOT `belongs_to` a Capability. Mounts or wires Interaction packages; MUST NOT own core domain logic or screen bodies. Ship is gated by Behavior First (§5.5). |
| **Foundation** | Shared substrate with no standalone behavior: infrastructure and reusable product platform, sorted by role (§2.0.1). Examples: app shell, database schemas, auth, Stripe SDK, design tokens. | Consumed by Interactions, Interfaces, or other Foundations via `depends_on`; MAY `depends_on` other Foundations. Gates the ship of the Interactions and Interfaces that depend on it (Infrastructure First, §5.4; Behavior First, §5.5). Shared state between Interactions MUST live in Foundations. MUST NOT own stakeholder-recognizable behavior. Not a Capability member. |
| **Bug** | A defect in one or more Interactions, Interfaces, or Foundations. | MUST link its targets via `affects`. Own lifecycle (§3.2). Does not count in Capability states. |

### 2.0.0 Type glossary (non-normative)

| Type | Question | Example |
|------|----------|---------|
| **Capability** | What does the product do? | Billing |
| **Interaction** | What can someone do? | Split the check |
| **Interface** | Where do they do it? | Waiter POS, CLI, MCP tools |
| **Foundation** | What does it all run on? | Database, design system, Stripe |
| **Bug** | What's broken? | Double charge on split |

#### Established equivalents (non-normative)

Each type and edge is close to a term from established software architecture. The tables name that term so a reader can map the type onto what they already know, then say where MindPlan differs. They are an anchor, not a list of synonyms: tool calls, prose, and conversation still use the type names only.

| Type | Closest established term | Where MindPlan differs |
|---|---|---|
| **Capability** | Business capability (business architecture); bounded context or subdomain (Domain-Driven Design) | Groups Interactions only. Holds no code, has no outgoing edges, and its state is computed from its Interactions (§4). An Interaction may belong to several. |
| **Interaction** | Use case (UML; the use case interactor of Clean Architecture); a feature | One actor goal, shippable on its own. It owns its body, including the screen for a UI behavior, and never depends on another Interaction. |
| **Interface** | Primary (driving) adapter (hexagonal architecture); a C4 container for an app, API, CLI, or channel | One per actor and delivery mechanism, not per page or command. It mounts Interactions and owns no domain logic or screen bodies. |
| **Foundation** | By role: composition root (Assembler); infrastructure or shared kernel (Infra); UI component library (Design system); secondary (driven) adapter or anti-corruption layer (Adapter) | Shared substrate with no standalone behavior. An Interaction that needs it ships only once it is ready for dependents (Infrastructure First, §5.4). |
| **Bug** | Defect, as in an issue tracker | The one type that records work rather than structure. It reaches the graph through `affects` and inherits the rules of the nodes it affects. |

| Edge | Closest established term | Where MindPlan differs |
|---|---|---|
| `belongs_to` | Membership of a use case in a capability or bounded context | Only Interaction → Capability. |
| `depends_on` | A dependency on a port or infrastructure module; a C4 "uses" relationship | Targets Foundations only, stays acyclic, and gates ship. |
| `exposes` | A driving adapter invoking a use case | Only Interface → Interaction; the Interface ships after what it exposes (Behavior First). |
| `mounts` | Composition-root wiring (dependency injection) | Only Foundation → Interface; it licenses imports and gates nothing. |
| `leads_to` | A step in a user flow or a navigation transition | Only Interaction → Interaction; cycles are allowed and it gates nothing. |
| `affects` | A defect linked to the component it breaks | Only Bug → Interaction, Interface, or Foundation. |

### 2.0 Classification litmus (agents)

Agents MUST classify new work by the first check that matches (definitions: the entity table, §2):

1. Something the product does, named in domain language → **Capability**
2. A self-contained behavior an actor initiates → **Interaction**
3. How an actor enters an Interaction → **Interface**
4. Shared code or UI with no standalone behavior → **Foundation**, then its role (§2.0.1)
5. Broken behavior on an existing node → **Bug**

Examples (guidance):

- Design tokens, a primary button, a dumb combobox → Foundation, Design system role.
- Next.js, Vercel Cron, or Supabase Functions app shell → Foundation, Assembler role; not a Capability named "Frontend".
- Stripe, Resend, or Slack SDK wrappers → Foundation, Adapter role; checkout and billing behavior stays in Interactions.
- "Split the check" → Interaction `i-checkout-split`, owning domain and mountable view; the phone page that hosts it → Interface `if-checkout-page`, which `exposes` it and only mounts the view.
- A user-picker search/select flow → Interaction (its view in the Interaction package), exposed from the existing POS Interface rather than a new Interface per screen.
- MCP tools → one Interaction per behavior (orient, assess impact, change status, shape the graph, …) owning its handlers and tool definitions; one Interface `if-mcp-tools` mounts them.
- A POS with floor, checkout, and pickup tabs, or a console web app with several pages → one Interface exposing many Interactions. A behavior reached from both MCP and the console is one Interaction with two `exposes` edges, not two Interactions.

### 2.0.1 Foundation roles

Every Foundation has one **role** in its frontmatter `role` field: `assembler`, `infra`, `design-system`, or `adapter`. Roles are not node types or edge types. `create_node` requires `role` for a Foundation and starts the description with the matching tag (`Assembler`, `Infra`, `Design system`, `Adapter`, e.g. `"Infra — …"`) when it does not already start with one; `patch_node_territory` changes it before first ship or in a revision (a revision that removes it records `role_removed: true`, §3.6). When `role` is absent, a description that starts with a role tag gives the role. Two rules read it: the import matrix, where an Assembler is the composition root (§1.2.2), and Minimum Territory Shape, which requires a role or role tag on every Foundation (§6.5).

| Role | Owns | Examples |
|------|------|----------|
| **Assembler** | The external framework or runtime that composes Interactions and Interfaces into a deployable surface: entrypoints, mount conventions, env and deploy constraints | `f-nextjs`, `f-vercel-cron`, `f-supabase-functions` |
| **Infra** | Persistence, messaging, storage, compute plumbing, observability, and shared state | `f-db`, `f-queue`, `f-blob-store`, `f-otel` |
| **Design system** | Tokens, typography, theme, layout primitives, and dumb presentational UI | `f-design-system`, or `f-tokens` + `f-ui-kit` |
| **Adapter** | Third-party SDKs and protocol wrappers at a boundary | `f-stripe`, `f-resend`, `f-slack-api` |

No role owns product behavior or screen bodies (Interactions) or entry wiring (Interfaces).

Choosing a role (guidance): Assembler only for a runtime that composes and runs nodes (app framework, cron host, function host); Adapter for a vendor or protocol boundary; Design system for visual language and dumb UI; otherwise Infra, including docs, CI config, and other misfits. Auth is Infra (`f-auth`) unless it is a vendor adapter (`f-clerk`). When unsure between Assembler and Infra, choose Infra. Agents MUST NOT invent hybrid tags such as `"Assembler/docs"`.

Assemblers (guidance): different Capabilities MAY run on different Assemblers. Interactions and Interfaces that run on one SHOULD `depends_on` it; this is not a gate (Rule 1 needs any Foundation). A Capability's assemblers are derived from its members' `depends_on`; the Capability still has no outgoing edges.

### 2.1 Node identifiers

Node ids MUST match `^[a-z0-9][a-z0-9-_]*$` and are unique across all types. Recommended prefixes by type: `c-`, `f-`, `i-`, `if-`, `bug-` (e.g. `c-ordering`, `f-db-core`, `i-checkout-split`, `if-mcp-tools`, `bug-race`).

**Naming (guidance):** the `title` is the stable name: a verb phrase for an Interaction ("Split the check"), a short noun phrase otherwise. The `description` says what the node is or does now. What changed in this PR belongs in the revision body or Atomic Ops, never in `title` or `description`.

### 2.2 Edge taxonomy

There are six edge types. An edge is a directed triple `(source, target, type)`. There is no version-lineage edge: a node evolves in place under its stable id (§3.6).

| Edge type | Legal shape | Meaning |
|---|---|---|
| `belongs_to` | Interaction → Capability | Membership. An Interaction MAY belong to several Capabilities. |
| `depends_on` | Interaction → Foundation, Interface → Foundation, Foundation → Foundation | Shared substrate. Gates an Interaction's or Interface's ship (§5.4, §5.5). Foundation → Foundation gates no ship; it decides whether the dependent Foundation is ready for dependents (§5.4). |
| `exposes` | Interface → Interaction | Entry: how an actor reaches the Interaction. Gates the Interface's ship (§5.5). |
| `mounts` | Foundation → Interface | Composition root: the Foundation may import the Interface's files (a registry or dispatcher, §1.2.2). Gates nothing; adds no dependency. |
| `leads_to` | Interaction → Interaction | Navigation hint only. Gates nothing; not an implementation dependency. |
| `affects` | Bug → Interaction, Bug → Interface, Bug → Foundation | Defect. Open Bugs make a shipped target `unstable` (§3.5). |

Link validation (§5.10):

- Every other shape is `Blocked:`. A Capability has no outgoing edges.
- No self-links (`source == target`), for every edge type.
- No duplicate edges (same source, target, and type).
- The `depends_on` subgraph MUST stay acyclic; a cycle is rejected at link time. `leads_to` MAY cycle and is never cycle-checked.
- **Interaction Independence:** an Interaction never `depends_on` another Interaction; shared state goes through a Foundation.

While the source has an open revision, an edge write from it goes to that revision's add/remove deltas (the revision of `change`, or the only open one), not to the live `<id>.mdx` edge arrays (§3.6, §8.2 `link_nodes`). Live keeps serving its edges until the revision ships.

---

## 3. State Machines

### 3.1 Build pipeline (Foundation / Interaction / Interface)

| # | State | Meaning |
|---|---|---|
| 1 | `draft` | Ideation; scope written in `<id>.mdx`, or in a revision file while a shipped node evolves (§3.6) |
| 2 | `ready` | Pre-flight passed (Interaction: Capability + Foundation linked; Interface: at least one `exposes`) |
| 3 | `in-progress` | Being built; Atomic Ops checked off |
| 4 | `in-review` | Build finished; may `ship` once Rules 1–6 and the Completion Check allow |
| 5 | `stable` / `unstable` | Computed production posture, entered via `ship`, never set manually (§3.5) |
| 6 | `cancelled` | Abandoned before ship; terminal |
| 7 | `deprecated` | Retired after ship |

| From \ To | draft | ready | in-progress | in-review | stable/unstable | cancelled | deprecated |
|---|---|---|---|---|---|---|---|
| **draft** | — | ✔ | ✘ | ✘ | ✘ | ✔ | ✘ |
| **ready** | ✔ | — | ✔ | ✘ | ✘ | ✔ | ✘ |
| **in-progress** | ✘ | ✔ | — | ✔ | ✘ | ✔ | ✘ |
| **in-review** | ✘ | ✘ | ✔ | — | ✔ | ✔ | ✘ |
| **stable/unstable** | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✔ |
| **cancelled** | ✘ | ✘ | ✘ | ✘ | ✘ | — | ✘ |
| **deprecated** | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | — |

**Ship.** `update_node_status(..., "ship")` from `in-review` sets `shipped_at` and computes `stable` or `unstable` (§3.5); there is no manual `active` state. `Blocked: Infrastructure First` (§5.4) or Behavior First (§5.5) holds production entry until the dependencies are ready; it is a compiler gate, not a quality verdict. A change's nodes advance in one ordered `update_node_status` call (§3.7).

**No reviewer.** The agent that builds a node MAY move it to `ready` and `ship` it (Bug: `resolved`) itself, when the transition is legal, Rules 1–6 allow, and the default check is green (§9.6). MindPlan requires no human review, Reviewer agent, approval protocol, PR approval, CI, or code-quality judgment: review is outside the dialect. A project MAY add such gates through host tooling or its standing rules in `mindplan/project.md` (§1.1.1).

**Readiness reset.** `ready` is a judgment about a contract. A contract write to a slot in `ready` — `<id>.mdx` of a pre-ship node, or the open revision the write goes to — moves that slot back to `draft`, and the result says so: the new `state` / `next_state` plus `readiness_reset: { slot, from: "ready", to: "draft", note }`. Self-ready it again after reviewing the changed contract.

| Write | Resets a `ready` slot |
|---|---|
| `patch_node_territory`: `title`, `description`, `role`, `body`, `section`, `replace`, `toggle_checkboxes` | Yes |
| `set_implementation_files` | Yes, when the claim list changes (re-sending the same list does not reset) |
| `link_nodes` / `unlink_nodes` (the source node's written slot) | Yes |
| `patch_node_territory` with only `change` / `change_ref`; `change` on `set_implementation_files` or `record_decision` | No — grouping metadata, not contract |
| `patch_node_rules` | No — rules are standing constraints, not the contract |
| `put_attachment` / `remove_attachment` | No |
| Any write to a slot in `draft`, `in-progress`, or `in-review` | No — ticking finished work and matching the territory to the code is how a revision completes |

**Cancel.** `update_node_status(..., "cancelled")` abandons a Foundation, Interaction, or Interface that never shipped (from `draft`, `ready`, `in-progress`, or `in-review`). It is `Blocked:` while any active node (not `cancelled`, `deprecated`, `resolved`, or `wontfix`) `depends_on` it, live or in an open revision; for an Interface, while an active Foundation `mounts` it; and while a shipped node relies on it (a `stable`/`unstable` node that `depends_on` it, or a shipped Interface that `exposes` it, §5.4). An unshipped Interface that `exposes` it does not block. Packages and territory folders stay on disk. There is no uncancel.

**`force_unship` (Rule 11, §5.12).** The one exception to the table: it clears `shipped_at` and moves a `stable`/`unstable` Foundation, Interaction, or Interface back to `draft`, `ready`, `in-progress`, or `in-review`, only with `confirm: "unship:<node_id>"` after explicit human confirmation. It is recovery from a mistaken ship and MUST NOT replace `open_next`.

### 3.2 Bug lifecycle

| State | Meaning |
|---|---|
| `open` | Reported; repro in `<id>.mdx` |
| `triaged` | Validated; linked via `affects`; severity optional |
| `fixing` | Fix in progress |
| `in-review` | Fix awaiting `resolved` (no review required, §3.1) |
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

An Atomic Operation is a PR-sized unit of work: a Markdown task-list item (`-`, `*`, or `+`, then `[ ]` open or `[x]` done) in `<id>.mdx`, or in a revision file of a shipped Foundation, Interaction, or Interface (§3.6). Checkboxes are parsed at validation time from the file being judged; the file on disk, not the graph, is the source of truth. Only Markdown task-list syntax counts: JSX is invisible to it (§6.4.4).

**Item ids and kinds.** Every checkbox the Completion Check counts (§5.6: the whole body except sections other writers own, such as `## Rules` and `## Decisions`, and lines inside a fenced code block) is a checklist item. It MAY end, before any annotation, with a tag `{#<id>}` or `{#<id> <kind>}`. The id is a lowercase slug (`a-z`, `0-9`, hyphens), unique in the slot and stable when the wording changes. The kind says who closes the item: `build` (the default, the agent building the node), `review` (a person reviewing it), or `deploy` (a person deploying it). The default items `create_node` and `open_next` write carry the ids `spec`, `impl`, and `verify`; a `review` or `deploy` item added without an id gets one slugged from its text:

```markdown
- [ ] Spec written {#spec}
- [x] Implementation complete {#impl}
- [ ] Verified in target environment {#verify}
- [ ] Legal signs off the copy {#legal-copy review}
```

`toggle_checkboxes` (§8.2 `patch_node_territory`) ticks an item by `id` or by its exact text (tag and annotation excluded, whitespace trimmed). A text that is not exactly one item's (a substring included) is `Blocked:` and lists the items; a text several items share is `Blocked:` unless the call passes `all: true`. `add_checklist_items` appends unticked items, with their tags, to the slot's first checklist section.

A `review` or `deploy` item waits on people: `run_check` lists the open ones in one `Info: waiting on people: …` line and `orient_for_work` in `open_items` (§8.1), and the agent reports the wait instead of ticking the item. Kinds change which dependencies hold a ship (§5.4, §5.5), not the Completion Check (§5.6).

**Closing an item honestly.** An item done differently, or one that does not apply, is closed with an annotation, never reworded:

```markdown
- [x] Load test checkout — note: verified manually against staging
- [x] Migrate legacy orders — n/a: no legacy orders exist in this market
```

`toggle_checkboxes` writes these (`note`, `not_applicable`, §8.2) after the item's text and tag. Both count as complete; a `— n/a:` with no reason counts as open. Unticking removes the annotation; the item's own words never change.

**Only unshipped slots hold Atomic Ops.** A node shows its current state; git keeps the ledger a ship relied on. Every `ship` (first ship and a revision's) removes the Atomic Ops section (a Foundation's `## Checklist` too) from the shipped `<id>.mdx`; `## Rules` and every other section stay. `open_next` gives the revision a fresh list of unticked default items (the `create_node` defaults, §6.3), where the old section was or else before `## Rules` or `## Attachments`, so a revision never ships on the ticks of the node's previous ship. `force_unship` gives the live file the same fresh list. A Bug's Fix Checklist is never removed.

### 3.4 Bug initial state

Bugs are created in state `open`. All other node types start in `draft`.

### 3.5 Computed production states (`stable` / `unstable`)

After `ship`, a Foundation, Interaction, or Interface's `state` holds a computed production posture:

| State | Condition |
|---|---|
| `stable` | `shipped_at` is set and no **open** Bug `affects` this node |
| `unstable` | `shipped_at` is set and at least one open Bug `affects` this node |

An **open bug** is a Bug in `open`, `triaged`, `fixing`, or `in-review`. The posture is recomputed after Bug status changes, `affects` link/unlink, and `ship`, and is never set manually.

### 3.6 Versioning

A Foundation, Interaction, or Interface keeps its `id` for life. There is no successor node, no `supersedes` edge, and no relinking of dependents: the git history of `<id>.mdx` is the version lineage. A shipped node is never reset to `draft` in place (except by `force_unship`, §3.1) and never replaced by a new node. A pull request shows a node's change once, as the diff of `<id>.mdx`, because the merge gate (§9.6) ships every change before it merges.

**Terms.** A **revision** is one open, unshipped change to a shipped Foundation, Interaction, or Interface. It belongs to exactly one change id (§3.7) and is stored at `<node folder>/revisions/<change>/<id>.mdx` with `attachments/` and `decisions/` beside it. A node MAY hold several open revisions, at most one per change id. **Live** is the node's `<id>.mdx`. A revision's edges, claims, and linked tests are **deltas** (adds and removes) against live; its title, description, role, and body are its own text. The **effective node under change C** is live ⊕ C's revision: live with C's deltas applied and C's text in place of live's. A node with no revision of C is, under C, its live self. "The revision" in a call means the revision of the `change` the call names, or the node's only open revision when `change` is omitted; several open revisions and no `change` is `Blocked:` listing them. A pre-ship node has no revision folder: its `<id>.mdx` is its revision, and its `change` field (§3.7) names the change. Capabilities and Bugs never hold revisions.

**Files.** A shipped node is one file, `<id>.mdx`, plus one folder per open revision (created and deleted as Open, Ship, Discard, and Retire below say). Every live MCP write touches `<id>.mdx` alone; title, description, and role of a shipped node change only through a revision (on live they are `Blocked:`). A `<id>.next.mdx` with `state: mirror` is a leftover, not an open revision: the default check warns about it (`legacy:`, §9.6); `open_next`, `force_unship`, retiring the node (`cancelled` / `deprecated`), and `upgrade_project` delete it. Any other `<id>.next.mdx` is an evolution file outside `revisions/`: every gated tool is `Blocked: Version` until `upgrade_project` moves it into `revisions/<change>/` (level 4, §1.1.2).

**Open.** `open_next` MUST validate:

- the node exists and is type `Foundation`, `Interaction`, or `Interface`,
- the node is `stable` or `unstable` (shipped) — Capabilities, Bugs, and unshipped pipeline nodes MUST be rejected,
- `change` is given (a valid change id) — without it the call is `Blocked:` and names the retry,
- the node has no **open** revision of `change` — the rejection MUST name the change and point to editing it (pass `change`), shipping it, or `discard_next({ node_id, change })`; revisions of other changes do not block,
- every planned edge of `change` on the node is still legal (§3.7).

It then writes `revisions/<change>/<id>.mdx` from the live file in state `draft` (optional `title` / `description` overrides, `change_ref`), with the change's planned edges as add deltas (§3.7) and otherwise empty deltas, `base` hashes of live (Rebase, below), and a fresh Atomic Ops list (§3.3), and ensures the revision's `attachments/`. `<id>.mdx`, its edges, and the node's other revisions are unchanged. After opening, the revision's text and deltas change independently of live and of the node's other revisions; new assets go in the revision's `attachments/`. Live keeps serving (`stable`/`unstable`, same id, same edges) while any revision is open, so dependents never relink.

**While open.** The manual pipeline transitions (`draft → ready → in-progress → in-review`) and the Ghost and Completion rules apply to the named revision's own state, checkboxes, and effective edges under its change — not to `<id>.mdx`, and not to the node's other revisions; `update_node_status` takes `change` to name the revision. A revision holding a rebase conflict (Rebase, below) MUST NOT move to `in-review` or `ship`; the rejection names a `resolve_conflict` call for each conflict.

**Gates judge live plus one change.** Every gate on a revision of change C — Ghost Interaction / Ghost Interface, Infrastructure First, Behavior First, the Completion Check, the import and ownership check gate, Minimum Territory Shape, and the decision gate (§5) — judges the graph **under C**: every node with a revision of C replaced by live ⊕ that revision, every other node live. Other changes' open revisions are invisible to it.

**Ship.** On `update_node_status({ node_id, change, new_status: "ship" })` for a node whose revision of `change` is `in-review`, the ship gates run under `change` (Gates judge live plus one change, above; order §5.14). When live changed in place since the revision's `base`, the revision is first rebased onto current live (Rebase, below); a section or scalar both edited is stored on it as a conflict and the ship is `Blocked:` naming `resolve_conflict`. Everything else that can Block (each sibling revision file parses, no decision file name clash) is checked, and every sibling's rebase computed, before the first write; a write that fails puts every file back. The server then MUST:

1. write live ⊕ the revision onto `<id>.mdx` under the same `id` and `type`: the revision's title, description, role (none when it has `role_removed: true`), and body; live's edges, claims, and tests with its deltas applied; fresh `updated_at` / `shipped_at`; `revisions` plus one, updated `churn` and split record (§5.15; only marked parts whose linking edge is in place); `stable` / `unstable` from open Bugs (§3.5); no Atomic Ops (§3.3);
2. move its decision files to the node's `decisions/` (a name already there is `Blocked:` before anything is written), copy its attachments (not `.gitkeep`) into `attachments/`, and delete `revisions/<change>/`;
3. **rebase** every other open revision of the node onto the new live (Rebase, below) and report each as `rebased: [{ change, conflicts, readiness_reset? }]`; a `ready` or `in-review` sibling whose text the rebase changed goes back to `draft` (`readiness_reset: { from, to: "draft" }`).

The `id` never changes, so every edge that targets the node keeps resolving through and after the ship; there is nothing to relink.

**Rebase.** Each revision records in `base` the hash of each live scalar (`title`, `description`, `role`) and each level-2 body section (and the text above the first one) it last started from: the first 8 hex characters of SHA-1 over the text with CRLF normalized to LF and trailing whitespace dropped. `## Rules` and `## Decisions` are never hashed. On rebase, B is carried onto new live per section and per scalar:

- untouched by B (its hash equals `base`) → takes the new live text;
- touched only by B (live's still equals `base`) → keeps B's text;
- both changed to the same text → kept;
- otherwise → B keeps its text and records a **conflict** (`section:<heading>` or `scalar:<field>`). Removing the role counts as changing `role` to none, so live changing the role under it is a `scalar:role` conflict. A conflict B already holds is dropped once new live reads B's text.

A section new live added is inserted before B's `## Rules` / `## Decisions` (text above the first heading goes at the top); one new live deleted that B did not touch is dropped. B's deltas are trimmed: an add already in live and a remove no longer in live drop silently; a claim add that another node now claims live, and that node's revision of B's change does not drop, becomes a claim conflict (`claim:<path>@<owner>`). Every `base` hash then moves to new live. `resolve_conflict` takes the revision's side, live's side (a claim conflict: drop the add; a role conflict while live has no role: the revision removes the role), or new text, and moves that `base` entry to live. `rebase_revision` (§8.2) applies the same rebase on demand, e.g. after a merge (§9.6).

**Discard.** `discard_next` MUST find an **open** revision: the one of `change`, or the node's only one when `change` is omitted (several open and no `change` is `Blocked:` listing them). It deletes `revisions/<change>/` (the file, its attachments, and its decisions); `<id>.mdx` and the node's other revisions are unchanged. The §5.4 guard applies.

**Retire.** `deprecated` on a node with open revisions deletes every revision folder (and closes each change that loses its last revision, §3.7). `force_unship` is `Blocked:` while any revision is open (§5.12).

`get_blast_radius` on a node reports its live dependents (and, for an Interaction, live reachability), the same whatever is open; with `change` it judges the node's revision on the graph under that change (§8.1).

#### Territory Completeness

`<id>.mdx` MUST describe the complete contract of what the node is in the repository now: purpose, living spec (PRD / Execution Logic / Shared Substrate Spec), and durable acceptance criteria that match shipped reality (or, before first ship, the reality being built). It MUST NOT be reduced to a changelog, a "what changed last" narrative, or a stub that points at a package path.

A source's revision (§3.7) is therefore a full successor, not a changelog: edit sections in place until the body describes the post-ship state of the whole node. Ship writes the revision's body over live section by section, so a delta-only body would leave `<id>.mdx` describing only the latest change. Only edges, claims, and tests are deltas. The revision's Atomic Ops are its own (§3.3). A neighbor (§3.7) has no revision: its files are edited in place and its contract stays as shipped.

Agents MUST verify Territory Completeness of each source before moving its revision to `in-review`.

### 3.7 Multi-node revisions

A change that touches several nodes gives each source one revision of it (§3.6), all under one change id; there is no new node type. The classification below applies to every Foundation, Interaction, Interface, and Bug. Nothing in the change may ship while a node it touches is broken. File ownership and Interaction Independence apply unchanged.

#### Pull-in

A node is in a source's blast radius when it `depends_on` the source (transitively: the `affected` set of `get_blast_radius`), `exposes` it, or `leads_to` it. `get_blast_radius` reports the first two (§8.1); inbound `leads_to` is read from the graph. Outbound `leads_to` alone does not make a neighbor. Cancelled and deprecated nodes need not move; `get_blast_radius` omits them unless `include_retired: true`.

#### Classes

| Class | When | Revision |
|---|---|---|
| **Source** | The node's own contract changed | Yes: `open_next`, full successor contract (§3.6 Territory Completeness) |
| **Neighbor** | Pulled in; its owned files changed, its own behavior did not | No: edit the owned files in place |
| **Unaffected** | Pulled in; its owned files did not change | No |

**Neighbor.** Its contract does not change, so it has no revision and no change id: `change` on it is `Blocked:` (Change ids, below). A node whose `implements` must change is a source, except for an additive claim in a folder it dominates (§1.2), which `set_implementation_files` writes in place.

**Unaffected.** Nothing to do, and not a member of the change. The source's revision body MAY name them; no field records them.

**`## Impact`.** No template writes this section, but when a territory body has one, moving to `ready`, `in-review`, `ship`, or (Bug) `resolved` rejects it empty or as a stub:

```
Blocked: Minimum Territory Shape. "<id>"/<file> section "## Impact" is empty or a stub. Write what this node adapted so the already-shipped contract still holds.
```

**Examples.** A visual-system change is a Foundation source; pages whose files adapt are Interface neighbors, edited in place. An enquiry behavior change is an Interaction source; the Interface that mounts it is the neighbor. A Bug that crosses several nodes splits the nodes it `affects` the same way.

#### One status call

The implementer advances a change's nodes with one `update_node_status` call, either a `revisions` batch or a scoped walk. Parameters and result shapes are in §8.2 `update_node_status`; the semantics are:

- **Batch.** Items run in tier order — Foundations, then Interactions, then Interfaces, then Bugs — keeping caller order within a tier. Every item is tried on the graph the earlier items left; a blocked item stays where it is and the call goes on. The result reports each item, plus `partial: true` and `blocked_count` when some moved and some did not. The call is `Blocked:` (nothing written) only when no item moved, listing every item's reason.
- **Scoped walk.** `scope` walks each selected node through every stage (`ready → in-progress → in-review → ship`), running each transition's rules and the in-review check gate at its step. A walk is all-or-nothing: one `Blocked:` step writes nothing. `dry_run` lists every step as `id: from -> to`.
- **Review is never skipped silently.** A walk to `ship` that would move a node not yet `in-review` is `Blocked:` unless `skip_review: true`; the node still stops at `in-review` for the gate, and the result lists it in `skipped_review`. The usual flow is two calls: walk to `in-review`, review, walk to `ship`.
- **Walking past blocked nodes.** With `skip_blocked: true`, each node's whole walk is validated on its own, in walk order, on top of the nodes already validated. A node blocked at any step (a review skip without `skip_review` included) moves no step, and neither does a later node that cannot move without it, because the gates block it in turn. The others walk to the target; the result lists the left-behind nodes in `blocked` (`{ node_id, step, reason }`). When no node can move, the call is `Blocked:` and writes nothing.

**The change hint.** A `Blocked:` single or batch move to `ready`, `in-progress`, `in-review`, or `ship` of a node that belongs to a change (a pre-ship node's `change`, or the revision moved) ends with one line naming the scoped call that moves the whole change: `To move the whole change: update_node_status({ scope: "change", change: "<change>", new_status: "<target>" })`, with `skip_review: true` when the target is `ship` and the node is not `in-review`.

#### Change ids

A **change id** (a slug; optional `change_ref` names the branch or PR) ties one feature's revisions together.

- **Setting it.** `create_node` and `open_next` take `change` / `change_ref` (`open_next` requires `change` and writes both to the revision file only). Before first ship, `patch_node_territory`, `set_implementation_files`, and `set_test_files` set or clear `change` on `<id>.mdx` (an empty string clears it), and `patch_node_territory` also `change_ref`. On a shipped node a revision's change id is its folder name and never changes; there `change` on these tools, and on every other tool that reads or writes a revision, only picks the revision (§8).
- **Only a revision carries one.** On a shipped, active node with no open revision, `change` or `change_ref` on `patch_node_territory`, `set_implementation_files`, or `set_test_files` is `Blocked: "<id>" is shipped with no open revision: edit its files in place; it needs no change id (open_next if its contract changes).` and nothing is written; the same writes without `change` apply in place. So a neighbor is never a member of the change that edits it, and nothing has to clear it when the change ends. The default check covers it anyway: import and ownership rules run on every node's files, and a shipped node whose claimed files changed against the base gets every stale-text signal (§9.6). `record_decision`'s `change` tags the decision only and never writes a change id on the node.
- **Members.** A change's members are its revisions: shipped nodes holding an open revision of the change, and pre-ship, non-retired nodes carrying it, at any state including `draft` and `ready`. A shipped node's revisions of other changes are not members. A shipped node with edges planned under the change (below) is a member with `kind: "planned"`: checked and listed, never walked.
- **Change-wide calls.** `update_node_status` with `scope: "change"` walks every member revision (ordering, validation, and `skip_review` as above). With `nodes: [...]` it walks only those members, so a finished part ships while the rest keeps building: each listed id MUST be a member (else `Blocked:` naming the members), the others stay where they are, and the gates still refuse a listed node that needs an unlisted one (an Interface whose exposed Interaction is unlisted and not shippable is blocked by Behavior First). `nodes` combines with `dry_run`, `skip_review`, and `skip_blocked`. `get_blast_radius` and `orient_for_work` with `change` cover every member, and `run_check` with `change` also runs the in-review gate's import, ownership, and stale-text rules on every revision (§8.1).
- **Decisions.** A decision recorded under the change id counts for every revision of that change at the decision gate (§5.13).
- **End.** Shipping ends membership: the shipped revision's folder is deleted, and first ship clears the id from `<id>.mdx`. A change with no members is `Blocked:` where a change is required. A change that loses its last revision drops its planned edges (below).

#### Planned edges

A plan often needs wiring on a shipped node long before it builds anything there: many features exposed by one shipped Interface, or depending on one shipped Foundation. Opening a revision for each would lock the node for the life of the plan. A **planned edge** records the wiring under a change instead, without `open_next`:

- **Writing.** `link_nodes({ source_id, target_id, edge_type, change })` on a shipped Foundation, Interaction, or Interface with no open revision of `change` writes `<change> <edge_type> <target>` to the live file's `planned:` list (server only, §6.1). Edge types: `belongs_to`, `depends_on`, `exposes`, `leads_to`, `mounts`. It is validated as a link (§5.10: shape, Interaction Independence, a `depends_on` cycle counting the change's other planned `depends_on`, a target that exists and is active, not already live) and `Blocked:` otherwise, or when the same entry is already planned. When the source has an open revision of that change, or is not shipped, `change` changes nothing and the edge is written as without it. `unlink_nodes({ source_id, target_id, change })` removes a planned edge.
- **Not a graph edge.** `graph.edges`, rules inheritance, Capability and stability computation, the import matrix, and the map ignore a planned edge until the change opens the node.
- **Checked with the change.** `run_check({ change })` lists the source as a member, fails on each planned edge that is no longer legal (`Blocked: change "<id>": planned edge <source> -<type>-> <target>: …`), and prints one `Info: planned edges: "<source>" plans <type> <target>, … under this change …` line per source. `get_blast_radius({ change })` merges its radius and returns `planned_edges`; `orient_for_work({ change })` orients on it. The change walk never transitions it.
- **Applied on open.** `open_next({ node_id, change })` adds the change's planned edges to the new revision as add deltas and returns `applied_planned`. The live entries stay until that revision ships: the ship drops the shipped change's entries and keeps other changes', and `discard_next` leaves them planned. While the revision is open, its applied entries are not listed again.
- **Dropped when the change closes.** When a write leaves a change with no revisions where it had at least one — its last revision ships, is discarded, cancelled, or deprecated, or has its change id moved or cleared — the server drops that change's planned entries from every node, once per call, and reports them as `cleared_planned`. Wiring a change never opened is not carried into the next one.

Contract text for a shipped node still needs `open_next`. A node holds at most one open revision per change, so planned wiring of one change never waits on another change's revision of the same node.

#### Attributed files

Some frameworks keep every migration in one folder owned by the composition root, while each schema change belongs to a schema node's revision. **Attribution** connects them without moving ownership: `set_implementation_files({ node_id, attributed })` writes the revision's `attributed:` list (its revision file, picked by `change`, or `<id>.mdx` before first ship; §6.1) of exact files the revision adds in another node's claimed folder. Each entry is one file (no glob, no trailing `/`) that another active node's claim covers and this node's own claims do not. A shipped node with no open revision is `Blocked:` naming `open_next`. `attributed` may be passed alone, keeping the claims. The write resets a `ready` slot like a claim (§3.1).

- The decision gate (§5.13) counts an attributed migration or schema file as new in the revision when the branch adds it, or always outside git.
- The blast radius lists attributed files in the revision's own `affected_files` group (`via: ["focus"]`); the folder's owner keeps them too.
- The check requires each attributed file on disk once the slot that holds it is in review (`Blocked: presence: "<id>" attributed file missing on disk: "<path>".`).
- Ship drops the list: a revision's ship does not carry it to live, and a first ship clears it from the live file.

#### Check before handoff

Before the agent stops owning the work, it MUST bring the graph in line with the implementation and get a green default check (`run_check`, or `mindplan-mcp check`) before self-`ready`, `in-review`, `ship` / Bug `resolved`, or calling the session done; when the work is done and a merge is requested, it MUST `ship` the node (Bug: `resolved`). §9.6 specifies the check and this handoff, and §5.10 the check gate the server runs itself at `in-review` and `ship`.

---
## 4. Computed Capability States

Capabilities are continuous and never "finished." Their states MUST NOT be set manually: the server derives them from the Interactions linked to the Capability by `belongs_to`, and recomputes them after **every** mutation that can change the result (status updates, linking, unlinking).

For a given Capability, let:

- `S` = count of member Interactions with `shipped_at` set (state `stable` or `unstable`)
- `P` = count of member Interactions **actively building**: either
  - no `shipped_at` and `<id>.mdx` state `in-progress` or `in-review`, **or**
  - shipped (`stable`/`unstable`) with at least one open revision in `in-progress` or `in-review` (§3.6)

| State | Condition | Reading |
|---|---|---|
| `evolving` | `S > 0` and `P > 0` | Live and actively being expanded — includes shipped Interactions with a revision mid-build. |
| `stable` | `S > 0` and `P = 0` | Live and untouched. |
| `incubation` | `S = 0` and `P > 0` | The V1 build phase. |
| `draft` | `S = 0` and `P = 0` | Resting state. |

Notes:

- **Bugs do not affect Capability states.** An Interaction flipping `stable` → `unstable` does not change its Capability. Interfaces do not count; only member Interactions do. Interactions in `draft`, `ready`, `cancelled`, or `deprecated` count toward neither `S` nor `P`.
- When a recomputation changes a Capability's state, the server MUST persist it to the Capability's `<id>.mdx` frontmatter and SHOULD report it in the tool response (`capabilities_recomputed`).

---

## 5. Architectural Guardrails (The Compiler Rules)

The MCP server enforces deterministic rules **before** any state mutation is written to disk. Validation is fail-fast: the first violated rule aborts the mutation and nothing is persisted for that transition. An ordered multi-node `update_node_status` (§3.7, §8.2) is a sequence of single-node transitions: a blocked item writes nothing for itself, every other item is still tried, and the call is `Blocked:` only when no item moved.

### 5.1 Error contract

Every rejection MUST be surfaced as a tool error whose text begins with the exact prefix:

```
Blocked: <reason>
```

The reason MUST name the violated rule, the offending node(s) and state(s), and — where applicable — the remediation (e.g. which tool call to make first). Agents MUST treat `Blocked:` responses as hard failures: fix the plan, do not retry blindly.

### 5.2 Rule 1 — No Ghost Interactions

An Interaction MUST NOT transition to `ready` or `in-progress` unless, at validation time, it has at least one `belongs_to` edge to a Capability **and** at least one `depends_on` edge to a Foundation.

Rationale: behavior that belongs to no Capability and stands on no Foundation cannot be routed or reviewed.

### 5.3 Rule 2 — No Ghost Interfaces

An Interface MUST NOT transition to `ready` or `in-progress` unless, at validation time, it has at least one `exposes` edge to an Interaction. An Interface's `depends_on` to a Foundation is optional and not required by this gate.

Rationale: an Interface with nothing to expose is hollow.

### 5.4 Rule 3 — Infrastructure First

An Interaction MUST NOT `ship` (move from `in-review` to production) unless **every** Foundation it directly `depends_on` is **ready for dependents**.

**Ready for dependents.** A node is ready for dependents when it is:

- `stable`, or
- `in-review` (its live file before first ship, else its open revision under the change being judged, §3.6) with at least one checklist item, every `build` item ticked (§3.3), **and** each of its own dependencies (`depends_on`; for an Interface also `exposes`) ready for dependents by this same rule, transitively.

A dependency with no checklist items counts only once `stable`. Its open `review` and `deploy` items wait on people and do not hold its dependents; they still hold its own ship (§5.6). The rejection message MUST list each dependency that is not ready with its current state, and say when a dependency counts.

**Shipped work never rests on unshipped work.** A dependent may ship before its in-review dependency, so retiring that dependency, or taking back what made it count, would leave shipped work on nothing. While a `stable` or `unstable` node `depends_on` a node that is not `stable` (or an Interface `exposes` it), these are `Blocked:` on that node, naming those dependents and the fixes (ship the dependency, or `force_unship` the dependents):

- `cancelled`;
- moving its active slot back from `in-review`;
- a `patch_node_territory` or `resolve_conflict` edit that, while that slot is in review and every `build` item in it was done before the call (the only slot a dependent can have shipped on), leaves a `build` item not done or fewer `build` items done. The Block names the items not done after the call, marking `(was done)` those the call took back (matched by id, or by text when untagged), and the done count before and after. A slot that already had an open `build` item was not relied on and is not guarded; rewording a done item in place, or adding a done item, passes;
- `discard_next` of a shipped node's revision, only when such a dependent relied on the revision's view: one of its owned files imports a file that only the revision claims (live does not). Otherwise the discard goes ahead.

Rationale: concrete is poured before the roof is built. A behavior cannot go live on substrate that is not ready for it.

### 5.5 Rule 4 — Behavior First

An Interface MUST NOT `ship` unless **every** Interaction it directly `exposes`, and **every** Foundation it directly `depends_on` (if any), is ready for dependents (§5.4).

The rejection message MUST list each exposed Interaction and Foundation that is not ready with its current state, ending with the same sentence as §5.4.

Rationale: an Interface must not go live while the behaviors it exposes, or the substrate it mounts on, are unfinished.

### 5.6 Rule 5 — The Completion Check

A Foundation, Interaction, or Interface MUST NOT `ship` while the territory file being judged (`<id>.mdx`, or the revision file of the change being shipped) contains one or more unchecked Atomic Operations (`[ ]`). A Bug MUST NOT transition to `resolved` while unchecked items remain. The rejection message MUST include the count of open checkboxes.

The check counts every item, whatever its kind (§3.3): an open `review` or `deploy` item holds the node's own ship, even when its dependents may already ship (§5.4). An item ticked with a note (`— note: …`) or as not applicable with a reason (`— n/a: <reason>`) is complete; `— n/a:` with an empty reason counts as unchecked.

`in-review` MUST NOT require a complete checklist, `build` items included: agents enter `in-review` with open items and tick them while in review. Atomic Ops are a **ship-time ledger**, confirmed before `ship` / `resolved`, not a plan or progress log. The server does not restrict when boxes are checked, in any state; this check is the only checklist gate. Each ship drops the ledger from the live file and every new slot starts a fresh one (§3.3), so a ship never relies on the ticks of the node's previous ship.

Rationale: blocking `ship` on an unchecked item keeps "done" honest without dictating when an agent ticks boxes.

### 5.7 Rule 6 — No Ghost Bugs

A Bug MUST NOT transition to `triaged` or `fixing` unless it has at least one `affects` edge to an Interaction, Interface, or Foundation at validation time.

### 5.8 Rule 7 — Computed Capabilities

Capability states are computed, not settable (§4): a manual status mutation of a Capability MUST be rejected.

### 5.9 Rule 8 — Computed Stability

`stable` and `unstable` are computed, not settable (§3.5): a manual move of a Foundation, Interaction, or Interface to either MUST be rejected.

### 5.10 Rule 9 — Taxonomy enforcement and Interaction Independence

Edge creation MUST validate:

- both node ids exist in territory,
- the edge shape is legal per §2.2,
- the edge is not a self-link and not a duplicate,
- **Interaction Independence:** `depends_on` from an Interaction MUST NOT target another Interaction — share state through Foundations instead,
- `depends_on` edges do not create a cycle (§2.2). Cycle detection MUST use each node's **effective** `depends_on` under the change being written or judged (§3.6): live with that change's revision delta applied, otherwise live; other changes' revisions do not count. A revision's ship MUST re-assert acyclicity under its change before writing live.
- **No cycle across changes.** Each change is judged alone, so two changes could each add half of a `depends_on` cycle and both pass; then neither could ship after the other. The server also builds one `depends_on` graph over live plus **every** open change — shipped nodes' live edges, each open revision's `depends_on_add` (its `depends_on_remove` takes the live edge out for that change only), each pre-ship active node's edges under its `change`, and every planned `depends_on` (§3.7) under its change — and rejects a cycle whose non-live edges need **two or more** changes (a cycle one change closes alone is the per-change rule above). `link_nodes` (a live edge, a revision delta, or a planned edge) and `open_next` (applying the change's planned `depends_on`) are `Blocked:` when the edge would close one: `Blocked: depends_on "<source>" -> "<target>" (change "<change>" | live) would close a dependency cycle across changes "<a>", "<b>": <path>. The changes could never ship in any order; move the shared part into a Foundation both depend on.` `run_check` reports each existing one as `Blocked: change cycle: changes "<a>", "<b>": <path> (<edge> in "<a>", …). …` (with `change`, only the cycles that change takes part in, prefixed `change "<id>": `).
- `leads_to` MUST NOT be subjected to cycle rejection.
- `mounts` runs from a Foundation to an Interface only; it is not part of the `depends_on` acyclicity set.

**Check gate.** A move to `in-review` or `ship` (Foundation, Interaction, Interface) MUST run the default check's **import matrix**, **exclusivity**, and linked-test **presence** (`tests` entries) rules over the node's files under the change being moved (live with the revision's claim delta applied, else `implements`, a pre-ship node seeing its own `change`'s revisions; §3.6) and fail with `Blocked: Check failed for "<id>" …`, listing each violation with its fix (a `link_nodes` call, `not allowed: …`, or the missing `tests` entry). It runs after the transition's other rules and before any write. The same moves also require a non-empty `implements` list whose every entry exists on disk (`Blocked: Implements required.` / `Blocked: Implements presence.`). The default check's other rules (§9.6), such as coverage and leftovers, are not gates.

There is **no Dependency Closure** rule: `link_nodes` MUST NOT accept or document a `link_dependent` parameter.

### 5.11 Rule 10 — Version Lineage (stable-id evolution)

A shipped Foundation, Interaction, or Interface changes through revisions under its unchanged `id` (§3.6). `open_next`, every status move of a revision, `discard_next`, and retiring a node with open revisions MUST validate and write exactly as §3.6 specifies (Open, While open, Ship, Discard, Retire), and MUST reject any other way of replacing a shipped node.

Rationale: a node is replaced without downtime, without dependents re-pointing at a new id, and without one change waiting for another on the same node. Git history of `<id>.mdx` is the audit trail of what each ship changed; while a revision is open, `get_node_context({ node_id, change })` reads it beside live.

### 5.12 Rule 11 — Force Unship (mistaken ship recovery)

`force_unship` MAY reverse a mistaken Foundation/Interaction/Interface ship. It is the only legal path from `stable`/`unstable` back to a pre-ship state. The server MUST:

1. require `confirm` exactly equal to `unship:<node_id>` — any other value MUST be rejected with a message that tells the agent to ask the user and not invent confirmation,
2. accept only Foundation/Interaction/Interface nodes currently in `stable` or `unstable` (Capabilities and Bugs MUST be rejected),
3. reject while any revision is open, naming each (`discard_next` or ship each first),
4. reject while any **direct** `depends_on` dependent is itself `stable` or `unstable` (list them; force-unship or deprecate the dependents first so Infrastructure First stays coherent),
5. accept `new_status` only in `draft | ready | in-progress | in-review` (default `ready`),
6. apply the Ghost Interaction / Ghost Interface / Completion Check gates of the target state, as a normal transition into it would,
7. clear `shipped_at` and `added_claims` (§1.2) on `<id>.mdx`, give the live file a fresh Atomic Ops list (§3.3; the gates in item 6 see it, and a rejected unship leaves the file as it was), set `state` to the target, recompute Capability states, and refresh `mindplan/map.md`.

Agents MUST obtain an explicit human yes in the conversation before calling `force_unship`, and MUST NOT invent or “helpfully” supply `confirm`. Manual `stable`/`unstable` stays forbidden (§5.9).

### 5.13 Rule 12 — Decision gate

MindPlan records decisions (§6.1.2); it never makes, ranks, or judges them. It asks for one only where a missing one is costly. An **open revision** (of a shipped Foundation, Interaction, or Interface, §3.6, or a pre-ship, non-retired one at any pre-ship state) is **decision-worthy** when any of these hold, each judged under the revision's change (§3.6):

| Trigger | Holds when |
|---|---|
| Shared contract | the revision is a revision of a shipped **Foundation** |
| Schema | its claims (live with its claim delta applied) cover a migration or schema file (config `decisions.schema_files`, §1.2.1) new in this revision: for a shipped node's revision, one its live claims do not cover or one the branch adds (untracked, staged as added, or added since the merge base of `HEAD` with `main` / `master`); for a first build, one the branch adds (a node modeling a file the repository already had is not gated); outside a git repository, every claimed one. A file the revision attributes to itself in another node's folder (§3.7) counts when the branch adds it, or always outside git |
| Blast radius | it has more non-retired dependents (transitive reverse `depends_on`) than config `decisions.blast_radius` |
| Edges | a shipped node's revision adds or removes a `depends_on` target. A first build's initial edges never count |

Capabilities and Bugs are never revisions. A revision that is not decision-worthy is never gated.

A decision-worthy revision **has a decision** when, on or after the day the change started (the earliest start among its open revisions: a revision's `opened_at`, `created_at` before first ship), an active node recorded a decision whose `change` is the revision's change id (§3.7), or one whose `nodes` lists this node, untagged or under that change (so one decision clears the gate of every node it lists); or the revision holds a decision of its own: for a shipped node's revision any file in its `decisions/` folder, before first ship any of the node's decisions. The date bound keeps a reused change id from being satisfied by an earlier change's decisions, while a member added to a change later still gets credit for its earlier decisions.

- **While draft, ready, or in progress:** the default check (§9.6) prints `Warning: decision: "<id>" <triggers>; record the choice and the alternative you rejected with record_decision before in-review.`
- **Moving to `in-review`:** `Blocked: Decision. "<id>" <triggers>, and no decision is recorded for this revision (under change "<change>" or on the node). Record the choice and the alternative you rejected. Fix: record_decision({...}).` When the node has shipped and a trigger is the shared contract or the blast radius, the message also names the open–closed alternative (§5.15) before `Fix:`: `An additive alternative leaves "<id>" closed: a new node that depends_on it, or a split of it; name it in alternatives if you rejected it.` The gate runs after the transition's own rules and the check gate (§5.10), before any write, for single moves, revisions, scoped walks, and their dry runs. Moves to other states are not decision-gated.

### 5.14 Enforcement ordering

For a status mutation the compiler MUST evaluate, in order:

1. node exists → 2. node is not a Capability → 3. resolve the slot: the revision of `change`, or the node's only open revision (several and no `change` is `Blocked:`), else `<id>.mdx`; a retirement (`deprecated` / `cancelled`) always acts on `<id>.mdx` → 4. target state is valid for that slot → 5. transition is legal per §3 (or the §3.6 revision pipeline), and a revision moving to `in-review` or `ship` holds no conflict → 6. Rules 1–6 (type-specific, evaluated under the revision's change, §3.6), then the check gate on `in-review` / `ship` (§5.10) and the decision gate on `in-review` (§5.13) → **write** → 7. on a revision's `ship`, write live ⊕ the revision and rebase its siblings per Rule 10 (§3.6, §5.11) → 8. recompute stability (§3.5) → 9. recompute Capability states (§4) → 10. synchronize frontmatter (§6.2).

Other mutations validate, write, recompute, then synchronize frontmatter:

- `force_unship`: Rule 11 (§5.12), its writes (item 7 there), Capability states.
- `link_nodes` / `unlink_nodes` with `affects`: §5.10, the edge, stability of the affected targets, Capability states when they change.
- `link_nodes` with `belongs_to`, `depends_on`, `exposes`, `leads_to`, or `mounts`: §5.10 (Interaction Independence and the `depends_on` cycle checks included), the edge — on the source's revision (the one of `change`, or its only open one) as an add delta against live, else on `<id>.mdx` — and Capability states when membership changes.
- `open_next` / `discard_next`: Rule 10 (§5.11), then the revision write or delete it describes.

### 5.15 Open–closed signals

A feature should mostly add nodes and files, and rarely reopen a shipped node that keeps changing for several reasons (open for extension, closed for modification). Frequent change and a node everything depends on (auth) are both normal, so MindPlan compares each node with the project's own pace, not with fixed numbers. It reads graph facts only (edges, ship counts and times, decision records, change ids), never code. Every signal below is a warning or an informational field (`orient_for_work` `stability`, §8.1); none Blocks.

- **Fan-in.** The distinct active nodes with a direct live edge into the node that a change to its contract reaches first: `depends_on` from any source, an Interface that `exposes` an Interaction, a composition root that `mounts` an Interface. Retired sources do not count; an edge that exists only in an open revision or as a planned edge counts once it ships.
- **Revision count.** A shipped node's live `<id>.mdx` carries `revisions: N` (§6.1): how many times it shipped. First ship writes `1` and each revision's ship adds one; only ship and the backfill (below) write it. It is a count, not a log: git keeps the history.
- **Recent ship rate.** The live file also carries `churn: X`, a decayed ship count as of `shipped_at`: each ship sets it to the previous value multiplied by `½^(days since the previous ship / half_life_days)` (config `hotspots.half_life_days`, §1.2.1), plus 1 (rounded to three decimals). `force_unship` decays it to the unship and writes `churn_at`, the time it is as of while there is no `shipped_at`; the next ship decays it from `churn_at` and drops `churn_at`. The rate a check sees is that value decayed on from `shipped_at` to the day the check runs, plus one while any revision is open (one, however many are open). The graph's **median rate** is the median over the established nodes: shipped, active Foundations, Interactions, and Interfaces that shipped at least twice since their last split. A node shipped once, or a root that just split, has no pace yet, so a change that adds many nodes does not drag the median down.
- **Split record.** `split_at: N` and `split_into: [ids]` record where a node last split parts out of itself. A split is declared, not guessed: while a revision of the node is open, `patch_node_territory({ node_id, change, split_into: [ids] })` marks the parts on that revision. What a part is depends on the type, and each keeps the import rules intact: a Foundation splits into Foundations it then `depends_on` (it stays the composition root and imports them; a part never imports the root to register itself); an Interaction splits into Interactions that share one of its Capabilities, one behavior each, sharing state through Foundations; an Interface splits into the Interactions it `exposes` (the behavior moves into Interactions it only mounts). When the revision ships, the marked parts with that edge in place are recorded: `split_at` becomes the new count, the parts join `split_into`, and `churn` is reset to 0. A marked part without the edge yet returns a `split_into:` warning naming it. A wrong split record is cleared with `patch_node_territory({ node_id, split_into: [] })` on the shipped node with no open revision: `split_at` and `split_into` go, `revisions` stays, and `churn` is replayed from the node file's git history without the reset (kept as stored outside git); a node with no split record is `Blocked:`. A revision that only starts using a new Foundation marks nothing, so it records no split. `split_into` is not an edge: it changes no import rule and no blast radius.
- **Change groups.** The reasons behind the rate come from decision records: each change id on the node's decisions (live and every open revision, superseded included), with the decision sentences recorded under it, oldest first. A hotspot shows the three most recent groups.
- **Backfill.** `upgrade_project` writes `revisions` and `churn` on every shipped Foundation, Interaction, and Interface that lacks either, from the git history of its live file: each distinct `shipped_at` value is one ship, at the first commit that has it (a side branch merging an older copy back does not count twice), plus one when the working tree holds a ship not yet committed. A past split is inferred only from moved claims: a Foundation ship whose `depends_on` gained a Foundation that first shipped after its previous ship and no later than this one, and where one of that part's claims (at its first ship) was covered by the node's claims at the previous ship and is not at this one, is recorded as a split. `churn` replays the ships' `shipped_at` values through the same decay, reset to 0 at a split. Outside git a node gets `revisions: 1` and `churn: 1`; a node file git has never seen at its path (one this upgrade just renamed) is left for a later `upgrade_project`, after the rename is committed. A node that already carries both is left alone, so a second call writes nothing.
- **Hotspot.** A shipped, active Foundation, Interaction, or Interface whose rate is at least config `hotspots.min_rate` (default `2`) and at least `hotspots.outlier_ratio` (default `3`) times the graph's median rate (a median below 1 counts as 1), §1.2.1. Fan-in never decides it; it ranks hotspots (rate × fan-in, highest first), since a busy node many others depend on costs the most. Open revisions raise a node's own rate but not the median. The default check (§9.6) warns once per hotspot: `Warning: hotspot: "<id>" ships far more often than the rest of the graph lately (rate X against a median of Y)[ since it split into <ids>], and N nodes depend on it directly; it may change for several reasons. Its recent changes fall into these groups: change "a" (<decision>; <decision>), change "b" (no decision recorded). If they are separate reasons, <split>, so a later feature revises one part and the rest stays closed; if it should stay one node, record that with record_decision({ keep_whole: true }).` `<split>` is the node type's split (Split record, above), with how to mark the parts with `patch_node_territory` `split_into`.
- **Fan-out.** A node that must know every feature of a kind (erase a site, export an account, index for search, check a permission) grows one `depends_on` per feature, so every new feature reopens it. For each pre-ship (never shipped, not retired) Foundation, Interaction, or Interface, the fan-out count is the number of distinct other change ids among its `depends_on` targets that have never shipped (not retired, with a change id). Targets in the node's own change, shipped targets, retired targets, and targets with no change id do not count. The changes are listed in the order their first target appears in `depends_on`. When the count reaches config `fan_out.warn_at` (default `3`, §1.2.1), the default check (§9.6) warns, highest count first, then by id: `Warning: fan-out: <id> depends on <N> other changes (<a>, <b>, …). It may need to know every feature of a kind. Consider inverting: put a contract on a Foundation those changes meet (a schema convention, or a record they react to), enforce it with a node rule and a test, and drop these depends_on edges.`
- **Keep whole.** A node the owner keeps whole on purpose (auth, where every change is a security change) holds a decision recorded with `keep_whole: true` (§8.2). While no record supersedes it, the node is never a hotspot, `open_next` does not warn on it, and the check prints no `fan-out:` line for it; superseding that decision turns detection back on.
- **Reopening a hotspot.** `open_next` on a shipped node that is a hotspot counting the revision it opens (and is not kept whole) opens the revision and returns `warnings: ["Warning: \"<id>\" ships far more often than the rest of the graph lately (…), and this revision reaches its N direct dependents. Prefer extending it: add a new node that depends_on \"<id>\", or split it so this change revises a smaller part (recent changes: …). If revising it is still right, record why with record_decision and name the additive alternative you rejected."]` and `decision_prompt`, the `record_decision` call with the node, the revision's change, and that alternative filled in (§8.2).
- **Additivity of a change.** `get_blast_radius({ change })` returns `additivity` and `run_check({ change })` prints it as `Info: additivity: …` (and `change.additivity`): `{ summary, new_nodes, revised, planned }`, where `new_nodes` are its revisions never shipped, `revised` its shipped nodes with an open revision of the change (`{ id, state, fan_in }`), and `planned` the shipped nodes it will reopen through planned edges (§3.7). `summary` reads `change "payload-split": 5 new nodes, 1 revised shipped node (f-payload, fan-in 43)`, adds `, N planned revisions (…)` when there are any, and ends `; purely additive` when nothing shipped is revised or planned.

Agents check these before choosing `open_next` (the `plan-project` skill, Classify scope): a new node that `depends_on` a hotspot, or a part split out of it, keeps the shipped node closed.

---

## 6. Territory File Format

### 6.1 `<id>.mdx` structure

Every node's `<id>.mdx` MUST begin with YAML frontmatter followed by a Markdown body (the file is MDX; JSX is allowed and ignored, §6.4). A revision file `revisions/<change>/<id>.mdx` (Foundation/Interaction/Interface only, §3.6) has its own flat frontmatter (§6.1.3) over the same kind of body. MCP writes leave exactly one blank line between the closing `---` and the body; `get_node_context` returns the body from its first text.

```mdx
---
id: i-checkout-split
type: Interaction
title: "Split & pay checkout"
description: "Diner splits and pays the bill from their phone"
state: in-progress
created_at: 2026-07-14T06:00:00.000Z
updated_at: 2026-07-14T07:00:00.000Z
belongs_to:
  - c-ordering
depends_on:
  - f-db-core
leads_to:
  - i-tip-selection
implements:
  - src/checkout/split/
---

# Split & pay checkout

Diner splits and pays the bill from their phone.

## Purpose

Let each diner at a table pay their own share without waiting for staff.

## Actor & Trigger

A diner taps "Split bill" on the table's open order.

## Inputs & Outputs

In: the table's open order and the number of payers. Out: one payment request per payer.

## PRD / Execution Logic

1. Load the open order through the f-db-core Foundation.
2. Split it evenly or by item, as the diner picks.
3. Create one payment request per payer and close the order when all are paid.

## Acceptance Criteria

- Each payer sees and pays only their share.
- The order closes when every share is paid.

## Atomic Ops

- [x] Requirements defined {#spec}
- [ ] Implementation complete {#impl}
- [ ] Tests passing {#verify}

## Attachments

![wireframe](attachments/checkout-wireframe.png)
```

Frontmatter fields (lists use YAML block syntax; an empty list MUST be omitted):

| Field | Type | Written by | Notes |
|---|---|---|---|
| `id` | string | server, at creation | Immutable for the node's lifetime, including every revision. MUST equal the folder name. |
| `type` | `Capability \| Foundation \| Interaction \| Interface \| Bug` | server, at creation | Immutable. |
| `title`, `description` | string (JSON-quoted) | territory (`create_node`, `patch_node_territory`) | Stored only in frontmatter. MAY be edited on a pre-ship `<id>.mdx`, or on a revision at any revision state (§6.1.3), whose ship writes them to live. |
| `state` | string | **server only** | Build pipeline, computed production, Capability, or Bug lifecycle state. Written on accepted transitions and by a readiness reset (§3.1). A revision's state is in its own file (§6.1.3). |
| `created_at` | ISO-8601 | server, at creation | Immutable; never rewritten by a revision's ship. |
| `updated_at` | ISO-8601 | **server only** | Touched on every accepted state or edge mutation to the live file. |
| `shipped_at` | ISO-8601 | **server only** | Optional; set on `ship` (first build or a revision's ship); cleared by `force_unship`. |
| `revisions` | integer | **server only** | Shipped Foundation, Interaction, or Interface: how many times it shipped (§5.15). Not the open revisions, which are folders. |
| `churn` | number | **server only** | `<id>.mdx` only. The decayed ship count as of `shipped_at` (§5.15). Written at each ship, by `force_unship`, by a split or its clearing, and by `upgrade_project`. |
| `churn_at` | ISO-8601 | **server only** | `<id>.mdx` only. Written by `force_unship`: the time `churn` is as of while there is no `shipped_at`. The next ship drops it (§5.15). |
| `split_at` / `split_into` | integer / id list | **server only** | `<id>.mdx` only. The revision at which the node last split parts out of itself, and every part it split into (§5.15). Not edges. A revision's own `split_into`: §6.1.3. |
| `severity` | `low \| medium \| high \| critical` | no tool | Bug only, optional. Read into the node record when it holds one of these values (`get_mindplan_graph` `fields`); no rule reads it. |
| `role` | `assembler \| infra \| design-system \| adapter` | **server only** (`create_node`, `patch_node_territory`) | Foundation only (§2.0.1). A revision proposes its own (§6.1.3). |
| `belongs_to`, `depends_on`, `exposes`, `leads_to`, `mounts`, `affects` | string[] | **server only** (`link_nodes`, `unlink_nodes`) | Outgoing edges; legal shapes in §2.2. A revision changes all but `affects` through `<edge>_add` / `<edge>_remove` deltas (§6.1.3), applied on ship. |
| `implements` | string[] | **server only** (`set_implementation_files`) | Owned files (§1.2). A revision changes it through `implements_add` / `implements_remove` (§6.1.3). |
| `added_claims` | string[] | **server only** | `<id>.mdx` of a shipped node only. The `implements` entries `set_implementation_files` added in place (§1.2). `run_check` warns `stale:` for each one the body does not name as a whole path (not as part of a longer path: `src/a.ts` is not named by `src/a.tsx`, `src/a/` not by `src/a/b.ts`) (§9.6); a territory patch prunes the entries its body now names; a revision's ship and `force_unship` drop the list. |
| `planned` | string[] | **server only** | `<id>.mdx` of a shipped node only. Planned edges (§3.7), one `<change> <edge_type> <target>` item each; not graph edges. Written by `link_nodes` / `unlink_nodes` with `change`; a revision's ship drops its change's items; a closing change drops its own. `open_next` turns its change's items into add deltas on the revision. |
| `attributed` | string[] | **server only** | `<id>.mdx` before first ship (a revision carries its own, §6.1.3). Exact files the revision adds in another node's claimed folder (§3.7); not claims. Dropped on ship. |
| `tests` | string[] | **server only** (`set_test_files`, §8.2) | Foundation, Interaction, or Interface. The test files, directories ending in `/`, or globs that verify the node. Not ownership: the files are claimed through some node's `implements` as usual, and several nodes may list one file. A revision changes it through `tests_add` / `tests_remove` (§6.1.3), applied on ship. Writing it never touches `state` or `updated_at`, so it never resets readiness; other writers keep the list verbatim. |
| `aliases` | string[] | **server only** | Any node type. Search aliases: synonyms, the words users will say, other languages (`quote`, `request a quote`, `ofertă`). Written by `create_node` and `patch_node_territory` (`aliases`, §8.2), each a JSON string, at most 20 of up to 60 characters, deduplicated ignoring case. Live only: revisions do not carry it, and writing it never needs `open_next` or resets readiness. Search indexes it with the node's text (§8.1.1). |
| `change`, `change_ref` | string | **server only** | Pre-ship `<id>.mdx` only: the node's change id and optional branch or PR reference; writers in §3.7. A first ship removes both; a shipped live file carries neither. A revision file carries its own (§6.1.3). |

The body is free-form and owned by humans and agents, except the optional `## Rules` section (§6.1.1), which has its own writer; decisions are files, not body text (§6.1.2). Host file tools MUST NOT write territory (§8.2). In a body, comments use MDX syntax `{/* … */}`; HTML comments (`<!-- -->`) MUST NOT be used.

**Shipped scope freeze:** `patch_node_territory` of `title`, `description`, or a Foundation's `role` on the live file of a Foundation, Interaction, or Interface that is shipped, `deprecated`, or `cancelled` MUST be rejected. A shipped node takes them on a revision (`open_next` first).

#### 6.1.1 Node rules

Any node (Capability, Interaction, Interface, Foundation, Bug) MAY carry **node rules**: standing constraints for the work in that node's territory, stored as a `## Rules` section in its `<id>.mdx` body. The section runs from a line that is exactly `## Rules` to the next level-1 or level-2 heading, or end of file; at most one per file. It is placed immediately before `## Attachments` when that heading exists, otherwise at the end of the body. An empty rule set has no section.

- **Single writer.** Only `patch_node_rules` (§8.2) writes the section. `patch_node_territory` MUST preserve its text when it replaces the body, and MUST reject a body that contains a `## Rules` heading (the error names `patch_node_rules`). `get_node_context` returns the body without the section plus a separate `rules` string.
- **Slot independence.** Rules are not part of a revision. `patch_node_rules` writes `<id>.mdx` only and never needs `open_next`; a revision body carries no `## Rules` section, every open revision reads the live rules, and a revision's ship keeps them. Checkbox-looking lines in the section are not Atomic Ops.
- **Inheritance.** The rules that apply to a node N, in order, each labeled with the node it came from (`via`, `distance`):
  1. N's own rules (`self`, 0).
  2. Rules of nodes reached upward through `belongs_to` (`belongs_to`): an Interaction gets its Capabilities' rules.
  3. Rules of the transitive closure of `depends_on` (`depends_on`): a dependent gets its Foundations' rules, and a Foundation gets the rules of the Foundations it depends on.
  4. For a Bug only: everything each node it `affects` would itself resolve (own, `belongs_to`, `depends_on`), with `via: affects` and distance increased by 1.

  Nothing is inherited downward (a Capability gets no Interaction's rules; a Foundation gets no dependent's), across siblings, or through `exposes` / `leads_to`. Only live edges count; a revision's edge deltas do not. A node reached twice keeps its smallest distance; nodes with no rules and inactive nodes (`cancelled`, `deprecated`, and closed Bugs: `resolved`, `wontfix`) are omitted.
- **Reach.** The inverse is the node's **rules audience**: exactly the other active nodes whose resolved rules include an entry from N. `get_blast_radius` and `patch_node_rules` report it (§8), because editing a Foundation's rules affects everything that depends on it.
- **Enforcement.** Prose only. The compiler does not read node rules; no `Blocked:` rule depends on them.
- **Fences.** Detection is line-based and does not understand fenced code blocks: a `## Rules` line, or a level-1/2 heading line, inside a fence counts as a heading. Keep such lines out of node rules and out of bodies that show a Rules template.

#### 6.1.2 Decision records

A node MAY carry **decision records**: why its design looks the way it does, so a later agent does not "simplify" it back into the problem it avoided. Each record is one append-only file, `decisions/<decision-id>.md`, in the node folder, or in a revision folder (`revisions/<change>/decisions/`) while that revision is open. The file holds exactly one `### <id>` entry plus an optional `- Nodes: a, b` line, with LF line endings and a final newline.

```md
### d-invoice-numbers-at-finalize

- Decision: Invoice numbers are assigned when an invoice is finalized, not when the draft is created.
- Alternatives:
  - Assign on draft creation (simple, but leaves gaps when drafts are deleted)
  - Assign on payment (too late: customers need the number on the PDF)
- Why: Tax law in the target markets requires gapless sequential numbering of issued invoices.
- Consequences: Drafts have no number; anything showing a draft must handle that.
- Change: invoice-finalize
- Date: 2026-03-02
```

| Field | Meaning |
|---|---|
| `id` | The `### ` heading: `d-` followed by a slug, unique across the graph |
| `Decision` | One sentence: what was chosen |
| `Alternatives` | What else was considered, one indented line each (at least one) |
| `Why` | The constraint or trade-off that decided it |
| `Consequences` | Optional: what it makes harder or forbids |
| `Supersedes` | Optional: id of the decision it replaces |
| `Change` / `Date` | The change id (§3.7) and date it was recorded under |
| `Keep whole` | Optional: `true` keeps the node whole on purpose (§5.15) |
| `Nodes` | Optional: every node the one decision shapes (`record_decision`'s `nodes`); it clears the decision gate of each listed node's revision (§5.13) |

- **Single writer, append only.** Only `record_decision` (§8.2) writes decision files, one new file per call; a file is never rewritten, and a file of that name already there is `Blocked:`. `patch_node_territory` MUST reject a body, section text, or replacement containing a `## Decisions` heading, and `section: "## Decisions"` (the error names `record_decision`). Stale-text warnings ignore decisions, because a recorded decision may name a path a later revision removed.
- **Revision-bound.** Unlike rules, decisions belong to a revision while it is open. `record_decision` on a shipped node writes `revisions/<change>/decisions/` of the revision it picks (`change`, or the node's only open revision); a revision's ship moves its files to the node's `decisions/`, and `discard_next` deletes them (§3.6). With no open revision (or a `change` the node has no revision of) it writes the node's `decisions/` beside the live file. A node's decisions are its live ones plus, read under a change, that revision's. Recording never changes state or readiness: a decision explains a contract, it does not change it.
- **Status is computed.** A decision is `superseded` while a decision held by a node that is not `cancelled` names it in `Supersedes`, and `active` otherwise. A `deprecated` node's replacement still stands (retiring it does not bring back the design it replaced); a cancelled node's work never shipped, so its decisions supersede nothing. No status is written into the old entry, so abandoning the revision that superseded a decision makes it active again. Changing a decision means recording a new one that supersedes it; the old one stays listable.
- **Ids.** Ids are unique across the graph: an id is taken while any node's decision files (live or in any open revision) hold it or any recorded `Supersedes` still names it, so an id freed by a discarded revision is not reused while a decision still points at it. A duplicate is `Blocked:`.
- **Inheritance.** Decisions reach a node along exactly the node-rules walk (§6.1.1): its own, its Capabilities', its transitive Foundations', and for a Bug those of the nodes it affects, each labeled with the node it came from. Superseded entries are left out unless asked for.
- **Where they show up.** `orient_for_work` (`decisions` block), `list_decisions`, `get_node_context` (`decisions`), `get_blast_radius` (`decisions`), and `export_mindplan_view` (`decisions: true`) (§8.1). The decision gate (§5.13) reads them.
- **Body sections.** A `## Decisions` section in a live body is read as that node's decisions (only its `### d-…` entries are parsed) until `upgrade_project` splits it into files (§1.1.2). Detection is line-based like §6.1.1: a heading line inside a fenced code block counts as a heading.

#### 6.1.3 Revision files

A revision of a shipped Foundation, Interaction, or Interface (§3.6) is `revisions/<change>/<id>.mdx`. Its frontmatter is flat, server-written, in this order (lists in YAML block syntax, omitted when empty; an item that is not plain path characters is a JSON string):

| Field | Notes |
|---|---|
| `id`, `type` | The node's. |
| `change` | The change id; MUST equal the folder name. |
| `change_ref` | Optional branch or PR reference. |
| `state` | `draft \| ready \| in-progress \| in-review` — never a production or retired state. |
| `opened_at`, `updated_at` | When `open_next` opened it (the decision gate dates the revision's start from it, §5.13), and its last write. |
| `title`, `description` | The revision's own (JSON-quoted). |
| `role` | Foundation only, optional: the proposed role; absent keeps live's. |
| `role_removed` | Foundation only, optional: `true` when the revision removes live's role (no `role`); its ship clears the role. |
| `<edge>_add` / `<edge>_remove` | Edge deltas against live for `belongs_to`, `depends_on`, `exposes`, `leads_to`, `mounts`. |
| `implements_add` / `implements_remove` | Claim delta against live (§1.2). |
| `tests_add` / `tests_remove` | Linked-test delta against live. |
| `attributed` | Exact files the revision adds in another node's claimed folder (§3.7). |
| `split_into` | The parts this revision marks (§5.15); live's record is not copied in, and its view and its ship add them to live's list. |
| `base` | The live hashes the revision last rebased on (§3.6): `title=<hash>`, `description=<hash>`, `role=<hash>`, and one `section:<heading>=<hash>` per level-2 section of the live body (`section:_preamble=<hash>` for the text above the first heading). |
| `conflicts` | Unresolved rebase conflicts (§3.6): `section:<heading>`, `scalar:<field>`, `claim:<path>@<owner>`. |

Deltas are stored trimmed against live: an add already live and a remove not live are dropped when written. The **effective** lists under the change are live with the removes applied, then the adds, sorted and deduplicated. The body is the revision's whole proposed territory (§3.6 Territory Completeness) and carries no `## Rules` or `## Decisions` section (rules are live only, §6.1.1; decisions are files, §6.1.2). The revision's decisions live in its `decisions/` folder and its attachments in its `attachments/` folder.

### 6.2 Frontmatter mirroring

Server-owned fields (every **server only** field in §6.1, and a revision file's whole frontmatter, §6.1.3) MUST be written only by MCP tools (§8.2), and only after a mutation is accepted. After each accepted mutation the server rewrites them in every file the mutation affects: the slot that moved or was linked, every Capability whose computed state changed (§4), and on a revision's ship the live file and each rebased sibling revision (§3.6). The tables in §6.1 and §6.1.3 name each field's writer. If a file is missing or has no frontmatter, mirroring skips it silently.

### 6.3 Scaffolding templates

`create_node` MUST scaffold the node folder with a type-appropriate `<id>.mdx` and an empty `attachments/` directory (with `.gitkeep`, so the folder is versionable), and ensure `mindplan/components/` exists at the planning root (§6.4). It never creates revision folders; only `open_next` does (§3.6). Every body starts with `# <title>` and the description, then these level-2 sections, each holding placeholder text (a stub, §6.5) or default checklist items, and ends with an MDX comment naming standard components (§6.4):

| Type | Sections | Default checklist items |
|---|---|---|
| Capability | `Overview`, `Linked Interactions`, `Attachments` | none (no completion gate) |
| Foundation | `Purpose`, `Shared Substrate Spec`, `Acceptance Criteria`, `Atomic Ops`, `Attachments` | `Spec written {#spec}`, `Implementation complete {#impl}`, `Verified in target environment {#verify}` |
| Interaction | `Purpose`, `Actor & Trigger`, `Inputs & Outputs`, `PRD / Execution Logic`, `Acceptance Criteria`, `Atomic Ops`, `Attachments` | `Requirements defined {#spec}`, `Implementation complete {#impl}`, `Tests passing {#verify}` |
| Interface | `Purpose`, `Kind`, `Exposed Interactions`, `Spec`, `Acceptance Criteria`, `Atomic Ops`, `Attachments` | `Spec written {#spec}`, `Implementation complete {#impl}`, `Verified against exposed Interactions {#verify}` |
| Bug | `Summary`, `Repro Steps`, `Expected / Actual`, `Fix Checklist`, `Attachments` | `Root cause identified`, `Fix implemented`, `Regression test added` |

A Bug is created in state `open` (§3.4); every other node in `draft`. Default items are placeholders: teams SHOULD replace them with real PR-sized Atomic Ops during `draft` (a Bug: during triage). `open_next` starts each revision with the same defaults (§3.3).

#### 6.3.1 Declared file ownership

`create_node` scaffolds territory only: a Foundation, Interaction, or Interface declares its files afterward with `set_implementation_files`, and the graph plus `implements` claims, not a prescribed `src/<type>/<id>/` tree, is the architecture authority (§1.2).

### 6.4 MDX Component Contract

**Not implemented.** No renderer exists. The server only writes the scaffold comment (§6.3) — naming `AtomicOp`, `AcceptanceCriteria`, `Attachment`, `StateBadge`, `DependsOn`, and `BelongsTo`, or for a Bug `Affects`, `ReproSteps`, `Severity`, and `ExpectedActual` — and creates `mindplan/components/`. Node files are MDX, so JSX MAY appear in a body; this section reserves component names for a future viewer, and §6.4.4 is normative today.

#### 6.4.1 Two component tiers

**Standard library** components are provided by MindPlan, versioned with the server and spec, with the same meaning in every project; host projects MUST NOT implement or shadow them. **Project components** live in the host's `mindplan/components/` and are opaque to MindPlan. MindPlan depends on nothing in the host's stack: a project that never uses JSX is fully compliant.

#### 6.4.2 Standard component set (reserved names)

Reserved in every MindPlan project; a future viewer MUST implement them with these props. All are presentation only: the Markdown checkbox and the frontmatter edges stay the authority.

`AtomicOp` (`done`) · `AcceptanceCriteria` · `Attachment` (`file` relative to `attachments/`, `caption?`) · `StateBadge` (`state?`, default the frontmatter `state`) · `DependsOn`, `BelongsTo`, `Exposes`, `LeadsTo`, `Affects` (`id`: an inline link to that node) · `ReproSteps` · `Severity` (`level: low | medium | high | critical`) · `ExpectedActual` (`expected`, `actual`)

Future spec versions MAY extend this set; they MUST NOT change the semantics of existing names.

#### 6.4.3 Project components

Project components live in `mindplan/components/` (any layout; `.tsx`/`.jsx` recommended), MAY be referenced from any live or revision file, MUST NOT use a reserved name, and are ignored by the MCP server and the compiler rules: a missing or broken one MUST NOT block any state transition.

#### 6.4.4 Compiler independence (normative)

The compiler MUST NOT parse, resolve, or evaluate JSX. Every guardrail reads only YAML frontmatter (§6.1) and Markdown task-list syntax (Completion Check, §3.3/§5.6). So:

- JSX anywhere in the body — known or unknown, well-formed or broken — has no effect on any accept/reject decision.
- `<AtomicOp done={false} />` does not count as an open checkbox. Work items that must gate `in-review`/`ship` (pipeline nodes) or `in-review`/`resolved` (Bugs) MUST be `- [ ]` Markdown items.
- Determinism (§9.1) holds: rule evaluation never depends on component resolution, a renderer, or the host project's toolchain.

#### 6.4.5 Rendering

Rendering MDX is out of scope for the MCP server. A viewer would resolve reserved names to the standard library and all other names to `mindplan/components/`. Until one exists, node files are read as plain text.

### 6.5 Minimum Territory Shape

A structural gate on the document, not a judgment of its content (Territory Completeness, §3.6, is the semantic rule). Every transition the table names checks the slot that moves (the revision of the change moved, else `<id>.mdx`) and MUST fail with one `Blocked: Minimum Territory Shape. …` that lists **every** gap at once: a missing section, a prose section that is empty or still holds `create_node` placeholder text, a checklist section with no checkbox, a stub `## Impact` (§3.7), a Foundation with no role. One gap keeps its single-section wording (Appendix A); several read `Blocked: Minimum Territory Shape. "<id>"/<file> has N problems: (1) …; (2) …. Write each section before leaving draft / entering in-review / shipping.`

<!-- shape-table:start -->
| Type | Required sections | Checked when moving to |
|---|---|---|
| Foundation | `## Purpose`, `## Shared Substrate Spec`, `## Acceptance Criteria`, `## Atomic Ops` (or `## Checklist`) with a checkbox, and a `role` (frontmatter, or a role tag starting the description) | `ready`, `in-review`, `ship` |
| Interaction | `## Purpose`, `## Actor & Trigger`, `## PRD / Execution Logic` (or `## Execution Logic` / `## PRD`), `## Acceptance Criteria`, `## Atomic Ops` with a checkbox | `ready`, `in-review`, `ship` |
| Interface | `## Purpose`, `## Kind`, `## Spec`, `## Acceptance Criteria`, `## Atomic Ops` with a checkbox | `ready`, `in-review`, `ship` |
| Bug | `## Summary`, `## Repro Steps`, `## Fix Checklist` with a checkbox | `in-review`, `resolved` |

A prose section must not be empty or hold only `create_node` placeholder text. An optional `## Impact` must not be a stub. Capabilities have no required sections. `create_node` and `orient_for_work` return `shape`: each required section marked `present`, `missing`, or `stub`.
<!-- shape-table:end -->

The server holds the table as one constant; this section and the `define-entities` skill embed the copy generated from it, and the test suite fails when an embedded copy differs. The playbook points to them. Agents learn the shape before the first transition:

- `create_node`, every full `orient_for_work` reply, and `get_node_context` return `shape: { slot, gates, sections: [{ heading, kind, status }], role? }` for a node with a transition ahead (a pre-ship node, an open revision read under its change, a Bug before `resolved` / `wontfix`): each required section is `present`, `missing`, or `stub`, and `role: "missing"` appears when a Foundation has none. A Capability, a retired node, a closed Bug, and a shipped node with no open revision have no `shape`.
- The default check warns `shape: "<id>" is missing "## X" and has stub "## Y" (required before ready)` once per node whose active slot is `draft` (a Bug before `in-review`: `required before in-review`). It never fails the check.

---
## 7. Graph Assembly

There is no central graph file. At runtime the server reads the frontmatter of every `mindplan/<folder>/<id>/<id>.mdx` (`<folder>`: `capabilities`, `foundations`, `interactions`, `interfaces`, `bugs`) to assemble nodes, and expands each outgoing edge array into flat edge triples. Each `revisions/<change>/<id>.mdx` of a Foundation, Interaction, or Interface is parsed into that node's `open_revisions` (§3.6, §6.1.3). A revision's edge deltas are **not** expanded into graph edges: only `<id>.mdx` edges are live.

### 7.1 Runtime graph shape

`get_mindplan_graph` returns:

```jsonc
{
  "version": 1,
  "nodes": [ /* from frontmatter §6.1, each optionally carrying "open_revisions" (§6.1.3) */ ],
  "edges": [
    { "source": "i-checkout-split", "target": "c-ordering", "type": "belongs_to" },
    { "source": "i-checkout-split", "target": "f-db-core", "type": "depends_on" },
    { "source": "if-checkout-page", "target": "i-checkout-split", "type": "exposes" },
    { "source": "f-app-shell", "target": "if-checkout-page", "type": "mounts" },
    { "source": "i-checkout-split", "target": "i-tip-selection", "type": "leads_to" },
    { "source": "bug-race", "target": "i-checkout-split", "type": "affects" }
  ]
}
```

`version` is the graph schema generation, `GRAPH_VERSION` (currently `1`). The version stamp records it (§1.1.2).

### 7.2 Edge persistence rule

Outgoing edges are stored **only on the source node**, in frontmatter:

| Edge type | Source type | Frontmatter field |
|---|---|---|
| `belongs_to` | Interaction | `belongs_to: [capability-id, …]` |
| `depends_on` | Interaction, Interface, Foundation | `depends_on: [foundation-id, …]` |
| `exposes` | Interface | `exposes: [interaction-id, …]` |
| `mounts` | Foundation | `mounts: [interface-id, …]` |
| `leads_to` | Interaction | `leads_to: [interaction-id, …]` |
| `affects` | Bug | `affects: [interaction-or-interface-or-foundation-id, …]` |

Capabilities have no outgoing edges. Incoming relationships are derived at scan time (a Capability finds its Interactions by scanning every `belongs_to` array). A revision's edge deltas (§6.1.3) belong to its change (§3.6): they join the graph's edges only when the revision ships onto `<id>.mdx`, and a gate judging the revision sees them on the graph under its change.

### 7.3 Invariants

- Every edge endpoint MUST be an existing territory node (folder + `<id>.mdx`).
- Edge triples are unique per `(source, target, type)`.
- Edge arrays MUST appear only on the source types of §7.2.
- A revision file MUST sit beside a `<id>.mdx` of the same Foundation, Interaction, or Interface id, MUST NOT introduce a new `id`, and MUST name its folder's change.

---

## 7.4 Graph views (projections)

Exporters MAY render a deterministic projection of the assembled graph for humans (PRs, docs, local preview) as Mermaid (`flowchart`) or Graphviz DOT, through `export_mindplan_view` (§8.1) or the CLI `mindplan-mcp view`. A view MUST NOT become a second write path for nodes or edges: frontmatter stays the only graph authority (§7, §9.3).

**`mindplan/map.md`.** After every successful graph mutation (`create_node`, `link_nodes`, `unlink_nodes`, `open_next`, `discard_next`, `update_node_status`, `force_unship`) the server MUST write the full Mermaid projection to `mindplan/map.md`. It is derived output: never hand-edited, never read back as graph state, git-ignored (§1.1.2), and never listed in `changed_files`. On-demand views do not replace it unless the caller writes a file.

### Layout conventions

Informative; both exporters follow it.

| Element | Rendering |
|---|---|
| Capability | Cluster holding its Interactions; no outgoing edges |
| Interaction | Inside each Capability it `belongs_to` (Mermaid: one instance per Capability; DOT: in the lexicographically first, the others annotated). One with no `belongs_to` into a Capability in the view goes in an **Unassigned interactions** band |
| Foundation, Interface | One cluster per type |
| Bug | Overlay node |
| `belongs_to` | Encoded by clustering; no arrow |
| `depends_on` | Solid arrow |
| `exposes` | Labeled arrow, Interface → Interaction |
| `mounts` | Bold labeled arrow, Foundation → Interface |
| `leads_to` | Dashed labeled arrow (cycles allowed) |
| `affects` | Dashed arrow |
| Node label | `id · title · state` |

A node with open revisions renders once, with its live id and state; a revision has no diagram representation.

### Filters

By default a view MUST exclude `deprecated` and `cancelled` nodes and Bugs in `resolved` or `wontfix`; `include_retired: true` (MCP) or `--include-retired` (CLI) includes them. `focus` limits the view to that node and its 1-hop neighborhood (as `find_related_nodes` defines it). MDX components (§6.4) and external board sync (§10) are not graph views.

---

## 8. MCP Tool Contract

The server exposes thirty-seven tools over stdio. Inputs are validated with zod; failures follow the §5.1 error contract. A success is **compact JSON text** (no indentation) in `content[0].text`; an object payload is also returned as `structuredContent`. No tool declares an `outputSchema`. Errors are text only. Each tool description MUST lead with when to call the tool, then what it returns, and MUST describe only that tool: it MUST NOT route the agent to a skill or to another tool's behavior (the server `instructions` string carries the plan-project routing once). Every tool except the nine §1.1.2 lists passes the version gate before its handler runs.

**Annotations.** Every tool carries a `title` and MCP `annotations` from its kind, so the host can decide which calls need a per-call confirmation. `openWorldHint` is always `false`: every tool acts on the local `mindplan/` tree and the repository.

| Kind | Annotations | Tools |
|---|---|---|
| `read` | `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }` | `run_check`, `get_mindplan_graph`, `export_mindplan_view`, `find_related_nodes`, `get_node_implementation`, `get_node_context`, `orient_for_work`, `get_project`, `get_rules`, `get_spec`, `get_skill`, `list_decisions`, `list_areas`, `get_blast_radius`, `doctor` |
| `destructive` (removes data or edges no undo restores) | `{ readOnlyHint: false, destructiveHint: true, openWorldHint: false }` | `unlink_nodes`, `remove_attachment`, `discard_next`, `force_unship` |
| `write` | `{ readOnlyHint: false, destructiveHint: false, openWorldHint: false }` | every other tool |

**Common parameters.** These mean the same wherever they appear; a tool entry states only how it differs.

| Parameter | Meaning |
|---|---|
| `root` | Every tool. The absolute path of a checkout or git worktree whose `mindplan/` this one call reads and writes (its source files, git probe, config, version stamp, and `.mindplan-cache/` included). Omitted: the server's project root (`MINDPLAN_ROOT`, else the working directory). A `root` that is not an absolute path to an existing directory is `Blocked: root "<path>" must be an absolute path to a checkout or git worktree` or `Blocked: root "<path>" is not an existing directory`; one with no `mindplan/` folder is `Blocked: root "<path>" has no mindplan/ folder`, except for `setup_project` and `doctor`. The version gate, the handler, and the envelope all run inside that root. A result for a root other than the server's names it: an object result gains `root` (the resolved path) unless it has its own; a `Blocked:` or plain-text result ends with ` (root: <path>)`; an array or other JSON result is unchanged. Orientation is per root (§8.1.2). The background search warm-up stays on the server's root. Parallel worktrees: §9.4. |
| `change` | Which open revision of a shipped node (§3.6) the call reads or writes, by change id. Omitted: the node's only open revision, else live when none is open. Several open and no `change` is `Blocked:` listing them (`"<id>" has open revisions "a", "b"; pass change.`). A `change` the node has no revision of is `Blocked:` too, unless the entry gives it another meaning (planning an edge, tagging a decision, a change-wide read). On a **pre-ship** node, `patch_node_territory`, `set_implementation_files`, and `set_test_files` instead set the node's change id (`""` clears; grouping only, never resets readiness); on a shipped node with no open revision they are `Blocked:` and write nothing (§3.7 Change ids). Taken by `patch_node_territory`, `set_implementation_files`, `set_test_files`, `put_attachment`, `remove_attachment`, `link_nodes`, `unlink_nodes`, `record_decision`, `open_next` (required), `discard_next`, `resolve_conflict`, `rebase_revision`, `update_node_status`, `orient_for_work`, `get_node_context`, `get_blast_radius`, and `run_check`; `create_node`, `get_mindplan_graph`, and `list_decisions` use it as stated in their entries. |
| `slot` | `current` (the live `<id>.mdx`) or `next` (the revision `change` picks). On a write (`patch_node_territory`, `set_implementation_files`, `put_attachment`, `remove_attachment`), omitted means the revision when the node is a shipped Foundation, Interaction, or Interface with one open, else live. On a read (`get_node_context`, `orient_for_work`) it returns only that slot. `next` with no open revision is `Blocked:`. |
| `verbose` | Boolean, default `false`, on the write tools that touch one node: `create_node`, `patch_node_territory`, `record_decision`, `set_implementation_files`, `set_test_files`, `open_next`, `discard_next`, `resolve_conflict`, `rebase_revision`, `put_attachment`, `remove_attachment`, `link_nodes`, `unlink_nodes`, `update_node_status`, `force_unship`. See write results. |

**Write results.** By default a write that touches one node returns the tool's own fields plus, for the touched node, `state` (live), `next_state` (the state of its only open revision, else `null`), `revisions: [{ change, state, conflicts }]` when it has open revisions (`conflicts` is a count), and `changed_files`. No record, neighborhood, or drift, so one write stays under about 1k tokens. `verbose: true` adds `anchor` (`{ record, neighborhood, next }`) and `drift`. Every successful graph mutation MUST include `changed_files: string[]`: the repo-relative paths written or deleted (territory files, including the live file of a node whose stability was recomputed; every revision file a ship, discard, or retire deleted; every sibling revision file a ship rebased; every decision file moved; scaffolds and attachments). `mindplan/map.md` is never listed (§7.4). Agents SHOULD show these paths to humans, because many hosts do not list MCP subprocess writes as edited files. A result MAY also carry `removed_legacy_files` (§1.1.2).

**Result size.** A host truncates an over-limit result silently (Claude Code: 25,000 tokens; claude.ai: about 150,000 characters). The two tools whose result grows with the graph bound it: `get_mindplan_graph` pages, and `export_mindplan_view` refuses an over-budget diagram with the fix.

**Drift.** A successful `read` result MAY carry `drift` when the uncommitted working tree has source files in the ownership universe, tracked paths deleted from disk included; a `write` or `destructive` result carries it only with `verbose: true`. `get_project` and `get_rules` MUST NOT carry it (`get_rules` runs before every action, and `orient_for_work` already carries the report); neither do `get_spec`, `get_skill`, `run_check`, `doctor`, `acknowledge_warning`, `setup_project`, or `upgrade_project`. The report is scoped to the node the result is about (`node_id`, orient `focus`, link ends, created node); with no node it covers the whole tree. Envelope: `{ paths: [{ path, owner_id, state, next_state, class }], unowned: string[], expected: number, other_count?: number, more?: number, reminder: string }`. Each dirty file is classified:

- `unowned` — an in-universe file no node claims (listed in `unowned`);
- `owner_idle` — its owner has no open update: a shipped node with no open revision, or a pre-ship node not `in-progress` (listed in `paths`);
- `claimed_missing` — a claimed path gone from disk, such as a deleted tracked file; it keeps the owner of the file or directory claim covering it (listed in `paths`);
- expected — the owner has an open update claiming the file (an open revision, the node itself `in-progress`, or a Bug in `fixing` / `in-review`); only counted in `expected`.

When scoped, files owned by other nodes only count in `other_count`. Each list holds at most 20; `more` counts the rest. `drift` is omitted when there is nothing to act on (clean tree, git unreadable, or only expected edits). It is never a `Blocked:` and MUST NOT change the default `mindplan-mcp check`.

### 8.1 Read tools

#### `get_mindplan_graph`

One page of the graph assembled from territory frontmatter (§6.1, §7). For one piece of work, prefer `orient_for_work`.

- **Input:**
  - `offset` (integer ≥ 0, default `0`) — index of the first node, in id order
  - `limit` (integer 1..500, default `200`) — nodes per page
  - `state` (a node state or an array) — any build-pipeline or Bug state, matched against the node record's `state` (a shipped node with an open revision keeps its live state there)
  - `type` (a node type or an array) — `Capability`, `Interaction`, `Interface`, `Foundation`, `Bug`
  - `change` (change id) — the nodes holding an open revision of this change, and pre-ship nodes whose `change` field it is
  - `fields` (array of node record field names) — the fields each node returns; `id` is always included. A node with several open revisions has no `next`, so when `fields` names `title`, `description`, or `next` it also returns its `open_revisions` summary. Projection never changes which nodes or edges are returned.
  - `edges` (`true` | `false` | array of edge types, default `true`) — `true`: every edge whose source is in the page; `false`: neither `edges` nor `total_edges`; an array (`belongs_to`, `depends_on`, `exposes`, `leads_to`, `affects`, `mounts`; OR) keeps only those types. Edge selection never changes which nodes are returned, sorted, or paged.
- **Filters:** filters combine with AND, values inside one array with OR. Filtering happens before sorting and paging, so `total_nodes`, `offset`, `limit`, and `next_offset` describe the filtered set. With no filter, `fields`, or `edges`, the output is the unfiltered graph. Example: `state: ["draft", "ready"]`, `fields: ["id", "type", "title", "change"]`, `edges: false` lists what is planned but not built.
- **Output:** `{ version, nodes, edges?, total_nodes, total_edges?, offset, limit, next_offset? }`. `nodes` is sorted by id and sliced by `offset` / `limit`; a node with open revisions carries `open_revisions: [{ change, state }]` only (read one with `get_node_context({ node_id, change })`). `edges` holds every selected edge whose **source** is in the page, so a walk over every page sees each node and edge exactly once; `total_edges` counts the selected edges of the filtered set. `next_offset` is present only while nodes remain. A graph that fits one page returns whole; an `offset` past the end returns an empty page with the totals.
- **Errors:** `limit` above 500 fails at the schema layer. An unknown name in `fields` fails before any node is read: `Blocked: get_mindplan_graph fields: unknown field "<name>". Valid fields: <list>.` So does an unknown edge type: `Blocked: get_mindplan_graph edges: unknown edge type "<name>". Valid edge types: depends_on, belongs_to, exposes, leads_to, affects, mounts.` Otherwise only I/O failures.

#### `export_mindplan_view`

A deterministic projection (§7.4) as Mermaid or DOT, for a human diagram. For agent orientation, prefer `find_related_nodes`. It never writes `mindplan/map.md`.

- **Input:**
  - `format` (`mermaid` \| `dot`, default `mermaid`)
  - `focus` (slug) — export that node and its 1-hop neighborhood only
  - `include_retired` (boolean, default `false`) — include deprecated / cancelled nodes and closed Bugs
  - `decisions` (boolean, default `false`) — label each node that has active decisions (§6.1.2) with their count (` · 2 decisions` in Mermaid, a label line in DOT); `mindplan/map.md` never carries the counts
  - `output` (string) — repo-relative path to write the diagram to; MUST resolve inside the project root and outside `mindplan/`. The result then carries `written_to` (repo-relative POSIX path) and no `diagram`.
- **Result budget:** without `output`, a diagram over 80,000 characters is `Blocked:` with its size, the budget, and the two fixes (`focus`, `output`), because a host would cut it silently and a cut diagram renders nothing. The CLI `view` / `export` never applies the budget.
- **Output:**

```jsonc
{
  "format": "mermaid",
  "focus": null,           // or node id when focus was requested
  "include_retired": false,
  "decisions": false,
  "node_count": 12,
  "edge_count": 15,
  "diagram": "flowchart TB\n..."
}
```

- **Errors:** unknown `focus`; `output` outside the root or under `mindplan/`; a diagram over the budget without `output`.

#### `find_related_nodes`

Ranks nodes for a text query and returns the focus node plus its 1-hop neighborhood. Reads no `<id>.mdx` or revision bodies and no transitive blast radius (`get_blast_radius`).

- **Input:**
  - `query` (string) — free text, ranked by the hybrid search (§8.1.1)
  - `node_id` (slug) — force the focus to this node
  - `type` (`Capability|Foundation|Interaction|Interface|Bug`) — filter candidates before ranking
  - `limit` (integer 1–20, default `5`) — max ranked matches
  - `area` (Capability id) — rank only that Capability's members: the Capability, its Interactions, the Interfaces exposing them, and the Foundations they depend on transitively (live and proposed edges). A non-Capability id is `Blocked:`.
  - At least one of a non-empty `query` or `node_id` is required.
- **Focus:** `node_id` when given (after an existence check), else the top match, else `null`.
- **Neighborhood:** every edge (any type) whose `source` or `target` is the focus; `nodes` holds the focus and every endpoint of those edges, as summaries (`id`, `type`, `state`, `title`, `description`).
- **Output:**

```jsonc
{
  "query": "checkout split payment",
  "matches": [
    { "id": "i-checkout-split", "type": "Interaction", "state": "in-progress", "title": "...", "description": "...", "score": 12 }
  ],
  "focus": "i-checkout-split",
  "nodes": [ /* focus + 1-hop neighbors */ ],
  "edges": [ /* edges incident to focus */ ]
}
```

- **Errors:** neither `query` nor `node_id`; unknown `node_id`. A valid query with no match and no `node_id` succeeds with `focus: null` and empty `nodes` / `edges`.

#### `get_blast_radius`

What a change to a node, or to a whole change, reaches.

- **Input:** `node_id` (slug), `change` (change id, §3.7), or both; `include_retired` (boolean, default `false`); `include_dependent_decisions` (boolean, default `false`).
- **Output (`node_id`):**

```jsonc
{
  "node_id": "i-checkout-split",
  "affected": [
    { "id": "if-checkout-page", "type": "Interface", "state": "ready", "distance": 1 }
  ],
  "capabilities_at_risk": ["c-ordering"],
  "affected_files": [
    {
      "owner_id": "if-checkout-page",
      "owner_type": "Interface",
      "via": ["exposing", "importer"],
      "files": ["src/interfaces/if-checkout-page/page.tsx"]
    }
  ],
  "tests": ["tests/checkout-split.test.ts"],
  "decisions": [
    { "id": "d-split-by-seat", "node_id": "i-checkout-split", "via": "focus", "distance": 0, "decision": "Bills split by seat, not by item." }
  ],
  "dependent_decisions": { "count": 0, "nodes": [] },
  "rules_impact": {
    "has_rules": true,
    "inherited_by": [
      { "id": "i-checkout-split", "type": "Interaction", "state": "stable", "via": "depends_on", "distance": 1 }
    ]
  },
  // only when the focus is an Interaction:
  "reachability": {
    "exposing_interfaces": [{ "id": "if-checkout-page", "type": "Interface", "state": "ready", "title": "...", "description": "..." }],
    "containing_capabilities": [{ "id": "c-ordering", "type": "Capability", "state": "incubation", "title": "...", "description": "..." }],
    "leads_to_downstream": [{ "id": "i-tip-selection", "type": "Interaction", "state": "draft", "title": "...", "description": "...", "distance": 1 }]
  }
}
```

  - `affected` — the transitive reverse-`depends_on` closure (BFS) from `node_id`, the seed left out. Cancelled and deprecated nodes are left out unless `include_retired`; BFS still traverses them, so a live dependent behind one keeps its true distance.
  - `capabilities_at_risk` — the Capabilities that visible affected Interactions (and a focus Interaction) `belongs_to`.
  - `affected_files` — grouped by owner, sorted by `owner_id`, files deduplicated, several reasons merged into one entry. `via`: `focus` (the node's own files), `dependent` (files of reverse-`depends_on` dependents), `exposing` (files of Interfaces exposing a focus Interaction), `importer` (other nodes' files that import the focus node's files).
  - `tests` (always) — the expanded `tests` (§6.1) of the focus and of every owner in `affected_files`, sorted: the suites a change should run.
  - `rules_impact` (always) — `has_rules` (the focus carries node rules, §6.1.1) and `inherited_by`, its rules audience as `{ id, type, state, via, distance }`; empty when there are no rules or no audience. Independent of `affected`: a Capability's audience is its Interactions. Inactive nodes (retired, closed Bugs) are never listed, whatever `include_retired` says.
  - `decisions` (always) — the active decisions (§6.1.2) the focus holds (`via: focus`, distance 0), each `{ id, node_id, via, distance, decision }`; with `include_dependent_decisions`, the rows of the visible `affected` nodes follow (`via: dependent`, their distance). `dependent_decisions: { count, nodes }` (always) counts the active decisions those nodes hold and names them, nearest first. Superseded decisions and those of inactive nodes are never listed or counted, even with `include_retired`.
  - `reachability` (focus is an Interaction) — `exposing_interfaces` (Interfaces with an `exposes` edge to it), `containing_capabilities` (what it `belongs_to`), `leads_to_downstream` (the transitive forward `leads_to` closure, BFS, cycles cut by a visited set, each with `distance`); retired nodes are left out unless `include_retired`.
  - A node with open revisions lists them in `open_revisions: [{ change, state }]`.
- **Output (`node_id` + `change`):** the same, judged for that node's revision of the change on the graph under the change (§3.6): its claims, tests, and edges are live ⊕ the revision. `Blocked:` when the node has no open revision of the change.
- **Output (`change` alone):** `{ change, additivity, members: [{ id, type, kind, change?, state, next_state }], planned_edges: [{ source, type, target }], affected, capabilities_at_risk, affected_files, tests, rules_impact, decisions, dependent_decisions }`: the radii of every member (revisions and planned sources, §3.7; `kind` is `"revision"` or `"planned"`) merged. `affected` keeps each node's smallest distance and leaves out the members; `affected_files` merges groups per owner; `tests` is the sorted union; `rules_impact` is keyed by member id; `decisions` merges per decision id (a member's own decisions are `focus`); `dependent_decisions` counts each non-member holder once, nearest to any member first; `additivity` is the change's additivity (§5.15). `Blocked:` when the change has no members.
- **Errors:** unknown `node_id`.

#### `get_node_context`

One node's territory: record, body, rules, decisions, and attachments. A call orients on the node (§8.1.2).

- **Input:** `node_id` (slug); `change`, `slot` (§8: `current` leaves `next` as `{ record }` while a revision is open; `next` leaves out the live `body` and `decisions`; omitted, both come back); `section` (a level-2 heading such as `## Spec`) cuts each returned body to that section and adds `section` to the payload, and a heading missing from a returned body is `Blocked:` listing its sections, so a large node is read a section at a time; `include_superseded` (boolean, default `false`; the same default and flag as `list_decisions` and `orient_for_work`); `include_inherited_decisions` (boolean, default `false`).
- **Output:** always the live `<id>.mdx` slice:

```jsonc
{
  "folder": "mindplan/interactions/i-checkout-split",
  "current_path": "mindplan/interactions/i-checkout-split/i-checkout-split.mdx",
  "attachments_path": "mindplan/interactions/i-checkout-split/attachments",
  "attachments": ["checkout-wireframe.png"],
  "record": {
    "id": "i-checkout-split",
    "type": "Interaction",
    "state": "in-progress",
    "title": "Split & pay checkout",
    "description": "Diner splits and pays the bill from their phone",
    "created_at": "...",
    "updated_at": "...",
    "belongs_to": ["c-ordering"],
    "depends_on": ["f-db"],
    "leads_to": ["i-tip-selection"]
  },
  "body": "# Split & pay checkout\n\n...",   // never includes the `## Rules` section
  "rules": "- Money is integer cents.",       // the node's own rules; "" when none
  "decisions": [                              // the node's own decision records (§6.1.2), each with status
    { "id": "d-split-by-seat", "decision": "...", "alternatives": ["..."], "why": "...", "node_id": "i-checkout-split", "node_type": "Interaction", "status": "active" }
  ],
  "inherited_decisions": { "count": 0, "nodes": [] },
  "resolved_rules": { "node_id": "i-checkout-split", "entries": [] },
  "next": null
  // when a revision is read, the payload also carries:
  //   "revisions": [{ "change": "split-tips", "state": "in-progress", "conflicts": 0 }],
  //   "next_path": ".../revisions/split-tips/<id>.mdx", "next_attachments_path": ".../revisions/split-tips/attachments",
  //   "next": { "record": { state, title, description, updated_at, change, belongs_to?, depends_on?, exposes?, leads_to? }, "body": "...", "decisions": [...] }
}
```

  - `decisions` and `next.decisions` leave out superseded records unless `include_superseded` (each then names `superseded_by`). Status is computed over every decision file (§6.1.2), so a live decision superseded by one in an open revision is left out of the live `decisions` too, until that revision is discarded.
  - `inherited_decisions: { count, nodes, entries? }` names every other decision reaching the node through node-rules inheritance (a Bug: those of the nodes it affects too, whole at distance 1); `entries` only with `include_inherited_decisions`.
  - `resolved_rules` holds every node rule that reaches the node (§6.1.1). `shape` (§6.5) is present while the node has a transition ahead.
  - **Revisions:** a node with open revisions carries `revisions: [{ change, state, title?, conflicts }]` (`title` only when it differs from live, `conflicts` a count, no bodies). `next` is the revision of `change`, else the only open one: its effective record (live ⊕ the revision, §3.6), its body (no Rules section; rules are live only), and its decisions (live, then the revision's). With several open and no `change`, `next` is the string `"pass change to read a revision"` and only live comes back. With `change`, the reply also carries `unlocks: "<change>"`.
  - `title` and `description` appear only on `record`.
- **Errors:** unknown `node_id`; missing `<id>.mdx`; the `change` and `slot` errors of §8.

#### 8.1.1 Search

`find_related_nodes` and `orient_for_work` rank through one hybrid search.

- **Source of truth.** The `<id>.mdx` files are the only source of truth. Search runs on a derived SQLite cache, `.mindplan-cache/index.db` at the project root (Node's built-in `node:sqlite`). It is git-ignored (the folder carries its own `.gitignore`, and the setup guide has the agent add `.mindplan-cache/` to the repo's), rebuilt from the files, and safe to delete at any time. It is not a graph file: never listed in `changed_files`, never part of the coverage universe.
- **What is indexed.** The unit of retrieval is a node; bodies are never chunked. The indexed and embedded text is `"{type}: {title}. {description}. Area: {Capability titles}. Entry points: {Interface titles}. Aliases: {aliases}. Sections: {## headings}"`, from live's title, description, and body. Each open revision whose title or description differs adds its wording (tagged with its change) and its body's headings, and every revision's edge adds count toward Area and Entry points, so a node is found by its new wording while it is being reshaped. Area is the Capabilities a node belongs to (an Interface: those of the Interactions it exposes; a Bug: those of the Interactions it affects); entry points are the Interfaces exposing it. Headings leave out scaffold sections and any heading most nodes share. The keyword index also holds the id and the claimed paths, split into words.
- **Keyword half.** FTS5 `bm25` over those columns (porter stemming), top 50. When `node:sqlite` or FTS5 is unavailable (Node 22.13's bundled SQLite has no FTS5), or the query fails, the keyword half is the same BM25 computed in JS: the same fields and weights, FTS5's `bm25()` formula, Unicode words with diacritics folded, light stemming.
- **Semantic half.** Cosine similarity between the query and each node's normalized embedding from a local transformers.js model (`search.model`, default `Xenova/bge-small-en-v1.5`, 384 dimensions), top 50 within 0.12 of the best hit. The model downloads once per machine into `~/.cache/mindplan/models` (override with `MINDPLAN_MODEL_CACHE`) and loads in the background at server start. Until it is ready, when it cannot load (offline, proxy, sandbox, `@huggingface/transformers` not installed), with `search.enabled: false`, or with `MINDPLAN_SEARCH=keyword`, search is keyword-only and never errors; the reason is logged once to stderr. `MINDPLAN_SEARCH_OFFLINE=1` uses only an already-downloaded model.
- **Fusion.** Reciprocal rank fusion, `score = Σ 1/(60 + rank)`, then a bonus of one rank step for each node one `belongs_to`, `depends_on`, `exposes`, or `mounts` link from a top-3 node (it breaks near-ties and never reorders a clear winner). Then the shortcuts: an exact `id` ranks first, then the owners of a claim that matches a path query. `score` is the fused score: higher is better, comparable only within one reply. A `type` filter applies before ranking; retired nodes (`deprecated`, `cancelled`, closed Bugs) never rank.
- **Keeping it current.** On server start and after every successful graph write, the cache syncs and re-embeds only nodes whose text changed. Each search loads the graph and re-syncs from it first, so edits made outside MCP (`git pull`, a branch switch) are found on the next call. A change of schema version, model, or vector size drops and rebuilds the cache. A call never waits on the model download or a full re-embed: when more than a few nodes need new vectors, that call is keyword-only and the embedding finishes in the background.

#### `orient_for_work`

Orientation, summary first. A `query` alone returns ranked rows to pick from; `node_id` returns that node in full (territory, rules, own decisions, owned files, and its blast radius when it is a Foundation, Interaction, or Interface); `change` alone orients on a whole change.

- **Input:** `query`, `node_id`, `type`, `area` as in `find_related_nodes`; `limit` (1–20, default `8` for a query alone, `5` with `node_id`); `change` (alone: the change-wide reply; with `node_id`: that node's revision of it); `depth` (`rules` \| `body` \| `full`, default `full`); `include_superseded` (boolean, default `false`); `include_inherited_decisions` (boolean, default `false`); `known_rules_versions` (object: node id → rules version); `slot` and `section` (as in `get_node_context`); `sections` (string array).
- **Summary (`query`, no `node_id`):** `{ query, matches, focus: null, next }`. `matches` are rows `{ id, type, state, title, description, area?, score }` from the hybrid ranking (§8.1.1), `description` cut to 70 characters and `area` (Capability titles) omitted when empty. No body, neighborhood, blast radius, rules, or decisions: under 2 KB for 10 rows. `next` names the call to make.
- **Auto-focus:** when the top row is a clear winner (the query is its exact id, it is the only match, or its fused score is at least twice the next one's), the reply is the full node plus the rows and `auto_focus: true`. A full reply (`node_id` or auto-focus) orients on the node (§8.1.2).
- **Depth:** `rules` — the focus's `rules` block and `context.record` (and `context.next.record`) only; `slot` and `section` are ignored. `body` — also `context` (body, attachments) of one slot, the active one by default (the revision read as `next`, else `current`), cut to `section` when given, plus, for a pipeline node, `files: { files, next_files?, revision_files? }`, its expanded claims (`revision_files`, keyed by change, when several revisions are open). `full` — everything.
- **Output (`full`):** `{ query, matches, focus, nodes, edges, context, blast_radius, rules, decisions }`, plus `files`, `revisions`, `shape`, `stability`, and `open_items` below.
  - `nodes`, `edges` — the 1-hop neighborhood.
  - `context` — as `get_node_context` with the same `slot` and `section`, without `decisions`, `next.decisions`, and `inherited_decisions` (the `decisions` block is the reply's only copy), when `focus` is set, else `null`.
  - `blast_radius` — the default `get_blast_radius` (so it carries the focus's own decisions and `dependent_decisions`, and `reachability` for an Interaction) for a Foundation, Interaction, or Interface focus, else `null`.
  - `rules` — `{ node_id, entries }`: the focus's resolved node rules (§6.1.1), each `{ node_id, node_type, via, distance, rules, version }`, labeled with the node it came from and ordered self, `belongs_to`, `depends_on`, `affects`; `[]` when nothing applies. `version` tags the entry's text like `rules_version`; an entry whose version equals `known_rules_versions[node_id]` leaves out `rules` and carries `unchanged: true`. Project rules are not repeated (`get_rules`).
  - `decisions` — `{ node_id, entries, inherited_decisions }`, at every depth. `entries` are the focus's own records (§6.1.2, `via: self`; a Bug: those of the nodes it affects directly, `via: affects`, distance 1), each a record plus `{ node_id, node_type, via, distance, status }`; superseded ones only with `include_superseded` (each then names `superseded_by`). `inherited_decisions: { count, nodes }` counts the decisions reaching the focus through the rest of the node-rules inheritance (`belongs_to`, `depends_on`, a Bug's further `affects`) and names their nodes, nearest first; `include_inherited_decisions` adds `entries`, ordered like rules: whole records at distance 1, one line `{ id, node_id, distance, decision }` beyond (with `status` and `superseded_by` when superseded; `list_decisions` gives the full text). At `depth: "rules"` each entry is compact (`id`, `decision`, `why`, and its labels), because orientation runs before every action; the other depths return whole records.
- **Output (`rules` / `body`):** `{ query, matches, focus, context, rules, decisions }` (and `files` at `body`): no `nodes`, `edges`, or `blast_radius`.
- **Revisions:** a node with open revisions lists them in `revisions: [{ change, state, title?, conflicts }]` (as in `get_node_context`). With `change`, the reply reads that revision (its view, body, shape, and a blast radius judged under the change) and carries `unlocks: "<change>"`. A node with no revision of `change` is `Blocked:`, unless it is a pre-ship member of that change (its `change` field names it): its live file is the change's, so the reply reads it and carries `unlocks`, and `slot: "next"` is `Blocked:` (omit `slot`). Without `change`, a node with one open revision reads it; with several, the body is live and `next` says to pass `change`.
- **Shape:** every full reply carries `shape` (§6.5) while the node has a transition ahead.
- **Stability:** at `depth: "full"`, a Foundation, Interaction, or Interface carries `stability: { fan_in, rate, median_rate, revisions?, split_at?, split_into?, hotspot?, fan_out? }` (§5.15). `hotspot` is the hotspot warning line when the node is one. `fan_out: { count, changes }` is present on a pre-ship node (even at count 0 and even when kept whole) and absent on a shipped one.
- **Open items:** a node reply (any depth) carries `open_items: [{ node_id, change?, id?, kind, text }]` when the node has unticked `review` or `deploy` items (§3.3) in its live pre-ship file or an open revision; the change reply carries its members'. They wait on people: the agent reports them instead of ticking them.
- **Change (`change`, without `query` or `node_id`):** `{ change, members, rules, decisions, next }`. `members` are the nodes holding the change's open revisions (each judged as its revision of the change), its planned sources (§3.7), and every other active node holding an active decision recorded under the change (`kind: "decision"`: a decision gives its node no change id, so these are members of this reply only, not of `run_check`, `get_blast_radius`, or scoped walks). Each member is `{ id, type, state, next_state?, kind, rules_from }`, `rules_from` naming the nodes whose rules reach it. `rules` holds each source's entry once, `{ node_id, node_type, version, rules }` (no text and `unchanged: true` when `known_rules_versions` holds its version). `decisions` is `{ count, nodes }` over the members' own active decisions. The reply orients on every member (§8.1.2). A change with no members and no decision recorded under it, or `change` with `query`, is `Blocked:`.
- **Sections:** `sections` returns only the named parts plus the identity fields (`query`, `focus`, `auto_focus`, `unlocks`, `change`, `members`, `next`). Valid names: `rules`, `decisions`, `record`, `body`, `files`, `shape`, `revisions`, `open_items`, `blast_radius`, `stability`, `neighborhood` (`nodes` and `edges`); `record` and `body` are cut from `context` (and `context.next`). An unknown name is `Blocked:` and lists the valid ones. Omitted: every part `depth` returns. A reply cut to sections **without** `rules` does not orient (§8.1.2).
- **Errors:** those of `find_related_nodes`; an unknown `depth`; an unknown section.

#### `list_areas`

Capability-first orientation: call it when unsure where work lands, then `orient_for_work({ query, area })`; a question that cuts across Capabilities searches without `area`.

- **Input:** none.
- **Output:** `{ columns, rows, count }`. `columns` is `["id", "title", "description", "interactions", "interfaces", "foundations", "open_bugs"]`; each row is one active Capability, sorted by id: its title, its description cut to 60 characters, the counts of its active members (its Interactions, the Interfaces exposing them, the Foundations they depend on), and the open Bugs affecting any of them. 30 Capabilities stay under 4 KB.

#### 8.1.2 Orientation gate

Node rules are mandatory, and orientation returns rows first, so the server keeps an in-memory **orientation ledger** per MCP session (one server process), keyed by graph root (§8 `root`) and node id: orienting in one checkout never unlocks a write in another.

**Entering the ledger.** A node enters it, with a fingerprint of the rules that reach it, through:

- a full `orient_for_work` reply (`node_id` or `auto_focus`; with `sections`, only a reply that includes `rules`), or a change-wide reply, which enters every member;
- `get_node_context` (which carries `resolved_rules`);
- its own `create_node` result (which carries `rules`);
- a `link_nodes` / `unlink_nodes` result that changed the rules reaching it (which then carries them as `rules`).

These `rules` fields appear only while the gate is on. `patch_node_rules` keeps its author in the ledger.

**Project rules gate.** The ledger also keeps, per graph root, the `rules_version` of the project rules (§1.1.1) that reached the session: through `get_project`, `get_rules`, the author's own `patch_project_rules`, or a `project_rules` push. Every `write` or `destructive` tool behind the version gate (all but `setup_project` and `upgrade_project`) is `Blocked: Rules: <tool> acts before the project rules reached you in this session. Call get_project (or get_rules), with the same root when you passed one, read the rules, then retry.` until then, and `Blocked: Rules: the project rules changed since they reached you. Call get_rules, read them, then retry <tool>.` after another session changed them. Every reply that orients (`orient_for_work` with `rules` in its sections) carries `project_rules: { path, rules, rules_version }` when the rules have not reached the session or changed since, and records them as served; otherwise the field is absent. So no call before each action is needed: the rules arrive once, and again when they change. The CLI is never gated; `MINDPLAN_ORIENT_GATE=off` turns this gate off with the orientation gate. The fingerprint covers the node's own rules and every inherited entry, resolved over live edges plus the `belongs_to` / `depends_on` adds of every open revision of the node, so one orientation covers writes to any of its revisions and a revision is built against the rules its new edges bring. `orient_for_work`'s `rules` block resolves over the same edges; decisions and the rules audience (`rules_impact`) follow live edges only.

**Gated writes.** These writes are `Blocked: Orientation: <tool> acts on …`, naming the fix (`orient_for_work({ node_id: "<id>" })`), when the node is not in the ledger or the rules reaching it changed since: `set_implementation_files`, `set_test_files`, `update_node_status` (every node a single, batch, or scoped walk transitions; a `dry_run` is not gated), `resolve_conflict`, `rebase_revision`, `discard_next`, `patch_node_territory` (checkbox toggles included), `patch_node_rules`, `open_next`, `record_decision`, `put_attachment` / `remove_attachment`, `force_unship`, and `link_nodes` / `unlink_nodes` on the source (`link_nodes` after its own validation). An id that does not exist reports that instead. One `Blocked: Orientation` names every unoriented node of the call: one node keeps the wording above; several are listed (`"<id>" (not oriented on in this session)` or `(rules changed since)`), and a `scope: "change"` walk names `orient_for_work({ change: "<change>" })`, which orients on every member at once. `create_node` is never blocked. The CLI has no session and is never gated; `MINDPLAN_ORIENT_GATE=off` turns the gate off for one server process.

#### `run_check`

Runs the same check as `mindplan-mcp check` (§9.6). When to call it: §9.6.

- **Input:** `base` (git ref) — opt-in dirty-src (`--base`) and the strict merge gate's base; `change` (change id); `merge` (`true` or `"strict"`) — the merge gate (`--merge` / `--merge=strict`); `after_merge` (boolean) — the after-merge check (`--after-merge`); `compact` (boolean, default `true`); `nodes` (node ids).
- **Output (compact, the default):** `{ ok, counts, failures, warnings: [{ id, text }], acknowledged, unchanged, info, change?, merge?, removed_legacy_files? }`. `counts` maps each warning category (the warning's `<word>:` prefix — `stale`, `description`, `shape`, `hotspot`, …, else `other`) to its count. `failures` lists every failure once. `warnings` holds only the warnings that no earlier check of this root in this MCP session showed and that are not acknowledged; `unchanged` counts those an earlier check showed, `acknowledged` those acknowledged (`acknowledge_warning`). A warning's **id** is `w-` plus the first 10 hex characters of the SHA-1 of its text, so a warning whose text changes gets a new id and shows again. Shown ids are kept in memory per root for the server process (a new session shows every warning once again); only acknowledgements are stored on disk. `info` holds the `Info:` lines (`planned:`, `waiting on people:`, …).
- **Output (`compact: false`):** `{ ok: boolean, output: string, failures: string[], warnings: string[], info: string[], change?, merge?, removed_legacy_files? }`. `output` is exactly what the CLI prints (which is always this full output): `mindplan-mcp check: ok`, or one `Blocked:` line per failure (an illegal import names its fix), then `Warning:` lines, then `Info:` lines (§9.6).
- **`nodes`:** warnings (compact or full) are limited to those naming a listed node, and a compact result lists **every** one of them, seen before or not (acknowledged ones excepted), so none counts as `unchanged`. Failures stay graph-wide (`ok` judges the whole graph); compact `counts.out_of_scope` says how many warnings were left out.
- **`after_merge`:** each leftover of a git merge of graph-changing branches is a `Blocked: after-merge: …` failure naming its fix, and a revision based on an older live is a `Warning: after-merge: …` naming `rebase_revision` (§9.6).
- **`change`:** also runs the in-review gate on every revision of the change (§3.7). Import and ownership violations on each revision's files, judged under the change (§3.6), are added to `failures` as `Blocked: change "<id>": …` (so `ok` is false), except one the global import rule already reported. Every stale-text signal for the revisions is added to `warnings` (their `planned:` lines to `info`), with their decision warnings (§5.13) and `fan-out:` lines (§5.15). The output adds `change: { id, members: [{ id, type, state, next_state, kind }] }`, `kind` being `"revision"` or `"planned"`. A change with no members is a `Blocked:` failure.
- **`merge`:** adds the `Blocked: Merge` lines (§9.6) to `failures`, and the output adds `merge: { level: "default" | "strict", base?, changes: [{ change: string | null, nodes: [{ id, type, state, slot: "live" | "revision", files?, stale? }] }] }` (`base` names the compared base), one group per change id (`null` for nodes with none, last). Agents run it before telling the user a PR is ready to merge.
- **Errors:** a failed check is a successful call with `ok: false`, including a git failure with `base` set, an invalid config, or a graph that is not `current` (its only failure is `Blocked: Version — <warning>`, §1.1.2), each reported as a `Blocked:` failure.

#### `doctor`

The server's health, for a slow attach, a server serving the wrong folder, or a graph tool failing in a way its message does not explain. Answers for a `root` with no `mindplan/` (§8 `root`), writes nothing, and never throws.

- **Input:** none besides `root`.
- **Output:** `{ version, node, root, graph: { status, level, server_level }, load_ms_cached, cache_hit, load_error?, cache: { graph, search }, started_at, uptime_s }`: the package version and `process.version`; the project root served; the graph status (`setup` \| `upgrade` \| `server-behind` \| `current`, §1.1.2), the stamp's migration level, and the server's; how long a graph load takes through the graph cache (`load_ms_cached`), with `cache_hit` saying whether the cache served it (the cache has no bypass, so a cold load or a graph with no node folders shows `cache_hit: false`; §1.1.3); whether `.mindplan-cache/graph.db` and `.mindplan-cache/index.db` exist; the server's start time (ISO) and uptime in seconds. Only a `current` graph is loaded, and not when the load would remove legacy files (§1.1.2); otherwise `load_ms_cached` is `0` and `load_error` says why (`not loaded: <reason>`). A load that fails gives its message.

#### `get_project`

Live read of the systems dialect and the project brief (§1.1.1). Call before the first answer or code change in a session, and again after the product description or rules change; not before every action.

- **Input:** none.
- **Output:**

```jsonc
{
  "path": "mindplan/project.md",  // local path today; MAY be null when storage is remote
  "description": "What this product is…",
  "rules": "- Standing constraint…",
  "rules_version": "3f9c1a0b2d4e",  // tag of rules; pass to get_rules as known_version
  "playbook": "# MindPlan — think in systems\n…",  // always the bundled systems dialect
  "check": "Run the check with the run_check tool (CLI: mindplan-mcp check) before …",  // names the integrity check
  "version": "This graph needs an upgrade: … Call upgrade_project, then commit the upgrade on its own.",  // only when the graph is not current (§1.1.2)
  "restart": "mindplan-mcp 0.19.0 is installed, but this server is still running 0.18.1, …"  // only when the package was replaced under the running server
}
```

`playbook` is always the package's `templates/agent/playbook.md`. `check` is a fixed sentence naming the `run_check` tool and the CLI `mindplan-mcp check`. `version` is present only when the graph status is not `current`, and is its warning sentence (naming `setup_project`, `upgrade_project`, or a `mindplan-mcp` upgrade). `restart` is present only when the `version` in the package's own `package.json`, read on every call, differs from the version the server read at boot: an `npm install` replaced the package under the running server, so the running code, and with it `version`, is the old package's. It names both versions and tells the agent to have the server restarted and call `get_project` again; it is advice only, gates no tool, and is absent when `package.json` cannot be read. `rules_version` is the first 12 hex characters of the SHA-256 of `rules` (an empty string has one too), the same tag `get_rules` returns, so a later `get_rules` can already be the short form. The call records the rules as served to the session, which clears the project rules gate (§8.1.2). When the brief is missing or unreadable, `description` and `rules` are empty strings and `path` stays the local relative path while territory is file-backed.

- **Errors:** a missing or unreadable bundled playbook is `Blocked:` (agents MUST NOT invent the dialect). Brief I/O failures surface as empty `description` / `rules` (`loadProjectBrief` MUST NOT throw).

#### `get_rules`

The mandatory project rules only (§1.1.1): the explicit re-read, after a context summary or a missed push. Nothing requires it before each action; like `get_project`, it records the rules as served to the session (§8.1.2).

- **Input:** `known_version` (string, optional) — the `rules_version` of the rules text the caller still holds, from the last `get_project` or `get_rules`. Callers pass it only while they hold that text (not after a new session or a summarized context).
- **Output:** `{ path, rules, rules_version }` from `loadProjectBrief()`; `rules` is `""` when the section is empty. When `known_version` equals the current `rules_version`: `{ path, rules_version, unchanged: true }`, no text (under 150 bytes), and the text the caller holds still applies. Any other value, or none, returns the full text. No playbook or description. These are the **global** rules only; node rules arrive through `orient_for_work` (§6.1.1).
- **Errors:** none (`loadProjectBrief` MUST NOT throw).

#### `get_spec`

One part of this specification, read from the running package's own `SPEC.md`, so an agent never answers from a stale copy. Call it for a specific rule instead of guessing or retrying.

- **Input:** `topic` (optional): a stable topic id, or a tool name (its `####` entry in §8).
- **Output:** with `topic`, `{ topic, version, text }`: `text` is each named heading's section, from the heading to the next heading of the same or a higher level; `version` is the package version. Without `topic`, `{ version, topics: [{ id, title }], tools }`. Topics match headings by their text without section numbers, so renumbering does not change them: `territory-shape` (§6.5), `lifecycle` (§3.1), `bugs` (§3.2, §3.4), `version` (§1.1.2 Version stamp, Version gate), `atomic-ops` (§3.3, §5.6), `versioning` (§3.6), `change-ids` (§3.7 Change ids, One status call), `neighbors` (§3.7 Pull-in, Classes), `planned-wiring` (§3.7 Planned edges, Attributed files), `decisions` (§5.13, §6.1.2), `open-closed` (§5.15), `imports` (§1.2.2, §5.10), `ownership` (§1.2), `orientation` (§8.1.2), `rules` (§1.1.1, §6.1.1), `checks` (§9.6), `errors` (Appendix A).
- **Errors:** an unknown topic is `Blocked:` and names the valid ones; a missing `SPEC.md`, or a topic heading it lacks, is `Blocked:` with the reinstall fix.

#### `get_skill`

The skills this server serves, read from the running package's `templates/agent/skills/<name>/`, so an agent never follows a stale copy. Nothing is installed into the repository; the playbook and the server instructions say when to load one.

- **Input:** `name` (optional): a skill name (`plan-project`, `define-entities`); `file` (optional, needs `name`): a supporting file of that skill, by its path inside the skill folder (`examples.md`).
- **Output:** without `name`, `{ skills: [{ name, description, files }] }` (`description` from the SKILL.md frontmatter, `files` its supporting files). With `name`, `{ name, text, files }`, `text` being SKILL.md without its frontmatter. With `name` and `file`, `{ name, file, text }`.
- **Errors:** an unknown name is `Blocked:` and lists the skills; an unknown file is `Blocked:` and lists the skill's files; `file` without `name` is `Blocked:`; a package without `templates/agent/skills` is `Blocked:` with the reinstall fix.

#### `list_decisions`

Reads the decision trail (§6.1.2). Call before reshaping a design someone else chose.

- **Input:** `node_id` (slug, optional), `change` (change id, optional), `include_superseded` (boolean, default `false`).
- **Output:** `{ node_id?, change?, decisions: DecisionEntry[], count }`. With `node_id`: that node's own decisions (live and every open revision's), whatever its state; otherwise every non-inactive node's. `change` keeps the decisions recorded under that change id; the filters combine. Each entry is the record plus `{ node_id, node_type, status }`, and `superseded_by` when superseded. Superseded entries only with `include_superseded`.
- **Errors:** unknown `node_id`.

#### `get_node_implementation`

Declared file ownership (§1.2) of a node, or the owner of a path.

- **Input:** `node_id` (slug) and/or `path` (repo-relative POSIX path); at least one.
- **Output (`node_id`, Interaction / Interface / Foundation):**

```jsonc
{
  "node_id": "i-checkout-split",
  "files": [{ "path": "src/interactions/i-checkout-split/handlers.ts", "exists": true }],
  "next_files": [{ "path": "src/interactions/i-checkout-split/handlers.ts", "exists": true }]
}
```

`next_files` is present when the node has exactly one open revision (live claims with the revision's delta applied); with several, `revision_files` maps each change to its claims instead. Directory and glob claims are expanded to the files on disk.

- **Output (Capability):** the files of member Interactions and of the Interfaces exposing them, each `{ path, owner_id, owner_type, exists }`.
- **Output (Bug):** the files of its `affects` targets, tagged the same way.
- **Output (`path`):** `{ path, owner: <node summary> | null }`.
- **Errors:** unknown `node_id`; neither `node_id` nor `path`.

### 8.2 Mutation tools

#### Territory write authority

Any change under `mindplan/` goes through the territory store, and agents reach the store only through MCP. Host file tools MUST NOT write that tree. `setup_project` and `upgrade_project` reach it through MCP too; `mindplan-mcp check` / `view` MAY call the same store.

| Concern | Who writes |
|---------|------------|
| Create node, edges, pipeline / Bug state, `open_next` / `discard_next` / `ship` / `force_unship`, revision folders and their deltas, `base`, and `conflicts`, `implements`, Foundation `role` | **MCP only** |
| `title`, `description`, body (PRD / Atomic Ops), checkbox toggles | **MCP only** (`patch_node_territory`) |
| Rebase conflicts | **MCP only** (`resolve_conflict`, `rebase_revision`) |
| A node's `## Rules` section (§6.1.1) | **MCP only** (`patch_node_rules`) |
| Decision files `decisions/<id>.md` (§6.1.2) | **MCP only** (`record_decision`, append only) |
| Attachments | **MCP only** (`put_attachment` / `remove_attachment`) |
| `mindplan/project.md` | **MCP only** (`patch_project_description`, `patch_project_rules`) |
| `mindplan/config.json` | **MCP only** (`patch_config`) |
| Server-owned frontmatter (`state`, `updated_at`, `shipped_at`, edge arrays, `implements`, `added_claims`, `tests`, `aliases`, `role`) | **MCP only** |
| `mindplan/map.md` | Server after graph mutations: derived snapshot, not graph authority, git-ignored (§7.4) |
| `mindplan/version.json`, graph tree creation, migrations | **MCP only** (`setup_project`, `upgrade_project`; §1.1.2) |

Agents trust graph state from MCP `record` responses, not from on-disk frontmatter. Write results and `changed_files`: §8.

#### `create_node`

- **Input:** `id` (slug); `type` (`Capability|Foundation|Interaction|Interface|Bug`); `title` (non-empty); `description`; `role` (required for a Foundation: `assembler|infra|design-system|adapter`); `change` / `change_ref` (optional; Foundation, Interaction, or Interface only, §3.7); `aliases` (optional; search aliases, at most 20 of up to 60 characters, §6.1); `verbose`.
- **Effect:** scaffolds the node folder with a full-frontmatter `<id>.mdx` (§6.3). Writes no edges (`link_nodes` adds them), no `src/` folder (declare owned files with `set_implementation_files`), and never a revision folder.
- **Output:** `{ created: <node from frontmatter>, folder, current, context, attachments, rules?, shape?, changed_files, state, next_state }` (project-relative paths; `context` is an alias of `current`; `rules` per §8.1.2). `shape` (§6.5) lists the sections the node's first transition checks; the scaffold's are `stub`.
- **Errors:** duplicate `id`; a Foundation with a missing or invalid `role`.

#### `patch_node_territory`

The writer of territory prose: patches `<id>.mdx` or one revision file. Server-owned frontmatter (`state`, edge arrays, `shipped_at`) is never modified.

- **Input:**
  - `node_id` (slug, required); `change`, `change_ref`, `slot`, `verbose` (§8). A revision's change id is its folder name and is never rewritten. `change_ref` (the branch / PR reference of the pre-ship node or the picked revision; `""` clears) is `Blocked:` like `change` on a shipped node with no open revision.
  - `title`, `description`, `role` (Foundation only) — on a Foundation, Interaction, or Interface, only pre-ship or on a revision; a shipped live file is `Blocked:` (`Use open_next for material scope changes on live work.`). Capabilities and Bugs take `title` / `description` in any state.
  - `body` (string) — replaces the whole body below the frontmatter.
  - `section` + `text` (strings, together) — rewrites the content under one `## heading` (`"## Purpose"` or `"Purpose"`); the heading line and every other section stay.
  - `replace` (`{ find, with, all? }`) — replaces one exact piece of the body; `find` MUST match exactly once unless `all: true`. `body` MUST NOT be combined with `section` or `replace`.
  - `toggle_checkboxes` (array of `{ id | contains, checked?, all?, note?, not_applicable? }`) — each names one checklist item (§3.3) by `id` (its `{#id}` tag) or by `contains`, the item's **exact** text (tag and annotation excluded, whitespace trimmed); exactly one of the two. A text that is no item's exact text (a substring included) is `Blocked:` and lists the items with their ids; a text several items share is `Blocked:` and lists the lines, unless `all: true` toggles them all. `note` ticks the item and appends ` — note: <text>`; `not_applicable` ticks it and appends ` — n/a: <reason>`; `checked` may be omitted with either, and both count as complete (§3.3, §5.6). Unticking strips an annotation; a new annotation replaces the old one.
  - `add_checklist_items` (array of `{ text, id?, kind? }`) — appends unticked items to the slot's first checklist section, after its last item and that item's continuation lines (never inside fenced code; a thematic break, a fence, or a line after a blank line indented less than the item's content column — the marker plus the spaces after it, tabs expanded to 4-column stops — ends the item). Each is written `- [ ] <text> {#<id> <kind>}`; `build` is left out of the tag, and an item with no id and kind `build` gets no tag. `kind` is `build` (default), `review`, or `deploy` (§3.3); a non-build item with no id gets one slugged from its text.
  - `split_into` (string array) — a node with an open revision only: the parts this revision splits out of it (§5.15), Foundations for a Foundation, Interactions for an Interaction or Interface. Written to the revision, replacing the parts it marked before (`[]` clears them). A part whose edge is not in place yet (`depends_on`, a shared Capability, `exposes`) returns a `split_into:` warning. `Blocked:` without an open revision (except `[]`, which clears a shipped node's split record, §5.15), or for an id that is not another active node of the part's type.
  - `aliases` (string array) — replaces the node's search aliases (§6.1; `[]` clears). Live only, on any active node, shipped included, without `open_next`.
  - At least one patch field is required.
- **Effect:** writes the body and / or scalars on the resolved slot and touches that slot's `updated_at`. On a live file with `added_claims` (§6.1), removes the entries the new body names verbatim. A body replace of `<id>.mdx` keeps its `## Rules` section (§6.1.1) and any `## Decisions` section (§6.1.2); a revision body holds neither. A contract write (text, checkboxes, `title`, `description`, `role`) to a `ready` slot resets it (§3.1); `change`, `change_ref`, `split_into`, and `aliases` never do.
- **Output:** `{ node_id, patched_fields: ["description", ...], slot: "current" | "next", path, toggled?, readiness_reset?, cleared_planned?, aliases?, split_into?, churn?, warnings?, changed_files, state, next_state }`. `path` is the repo-relative file written; `toggled` lists the checkbox lines as written; `readiness_reset` is present when the write moved a `ready` slot back to `draft`; `cleared_planned` lists the planned edges dropped when the write moved the last revision off a change (§3.7); `aliases` and `split_into` echo what was written (`churn` when a split record was cleared).
- **Errors:** unknown `node_id`; empty patch; a toggle with both or neither of `id` and `contains`; no item with that id or exactly that text (lists the items); a `contains` matching several items without `all` (lists the lines); `add_checklist_items` on a slot with no checklist section, with empty text, text carrying a tag or annotation, an unknown kind, an id that is not a lowercase slug, or an id already used in the slot; `note` with `not_applicable`, or either with `checked: false`; an empty note or reason; an invalid change id; the `change` / `slot` errors of §8; `section` heading not found (lists the sections); `section` without `text`; `replace.find` not found, or found more than once without `all`; a shipped live `title` / `description` / `role` change; `role` on a non-Foundation; aliases on an inactive node; `section: "## Rules"` or a `body` containing a `## Rules` heading (use `patch_node_rules`); `section: "## Decisions"`, or a body, section text, or replacement containing a `## Decisions` heading (use `record_decision`).

#### `patch_node_rules`

Writes one node's rules (§6.1.1): a rule about one node's work. A rule for everywhere goes through `patch_project_rules`.

- **Input:** `node_id` (slug, required); `rules` (string, required; `""` clears the section).
- **Effect:** replaces the `## Rules` section of `<id>.mdx` (revisions carry none; they read the live rules). Valid on every node type in any state except inactive ones, `stable` / `unstable` nodes with or without open revisions included, without `open_next`. Changes no state, edge, checkbox, or `shipped_at`, and not `mindplan/map.md`.
- **Output:** `{ node_id, rules, slots: ["current"], rules_impact, changed_files }`; `rules_impact` is the node's rules audience (`{ has_rules, inherited_by }`, as in `get_blast_radius`); `changed_files` lists the live file.
- **Errors:** unknown `node_id`; an inactive node (`cancelled`, `deprecated`, or a Bug that is `resolved` or `wontfix`); `rules` containing a level-1 or level-2 heading line.

#### `record_decision`

Appends one decision record (§6.1.2). Call when you choose between viable designs (a data shape, an ordering guarantee, which system owns a fact).

- **Input:**
  - `node_id` (slug, required) — the node the choice shapes (not a Bug)
  - `decision` (string, required; one sentence), `alternatives` (non-empty string array, required), `why` (string, required), `consequences` (string, optional)
  - `supersedes` (decision id, optional)
  - `change` (§8) — the open revision to record it in, and the change id the decision is tagged with. Omitted: the node's only open revision, else the node's own change before first ship, else none. A `change` the node has no revision of only tags the decision, written live; it never writes a change id on the node, so a decision alone does not make a shipped node a member of that change (§3.7).
  - `nodes` (string array, optional) — every node this one decision shapes (none a Bug, each existing). Written once, on `node_id`, as `- Nodes: …`; it clears the decision gate of each listed node's revision under the same change, or under any change when untagged (§5.13).
  - `id` (optional) — `d-` plus a slug; generated from the decision's first words when omitted
  - `keep_whole` (boolean, optional) — the node stays one node on purpose: hotspot and fan-out detection skip it while this record is not superseded (§5.15); written as `- Keep whole: true`
  - `verbose` (§8)
- **Effect:** writes one new file, `decisions/<id>.md`: in the picked revision's folder (`revisions/<change>/decisions/`), else beside `<id>.mdx`. Values are collapsed to one line; `date` is today (UTC). Never changes state or readiness, and does not rewrite `mindplan/map.md`. A `supersedes` target becomes `superseded` by computation; its file is not rewritten.
- **Output:** `{ node_id, slot: "revision" | "current", revision, decision: DecisionEntry, supersedes?: { id, node_id }, changed_files, state, next_state, revisions? }`; `revision` is the picked change or `null`.
- **Errors:** unknown node; an inactive node; a Bug (record the decision on the node the fix shapes); empty `decision` or `why`; no alternative; an invalid or taken id (ids are unique across the graph); an invalid change id; several open revisions and no `change`; a `nodes` entry that does not exist or is a Bug; a `supersedes` that is not a recorded decision, is already superseded, or is held by a node outside the recorder's reach (itself, its Capabilities, its transitive Foundations).

#### `set_implementation_files`

Edits a node's claim list (`implements`, §1.2).

- **Input:**
  - `node_id` — an Interaction, Interface, or Foundation
  - `add` (string[]) — repo-relative POSIX paths to claim; the default way to claim
  - `remove` (string[]) — each drops every stored entry whose key equals its key (the normalized path when it validates, else the raw path, a trailing `/` ignored, so duplicates naming one path go together); one that matches none is `Blocked:` naming the stored entries
  - `files` (string[], the whole new list) — only with `replace: true`; `files` without `replace: true` is `Blocked:`, and so is `replace: true` without `files` or combined with `add` / `remove`
  - `attributed` (string[]) — exact files the revision adds in another node's folder (§3.7 Attributed files); replaces the list, `[]` clears; may be passed alone, keeping the claims
  - `change`, `slot`, `verbose` (§8)
- **Entries:** files, directories ending in `/`, or globs (§1.2).
- **Effect:** a pre-ship node writes `current`. On a shipped node with an open revision, the edit is applied to live with the revision's delta and stored as that revision's `implements_add` / `implements_remove` delta (§6.1.3). On a shipped node with no open revision (with or without `slot: "current"`), only an **additive** change is written, in place on live (§1.2), recording the new entries in `added_claims` (§6.1); anything else is `Blocked:` → `open_next`. Retired nodes may only shrink their list. Rejects `..`, paths under `mindplan/`, and ownership conflicts under the same change (live, or live plus that change's revisions, §1.2). A claim on a `ready` slot resets it (§3.1).
- **Import scan:** after writing, scans the claimed files and returns `import_violations: [{ file, imports, fix }]` for each illegal import (omitted when none). `fix` is the exact call that makes it legal, `{ tool: "link_nodes", args: { source_id, target_id, edge_type } }`: `depends_on` for a missing Foundation, `exposes` for an unexposed Interaction, `mounts` for a Foundation importing an Interface. When no edge can make it legal the entry has `not_allowed` instead (an Interaction importing an Interface, a `depends_on` that would close a cycle). The claim is still written; the violation is `Blocked:` at `in-review` / `ship` (§5.10).
- **Folder claims:** a result MAY add `folder_claims: [{ folder, files, note }]`, suggesting one directory claim for `folder` when every file under it is already one of this node's per-file claims and no other node claims under it.
- **Output:** `{ node_id, slot, change?, implements, implements_delta?, attributed?, added_in_place?, hint?, folder_claims?, cleared_planned?, import_violations?, readiness_reset?, changed_files, state, next_state }`. `implements` is the resulting list (on a revision, live with its delta applied); `implements_delta` is the revision's stored delta; `added_in_place` lists the entries an in-place write added, with a `hint` on naming them in the body; `changed_files` lists the live file after an in-place write.
- **Errors:** unknown node or wrong type; no edit (`add`, `remove`, `files` with `replace: true`, or `attributed`); the `files` / `replace` combinations above; a non-additive change to a shipped node's live list, or an in-place entry that reaches a migration or schema file (→ `open_next`); a retired node expanding; a bad path; an exclusivity conflict; an invalid change id; the `change` / `slot` errors of §8.

#### `set_test_files`

Edits a node's linked tests (`tests`, §6.1). Tests are evidence, not contract: a `ready` slot stays `ready`, and the files are not claimed (ownership stays with `set_implementation_files`).

- **Input:** `node_id` (Interaction, Interface, or Foundation); `add` / `remove` (string[] of repo-relative POSIX test paths: files, directories ending in `/`, or globs; `add` is the default way to link); `files` (the whole new list) only with `replace: true`, as for `set_implementation_files`; `change`, `verbose` (§8).
- **Effect:** edits the list, deduplicated and sorted. **Unlike the §8 default, an omitted `change` writes live**: `<id>.mdx` in place, on a pre-ship node or a shipped one whatever revisions are open, with no `open_next`. With `change` on a shipped node with open revisions, the edit is that revision's `tests_add` / `tests_remove` delta (§6.1.3), applied when it ships. `files: []` with `replace: true` removes the field.
- **Gate:** entries may name files that do not exist yet while the node is a draft. Once it is in review or shipped, a missing entry fails `run_check` and the move to `in-review` or `ship` (`presence`, §9.6). A revision in review with no linked tests only warns.
- **Output:** `{ node_id, tests, cleared_planned?, changed_files, state, next_state }`.
- **Errors:** a Capability or Bug; a retired node; a bad path (`..`, absolute, under `mindplan/`); no edit; `files` without `replace: true`; an invalid change id; a `change` the node has no open revision of.

#### `open_next`

Opens a revision of a shipped node under a change (§3.6).

- **Input:** `node_id` (a shipped Foundation, Interaction, or Interface); `change` (required: without it the call is `Blocked:` and names the retry); `change_ref`, `title`, `description` (optional); `verbose`.
- **Effect:** Rule 10 (§5.11): writes `revisions/<change>/<id>.mdx` from the live file in state `draft` (with the optional title / description), empty deltas, and `base` hashes of live; gives it a fresh list of unticked default Atomic Ops (§3.3) and an `attachments/` folder. `<id>.mdx` and the node's other revisions are unchanged. The edges planned on the node under `change` become add deltas, listed as `applied_planned` (§3.7 Planned edges).
- **Open–closed warning:** when the node is a hotspot counting the revision it opens (§5.15), the result carries `warnings` (the open–closed line) and `decision_prompt: { tool: "record_decision", args: { node_id, decision, alternatives, why, change? } }`, whose one alternative names a new node that `depends_on` it. The revision opens either way.
- **Output:** `{ node_id, live_state, change, revision: { change, state, title, description, opened_at, change_ref? }, folder, current, revision_path, applied_planned?, warnings?, decision_prompt?, rules?, changed_files, state, next_state, revisions }` (`revisions` lists every open revision of the node: this one and its siblings).
- **Errors:** unknown `node_id`; wrong type; node not shipped; no `change`; the node already has an open revision of `change`; a planned edge of `change` that is no longer legal (names the `unlink_nodes` call); a planned `depends_on` of `change` that would close a dependency cycle across changes (§5.10).

#### `discard_next`

Abandons one open revision.

- **Input:** `node_id` (a Foundation, Interaction, or Interface with an open revision); `change`, `verbose` (§8).
- **Effect:** deletes `revisions/<change>/` (the revision file, its attachments, and its decisions). `<id>.mdx` and the node's other revisions are untouched. When it was its change's last revision, the change's planned edges are dropped (§3.7).
- **Output:** `{ node_id, change, discarded: true, live_state, cleared_planned?, changed_files, state, next_state, revisions? }`; `changed_files` lists each deleted path.
- **Errors:** unknown `node_id`; no open revision; the `change` errors of §8; a revision a shipped node already rests on — a `stable` or `unstable` node `depends_on` the node (or an Interface `exposes` it) and imports a file only that revision claims (§5.4; names the dependents and the imports).

#### `resolve_conflict`

Clears one rebase conflict a sibling revision's ship left on a revision (§3.6).

- **Input:** `node_id`; `change`, `verbose` (§8); exactly one of `section` (a level-2 heading such as `"## Spec"`, or `"_preamble"` for the text above the first heading; a bare heading gets `## `), `field` (`title` \| `description` \| `role`), or `claim` (the claimed path another node now owns); `take` (`revision` \| `live` \| `text`); `text` (with `take: "text"`: the section body or scalar value to write).
- **Effect:** `revision` keeps the revision's value; `live` takes the shipped value (a section's live text, a scalar's live value; a claim conflict drops the add); `text` writes `text` (sections and scalars only; a section's heading is added when `text` lacks it). The conflict is removed and its `base` entry moves to live, so a later sibling ship compares against the value now live. Sets `updated_at`. A resolution that changes the revision's text, scalars, or claims resets a `ready` revision (§3.1, `readiness_reset`); an `in-review` revision stays in review; taking `revision` keeps the state.
- **Output:** `{ node_id, change, resolved, take, conflicts, changed_files, state, next_state, revisions, readiness_reset? }`; `conflicts` lists the conflicts left (`section:…`, `scalar:…`, `claim:…@…`).
- **Errors:** not exactly one of `section` / `field` / `claim`; `take: "text"` without `text`, or on a claim conflict; no open revision; the `change` errors of §8; no conflict on that target (lists the ones the revision holds); an invalid Foundation role; `take: "text"` holding a level-2 heading outside fenced code (any for `_preamble`, any beyond the section's own heading); a resolution that takes back a `build` item of a relied-on in-review revision (§5.4).

#### `rebase_revision`

Carries one open revision onto current live when live changed somewhere the revision did not see: typically a sibling revision shipped on another branch and the branches merged, so `run_check({ after_merge: true })` reports the revision's `base` as stale (§9.6).

- **Input:** `node_id`; `change`, `verbose` (§8).
- **Effect:** the rebase a ship applies to its siblings (§3.6). A revision already based on live is left as it is (`rebased: false`). A `ready` or `in-review` revision whose text changed goes back to `draft` (`readiness_reset`).
- **Output:** `{ node_id, change, rebased, conflicts, readiness_reset?, changed_files, state, next_state, revisions? }`; `conflicts` lists the conflicts the revision holds after the rebase (`section:…`, `scalar:…`, `claim:…@…`).
- **Errors:** unknown `node_id`; no open revision; the `change` errors of §8.

#### `acknowledge_warning`

Marks check warnings as known and accepted, so compact `run_check` results stop listing them.

- **Input:** `id` (one warning id, `w-<10 hex>`) and / or `ids` (several).
- **Effect:** adds the ids to `.mindplan-cache/acks.json` of the call's root: per checkout, git-ignored with the rest of the cache (§1.1.3), never in `changed_files`. Writes no graph node and is not orientation-gated. An acknowledged warning is counted in `acknowledged` instead of listed; when its text changes it gets a new id and shows again.
- **Output:** `{ acknowledged: [ids] }`.
- **Errors:** neither `id` nor `ids`; an id not shaped `w-<10 hex>` (lists them).

#### `patch_project_description`

- **Input:** `description` (string, required; `""` clears the section).
- **Effect:** writes the `## Description` section of `mindplan/project.md` through the store, creating the file when missing. `## Rules` is unchanged.
- **Output:** `{ path, description, rules, changed_files }`.
- **Errors:** missing `description`.

#### `patch_project_rules`

- **Input** (at least one): `rules?` (string; replaces the whole section, `""` clears it), `add?` (rules to append, one bullet each; one already present is skipped), `remove?` (rules to drop, by full text or a fragment matching exactly one rule; applied before `add`). `rules` is not combined with `add` / `remove`.
- **Effect:** writes the `## Rules` section of `mindplan/project.md` through the store, creating the file when missing. `## Description` is unchanged.
- **Output:** `{ path, description, rules, changed_files }`.
- **Errors:** none of `rules`, `add`, `remove`; `rules` with `add` or `remove`; an empty entry; a `remove` entry matching no rule or more than one.

#### `patch_config`

- **Input** (at least one): `sources?` and `exclude?` (glob lists; each replaces the stored list), `decisions?: { blast_radius?, schema_files? }`, `hotspots?: { half_life_days?, outlier_ratio?, min_rate? }`, `fan_out?: { warn_at? }`, `search?: { enabled?, model? }`. Keys, defaults, and valid values: §1.2.1.
- **Effect:** writes `mindplan/config.json` through the store. A nested setting not passed keeps its stored value; an unknown nested key or an invalid value is rejected (§1.2.1).
- **Output:** `{ path, config, changed_files }`.

#### `put_attachment`

Writes one supporting file beside a node (§8.3).

- **Input:** `node_id`; `filename` (basename only); `content_base64`; `slot`, `change`, `verbose` (§8).
- **Effect:** writes under the node's `attachments/`, or under `revisions/<change>/attachments/` of the picked revision. A revision's attachments are copied into `attachments/` when it ships.
- **Output:** `{ node_id, slot, path, changed_files, state, next_state, revisions? }`.

#### `remove_attachment`

Deletes one supporting file of a node.

- **Input:** `node_id`; `filename` (basename only); `slot`, `change`, `verbose` (§8).
- **Effect:** deletes the file from the slot `put_attachment` would write.
- **Output:** as `put_attachment`.

#### `link_nodes`

- **Input:** `source_id`, `target_id`, `edge_type` (`depends_on|belongs_to|exposes|leads_to|affects|mounts`), `change`, `verbose` (§8).
- **Planned:** with `change`, on a shipped source with no open revision of that change, the edge is planned instead (§3.7 Planned edges); the result is `{ planned: { source, change, type, target }, note, changed_files, state, next_state }`, the live file only, and nothing below applies.
- **Effect:** validates §5.10 (under the revision's change when one is written), then adds the target to the source's edge array on `<id>.mdx` or, when the source is a shipped Foundation, Interaction, or Interface with an open revision, as an `<edge>_add` delta on that revision (§2.2, §6.1.3). Recomputes stability (§3.5) and Capability states (§4) from the live graph (revision deltas count only once shipped). A write to a `ready` slot resets it (§3.1).
- **Output:** `{ linked: { source, target, type }, slot: "current" | "next", change?, capabilities_recomputed: [...], stability_recomputed: [{ id, state }], readiness_reset?, rules?, changed_files }` (`rules` per §8.1.2).
- **Errors:** unknown ids; an illegal shape; an Interaction Independence violation; a self-link; a duplicate edge on the resolved slot; a `depends_on` cycle, under the change written or across changes (§5.10; checked alike for a live edge, a revision delta, and a planned edge).

#### `unlink_nodes`

- **Input:** `source_id`, `target_id`, `change`, `verbose` (§8).
- **Planned:** with `change` and no open revision of that change on the source, removes only the edges planned under that change from source to target (§3.7): `{ unplanned: [{ source, change, type, target }], changed_files, state, next_state }`; `Blocked:` when there are none.
- **Effect:** on a source with no open revision, removes **all** edges from `source_id` to `target_id` (any type) from `<id>.mdx` and recomputes stability and Capability states. On a shipped source with an open revision, the removal goes to that revision: each live edge to the target becomes an `<edge>_remove` delta and each `<edge>_add` of it is dropped; live is untouched until the revision ships. A write to a `ready` slot resets it (§3.1). Unlinking never demotes a node already past a gate: guardrails run at transition time only (§9.2).
- **Output:** `{ removed: <count>, slot?, change?, capabilities_recomputed: [...], stability_recomputed: [...], readiness_reset?, rules?, changed_files }`.
- **Errors:** unknown ids; no edge between the pair (live, or under the revision's change).

#### `update_node_status`

Moves Foundations, Interactions, Interfaces, and Bugs along their pipelines (§3.1, §3.4), one node, a batch, or a scoped walk.

- **Input (one node):** `node_id`; `new_status` (a build or Bug state name, or `ship` for a Foundation, Interaction, or Interface entering production); `change` (§8: which open revision moves).
- **Input (batch):** `revisions` — a non-empty array of `{ node_id, new_status, change? }`, each moving its node's revision of `change` or its only open revision. Mutually exclusive with `node_id` / `new_status`. A node may appear once per change.
- **Input (scope):** `scope` (`all_open_updates` \| `node_and_dependents` \| `change`) with `new_status` as the target (`ready` \| `in-progress` \| `in-review` \| `ship`). Mutually exclusive with `revisions`.
  - `all_open_updates` selects every shipped Foundation, Interaction, or Interface with an open revision, and every pre-ship one being built (`in-progress` or `in-review`); a `draft` or `ready` node is a plan and is never selected.
  - `node_and_dependents` takes `node_id` and selects it plus the nodes that `depends_on` or `exposes` it, transitively (open revisions' edge adds included), walking those that are open updates or pre-ship at any state.
  - `change` takes `change` and walks every revision of that change (§3.7), `draft` and `ready` included, each node moving its revision of that change only; `nodes` (node ids) limits it to those members (§3.7 Change ids).
  - The first two move each node's only open revision. A selected node with several stays in place and, when one of its revisions has a step left toward the target, is listed in `needs_change_walk: [{ node_id, changes }]` to walk with `scope: "change"`; when no node moves and some are listed, the result adds a `note` naming those walks.
  - `skip_review` (boolean): a walk to `ship` may move nodes not yet `in-review`; `skip_blocked` (boolean): walk every node that passes and leave the blocked ones (§3.7 One status call).
- **Input (any form):** `dry_run` (boolean) — validate and return the plan without writing; `verbose`.
- **Effect (one node):** the §5.14 pipeline. With no open revision, transitions apply to `<id>.mdx` as in a first build. With revisions open, `draft` / `ready` / `in-progress` / `in-review` apply to the named revision only, judged under its change (§3.6); `ship` (only from that revision's `in-review`, with no conflict) writes it onto live and rebases the node's other revisions (§3.6). `deprecated` acts on live and deletes every open revision folder. Stability and Capability states are recomputed.
- **Effect (batch):** ordered **Foundations, then Interactions, then Interfaces, then Bugs** (caller order within a tier); each item is tried on the graph as the items before it left it (§3.7 One status call).
- **Effect (scope):** the selected nodes are ordered Foundations, Interactions, Interfaces (dependency order within a tier, on each moving revision's view: a `scope: "change"` walk orders by the change's view, the other scopes by each row's own revision), then each walks from its active state through `draft → ready → in-progress → in-review → ship` to the target, skipping nodes already there. Every stage runs (a node never jumps from `ready` to `stable`), including the in-review check gate. The whole walk is validated in memory first, and **nothing is written** if any step would be `Blocked:`; with `skip_blocked`, see §3.7 One status call (the ship gate then counts only the nodes that walk; a node left behind keeps its live claims). A walk to `ship` past nodes not yet `in-review` is `Blocked:` unless `skip_review: true`, which walks them through `in-progress` and `in-review` (gate included) and lists them in `skipped_review`.
- **Gates:** a move to `in-review` or `ship` runs the check gate (§5.10; stale-text warnings ride along as `warnings` and never block), and a move to `in-review` also runs the decision gate (§5.13), in every form, a scoped walk's validation and `dry_run` included. When a `ship`, `cancelled`, or `deprecated` leaves a change with no revisions, its planned edges are dropped (§3.7), once per call (`cleared_planned`).
- **Output (one node):** `{ node_id, change?, previous_state, new_state, revision_state?, state, next_state, shipped_at, promoted_next: boolean, rebased?: [{ change, conflicts, readiness_reset? }], warnings?, cleared_planned?, capabilities_recomputed: [...], stability_recomputed: [...], changed_files, revisions? }`. `state` is the live state; `change` and `revision_state` name the revision moved; `promoted_next` is true when a revision shipped; `rebased` lists each sibling revision the ship rebased with its conflicts (`section:…`, `scalar:…`, `claim:…@…`) and `readiness_reset` when the rebase sent it back to `draft`. A revision's ship lists in `changed_files` `<id>.mdx`, the deleted revision folder's files, the moved decision files, each `attachments/<file>` copy, and every rebased sibling revision file.
- **Output (batch / scope):** `{ ordered: true, scope?, change?, partial?, blocked_count?, results?: [{ node_id, change?, ok, line?, blocked? }], lines: ["<id>: <from> -> <to>", ...], skipped_review?, needs_change_walk?, note?, blocked?: [{ node_id, step, reason }], cleared_planned?, changed_files, warnings? }`: one line per moved node (`to` is the revision's state while one moves). A batch has `results`, one per item (`line` when it moved, `blocked` with its reason and change hint when not), and `partial: true` with `blocked_count` when some items were blocked. `blocked` (scope) only with `skip_blocked`. `changed_files` is the union of every applied transition. With `verbose`: also `applied` (the one-node outputs) and the recomputed Capability / stability lists.
- **Output (`dry_run`):** `{ dry_run: true, scope?, change?, plan: ["<id>: <from> -> <to>", ...], blocked: string | null, skipped_review?, needs_change_walk?, note?, warnings? }`. `plan` lists **every transition**, one line per step (a node walking `ready → ship` contributes three); `blocked` names the first failing node and step, or the review skip. With `skip_blocked`, `plan` lists only the nodes that can move and `blocked` is the `[{ node_id, step, reason }]` list of the others. A batch dry run validates each item on the graph as the items before it would leave it and adds `results`; `blocked` then names the items that would not move.
- **Errors:** unknown id; a Capability; an invalid state name; an illegal transition (on the slot that moves); Rule 1–6 violations; a manual `stable` / `unstable`; `ship` while the revision is not `in-review`; a revision holding conflicts moved to `in-review` or `ship` (names a `resolve_conflict` call per conflict); the `change` errors of §8; both input forms at once; empty or duplicate `revisions`; `scope` with `revisions`, without a forward `new_status`, or `node_and_dependents` without `node_id`; `scope: "change"` without `change`, or a change with no members; `nodes` with another scope, empty, or naming a non-member (lists the members); a batch in which no item can move; `cancelled`, or a move back from `in-review`, on a node that is not `stable` while a shipped node `depends_on` it (or a shipped Interface `exposes` it) (§5.4; names the dependents); `skip_review` or `skip_blocked` outside a scoped walk; a `skip_blocked` walk in which no node can move; a scoped walk to `ship` past nodes not yet `in-review` without `skip_review`; a check-gate violation (`Blocked: Check failed for "<id>" …`); a missing decision (`Blocked: Decision. …`). A `Blocked:` scoped walk writes nothing. An illegal production retreat SHOULD mention `force_unship` and the `unship:<node_id>` confirm shape. A `Blocked:` move of a node in a change ends with the change hint (§3.7 One status call).

#### `force_unship`

Reverses a mistaken ship: Rule 11 (§5.12).

- **Input:** `node_id`; `confirm` (exactly `unship:<node_id>`); `new_status` (`draft|ready|in-progress|in-review`, default `ready`); `verbose`.
- **Effect:** Rule 11 (§5.12), then refreshes `mindplan/map.md`.
- **Output:** `{ node_id, previous_state, new_state, shipped_at: null, force_unship: true, capabilities_recomputed: [...], stability_recomputed: [...], changed_files }`.
- **Errors:** a wrong or missing `confirm`; not a Foundation, Interaction, or Interface; not `stable` / `unstable`; an open revision (names each; ship or `discard_next` each first); shipped direct dependents; an invalid target; Ghost Interaction / Ghost Interface / Completion Check failures for the target state.
- **Playbook:** agents MUST ask the human and wait for an explicit yes before calling, and MUST NOT invent `confirm`.

#### `setup_project`

Creates the graph in a repository that has none, and hands the agent the judgment work as a guide.

- **Input:** `ci` (optional, `"github"`): also install the CI merge gate (§9.6).
- **Effect:** when the status is `setup` (§1.1.2), creates the tree (§1.1), a default `mindplan/config.json` (`{ "sources": ["src/**"], "exclude": [] }`), `mindplan/project.md` from `templates/agent/project.md` when absent (§1.1.1), and the stamp at the server's `MIGRATION_LEVEL`. On a `current` graph it writes nothing under `mindplan/`. It MUST NOT write any repo-owned file (`MINDPLAN.md`, `CLAUDE.md`, `AGENTS.md`, `.gitignore`, `.cursorignore`, host rules files). With `ci: "github"` it writes `.github/workflows/mindplan-merge-gate.yml` (§9.6), keeping an existing file.
- **Output:** `{ created, changed_files, ci?, pointer, guide }`. `created` is true when this call created the graph. `ci` is `{ installed, path }` (`installed: false` when the file was kept); an installed workflow is listed in `changed_files`. `pointer` is `templates/agent/agents-stub.md`, the text the agent writes to `MINDPLAN.md`; `guide` is `templates/agent/setup-guide.md`: wire `MINDPLAN.md` into the host's agent files, add the ignores, move standing rules into the brief with the user's approval, write the description, offer the merge gate, run the check.
- **Errors:** status `upgrade` or `server-behind` → `Blocked: setup_project: <warning>`; a missing template → `Blocked:` with the reinstall fix.

#### `upgrade_project`

Brings an existing graph to the server's migration level (§1.1.2).

- **Input:** none.
- **Effect:** runs every migration (§1.1.2), then stamps `mindplan/version.json` with the server's `MIGRATION_LEVEL`. It writes no repo-owned file, and it reports agent files outside `mindplan/` (`leftovers`) but MUST NOT delete them.
- **Output:** `{ from_level, to_level, changed_files, migrations, leftovers, pointer_outdated, pointer, guide }`.
  - `migrations` reports what each migration did: `capabilitiesMoved` (the moved ids, sorted), `territoryFilenames`, `config`, `atomicOpsDropped`, `mirrorTwinsRemoved`, `mirrorTwinSkips`, `revisionsBackfilled`, `splitsFound`, `agentFilesRemoved`, `staleChangeLabelsCleared` (`{ node_id, change }` per stripped label), `revisionsMoved` (`{ node_id, change }` per `<id>.next.mdx` moved to `revisions/<change>/`), `decisionsSplit` (`{ node_id, count }` per `## Decisions` section split into files), `mapIgnored` (true when this run added `map.md` to `mindplan/.gitignore` or untracked it).
  - `changed_files` lists every path written, moved, or deleted, `mindplan/.gitignore` included; the `git rm --cached mindplan/map.md` is already staged, so commit the upgrade on its own.
  - `leftovers` lists those of `.claude/skills/mindplan-define-entities/`, `.claude/skills/mindplan-plan-project/`, `.cursor/skills/mindplan-define-entities/`, `.cursor/skills/mindplan-plan-project/`, and `.cursor/rules/mindplan.mdc` that exist.
  - `pointer_outdated` is true when `MINDPLAN.md` is missing or differs from `pointer`, or `AGENTS.md` / `CLAUDE.md` still holds an outdated stub.
  - `guide` is `templates/agent/upgrade-guide.md`: delete the leftovers, refresh the pointer, commit the upgrade alone, run the check.
- **Errors:** status `server-behind`, or `setup` with no `mindplan/` folder → `Blocked: upgrade_project: <warning>`; a rename the filesystem rejects → `Blocked:` naming the file and the renames already applied (§1.1.2); a missing template → `Blocked:` with the reinstall fix.

### 8.3 Attachments

Attachments under `attachments/` and a revision's `revisions/<change>/attachments/` are written only through `put_attachment` / `remove_attachment` (§8.2 Territory write authority). `get_node_context` reports the inventory (`attachments_path`, filenames); hosts MAY read those files for display.

---
## 9. Operational Semantics

### 9.1 Determinism

For the same inputs and the same tool call, the server MUST reach the same accept/reject verdict and write the same resulting state (timestamps excepted). A call's verdict and result depend only on:

- the `mindplan/` tree and the project's files on disk (claims, presence, imports);
- git, where a rule reads it: the base ref and the files changed or added against it (§5.13, §9.6);
- per-session state in server memory, kept per root: the orientation ledger (§8.1.2), which gates writes, and the warning ids `run_check` already showed (§8.1), which only shorten compact output;
- the `MINDPLAN_VERSION_GATE` and `MINDPLAN_ORIENT_GATE` switches.

The derived files in `.mindplan-cache/` never change a verdict: the graph cache (§1.1.3) returns what a full parse returns, the search index (§8.1.1) only ranks results, and `acks.json` only hides acknowledged warnings from compact `run_check` output (§8.2). No verdict needs the network; the search model download (§8.1.1) affects ranking only.

### 9.2 Validation-at-transition

Guardrails judge the graph and the files as they are on disk at the moment of each transition. Nothing enforces invariants between calls: an inconsistency made out of band (§9.3) is caught by the next gated transition or check (§9.6).

### 9.3 Out-of-band edits

Every change under `mindplan/` goes through MCP; host file tools MUST NOT write that tree (§8.2 Territory write authority). A hand edit voids the framework's guarantees: the server judges whatever it finds on disk (§9.2).

### 9.4 Concurrency

The server assumes a single writer per graph: one MCP server process for a project and its worktrees. Deployments with concurrent writers to one checkout MUST serialize mutations externally.

Parallel agents work in separate git worktrees instead. One server serves them all through `root` (§8): each agent passes its worktree as `root` to every MindPlan tool and orients there (orientation is per root, §8.1.2), and git merges the graphs along with the code; run `run_check({ after_merge: true })` on the merged checkout (§9.6). A change spread over worktrees is still one change: the merge gate (§9.6) and the cross-change cycle rule (§5.10) judge it on the merged graph. The step-by-step recipe (plan on the integration branch, build in worktrees, merge, ship with a scoped change walk) is in the `plan-project` skill.

### 9.5 Deprecation, cancel, and orphans

Retiring a node retires only that node: `deprecated` (from `stable` / `unstable`) deletes its open revisions, and `cancelled` (pre-ship) is Blocked while active dependents remain (§3.1). Its claims on files still on disk fail the check as leftovers (§9.6). After retiring an Interaction or Interface, review its Foundations (`get_blast_radius`, `get_mindplan_graph`) and retire any whose consumers are all retired; to replace scope on live work, use `open_next` instead (§3.6).

### 9.6 Offline integrity check (`mindplan-mcp check`)

`mindplan-mcp check` (the package binary; no MCP session needed) audits the graph and the source universe (§1.2.1) without changing them. `run_check` (§8.1) runs the same check and returns the same output, full (`compact: false`) or compact. Output: `mindplan-mcp check: ok` or one `Blocked: …` line per failure, then `Warning:` lines, then `Info:` lines; exit code `0` on success, `1` on failure. Warnings and info never change the exit code or `ok`. The default check does not run dirty-src and does not fail because nodes are mid-pipeline. Opt-in flags, each below: `--base <ref>` (dirty-src), `--merge` / `--merge=strict` (merge gate; both together are `Blocked:`), `--after-merge`. `--root <path>` runs any mode on the checkout at `<path>` instead of `MINDPLAN_ROOT` / the working directory (the MCP tools take `root`, §8).

**Before any check.** A graph whose status is not `current` (§1.1.2) fails with one `Blocked: Version — <warning>` line and no other check runs, except the file-level `--after-merge` findings (`MINDPLAN_VERSION_GATE=off` turns this off). A `mindplan/config.json` that exists but is invalid (§1.2.1) fails at once.

**Failures.** Every mode runs these:

| Check | `Blocked:` when |
|---|---|
| Graph load | the graph does not load (`graph load failed: …`). |
| Exclusivity | a universe file has more than one owner (§1.2). |
| Coverage | a universe file is claimed by no non-retired node, live or in an open revision (`Blocked: Coverage: …` naming the probable owner and the fix, §1.2.1). |
| Presence | a live entry of an in-review or shipped node is missing on disk, except one an open revision **released** (§1.2); an in-review revision's entry is missing; a `tests` entry (§6.1) matches no file once its node is in review or shipped (`Blocked: presence: "<id>" tests entry missing on disk: "<entry>".`); an `attributed` file (§3.7) is missing once the slot that holds it is in review. |
| Leftovers | a retired node still claims a file on disk, until the file is deleted or reassigned. |
| Import matrix | an import breaks §1.2.2 (including `mounts` and the test-file scope). |
| Change cycles | `depends_on` edges close a cycle across changes (`Blocked: change cycle: …`, §5.10). |

**Import fixes.** Every illegal-import failure ends with its fix: `Fix: link_nodes({"source_id":…,"target_id":…,"edge_type":…}).` when an edge (`depends_on`, `exposes`, or `mounts`) would make it legal, or `not allowed: …` when none can (for example an Interaction importing an Interface).

**Imports over every claim.** The import matrix scans each universe file, and each file a non-retired node claims outside the universe (the in-review gate scans every claimed file, so the check must not pass what the gate Blocks), as every node that claims it: its live owner, each open revision that claims it, and a released live owner. Import targets resolve through released claims too. A violation that only this wider scan finds (a released file, a target that is only released, or a file's second claimant) is a `Warning: imports (next slot): …`, not a failure.

**Warnings.** Each `Warning:` line starts with its category:

| Category | Warns when |
|---|---|
| `stale:` | territory text no longer matches the repo (below). |
| `description:` | an active node's description (each open revision's on its own) is empty or repeats the title; exceeds 300 characters (descriptions are search rows); is an Interaction's and names no actor (a loose word list: visitor, editor, owner, customer, admin, agent, …); or, except on a Bug, uses revision wording (`now`, `no longer`, `was changed to`, `used to be`, `previously`, `anymore`, `instead of the old`) that belongs in the revision's body. |
| `shape:` | a node whose active slot is `draft`, or a Bug before `in-review`, misses a required section (§6.5). |
| `decision:` | a decision-worthy open revision has no decision yet, at any pre-ship state (§5.13). |
| `tests:` | a Foundation, Interaction, or Interface in review has no linked tests: `tests: "<id>" is in review with no linked tests; …`; for a revision, `… (revision "<c>"); link … with set_test_files({ node_id, change: "<c>", add: [...] })`, since `set_test_files` without `change` writes live. |
| `ownership:` | a file is claimed from different changes, by revisions or pre-ship members (§1.2): `ownership: "<file>" is claimed by "<a>" (…) and "<b>" (…)`. |
| `imports (next slot):` | an import violation only the wider scan finds (above). |
| `routes:` | a route family is split between owners (§1.2.3): `routes: route family "<dir>/" is split: "<id>" (Assembler) owns …; "<id>" (Interface) owns …`. |
| `conflicts:` | an open revision holds unresolved rebase conflicts (§3.6): `conflicts: "<id>" revision "<c>" has N unresolved rebase conflict(s); resolve_conflict before in-review.` |
| `legacy:` | a shipped node keeps a leftover `state: mirror` next file: `legacy: "<id>" has a leftover mirror twin (<path>); call upgrade_project to remove it.` |
| `hotspot:` | highest rank first (§5.15): `hotspot: "<id>" ships far more often than the rest of the graph lately (rate X against a median of Y), and N nodes depend on it directly; …`. |
| `fan-out:` | a pre-ship node's fan-out reaches `fan_out.warn_at`, highest count first, then by id (§5.15): `fan-out: <id> depends on <N> other changes (<a>, <b>, …). …`. |
| `after-merge:` | with `--after-merge`, a revision based on an older live (below). |

**Stale text (`stale:`).** A node in review (`in-review`, or an open revision in review) gets every signal: a body path in backticks that does not exist; a claimed file changed after the body was last updated; unticked checkboxes. Nodes still being built are skipped (they may name files not written yet). The missing-path signal skips closed checklist items, which record what was done: an item the Completion Check counts as done (`- [x] …`, with `— note:`, or with `— n/a: <reason>`; an `— n/a:` with no reason is not closed), with its continuation lines (indented lines, nested non-checkbox bullets, lazy lines up to a blank line). A shipped node (`stable` / `unstable`) with no open revision gets the path signals: a missing body path, and each `added_claims` entry (§1.2, §6.1) its live body does not name verbatim. When one of its claimed files changed against the base (`--base`, else the default-branch merge base: the commits since it plus the working tree, from the git probe dirty-src and the strict merge gate share), it gets every signal, because the branch edited it in place; without git or a base it keeps the path signals only, and nothing reports the missing base. Moves to `in-review` and `ship` return the same warnings; `run_check` with `change` computes them for every member (§8.1).

**Info.** `Info:` lines are not drift:

| Category | Line |
|---|---|
| `planned:` | A slot still a plan (`draft` or `ready`, none of its claimed files on disk) names files not built yet, so its missing body paths are not `stale:`: one `planned: "<id>" names N path(s) not on disk yet (…).` line per node. A path on a line that says "at build time" is planned on every node. |
| `waiting on people:` | Unticked `review` and `deploy` items (§3.3) of live pre-ship nodes and open revisions, in one line grouped per node and revision: `waiting on people: <id>[ (revision <change>)]: <item id or text> (<kind>), …; …`. |
| `planned edges:` | With `change`: one line per source of planned edges (§3.7); a planned edge no longer legal fails as `Blocked: change "<id>": planned edge …`. |
| `additivity:` | With `change`: `additivity: <summary>` (§5.15). |

**Dirty-src (`--base <ref>`).** Each changed universe file needs an owner whose state allows the change, found through the implements index; a changed file with no owner fails. Changed paths are relative to the project root: when the project sits below the repository top, paths outside it are ignored. An explicit `--base` fails closed on git errors.

| Changed paths | Allowed when the owner is |
|---|---|
| Uncommitted (working tree) | `in-progress`, or shipped (`stable` / `unstable`) with no open revision (neighbors edit in place, §3.7); while revisions are open, only a revision in `in-progress` counts. |
| Committed (`<base>...HEAD`) | `in-progress`, `in-review`, `stable`, `unstable`, `cancelled`, or `deprecated`; while revisions are open, only a revision in `in-progress` or `in-review` counts. |

Either kind also passes while a Bug in `fixing` or `in-review` affects the owner.

**Merge gate (`--merge`).** The default branch holds only done (`stable` / `unstable`) or still-building (`draft`, `ready`, `in-progress`) work, never work in review. Each Foundation, Interaction, or Interface with a slot in `in-review` (each open revision on its own, under its change, else live; a leftover `mirror` file is not a revision), and each Bug in `in-review`, fails with `Blocked: Merge: "<id>" (<type>, [revision ]<state>, change "<change>" | no change): …` and its fix: ship it (`update_node_status({ scope: "change", change, new_status: "ship" })`; no change: `{ node_id, new_status: "ship" }`; a Bug: `"resolved"`), or move it back to `in-progress` (a Bug: `fixing`) if unfinished. Lines are ordered by change id (none last), then node id. Retired nodes pass. Run it on pull requests to the default branch and before telling the user a PR is ready to merge.

**Stale territory at the merge gate.** Every merge level also requires the graph to describe the code: a shipped (`stable` / `unstable`) node with no open revision whose live claims cover a path changed against the base (the same base and git probe as the strict gate), while its live territory file `mindplan/<folder>/<id>/<id>.mdx` is not among the changed paths, fails with `Blocked: Merge: "<id>" (<type>, <state>): claimed files changed against <base> but its territory did not: <up to five paths>. Update the node so it matches the code: …`, naming `open_next` and ship when its contract changed, or `patch_node_territory` in place when it holds; the node is listed with `stale: true`. Any change to the territory file clears it (the gate cannot judge the text, so when the text still holds, any patch that confirms it counts). A node that a Bug changed on the branch `affects` is exempt: the Bug describes the fix. Migration and schema files (the decision gate's `schema_files`) do not count: the decision gate covers them, and a composition root that owns the migrations folder gains one with every feature. A shipped node's revision still at `draft` or `ready` whose claims (live or its own) cover a changed path is Blocked the same way (`… but its revision was never started`), so opening a revision alone does not clear the rule; an `in-progress` revision merges, as incremental work does. Without a resolvable base, or when the git probe fails, the default level skips the rule with one `Info: merge: …` line. The default check only warns (`stale:`), so a branch may code first and update the graph before it merges.

**Strict merge gate (`--merge=strict`).** Adds `Blocked: Merge (strict): …` for each `in-progress` active slot whose claims cover a path changed against the base (`<base>...HEAD` plus the working tree, deletions included), listing up to five paths. The base is `--base`, else the merge base of `HEAD` with `main` (else `master`), using the newer of the local branch and `origin/<branch>` so a never-pulled local branch cannot count already-merged commits; with neither (or outside git) it fails with `Blocked: Merge (strict): no git base …`. Opt-in because it blocks the incremental PRs of a large feature. An explicit `--base` also runs dirty-src; both share one git probe, and a failed probe is reported once.

**After merge (`--after-merge`).** Run it after merging a branch that changed the graph (§9.4). Each leftover is a `Blocked: after-merge: …` line naming its fix:

| Leftover | Fix |
|---|---|
| git conflict markers in a file under `mindplan/` (file and line) | resolve the conflict, then commit |
| a node id in two folders | keep one, merge the others into it |
| a decision id recorded in two files of one node | re-record one with `supersedes` |
| a revision file that does not parse | fix the file |
| a tracked `mindplan/map.md` | `git rm --cached`, and list it in `mindplan/.gitignore` |
| `mindplan/version.json` missing, unreadable, or behind the graph | `upgrade_project` |
| `mindplan/version.json` newer than this server | install the `mindplan-mcp` version it names |

The file-level findings run even when the graph fails to load, so whatever broke the load is named. An open revision whose `base` no longer matches live (live moved on the other branch) is a `Warning: after-merge: …` naming `rebase_revision({ node_id, change })` and then `resolve_conflict`.

**CI merge gate.** `setup_project({ ci: "github" })` (§8.2) installs `.github/workflows/mindplan-merge-gate.yml` (template `templates/ci/github/mindplan-merge-gate.yml`) at the repository top, where GitHub reads workflows (outside git: under the project root). On a `pull_request` to the repository's default branch, its job `mindplan merge gate` runs `npx -y mindplan-mcp@<major.minor> check --merge` (the version that installed it) in the project root (`defaults.run.working-directory`, `.` at the repository top). The file is repo-owned: an existing one is kept. Without `ci`, no workflow is installed. A repository SHOULD make the job a required status check on the default branch, or a red gate does not stop a merge. Consumer repositories SHOULD run the published `mindplan-mcp` package.

**Check before handoff.** Before the agent stops owning the work, it MUST update the graph to match the implementation, and the default check MUST exit 0 (every `Blocked:` fixed) before self-`ready`, `in-review`, `ship` / Bug `resolved`, or claiming the session is done. When the implementation is done and a merge is requested, the agent MUST `ship` the node (Bug: `resolved`). Moves to `in-review` and `ship` also run the check's import-matrix and exclusivity rules on the node's files, under the revision's change (§3.6, §5.14), as a `Blocked:` that names the fix; a decision-worthy revision needs a recorded decision to enter `in-review` (§5.13). Warnings ride along and never block. The check runs no host typechecker; host typecheck is not a MindPlan gate.

### 9.7 Server startup and exit

- **Initialize first.** Nothing before the MCP `initialize` reply reads the graph (no graph load, migration check, search index, or model load), so the reply is fast whatever the graph's size. The search warm-up (§8.1.1) starts after the client's `initialized` notification; tool calls never wait on it.
- **Logged exits.** stdout carries only the protocol; logs go to stderr. An uncaught exception or unhandled rejection logs `mindplan-mcp: fatal: <message>` with its stack and exits 1. stdin closing (even before `initialize`) and `SIGINT` / `SIGTERM` log `mindplan-mcp: exiting (<reason>)` and exit 0.
- **Diagnosis.** `doctor` (§8.1) reports the server's health from a tool call, in every graph state.

---

## 10. External UI Synchronization (GitOps Integration)

**Not implemented.** No sync parser ships with MindPlan; this section records the intended design.

### 10.1 Principles

The repository is the write side: states move only through MCP tools, and Atomic Ops are ticked in the territory files. An external board (Jira, Linear, GitHub Projects) is a read-only projection for stakeholders: humans MUST NOT move tickets there, and the next sync overwrites any manual change. The board has no authority, so there is nothing for it to drift from.

### 10.2 Sync pipeline

On every merge to the main branch (or on a schedule), a CI step reads node states and edge arrays from the territory frontmatter, computes completion from each `<id>.mdx` checklist (open revisions' checklists informational), and sends idempotent calls to the tracker: create missing tickets (keyed by node `id`), move each ticket to the column of its node's state, and update checklist progress (a comment or custom field). Suggested columns: `draft` Backlog · `ready` To Do · `in-progress` In Progress · `in-review` In Review · `stable` Done (healthy) · `unstable` Done (degraded) · `deprecated` Archived · Bug `open` / `triaged` Bug Backlog / Triaged · Bug `fixing` / `in-review` In Progress / In Review · Bug `resolved` / `wontfix` Closed · Capability `incubation` / `evolving` / `stable` an Epic status field.

### 10.3 Implementation status

The parser belongs in CI, outside the MCP server; §6.1 (frontmatter and checklist syntax) and §7 (graph assembly) are its compatibility contract.

---

## 11. Compliance Checklist

An implementation is MindPlan-compliant if and only if:

- [ ] All graph state lives under `mindplan/` (§1.1); no external database (caches are derived, §1.1.3).
- [ ] The taxonomy (Capability, Interaction, Interface, Foundation, and Bug) and all six edge types are enforced (§2).
- [ ] The build pipeline, Bug lifecycle, and computed `stable` / `unstable` are enforced (§3).
- [ ] The stable-id revision model is enforced (§3.6): `open_next`, `revisions/<change>/`, ship with rebase, `resolve_conflict`, `discard_next`, and gates judging live plus one change; no version-lineage edge, no dependent relinking.
- [ ] Capability states are computed from member Interactions, never set (§4).
- [ ] Rules 1–12 are enforced before any write, fail-fast (§5), and every rejection starts with `Blocked: ` (§5.1).
- [ ] `<id>.mdx` and revision-file frontmatter is server-mirrored (§6); decisions are one file each (§6.1.2).
- [ ] The MDX component contract holds (§6.4): reserved names respected, project components opaque, no guardrail parses JSX.
- [ ] Edges persist in the source node's `<id>.mdx` frontmatter and assemble at runtime (§7); a revision's edge deltas are not live graph edges.
- [ ] The thirty-seven-tool MCP surface matches §8 (names, inputs, outputs, errors), including `root` on every tool and the version gate (§1.1.2).
- [ ] Mutations are deterministic (§9.1) and atomic (§5).
- [ ] Ownership is `implements` claims (files, or directories ending in `/`): no symbol-level mapping inside a file and no prescribed `src/<type>/<id>/` tree (§1.2, §1.4).

---

## Appendix A — Canonical error catalog

Every rejection starts with `Blocked: ` and names the rule, the nodes and states, and the fix (§5.1). Ids, counts, and versions below are examples.

| Rule | Example message |
|---|---|
| Unknown node | `Blocked: node "i-x" does not exist in mindplan territory.` |
| Duplicate node | `Blocked: node "i-checkout" already exists.` |
| Illegal edge shape | `Blocked: belongs_to edges must go Interaction -> Capability. Got Foundation "f-db" -> Capability "c-ordering".` · `Blocked: depends_on edges must originate from an Interaction, Interface, or Foundation. Got Capability "c-ordering" -> Foundation "f-db".` |
| Duplicate edge | `Blocked: edge i-checkout -depends_on-> f-db already exists.` |
| Manual Capability state | `Blocked: Capability states are computed automatically from their Interactions and cannot be set manually.` |
| Invalid state name | `Blocked: "active" is not a valid state. Valid manual states: draft, ready, in-progress, in-review, cancelled, deprecated, or "ship" from in-review. Production states stable/unstable are computed automatically after shipping.` |
| Illegal transition | `Blocked: illegal transition "draft" -> "in-review" for node "i-tips". Allowed from "draft": ready, cancelled.` |
| Manual stability | `Blocked: illegal transition "stable" -> "unstable" for node "i-checkout". Allowed from "stable": deprecated. Production posture (stable/unstable) is computed automatically from open Bugs. Use open_next to evolve a shipped Foundation/Interaction/Interface. To undo a mistaken ship, ask the user then call force_unship with confirm: "unship:i-checkout".` |
| Rule 1 (Ghost Interaction) | `Blocked: Ghost Interaction. "i-checkout" has no belongs_to edge to a Capability. Link it with link_nodes before moving it to "ready".` (with no Foundation: `… has no depends_on edge to a Foundation. …`) |
| Rule 2 (Ghost Interface) | `Blocked: Ghost Interface. "if-checkout-page" has no exposes edge to an Interaction. Link it with link_nodes before moving it to "ready".` |
| Rule 3 (Infra First) | `Blocked: Infrastructure First. Interaction "i-checkout" cannot ship while linked Foundations are not stable: "f-db" (in-progress). A dependency counts once stable, or in-review with at least one checklist item, every build item ticked, and its own dependencies counting the same way.` |
| Rule 4 (Behavior First) | `Blocked: Behavior First. Interface "if-checkout-page" cannot ship while exposed Interactions are not stable: "i-checkout" (in-progress). A dependency counts once stable, …` (same last sentence as Rule 3) |
| Interaction Independence | `Blocked: Interaction Independence. Interactions must not depend_on each other. "i-a" -> "i-b" is illegal — share application state through a Foundation instead. Use leads_to for Capability navigation/progression only.` |
| Dependency cycle | `Blocked: depends_on edge f-a -> f-b would create a dependency cycle.` |
| Cycle across changes | `Blocked: depends_on "f-a" -> "f-b" (change "pay") would close a dependency cycle across changes "pay", "tax": f-a -> f-b -> f-a. The changes could never ship in any order; move the shared part into a Foundation both depend on.` |
| open_next: not shipped | `Blocked: only shipped Foundations/Interactions/Interfaces (stable or unstable) open revisions. "i-checkout" is currently "in-progress".` |
| open_next: no change | `Blocked: open_next needs change: every revision of a shipped node belongs to one change id (a slug, e.g. "add-export"). Retry with open_next({ node_id: "i-checkout", change: "<change-id>" }).` |
| open_next: already open | `Blocked: "i-checkout" already has an open revision of change "split-pay" in state "draft". Edit it (pass change: "split-pay"), ship it, or discard_next({ node_id: "i-checkout", change: "split-pay" }).` |
| Several revisions, no change | `Blocked: "i-checkout" has open revisions "split-pay", "tips"; pass change.` |
| ship: revision not in-review | `Blocked: ship is only allowed from a revision in-review. "i-checkout" revision is currently "in-progress".` |
| Rebase conflict | `Blocked: "i-checkout" revision "tips" has 1 unresolved rebase conflict(s): section "## Spec". Resolve each with resolve_conflict({ node_id, change, ... }). Fix: resolve_conflict({ node_id: "i-checkout", change: "tips", section: "## Spec", take: "revision" \| "live" \| "text" }).` |
| discard_next: nothing to discard | `Blocked: node "i-checkout" has no open revision to discard (a leftover mirror file is not a revision; upgrade_project removes it).` |
| force_unship with revisions | `Blocked: "i-checkout" has open revisions ("tips"); ship or discard_next each before force_unship.` |
| Claims replace | `Blocked: set_implementation_files files replaces the whole list only with replace: true. Pass add / remove to change entries (add is the default), or files with replace: true.` |
| Rule 5 (Completion) | `Blocked: Completion Check. 3 unchecked checkbox(es) remain in i-checkout/i-checkout.mdx. All [ ] items must be [x] before moving to "ship".` |
| Impact section | `Blocked: Minimum Territory Shape. "if-checkout-page"/if-checkout-page.mdx section "## Impact" is empty or a stub. Write what this node adapted so the already-shipped contract still holds.` |
| Batch with no move | `Blocked: no item of this batch could move; nothing was written.` followed by one `- "<id>" -> <status>: <reason>` line per item, then the change hints |
| Change hint | (last line of a Blocked move of a change member) `To move the whole change: update_node_status({ scope: "change", change: "pay", new_status: "ship", skip_review: true })` |
| Not a member | `Blocked: "i-tax" is not a member of change "pay"; its members: "f-ledger", "i-pay".` |
| Rule 6 (Ghost Bug) | `Blocked: Ghost Bug. "bug-race" has no affects edge to an Interaction, Interface, or Foundation. Link it with link_nodes before moving it to "triaged".` |
| No edge to remove | `Blocked: no edge exists between "i-tips" and "f-db".` |
| Shipped scope freeze | `Blocked: title cannot be changed on Interaction "i-checkout" (stable). Use open_next for material scope changes on live work.` |
| Coverage | `Blocked: Coverage: "src/i-b/extra.ts" is inside the configured sources but no node claims it in a current or next slot. Probable owner by path: "i-b". Fix: set_implementation_files({"node_id":"i-b","add":["src/i-b/extra.ts"]}).` |
| Checklist item not found | `Blocked: no item with that exact text ("Write"); items: "Write docs" {#docs}, "Spec written" {#spec}. Pass an item's id, or its full text without tag or annotation.` |
| Ambiguous checkbox | `Blocked: "Write docs" matches 2 items; pass an id, or all: true. Matches:` followed by one `- <line>` per match |
| Review skip | `Blocked: this walk would take "f-quick" to ship without a review stop (not in-review yet). Walk to in-review first and review, or pass skip_review: true …` |
| Empty change | `Blocked: change "feat-x" has no members. Set it with open_next, create_node, or patch_node_territory (change).` |
| Rule 12 (Decision) | `Blocked: Decision. "f-payments" contract changes (an open revision of a shipped Foundation), and no decision is recorded for this revision (under change "pay-v2" or on the node). Record the choice and the alternative you rejected. An additive alternative leaves "f-payments" closed: a new node that depends_on it, or a split of it; name it in alternatives if you rejected it. Fix: record_decision({"node_id":"f-payments",…,"change":"pay-v2"}).` |
| Decision on a Bug | `Blocked: "bug-race" is a Bug; record the decision on the node the fix shapes (it affects "i-checkout").` |
| Version (no graph) | `Blocked: Version — This project has no MindPlan graph (mindplan/). Call setup_project to create it, then follow the guide it returns.` |
| Version (upgrade) | `Blocked: Version — This graph needs an upgrade: the graph is at migration level 0, and mindplan-mcp 0.13.0 needs level 1. Call upgrade_project, then commit the upgrade on its own.` |
| Version (server behind) | `Blocked: Version — This graph was upgraded by mindplan-mcp 0.14.0 (migration level 2), newer than this server 0.13.0 (level 1). Upgrade mindplan-mcp (npm install -D mindplan-mcp@0.14.0, or point npx at it) before using the graph.` |
| Rules | `Blocked: Rules: create_node acts before the project rules reached you in this session. Call get_project (or get_rules), with the same root when you passed one, read the rules, then retry.` |
| Merge (stale territory) | `Blocked: Merge: "i-checkout" (Interaction, stable): claimed files changed against main but its territory did not: "src/i-checkout/pay.ts". Update the node so it matches the code: open_next({ node_id: "i-checkout", change: "<change-id>" }) and ship it when its contract changed, or patch_node_territory({ node_id: "i-checkout", ... }) in place when it holds.` |
| Root without a graph | `Blocked: root "D:/work/feature-x" has no mindplan/ folder` |
| Root not a directory | `Blocked: root "D:/work/feature-y" is not an existing directory` |
| After merge | `Blocked: after-merge: node id "i-pay" is in 2 folders (…). Keep one: merge what the others hold into it and delete them.` |
| Supersede out of reach | `Blocked: "d-soft-delete" is held by "i-cancel", which "i-reschedule" does not inherit decisions from. …` |

## Appendix B — Reference lifecycle walkthrough

```
get_project()                                  → playbook, project description and rules
create_node(c-ordering, Capability)            → c-ordering: draft (computed)
create_node(f-db, Foundation, role: infra)     → f-db: draft
create_node(i-checkout, Interaction)           → i-checkout: draft
create_node(if-checkout-page, Interface)       → if-checkout-page: draft
… each create_node leaves its node oriented for this session (§8.1.2); required sections written (§6.5) …
update_node_status(i-checkout, ready)          → Blocked: Ghost Interaction (no Capability link)
link_nodes(i-checkout, c-ordering, belongs_to)
link_nodes(i-checkout, f-db, depends_on)
update_node_status(i-checkout, ready)          → ok
update_node_status(i-checkout, in-progress)    → ok; c-ordering → incubation
… agent claims its files (set_implementation_files), implements, checks off Atomic Ops …
update_node_status(i-checkout, in-review)      → ok
update_node_status(i-checkout, ship)           → Blocked: Infrastructure First (f-db is in-progress)
… f-db reaches in-review with every build item ticked: it now counts as ready for dependents (§5.4) …
update_node_status(i-checkout, ship)           → ok (all [x]); i-checkout: stable; c-ordering → stable
update_node_status(f-db, ship)                 → ok; f-db: stable

link_nodes(if-checkout-page, i-checkout, exposes)
update_node_status(if-checkout-page, ready)    → ok (exposes present)
… implement the Interface, claim its files …
update_node_status(if-checkout-page, in-review) → ok
update_node_status(if-checkout-page, ship)     → ok (Behavior First: i-checkout stable)

create_node(bug-race, Bug)                     → bug-race: open
update_node_status(bug-race, triaged)          → Blocked: Ghost Bug (no affects edge)
link_nodes(bug-race, i-checkout, affects)      → i-checkout: unstable (stability recomputed)
update_node_status(bug-race, triaged)          → ok; c-ordering unchanged (still stable)
update_node_status(bug-race, fixing)           → ok
… fix the bug, check off the Fix Checklist …
update_node_status(bug-race, in-review)        → ok
update_node_status(bug-race, resolved)         → ok; i-checkout: stable

link_nodes(i-a, i-b, depends_on)               → Blocked: Interaction Independence
link_nodes(i-checkout, i-tip, leads_to)        → ok (navigation; not a gate)

… months later, in a new session: checkout gains split-payment support (same id, no new node) …
open_next(i-checkout, change: split-pay)       → Blocked: Orientation (i-checkout not oriented on in this session)
orient_for_work(node_id: i-checkout)           → rules, decisions, body, files, blast radius; writes on i-checkout unlocked
open_next(i-checkout, change: split-pay)       → i-checkout: still stable (<id>.mdx untouched); revisions/split-pay/<id>.mdx created in draft
open_next(i-checkout, change: tips)            → a second revision, revisions/tips/<id>.mdx, in draft; each judged against live plus itself
update_node_status(i-checkout, ready, change: split-pay)  → revision split-pay → ready (tips untouched)
update_node_status(i-checkout, in-progress, change: split-pay) → split-pay → in-progress; c-ordering → evolving
… agent implements, checks off Atomic Ops in revisions/split-pay/<id>.mdx …
update_node_status(i-checkout, in-review, change: split-pay) → ok
update_node_status(i-checkout, ship, change: split-pay)      → ok (all [x] in the revision); live ⊕ split-pay written to <id>.mdx (same id "i-checkout");
                                                  revisions/split-pay/ deleted; tips rebased: rebased: [{ change: "tips", conflicts: ["section:## PRD"] }];
                                                  i-checkout: stable; c-ordering → stable
resolve_conflict(i-checkout, change: tips, section: "## PRD", take: "text", text: …) → conflicts: []; tips may now move to in-review
```
