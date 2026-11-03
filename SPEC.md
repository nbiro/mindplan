# MindPlan Specification

**Version:** 0.1.0
**Status:** Unreleased
**Reference implementation:** repository root (TypeScript MCP server, stdio transport)

The key words MUST, MUST NOT, SHALL, SHOULD, and MAY in this document are to be interpreted as described in RFC 2119.

---

## 0. Abstract

Everything works great until it doesn’t. MindPlan draws the boundaries your agent won’t. Without them you get a 5,000-line app file; MindPlan keeps the product’s structure as a **persistent, machine-queryable graph** in git and rejects any agent move that crosses it with a machine-parsable `Blocked: …` error.

The model is **Interaction-centric**. Agents query *what the system does* (Capabilities → Interactions), *how actors enter those behaviors* (Interfaces), and *what shared substrate those behaviors stand on* (Foundations), composed by an Assembler — instead of reconstructing architecture from source on every task.

MindPlan is exposed exclusively through a Model Context Protocol (MCP) server — the single write path to graph state. Direct file edits to server-owned frontmatter are out of contract (§9.3). The always-on agent artifact is the **systems dialect**: a one-screen playbook (`templates/agent/playbook.md`) covering orientation, the taxonomy and edges, file claims, `Blocked:` handling, blast-radius classification, graph-first new features, and handoff (the graph matches the implementation; ship when a merge is requested; `check --merge` is the merge gate). On connect, MCP server `instructions` are a **short pointer** that requires `get_project` before the first answer or code change, `get_rules` then `orient_for_work` before each action, and the `plan-project` skill before new-feature code when nodes must be updated or created; `get_project` returns the playbook plus the **project brief** (`mindplan/project.md` — description and standing rules) (§1.1.1). Instructions MUST NOT embed the playbook, description, or rules bodies. The playbook and the skills ship with the package and are served by the server (`get_project`, `get_skill`, §8.1); nothing is copied into the repository. Setup is the MCP tool `setup_project` (§8.2): it creates `mindplan/` and returns the pointer text (`templates/agent/agents-stub.md`) that the agent writes to `MINDPLAN.md` at the repository root, plus a guide for wiring that file into the host's agent files; `upgrade_project` brings an existing graph to the server's migration level (§1.1.2). Procedures load on demand with `get_skill`: entity scaffolding in `define-entities` and graph create/patch (including before new-feature code) in `plan-project`. The parent may self-`ready` (`draft → ready`) and self-`ship` / self-`resolved` when default check is green and Rules 1–6 allow (§3.1). Code review and similar process gates are outside the dialect. Handoff check is playbook-level, not server-enforced.

`GRAPH_VERSION` remains `1`. This Interaction-centric taxonomy is a **breaking** change accepted while the package is unreleased — there is no consumer compatibility layer for the former Workflow-centric schema.

---

## 1. Core Architecture: Territory

MindPlan persists the product graph under `mindplan/`. Each node owns a folder containing a `<id>.mdx` file and an `attachments/` directory. The `<id>.mdx` YAML frontmatter is the **node record** — identity, state, timestamps, and outgoing edge arrays; it is the live, stable id for the node's entire lifetime (§3.6). The body contains Purpose / PRD / Execution Logic / Shared Substrate Spec, Acceptance Criteria, and Atomic Operations.

A shipped Foundation, Interaction, or Interface (`stable`/`unstable`) MAY hold several open **revisions** under the same id while `<id>.mdx` keeps serving, one per change id, each in its own folder `revisions/<change>/` (`<id>.mdx`, `attachments/`, `decisions/`); a revision folder exists only while that revision is open. Revision folders exist only for Foundations, Interactions, and Interfaces (§3.6) and are never present on Capabilities or Bugs. A node's decision records are one file each, `decisions/<decision-id>.md` (§6.1.2).

Context files are MDX: standard Markdown plus optional JSX components (§6.4). Markdown remains the load-bearing syntax — every compiler rule operates on Markdown constructs only, and a context file containing no JSX at all is fully compliant.

The territory MUST live in the repository alongside the source code and MUST be versioned with it. A commit therefore captures code, architecture, and requirements in one atomic snapshot.

### 1.1 Directory layout

MindPlan prescribes the **planning tree** under `mindplan/`. Implementation code is **not** a second prescribed tree: Interactions, Interfaces, and Foundations declare owned paths via `implements` (§1.2) anywhere under the project's `sources`/`exclude` universe (default `sources: ["src/**"]`). Capabilities have no code ownership. Bugs are a defect layer whose fixes land in the affected node's claimed files.

```
<project-root>/
├── .mindplan-cache/                   # Derived graph and search caches, gitignored, safe to delete (§1.1.3, §8.1.1)
├── mindplan/
│   ├── config.json                    # { sources, exclude } — coverage universe (§1.2)
│   ├── project.md                     # Project brief — description + rules (§1.1.1)
│   ├── version.json                   # { package, graph, migrations } — written by setup_project / upgrade_project (§1.1.2)
│   ├── map.md                         # Derived Mermaid snapshot (§7.4) — git-ignored, never in changed_files
│   ├── .gitignore                     # Lists map.md (migration level 4)
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

- The planning root is `<MINDPLAN_ROOT>/mindplan`, where `MINDPLAN_ROOT` is an environment variable resolving to the target project root. If unset, the server's working directory is used.
- Each entity folder name under `mindplan/` MUST equal the node `id`.
- The live record of a new node MUST be named `<id>.mdx` (the same id as the folder) so a review diff shows which node changed. A revision file MUST be named `<id>.mdx` inside `revisions/<change>/`. A legacy `current.mdx` remains valid: the server MUST read and write the file that already exists. When both the legacy name and the id name exist for one slot and both are regular files, the server MUST delete the legacy file and keep the id-named file. The id name MUST NOT win when it is the same directory entry as the legacy file, including a case-only difference. A deletion MUST be reported: MCP tool results include the deleted path in `removed_legacy_files` and, when present, `changed_files`; `check` and `view` print `Removed <legacy> (kept <id-named>)` on stderr.
- `upgrade_project` (§8.2) MUST rename a legacy `current.mdx` to `<id>.mdx`, and a legacy `next.mdx` to `<id>.next.mdx`, inside that node's folder, before any graph load. When both names are already present it MUST delete the legacy file and keep the id-named file. Any evolution file under `capabilities/` or `bugs/` (`next.mdx` or `<id>.next.mdx`) MUST stop the upgrade before any rename and name the file to fix by hand. A rename the filesystem rejects MUST stop the upgrade, name the file to fix by hand, and list every rename or removal already applied in that call. A second call on id-named files MUST rename nothing. When the legacy name and the id name are the same file (`id` is `current`, including case-only folder names), the upgrade MUST leave that file in place.
- The subdirectory per type is fixed: `capabilities/`, `foundations/`, `interactions/`, `interfaces/`, `bugs/`.
- `revisions/` MUST NOT exist for Capabilities or Bugs; it is legal only under `foundations/<id>/`, `interactions/<id>/`, and `interfaces/<id>/` (§3.6). A shipped node has `revisions/<change>/` only while its revision of change `<change>` is open. The folder name MUST equal the revision file's `change`. A pre-ship node has no revision folder. A legacy `<id>.next.mdx` / `next.mdx` with `next-attachments/` (releases before 0.18.0) is moved into `revisions/` by `upgrade_project`; until then the graph needs an upgrade (§8.2 version gate), and the store never reads it. A live file whose name is `next.mdx` because the id is `next` is not an evolution file.
- `attachments/` MAY contain arbitrary files. Attachments SHOULD be referenced from `<id>.mdx` with relative links (e.g. `![flow](attachments/flow.png)`); a revision's `attachments/` is referenced the same way from its `<id>.mdx` and is copied into the node's `attachments/` when that revision ships (§3.6).
- `decisions/` holds one append-only file per decision record (§6.1.2), beside the live file or inside a revision folder; a revision's decision files move to the node's `decisions/` when it ships.
- `map.md` is derived (§7.4): the server rewrites it after graph mutations, `mindplan/.gitignore` lists it, and no tool reports it in `changed_files`.
- `components/` MAY contain project-specific MDX components (§6.4.3). It is created by the server but never read by it.
- The server MUST NOT create `mindplan/` at boot or on a gated call: `setup_project` (§8.2) creates the tree, and until then gated tools are `Blocked: Version` (§1.1.2). Once `mindplan/` exists, the server MUST create missing subdirectories on demand.
- A read, write, copy, or removal of a file under `mindplan/` (node files, attachments, `project.md`, `version.json`, and the files the graph cache hashes) that fails with `EBUSY` or `UNKNOWN`, or on Windows with `EPERM` or `EACCES` (another process holding the file for a moment, as antivirus, an indexer, or a file watcher does right after a write), MUST be retried a few times, about 0.3 s in all, before the call fails with that error. Any other error fails the call at once; outside Windows `EPERM` and `EACCES` are permission errors and are not retried.
- `create_node` does **not** scaffold application code paths. Declare ownership with `set_implementation_files`.

#### 1.1.1 Project brief (`mindplan/project.md`)

Each consumer repo MAY hold a **project brief** — what this product is, and standing rules for every change — at `mindplan/project.md`. It is not a graph node, not frontmatter, and not a compiler rule. Agents MUST edit the description through `patch_project_description` and the rules through `patch_project_rules` (MCP / territory store); do not hand-edit `mindplan/project.md`.

The brief template is the package file `templates/agent/project.md` (`## Description` and `## Rules`). `setup_project` copies that file when `mindplan/project.md` is absent. Description starts empty. Rules start with the default requirement to list every `mindplan/` path in an MCP write's `changed_files`.

**Two rule scopes.** The project brief's rules are **global**: they apply to every change, and `get_rules` returns them before every action, so they MUST stay short. A rule about one part of the code belongs on that part's node as **node rules** (§6.1.1), written with `patch_node_rules` and delivered by `orient_for_work` (§8.1). Both scopes are mandatory prose; neither is a compiler rule and neither overrides a `Blocked:`.

Rules:

- Missing `project.md` is valid. `mindplan-mcp check` MUST NOT require it. Boot MUST NOT fail when it is absent or unreadable.
- `setup_project` MUST copy `templates/agent/project.md` when `mindplan/project.md` is absent. That markdown file is the brief template; do not hardcode its body in TypeScript. No tool overwrites an existing brief except `patch_project_description` / `patch_project_rules` (product text is owned by the repo).
- Brief rules are **mandatory** for agents. Call `get_rules` before each action. They MUST NOT override a compiler `Blocked:`. The description is the product summary, not a rule.
- Do **not** paste the systems dialect into `project.md`. The playbook stays in the package (`templates/agent/playbook.md`); `get_project` composes it with the brief at read time.
- **Primary channel:** on every MCP connect, server `instructions` MUST be a short pointer that requires `get_project` before the first answer or code change; `get_rules` then `orient_for_work` before each action; and the plan-project skill (loaded with `get_skill`) before any new-feature code change when nodes must be updated or created. Instructions MUST NOT embed the playbook body, the project description, or the rules body.
- **Live read:** MCP tool `get_project` (§8.1) returns `{ path, description, rules, playbook, check, version? }` (`version` only when the graph status of §1.1.2 is not `current`). `get_rules` returns `{ path, rules }` only. `description` / `rules` come from `loadProjectBrief()`; `playbook` is always the bundled dialect. Missing playbook → `Blocked:`. Call `get_project` again after a description change; call `get_rules` after a rules change.
- **Redundancy:** the pointer text (`templates/agent/agents-stub.md`, returned as `pointer` by `setup_project` and `upgrade_project`) is what the agent writes to `MINDPLAN.md` at the repository root and wires into the host's agent files (`@MINDPLAN.md` in `CLAUDE.md`, a line in `AGENTS.md`, or the host's rules file). It tells agents to call `get_project` first, `get_rules` / `orient_for_work` before each action, load the skills with `get_skill`, never read or edit `mindplan/**` with host file tools (the server is the only writer, and reads go through MCP because a raw node file lacks the rules inherited along `belongs_to` and `depends_on`, decision status, the active slot, and the orientation the write gate needs, §8.1.2), and call the tool a `Blocked: Version` names. The server MUST NOT write these repo-owned files (`MINDPLAN.md`, `CLAUDE.md`, `AGENTS.md`, `.gitignore`, `.cursorignore`, host rules files); the agent does, following the returned guide.
- **Storage seam:** the brief loads through `loadProjectBrief` (today `mindplan/project.md`). A later remote store MAY replace that read; `get_project` and `get_rules` keep the same contract. This specification does not define a cloud backend.

#### 1.1.2 Version stamp (`mindplan/version.json`)

Consumers install `mindplan-mcp` from npm and upgrade it like any dependency. Some releases change the graph's on-disk conventions, so the tree records which package last set it up or upgraded it, its graph format, and the **migration level** it reached: `{ "package": "<semver>", "graph": <GRAPH_VERSION>, "migrations": <level> }`.

- **Writers.** Only `setup_project` (when it creates the graph) and `upgrade_project` (after every migration succeeded) write the stamp, with the running package version, `GRAPH_VERSION`, and the server's `MIGRATION_LEVEL`. No other tool and no CLI command writes it.
- **Migration level.** `MIGRATION_LEVEL` is the integer level the server's migrations bring a graph to (`4` in this release). A release MUST raise it by one when it adds a migration to `upgrade_project`, and MUST NOT raise it otherwise: a release that adds no migration needs no upgrade step. The gate never compares package versions; `package` is informational, except in the `server-behind` warning. A stamp without `migrations` (written by the retired `init` command), or whose `migrations` is not a non-negative integer, reads as level 0. A stamp is **unreadable** when it is not a JSON object with a SemVer `package` and an integer `graph`.
- **Status.** The server compares the tree with itself in this order, and each status but `current` has one warning sentence naming the fix:
  - `setup` — no `mindplan/`, or a `mindplan/` with no stamp and no node folder (empty folders an older server created at boot, or a setup that stopped before its stamp; `setup_project` finishes it and `upgrade_project` may migrate it): `This project has no MindPlan graph (mindplan/). Call setup_project to create it, then follow the guide it returns.`
  - `server-behind` — a readable stamp whose `graph` is above `GRAPH_VERSION` or whose level is above `MIGRATION_LEVEL`: `This graph was upgraded by mindplan-mcp <package> (migration level <N>), newer than this server <version> (level <M>). Upgrade mindplan-mcp (npm install -D mindplan-mcp@<package>, or point npx at it) before using the graph.`
  - `upgrade` — a missing or unreadable stamp, a `graph` below `GRAPH_VERSION`, or a level below `MIGRATION_LEVEL`: `This graph needs an upgrade: <mindplan/version.json is missing | mindplan/version.json is unreadable | the graph is at migration level <N>>, and mindplan-mcp <version> needs level <M>. Call upgrade_project, then commit the upgrade on its own.` A stamp at the level while `mindplan/journeys/` holds a node folder (one with a live file) (a branch from before level 3 merged one in) is also `upgrade`: `This graph needs an upgrade: mindplan/journeys/ still holds a node folder, and mindplan-mcp <version> reads Capabilities only from mindplan/capabilities/. Call upgrade_project, then commit the upgrade on its own.` So is a stamp at the level while a Foundation, Interaction, or Interface folder with a live `<id>.mdx` holds a legacy `<id>.next.mdx` that is not a `state: mirror` leftover (a branch from before level 4 merged one in): `This graph needs an upgrade: <path> is an evolution file from before revisions/<change>/, and mindplan-mcp <version> reads open revisions only from revisions/. Call upgrade_project to move it, then commit the upgrade on its own.`
  - `current` — otherwise.

#### Version gate

While the status is not `current`, every MCP tool except nine fails before it loads or writes the graph with `Blocked: Version — <warning>`. The nine **ungated** tools are `get_project`, `get_rules`, `get_spec`, `get_skill`, `run_check`, `acknowledge_warning`, `doctor`, `setup_project`, and `upgrade_project`.

- `get_project` carries the warning as `version` (§8.1), so the first call of a session names the fix.
- `run_check` and `mindplan-mcp check` fail with the same `Blocked: Version — <warning>` line and run no other check, since the code may misread a graph it does not understand (§9.6).
- `setup_project` is Blocked in `upgrade` and `server-behind`; `upgrade_project` is Blocked in `setup` and `server-behind` (§8.2).
- `MINDPLAN_VERSION_GATE=off` turns the gate and the check's version failure off for one process (test fixtures that build a graph without a stamp), as `MINDPLAN_ORIENT_GATE=off` does for the orientation gate (§8.1.2).

**Migrations.** Every migration MUST be idempotent, so `upgrade_project` runs all of them on every call: a graph already at the level is left as it is, and a node a stale branch merged in an old format is brought up to date by the next call. In order: (level 3) moving Capabilities, which releases before 0.17.0 called Journeys: every `mindplan/journeys/<id>/` folder that holds a live file, attachments included, moves to `mindplan/capabilities/<id>/`; before the move `type: Journey` in its live file becomes `type: Capability` and the scaffold stubs `create_node` used to write are replaced by the current ones; every run also applies that rewrite to every `mindplan/capabilities/<id>/` live file, so a folder moved by hand is repaired by the next upgrade; until then, loading a live file that still says `type: Journey` is `Blocked: type "Journey" in <file> is the old name of Capability. Call upgrade_project, which rewrites it, then commit the upgrade on its own.`; `journeys/` is removed once it holds nothing but `.gitkeep` files and empty folders, and a folder there with no live file is not a node and blocks nothing; ids and other body text are left as they are, and an id present in both folders is `Blocked:` naming both paths, after the moves made before it; then legacy territory file names (§1.1), a legacy `implementation_packages` config (§1.2.1), Atomic Ops left on shipped nodes (§5.6), leftover `state: mirror` twins (§3.6), the `revisions` / `churn` / split backfill (§5.15), deleting `mindplan/agent/` (the playbook, skills, integrations, and MCP example the retired `init` copied there), and (level 2) stripping change labels: the `change` and `change_ref` scalars are removed from the live file of every shipped, active Foundation, Interaction, or Interface, with or without open revisions (a revision's own change lives in its revision file) (§3.7). Releases before 0.15.0 wrote them as neighbor labels; only a revision carries a change id now. A branch from an older release merged later brings a label back, and the next `upgrade_project` strips it. Then (level 4, §3.6): every legacy `<id>.next.mdx` (or `next.mdx`) of a Foundation, Interaction, or Interface moves to `revisions/<change>/<id>.mdx`, `<change>` being the next file's `change`, else `rev-<id>`; its edges, claims, and tests become add/remove deltas from the live file to the next file, its scalars, state, dates, `change_ref`, `attributed`, and `split_into` are kept, and `base` hashes the current live file as the decisions split below leaves it, so the moved revision holds no conflict; its body loses `## Rules` and `## Decisions`, each next-file decision live does not hold is copied verbatim to `revisions/<change>/decisions/<id>.md`, `next-attachments/` (but `.gitkeep`) moves to `revisions/<change>/attachments/`, the revision file is written (atomically, last but one), and the next file and `next-attachments/` are deleted. A leftover `state: mirror` file is skipped (the mirror pass removes it). A run stopped part way resumes: a `revisions/<change>/` with no revision file, or with exactly the file this move writes, is finished; one holding a different revision, an invalid change id, or a next-file `###` entry whose id does not parse is `Blocked:`. Every live file's `## Decisions` section is split into `decisions/<id>.md` files, each entry's raw text copied verbatim (from its `###` heading to the next heading of any level), and removed from the body, every other byte and the line endings kept; a decision file already there with the same entry is kept, one with another is `Blocked:`, and so is a `###` entry whose id does not parse or that has no `- Decision:` line. Finally `map.md` is added to `mindplan/.gitignore` (the file is created when missing) and, inside git, untracked with `git rm --cached` (the working copy stays). The report fields are `revisionsMoved` (`{ node_id, change }` each), `decisionsSplit` (`{ node_id, count }` each), and `mapIgnored` (true when this run changed the ignore file or the index). Commit the upgrade on its own, the untracked `mindplan/map.md` included.

#### 1.1.3 Graph cache (`.mindplan-cache/graph.db`)

Every tool loads the graph, and parsing every `<id>.mdx` costs about a millisecond per node, so the server keeps parsed node records in a derived cache: in memory per process, and in `.mindplan-cache/graph.db` at the project root (Node's built-in `node:sqlite`; memory only where it is unavailable). The `.mdx` files stay the only source of truth. Like the search cache (§8.1.1), it is gitignored, never in `changed_files`, never part of the coverage universe, and safe to delete. The same folder holds `acks.json`, the warning ids `acknowledge_warning` stored for this checkout (§8.2); deleting it shows those warnings again.

- **Freshness, per node folder.** A load MUST return what parsing every file would return. Inside git, a record is reused without touching its files only when it was parsed while its folder was clean at a plan tree T (no git status entry, and every file at least 2 seconds older than the status call), git status lists nothing under the folder now, and the folder did not change between T and the plan tree of the commit that status call reports. Folder paths from git and from the file system are compared case-folded and NFC-normalized, so a spelling difference can only re-check a folder, never skip one. Every other record is checked by its `.mdx` files' stamps (name, size, mtime): a stamp taken within 2 seconds of a file's mtime is not trusted, so that folder is hashed when parsed and compared by content until its stamps settle. Anything else re-parses the folder. A folder whose files change during its parse is not cached.
- **When git is used.** Git costs a status call and a tree lookup per load (about 0.1 s on Windows), so it is used from 1,000 node folders on, and only when git can vouch for every plan file: outside a work tree, before the plan's first commit, or when git ignores a plan file, every record is checked by stamp.
- **Limits.** Like git's own stat check, a stamp cannot see an edit that keeps a file's size and restores its old mtime. Git status does not report files marked `assume-unchanged` or `skip-worktree`, so in git mode their edits are not seen either. `MINDPLAN_GRAPH_CACHE=off` turns the cache off for one process (`git` or `stamps` forces one mode).
- **Invalidation.** Each record carries the parser that made it (the package version plus a hash of the built modules that shape a record, so a rebuilt source checkout counts as a new parser), and a server reads only its own parser's records, so servers of two versions sharing the file never trade records; opening the file drops other parsers' rows. A change of the cache schema drops every record. A corrupt file is deleted and rebuilt; any other open failure leaves the cache in memory only. Records returned by a load are copies: a caller that mutates one does not change the cache.

### 1.2 Declared file ownership

Interaction, Interface, and Foundation nodes declare the files they own via server-owned frontmatter `implements: string[]` (written only by MCP — `set_implementation_files`). Entries are repo-relative POSIX paths: exact files, directories ending in `/` that own everything beneath, or **glob claims**. Queries and `check` expand directories and globs to the files on disk. Paths MUST NOT contain `..` or live under `mindplan/`. `.gitkeep` is ignored.

**Glob claims.** An entry containing `*`, `**`, or `?` is a glob. `*` and `?` match within one path segment; `**` matches any depth. `[` and `]` are literal, so App Router folders such as `[slug]` are plain paths. A glob ending in `/` owns every file beneath each matching directory: an action that owns its views in every template claims `src/templates/*/actions/i-read-post/`. A glob entry exists on disk (presence, §9.6) when it matches at least one file. Exclusivity is per expanded file: two nodes whose claims (glob or not) cover the same file conflict, and `set_implementation_files` rejects the second claim. `get_node_implementation` lists the concrete files a glob expands to, and a path lookup finds its owner through a glob.

| Node type | Ownership |
|---|---|
| Interaction | Declared files — domain/view-model **and** the exportable surface (UI: mountable view; CLI/MCP/Webhook/Cron: handler) |
| Interface | Declared files — mounts/wires Interactions; MUST NOT own screen bodies or core domain |
| Foundation | Declared files — shared substrate by `role` (assembler, infra, design-system, adapter) |
| Capability | *(none)* — architecture is the union of member Interaction files plus Interfaces that expose them |
| Bug | *(none)* — fixes land in affected targets' files |

Rules:

- Before `in-review` / `ship`, the claim list being judged (live, or live with the revision's delta) MUST be non-empty and every entry MUST exist on disk. While building, `implements` may name intended paths that do not exist yet.
- A revision holds its claims as a delta against live (`implements_add` / `implements_remove`, §6.1); its claim list is live with that delta applied, and `ship` writes it to live. A live entry is **released** under change C when C's revision removes it (another owner may claim it under C). Retired nodes (`cancelled`/`deprecated`) may only shrink their list.
- **Exclusivity per change.** Each file has at most one owner live, and at most one under each change (live plus that change's revisions, §3.6). Two revisions of the same change claiming one file fail. Revisions of different changes may both claim a file that no live claim covers: the check warns (`exclusivity: "<file>" is claimed by revisions of different changes: …`), and whichever ships second meets the first one's live claim (a claim conflict when the two are revisions of one node, §3.6; otherwise its exclusivity gate at `in-review` / `ship`).
- **Additive claims on shipped nodes.** A folder F is **dominated** by node N when N's live claims include at least one existing file directly in F, and no other non-retired node claims F, claims a path under it, or covers a path under it (directory or glob), live or in any open revision. A shipped node's live list changes only through a revision (`open_next`), except an **additive** change, which `set_implementation_files` writes in place (§8.2): every old entry is kept or covered by a new directory entry, and each new entry is an exact file whose parent folder N dominates, or a directory `F/` where N dominates F. Removing or moving a claim, a glob, or a path outside a dominated folder is `Blocked:` → `open_next`, and so is an entry that reaches a migration or schema file (config `decisions.schema_files`, §1.2.1): an exact file that matches, or `F/` when F is a schema folder or holds a matching file. Such a claim is decision-worthy (§5.13), and only a revision reaches the decision gate. Entries added in place are listed in the live file's `added_claims` (§6.1) until the body names them.
- *Rationale:* the blast-radius rule protects dependents from contract changes. A new file in a folder nobody else can own is a neighbor change (files change, behavior doesn't, §3.7), not a contract change; without it agents put the file in some other folder the node claimed as a directory, splitting related code for ownership reasons.
- Agents MUST implement only in files their node claims. Cross-cutting reuse goes through Foundations — not Interaction→Interaction `depends_on` (illegal; §2.2, §5.9).
- Agents query files via `get_node_implementation` (§8.1) and blast-radius `affected_files`.

#### 1.2.1 Source universe (`mindplan/config.json`)

```json
{
  "sources": ["src/**"],
  "exclude": []
}
```

- Missing config → `sources: ["src/**"]`, `exclude: []`.
- Brownfield may start with `sources: []` and widen over time.
- A config that still has `implementation_packages` MUST hard-fail with `Blocked:` pointing at `upgrade_project` (migration, §1.1.2). Invalid JSON / shape also hard-fails.
- `create_node` does **not** scaffold `src/<type>/<id>/`. Declare files with `set_implementation_files`.
- Default `mindplan-mcp check` enforces exclusivity, coverage, presence, leftovers, and the import matrix over the universe plus every claimed file. Opt-in `--base` applies dirty-src lifecycle using the implements index.
- **Decision-gate settings (optional).** `decisions: { blast_radius?, schema_files? }` tunes when a revision is decision-worthy (§5.13). `blast_radius` is a non-negative integer (default `5`); `schema_files` is a glob list (default `**/migrations/**`, `**/migration/**`, `**/*.prisma`, `**/schema.sql`, `**/structure.sql`, `**/db/schema.rb`: database migrations and schema dumps only, so JSON Schema, zod, or GraphQL modules named `schema` do not gate a change; widen the list to include them). Absent fields take the defaults, and a config without `decisions` is written back without it. Unknown keys, a negative or non-integer `blast_radius`, or an empty glob hard-fail like any invalid config, and `patch_config` rejects an unknown `decisions` key rather than ignoring it (§8.2).
- **Hotspot settings (optional).** `hotspots: { half_life_days?, outlier_ratio?, min_rate? }` tunes the hotspot signal (§5.15): how many days a node's recent ship rate takes to fade by half (`half_life_days`, default `30`), how many times the graph's median rate makes a node an outlier (`outlier_ratio`, default `3`), and the lowest rate that can be one (`min_rate`, default `2`). Each is a positive number; absent fields take the defaults, and a config without `hotspots` is written back without it. Unknown keys or a value that is not a positive number hard-fail like any invalid config, and `patch_config` rejects an unknown `hotspots` key (§8.2).
- **Fan-out settings (optional).** `fan_out: { warn_at? }` sets how many other unshipped changes a pre-ship node's `depends_on` may reach before the check warns `fan-out:` (§5.15). `warn_at` is a positive integer (default `3`); an absent field takes the default, and a config without `fan_out` is written back without it. Unknown keys or a value that is not a positive integer hard-fail like any invalid config, and `patch_config` rejects an unknown `fan_out` key (§8.2).
- **Search settings (optional).** `search: { enabled?, model? }` tunes ranking (§8.1.1). `enabled: false` turns semantic ranking off (keyword ranking always runs); `model` names the transformers.js embedding model (default `Xenova/bge-small-en-v1.5`, English). Absent fields take the defaults; unknown keys, a non-boolean `enabled`, or an empty `model` hard-fail like any invalid config, and `patch_config` rejects an unknown `search` key (§8.2).
- **Coverage.** Every file in the universe (`sources` minus `exclude`, git-visible including untracked) MUST be claimed live or in an open revision of a non-retired node. An unclaimed file is `Blocked: Coverage: …` naming the probable owner (the node whose claim shares the longest directory prefix with the file; a file two or more folders deep needs at least two shared folders, so sharing only `src/` names no owner) and the exact fix: `set_implementation_files({ node_id, add: [file] })` on that node (with `change` naming its open revision when it has one), preceded by `open_next({ node_id, change })` when the owner is shipped with no open revision and either does not dominate the file's folder (§1.2) or the file is a migration or schema file; otherwise, in a dominated folder, the claim alone is the fix. A retired node's claim does not cover a file; such a file is reported once, by the leftovers rule, not again as Coverage.

#### 1.2.2 Ownership split (Interaction owns the body; Interface mounts)

**Interaction owns the behavior surface. Interface only mounts or wires it.**

- **Interaction** owns domain logic, view-model, and the exportable surface. It MUST NOT own app routing, device/staff shell chrome, or cross-Interaction navigation. It MUST NOT import Interface-owned files (import matrix).
- **Interface** owns routes/entry, providers, guards, thin mounts/wiring, shared shell chrome, and nav callbacks. It MUST NOT reimplement behavior that belongs in an `exposes` target.
- **One Interface per actor surface**, not one Interface per screen/tab.
- **Assembler** Foundations may import Interfaces/Interactions that `depends_on` them (composition root). Reachable Foundation closure for imports stops at assemblers.
- **Composition root (`mounts`).** A Foundation may import exactly the Interfaces it `mounts` (§2.2). Use it for a module whose job is to import several Interfaces: a template registry, a route dispatcher, a redirect list. Without the edge the same import is an illegal Foundation → Interface import. `mounts` permits those imports and nothing else: it adds no `depends_on`, does not make the Interface depend on the Foundation, and does not gate ship.

  *Multi-template example.* A platform ships two site templates, each its own Interface (`if-template-a`, `if-template-b`, each `exposes` the shared Interactions and `depends_on` the Foundations it uses). One module, `src/foundations/f-registry/registry.ts`, imports both Interfaces to build the route dispatcher. Claim it on a Foundation `f-registry` and link `f-registry -mounts-> if-template-a` and `f-registry -mounts-> if-template-b`. `set_implementation_files` on the registry returns the two `link_nodes` calls when the edges are missing; with both edges `check` passes; with only one, the other import stays Blocked.
- **Test files.** A test exercises its node where it is wired in. A file that node A's `tests` list covers (§6.1) **and** that looks like a test (a `*.test.*` or `*.spec.*` file name, or a `__tests__`, `test`, or `tests` path segment) MAY import files owned by A and by A's **direct dependents** — nodes with a `depends_on`, `exposes`, or `mounts` edge to A, in the view being judged (live, or live plus a change's revisions) — with no edge of its own. Any other import from it follows the matrix as usual. The check and the `in-review` / `ship` gates apply the same rule.

**Build order (per exposed Interaction):** Interaction `in-progress` → implement + declare files → only then Interface thin mount/wire.

Default Atomic Ops templates (§6.3) and the playbook encode this split.

#### 1.2.3 Shared app routes (Assembler vs template Interface)

A product with several templates (site themes, white-label shells) often has routes that exist for every template, for example `app/sites/[site]/[lang]/blog/*`. One route family has one owner:

- **The Assembler owns routes that dispatch to whichever template is active.** A template-agnostic route reads the active template and renders its Interface (through `mounts`, §1.2.2); it is composition, so it belongs to the Assembler Foundation.
- **A template's Interface owns only routes that exist for that template alone.**

A **router root** is an `app/` folder (at any depth) that holds a root `layout` file, directly or in a route group (`app/(site)/layout.tsx`); an `app/` folder without one is not a router. A **route family** is a route folder below a router root, cut after its last static segment: the route files (`page`, `route`, `layout`, `template`, `loading`, `error`, `not-found`, `default`) of `app/sites/[site]/[lang]/blog/page.tsx` and `app/sites/[site]/[lang]/blog/[slug]/page.tsx` are one family, `app/sites/[site]/[lang]/blog/`. Dynamic (`[x]`), group (`(x)`), and slot (`@x`) segments do not start a new family. The check warns (§9.6) when one family's route files have more than one owner; the warning names each owner and the rule. It is a warning, not a `Blocked:`.

### 1.3 Screaming architecture

A glance at the territory MUST scream what the product *is*, not which frameworks or delivery mechanisms it uses:

| Layer | Screams |
|---|---|
| **Capabilities** | What the product does |
| **Interactions** | Behaviors the system performs (initiated by any actor) |
| **Interfaces** | How actors enter those behaviors |
| **Foundations** | Shared substrate at the edges |
| **Assembler** | Foundation role that composes Capabilities + Interactions + Interfaces + Foundations into a deployable surface |

Tech layers (`Frontend`, `API`, `Database`) MUST NOT be Capabilities. Delivery mechanisms (pages, CLIs, MCP tools, webhooks, crons) are **Interfaces**, not Interactions.

### 1.4 Roadmap (not implemented)

Further refinements (e.g. symbol-level mapping inside a file) are out of scope. File ownership via `implements` is the v0.2 authority for architecture queries and check.

---

## 2. Entity Taxonomy

The framework separates **build taxonomy** (Capability, Interaction, Interface, Foundation) from a **defect layer** (Bug) to eliminate scope creep and prevent spaghetti dependencies.

MindPlan tracks **architecture and delivery together**. The build taxonomy is Interaction-first (screaming architecture): Capabilities name what the product does; Interactions name self-contained behaviors; Interfaces name entry surfaces; Foundations hold shared substrate so behaviors stay independent of each other.

### 2.0.0 Type glossary (non-normative)

The type names are the vocabulary: Capability, Interaction, Interface, Foundation, and Bug, in tool calls, in prose, and with the user. README, playbook, map legend, and skills MUST use them and no synonym for a type (no "area", "action", "entry point", or "building block").

| Type | Question | Example |
|------|----------|---------|
| **Capability** | What does the product do? | Billing |
| **Interaction** | What can someone do? | Split the check |
| **Interface** | Where do they do it? | Waiter POS, CLI, MCP tools |
| **Foundation** | What does it all run on? | Database, design system, Stripe |
| **Bug** | What's broken? | Double charge on split |

**Links:** `belongs_to` = is part of; `exposes` = shows; `depends_on` = needs; `leads_to` = then goes to; `affects` = breaks.

**States:** draft = idea; ready = ready to build; in-progress = building; in-review = awaiting ship; stable = live; unstable = live with problems.

**Rules:** Infrastructure First = ship the Foundations before the Interaction that needs them; Behavior First = an Interaction has to work before an Interface shows it; Completion Check = finish the checklist before going live; No Ghosts = every Interaction belongs to a Capability and depends on a Foundation.

#### Established equivalents (non-normative)

Each type and edge is close to a term from established software architecture. The table names that term so a reader can map the type onto what they already know, then says where MindPlan differs. It is an anchor, not a list of synonyms: tool calls, prose, and conversation still use the type names only.

| Type | Closest established term | Where MindPlan differs |
|---|---|---|
| **Capability** | Business capability (business architecture); bounded context or subdomain (Domain-Driven Design) | Groups Interactions only. Holds no code, has no outgoing edges, and its state is computed from its Interactions (§4). An Interaction may belong to several. |
| **Interaction** | Use case (UML; the use case interactor of Clean Architecture); a feature | One actor goal, shippable on its own. It owns its body, including the screen for a UI behavior, and never depends on another Interaction. |
| **Interface** | Primary (driving) adapter (hexagonal architecture); a C4 container for an app, API, CLI, or channel | One per actor and delivery mechanism, not per page or command. It mounts Interactions and owns no domain logic or screen bodies. |
| **Foundation** | By role: composition root (Assembler); infrastructure or shared kernel (Infra); UI component library (Design system); secondary (driven) adapter or anti-corruption layer (Adapter) | Shared substrate with no standalone behavior. It must be `stable` before an Interaction that needs it ships (Infrastructure First). |
| **Bug** | Defect, as in an issue tracker | The one type that records work rather than structure. It reaches the graph through `affects` and inherits the rules of the nodes it affects. |

| Edge | Closest established term | Where MindPlan differs |
|---|---|---|
| `belongs_to` | Membership of a use case in a capability or bounded context | Only Interaction → Capability. |
| `depends_on` | A dependency on a port or infrastructure module; a C4 "uses" relationship | Targets Foundations only, stays acyclic, and gates ship. |
| `exposes` | A driving adapter invoking a use case | Only Interface → Interaction; the Interface ships after what it exposes (Behavior First). |
| `mounts` | Composition-root wiring (dependency injection) | Only Foundation → Interface; it licenses imports and gates nothing. |
| `leads_to` | A step in a user flow or a navigation transition | Only Interaction → Interaction; cycles are allowed and it gates nothing. |
| `affects` | A defect linked to the component it breaks | Only Bug → Interaction, Interface, or Foundation. |

| Entity | Definition | Routing rules |
|---|---|---|
| **Capability** | A named **business capability**: what the product does, as a permanent architectural boundary for related behaviors (e.g. "Table Ordering", "Billing", "Agency Site Generator"). The set of Capability titles is the product's scream. Capabilities are continuous containers, not closable epics, sprints, or technical layers. | Permanent container. MUST NOT execute code directly. MUST NOT have outgoing edges. State is computed, never set manually (§4). MUST be named in domain language. |
| **Interaction** | A **self-contained behavior** initiated by any actor — user, system, scheduler, external service, CLI, or MCP client. Examples: "Split the check", "Orient on the plan", "Check integrity", "Process payment webhook payload". An Interaction is **not** a page, route, CLI, MCP toolset, or other **entry surface** — those are Interfaces. When the behavior has a UI, the Interaction package owns the **screen body** (domain + mountable view). When the behavior is CLI/MCP/Webhook/Cron, the Interaction package owns the handler/module the Interface wires. | MUST belong to one or more Capabilities via `belongs_to`. MUST `depends_on` at least one Foundation. MUST NOT `depends_on` another Interaction (§5.9 Interaction Independence). MAY `leads_to` other Interactions (navigation only; not a ship gate). MUST NOT import Interface packages. **Agents MUST define the Capability before creating an Interaction** — if the user requests an Interaction that cannot be mapped to an existing Capability, the agent MUST refuse and ask the user to define the Capability first. Size test (guidance): one actor goal; nameable as verb + object without "and"; shippable on its own. |
| **Interface** | **How an actor enters or accesses** one or more Interactions — one Interface per **actor + delivery mechanism** (e.g. Waiter POS, console web app, MCP tools, CLI), not one Interface per page, tab, command, or tool. Pages, tabs, commands, and tools inside that surface are routes the Interface mounts. Grain test (guidance): "Would a user call this a different app or channel?" If no, it is the same Interface. Examples of Kind: Page, CLI, MCP, Webhook, Cron, Script. Interfaces have the **full build pipeline** and declare owned files via `implements`. They **mount or wire** Interaction packages; they MUST NOT own core domain logic or screen bodies. | MUST `exposes` at least one Interaction before leaving `draft` (§5.3). MAY `depends_on` Foundations (e.g. Assembler, Adapter). MUST NOT `belongs_to` a Capability (membership is on Interactions). Ship is gated by **Behavior First** (§5.4): every exposed Interaction MUST be `stable`. Spec boilerplate: App Router (or CLI/MCP) mounts Interaction packages; Interface does not own core domain logic or screen bodies. |
| **Foundation** | **Shared substrate** with no standalone behavior: infrastructure *and* reusable product platform, organized by **role** (assembler, infra, design system, adapter — see §2.0.1). Examples: Next.js app shell, database schemas, auth, Stripe SDK, design tokens. Behaviors consume Foundations via `depends_on` without becoming them. Shared state between Interactions MUST live in Foundations. | Exists solely to be consumed by Interactions, Interfaces, or other Foundations. MUST be shipped (`stable`) before dependent Interactions can ship (Infrastructure First). MAY depend on other Foundations. MUST NOT own stakeholder-recognizable product behavior — that belongs in Interactions. Foundations are not Capability members. |
| **Bug** | A defect afflicting one or more Interactions, Interfaces, or Foundations. | MUST link to targets via `affects` (Bug → Interaction\|Interface\|Foundation). Dedicated defect lifecycle (§3.2). Does not affect Capability computation. |

### 2.0 Classification litmus (agents)

Agents MUST classify new work with these checks, in order:

1. Something the product *does*, named in domain language ("Billing", "Table ordering")? → **Capability**
2. Self-contained behavior initiated by an actor (user/system/scheduler/CLI/MCP/…)? → **Interaction**
3. How an actor *enters* an Interaction (page, CLI, MCP tool, webhook, cron, …)? → **Interface**
4. Shared code/UI with **no** standalone behavior, only consumed by Interactions/Interfaces? → **Foundation** (then pick a **role** per §2.0.1)
5. Broken behaviour on an existing node? → **Bug**

**Litmus examples:**

- Primary button / design tokens → Foundation, Design system role. Not an Interaction.
- Next.js / Vercel Cron / Supabase Functions app shell → Foundation, Assembler role. Not a Capability named "Frontend".
- Stripe / Resend / Slack SDK wrappers → Foundation, Adapter role. Checkout/billing behaviour stays in Interactions.
- "Split the check" behaviour → Interaction (`i-checkout-split`) owns domain + mountable view. A phone page that hosts it → Interface (`if-checkout-page`) that `exposes` the Interaction and **only mounts** that view.
- MCP tools that orient / mutate the plan → Interactions own the handlers and the tool definitions (one Interaction per behavior: orient, assess impact, read the brief, browse the graph, change status, shape the graph, edit territory, revise a node, claim files, record decisions, edit the brief); one Interface (`if-mcp-tools`) mounts them.
- User-picker *behaviour* (search/select flow) → Interaction (view lives in the Interaction package); expose it from the same ordering/POS Interface rather than minting one Interface per screen. A dumb combobox with no product behaviour MAY live under the design-system Foundation instead.
- Waiter POS with floor / checkout / pickup tabs → **one** Interface exposing many Interactions. Not one Interface per tab.
- Console web app with status / graph / territory / model / mutate pages → **one** Interface (actor + web channel) exposing many Interactions. Not one Interface per console page. Same Interaction reached from MCP and from the console → reuse the Interaction; add `exposes` (and mount/wire), do not mint a second Interaction.

**Two axes** (keep distinct):

1. **Membership** — `belongs_to`: an Interaction is part of one or more Capabilities.
2. **Entry** — `exposes`: an Interface surfaces one or more Interactions to an actor.
3. **Shared substrate** — `depends_on`: Interactions and Interfaces stand on Foundations; Foundations may layer on Foundations. **Never** Interaction → Interaction.
4. **Navigation** — `leads_to`: optional Interaction → Interaction flow hints for agents and humans; cycles allowed; **not** a compiler ship gate.

### 2.0.1 Foundation roles (documentation convention)

Foundations remain a single NodeType. Agents SHOULD classify each Foundation into one **role**. Roles are **not** NodeTypes, edge types, frontmatter fields, or compiler enums — they sort substrate without polluting Capabilities with tech layers.

| Role | Owns | Examples | Does not own |
|------|------|----------|--------------|
| **Assembler** | External framework/runtime that **composes** Capabilities, Interactions, Interfaces, and Foundations into a deployable surface | `f-nextjs`, `f-vercel-cron`, `f-supabase-functions` | Product behaviors (Interactions), entry wiring beyond mount conventions (Interfaces) |
| **Infra** | Persistence, messaging, storage, compute plumbing, observability — including **shared state** Interactions must not own pairwise | `f-db`, `f-queue`, `f-blob-store`, `f-otel` | Product features that happen to use a DB |
| **Design system** | Tokens, typography, theme, layout primitives, and dumb presentational UI | `f-design-system` (tokens + Button, Input, Stack) | Capability-specific screen bodies (Interaction packages) and page/CLI/MCP entry (Interfaces) |
| **Adapter** | Third-party / boundary SDKs and protocol wrappers | `f-stripe`, `f-resend`, `f-slack-api` | Checkout/billing Interactions on top |

**Role discoverability:** agents SHOULD write the role as the leading tag of the Foundation's `description` — e.g. `"Assembler — Next.js app shell composing interactions and interfaces"`. This is the only place the role lives; it surfaces in `find_related_nodes`, `export_mindplan_view` labels, and graph dumps without a schema change. Missing role tags are not compiler violations (SHOULD, never MUST).

**Auth / identity:** model as **Infra** (e.g. `f-auth`) unless it is clearly a vendor adapter (`f-clerk` → Adapter). Do not invent a fifth role for it by default.

**Design system vs UI components:** keep as **one role**. If a project later needs two packages, both stay Design system role (`f-tokens` + `f-ui-kit`).

**Assembler specifics:**

- Different Capabilities MAY use different assemblers (UI → Next.js; jobs → Vercel Cron / Supabase Functions).
- A Capability's assembler(s) are **derived** from member Interactions' (and their Interfaces') `depends_on` Foundations that play the Assembler role — Capabilities still MUST NOT have outgoing edges.
- Interactions and Interfaces that run on a given backbone SHOULD `depends_on` that Assembler Foundation; this is guidance, not a compiler gate (Ghost Interactions still only require any Foundation `depends_on`).
- Assembler territory documents entrypoints, mount conventions, and env/deploy constraints — not product behaviour. Claim those files with `implements` like any other Foundation.

**Role litmus** (after classifying as Foundation):

1. External app/runtime that **assembles** Interactions + Interfaces into a deployable surface? → **Assembler**
2. Vendor/protocol boundary only? → **Adapter**
3. Visual language / dumb UI primitives? → **Design system**
4. Otherwise shared platform plumbing (including shared state)? → **Infra**

**Role fallback:** Assembler applies **only** to runtimes that compose and run nodes (app framework, cron host, function host). Docs, CI config, frameworks-of-prose, and other misfits that are not a deployable runtime are **Infra**. Agents MUST NOT invent hybrid tags such as `"Assembler/docs"` or `"Assembler/shell"` — pick exactly one of the four roles; when unsure between Assembler and Infra, choose Infra unless the Foundation is clearly the external runtime that mounts Interactions and Interfaces.

### 2.1 Node identifiers

Node ids MUST match the pattern `^[a-z0-9][a-z0-9-_]*$` (lowercase slug style). Ids are globally unique across all types. Recommended convention: prefix by type (`c-`, `f-`, `i-`, `if-`, `bug-`), e.g. `c-ordering`, `f-db-core`, `i-checkout-split`, `if-mcp-tools`, `bug-race`.

**Naming (guidance):** the `title` is the stable name of the thing — a verb phrase for Interactions (e.g. "Split the check"), a noun or short noun phrase for Capabilities, Interfaces, Foundations, and Bugs. The `description` says what the node is or does **now**. Revision notes, changelog fragments, and parenthetical "what changed this PR" asides belong in the revision body (or Atomic Ops), never in `title` or `description`.

### 2.2 Edge taxonomy

Exactly six edge types exist. An edge is a directed triple `(source, target, type)`. There is no version-lineage edge type: a Foundation, Interaction, or Interface evolves in place under its **stable id** through revisions (§3.6), so there is nothing for a graph edge to link.

| Edge type | Legal shape | Meaning |
|---|---|---|
| `belongs_to` | Interaction → Capability | Membership. An Interaction MAY have multiple `belongs_to` edges when the behaviour spans domain capabilities. |
| `depends_on` | Interaction → Foundation, Interface → Foundation, Foundation → Foundation | Composition / shared substrate. The source cannot ship without the target's Foundations being `stable` (Infrastructure First for Interactions; Behavior First also requires Foundation deps for Interfaces). **NEVER** Interaction → Interaction. |
| `exposes` | Interface → Interaction | Entry. The Interface is how an actor reaches the Interaction. |
| `mounts` | Foundation → Interface | Composition root. The Foundation may import the Interface's files (a registry or dispatcher importing several Interfaces, §1.2.2). Not a ship gate; adds no dependency. |
| `leads_to` | Interaction → Interaction | Navigation / flow hint only. Cycles **allowed**. Not a ship gate; not implementation dependency. |
| `affects` | Bug → Interaction, Bug → Interface, Bug → Foundation | Affliction. Open Bugs drive `unstable` production posture (§3.5). |

All other shapes MUST be rejected, specifically including:

- Capability → anything (Capabilities are containers; they have no outgoing edges)
- Interaction → Interaction via `depends_on` (Interaction Independence — §5.9)
- `depends_on` targeting a Capability, Interaction, Interface, or Bug (except Foundation → Foundation and Interaction/Interface → Foundation)
- `belongs_to` from a Foundation, Interface, Capability, or Bug
- `exposes` from anything other than an Interface, or targeting a non-Interaction
- `leads_to` from/to anything other than Interaction → Interaction
- `mounts` from anything other than a Foundation, or targeting anything other than an Interface
- `affects` from anything other than a Bug, or targeting a Capability
- `depends_on` from a Bug or Capability
- self-links (`source == target`) for any edge type except where explicitly allowed — self-links MUST be rejected for all types
- duplicate edges (same source, target, and type)

The `depends_on` subgraph MUST remain acyclic. Implementations MUST reject `depends_on` cycles at link time (Foundation→Foundation only, given Interaction Independence). The `leads_to` subgraph MAY contain cycles; cycle detection MUST NOT apply to `leads_to`.

While a Foundation, Interaction, or Interface has an open revision, edge writes from that node (`belongs_to` / `depends_on` / `exposes` / `leads_to` / `mounts` as applicable) MUST target that revision's add/remove deltas (the revision of `change`, or the only open one) rather than the live `<id>.mdx` edge arrays (§6.1.3, §6.2, §8.2 `link_nodes`) — the live node keeps serving its existing edges until the revision ships.

There is **no Dependency Closure** rule and **no** `link_dependent` flag. Linking an Interaction into a Capability does not auto-link other Interactions; Navigation (`leads_to`) and membership are independent decisions.

---

## 3. State Machines

### 3.1 Build pipeline (Foundation / Interaction / Interface)

Foundations, Interactions, and Interfaces move through a manual build pipeline, then enter production via `ship`:

| # | State | Meaning |
|---|---|---|
| 1 | `draft` | Ideation; scope written in `<id>.mdx` (or in a revision file while a shipped node evolves, §3.6) |
| 2 | `ready` | Pre-flight passed (Interaction: Capability + Foundation linked; Interface: at least one `exposes`) |
| 3 | `in-progress` | Active execution; Atomic Ops checked off |
| 4 | `in-review` | Neutral pipeline checkpoint: build finished; eligible for `ship` when Rules 1–6 and Completion Check allow. MindPlan does **not** require human review, an agent Reviewer, PR approval, or CI |
| 5 | `stable` / `unstable` | Computed production posture; entered via `ship`, never set manually (§3.5) |
| 6 | `cancelled` | Pre-ship abandon (from `draft`/`ready`/`in-progress`/`in-review` only); terminal |
| 7 | `deprecated` | Retired (from `stable`/`unstable` only) |

**Ship transition:** `update_node_status(..., "ship")` from `in-review` sets `shipped_at` and computes `stable` or `unstable` (§3.5). There is no manual `active` state. The implementing agent MAY `ship` (or Bug `resolved`) its own revision when default `mindplan-mcp check` is green and legal transitions / Rules 1–6 allow. Classify the revision per §3.7 (source, neighbor, unaffected) for `open_next` vs edit-in-place — not for a Reviewer gate. MindPlan does **not** require spawning an independent Reviewer, Approve/Reject protocol, or any code-quality judgment before `ship`. Code review and similar process gates are **outside the dialect**; projects MAY add them via host tooling or `mindplan/project.md` standing rules. The parent MAY self-`ready` (`draft` → `ready`) in one ordered `update_node_status` call. Status advances for a multi-node revision in one ordered `update_node_status` call (§3.7). `Blocked: Infrastructure First` (Rule 3, §5.4) or Behavior First defers production entry until deps are ready; that is a compiler gate, not a quality Reject.

**Readiness reset.** `ready` is a judgment about a contract. A contract write to a slot whose state is `ready` — `<id>.mdx` of a pre-ship node, or the open revision the write goes to — moves that slot back to `draft`, and the write's result says so: the new `state` / `next_state` plus `readiness_reset: { slot, from: "ready", to: "draft", note }`. Self-ready it again after reviewing the changed contract.

| Write | Resets a `ready` slot |
|---|---|
| `patch_node_territory`: `title`, `description`, `role`, `body`, `section`, `replace`, `toggle_checkboxes` | Yes |
| `set_implementation_files` | Yes, when the claim list changes (re-sending the same list does not reset) |
| `link_nodes` / `unlink_nodes` (the source node's written slot) | Yes |
| `patch_node_territory` with only `change` / `change_ref`; `change` on `set_implementation_files` or `record_decision` | No — grouping metadata, not contract |
| `patch_node_rules` | No — rules are standing constraints, not the contract |
| `put_attachment` / `remove_attachment` | No |
| Any write to a slot in `draft`, `in-progress`, or `in-review` | No — ticking finished work and matching the territory to the code is how a revision completes |

**Cancel transition:** `update_node_status(..., "cancelled")` abandons a Foundation, Interaction, or Interface that never shipped (a pre-ship node holds no revision folder, §3.6). It is blocked while any **active** (non-`cancelled`/`deprecated`/`resolved`/`wontfix`) node still `depends_on` this node (or, for Interactions, while an active Interface still `exposes` it — implementations SHOULD reject cancel when active dependents of either edge kind exist). Packages and territory folders are left on disk. There is no uncancel in v1 — cancelled is terminal like `deprecated`.

| From \ To | draft | ready | in-progress | in-review | stable/unstable | cancelled | deprecated |
|---|---|---|---|---|---|---|---|
| **draft** | — | ✔ | ✘ | ✘ | ✘ | ✔ | ✘ |
| **ready** | ✔ | — | ✔ | ✘ | ✘ | ✔ | ✘ |
| **in-progress** | ✘ | ✔ | — | ✔ | ✘ | ✔ | ✘ |
| **in-review** | ✘ | ✘ | ✔ | — | ✔ | ✔ | ✘ |
| **stable/unstable** | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✔ |
| **cancelled** | ✘ | ✘ | ✘ | ✘ | ✘ | — | ✘ |
| **deprecated** | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | — |

**Exception — `force_unship` (Rule 11):** a dedicated recovery tool may clear `shipped_at` and move a `stable`/`unstable` Foundation/Interaction/Interface to `draft`/`ready`/`in-progress`/`in-review` only when the caller passes `confirm: "unship:<node_id>"` after explicit human confirmation. This is not a normal transition and MUST NOT be used as a substitute for `open_next` evolution.

### 3.2 Bug lifecycle

| State | Meaning |
|---|---|
| `open` | Reported; repro in `<id>.mdx` |
| `triaged` | Validated; linked via `affects`; severity optional |
| `fixing` | Fix in progress |
| `in-review` | Fix awaiting resolve (neutral checkpoint; no required PR/Reviewer) |
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

An Atomic Operation is a PR-sized unit of work expressed as a Markdown task-list item in `<id>.mdx` (or in a revision file of a shipped Foundation/Interaction/Interface, §3.6):

```markdown
- [ ] Implement POST /orders endpoint
- [x] Write migration for orders table
```

Recognized syntax: a list item beginning with `-`, `*`, or `+`, followed by `[ ]` (open) or `[x]` (complete). Checkbox state is parsed from the relevant file (`<id>.mdx`, or the revision file of the change being judged) at validation time — the file on disk is the source of truth for completion, not the graph.

**Item ids and kinds.** Every checkbox the Completion Check counts (§5.6: the whole body, except the sections other writers own, such as `## Rules` and `## Decisions`, and lines inside a fenced code block, which are example text) is a checklist item, and MAY end with a tag, before any annotation: `{#<id>}` or `{#<id> <kind>}`. The id is a lowercase slug (`a-z`, `0-9`, hyphens), unique in the slot and stable when the wording changes. The kind says who closes the item: `build` (the default: every item not tagged `review` or `deploy`, closed by the agent building the node), `review` (a person reviewing it), or `deploy` (a person deploying it). The default items `create_node` and `open_next` write for a Foundation, Interaction, or Interface carry the ids `spec`, `impl`, and `verify`; an item added with a `review` or `deploy` kind and no id gets one slugged from its text:

```markdown
- [ ] Spec written {#spec}
- [ ] Implementation complete {#impl}
- [ ] Verified in target environment {#verify}
- [ ] Legal signs off the copy {#legal-copy review}
```

`toggle_checkboxes` (§8.1 `patch_node_territory`) ticks any such item by `id` or by its **exact** text (tag and annotation excluded, whitespace trimmed); a text that is not exactly one item's, a substring included, is `Blocked:` and lists the items, and a text several items share is `Blocked:` unless the toggle passes `all: true`. `add_checklist_items` appends unticked items with their tag to the slot's first checklist section. A `review` or `deploy` item waits on people: `run_check` lists the open ones in one `Info: waiting on people: …` line and `orient_for_work` in `open_items` (§8.1), so the agent says it waits instead of ticking it. Kinds change which dependencies hold a ship (§5.4, §5.5), not the Completion Check (§5.6).

**Closing an item honestly.** An item that was done differently, or does not apply, is closed with an annotation instead of being reworded:

```markdown
- [x] Load test checkout — note: verified manually against staging
- [x] Migrate legacy orders — n/a: no legacy orders exist in this market
```

`toggle_checkboxes` writes these (`note`, `not_applicable`, §8.1) after the item's text and tag. Both count as complete. A `— n/a:` with no reason counts as open. Unticking removes the annotation; the item's own words never change.

JSX in the file is invisible to this check (§6.4.4): only Markdown task-list syntax gates completion.

### 3.4 Bug initial state

Bugs are created in state `open`. All other node types start in `draft`.

### 3.5 Computed production states (`stable` / `unstable`)

After `ship`, a Foundation, Interaction, or Interface's `state` field holds a **computed** production posture:

| State | Condition |
|---|---|
| `stable` | `shipped_at` is set and zero **open** Bugs `affects` this node |
| `unstable` | `shipped_at` is set and at least one open Bug `affects` this node |

**Open bug** = Bug in `open`, `triaged`, `fixing`, or `in-review`.

Recomputed after: Bug status changes, `affects` link/unlink, and `ship`. Never set manually.

### 3.6 Versioning

MindPlan uses a **stable-id evolution model**: a Foundation, Interaction, or Interface's `id` never changes across its lifetime, and there is no successor node, no `supersedes` edge, and no dependent relinking. A node's history — including every past evolution — lives in the git history of its `<id>.mdx`, which **is** the version lineage; there is nothing else to consult.

Shipped Foundations, Interactions, and Interfaces (`stable`/`unstable`) are never reset to `draft` in place, and they are never replaced by a new node.

**Terms.** A **revision** is one open, unshipped change to a shipped Foundation, Interaction, or Interface, belonging to exactly one change id (§3.7) and stored at `<node folder>/revisions/<change>/<id>.mdx` with `attachments/` and `decisions/` beside it. A node MAY hold several open revisions at once, at most one per change id. **Live** is the node's `<id>.mdx`. A revision's edges, claims, and linked tests are **deltas** (adds and removes) against live, and its title, description, role, and body are its own text; the **effective node under change C** is live ⊕ C's revision: live with C's deltas applied and C's text in place of live's. A node with no revision of C is, under C, its live self. "The revision" in a call means the revision of the `change` the call names, or the node's only open revision when `change` is omitted; several open revisions and no `change` is `Blocked:` listing them. A pre-ship node has no revision folder: its `<id>.mdx` is its revision, and its `change` field (§3.7) names the change. Capabilities and Bugs never hold revisions.

A shipped node is one file, `<id>.mdx`, plus one folder per open revision. `open_next` creates a revision folder; ship, `discard_next`, and `deprecated` delete it. Every live MCP write touches `<id>.mdx` alone.

**Leftover twins.** Releases before 0.8.0 kept a standing `<id>.next.mdx` twin with `state: mirror` beside every shipped node. Such a file is **not** an open revision: the default check warns about it (`legacy:`, §9.6), `open_next` removes it, and `upgrade_project` deletes it. **Legacy next files.** Releases before 0.18.0 kept one open evolution per node in `<id>.next.mdx` with `next-attachments/`. Migration level 4 (§1.1.2) moves each into `revisions/<change>/`; until then the graph needs an upgrade, so every gated tool is `Blocked: Version` naming `upgrade_project`. A pull request shows a node's change once, as the diff of `<id>.mdx`, because the merge gate (§9.6) ships every change before it merges.

To evolve a shipped node, call `open_next({ node_id, change })`, which:

1. verifies the node is `stable` or `unstable`, and has no open revision of `change` (§5.11),
2. writes `revisions/<change>/<id>.mdx` from the live file in state `draft` (optional `title` / `description` overrides, `change_ref`), with empty deltas, `base` hashes of live, a fresh Atomic Ops list (§5.6), and the change's planned edges as add deltas (§3.7),
3. from that point the revision's text and deltas change independently of live and of the node's other revisions. New assets go in the revision's `attachments/`.

The **live `<id>.mdx` keeps serving** (`stable`/`unstable`, same id, same edges) while any revision is open. Dependents' edges continue to resolve to the same id throughout — there is nothing to relink, because the id never moves.

**Gates judge live plus one change.** Every gate on a revision of change C — Ghost Interaction / Ghost Interface, Infrastructure First, Behavior First, the Completion Check, the import and ownership check gate, Minimum Territory Shape, and the decision gate (§5) — judges the graph **under C**: every node with a revision of C replaced by live ⊕ that revision, every other node live. Other changes' open revisions are invisible to it. The revision's own state (`draft → ready → in-progress → in-review`) moves along §3.1; `update_node_status` takes `change` to name it.

**Ship.** When the revision of C is `in-review` and the caller calls `update_node_status({ node_id, change, new_status: "ship" })`, the gates above run under C. When live changed in place since C's `base` (a live patch while C was open), C is first rebased onto current live (below); a section or scalar both edited is stored on C as a conflict and the ship is `Blocked:` naming `resolve_conflict`. Everything else that can Block (each sibling revision file parses, no decision file name clash) is checked and every sibling's rebase computed before the first write; a write that fails puts every file back. Then the server:

1. writes live ⊕ C onto `<id>.mdx` (same `id` and `type`; C's title, description, role (none when C removes it: `role_removed: true`), body, and live with C's edge, claim, and test deltas applied; fresh `updated_at` / `shipped_at`), adds one to `revisions`, updates `churn` and the split record (§5.15; only the marked parts whose linking edge is in place, as the dry-run walk counts them), computes `stable`/`unstable` from open Bugs (§3.5), and drops the Atomic Ops (§5.6);
2. moves C's decision files from `revisions/C/decisions/` to the node's `decisions/` (a name already there is `Blocked:` before anything is written), copies C's attachments into `attachments/`, and deletes `revisions/C/`;
3. **rebases** every other open revision B of the node onto the new live (below), and lists each in the result as `rebased: [{ change, conflicts, readiness_reset? }]`; a `ready` or `in-review` sibling whose text the rebase changed goes back to `draft` (`readiness_reset: { from, to: "draft" }`).

**Rebase.** Each revision records in `base` the hash of each live scalar (`title`, `description`, `role`) and each level-2 body section (and the text above the first one) it last started from: the first 8 hex characters of SHA-1 over the text with CRLF normalized to LF and trailing whitespace dropped; `## Rules` and `## Decisions` are never hashed. When a sibling ships, B is carried onto the new live per section and per scalar: untouched by B (its hash equals `base`) → takes the new live text; touched only by B (live's still equals `base`) → B's text is kept; both changed to the same text → kept; otherwise B keeps its text and records a **conflict** (`section:<heading>` or `scalar:<field>`); a revision that removes the role counts as changing `role` to none, so live changing the role under it is a `scalar:role` conflict; a conflict B already holds is dropped once new live reads B's text. A section new live added is inserted before B's `## Rules` / `## Decisions` (text above the first heading at the top); one new live deleted that B did not touch is dropped. B's deltas are trimmed: an add already in live and a remove no longer in live drop silently; a claim add that another node now claims live, and that node's revision of B's change does not drop, becomes a claim conflict (`claim:<path>@<owner>`). Every `base` hash then moves to the new live. A revision holding a conflict is `Blocked:` at `in-review` and `ship` naming `resolve_conflict` for each; `resolve_conflict` takes the revision's side, live's side (a claim conflict: drop the add; a role conflict while live has no role: the revision removes the role), or new text, and moves that `base` entry to live.

The node's `id` and production posture continue uninterrupted — dependents never see a different id and never need relinking. To abandon a revision without shipping it, call `discard_next({ node_id, change })`: it deletes `revisions/<change>/` (the file, its attachments, and its decisions), leaving `<id>.mdx` and the node's other revisions untouched. `deprecated` deletes every open revision folder of the node; `force_unship` is `Blocked:` while any revision is open.

`get_blast_radius` on a node reports the **live** dependents and (for Interactions) live reachability, the same set whatever is open, since the id never changes; with `change` and `node_id` it judges that node's revision of the change on the graph under the change (§8.1).

#### Territory Completeness

`<id>.mdx` MUST describe the **complete** contract of what the node *is* in the repository now — purpose, living spec (PRD / Execution Logic / Shared Substrate Spec), and durable acceptance criteria that match shipped (or in-flight pre-ship) reality. It MUST NOT be reduced to a changelog, a “what changed last” narrative, or a stub that only points at a package path.

When `open_next` seeds a revision from `<id>.mdx`, a **source** (§3.7) MUST be edited into a **complete proposed successor** of that same contract: add, change, or remove sections in place until the body describes the desired post-ship state. Because `ship` writes the revision's body over live section by section, a delta-only or changelog-only revision body is illegal — it would leave `<id>.mdx` describing only the latest change instead of the repository’s full state for that node. (Only edges, claims, and tests are deltas.)

A **neighbor** (§3.7) has no revision: its owned files are edited in place and its contract stays as shipped. It carries no change id.

Atomic Operations in a revision file are scoped to that revision: `open_next` replaces the Atomic Ops section with a fresh list of unticked default items (§5.6), which the agent rewrites into this revision's PR-sized ops. On a source, spec sections (Purpose, PRD, Execution Logic, Shared Substrate Spec, Acceptance Criteria, and equivalents) MUST remain a full successor document, not an evolution-only diff.

Agents MUST verify Territory Completeness for sources before transitioning a revision to `in-review` (playbook check-at-handoff). Semantic completeness is the implementer’s responsibility before `ship`; MindPlan does not prescribe an independent Reviewer.

### 3.7 Multi-node revisions

A change that touches several nodes gives each source one revision of it (§3.6), all under one change id. There is no new node type. The same classification applies to every Foundation, Interaction, Interface, and Bug.

Nothing in the successor set may ship while a node the revision touches is broken. Independence, file ownership, and Interaction Independence are unchanged. The parent may self-`ready` and self-`ship` / self-`resolved` when default check is green and Rules 1–6 allow (§3.1).

#### Pull-in

A node is in a source’s blast radius when it:

- `depends_on` that source (transitive reverse `depends_on`, the `affected` set from `get_blast_radius`), or
- `exposes` that source, or
- `leads_to` that source (it navigates to the source).

`get_blast_radius` reports reverse `depends_on` and, for an Interaction, exposing Interfaces. Inbound `leads_to` is read from the graph. Outbound `leads_to` alone does not make a neighbor. Cancelled and deprecated nodes are not required to move, and `get_blast_radius` omits them by default (`include_retired: true` to see them; BFS still traverses through retired nodes so live dependents keep true hop distances).

#### Classes

| Class | When | Successor set |
|---|---|---|
| **Source** | The node’s own contract changed | Yes. `open_next`, full successor contract |
| **Neighbor** | Blast radius pulls the node in, its owned files changed, and its own behavior did not | No. Edit the owned files in place; no `open_next` |
| **Unaffected** | Blast radius pulls the node in, and its owned files did not change | No. Do not open a revision |

**Source.** The active body is the post-ship contract.

**Neighbor.** A neighbor’s contract does not change, so it has no successor and no impact note. A node whose `implements` must change is not a pure neighbor; `open_next` it like a source — except an additive claim in a folder it dominates (§1.2), which `set_implementation_files` writes in place. A neighbor takes no change id: `change` on it is `Blocked:` (Change ids, below). The `## Impact` heading is no longer scaffolded by any template, but when a territory body contains one, leaving `draft` (`ready`), entering `in-review`, and `ship` / `resolved` MUST still reject an empty or scaffold section:

```
Blocked: Minimum Territory Shape. "<id>"/<file> section "## Impact" is empty or a stub. Write what this node adapted so the already-shipped contract still holds.
```

**Unaffected.** List them on the revision. They are not members of `node_ids`.

**Examples.** A visual-system change is a Foundation source; pages whose files adapt are Interface neighbors, edited in place. An enquiry behavior change is an Interaction source; the Interface that mounts it is the neighbor. A Bug that crosses several nodes uses the same split on the nodes it `affects`: full successor where the contract changed, plain in-place edits everywhere else.

#### One status call

The implementer advances the successor set with one `update_node_status` call (§8.2 `revisions`). The server orders **Foundations, then Interactions, then Interfaces, then Bugs**, keeps caller order within a tier, and tries **every** item on the graph as the items before it left it: a blocked item stays where it is and the call goes on. The result lists `results: [{ node_id, change?, ok, line?, blocked? }]`, one per item; when some items moved and others were blocked it also carries `partial: true` and `blocked_count: <n>` at the top level. The call is `Blocked:` (and writes nothing) only when no item moved; that message lists every item's reason.

`Blocked: Infrastructure First`, or Behavior First because an exposed Interaction is not yet shippable, defers production entry until deps allow — that is a compiler gate, not a quality judgment. An item behind it stays put while the items that pass move.

**The change hint.** A `Blocked:` single or batch move of a node that belongs to a change (a pre-ship node's `change`, or the revision moved), to `ready`, `in-progress`, `in-review`, or `ship`, ends with one line naming the scoped call that moves the whole change: `To move the whole change: update_node_status({ scope: "change", change: "<change>", new_status: "<target>" })`, with `skip_review: true` when the target is `ship` and the node is not `in-review`.

**Scoped walks do not skip review.** `update_node_status` with `scope` walks each selected node through every stage (`ready → in-progress → in-review → ship`), running each transition's rules and the in-review check gate at that step. A walk to `ship` that would move a node whose active state is not yet `in-review` is `Blocked:` unless the call passes `skip_review: true`; with it the walk still stops at `in-review` for the gate and the result lists those nodes in `skipped_review`. The usual flow is two calls: walk to `in-review`, review, then walk to `ship`. `dry_run` lists every transition the walk will make, one `id: from -> to` line per step.

**Walking past blocked members.** A scoped walk is all-or-nothing: one `Blocked:` step writes nothing. With `skip_blocked: true` the walk validates each node's whole walk on its own, in walk order, on top of the nodes already validated; a node blocked at any step stays where it is (no partial steps), and so does every later node that cannot move without it, because the gates Block it in turn. The others walk to the target, and the result lists the left-behind nodes in `blocked` (`{ node_id, step, reason }`). A node that would skip review without `skip_review` is one of them. When no node can move, the call is `Blocked:` and writes nothing.

#### Change ids

One feature often touches several nodes. A **change id** (a slug, optional `change_ref` naming the branch or PR) ties their revisions together without a new node type:

- `create_node` and `open_next` take `change` / `change_ref` (`open_next` requires `change`). Before first ship, `patch_node_territory`, `set_implementation_files`, and `set_test_files` set or clear `change` (empty string clears) on `<id>.mdx`, and `patch_node_territory` also `change_ref`. On a shipped node, a revision's change id is its folder name and never changes: there `change` on those tools (and on every other tool that reads or writes a revision) only **picks** the revision of that change, and may be omitted when the node has one open revision.
- **No change id on a shipped node with no open revision.** Only a revision carries a change id. On a shipped, active node with no open revision, `change` or `change_ref` on `patch_node_territory`, `set_implementation_files`, or `set_test_files` is `Blocked: "<id>" is shipped with no open next: edit its files in place; it needs no change id (open_next if its contract changes).` and nothing is written; the same writes without `change` pass in place. A neighbor (below) is therefore not a member of the change that edits it, and nothing has to clear it when the change ends. The plain check covers it anyway: import and ownership rules run on every node's files, and a shipped node whose claimed files changed against the base gets every stale-text signal (§9.6). `record_decision`'s `change` tags the decision only and never writes a change id on the node. Title, description, and role on a shipped live slot are `Blocked:` too: those imply a revision. `open_next` writes `change` / `change_ref` to the revision file only.
- **Members** of a change are its **revisions** — shipped nodes holding an open revision of the change, and pre-ship, non-retired nodes carrying it, at any state including `draft` and `ready`. A shipped node's other open revisions are not members. A shipped node with edges planned under the change (§3.7) is a member too, with `kind: "planned"`: checked and listed, never walked.
- `update_node_status` with `scope: "change"` and `change` walks every revision of the change (same ordering, validation, and `skip_review` rule as the other scopes). With `nodes: [...]` it walks only those members, so a change ships its finished part while the rest keeps building: each listed id MUST be a member (else `Blocked:` naming the members), the others stay where they are, and the gates still refuse a listed node that needs an unlisted one (an Interface whose exposed Interaction is unlisted and not shippable is Blocked by Behavior First). `nodes` works with `dry_run`, `skip_review`, and `skip_blocked`, and is `Blocked:` with any other scope.
- `get_blast_radius` with `change` returns the merged radius and files of every member; `run_check` with `change` also runs the in-review gate's import, ownership, and stale-text rules on every revision (§8.1).
- A decision recorded under a change id (§6.1.2) counts for every revision of that change at the decision gate (§5.13), so one decision can clear a whole change; a decision whose `nodes` lists several nodes clears each listed node's revision.
- Shipping ends membership: the shipped revision's folder is deleted, and first ship clears the id from `<id>.mdx`. When a write leaves a change with no revisions that had at least one before it — its last revision ships, is discarded (`discard_next`), or is cancelled, or has its change id moved or cleared — the server drops that change's planned edges after the write, once per call (`cleared_planned`). A change with no members is `Blocked:` where a change is required.

#### Planned edges

A plan often needs wiring on shipped nodes long before it builds them: many features exposed by one shipped Interface, or depending on one shipped Foundation. Opening a revision on that node for each would lock it for the life of the plan. A **planned edge** records the wiring under a change instead, without `open_next`:

- `link_nodes({ source_id, target_id, edge_type, change })` on a shipped Foundation, Interaction, or Interface that has no open revision of `change` writes the entry `<change> <edge_type> <target>` to the live file's `planned:` list (server only, §6.1). Edge types: `belongs_to`, `depends_on`, `exposes`, `leads_to`, `mounts`. It is checked as a link would be (§5.10: shape, Interaction Independence, a `depends_on` cycle counting the change's other planned `depends_on`, a target that exists and is active, not already live) and `Blocked:` otherwise, or when the same entry is already planned. When the source has an open revision of that change, or is not shipped, `change` changes nothing and the edge is written as without it.
- A planned edge is **not** a graph edge: `graph.edges`, rules inheritance, Capability and stability computation, the import matrix, and the map ignore it until the change opens the node. `unlink_nodes({ source_id, target_id, change })` removes it.
- The source is a member of the change with `kind: "planned"`: `run_check({ change })` lists it, fails on each planned edge that is no longer legal (`Blocked: change "<id>": planned edge <source> -<type>-> <target>: …`), and prints one `Info: planned edges: "<source>" plans <type> <target>, … under this change …` line per source; `get_blast_radius({ change })` merges its radius and returns `planned_edges`; `orient_for_work({ change })` orients on it. The change walk never transitions it.
- `open_next({ node_id, change })` adds the change's planned edges to the new revision as add deltas and returns `applied_planned`. The live entries stay until that revision ships: the ship drops the shipped change's entries and keeps other changes', and `discard_next` leaves them planned. While the revision is open, its applied entries are not listed again.
- A change that closes (its last revision ships, is cancelled, or is discarded, §3.7) drops its remaining planned entries from every node and reports them as `cleared_planned`: wiring a change never opened is not carried into the next one.

Contract text for a shipped node still needs `open_next`. A node may hold one open revision per change, so planned wiring of one change never waits on another change's revision of the same node.

#### Attributed files

Some frameworks keep one folder for every migration, owned by the composition root, while each schema change belongs to a schema node's revision. **Attribution** connects them without moving ownership: `set_implementation_files({ node_id, attributed })` writes the revision's `attributed:` list (its revision file, picked by `change`, or `<id>.mdx` before first ship; §6.1) of exact files the revision adds in another node's claimed folder. Each entry must be one file (no glob, no trailing `/`) that another active node's claim covers and this node's own claims do not; a shipped node with no open revision is `Blocked:` with `open_next`. `attributed` may be passed alone, keeping the claims. The write resets a `ready` slot like a claim.

- The decision gate (§5.13) counts an attributed migration or schema file as new in the revision when the branch adds it, or always outside git.
- The blast radius lists attributed files in the revision's own `affected_files` group (`via: ["focus"]`); the folder's owner keeps them too.
- The check requires each attributed file on disk once the slot that holds it is in review (`Blocked: presence: "<id>" attributed file missing on disk: "<path>".`).
- Ship drops the list: a revision's ship does not carry it to live, and a first ship clears it from the live file.

#### Check before handoff

Before the agent stops owning the work, it MUST update the graph so it matches the implementation. Default `mindplan-mcp check` MUST exit 0 before self-`ready`, entering `in-review`, `ship` / Bug `resolved`, or claiming the session is done. Fix every `Blocked:` first. When the implementation is done and a merge is requested, the agent MUST `ship` the node (Bug: `resolved`). Default check covers graph load, file ownership (exclusivity, coverage, presence, leftovers), and the import matrix for the set (§9.6). It does not invoke a host typechecker; host typecheck is not a MindPlan gate. Agents run it with the `run_check` tool (§8.1), which returns the same output as the CLI. The server also runs the check's import-matrix and exclusivity rules on a node's files (under the revision's change, §3.6) at every move to `in-review` and `ship` (§5.14); a violation is a `Blocked:` that names the fix. A move to `in-review` of a decision-worthy revision also needs a recorded decision (§5.13). Stale-text warnings (§9.6) ride along and never block.

---

## 4. Computed Capability States

Capabilities are continuous and never technically "finished." Their states MUST NOT be set manually; the server derives them from the states of the Interactions linked to the Capability via `belongs_to`, and recomputes them after **every** mutation that can affect the result (status updates, linking, and unlinking).

For a given Capability, let:

- `S` = count of member Interactions with `shipped_at` set (state `stable` or `unstable`)
- `P` = count of member Interactions that are **actively building**, where an Interaction counts toward `P` if either:
  - it has no `shipped_at` and its `<id>.mdx` state is `in-progress` or `in-review`, **or**
  - it is shipped (`stable`/`unstable`) and has at least one open revision whose pipeline state is `in-progress` or `in-review` (§3.6)

| State | Condition | Reading |
|---|---|---|
| `evolving` | `S > 0` and `P > 0` | Live and actively being expanded — includes shipped Interactions with a revision mid-build. |
| `stable` | `S > 0` and `P = 0` | Live and untouched. |
| `incubation` | `S = 0` and `P > 0` | The V1 build phase. |
| `draft` | `S = 0` and `P = 0` | Resting state. |

Notes:

- **Bugs do not affect Capability states.** An Interaction flipping `stable` → `unstable` does not change its Capability.
- Interfaces do not contribute to Capability computation — only member Interactions do.
- `in-review` counts toward `P`, whether on `<id>.mdx` (unshipped Interaction) or on a revision of a shipped Interaction.
- A shipped Interaction with no open revision, or whose open revisions are all `draft`/`ready`, contributes to `S` but not `P`.
- Interactions in `draft`, `ready`, `cancelled`, or `deprecated` (and not evolving) contribute to neither count.
- Any attempt to set a Capability's state through the status-update tool MUST be rejected.
- When a recomputation changes a Capability's state, the server MUST persist the new state to the Capability's `<id>.mdx` frontmatter, and SHOULD report the change in the tool response (`capabilities_recomputed`).

---

## 5. Architectural Guardrails (The Compiler Rules)

The MCP server enforces deterministic rules **before** any state mutation is written to disk, physically blocking the AI (or developer) from executing out of bounds. Validation is fail-fast: the first violated rule aborts the mutation and nothing is persisted for that transition. An ordered multi-node `update_node_status` (§3.7, §8.2) is a sequence of single-node transitions: a blocked item writes nothing for itself, every other item is still tried, and the call is `Blocked:` only when no item moved.

### 5.1 Error contract

Every rejection MUST be surfaced as a tool error whose text begins with the exact prefix:

```
Blocked: <reason>
```

The reason MUST name the violated rule, the offending node(s) and state(s), and — where applicable — the remediation (e.g. which tool call to make first). Agents MUST treat `Blocked:` responses as hard failures: fix the plan, do not retry blindly.

### 5.2 Rule 1 — No Ghost Interactions

An Interaction MUST NOT transition to `ready` or `in-progress` unless, at validation time:

1. it has at least one `belongs_to` edge to a Capability, **and**
2. it has at least one `depends_on` edge to a Foundation.

Rationale: behaviour that belongs to no capability and stands on no infrastructure is unroutable and unreviewable — it must not enter execution.

### 5.3 Rule 2 — No Ghost Interfaces

An Interface MUST NOT transition to `ready` or `in-progress` unless, at validation time, it has at least one `exposes` edge to an Interaction.

Rationale: an entry surface with nothing to enter is hollow. Foundation `depends_on` on an Interface is optional (Assembler/Adapter wiring) and is **not** required by this gate.

### 5.4 Rule 3 — Infrastructure First

An Interaction MUST NOT `ship` (transition from `in-review` to production) unless **every** Foundation reachable via its direct `depends_on` edges is **ready for dependents**:

- `stable`, or
- `in-review` (its live file before first ship, else its open revision under the change being judged, §3.6) with at least one checklist item and every `build` item ticked (§3.3), **and** each of its own dependencies (`depends_on`; for an Interface also `exposes`) ready for dependents by this same rule, transitively.

A dependency with no checklist items counts only once `stable`. Its `review` and `deploy` items may still be open: they wait on people, and the dependency itself still ships only with every item ticked (§5.6). The rejection message MUST enumerate each dependency that is not ready with its current state, and says when a dependency counts.

**Shipped work never rests on unshipped work.** Because a dependent may ship before its in-review dependency, retiring that dependency, or taking back what made it count, would leave shipped work on nothing. While a `stable` or `unstable` node `depends_on` a node that is not `stable` (or an Interface `exposes` it), these are `Blocked:`, naming those dependents and the fixes (ship the dependency, or `force_unship` the dependents): `cancelled`; moving its active slot back from `in-review`; and any `patch_node_territory` or `resolve_conflict` edit that, while that slot is in review and every `build` item in it was done before the call (the relaxed rule: the only slot a dependent can have shipped on), leaves a `build` item not done or fewer `build` items done; the Block names the items not done after the call, marking `(was done)` those the call took back (matched by id, or by text when untagged), and the done count before and after. A slot that already had an open `build` item was not relied on, so its build items are not guarded; a done item reworded in place, or a done item added, passes. `discard_next` of a shipped node's revision is `Blocked:` only when such a dependent relied on the revision's view: one of its owned files imports a file that only the revision claims (live does not); otherwise the discard goes ahead.

Rationale: concrete must be poured before the roof is built. A behaviour cannot go live on substrate that is not stable in production.

(There are no Interaction→Interaction `depends_on` edges; Infrastructure First does not walk other Interactions.)

### 5.5 Rule 4 — Behavior First

An Interface MUST NOT `ship` unless:

1. **every** Interaction reachable via its direct `exposes` edges is ready for dependents (§5.4: `stable`, or `in-review` with every `build` item ticked and its own dependencies ready, transitively), **and**
2. **every** Foundation reachable via its direct `depends_on` edges (if any) is ready for dependents.

The rejection message MUST enumerate each exposed Interaction and/or Foundation dependency that is not ready with its current state, ending with the same sentence as §5.4.

Rationale: an entry surface must not go live while the behaviours it exposes (or the substrate it mounts on) are unfinished.

### 5.6 Rule 5 — The Completion Check

A Foundation, Interaction, or Interface MUST NOT transition to `ship` while the territory file being judged (`<id>.mdx`, or the revision file of the change being shipped) contains one or more unchecked Atomic Operations (`[ ]`). A Bug MUST NOT transition to `resolved` while unchecked items remain. The rejection message MUST include the count of open checkboxes.

`in-review` MUST NOT require a complete checklist, `build` items included. Agents enter `in-review` with open DoD items, then tick them while in review. The check counts every item whatever its kind (§3.3): a `review` or `deploy` item left open holds the node's own ship, even when its dependents may already ship (§5.4).

An item ticked with a note (`— note: …`) or as not applicable with a reason (`— n/a: <reason>`, §3.3) is complete. `— n/a:` with an empty reason counts as unchecked.

Atomic Ops are a **ship-time ledger**: the record confirmed before `ship` / `resolved`, not a plan and not progress narration. The server does not restrict when boxes may be checked, including checking every box while the node is still `draft`, `ready`, or `in-progress`. The Completion Check at ship is the only checklist gate.

Rationale: the ledger is only meaningful at the moment it is relied on. Blocking `ship` on an unchecked item keeps “done” honest without dictating when an agent ticks boxes while it works.

**Atomic Ops live only on unshipped slots.** A node shows its current state; the ledger a ship relied on is history, and git keeps it. So every `ship` removes the Atomic Ops section (a Foundation's `## Checklist` too) from the shipped `<id>.mdx`, on first ship and on a revision's ship; `## Rules` and every other section stay. `open_next` gives the revision file a fresh list of unticked default items (the `create_node` defaults, §6.3), placed where the old section was or else before `## Rules` or `## Attachments`, so a revision can never ship on the ticks of the release before it. `force_unship` gives the live file the same fresh list, since the unshipped node must pass this check again. A Bug's Fix Checklist is never removed. `upgrade_project` removes the Atomic Ops that releases before 0.7.0 left on shipped nodes (an open revision keeps its own). The Minimum Territory Shape checklist requirement applies on the transitions of unshipped slots only, where the section always exists.

### 5.7 Rule 6 — No Ghost Bugs

A Bug MUST NOT transition to `triaged` or `fixing` unless it has at least one `affects` edge to an Interaction, Interface, or Foundation at validation time.

### 5.8 Rule 7 — Computed Capabilities

Manual status mutation of a Capability MUST be rejected (§4). This is a compiler rule, not a convention.

### 5.9 Rule 8 — Computed Stability

Manual mutation of a Foundation, Interaction, or Interface to `stable` or `unstable` MUST be rejected. Production posture is computed per §3.5 after `ship` and whenever open Bugs change.

### 5.10 Rule 9 — Taxonomy enforcement and Interaction Independence

Edge creation MUST validate:

- both node ids exist in territory,
- the edge shape is legal per §2.2,
- the edge is not a self-link and not a duplicate,
- **Interaction Independence:** `depends_on` from an Interaction MUST NOT target another Interaction — share state through Foundations instead,
- `depends_on` edges do not create a cycle (§2.2). Cycle detection MUST use the **effective** `depends_on` set for each node under the change being written or judged (§3.6): live with that change's revision delta applied, otherwise live `depends_on`; other changes' revisions do not count. A revision's ship MUST re-assert acyclicity under its change before writing live.
- **No cycle across changes.** Each change is judged alone, so two changes could each add half of a `depends_on` cycle and both pass; neither could then ship after the other. The server also builds the `depends_on` graph over live plus **every** open change at once — shipped nodes' live edges, each open revision's `depends_on_add` (a revision's `depends_on_remove` takes its live edge out for that change only), a pre-ship active node's edges under its `change`, and every planned `depends_on` (§3.7) under its change — and rejects a cycle whose non-live edges need **two or more** changes (a cycle one change closes alone is the per-change rule above). `link_nodes` (a live edge, a revision delta, or a planned edge) and `open_next` (the change's planned `depends_on` it applies) are `Blocked:` when the edge would close one: `Blocked: depends_on "<source>" -> "<target>" (change "<change>" | live) would close a dependency cycle across changes "<a>", "<b>": <path>. The changes could never ship in any order; move the shared part into a Foundation both depend on.` `run_check` reports each existing one as `Blocked: change cycle: changes "<a>", "<b>": <path> (<edge> in "<a>", …). …` (with `change`, only the cycles that change takes part in, prefixed `change "<id>": `).
- `leads_to` MUST NOT be subjected to cycle rejection.
- `mounts` runs from a Foundation to an Interface only; it is not part of the `depends_on` acyclicity set.

**Check gate.** A move to `in-review` or `ship` (Foundation, Interaction, Interface) MUST run the default check's **import matrix** and **exclusivity** rules over the node's files under the change being moved (live with the revision's claim delta applied, else `implements`; §3.6) and fail with `Blocked: Check failed for "<id>" …`, listing each violation with its fix (a `link_nodes` call, or `not allowed: …`). It runs after the transition's other rules and before any write. Coverage, presence, mirror and leftover rules stay in the default check (§9.6) — they are not gates.

There is **no Dependency Closure** rule. Implementations MUST NOT accept or document a `link_dependent` parameter on `link_nodes`.

### 5.11 Rule 10 — Version Lineage (stable-id evolution)

`open_next` MUST validate:

- the node exists and is type `Foundation`, `Interaction`, or `Interface`,
- the node is in state `stable` or `unstable` (shipped) — Capabilities, Bugs, and unshipped pipeline nodes MUST be rejected,
- `change` is given (a valid change id) — without it the call is `Blocked:` and names the retry,
- the node has no **open** revision of `change` — the rejection message MUST name the change and point to editing it (pass `change`), shipping it, or `discard_next({ node_id, change })`; revisions of other changes do not block,
- every planned edge of `change` on the node is still legal (§3.7).

`discard_next` MUST validate:

- the node has an **open** revision: the one of `change`, or its only one when `change` is omitted (several open and no `change` is `Blocked:` listing them). A leftover `mirror` file is not one; `upgrade_project` removes it.

While revisions are open, the manual build pipeline transitions (`draft → ready → in-progress → in-review`) and Ghost / Completion rules apply to the named revision's own state, checkboxes, and effective edges under its change — not to `<id>.mdx`, which is untouched and keeps serving, and not to the node's other revisions. A revision holding a rebase conflict (§3.6) MUST NOT move to `in-review` or `ship`; the rejection names a `resolve_conflict` call for each conflict. `deprecated` on a node with open revisions deletes every revision folder (and closes each change that loses its last revision, §3.7).

On successful `update_node_status({ node_id, change, new_status: "ship" })` for a node whose revision of `change` is `in-review`, the server MUST:

1. re-validate Infrastructure First / Behavior First and Completion Check under `change` (§3.6),
2. **ship the revision**: write live ⊕ the revision onto `<id>.mdx` under the unchanged `id`, move its decision files to the node's `decisions/`, copy its attachments into `attachments/`, compute the new `stable`/`unstable` from open Bugs (§3.5), and delete `revisions/<change>/`,
3. **rebase** every other open revision of the node onto the new live (§3.6) and report each as `rebased: [{ change, conflicts }]`.

There is no successor id, no relinking step, and no predecessor to auto-deprecate: the `id` never changes, so every existing edge that already targets this node continues to resolve correctly through and after the ship.

Rationale: versioning models replacement without downtime during the build, without ever forcing dependents to discover and re-point at a new id, and without making one change wait for another on the same node. Git history of `<id>.mdx` is the audit trail for what each ship changed; while a revision is open, `get_node_context({ node_id, change })` reads it beside live.

### 5.12 Rule 11 — Force Unship (mistaken ship recovery)

`force_unship` MAY reverse a mistaken Foundation/Interaction/Interface ship. It is the only legal path from `stable`/`unstable` back to a pre-ship execution state. The server MUST:

1. require `confirm` exactly equal to `unship:<node_id>` — any other value MUST be rejected with a message that tells the agent to ask the user and not invent confirmation,
2. accept only Foundation/Interaction/Interface nodes currently in `stable` or `unstable`,
3. reject while any revision is open, naming each (`discard_next` or ship each first); on success delete any leftover mirror file,
4. reject while any **direct** `depends_on` dependent is itself `stable` or `unstable` (enumerate them; force-unship or deprecate dependents first so Infrastructure First remains coherent),
5. accept `new_status` only in `draft | ready | in-progress | in-review` (default `ready` when omitted),
6. apply Ghost Interaction / Ghost Interface / Completion Check gates appropriate to the target state (same as a normal transition into that state),
7. clear `shipped_at` and `added_claims` (§1.2) on `<id>.mdx`, give the live file a fresh Atomic Ops list (§5.6; the gates in item 6 see it, and a rejected unship leaves the file as it was), set `state` to the target, recompute Capability states, and refresh `mindplan/map.md`.

Agents MUST obtain an explicit human yes in the conversation before calling `force_unship`. Agents MUST NOT invent or “helpfully” supply `confirm`. Capabilities and Bugs MUST be rejected. Manual `stable`/`unstable` remains forbidden (§5.9).

### 5.13 Rule 12 — Decision gate

MindPlan records decisions (§6.1.2); it never makes, ranks, or judges them. It asks for one only where a missing one is costly. An **open revision** (an open revision of a shipped Foundation, Interaction, or Interface, §3.6, or a pre-ship, non-retired one at any pre-ship state) is **decision-worthy** when any of these hold, each judged under the revision's change (§3.6):

| Trigger | Holds when |
|---|---|
| Shared contract | the revision is a revision of a shipped **Foundation** |
| Schema | its claims (live with its claim delta applied) cover a migration or schema file (config `decisions.schema_files`, §1.2.1) that is new in this revision. For a shipped node's revision: a file its live claims do not cover, or one the branch adds (untracked, staged as added, or added since the merge base of `HEAD` with `main` / `master`). For a first build: a file the branch adds, so a node modeling a file the repository already had is not gated; outside a git repository every claimed one counts. A file the revision attributes to itself in another node's folder (§3.7) counts when the branch adds it, or always outside git |
| Blast radius | it has more non-retired dependents (transitive reverse `depends_on`) than config `decisions.blast_radius` |
| Edges | a shipped node's revision adds or removes a `depends_on` target. A first build's initial edges never count |

Capabilities and Bugs are never revisions. A revision that is not decision-worthy is never gated.

A decision-worthy revision **has a decision** when, on or after the day the change started (the earliest start among its open revisions: a revision's `opened_at`, `created_at` before first ship), an active node recorded a decision whose `change` is the revision's change id (§3.7), or one whose `nodes` lists this node, untagged or under that change (so one decision clears the gate of every node it lists); or the revision holds a decision of its own: a shipped node's revision any file in its `decisions/` folder, before first ship any of the node's decisions. The date bound keeps a reused change id from being satisfied by an earlier change's decisions, while a member added to a change later still gets credit for its earlier decisions.

- **While draft, ready, or in progress:** the default check (§9.6) prints `Warning: decision: "<id>" <triggers>; record the choice and the alternative you rejected with record_decision before in-review.`
- **Moving to `in-review`:** `Blocked: Decision. "<id>" <triggers>, and no decision is recorded for this revision (under change "<change>" or on the node). Record the choice and the alternative you rejected. Fix: record_decision({...}).` When the node has shipped and a trigger is the shared contract or the blast radius, the message also names the open–closed alternative before `Fix:`: `An additive alternative leaves "<id>" closed: a new node that depends_on it, or a split of it; name it in alternatives if you rejected it.` (§5.15). The gate runs after the transition's own rules and the check gate (§5.10), before any write, for single moves, revisions, scoped walks, and their dry runs. Moves to other states are not decision-gated.

### 5.14 Enforcement ordering

For a status mutation the compiler MUST evaluate, in order:

1. node exists → 2. node is not a Capability → 3. resolve the slot: the revision of `change`, or the node's only open revision (several and no `change` is `Blocked:`), else `<id>.mdx`; a retirement (`deprecated` / `cancelled`) always acts on `<id>.mdx` → 4. target state is valid for that slot → 5. transition is legal per §3 (or the §3.6 revision pipeline), and a revision moving to `in-review` or `ship` holds no conflict → 6. Rules 1–6 (type-specific, evaluated under the revision's change, §3.6), then the check gate on `in-review` / `ship` (§5.10) and the decision gate on `in-review` (§5.13) → **write** → 7. on a revision's `ship`, write live ⊕ the revision and rebase its siblings per Rule 10 (§5.11) → 8. recompute stability (§3.5) → 9. recompute Capability states (§4) → 10. synchronize frontmatter.

For `force_unship`: validate Rule 11 (§5.12), clear `shipped_at`, write pre-ship `state`, recompute Capability states, synchronize frontmatter.

For `link_nodes` / `unlink_nodes` involving `affects`: validate §5.10, write edge, recompute stability for affected targets, recompute Capabilities if applicable, mirror frontmatter.

For `link_nodes` involving `belongs_to`, `depends_on`, `exposes`, or `leads_to`: validate §5.10 (including Interaction Independence and `depends_on` cycle check where applicable), write the edge to the source's revision (the one of `change`, or its only open one) as an add delta against live, else to `current`, recompute Capability states when membership changes, mirror frontmatter.

For `open_next`: validate Rule 10 (§5.11), write `revisions/<change>/<id>.mdx` from the live file in state `draft` (optional title/description; a leftover `mirror` file is removed) with a fresh Atomic Ops list (§5.6), the change's planned edges as add deltas, and `base` hashes of live; `<id>.mdx`, its edges, and the node's other revisions are unchanged.

For `discard_next`: validate Rule 10 (§5.11), delete `revisions/<change>/`; `<id>.mdx` and the node's other revisions are unchanged.

### 5.15 Open–closed signals

A feature should mostly add nodes and files, and rarely reopen a shipped node that keeps changing for several reasons (open for extension, closed for modification). Changing often is normal on a long project, and a node everything depends on (auth) is normal too, so MindPlan compares each node with the project's own pace rather than with fixed numbers. It reads graph facts only (edges, ship counts and times, decision records, change ids), never code, and every signal below is a warning or an informational field: none of them Blocks.

- **Fan-in.** The distinct active nodes with a direct live edge into the node that a change to its contract reaches first (an edge that exists only in an open revision or as a planned edge counts once it ships): `depends_on` from any source, an Interface that `exposes` an Interaction, a composition root that `mounts` an Interface. Retired sources do not count.
- **Revision count.** A shipped node's live `<id>.mdx` carries `revisions: N` (§6.1): how many times it shipped. First ship writes `1` and each revision's ship adds one; only ship (and `upgrade_project`, below) writes it. It is a count, not a log: git keeps the history.
- **Recent ship rate.** The live file also carries `churn: X`, a decayed ship count as of `shipped_at`: each ship sets it to the previous value multiplied by `½^(days since the previous ship / half_life_days)`, plus 1 (rounded to three decimals). The rate a check sees is that value decayed on from `shipped_at` to the day the check runs, plus one while any revision is open (one, however many are open). A node that shipped often lately has a high rate; one busy a year ago and quiet since has a rate near zero. The graph's **median rate** is the median over the established nodes: shipped, active Foundations, Interactions, and Interfaces that shipped at least twice since their last split. A node shipped once, or a root that just split, has no pace yet, so a change that adds many nodes does not drag the median down and make every established node look busy.
- **Split record.** `split_at: N` and `split_into: [ids]` record where a node last split parts out of itself. A split is declared, not guessed: while a revision of the node is open, `patch_node_territory({ node_id, change, split_into: [ids] })` marks the parts on that revision. What a part is depends on the type, and each keeps the import rules intact: a Foundation splits into Foundations it then `depends_on` (it stays the composition root and imports them); an Interaction splits into Interactions that share one of its Capabilities (sibling Interactions, one behavior each); an Interface splits into the Interactions it `exposes` (the behavior moves into Interactions it only mounts). When the revision ships, the marked parts with that edge in place are recorded: `split_at` becomes the new count, the parts join `split_into`, and `churn` is reset to 0. A marked part without the edge yet returns a `split_into:` warning naming it. A wrong split record is cleared with `patch_node_territory({ node_id, split_into: [] })` on the shipped node with no open revision: `split_at` and `split_into` go, `revisions` stays, and `churn` is replayed from the node file's git history without the reset (kept as stored outside git); a node with no split record is Blocked. A revision that only starts using a new Foundation marks nothing, so it records no split. `split_into` is not an edge: it changes no import rule and no blast radius.

- **Change groups.** The reasons behind the rate come from decision records: each change id on the node's decisions (live and every open revision, superseded included), with the decision sentences recorded under it, oldest first. A hotspot shows the three most recent groups.
- **Backfill.** `upgrade_project` writes `revisions` and `churn` on every shipped Foundation, Interaction, and Interface that lacks either, from the git history of its live file (`git log --follow` over the file and one `git cat-file --batch` read): each distinct `shipped_at` value is one ship, at the first commit that has it (a side branch merging an older copy back does not count twice), plus one when the working tree holds a ship not yet committed. Past splits are inferred only from moved claims: a Foundation ship whose `depends_on` gained a Foundation that first shipped after its previous ship and no later than this one, and where one of that part's claims (at its first ship) was covered by the node's claims at the previous ship and is not at this one, is recorded as a split the same way. A ship that only starts using a new Foundation moved nothing, so it records no split. `churn` replays the ships' `shipped_at` values through the same decay, reset to 0 at a split, so a backfilled graph reads exactly as one whose ships happened under this release. Outside git a node gets `revisions: 1` and `churn: 1`; a node file git has never seen at its path (one this upgrade just renamed) is left for a later `upgrade_project`, after the rename is committed. A node that already carries both is left alone, so a second call writes nothing.
- **Hotspot.** A shipped, active Foundation, Interaction, or Interface whose rate is at least config `hotspots.min_rate` (default `2`) and at least `hotspots.outlier_ratio` (default `3`) times the graph's median rate (a median below 1 counts as 1), §1.2.1. Fan-in never decides it: a node everything depends on is fine at the project's pace. Fan-in ranks hotspots instead (rate × fan-in, highest first), since a busy node many others depend on costs the most. Open revisions raise a node's own rate but not the median, so a change that opens many nodes does not hide the others. The default check (§9.6) warns once per hotspot: `Warning: hotspot: "<id>" ships far more often than the rest of the graph lately (rate X against a median of Y)[ since it split into <ids>], and N nodes depend on it directly; it may change for several reasons. Its recent changes fall into these groups: change "a" (<decision>; <decision>), change "b" (no decision recorded). If they are separate reasons, <split>, so a later feature revises one part and the rest stays closed; if it should stay one node, record that with record_decision({ keep_whole: true }).` The split follows the import rules: a Foundation moves each group into its own Foundation that it `depends_on` (the node stays the composition root and imports the parts; a part never imports the root to register itself); an Interaction splits into separate Interactions, one behavior each, sharing state through Foundations; an Interface moves the behavior into the Interactions it exposes. A full `orient_for_work` reply (§8.1) carries `stability: { fan_in, rate, median_rate, revisions?, split_at?, split_into?, hotspot?, fan_out? }`.
- **Fan-out.** A node that must know every feature of a kind (erase a site, export an account, index for search, check a permission) grows one `depends_on` per feature, so every new feature reopens it. For each pre-ship (never shipped, not retired) Foundation, Interaction, or Interface, the fan-out count is the number of distinct other change ids among its `depends_on` targets that have never shipped (not retired, with a change id). Targets in the node's own change, shipped targets, retired targets, and targets with no change id do not count. The changes are listed in the order their first target appears in `depends_on`. When the count reaches config `fan_out.warn_at` (default `3`, §1.2.1), the default check (§9.6) warns, highest count first, then by id: `Warning: fan-out: <id> depends on <N> other changes (<a>, <b>, …). It may need to know every feature of a kind. Consider inverting: put a contract on a Foundation those changes meet (a schema convention, or a record they react to), enforce it with a node rule and a test, and drop these depends_on edges.` A full `orient_for_work` reply on a pre-ship Foundation, Interaction, or Interface carries `stability.fan_out: { count, changes }`, even at count 0 and even when the node is kept whole; a shipped node has none.
- **Keep whole.** A node the owner decided to keep whole (auth, where every change is a security change) holds a decision recorded with `keep_whole: true` (§8.2). While no record supersedes it, the node is never a hotspot, `open_next` does not warn on it, and the check prints no `fan-out:` line for it; superseding that decision turns detection back on.
- **Reopening a hotspot.** `open_next` on a shipped node that is a hotspot counting the revision it opens (and is not kept whole) opens the revision and returns `warnings: ["Warning: \"<id>\" ships far more often than the rest of the graph lately (…), and this revision reaches its N direct dependents. Prefer extending it: add a new node that depends_on \"<id>\", or split it so this change revises a smaller part (recent changes: …). If revising it is still right, record why with record_decision and name the additive alternative you rejected."]` and `decision_prompt`, the `record_decision` call with the node, the revision's change, and that alternative filled in (§8.2). The in-review decision gate is unchanged; its `Blocked: Decision` message for a shipped node's revision that changes a Foundation's contract or has a wide blast radius also names the additive alternative (§5.13).
- **Additivity of a change.** `get_blast_radius({ change })` returns `additivity` and `run_check({ change })` prints it as `Info: additivity: …` (and `change.additivity`): `{ summary, new_nodes, revised, planned }`, where `new_nodes` are its revisions never shipped, `revised` its shipped nodes with an open revision of the change (`{ id, state, fan_in }`), and `planned` the shipped nodes it will reopen through planned edges (§3.7). `summary` reads `change "payload-split": 5 new nodes, 1 revised shipped node (f-payload, fan-in 43)`, adds `, N planned revisions (…)` when there are any, and ends `; purely additive` when nothing shipped is revised or planned.

Agents check these before choosing `open_next` (the `plan-project` skill, Classify scope): a new node that `depends_on` a hotspot, or a part split out of it, keeps the shipped node closed. Two changes no longer wait for one node: each opens its own revision, and the second to ship rebases (§3.6).

---

## 6. Territory File Format

### 6.1 `<id>.mdx` structure

Every entity's `<id>.mdx` MUST begin with YAML frontmatter followed by an MDX body (Markdown plus optional JSX per §6.4). A revision file `revisions/<change>/<id>.mdx` (Foundation/Interaction/Interface only, §3.6) has its own flat frontmatter (§6.1.3) over the same kind of body:

Every MCP write of a node file leaves exactly one blank line between the closing `---` and the body (none when the body is empty), in the file's own line endings, so longer runs left by older releases collapse on the next write. `get_node_context` returns the body from its first text.

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
---

# Split & pay checkout

Diner splits and pays the bill from their phone.

<StateBadge />

## Execution Logic

Step-by-step behaviour…

## Checklist

- [x] Domain API against Foundations (no Interaction→Interaction `depends_on`)
- [ ] Mountable view exported from package
- [ ] View accepts shell/nav as props/callbacks — does not import Interface packages

## Attachments

![wireframe](attachments/checkout-wireframe.png)
<Attachment file="checkout-flow.pdf" caption="Full payment flow" />
```

Frontmatter fields:

| Field | Type | Written by | Notes |
|---|---|---|---|
| `id` | string | server, at creation | Immutable for the node's lifetime, including every revision. MUST equal folder name. |
| `type` | `Capability \| Foundation \| Interaction \| Interface \| Bug` | server, at creation | Immutable. |
| `title` | string (JSON-quoted) | territory | Human-readable. Stored only in frontmatter. A revision carries its own (§6.1.3), written to live on ship. |
| `description` | string (JSON-quoted) | territory | Short summary. Stored only in frontmatter. A revision carries its own (§6.1.3), written to live on ship. |
| `state` | string | **server only** | Build pipeline, computed production, or Bug lifecycle. A revision's state is in its own file (§6.1.3). Patched by MCP on accepted transitions. |
| `created_at` | ISO-8601 | server, at creation | Immutable; never rewritten by a revision's ship. |
| `updated_at` | ISO-8601 | **server only** | Touched on every accepted state or edge mutation to the live file. |
| `shipped_at` | ISO-8601 | **server only** | Optional; set on `ship` (first build or a revision's ship, §3.6). |
| `revisions` | integer | **server only** | `<id>.mdx` of a shipped Foundation, Interaction, or Interface. How many times it shipped: `1` at first ship, one more per revision shipped; backfilled by `upgrade_project` (§5.15). Not the open revisions, which are folders. |
| `churn` | number | **server only** | `<id>.mdx` only. A decayed ship count as of `shipped_at`: the node's recent ship rate (§5.15). Written at each ship and by `upgrade_project`. `force_unship` decays it to the unship and writes `churn_at` (the time it is as of, while there is no `shipped_at`); the next ship decays it from `churn_at` and drops `churn_at`. |
| `split_at` / `split_into` | integer / id list | **server only** | `<id>.mdx` only. The revision at which the node last split parts out of itself, and every part it split into (§5.15). Not edges. A revision's `split_into` holds only the parts it marks (§5.15); live's record is not copied in, and its view and its ship add them to live's list. |
| `severity` | `low \| medium \| high \| critical` | optional | Bug nodes only; informational in v1. |
| `belongs_to` | string[] | **server only** | Interaction only. Target Capability ids. Omitted when empty. A revision changes it through `belongs_to_add` / `belongs_to_remove` (§6.1.3), applied on ship. |
| `depends_on` | string[] | **server only** | Interaction, Interface, or Foundation. Target Foundation ids only (never Interaction). Omitted when empty. Revision deltas as for `belongs_to`. |
| `exposes` | string[] | **server only** | Interface only. Target Interaction ids. Omitted when empty. Revision deltas as for `belongs_to`. |
| `leads_to` | string[] | **server only** | Interaction only. Target Interaction ids (navigation). Omitted when empty. Revision deltas as for `belongs_to`. |
| `affects` | string[] | **server only** | Bug only. Target Interaction, Interface, or Foundation ids. Omitted when empty. |
| `added_claims` | string[] | **server only** | `<id>.mdx` of a shipped node only. The `implements` entries `set_implementation_files` added in place (§1.2). `run_check` warns `stale:` for each one the body does not name as a whole path (not as part of a longer path: `src/a.ts` is not named by `src/a.tsx`, `src/a/` not by `src/a/b.ts`) (§9.6); a territory patch prunes the entries its body now names; a revision's ship drops the list. Omitted when empty. |
| `planned` | string[] | **server only** | `<id>.mdx` of a shipped node only. Planned edges (§3.7), one `<change> <edge_type> <target>` item each; not graph edges. Written by `link_nodes` / `unlink_nodes` with `change`; a revision's ship drops its change's items; a closing change drops its own. `open_next` turns its change's items into add deltas on the revision. Omitted when empty. |
| `attributed` | string[] | **server only** | `<id>.mdx` before first ship (a revision carries its own, §6.1.3). Exact files the revision adds in another node's claimed folder (§3.7); not claims. Dropped on ship. Omitted when empty. |
| `tests` | string[] | **server only** | Foundation, Interaction, or Interface. The test files, directories ending in `/`, or globs that verify the node, written by `set_test_files` (§8.2). Not ownership: the files are claimed through some node's `implements` as usual, and several nodes may list one file. Without `change`, `set_test_files` writes it in place on live, whatever revisions are open; with `change` on a shipped node with open revisions it writes that revision's `tests_add` / `tests_remove` delta (§6.1.3), applied on ship. Omitted when empty. |
| `aliases` | string[] | **server only** | Any node type. Search aliases: synonyms, the words users will say, other languages (`quote`, `request a quote`, `ofertă`). Written by `create_node` and `patch_node_territory` (`aliases`, §8.2), each a JSON string, at most 20 of up to 60 characters, deduplicated ignoring case. Live only: revisions do not carry it, and writing it never needs `open_next` or resets readiness. Search indexes it with the node's text (§8.1.1). |

The body is free-form and owned by humans and agents, except the optional `## Rules` section (§6.1.1), which has its own writer. A `## Decisions` section is no longer written (decisions are files, §6.1.2). Frontmatter `title:` and `description:` are territory-owned and MAY be edited after creation (on `<id>.mdx` pre-ship, or on a revision at any revision state). Server-owned frontmatter fields (`state`, `updated_at`, `shipped_at`, edge arrays, `added_claims`) MUST be written only via MCP tools.

**Shipped scope freeze:** `patch_node_territory` of `title`/`description` on the `current` slot of a shipped Interaction or Interface MUST be rejected — call `open_next` first. (Same freeze applies to shipped Foundations for material scope changes via playbook; Interaction/Interface freeze is the hard gate.) Host file tools MUST NOT write territory (§8.2).

Frontmatter delimiters (`---`) MUST appear before any JSX. MDX comments use `{/* ... */}` syntax; HTML comments (`<!-- -->`) are not valid MDX and MUST NOT be used in the body.

#### 6.1.1 Node rules

Any node (Capability, Interaction, Interface, Foundation, Bug) MAY carry **node rules**: standing constraints for the work in that node's territory, stored as a `## Rules` section in its `<id>.mdx` body. The section runs from a line that is exactly `## Rules` to the next level-1 or level-2 heading, or end of file; at most one per file. It is placed immediately before `## Attachments` when that heading exists, otherwise at the end of the body. An empty rule set has no section. Node rules are not frontmatter, so §9 and `GRAPH_VERSION` (`1`) are unchanged.

- **Single writer.** Only `patch_node_rules` (§8.2) writes the section. `patch_node_territory` MUST preserve its text when it replaces the body, and MUST reject a body that contains a `## Rules` heading (the error names `patch_node_rules`). `get_node_context` returns the body without the section plus a separate `rules` string.
- **Slot independence.** Rules are not part of a revision. `patch_node_rules` writes `<id>.mdx` only; a revision body carries no `## Rules` section, every open revision reads the live rules, and a revision's ship keeps them. It never needs `open_next`. Checkbox-looking lines in the section are not Atomic Ops.
- **Inheritance.** The rules that apply to a node N, in order, each labeled with the node it came from (`via`, `distance`):
  1. N's own rules (`self`, 0).
  2. Rules of nodes reached upward through `belongs_to` (`belongs_to`): an Interaction gets its Capabilities' rules.
  3. Rules of the transitive closure of `depends_on` (`depends_on`): a dependent gets its Foundations' rules, and a Foundation gets the rules of the Foundations it depends on.
  4. For a Bug only: everything each node it `affects` would itself resolve (own, `belongs_to`, `depends_on`), with `via: affects` and distance increased by 1.

  Nothing is inherited downward (a Capability gets no Interaction's rules; a Foundation gets no dependent's), across siblings, or through `exposes` / `leads_to`. Only live edges count; a revision's edge deltas do not. A node reached twice keeps its smallest distance; nodes with no rules and inactive nodes (`cancelled`, `deprecated`, and closed Bugs: `resolved`, `wontfix`) are omitted.
- **Reach.** The inverse is the node's **rules audience**: exactly the other active nodes (not inactive, as above) whose resolved rules include an entry from N. `get_blast_radius` and `patch_node_rules` report it (§8), because editing a Foundation's rules affects everything that depends on it.
- **Enforcement.** Prose only. The compiler does not read node rules; no `Blocked:` rule depends on them.
- **Adoption.** The heading is the storage format, so a `## Rules` section already present in a node body (written before this feature) is read as that node's rules on the next load, removed from `get_node_context` `body`, and inherited like any other. Rename such a heading (for example `## Constraints`) before upgrading when it is not meant as node rules.
- **Fences.** Detection is line-based and does not understand fenced code blocks: a `## Rules` line, or a level-1/2 heading line, inside a fence counts as a heading. Keep such lines out of node rules and out of bodies that show a Rules template.

#### 6.1.2 Decision records

A node MAY carry **decision records**: why its design looks the way it does, so a later agent does not "simplify" it back into the problem it avoided. Each record is one append-only file, `decisions/<decision-id>.md`, in the node folder, or in a revision folder (`revisions/<change>/decisions/`) while that revision is open. The file holds exactly one `### <id>` entry (the format the `## Decisions` body section of releases before 0.18.0 held, so splitting a section into files is a straight cut) plus an optional `- Nodes: a, b` line; LF line endings and a final newline. Decisions are not frontmatter, so §9 and `GRAPH_VERSION` (`1`) are unchanged.

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

- **Single writer, append only.** Only `record_decision` (§8.2) writes decision files, one new file per call; a file is never rewritten, and a file of that name already there is `Blocked:`. No tool writes a `## Decisions` body section any more. `patch_node_territory` MUST reject a body, section text, or replacement containing a `## Decisions` heading, and `section: "## Decisions"` (the error names `record_decision`). Stale-text warnings ignore decisions, because a recorded decision may name a path a later revision removed.
- **Revision-bound.** Unlike rules, decisions belong to a revision while it is open. `record_decision` on a shipped node writes `revisions/<change>/decisions/` of the revision it picks (`change`, or the node's only open revision); a revision's ship moves its files to the node's `decisions/` (a name already there is `Blocked:` before anything is written), and `discard_next` deletes them. With no open revision (or a `change` the node has no revision of) it writes the node's `decisions/` beside the live file. A node's decisions are its live ones plus, read under a change, that revision's. Recording never changes state or readiness: a decision explains a contract, it does not change it.
- **Status is computed.** A decision is `superseded` while a decision held by a node that is not `cancelled` names it in `Supersedes`, and `active` otherwise. A `deprecated` node's replacement still stands (retiring it does not bring back the design it replaced); a cancelled node's work never shipped, so its decisions supersede nothing. No status is written into the old entry, so abandoning the revision that superseded a decision makes it active again. Changing a decision means recording a new one that supersedes it; the old one stays listable.
- **Ids.** Ids are unique across the graph: an id is taken while any node's decision files (live or in any open revision) hold it or any recorded `Supersedes` still names it, so an id freed by a discarded revision is not reused while a decision still points at it. A duplicate is `Blocked:`.
- **Inheritance.** Decisions reach a node along exactly the node-rules walk (§6.1.1): its own, its Capabilities', its transitive Foundations', and for a Bug those of the nodes it affects, each labeled with the node it came from. Superseded entries are left out unless asked for.
- **Where they show up.** `orient_for_work` (`decisions` block), `list_decisions`, `get_node_context` (`decisions`), `get_blast_radius` (`decisions`), and `export_mindplan_view` (`decisions: true`) (§8.1). The decision gate (§5.13) reads them.
- **Older graphs.** A `## Decisions` section left in a live body by a release before 0.18.0 is still read as that node's decisions until migration level 4 (§1.1.2) splits it into files; only its `### d-…` entries are parsed. Detection is line-based like §6.1.1: a heading line inside a fenced code block counts as a heading.

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
| `base` | The live hashes the revision last rebased on (§3.6): `title=<hash>`, `description=<hash>`, `role=<hash>`, and one `section:<heading>=<hash>` per level-2 section of the live body (`section:_preamble=<hash>` for the text above the first heading). `## Rules` and `## Decisions` are never hashed. |
| `conflicts` | Unresolved rebase conflicts: `section:<heading>`, `scalar:<field>`, `claim:<path>@<owner>`. |

Deltas are stored trimmed against live: an add already live and a remove not live are dropped when written. The **effective** lists under the change are live with the removes applied, then the adds, sorted and deduplicated. The body is the revision's whole proposed territory (§3.6 Territory Completeness) and carries no `## Rules` or `## Decisions` section: rules are live only (§6.1.1), decisions are files (§6.1.2). Decisions live in the revision's `decisions/` folder and attachments in its `attachments/` folder.

### 6.2 Frontmatter mirroring

After any accepted mutation, the server MUST rewrite server-owned fields in each affected node's territory frontmatter:

- **Status mutations:** `state:` and `updated_at:` on the transitioned slot (`<id>.mdx`, or the revision file of the change moved) plus every Capability whose computed state changed; `shipped_at:` on `<id>.mdx` when a first build or a revision ships.
- **Link/unlink:** on a node with no open revision, the appropriate outgoing edge array (`belongs_to`, `depends_on`, `exposes`, `leads_to`, `mounts`, or `affects`) on `<id>.mdx`, plus `updated_at:`; on a revision, its `<edge>_add` / `<edge>_remove` delta (§6.1.3) and its `updated_at:`.
- **Opening a revision (`open_next`):** creates `revisions/<change>/<id>.mdx` with `state: draft`, `opened_at:`, copied/overridden `title:`/`description:`, the change's planned edges as `<edge>_add`, and `base:` hashes of `<id>.mdx` at open time.
- **Discarding a revision (`discard_next`):** deletes `revisions/<change>/`; `<id>.mdx` and the other revisions are untouched.
- **Ship (`update_node_status(..., "ship")`):** on a first build, writes `state:`, `updated_at:`, and `shipped_at:` on `<id>.mdx`, and removes `change:` / `change_ref:`. On a revision's ship, writes live ⊕ the revision onto `<id>.mdx` (no `change:` / `change_ref:` / `added_claims:` / `attributed:`), sets computed `stable`/`unstable`, `revisions:`, `churn:`, and the split record, refreshes timestamps, deletes the revision folder, and rewrites each sibling revision file (rebased text, trimmed deltas, new `base:`, `conflicts:`). There is no other node's frontmatter to update — the `id` never changes.
- **Readiness reset (§3.1):** a contract write to a `ready` slot sets `state: draft` and `updated_at:` on that slot.
- **Change ids (§3.7):** `change:` and `change_ref:` are optional scalars on a pre-ship node's `<id>.mdx`, written by `create_node`, `patch_node_territory`, and (`change:` only) `set_implementation_files` and `set_test_files`; a revision file always carries `change:` (its folder name) and `change_ref:` when given to `open_next` or `patch_node_territory`. A shipped node's live file carries neither; migration level 2 strips a leftover label from releases before 0.15.0.
- **Additive claims (§1.2):** an in-place `set_implementation_files` on a shipped node writes `implements:` and `added_claims:` on `<id>.mdx`. A territory patch that names an `added_claims` entry in the body removes it from the list.
- **Linked tests:** `set_test_files` writes `tests:` on `<id>.mdx`, or (with `change`) the `tests_add` / `tests_remove` delta of the revision it picks. It never touches `state:` or `updated_at:` of `<id>.mdx`, so it never resets readiness. Other frontmatter writers keep the list verbatim, and a revision's ship applies its delta.
- **Conflicts:** `resolve_conflict` rewrites the revision's text or claim delta, drops the resolved `conflicts:` entry, and moves its `base:` entry to live.

Edge arrays use YAML block-list syntax. Empty arrays MUST be omitted from the file. If the file is missing or has no frontmatter, mirroring is skipped silently.

### 6.3 Scaffolding templates

`create_node` MUST scaffold the entity folder with a type-appropriate `<id>.mdx` and an empty `attachments/` directory (with `.gitkeep` so the folder is versionable). Revision folders are never scaffolded by `create_node` — they are created only by `open_next` on an already-shipped Foundation/Interaction/Interface (§3.6, §8.2):

- **Capability** — Overview section (what the product does in it + the behaviors it owns), Linked Interactions note, Attachments note. No checklist (Capabilities have no completion gate). No `implements`.
- **Foundation** — Shared Substrate Spec section (role tag belongs in frontmatter `description` at create time — Assembler | Infra | Design system | Adapter), Checklist (3 default Atomic Ops), Attachments note. No application-code scaffold.
- **Interaction** — Purpose / Actor & Trigger / Inputs & Outputs / PRD, Checklist. Default Atomic Ops (Kind-aware): Domain API against Foundations; exportable behavior surface (UI: mountable view; CLI/MCP/Webhook/Cron: handler/module); surface does not import Interface-owned files. No application-code scaffold.
- **Interface** — Kind / Exposed Interactions / Spec (boilerplate: App Router or CLI/MCP mounts Interaction surfaces; Interface does not own core domain or screen bodies), Checklist. Default Atomic Ops (Kind-aware): thin wiring for each `exposes` target; no duplicated domain/behavior UI; Page/UI only — shell chrome under `ui/`. No application-code scaffold.
- **Bug** — Summary, Repro Steps, Expected/Actual, Fix Checklist (3 default Atomic Ops), Attachments note. Created in state `open` (§3.4). No `implements`.

Default checklist items are Kind-aware ownership placeholders (§1.2.2); teams SHOULD replace them with real PR-sized Atomic Ops during `draft` or triage, but MUST keep the Interaction-owns-surface / Interface-mounts split. The same defaults start every revision's list on `open_next`; a shipped node keeps no Atomic Ops (§5.6).

#### 6.3.1 Declared file ownership

`create_node` scaffolds territory only. Owned files are declared afterward with `set_implementation_files` (`implements` in frontmatter). Entries are exact files or directories ending in `/` (§1.2). Foundations require `role`. Capabilities and Bugs have no code ownership.

Agents MUST implement only in paths claimed by the node's active `implements` list. Query expanded files via `get_node_implementation` (§8.1). Architecture authority is the graph plus `implements` claims — not a prescribed `src/<type>/<id>/` tree.

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
| `<DependsOn>` | `id: string` (Foundation id) | Inline reference to a Foundation dependency; viewers link to that node. Informational — `depends_on` in frontmatter is the authority. |
| `<BelongsTo>` | `id: string` (Capability id) | Inline reference to a parent Capability. Informational — `belongs_to` in frontmatter is the authority (multiple allowed). |
| `<Exposes>` | `id: string` (Interaction id) | Inline reference to an Interaction an Interface exposes. Informational — `exposes` in frontmatter is the authority. |
| `<LeadsTo>` | `id: string` (Interaction id) | Inline reference to navigation. Informational — `leads_to` in frontmatter is the authority. |
| `<Affects>` | `id: string` (Interaction, Interface, or Foundation id) | Inline reference to an afflicted node. Informational — `affects` in frontmatter is the authority. |
| `<ReproSteps>` | children | Marks repro steps for viewers. |
| `<Severity>` | `level: low \| medium \| high \| critical` | Renders bug severity. |
| `<ExpectedActual>` | `expected`, `actual` strings | Expected vs actual behaviour. |

Future spec versions MAY extend this set; they MUST NOT change the semantics of existing names.

#### 6.4.3 Project components

- Live in `mindplan/components/` at the planning root (any file layout inside is the project's business; `.tsx`/`.jsx` recommended).
- MAY be referenced from any `<id>.mdx` (live or revision file) in that project.
- MUST NOT use reserved names from §6.4.2.
- Are ignored entirely by the MCP server and the compiler rules. A missing or broken project component MUST NOT block any state transition.

#### 6.4.4 Compiler independence (normative)

The compiler MUST NOT parse, resolve, or evaluate JSX. All guardrails operate exclusively on:

1. YAML frontmatter (state mirroring, §6.2), and
2. Markdown task-list syntax (Completion Check, §3.3/§5.6).

Consequences:

- JSX anywhere in the body — known or unknown, well-formed or broken — has no effect on any accept/reject decision.
- `<AtomicOp done={false} />` does not count as an open checkbox. Work items that must gate `in-review`/`ship` (pipeline nodes) or `in-review`/`resolved` (Bugs) MUST be expressed as `- [ ]` Markdown items.
- Determinism (§9.1) is preserved: rule evaluation never depends on component resolution, a renderer, or the host project's toolchain.

#### 6.4.5 Rendering

Rendering MDX is out of scope for the MCP server. Viewers (docs sites, dashboards, IDE previews) resolve reserved names to the standard library and all other names to `mindplan/components/`. Until a viewer exists, agents and humans read context files as plain text; the JSX reads as self-describing markup.

### 6.5 Minimum Territory Shape

A structural gate on the document, not a judgment of its content (Territory Completeness, §3.6, is the semantic rule). Every transition the table names checks the slot that moves (the revision of the change moved, else `<id>.mdx`) and MUST fail with one `Blocked: Minimum Territory Shape. …` that lists **every** gap at once: a missing section, a prose section that is empty or still holds `create_node` placeholder text, a checklist section with no checkbox, a stub `## Impact`, a Foundation with no role. One gap keeps its single-section wording (Appendix A); several read `Blocked: Minimum Territory Shape. "<id>"/<file> has N problems: (1) …; (2) …. Write each section before leaving draft / entering in-review / shipping.`

<!-- shape-table:start -->
| Type | Required sections | Checked when moving to |
|---|---|---|
| Foundation | `## Purpose`, `## Shared Substrate Spec`, `## Acceptance Criteria`, `## Atomic Ops` (or `## Checklist`) with a checkbox, and a `role` (frontmatter, or a role tag starting the description) | `ready`, `in-review`, `ship` |
| Interaction | `## Purpose`, `## Actor & Trigger`, `## PRD / Execution Logic` (or `## Execution Logic` / `## PRD`), `## Acceptance Criteria`, `## Atomic Ops` with a checkbox | `ready`, `in-review`, `ship` |
| Interface | `## Purpose`, `## Kind`, `## Spec`, `## Acceptance Criteria`, `## Atomic Ops` with a checkbox | `ready`, `in-review`, `ship` |
| Bug | `## Summary`, `## Repro Steps`, `## Fix Checklist` with a checkbox | `in-review`, `resolved` |

A prose section must not be empty or hold only `create_node` placeholder text. An optional `## Impact` must not be a stub. Capabilities have no required sections. `create_node` and `orient_for_work` return `shape`: each required section marked `present`, `missing`, or `stub`.
<!-- shape-table:end -->

The server holds the table as one constant; this section and the `define-entities` skill embed the copy generated from it, and the test suite fails when an embedded copy differs. The playbook, which stays one screen, points to them. Agents learn the shape before the first transition:

- `create_node`, every full `orient_for_work` reply, and `get_node_context` return `shape: { slot, gates, sections: [{ heading, kind, status }], role? }` for a node with a transition ahead (a pre-ship node, an open revision read under its change, a Bug before `resolved` / `wontfix`): each required section is `present`, `missing`, or `stub`, and `role: "missing"` appears when a Foundation has none. A Capability, a retired node, a closed Bug, and a shipped node with no open revision have no `shape`.
- The default check warns `shape: "<id>" is missing "## X" and has stub "## Y" (required before ready)` once per node whose active slot is `draft` (a Bug before `in-review`: `required before in-review`). It never fails the check.

---

## 7. Graph Assembly

There is no central graph file. At runtime the server scans `mindplan/<folder>/<id>/<id>.mdx` (`<folder>` is `capabilities`, `foundations`, `interactions`, `interfaces`, or `bugs`) frontmatter to assemble nodes and expands outgoing edge arrays into flat edge triples. When a Foundation/Interaction/Interface folder also has `revisions/<change>/<id>.mdx` files, the server additionally parses each into that node's `open_revisions` (§3.6, §6.1.3); a revision's edge deltas are **not** expanded into graph edges — only `<id>.mdx`'s edges are live.

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
    { "source": "i-checkout-split", "target": "i-tip-selection", "type": "leads_to" },
    { "source": "bug-race", "target": "i-checkout-split", "type": "affects" }
  ]
}
```

`version` identifies the schema generation (currently `1`). It is a constant reported by the server — not persisted to disk. Breaking Interaction-centric changes keep `GRAPH_VERSION` at `1` while the package is unreleased.

### 7.2 Edge persistence rule

Outgoing edges are stored **only on the source node** in frontmatter:

| Edge type | Source type | Frontmatter field |
|---|---|---|
| `belongs_to` | Interaction | `belongs_to: [capability-id, …]` |
| `depends_on` | Interaction, Interface, Foundation | `depends_on: [foundation-id, …]` |
| `exposes` | Interface | `exposes: [interaction-id, …]` |
| `leads_to` | Interaction | `leads_to: [interaction-id, …]` |
| `affects` | Bug | `affects: [interaction-or-interface-or-foundation-id, …]` |

Capabilities have no outgoing edges. Incoming relationships are derived at scan time (e.g. a Capability discovers member Interactions by scanning all Interaction `belongs_to` arrays). A revision's edge deltas (§6.1.3) are scoped to its change (§3.6): they are not part of the assembled graph's edge triples until the revision ships onto `<id>.mdx`; a gate judging the revision sees them in the graph under its change.

### 7.3 Invariants

- Every edge endpoint MUST reference an existing territory node (folder + `<id>.mdx`).
- Edge triples are unique per `(source, target, type)`.
- Edge arrays MUST only appear on node types permitted by §7.2.
- A revision file MUST only exist alongside a `<id>.mdx` for the same Foundation/Interaction/Interface id, MUST NOT introduce a new `id`, and MUST name its folder's change.

---

## 7.4 Graph views (projections)

Exporters MAY render a deterministic typed-graph projection of the assembled graph for humans (PRs, docs, local preview). Views MUST NOT become a second write path for node records or edges — frontmatter remains the sole graph authority (§7, §9.3).

**Exception — auto-persisted Mermaid snapshot:** after every successful graph mutation (`create_node`, `link_nodes`, `unlink_nodes`, `open_next`, `discard_next`, `update_node_status`, `force_unship`), the server MUST write a full Mermaid projection to `mindplan/map.md`. That file is derived output (regenerated, not hand-edited); it MUST NOT be read back as graph state, is listed in `mindplan/.gitignore` (migration level 4, §1.1.2), and is never reported in `changed_files`. On-demand projections via MCP `export_mindplan_view` (§8.1) and CLI `mindplan-mcp view` remain available and do not replace `map.md` unless the caller writes a file explicitly.

Reference formats: Mermaid (`flowchart`) and Graphviz DOT.

### Layout conventions

| Element | Rendering |
|---|---|
| Capability | Cluster / subgraph (container; no outgoing edges) |
| Interaction | Node inside every Capability it `belongs_to` (multi-membership: one instance per Capability in Mermaid; DOT places the node in the lexicographically first Capability and annotates others) |
| Interface | Entry-surface nodes (often outside Capability clusters or linked via `exposes`) |
| Foundation | Shared infrastructure cluster |
| Bug | Overlay node; `affects` drawn dashed |
| `depends_on` | Solid dependency arrow |
| `exposes` | Distinct arrow (e.g. dashed or labeled) from Interface → Interaction |
| `leads_to` | Navigation arrow between Interactions (cycles OK) |
| `belongs_to` | Encoded by clustering — omitted as an edge in diagrams |
| Node label | `id · title · state` |

A node with open revisions renders once, at its `<id>.mdx` state and id — a revision is an in-flight territory slot, not a second node, and has no dedicated diagram representation in v1.

Interactions with no `belongs_to` into a Capability present in the view appear under an **Unassigned interactions** band.

### Filters

By default, views MUST exclude:

- nodes in state `deprecated` or `cancelled`
- Bugs in terminal states `resolved` or `wontfix`

Pass `include_retired: true` (MCP) or `--include-retired` (CLI) to include them.

Optional `focus` limits the view to that node plus its 1-hop linked neighborhood (same neighborhood definition as `find_related_nodes`).

MDX component rendering (§6.4) and external board sync (§10) remain separate concerns and are out of scope for graph-view exporters.

---

## 8. MCP Tool Contract

The server exposes thirty-seven tools over stdio. All inputs are validated with zod; all failures follow the §5.1 error contract. A successful result is **compact JSON text** (no indentation) in `content[0].text`; when the payload is an object the same payload is also returned as `structuredContent`. No tool declares an `outputSchema`. Error results are text-only. Each tool description MUST lead with when to call the tool, then what it returns, and MUST describe only that tool: it MUST NOT route the agent to a skill or another tool's behavior (the server `instructions` string carries the plan-project routing once).

**Annotations.** Every tool carries a `title` and MCP `annotations` derived from one of three kinds, so the host can decide which calls need a per-call confirmation: `read` → `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }`; `write` → `{ readOnlyHint: false, destructiveHint: false, openWorldHint: false }`; `destructive` → `{ readOnlyHint: false, destructiveHint: true, openWorldHint: false }`. `openWorldHint` is always `false`: every tool acts on the local `mindplan/` tree and the repository. The read tools are `run_check`, `get_mindplan_graph`, `export_mindplan_view`, `find_related_nodes`, `get_node_implementation`, `get_node_context`, `orient_for_work`, `get_project`, `get_rules`, `get_spec`, `get_skill`, `list_decisions`, `list_areas`, `get_blast_radius`, and `doctor`. The destructive tools, which remove data or edges no undo restores, are `unlink_nodes`, `remove_attachment`, `discard_next`, and `force_unship`. Every other tool is `write`. The same kind drives the envelope: a `read` tool MAY carry `drift`, a `write` or `destructive` tool only with `verbose: true`.

**Revisions and `change`.** Every tool that reads or writes a shipped node's revision (§3.6) takes an optional `change` naming it: `patch_node_territory`, `set_implementation_files`, `set_test_files`, `put_attachment`, `remove_attachment`, `link_nodes`, `unlink_nodes`, `record_decision`, `discard_next`, `resolve_conflict`, `update_node_status`, `orient_for_work`, `get_node_context`, `get_blast_radius`, and `run_check` (`open_next` requires it). Omitted, the call acts on the node's only open revision, or on live when none is open; several open and no `change` is `Blocked:` listing them (`"<id>" has open revisions "a", "b"; pass change.`), and a `change` the node has no revision of is `Blocked:` too, except where a tool gives it another meaning below (planning an edge, tagging a decision, a change-wide read). A write result on a node with open revisions carries `revisions: [{ change, state, conflicts? }]`.

**Graph root per call (`root`).** One server serves the main checkout and its git worktrees. Every tool takes an optional `root`: the absolute path of a checkout or git worktree whose `mindplan/` this one call reads and writes (its source files, git probe, config, version stamp, and `.mindplan-cache/` included). Omitted, the call uses the server's project root (`MINDPLAN_ROOT`, else the working directory). For every tool, a `root` that is not an absolute path to an existing directory is Blocked (`Blocked: root "<path>" must be an absolute path to a checkout or git worktree`, `Blocked: root "<path>" is not an existing directory`). A `root` with no `mindplan/` folder is `Blocked: root "<path>" has no mindplan/ folder`, except for `setup_project` and `doctor`, which create or diagnose one. The version gate (§1.1.2), the handler, and the envelope all run inside that root. A successful object result for a root other than the server's adds `root` (the resolved path) unless it carries its own `root`; an array or other JSON result stays as it is (no text is appended to JSON); a `Blocked:` or plain-text result from such a call ends with ` (root: <path>)`, so the caller sees which graph answered. Orientation is per root (§8.1.2): orienting on a node in one checkout never unlocks it in another. The background search warm-up stays on the server's root.

**Result size.** A host truncates a result over its limit silently (Claude Code: 25,000 tokens; claude.ai: about 150,000 characters). The two tools whose result grows with the graph bound it: `get_mindplan_graph` pages, and `export_mindplan_view` refuses an over-budget diagram with the fix (below). Successful read results (except `get_project`, `get_rules`, `run_check`, and `doctor`) MAY include `drift` when uncommitted source files exist (envelope below), scoped to the node the result is about; `get_project` and `get_rules` MUST NOT include it, because `get_rules` runs before every action and `orient_for_work` already carries the report. A write tool returns a **small result by default** and includes `drift` and the neighborhood only with `verbose: true` (below).

### 8.1 Read tools

#### `get_mindplan_graph`

Returns one page of the graph assembled from territory frontmatter (§6.1, §7).

- **Input:**
  - `offset` (integer ≥ 0, optional, default `0`) — index of the first node, in id order
  - `limit` (integer 1..500, optional, default `200`) — nodes per page
  - `state` (a node state or an array, optional) — any build-pipeline or Bug state; matches the node record's `state` field (a shipped node with an open revision keeps its live state there)
  - `type` (a node type or an array, optional) — `Capability`, `Interaction`, `Interface`, `Foundation`, `Bug`
  - `change` (change id, optional) — the nodes holding an open revision of this change, and pre-ship nodes whose `change` field it is, so a change's new nodes and revisions match
  - `fields` (array of node record field names, optional) — the fields each node returns; `id` is always included. A node with several open revisions has no `next`, so when `fields` names `title`, `description`, or `next` it also returns its `open_revisions` summary beside the live values. Projection never changes which nodes or edges are returned.
  - `edges` (`true` | `false` | array of edge types, optional, default `true`) — `true` returns every edge whose source is in the page; `false` returns neither `edges` nor `total_edges`; an array (`belongs_to`, `depends_on`, `exposes`, `leads_to`, `affects`, `mounts`; values combine with OR) keeps only edges of those types whose source is in the page. Edge selection never changes which nodes are returned or how they are sorted and paged.
- **Filters:** filters combine with AND; the values inside one array with OR. Filtering happens before sorting and paging, so `total_nodes`, `offset`, `limit`, and `next_offset` describe the filtered set. Leaving every filter, `fields`, and `edges` out returns exactly the unfiltered output. For a question about part of the graph, filter, project, and drop the edges you do not need (`state: ["draft", "ready"]`, `fields: ["id", "type", "title", "change"]`, `edges: false` lists what is planned but not built) instead of reading the whole graph; for one piece of work, prefer `orient_for_work`.
- **Output:** `{ version, nodes, edges?, total_nodes, total_edges?, offset, limit, next_offset? }` (`edges` and `total_edges` are absent with `edges: false`). `nodes` is sorted by id and sliced by `offset` / `limit`; a node with open revisions carries `open_revisions: [{ change, state }]` only (no deltas or bodies; read one with `get_node_context({ node_id, change })`); `edges` holds every edge whose **source** is in the page, so a walk over every page sees each node and each edge exactly once; `total_edges` counts the edges returned for the filtered set: those whose source is in it, of the selected types (with no filter and no edge types, every edge); `next_offset` is present only while nodes remain. A graph that fits in one page returns the whole graph plus the totals. An `offset` past the end returns an empty page with the totals.
- **Errors:** `limit` above 500 is rejected at the schema layer. An unknown name in `fields` fails before any node is read: `Blocked: get_mindplan_graph fields: unknown field "<name>". Valid fields: <list>.` So does an unknown edge type in `edges`: `Blocked: get_mindplan_graph edges: unknown edge type "<name>". Valid edge types: depends_on, belongs_to, exposes, leads_to, affects, mounts.` None beyond I/O failures otherwise.

#### `export_mindplan_view`

Exports a deterministic typed-graph projection (§7.4) as Mermaid or DOT. Prefer `find_related_nodes` for agent orientation JSON; use this when a human diagram / architecture map is needed. Note: successful graph mutations also auto-write the full Mermaid projection to `mindplan/map.md` (§7.4); this tool does not itself write that file.

- **Input:**
  - `format` (`mermaid` \| `dot`, optional, default `mermaid`)
  - `focus` (slug, optional) — when set, export focus + 1-hop neighborhood only
  - `include_retired` (boolean, optional, default `false`) — include deprecated/cancelled nodes and closed bugs
  - `decisions` (boolean, optional, default `false`) — label each node that has active decisions (§6.1.2) with their count (` · 2 decisions` in Mermaid, a label line in DOT). `mindplan/map.md` never carries the counts
  - `output` (string, optional) — repo-relative path to write the diagram to. MUST resolve inside the project root and outside `mindplan/` (the server is the only writer of that tree); the result then carries `written_to` (the repo-relative POSIX path) and no `diagram`
- **Result budget:** without `output`, a diagram longer than 80,000 characters is `Blocked:` with its size, the budget, and the two fixes (`focus`, `output`); a host would otherwise truncate it silently and a cut diagram renders nothing. The CLI `view` / `export` path never applies the budget
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

- **Errors:** unknown `focus` node_id; `output` outside the root or under `mindplan/`; a diagram over the budget without `output`.

#### `find_related_nodes`

Scoped orientation for agents: rank nodes by a text query and return the focus node plus its 1-hop linked neighborhood. Does not load full `<id>.mdx` or revision bodies. Does not include transitive blast radius (use `get_blast_radius`).

- **Input:**
  - `query` (string, optional) — free text; tokenized for ranking.
  - `node_id` (slug, optional) — force focus to this node when it exists.
  - `type` (`Capability|Foundation|Interaction|Interface|Bug`, optional) — filter candidates before ranking.
  - `limit` (integer 1–20, optional, default `5`) — max ranked matches returned.
  - `area` (Capability id, optional) — rank only that Capability's members: the Capability, the Interactions that belong to it, the Interfaces that expose them, and the Foundations they depend on transitively (live and proposed edges). A non-Capability id is `Blocked:`. `orient_for_work` takes the same `area`.
  - At least one of non-empty `query` or `node_id` is required.
- **Ranking:** hybrid search over the search cache (§8.1.1). `loadGraph()` runs each call and the cache is re-synced from it first, so a search never serves a stale graph. The `type` filter applies before ranking; retired nodes (`deprecated`, `cancelled`, closed Bugs) never rank. An exact `id` is always first, then the owners of a claim that matches a path query. `score` is the fused score: higher is better, comparable only within one reply.
- **Focus selection:** if `node_id` is provided, `focus` is that id (after existence check). Otherwise `focus` is the highest-scoring match, or `null` when there are no matches.
- **Neighborhood:** all edges where `source` or `target` is `focus` (all five edge types); `nodes` includes the focus and every endpoint of those edges. Summaries only: `id`, `type`, `state`, `title`, `description`.
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

- **Errors:** neither `query` nor `node_id`; unknown `node_id`. Empty matches with a valid query and no `node_id` is success: `focus: null`, empty `nodes`/`edges`.

#### `get_blast_radius`

- **Input:** `node_id` (slug), `change` (change id, §3.7), or both; optional `include_retired` (boolean, default `false`) and `include_dependent_decisions` (boolean, default `false`).
- **Output (change):** `{ change, additivity, members: [{ id, type, state, next_state, kind }], affected, capabilities_at_risk, affected_files, tests, rules_impact, decisions, dependent_decisions }` — the radii of every member (revisions and planned sources, §3.7; `kind` is `"revision"` or `"planned"`) merged: `affected` keeps each node's smallest distance and leaves out the members themselves; `affected_files` merges groups per owner; `tests` is the sorted union of the members' tests; `rules_impact` is keyed by member id; `decisions` merges per decision id (a member's own decisions are `focus`); `dependent_decisions` counts each non-member holder once, nodes nearest to any member first; `additivity` is the change's additivity (§5.15). `Blocked:` when the change has no members.
- **Output (`node_id` + `change`):** the one-node output below, judged for that node's revision of the change on the graph under the change (§3.6): its claims, tests, and edges as live ⊕ the revision. `Blocked:` when the node has no open revision of the change. A node with open revisions lists them in `open_revisions: [{ change, state }]`.
- **Output:**

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
  // always present: the expanded `tests` (§6.1) of the focus and of every owner in affected_files, sorted: the suites a change should run
  "tests": ["tests/checkout-split.test.ts"],
  // always present: the active decisions a change to the focus would reach (§6.1.2)
  "decisions": [
    { "id": "d-split-by-seat", "node_id": "i-checkout-split", "via": "focus", "distance": 0, "decision": "Bills split by seat, not by item." }
  ],
  // always present:
  "rules_impact": {
    "has_rules": true,
    "inherited_by": [
      { "id": "i-checkout-split", "type": "Interaction", "state": "stable", "via": "depends_on", "distance": 1 }
    ]
  },
  // present when focus is an Interaction:
  "reachability": {
    "exposing_interfaces": [{ "id": "if-checkout-page", "type": "Interface", "state": "ready", "title": "...", "description": "..." }],
    "containing_capabilities": [{ "id": "c-ordering", "type": "Capability", "state": "incubation", "title": "...", "description": "..." }],
    "leads_to_downstream": [{ "id": "i-tip-selection", "type": "Interaction", "state": "draft", "title": "...", "description": "...", "distance": 1 }]
  }
}
```

Where:

- `affected` is the transitive reverse-`depends_on` closure (BFS) from `node_id` (distance 0 seed omitted from results) — Interfaces and Foundations that depend on this node, etc. Cancelled and deprecated nodes are omitted unless `include_retired` is true. BFS still traverses through retired nodes so a live dependent behind a retired one keeps its true hop distance.
- `capabilities_at_risk` lists Capability ids linked via `belongs_to` from **visible** affected **Interactions** (and from the focus Interaction when applicable),
- `reachability` MUST be included when the focus node is an **Interaction**:
  - `exposing_interfaces` — Interfaces with an `exposes` edge to this Interaction,
  - `containing_capabilities` — Capabilities this Interaction `belongs_to`,
  - `leads_to_downstream` — transitive forward closure via `leads_to` (BFS; cycles truncated by visited set), each with `distance`.
  - Cancelled and deprecated nodes are omitted from these lists unless `include_retired` is true.
- `affected_files` is grouped by owner: `{ owner_id, owner_type, via[], files[] }`, sorted by `owner_id`. Each `via` value is one of:
  - `focus` — the node's own files
  - `dependent` — files of reverse-`depends_on` dependents
  - `exposing` — files of Interfaces that expose a focus Interaction
  - `importer` — files owned by other nodes that import the focus node's files (composition-root reverse edge)
  Files are deduplicated within an owner; multiple `via` reasons merge into one entry.

- `rules_impact` is always present: `has_rules` says whether the focus carries node rules (§6.1.1) and `inherited_by` is its rules audience, each `{ id, type, state, via, distance }`, empty when `has_rules` is false or nobody inherits. It is independent of `affected`: a Capability's `inherited_by` lists its Interactions even though no one `depends_on` a Capability. Inactive nodes (retired, or closed Bugs) are never listed, whatever `include_retired` says.

- `decisions` is always present: the active decisions (§6.1.2) held by the focus (`via: focus`, distance 0), each `{ id, node_id, via, distance, decision }`. `dependent_decisions: { count, nodes }` is always present too: how many active decisions the visible `affected` nodes hold and which nodes hold them, nearest first. With `include_dependent_decisions: true` (boolean, default `false`) their rows (`via: dependent`, their distance) follow the focus's in `decisions`. Superseded decisions and decisions of inactive nodes are not listed or counted, even with `include_retired`.

- **Errors:** unknown `node_id`.
- **Rationale:** calling this before substantial implementation or `open_next` surfaces both substrate dependents and Interaction-centric reachability (who exposes this behaviour, which Capabilities contain it, where navigation flows next). The stable-id model means a revision never changes what depends on the node. Grouping and the retired filter keep the payload usable for agents.

#### `get_node_context`

- **Input:** `node_id` (slug), `include_superseded` (boolean, default `false`: superseded decisions are left out of `decisions` and `next.decisions`, the same default and flag as `list_decisions` and `orient_for_work`; with it, each superseded entry names `superseded_by`), `include_inherited_decisions` (boolean, default `false`). `change` (change id, optional) reads the node's revision of that change as `next` (`Blocked:` when it has none). `decisions` are the node's own; `inherited_decisions: { count, nodes, entries? }` names every other decision that reaches it through the node-rules inheritance (for a Bug, those of the nodes it affects too, whole at distance 1), with `entries` only when `include_inherited_decisions` is true. `slot` (`current` \| `next`, optional) returns one slot: `current` leaves `next` as `{ record }` while a revision is open, `next` leaves out the live `body` and `decisions` and is `Blocked:` without an open revision (or, with several and no `change`, listing them); omitted, both come back. `section` (a level-2 heading such as `## Spec`, optional) cuts each returned body to that section's text and adds `section` to the payload; a heading missing from a returned body is `Blocked:` and lists its sections, so a node too large for one result is read a section at a time. Status is computed over every decision file (§6.1.2), so a live decision that a decision in an open revision supersedes is left out of the live `decisions` too, until that revision is discarded.
- **Output:** always includes the live `<id>.mdx` slice. A node with open revisions also carries `revisions: [{ change, state, title?, conflicts }]` (lean: `title` only when it differs from live, `conflicts` a count, no bodies). The revision read as `next` is the one of `change`, else the node's only open revision; with several and no `change`, `next` is the string `"pass change to read a revision"` and only live comes back. The `next` object holds that revision's effective record (live ⊕ the revision, §3.6), body, decisions, and paths:

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
  "decisions": [                              // the node's live decision records (§6.1.2), each with status; superseded ones only with include_superseded
    { "id": "d-split-by-seat", "decision": "...", "alternatives": ["..."], "why": "...", "node_id": "i-checkout-split", "node_type": "Interaction", "status": "active" }
  ],
  "next": null
  // when a revision is read, the payload also carries:
  //   "revisions": [{ "change": "split-tips", "state": "in-progress", "conflicts": 0 }],
  //   "next_path": ".../revisions/split-tips/<id>.mdx", "next_attachments_path": ".../revisions/split-tips/attachments",
  //   "next": { "record": { state, title, description, updated_at, change, belongs_to?, depends_on?, exposes?, leads_to? }, "body": "...", "decisions": [...] }  // record is live ⊕ the revision; body has no Rules section (rules are live only); decisions are live then the revision's
}
```

- **Errors:** unknown `node_id`; missing `<id>.mdx`.
- The payload MUST NOT include `raw_context`, `context_path`, or top-level `title`/`description` (those live on `record`).

#### 8.1.1 Search

`find_related_nodes` and `orient_for_work` rank through one hybrid search.

- **Source of truth.** The `<id>.mdx` files are the only source of truth. Search runs on a derived SQLite cache, `.mindplan-cache/index.db` at the project root (Node's built-in `node:sqlite`). It is gitignored (the folder carries its own `.gitignore`, and the setup guide has the agent add `.mindplan-cache/` to the repo's), rebuilt from the files, and safe to delete at any time. It is not a graph file: it is never listed in `changed_files` and never part of the coverage universe.
- **What is indexed, per node.** The unit of retrieval is a node; bodies are never chunked. The indexed and embedded text is `"{type}: {title}. {description}. Area: {Capability titles}. Entry points: {Interface titles}. Aliases: {aliases}. Sections: {## headings}"`, using live's title, description, and body; each open revision whose title or description differs adds its wording (tagged with its change) and its body's headings, and every revision's edge adds count toward Area and Entry points, so a query finds a node by its new wording while it is being reshaped. Area is the Capabilities a node belongs to (an Interface: those of the Interactions it exposes; a Bug: those of the Interactions it affects); entry points are the Interfaces exposing it. Headings leave out scaffold sections and any heading most nodes share. The keyword index also holds the id split into words and the claimed paths split into words.
- **Keyword half.** FTS5 `bm25` over those columns (porter stemming), top 50. When `node:sqlite` or FTS5 is unavailable (Node 22.13's bundled SQLite has no FTS5), or the query fails, the keyword half is the same BM25 computed in JS: the same fields and weights, FTS5's `bm25()` formula, Unicode words with diacritics folded, light stemming.
- **Semantic half.** Cosine similarity between the query and each node's normalized embedding from a local transformers.js model (`search.model`, default `Xenova/bge-small-en-v1.5`, 384 dimensions), top 50 within 0.12 of the best hit. The model downloads once per machine into `~/.cache/mindplan/models` (override with `MINDPLAN_MODEL_CACHE`) and loads in the background at server start. Until it is ready, when it cannot load (offline, proxy, sandbox, `@huggingface/transformers` not installed), with `search.enabled: false`, or with `MINDPLAN_SEARCH=keyword`, search is keyword-only and never errors; the reason is logged once to stderr. `MINDPLAN_SEARCH_OFFLINE=1` uses only an already-downloaded model.
- **Fusion.** Reciprocal rank fusion, `score = Σ 1/(60 + rank)`, then a bonus of one rank step for each node one `belongs_to`, `depends_on`, `exposes`, or `mounts` link from a top-3 node (it breaks near-ties and never reorders a clear winner), then the path and exact-id shortcuts.
- **Keeping it current.** On server start and after every successful graph write, the cache syncs and re-embeds only nodes whose text changed; each search re-syncs from the loaded graph, so edits made outside MCP (`git pull`, a branch switch) are found on the next call. A change of schema version, model, or vector size drops and rebuilds the cache. A call never waits on the model download or on a full re-embed: when more than a few nodes need new vectors, that call is keyword-only and the embedding finishes in the background.

#### `orient_for_work`

Orientation for agents, summary first. With only a `query` it returns ranked rows and the agent picks one; with `node_id` it returns that node in full: its territory, rules, own decisions, owned files, and `get_blast_radius` when it is a Foundation, Interaction, or Interface.

- **Summary (query, no `node_id`):** `{ query, matches, focus: null, next }`. `matches` are rows `{ id, type, state, title, description, area?, score }` from the hybrid ranking (§8.1.1), default `limit` 8; `description` is cut to 70 characters and `area` (Capability titles) is omitted when empty. No body, neighborhood, blast radius, rules, or decisions: under 2 KB for 10 rows. `next` names the call to make.
- **Auto-focus:** when the top row is a clear winner (the query is its exact id, it is the only match, or its fused score is at least twice the next one's), the reply is the full node below plus the rows and `auto_focus: true`.
- **Full node (`node_id`, or auto-focus):** the outputs below; from `depth: "body"` on, a pipeline node also carries `files: { files, next_files?, revision_files? }`, its expanded claims (`revision_files`, keyed by change, when several revisions are open). A full reply counts as orienting on the node (§8.1.2).
- **Revisions (`node_id`, optionally `change`):** a node with open revisions lists them in `revisions: [{ change, state, title?, conflicts }]` (as in `get_node_context`). With `change`, the reply reads that revision (its view, body, shape, and a blast radius judged under the change) and carries `unlocks: "<change>"`; `Blocked:` when the node has no revision of it. Without `change`, a node with one open revision reads it; with several, the body is live and `next` says to pass `change`.

- **Input:** same as `find_related_nodes` (`query`, `node_id`, `type`, `limit`) plus `depth` (`rules` \| `body` \| `full`, default `full`), `include_superseded` (boolean, default `false`), `include_inherited_decisions` (boolean, default `false`), `known_rules_versions` (object, optional: node id → rules version), `slot` (`current` \| `next`, optional), `section` (a level-2 heading, optional), and `change` (change id, optional: alone, the change-wide reply below; with `node_id`, that node's revision of it). `rules`: the focus node's `rules` block and `context.record` (and `context.next.record`) only; `slot` and `section` are ignored. `body`: also the `context` (body, attachments) of one slot, the active one by default (the revision read as `next` — the one of `change`, or the only open one — else `current`), cut to `section` when given, both as in `get_node_context`. `full`: everything below.
- **Output (`full`):** `{ query, matches, focus, nodes, edges, context, blast_radius, rules, decisions }` where `decisions` is `{ node_id, entries, inherited_decisions }`. `entries` are the focus node's own decision records (§6.1.2, `via: self`; for a Bug, those of the nodes it affects directly, `via: affects`, distance 1), each a record plus `{ node_id, node_type, via, distance, status }`, superseded entries left out unless `include_superseded` (then each names `superseded_by`). `inherited_decisions` is `{ count, nodes }`: how many decisions reach the focus through the rest of the node-rules inheritance (`belongs_to`, `depends_on`, a Bug's further `affects`) and which nodes hold them, nearest first. With `include_inherited_decisions: true` it also has `entries`, ordered like rules: whole records at distance 1, and one line `{ id, node_id, distance, decision }` beyond (with `status` and `superseded_by` when superseded; `list_decisions` gives the full text). The blast radius `orient_for_work` embeds is the default one, so it carries the focus's own decisions and `dependent_decisions`. `decisions` is present at every depth; at `depth: "rules"` each entry is compact (`id`, `decision`, `why`, and its labels), because orientation runs before every action; `list_decisions` and the other depths return whole records. `rules` is `{ node_id, entries }`; `entries` is the focus node's resolved node rules (§6.1.1), each `{ node_id, node_type, via, distance, rules, version }` labeled with the node it came from and ordered self, `belongs_to`, `depends_on`, `affects`; `[]` when nothing applies. `version` tags the entry's text like `rules_version`; an entry whose version equals `known_rules_versions[node_id]` leaves out `rules` and carries `unchanged: true`. `rules` does not repeat the project brief rules (`get_rules`). And where `context` matches `get_node_context` (with the same `slot` and `section`, and without `decisions`, `next.decisions`, and `inherited_decisions`: the `decisions` block is the reply's only copy) when `focus` is set, else `null`; `blast_radius` matches `get_blast_radius` (default `include_retired: false`, grouped `affected_files`) for Foundation/Interaction/Interface focus (including `reachability` when focus is an Interaction), else `null`.
- **Output (`rules` / `body`):** `{ query, matches, focus, context, rules, decisions }` (and `files` at `body`) — no `nodes`, `edges`, or `blast_radius`.
- **Shape:** every full reply carries `shape` (§6.5) while the node has a transition ahead.
- **Stability:** at `depth: "full"`, a Foundation, Interaction, or Interface also carries `stability: { fan_in, rate, median_rate, revisions?, split_at?, split_into?, hotspot?, fan_out? }` (§5.15), `hotspot` being the hotspot warning line when the node is one. `fan_out: { count, changes }` is present on a pre-ship node (even at count 0 and even when kept whole) and absent on a shipped one.
- **Change (`change`, without `query` or `node_id`):** `{ change, members, rules, decisions, next }`. `members` are the nodes holding the change's open revisions (each judged as its revision of the change) and its planned sources (§3.7), plus every other active node holding an active decision recorded under the change (`kind: "decision"`: a decision gives its node no change id, so these are members of the change-wide orientation only, not of `run_check`, `get_blast_radius`, or scoped walks), each `{ id, type, state, next_state?, kind, rules_from }`, `rules_from` naming the nodes whose rules reach it; `rules` holds each source's entry once, `{ node_id, node_type, version, rules }` (text left out, `unchanged: true`, when `known_rules_versions` holds its version); `decisions` is `{ count, nodes }` over the members' own active decisions. The reply records every member in the orientation ledger (§8.1.2), so a scoped walk over the change needs no other orient call. A change with no members and no decision recorded under it, or `change` with `query`, is `Blocked:`.
- **Open items:** a node reply (any depth) carries `open_items: [{ node_id, change?, id?, kind, text }]` when the node has unticked `review` or `deploy` items (§3.3) in its live pre-ship file or an open revision; the change reply carries those of the change's members. They wait on people: the agent reports them instead of ticking them.
- **Sections:** `sections` (string array, optional) returns only the named parts of the reply, plus its identity fields (`query`, `focus`, `auto_focus`, `unlocks`, `change`, `members`, `next`). Valid names: `rules`, `decisions`, `record`, `body`, `files`, `shape`, `revisions`, `open_items`, `blast_radius`, `stability`, `neighborhood` (`nodes` and `edges`); `record` and `body` are cut from `context` (and `context.next`). An unknown name is `Blocked:` and lists the valid ones. Omitted, the reply is every part `depth` returns. A reply cut to sections **without** `rules` does not orient (§8.1.2): the rules are what the write gate is for.
- **Errors:** same as `find_related_nodes`; an unknown `depth`; an unknown section.

#### `list_areas`

Capability-first orientation: call it when unsure where work lands, then `orient_for_work({ query, area })`; a question that cuts across Capabilities searches without `area`.

- **Input:** none.
- **Output:** `{ columns, rows, count }`: `columns` is `["id", "title", "description", "interactions", "interfaces", "foundations", "open_bugs"]` and each row one active Capability, sorted by id: its title, its description cut to 60 characters, and the counts of the Capability's active members (its Interactions, the Interfaces exposing them, the Foundations they depend on) and of the open Bugs affecting any of them. A compact table, so 30 Capabilities stay under 4 KB.

#### 8.1.2 Orientation gate

Node rules are mandatory, and orientation returns rows first, so the server keeps an in-memory **orientation ledger** per MCP session (one server process), keyed by graph root (§8 `root`) and node id, so orienting in one checkout never unlocks a write in another. A node enters it, with a fingerprint of the rules that reach it (its own and every inherited entry, resolved over live edges plus the `belongs_to` / `depends_on` adds of every open revision of the node (so one orientation covers writes to any of its revisions), so a revision is built against the rules its new edges bring), when it gets a full `orient_for_work` reply (`node_id` or `auto_focus`; with `sections`, only a reply that includes `rules`), a `get_node_context` (which then carries `resolved_rules`, every rule that reaches the node), its own `create_node` result (which carries `rules`), or a `link_nodes` / `unlink_nodes` result that changed the rules reaching it (which then carries them as `rules`; these `rules` fields appear only while the gate is on). `orient_for_work`'s `rules` block resolves over the same edges; decisions and the rules audience (`rules_impact`) still follow live edges only. `patch_node_rules` keeps its author in the ledger.

These writes are `Blocked: Orientation: <tool> acts on …` with the call that fixes it (`orient_for_work({ node_id: "<id>" })`) when the node is not in the ledger, or when the rules that reach it changed since: `set_implementation_files`, `set_test_files`, `update_node_status` (every node a single, batch, or scoped walk transitions; a `dry_run` is not gated), `resolve_conflict`, `rebase_revision`, `discard_next`, `patch_node_territory` (checkbox toggles included), `patch_node_rules`, `open_next`, `record_decision`, `put_attachment` / `remove_attachment`, `force_unship`, and `link_nodes` / `unlink_nodes` on the source (`link_nodes` after its own validation). An id that does not exist reports that instead. One `Blocked: Orientation` names every unoriented node of the call: one node keeps the wording above; several are listed (`"<id>" (not oriented on in this session)` or `(rules changed since)`), and a `scope: "change"` walk names `orient_for_work({ change: "<change>" })`, which orients on every member at once (§8.1). `create_node` is never blocked. The CLI has no session and is never gated; `MINDPLAN_ORIENT_GATE=off` turns the gate off for one server process.

#### `run_check`

Runs the same check as `mindplan-mcp check` (§9.6), so agents cannot miss it.

- **Input:** `base` (git ref, optional) — opt-in dirty-src, as `--base`, and the strict merge gate's base; `change` (change id, optional); `merge` (`true` or `"strict"`, optional) — the merge gate, as `--merge` / `--merge=strict` (§9.6); `after_merge` (boolean, optional) — the after-merge check, as `--after-merge` (§9.6); `compact` (boolean, default `true`); `nodes` (node ids, optional).
- **Output (compact, the default):** `{ ok, counts, failures, warnings: [{ id, text }], acknowledged, unchanged, info, change?, merge?, removed_legacy_files? }`. `counts` maps each warning category (the warning's `<word>:` prefix — `stale`, `description`, `shape`, `hotspot`, …, else `other`) to its count. `failures` lists every failure once. `warnings` holds only the warnings that no earlier check of this root in this MCP session showed and that are not acknowledged; `unchanged` counts those an earlier check showed and this one leaves out (with `nodes`, every in-scope warning is listed, so none counts), `acknowledged` those acknowledged (`acknowledge_warning`, §8.2). A warning's **id** is `w-` plus the first 10 hex characters of the SHA-1 of its category, the first node id it names, and its text, so a warning whose text changes gets a new id and shows again. The ids already shown are kept in memory per root for the server process (a new session shows every warning once again); only acknowledgements are stored on disk. `info` holds the `Info:` lines as in the full output (`planned:`, `waiting on people:`, …).
- **Output (`compact: false`):** `{ ok: boolean, output: string, failures: string[], warnings: string[], info: string[], change?, merge?, removed_legacy_files? }`. `output` is exactly what the CLI prints: `mindplan-mcp check: ok`, or one `Blocked:` line per failure, then `Warning:` lines, then `Info:` lines (`planned:` paths, `waiting on people:`, §9.6). An illegal import failure names the fix (§9.6). The CLI always prints this full output.
- **Nodes:** with `nodes`, warnings (compact or full) are limited to those that name one of the listed nodes, and a compact result lists **every** one of them, seen before or not (acknowledged ones excepted); failures stay graph-wide (`ok` still judges the whole graph), and compact `counts.out_of_scope` says how many warnings were left out.
- **After merge:** with `after_merge`, each leftover of a git merge of graph-changing branches is a `Blocked: after-merge: …` failure naming its fix, and a revision based on an older live is a `Warning: after-merge: …` naming `rebase_revision` (§9.6).
- **Change:** with `change`, the check also runs the in-review gate on every revision of the change (§3.7): import and ownership violations on each revision's files, judged under the change (§3.6), are added to `failures` as `Blocked: change "<id>": …` (so `ok` is false), except a violation the global import rule already reported, which is not repeated, and every stale-text signal for the revisions is added to `warnings` (their `planned:` lines to `info`), with their decision warnings (§5.13) and `fan-out:` lines (§5.15). The output adds `change: { id, members: [{ id, type, state, next_state, kind }] }`, `kind` being `"revision"` or `"planned"`. A change with no members is a `Blocked:` failure.
- **Merge:** with `merge`, the `Blocked: Merge` lines (§9.6) are added to `failures` and the output adds `merge: { level: "default" | "strict", base?, changes: [{ change: string | null, nodes: [{ id, type, state, slot: "live" | "revision", files? }] }] }`, one group per change id (`null` for nodes with none, last). Agents run it before telling the user a PR is ready to merge.
- **Errors:** a failed check is a successful call with `ok: false`, including a git failure with `base` set, an invalid config, or a graph that is not `current` (§1.1.2), each reported as a `Blocked:` failure. `run_check` is not version-gated: it reports `Blocked: Version — <warning>` as its only failure instead of refusing the call.
- **Playbook:** call it before self-`ready`, `in-review`, `ship` / `resolved`, and before saying the work is done.

#### `doctor`

The server's health, for a slow attach, a server serving the wrong folder, or a graph tool failing in a way its message does not explain. Not version-gated, and answers for a `root` with no `mindplan/` (§8 `root`). Never throws.

- **Input:** none (besides `root`).
- **Output:** `{ version, node, root, graph: { status, level, server_level }, load_ms_cached, cache_hit, load_error?, cache: { graph, search }, started_at, uptime_s }`: the package version and `process.version`; the project root served; the graph status (`setup` \| `upgrade` \| `server-behind` \| `current`, §1.1.2), the stamp's migration level, and the server's; how long a graph load takes through the graph cache: `load_ms_cached`, with `cache_hit` saying whether the cache served it (the cache has no bypass, so a cold load, or a graph with no node folders, shows as `cache_hit: false`; §1.1.3) — only a `current` graph is ever loaded; otherwise `load_error` says why (`not loaded: <warning>`), and a load that fails gives its message; whether `.mindplan-cache/graph.db` and `.mindplan-cache/index.db` exist; the server's start time (ISO) and uptime in seconds.

#### `get_project`

Live read of the systems dialect and the project brief (§1.1.1). Call before the first answer or code change in a session, and again after the product description or rules change. Not before every action.

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
  "version": "This graph needs an upgrade: … Call upgrade_project, then commit the upgrade on its own."  // only when the graph is not current (§1.1.2)
}
```

When the brief is missing or unreadable, `description` and `rules` are empty strings and `path` remains the local relative path while territory is file-backed. `playbook` is always loaded from the package’s `templates/agent/playbook.md`. `check` is a fixed sentence naming the `run_check` tool and the CLI `mindplan-mcp check`. `version` is present only when the graph status is not `current` (§1.1.2), and is its warning sentence (naming `setup_project`, `upgrade_project`, or a `mindplan-mcp` upgrade). `get_project` is not version-gated. `rules_version` is the first 12 hex characters of the SHA-256 of `rules` (an empty string has one too), the same tag `get_rules` returns, so the first `get_rules` of a session can already be the short form.

- **Errors:** missing or unreadable bundled playbook → `Blocked:` (agents MUST NOT invent the dialect). Brief I/O failures surface as empty `description` / `rules` (`loadProjectBrief` MUST NOT throw).

#### `get_rules`

Mandatory project rules only (§1.1.1). Call before each action, before `orient_for_work`.

- **Input:** `known_version` (string, optional) — the `rules_version` from the last `get_project` or `get_rules`.
- **Output:** `{ path, rules, rules_version }` from `loadProjectBrief()`; when `known_version` equals the current `rules_version`, `{ path, rules_version, unchanged: true }` with no text (under 150 bytes): the rules text the caller holds still applies. Callers pass a tag only while they still hold the text it tags (not after a new session or a summarized context). Any other value, or none, returns the full text. A client that passes nothing gets the full reply, as before. `rules` is an empty string when the section is empty. Does not return the playbook or description. These are the **global** rules only; node rules arrive through `orient_for_work` (§6.1.1).
- **Errors:** none (`loadProjectBrief` MUST NOT throw).

#### `get_spec`

One part of this specification, read from the running package's own `SPEC.md`, so an agent never answers from a stale copy. Call it for a specific rule instead of guessing or retrying.

- **Input:** `topic` (optional): a stable topic id, or a tool name (its entry in §8).
- **Output:** with `topic`, `{ topic, version, text }`: `text` is each named heading's section, from the heading to the next heading of the same or a higher level, `version` the package version. Without `topic`, `{ version, topics: [{ id, title }], tools }`. Topics match headings by their text without section numbers, so renumbering does not change them: `territory-shape` (§6.5), `lifecycle` (§3.1), `bugs` (§3.2, §3.4), `atomic-ops` (§3.3, §5.6), `versioning` (§3.6), `change-ids` (§3.7 Change ids, One status call), `neighbors` (§3.7 Pull-in, Classes), `planned-wiring` (§3.7 Planned edges, Attributed files), `decisions` (§5.13, §6.1.2), `imports` (§1.2.2, §5.10), `ownership` (§1.2), `orientation` (§8.1.2), `rules` (§1.1.1, §6.1.1), `checks` (§9.6), `errors` (Appendix A).
- **Errors:** an unknown topic is `Blocked:` and names the valid ones; a missing `SPEC.md`, or a topic heading it lacks, is `Blocked:` with the reinstall fix.

#### `get_skill`

The skills this server serves, read from the running package's `templates/agent/skills/<name>/`, so an agent never follows a stale copy. Nothing is installed into the repository; the playbook and the server instructions say when to load one. Not version-gated.

- **Input:** `name` (optional): a skill name (`plan-project`, `define-entities`); `file` (optional, needs `name`): a supporting file of that skill, by its path inside the skill folder (`examples.md`).
- **Output:** without `name`, `{ skills: [{ name, description, files }] }`, `description` from the SKILL.md frontmatter and `files` its supporting files. With `name`, `{ name, text, files }`: `text` is SKILL.md without its frontmatter. With `name` and `file`, `{ name, file, text }`.
- **Errors:** an unknown name is `Blocked:` and lists the skills; an unknown file is `Blocked:` and lists the skill's files; `file` without `name` is `Blocked:`; a package without `templates/agent/skills` is `Blocked:` with the reinstall fix.

#### `list_decisions`

Reads the decision trail (§6.1.2). Call before reshaping a design someone else chose.

- **Input:** `node_id` (slug, optional), `change` (change id, optional), `include_superseded` (boolean, default `false`).
- **Output:** `{ node_id?, change?, decisions: DecisionEntry[], count }`. With `node_id`: that node's own decisions (live and every open revision's), whatever its state. Otherwise every non-inactive node's. `change` keeps decisions recorded under that change id; the filters combine. Each entry is the record plus `{ node_id, node_type, status }` and, when superseded, `superseded_by`. Superseded entries only with `include_superseded`.
- **Errors:** unknown `node_id`.

#### `get_node_implementation`

Returns declared file ownership (§1.2) for a node, or the owner of a path.

- **Input:** `node_id` (optional slug) and/or `path` (optional repo-relative POSIX path). At least one is required.
- **Output (by `node_id`, Interaction/Interface/Foundation):**

```jsonc
{
  "node_id": "i-checkout-split",
  "files": [{ "path": "src/interactions/i-checkout-split/handlers.ts", "exists": true }],
  "next_files": [{ "path": "src/interactions/i-checkout-split/handlers.ts", "exists": true }]
}
```

`next_files` is present when the node has exactly one open revision (its claims: live with the revision's delta applied); with several, `revision_files` maps each change to its claims instead. Directory and glob claims are expanded to the concrete files on disk.

- **Output (Capability):** files of member Interactions plus Interfaces that expose them, tagged `{ path, owner_id, owner_type, exists }`.
- **Output (Bug):** files of `affects` targets, tagged the same way.
- **Output (by `path`):** `{ path, owner: <node summary> | null }`.

- **Errors:** unknown `node_id`; neither `node_id` nor `path` provided.

#### `patch_node_territory`

Patches territory-owned content on `<id>.mdx` or on one revision file. Server-owned frontmatter (`state`, edge arrays, `shipped_at`) is never modified.

- **Input:**
  - `node_id` (slug, required)
  - `title` (string, optional) — pre-ship Interaction/Interface (`current`) or a revision only
  - `description` (string, optional) — pre-ship Interaction/Interface (`current`) or a revision only
  - `body` (string, optional) — replaces entire body below frontmatter
  - `section` (string, optional) + `text` (string) — rewrites the content under one `## heading` (`"## Purpose"` or `"Purpose"`); the heading line and every other section are untouched. `section` and `text` go together.
  - `replace` (`{ find, with, all? }`, optional) — replaces one exact piece of the body; `find` MUST match exactly once unless `all: true`. `body` MUST NOT be combined with `section` or `replace`.
  - `toggle_checkboxes` (array of `{ id | contains, checked?, all?, note?, not_applicable? }`, optional) — each toggle names one checklist item (§3.3) by `id` (its `{#id}` tag) or by `contains`, the item's **exact** text (tag and annotation excluded, whitespace trimmed); exactly one of the two. A text that is no item's exact text (a substring included) is `Blocked:` and lists the items with their ids. A text several items share is `Blocked:` and lists the matching lines, unless `all: true` toggles them all. `note` ticks the item and appends ` — note: <text>`; `not_applicable` ticks it and appends ` — n/a: <reason>`; `checked` may be omitted with either; both count as complete (§3.3, §5.6). Unticking strips an annotation; a new annotation replaces the old one.
  - `add_checklist_items` (array of `{ text, id?, kind? }`, optional) — appends unticked items to the slot's first checklist section (after its last item and that item's continuation lines; never inside fenced code; a thematic break, a fence, or a line after a blank line indented less than the item's content column, the marker plus the spaces after it (tabs expanded to 4-column stops), ends the item), each written `- [ ] <text> {#<id> <kind>}` (`build` is left out of the tag; an item with no id and kind `build` gets no tag). `kind` is `build` (default), `review`, or `deploy` (§3.3); an item with a non-build kind and no id gets one slugged from its text. Like any checkbox edit, it resets a `ready` slot.
  - `split_into` (string array, optional) — a node with an open revision only: the parts this revision splits out of it (§5.15): Foundations for a Foundation, Interactions for an Interaction or Interface. Written to the revision as these ids, replacing the parts it marked before (`[]` clears them); never resets readiness; a part whose edge is not in place yet (`depends_on`, a shared Capability, `exposes`) returns a `split_into:` warning. Blocked without an open revision (except `[]`, which clears a shipped node's split record, §5.15), or for an id that is not another active node of the part's type.
  - `change` (string, optional) — on a shipped node with open revisions, picks the revision to patch (§8 intro); a revision's change id is its folder name and is never rewritten. On a pre-ship node, sets its change id (§3.7); an empty string clears. Grouping metadata: it never resets readiness. On a shipped node with no open revision it is `Blocked:` (edit its files in place; it needs no change id).
  - `change_ref` (string, optional) — the branch/PR reference of the pre-ship node or of the picked revision; an empty string clears. `Blocked:` like `change` on a shipped node with no open revision.
  - `slot` (`current` \| `next`, optional) — explicitly select live (`current`) or the revision (`next`, picked by `change`); errors if `next` is requested but no revision is open (a leftover `mirror` file is not enough)
  - At least one patch field is required.
- **Slot resolution:** when `slot` is omitted, the server patches the revision (the one of `change`, or the only open one; several and no `change` is `Blocked:`) if the node is a shipped (`stable`/`unstable`) Foundation/Interaction/Interface with an open revision, otherwise `<id>.mdx`.
- **Effect:** writes territory body and/or `title`/`description` scalars on the resolved slot; touches `updated_at` in that slot's frontmatter. On a live file with `added_claims` (§6.1), removes the entries the new body names verbatim.
- **Output:** `{ node_id, patched_fields: ["description", ...], slot: "current" | "next", path, toggled?, readiness_reset?, cleared_planned?, changed_files: string[], state, next_state }` — `path` is the repo-relative MDX written; `toggled` lists the checkbox lines as written; `readiness_reset` is present when the write moved a `ready` slot back to `draft` (§3.1); `cleared_planned` lists the planned edges dropped when the write moved the last revision off a change (§3.7). This is the required writer for territory prose.
- **Errors:** unknown `node_id`; empty patch; a toggle with both or neither of `id` and `contains`; no item with that id, or with exactly that text (lists the items); a `contains` matching several items without `all` (lists the lines); `add_checklist_items` on a slot with no checklist section, with empty text, text carrying a tag or annotation, an unknown kind, an id that is not a lowercase slug, or an id already used in the slot; `note` together with `not_applicable`, or either with `checked: false`; an empty note or reason; an invalid change id; `change` or `change_ref` on a shipped node with no open revision; several open revisions and no `change`; a `change` the node has no revision of; `section` heading not found (the error lists the sections); `section` without `text`; `replace.find` not found, or found more than once without `all`; `section: "## Rules"` (use `patch_node_rules`); explicit `slot: "next"` with no open revision; shipped Interaction/Interface `title`/`description` change on `current` (`Use open_next for material scope changes on live work.`); write aimed at a leftover `mirror` file; a `body` containing a `## Rules` heading (use `patch_node_rules`); `section: "## Decisions"`, or a body, section text, or replacement containing a `## Decisions` heading (use `record_decision`).
- **Rules and Decisions sections:** a body replace of `<id>.mdx` preserves its existing `## Rules` section (§6.1.1) (and a `## Decisions` section an older release left, §6.1.2); a revision body holds neither.

#### `patch_node_rules`

Writes one node's rules (§6.1.1). Use it for a rule about one node's work; use `patch_project_rules` for a rule that applies everywhere.

- **Input:** `node_id` (slug, required); `rules` (string, required; empty string clears the section).
- **Effect:** replaces the `## Rules` section of `<id>.mdx` (revisions carry none; they read the live rules, §6.1.1). Valid for every node type in any state except inactive ones (`cancelled`, `deprecated`, closed Bugs), including `stable` / `unstable` nodes with or without open revisions. Does not change `state`, edges, checkboxes, or `shipped_at`, and does not require `open_next`.
- **Output:** `{ node_id, rules, slots: ["current"], rules_impact, changed_files }` where `rules_impact` is the node's rules audience (`{ has_rules, inherited_by }`, same shape as `get_blast_radius`) and `changed_files` lists the live file (`mindplan/map.md` does not change: rules are not graph structure).
- **Errors:** unknown `node_id`; an inactive node (`cancelled`, `deprecated`, or a Bug that is `resolved` or `wontfix`); `rules` containing a level-1 or level-2 heading line.

#### `record_decision`

Appends one decision record (§6.1.2). Call when you choose between viable designs (a data shape, an ordering guarantee, which system owns a fact).

- **Input:** `node_id` (slug, required); `decision` (string, required; one sentence); `alternatives` (non-empty string array, required); `why` (string, required); `consequences` (string, optional); `supersedes` (decision id, optional); `change` (change id, optional): the open revision of the node to record it in, and the change id the decision is tagged with; omitted, the node's only open revision (several open and no `change` is `Blocked:`), else the node's own change before first ship, else none. A `change` the node has no revision of only tags the decision, written live: it never writes a change id on the node, so a decision alone does not make a shipped node a member of that change (§3.7). `nodes` (string array, optional): every node this one decision shapes (none a Bug, each existing); written once, on `node_id`, as `- Nodes: …`, it clears the decision gate of each listed node's revision under the same change, or under any change when untagged (§5.13). `id` (optional; `d-` plus a slug; generated from the decision's first words when omitted); `keep_whole` (boolean, optional: the node stays one node on purpose, so hotspot and fan-out detection skip it while this record is not superseded, §5.15; written as `- Keep whole: true`); `verbose`.
- **Effect:** writes one new file, `decisions/<id>.md` (§6.1.2): in the picked revision's folder (`revisions/<change>/decisions/`), else in the node folder beside `<id>.mdx`. Values are collapsed to one line; `date` is today (UTC). Never changes state or readiness and does not rewrite `mindplan/map.md`. A `supersedes` target becomes `superseded` by computation; its file is not rewritten.
- **Output:** `{ node_id, slot: "revision" | "current", revision, decision: DecisionEntry, supersedes?: { id, node_id }, changed_files, state, next_state, revisions? }` (`revision` is the picked change or `null`; `anchor` with `verbose`).
- **Errors:** unknown node; an inactive node; a Bug (record the decision on the node the fix shapes); empty `decision` or `why`; no alternative; an invalid or taken id (ids are unique across the graph); an invalid change id; several open revisions and no `change`; a `nodes` entry that does not exist or is a Bug; `supersedes` that is not a recorded decision, is already superseded, or is held by a node outside the recorder's reach (itself, its Capabilities, its transitive Foundations).

### 8.2 Mutation tools

#### Territory write authority

Any change under `mindplan/` goes through the territory store. Agents reach the store through MCP. Host file tools MUST NOT write that tree. `setup_project` and `upgrade_project` reach it through MCP too; `mindplan-mcp check` / `view` MAY call the same store.

| Concern | Who writes |
|---------|------------|
| Create node, edges, pipeline/Bug state, `open_next` / `discard_next` / `ship` / `force_unship`, revision folders and their deltas, `base`, and `conflicts`, `implements`, Foundation `role` | **MCP only** |
| `title`, `description`, body (PRD / Atomic Ops), checkbox toggles | **MCP only** (`patch_node_territory`) |
| Rebase conflicts | **MCP only** (`resolve_conflict`) |
| A node's `## Rules` section (§6.1.1) | **MCP only** (`patch_node_rules`) |
| Decision files `decisions/<id>.md` (§6.1.2) | **MCP only** (`record_decision`, append only) |
| Attachments | **MCP only** (`put_attachment` / `remove_attachment`) |
| `mindplan/project.md` | **MCP only** (`patch_project_description`, `patch_project_rules`) |
| `mindplan/config.json` | **MCP only** (`patch_config`) |
| Server-owned frontmatter (`state`, `updated_at`, `shipped_at`, edge arrays, `implements`, `added_claims`, `tests`, `aliases`, `role`) | **MCP only** |
| `mindplan/map.md` | Server after graph mutations — derived snapshot, not graph authority, git-ignored |
| `mindplan/version.json` | **MCP only** (`setup_project`, `upgrade_project`; §1.1.2) |
| Graph tree creation and migrations | **MCP only** (`setup_project`, `upgrade_project`) |

Orient and trust graph state via MCP `record` responses. Do not treat on-disk frontmatter as authoritative for `state` or edges.

Successful graph mutations MUST include `changed_files: string[]` — repo-relative paths written or deleted (territory MDX, including the live file of a node whose stability was recomputed, every revision file a ship, discard, or retire deleted, every sibling revision file a ship rebased, and every decision file moved; optional scaffolds / attachment paths). `mindplan/map.md` is never listed: it is derived and git-ignored (§7.4). Agents SHOULD surface these paths to humans because many hosts do not list MCP subprocess writes in their native “edited files” UI.

**Small writes.** Every write tool that touches one node (`create_node`, `set_implementation_files`, `link_nodes`, `unlink_nodes`, `open_next`, `discard_next`, `resolve_conflict`, `patch_node_territory`, `update_node_status`, `force_unship`, `put_attachment`, `remove_attachment`, `record_decision`) accepts `verbose` (boolean, default `false`). By default its result is the tool's own fields plus `state` and `next_state` of the touched node (`next_state` is the state of its only open revision, else `null`), `revisions` when it has open revisions, and `changed_files` — no record, neighborhood, or drift — so one write stays under about 1k tokens. With `verbose: true` it also returns `anchor` (`{ record, neighborhood, next }`) and `drift`. A batch status call returns one line per node (§8.2).

Successful read results (except `get_project`, `get_rules`, `run_check`, and `doctor`) MAY include `drift` when the uncommitted working tree has source files in the ownership universe, including tracked paths deleted from disk. The report is scoped to the node the result is about (`node_id`, orient `focus`, link ends, created node); with no node it covers the whole tree. Envelope: `{ paths: [{ path, owner_id, state, next_state, class }], unowned: string[], expected: number, other_count?: number, more?: number, reminder: string }`. Each dirty file is classified:

- `unowned` — an in-universe file no node claims (listed in `unowned`);
- `owner_idle` — owned by a node with no open update: a shipped node with no open revision, or a pre-ship node not `in-progress` (listed in `paths`);
- `claimed_missing` — a claimed path that is gone from disk, such as a deleted tracked file; it keeps the owner of the file or directory claim that covers it (listed in `paths`);
- expected — the owner has an open update that claims the file (an open revision or the node itself `in-progress`, or a Bug in `fixing`/`in-review`); reported only as the `expected` count.

When scoped, files owned by other nodes are only counted in `other_count`. Each list is capped at 20; `more` counts what was dropped. Omit `drift` when there is nothing to act on (clean tree, git unreadable, or only expected edits). `drift` is not a `Blocked:` and MUST NOT change default `mindplan-mcp check`.

#### `create_node`

- **Input:** `id` (slug), `type` (`Capability|Foundation|Interaction|Interface|Bug`), `title` (non-empty), `description`, `role` (required when `type` is Foundation: `assembler|infra|design-system|adapter`), optional `change` / `change_ref` (Foundation, Interaction, or Interface only; §3.7).
- **Effect:** scaffolds the entity folder with a full-frontmatter `<id>.mdx` (§6.3). Does **not** scaffold `src/<type>/<id>/`. Declare owned files afterward with `set_implementation_files`. Does not write edge fields — those are added by `link_nodes`. Never creates a revision folder.
- **Output:** `{ created: <node from frontmatter>, folder, current, context, attachments, rules?, shape?, changed_files, state, next_state }` (project-relative paths; `context` is a deprecated alias for `current`; `anchor` with `verbose: true`). `shape` (§6.5) lists the sections the node's first transition checks; the scaffold's are `stub`.
- **Errors:** duplicate `id`; Foundation missing/invalid `role`.

#### `set_implementation_files`

- **Input:** `node_id` (Interaction, Interface, or Foundation); `add` (string[] of repo-relative POSIX paths to claim; the default way to claim) and `remove` (string[] of entries to drop: each drops every stored entry whose key equals its key, the key being the normalized path when it validates, else the raw path, with a trailing `/` ignored, so legacy duplicates that name one path go together; one that matches none is `Blocked:`, naming the stored entries); `files` (string[], the whole new list) only with `replace: true` — `files` without `replace: true` is `Blocked:`, and so is `replace: true` without `files` or combined with `add` / `remove`; optional `attributed` (string[] of exact files the revision adds in another node's folder, §3.7; replaces the list, `[]` clears; may be passed alone, keeping the claims); optional `slot` (`current`|`next`); optional `change` (change id): on a shipped node with open revisions it picks the revision (§8 intro); on a pre-ship node it sets its change id like `patch_node_territory` (empty string clears); on a shipped node with no open revision it is `Blocked:` and nothing is written (§3.7).
- **Effect:** applies the edit to the claim list being written. Pre-ship nodes write `current`. On a shipped node with an open revision, the edit is applied to live with the revision's delta and stored as that revision's `implements_add` / `implements_remove` delta against live (§6.1.3). A shipped node with no open revision (with or without `slot: "current"`) writes the live list in place only when the change is **additive** (§1.2); any other change is `Blocked:` → `open_next`. An in-place write records the new entries in `added_claims` (§6.1). Retired nodes (`cancelled`/`deprecated`) may only shrink their list. Rejects `..`, paths under `mindplan/`, and ownership conflicts with other claims under the same change (live, or live plus that change's revisions, §1.2).
- **Import scan:** after writing, scans the claimed files and returns `import_violations: [{ file, imports, fix }]` for each illegal import (omitted when none). `fix` is the exact call that makes it legal: `{ tool: "link_nodes", args: { source_id, target_id, edge_type } }` — `depends_on` for a missing Foundation, `exposes` for an unexposed Interaction, `mounts` for a Foundation importing an Interface. When no edge can make the import legal the entry has `not_allowed` instead (for example an Interaction importing an Interface, or a `depends_on` that would create a cycle). The claim is still written; the violation is also a `Blocked:` at `in-review` / `ship` (§5.10).
- **Entries:** files, directories ending in `/`, or glob claims (§1.2).
- **Readiness:** a claim on a slot in `ready` moves it back to `draft` (§3.1).
- **Folder claims:** any result (any slot) MAY add `folder_claims: [{ folder, files, note }]`, suggesting one directory claim for `folder` when every file under it is already one of this node's per-file claims and no other node claims under it.
- **Output:** `{ node_id, slot, change?, implements, implements_delta?, attributed?, added_in_place?, hint?, folder_claims?, cleared_planned?, import_violations?, readiness_reset?, changed_files, state, next_state }` — `implements` is the resulting list (on a revision, live with its delta applied) and `implements_delta` the revision's stored delta; `added_in_place` lists the entries an in-place write added, with a `hint` on naming them in the body; `changed_files` lists the live file after an in-place write.
- **Errors:** unknown/wrong type; `files` without `replace: true`; a non-additive change to a shipped node's live list, or an in-place entry that reaches a migration or schema file (→ `open_next`); retired expand; bad path; exclusivity conflict; an invalid change id; several open revisions and no `change`.

#### `set_test_files`

- **Input:** `node_id` (Interaction, Interface, or Foundation); `add` / `remove` (string[] of repo-relative POSIX test paths: files, directories ending in `/`, or globs; `add` is the default way to link); `files` (the whole new list) only with `replace: true`, as for `set_implementation_files`; optional `change` (change id): on a shipped node with open revisions it picks the revision whose delta is written (omitted: live's list is written); on a pre-ship node it sets its change id (empty string clears); on a shipped node with no open revision it is `Blocked:` and nothing is written (§3.7).
- **Effect:** edits the node's `tests` list (§6.1), deduped and sorted: on `<id>.mdx` when `change` is omitted (pre-ship node, or shipped node whatever revisions are open: written live in place, no `open_next`), or with `change` on a shipped node with open revisions as that revision's `tests_add` / `tests_remove` delta against live (§6.1.3), applied when it ships. Linked tests are evidence, not contract: a `ready` slot stays `ready`, and the files are not claimed (ownership stays with `set_implementation_files`). `files: []` with `replace: true` removes the field.
- **Gate:** entries may name files that do not exist yet while the node is a draft. Once it is in review or shipped, a missing entry fails `run_check` and the move to `in-review` or `ship` (`presence`, §9.6). A revision in review with no linked tests only warns.
- **Output:** `{ node_id, tests, cleared_planned?, changed_files, state, next_state }`.
- **Errors:** a Capability or Bug; a retired node; a bad path (`..`, absolute, under `mindplan/`); `files` without `replace: true`; an invalid change id; a `change` the node has no open revision of.

#### `open_next`

- **Input:** `node_id` (shipped Foundation, Interaction, or Interface), `change` (change id, required: without it the call is `Blocked:` and names the retry), `change_ref` (optional; §3.7), `title` (optional), `description` (optional).
- **Effect:** validates Rule 10 (§5.11), writes `revisions/<change>/<id>.mdx` from the live file in state `draft` (optional title/description; a leftover `mirror` file is removed) with empty deltas and `base` hashes of live, replaces the revision's Atomic Ops with a fresh list of unticked defaults (§5.6), and ensures its `attachments/`. `<id>.mdx` and the node's other revisions are unchanged.
- **Planned edges:** the edges planned on the node under `change` (§3.7) are added to the revision as add deltas and listed as `applied_planned`; their live entries stay until the revision ships.
- **Open–closed warning:** when the node is a hotspot counting the revision it opens (§5.15), the result carries `warnings` (the open–closed line) and `decision_prompt: { tool: "record_decision", args: { node_id, decision, alternatives, why, change? } }`, whose one alternative names a new node that `depends_on` it. The revision opens either way.
- **Output:** `{ node_id, live_state, change, revision: { change, state, title, description, opened_at, change_ref? }, folder, current, revision_path, applied_planned?, warnings?, decision_prompt?, rules?, changed_files, state, next_state, revisions }` (`revisions` lists every open revision of the node: this one and its siblings).
- **Errors:** unknown `node_id`; wrong type; node not shipped; no `change`; the node already has an open revision of `change`; a planned edge of `change` that is no longer legal (names the `unlink_nodes` call); a planned `depends_on` of `change` that would close a dependency cycle across changes (§5.10).

#### `discard_next`

- **Input:** `node_id` (Foundation, Interaction, or Interface with an open revision), `change` (optional; required when several are open).
- **Effect:** deletes `revisions/<change>/` (the revision file, its attachments, and its decisions). `<id>.mdx` and the node's other revisions are untouched. When the discarded revision was its change's last, drops that change's planned edges (§3.7).
- **Output:** `{ node_id, change, discarded: true, live_state, cleared_planned?, changed_files, state, next_state, revisions? }`; `changed_files` lists each deleted path.
- **Errors:** unknown `node_id`; no open revision (a leftover mirror file is not one); several open and no `change`; no revision of `change`; a revision a shipped node already rests on — a `stable` or `unstable` node `depends_on` the node (or an Interface `exposes` it) and imports a file only that revision claims (§5.4, names the dependents and the imports).

#### `resolve_conflict`

Clears one rebase conflict a sibling revision's ship left on a revision (§3.6).

- **Input:** `node_id`; `change` (optional; required when several revisions are open); exactly one of `section` (a level-2 heading such as `"## Spec"`, or `"_preamble"` for the text above the first heading; a bare heading gets `## `), `field` (`title` \| `description` \| `role`), or `claim` (the claimed path another node now owns); `take` (`revision` \| `live` \| `text`); `text` (with `take: "text"`: the section body or scalar value to write).
- **Effect:** `revision` keeps the revision's value; `live` takes the shipped value (a section's live text, a scalar's live value; a claim conflict drops the add); `text` writes `text` (sections and scalars only; a section's heading is added when `text` lacks it). The conflict is removed and its `base` entry moves to live, so a later sibling ship compares against the value now live. Sets `updated_at`. A resolution that changes the revision's text, scalars, or claims sends a `ready` revision back to `draft` (§3.1, `readiness_reset`), like any contract write; an `in-review` revision stays in review. Taking `revision` keeps its state.
- **Output:** `{ node_id, change, resolved, take, conflicts, changed_files, state, next_state, revisions, readiness_reset? }` — `conflicts` lists the conflicts left (`section:…`, `scalar:…`, `claim:…@…`).
- **Errors:** not exactly one of `section` / `field` / `claim`; `take: "text"` without `text`, or on a claim conflict; no open revision; several open and no `change`; the revision holds no conflict on that target (the error lists the ones it holds); an invalid Foundation role; `take: "text"` holding a level-2 heading outside fenced code (any for `_preamble`, any beyond the section's own heading); a resolution that takes back a `build` item of a relied-on in-review revision (§5.4).

#### `rebase_revision`

Carries one open revision onto current live when live changed somewhere the revision did not see: typically a sibling revision shipped on another branch and the branches merged, so `run_check({ after_merge: true })` reports the revision's `base` as stale (§9.6).

- **Input:** `node_id`; `change` (optional; required when several revisions are open); `verbose`.
- **Effect:** the rebase a ship applies to its siblings (§3.6): a section or scalar the revision did not touch takes live's text, one only the revision touched keeps the revision's, one both changed becomes a conflict (`resolve_conflict`); deltas already live (adds) or no longer live (removes) drop; claim conflicts are recomputed; every `base` hash moves to live. A `ready` or `in-review` revision whose text changed goes back to `draft` (`readiness_reset`). A revision already based on live is left as it is (`rebased: false`). Gated on orientation like every revision write (§8.1.2).
- **Output:** `{ node_id, change, rebased, conflicts, readiness_reset?, changed_files, state, next_state, revisions? }`; `conflicts` lists the conflicts the revision holds after the rebase (`section:…`, `scalar:…`, `claim:…@…`).
- **Errors:** unknown `node_id`; no open revision; several open and no `change`; no revision of `change`.

#### `acknowledge_warning`

Marks check warnings as known and accepted, so compact `run_check` results stop listing them (§8.1).

- **Input:** `id` (one warning id, `w-<10 hex>`) and/or `ids` (several).
- **Effect:** adds the ids to `.mindplan-cache/acks.json` of the call's root (§8 `root`): per checkout, git-ignored with the rest of the cache (§1.1.3), never in `changed_files`. Writes no graph node and is not gated on orientation or the graph version. An acknowledged warning is counted in `acknowledged` instead of listed; when its text changes it gets a new id and shows again.
- **Output:** `{ acknowledged: [ids] }`.
- **Errors:** neither `id` nor `ids`; an id not shaped `w-<10 hex>` (lists them).

#### `patch_project_description`

- **Input:** `description` (string, required; empty string clears the section).
- **Effect:** writes the `## Description` section of `mindplan/project.md` via the store. The `## Rules` section is unchanged. Creates the file when missing.
- **Output:** `{ path, description, rules, changed_files }`.
- **Errors:** missing `description`.

#### `patch_project_rules`

- **Input:** `rules` (string, required; empty string clears the section).
- **Effect:** writes the `## Rules` section of `mindplan/project.md` via the store. The `## Description` section is unchanged. Creates the file when missing.
- **Output:** `{ path, description, rules, changed_files }`.
- **Errors:** missing `rules`.

#### `patch_config`

- **Input:** `sources?`, `exclude?`, `decisions?: { blast_radius?, schema_files? }`, `hotspots?: { half_life_days?, outlier_ratio?, min_rate? }`, `fan_out?: { warn_at? }`, `search?: { enabled?, model? }` (at least one required).
- **Effect:** writes `mindplan/config.json` via the store. A decision, hotspot, fan-out, or search setting not passed keeps its stored value (§1.2.1); an unknown key inside `decisions`, `hotspots`, `fan_out`, or `search`, a hotspot setting that is not a positive number, or a `warn_at` that is not a positive integer is rejected.
- **Output:** `{ path, config, changed_files }`.

#### `put_attachment` / `remove_attachment`

- **Input:** `node_id`, `filename` (basename), optional `slot`, optional `change` (picks the revision when several are open); `put_attachment` also takes `content_base64`.
- **Effect:** write or delete under the node's `attachments/` or the revision's `revisions/<change>/attachments/` (defaults to the revision when one is open; several open and no `change` is `Blocked:`). A revision's attachments are copied into `attachments/` when it ships.
- **Output:** `{ node_id, slot, path, changed_files, ... }`.

#### `link_nodes`

- **Input:** `source_id`, `target_id`, `edge_type` (`depends_on|belongs_to|exposes|leads_to|affects|mounts`), optional `change`.
- **Planned:** with `change`, on a shipped source with no open revision of that change, the edge is planned instead (§3.7): `{ planned: { source, change, type, target }, note, changed_files, state, next_state }`, the live file only; nothing below applies.
- **Effect:** validates §5.10 (under the revision's change when one is written), then adds the target: to the source's outgoing edge array on `<id>.mdx`, or, when the source is a shipped Foundation/Interaction/Interface with an open revision, as an `<edge>_add` delta on that revision (the one of `change`, or the only open one; several and no `change` is `Blocked:`) (§2.2, §6.1.3). Recomputes stability (§3.5) and Capability states (§4) from the live graph (revision deltas never affect these computations until shipped), patches affected frontmatter fields.
- **Readiness:** when the written slot of the source is `ready`, it moves back to `draft` (§3.1).
- **Output:** `{ linked: {source, target, type}, slot: "current" | "next", change?, capabilities_recomputed: [...], stability_recomputed: [{id, state}], readiness_reset?, changed_files }`.
- **Errors:** unknown ids; illegal shape; Interaction Independence violation; self-link; duplicate edge (on the resolved slot); `depends_on` dependency cycle, under the change written or across changes (§5.10; checked for a live edge, a revision delta, and a planned edge alike).
- **Note:** there is no `link_dependent` parameter and no Dependency Closure cascade.

#### `unlink_nodes`

- **Input:** `source_id`, `target_id`, optional `change`.
- **Planned:** with `change` and no open revision of that change on the source, removes only the edges planned under that change from source to target (§3.7): `{ unplanned: [{ source, change, type, target }], changed_files, state, next_state }`; `Blocked:` when there are none.
- **Effect:** on a source with no open revision, removes **all** edges from `source_id` to `target_id` (any type) from `<id>.mdx`; recomputes stability and Capability states; mirrors frontmatter. On a shipped source with an open revision (the one of `change`, or the only open one; several and no `change` is `Blocked:`), the removal goes to that revision instead: each live edge to the target becomes an `<edge>_remove` delta and each `<edge>_add` of it is dropped; live is untouched until the revision ships.
- **Readiness:** when the written slot of the source is `ready`, it moves back to `draft` (§3.1).
- **Output:** `{ removed: <count>, slot?, change?, capabilities_recomputed: [...], stability_recomputed: [...], readiness_reset?, changed_files }`.
- **Errors:** unknown ids; no edge exists between the pair (live, or under the revision's change).
- **Note:** unlinking does not retroactively demote a node already past a gate; guardrails are evaluated at transition time only (§9.2).

#### `update_node_status`

- **Input (one node):** `node_id`, `new_status` (string; build/Bug state name, or `ship` for Foundation/Interaction/Interface production entry), `change` (optional: which open revision of the node moves; required when it has several, `Blocked:` listing them otherwise).
- **Input (one revision):** `revisions` — a non-empty array of `{ node_id, new_status, change? }`; each moves its node's revision of `change`, or its only open revision, if any (a node with several and no `change` is `Blocked:`). Mutually exclusive with `node_id` / `new_status`. A node may appear once per change; a duplicate is rejected.
- **Input (scope):** `scope` (`all_open_updates` \| `node_and_dependents` \| `change`) with `new_status` as the target (`ready` \| `in-progress` \| `in-review` \| `ship`); `node_and_dependents` also takes `node_id`; `change` takes `change` (the change id) and walks every revision of that change (§3.7), including `draft` and `ready` ones, each node moving its revision of that change only, or with `nodes` (node ids) only those members (§3.7 Change ids); `skip_review` (boolean) lets a walk to `ship` move nodes that are not yet `in-review` (see below); `skip_blocked` (boolean) walks every node that passes and leaves the blocked ones in place (see below). Mutually exclusive with `revisions`. `all_open_updates` selects every shipped Foundation/Interaction/Interface with an open revision, and every pre-ship one that is being built (`in-progress` or `in-review`); a `draft` or `ready` node is a plan, not an update, and is never walked by `all_open_updates`; `node_and_dependents` selects `node_id` plus the nodes that `depends_on` it or `exposes` it, transitively (including the edge adds of any open revision), and walks those that are open updates or pre-ship at any state, because the caller named the seed. These two scopes move each node's only open revision; a selected node with several stays in place and, when one of its revisions has a step left toward the target, is listed in `needs_change_walk` (`[{ node_id, changes }]`, `changes` naming those revisions) to walk with `scope: "change"`, while the other nodes walk. When no node moves and some are listed, the result adds `note` naming the change walks to run.
- **Input (any form):** `dry_run` (boolean) — validate and return the plan without writing; `verbose` (boolean).
- **Effect (one node):** runs the full §5.14 pipeline. When the node has no open revision, mutations apply to `<id>.mdx` exactly as in a first build. When revisions are open, `draft`/`ready`/`in-progress`/`in-review` transitions apply to the named revision only, judged under its change (§3.6); `ship` (only legal from that revision's `in-review`, and only with no conflict) writes live ⊕ the revision onto `<id>.mdx`, moves its decision files, copies non-`.gitkeep` files from its `attachments/` into `attachments/`, computes `stable`/`unstable`, sets `shipped_at`, deletes `revisions/<change>/`, and rebases the node's other revisions (§3.6, §5.11). `deprecated` acts on live and deletes every open revision folder. Recomputes stability and Capability states, persists, mirrors frontmatter.
- **Effect (revision):** orders the list **Foundations, then Interactions, then Interfaces, then Bugs** (caller order within a tier) and applies the one-node effect to each, reloading the graph between nodes so later gates see earlier writes (§3.7). A blocked item stays where it is and the next one is tried; the call is `Blocked:` (nothing written) only when no item moved, listing each item's reason and the change hints.
- **Effect (scope):** orders the selected nodes Foundations, Interactions, Interfaces (dependency order within a tier, on each moving revision's view: a `scope: "change"` walk orders by the change's view and the other scopes by each row's own revision, so a depends_on a revision adds counts), then walks each from its active state through `draft → ready → in-progress → in-review → ship` to the target, skipping nodes already there. Every intermediate stage runs: a node never jumps from `ready` to `stable`, and the in-review check gate runs at the `in-review` step. The whole walk is validated in memory first — every transition rule plus the check gate (§5.10) — and **nothing is written** if any step would be `Blocked:`.
- **Effect (scope with `skip_blocked`):** each node's whole walk is validated in memory on its own, on top of the nodes validated before it. A node blocked at any step (a transition rule, the check gate, the decision gate, or a review skip without `skip_review`) moves no step at all and is listed in `blocked`; a later node that cannot move without it is blocked in turn by the gates. The rest walk to the target. When nodes are blocked and none can move, the call is `Blocked:` (listing each node, step, and reason) and writes nothing.
- **Effect (scope to `ship`):** when any selected node's active state is not `in-review`, the walk is `Blocked:` (nothing written) unless `skip_review: true`. With it, those nodes still walk through `in-progress` and `in-review` (gate included) in this call, and the result lists them in `skipped_review`.
- **Effect (check gate):** a move to `in-review` or `ship` runs the check's import and exclusivity rules on the node's files under the change moved (§3.6) and is `Blocked:` on a violation (§5.10). Stale-text warnings (§9.6) for the node are returned as `warnings` and never block.
- **Effect (decision gate):** a move to `in-review` of a decision-worthy revision with no decision recorded is `Blocked: Decision` with the `record_decision` call (§5.13), in every form including a scoped walk's validation and `dry_run`.
- **Effect (closed changes):** when a `ship`, `cancelled`, or `deprecated` leaves a change with no revisions, the server drops that change's planned edges (§3.7), once after the whole call for a batch or scoped walk (`cleared_planned`).
- **Output (one node):** `{ node_id, change?, previous_state, new_state, revision_state?, state, next_state, shipped_at, promoted_next: boolean, rebased?: [{ change, conflicts, readiness_reset? }], warnings?, cleared_planned?, capabilities_recomputed: [...], stability_recomputed: [...], changed_files, revisions? }` (`anchor` with `verbose`). `state` is the live state; `change` and `revision_state` name the revision moved; `promoted_next` is true when a revision shipped; `rebased` lists each sibling revision the ship rebased with its conflicts (`section:…`, `scalar:…`, `claim:…@…`) and, when the rebase sent it back to `draft`, `readiness_reset`. On a revision's ship, `changed_files` includes `<id>.mdx`, the deleted revision folder's files, the moved decision files, any `attachments/<file>` copies, and every rebased sibling revision file.
- **Output (revision / scope):** `{ ordered: true, scope?, change?, results?: [{ node_id, change?, ok, line?, blocked? }], lines: ["<id>: <from> -> <to>", ...], skipped_review?, needs_change_walk?, note?, blocked?: [{ node_id, step, reason }], cleared_planned?, changed_files, warnings? }` (`results` for a `revisions` batch, one per item: `line` when it moved, `blocked` with its reason and change hint when not; `blocked` only with `skip_blocked`) — one line per moved node (`to` is the revision's state while one moves). `changed_files` is the union of every applied transition. With `verbose`: also `applied` (the one-node outputs) and the recomputed Capability/stability lists.
- **Output (dry_run):** `{ dry_run: true, scope?, change?, plan: ["<id>: <from> -> <to>", ...], blocked: string | null, skipped_review?, needs_change_walk?, note?, warnings? }`; `plan` lists **every transition**, one line per step (a node walking `ready → ship` contributes three lines); `blocked` names the first failing node and step, or the review skip. With `skip_blocked`, `plan` lists only the nodes that can move and `blocked` is the `[{ node_id, step, reason }]` list of the others. A `revisions` dry run validates each item on the graph as the items before it would leave it and adds `results` like the batch; `blocked` then names the items that would not move.
- **Errors:** unknown id; Capability target; invalid state name; illegal transition (on the slot that moves); Rule 1–6 violations; manual `stable`/`unstable` attempt; `ship` attempted while the revision is not in-review; a revision holding conflicts moved to `in-review` or `ship` (names a `resolve_conflict` call per conflict); several open revisions and no `change`; a `change` the node has no revision of; both input forms at once; empty or duplicate `revisions`; `scope` with `revisions`, without a forward `new_status`, or `node_and_dependents` without `node_id`; `scope: "change"` without `change`, or a change with no members; `nodes` with another scope, empty, or naming a non-member (lists the members); a `revisions` batch in which no item can move; `cancelled`, or a move back from `in-review`, on a node that is not `stable` while a shipped node `depends_on` it (or a shipped Interface `exposes` it) (§5.4, names the dependents); `skip_review` or `skip_blocked` outside a scoped walk; a `skip_blocked` walk in which no node can move; a scoped walk to `ship` past nodes not yet `in-review` without `skip_review`; a check-gate violation (`Blocked: Check failed for "<id>" …`); a missing decision (`Blocked: Decision. …`). A scope walk that is `Blocked:` writes nothing. Illegal production retreats SHOULD mention `force_unship` and the `unship:<node_id>` confirm shape. A `Blocked:` move of a node in a change ends with the change hint (§3.7 One status call).

#### `force_unship`

- **Input:** `node_id`, `confirm` (exact string `unship:<node_id>`), optional `new_status` (`draft|ready|in-progress|in-review`, default `ready`).
- **Effect:** runs Rule 11 (§5.12): clears `shipped_at`, sets pre-ship `state` on `<id>.mdx`, recomputes Capability states, refreshes `mindplan/map.md`.
- **Output:** `{ node_id, previous_state, new_state, shipped_at: null, force_unship: true, capabilities_recomputed: [...], stability_recomputed: [...], changed_files }`.
- **Errors:** wrong/missing confirm; not Foundation/Interaction/Interface; not `stable`/`unstable`; an open revision (names each; ship or `discard_next` each first); shipped direct dependents; invalid target; Ghost Interaction / Ghost Interface / Completion Check failures for the target state.
- **Playbook:** agents MUST ask the human and wait for an explicit yes before calling; MUST NOT invent `confirm`.

#### `setup_project`

Creates the graph in a repository that has none, and hands the agent the judgment work as a guide. Not version-gated.

- **Input:** `ci` (optional, `"github"`): also install the CI merge gate (§9.6).
- **Effect:** on a repository whose status is `setup` (§1.1.2): creates the tree (§1.1), a default `mindplan/config.json` (`{ "sources": ["src/**"], "exclude": [] }`), `mindplan/project.md` from `templates/agent/project.md` when absent (§1.1.1), and the stamp at the server's `MIGRATION_LEVEL`. On a `current` graph it writes nothing under `mindplan/`. It MUST NOT write any repo-owned file (`MINDPLAN.md`, `CLAUDE.md`, `AGENTS.md`, `.gitignore`, `.cursorignore`, host rules files). With `ci: "github"` it writes `.github/workflows/mindplan-merge-gate.yml` (§9.6), keeping an existing file.
- **Output:** `{ created, changed_files, ci?, pointer, guide }`. `created` is true when this call created the graph. `ci` is `{ installed, path }` (`installed: false` when the file was kept); an installed workflow is listed in `changed_files`. `pointer` is `templates/agent/agents-stub.md`, the text the agent writes to `MINDPLAN.md`; `guide` is `templates/agent/setup-guide.md`: wire `MINDPLAN.md` into the host's agent files, add the ignores, move standing rules into the brief with the user's approval, write the description, offer the merge gate, run the check.
- **Errors:** status `upgrade` or `server-behind` → `Blocked: setup_project: <warning>`; a missing template → `Blocked:` with the reinstall fix.

#### `upgrade_project`

Brings an existing graph to the server's migration level (§1.1.2). Not version-gated.

- **Input:** none.
- **Effect:** runs every migration (§1.1.2), then stamps `mindplan/version.json` with the server's `MIGRATION_LEVEL`. It reports the agent files the retired `init` installed outside `mindplan/` but MUST NOT delete them, and writes no repo-owned file.
- **Output:** `{ from_level, to_level, changed_files, migrations, leftovers, pointer_outdated, pointer, guide }`. `migrations` reports what each migration did (`capabilitiesMoved`: the moved ids, sorted; `territoryFilenames`, `config`, `atomicOpsDropped`, `mirrorTwinsRemoved`, `mirrorTwinSkips`, `revisionsBackfilled`, `splitsFound`, `agentFilesRemoved`, `staleChangeLabelsCleared`: `{ node_id, change }` per stripped label; level 4: `revisionsMoved`: `{ node_id, change }` per legacy next file moved to `revisions/<change>/`, `decisionsSplit`: `{ node_id, count }` per `## Decisions` section split into files, `mapIgnored`: true when this run added `map.md` to `mindplan/.gitignore` or untracked it). `changed_files` lists every path written, moved, or deleted, including `mindplan/.gitignore`; the `git rm --cached mindplan/map.md` is already staged, so commit the upgrade on its own. `leftovers` lists those of `.claude/skills/mindplan-define-entities/`, `.claude/skills/mindplan-plan-project/`, `.cursor/skills/mindplan-define-entities/`, `.cursor/skills/mindplan-plan-project/`, and `.cursor/rules/mindplan.mdc` that exist. `pointer_outdated` is true when `MINDPLAN.md` is missing or differs from `pointer`, or `AGENTS.md` / `CLAUDE.md` still holds the retired stub. `guide` is `templates/agent/upgrade-guide.md`: delete the leftovers, refresh the pointer, commit the upgrade alone, run the check.
- **Errors:** status `setup` or `server-behind` → `Blocked: upgrade_project: <warning>`; a rename the filesystem rejects → `Blocked:` naming the file and the renames already applied (§1.1); a missing template → `Blocked:` with the reinstall fix.

### 8.3 Attachments

Attachments under `attachments/` and a revision's `revisions/<change>/attachments/` are written only through `put_attachment` / `remove_attachment` (§8.2). `get_node_context` reports the attachment inventory (`attachments_path`, filenames) so agents can discover paths; hosts MAY read those files for display, but MUST NOT create, edit, or delete them with host file tools.

---

## 9. Operational Semantics

### 9.1 Determinism

Given identical `mindplan/` contents and an identical tool call, the server MUST produce an identical accept/reject decision and identical resulting state (timestamps excepted). There is no hidden state, no database, and no network dependency.

### 9.2 Validation-at-transition

Guardrails are evaluated at the moment of transition, against the graph and Territory as they exist on disk at that moment. MindPlan does not run continuous invariant enforcement; a graph made temporarily inconsistent by out-of-band edits is corrected the next time a gated transition is attempted.

### 9.3 Out-of-band edits

- Any change under `mindplan/` (including `<id>.mdx` and revision file bodies, decision files, `title` / `description`, attachments, `project.md`, and `config.json`) MUST go through the territory store via MCP (§8.2). Host file tools MUST NOT write that tree.
- Server-owned frontmatter (`state`, `updated_at`, `shipped_at`, edge arrays, `implements`, `role`) and the revision lifecycle (`open_next` / `discard_next` / `resolve_conflict` / `ship` / `force_unship`) are MCP-only. Hand-editing voids the framework's guarantees.

### 9.4 Concurrency

The reference implementation assumes a single writer per graph (one MCP server instance per project). Deployments requiring concurrent writers to one checkout MUST serialize mutations externally.

**Parallel work in git worktrees.** Agents working in parallel each write their own checkout's graph, and git merges them. One server serves them all through `root` (§8):

1. **Plan on the integration branch.** The orchestrator creates the change there — the nodes, the revisions (`open_next`), and the decisions — and commits it, so every worktree branched from it holds the same plan.
2. **Build in worktrees.** Each agent works in its own worktree and passes `root: "<its worktree>"` to every MindPlan tool. It fills its revisions, claims its files (`set_implementation_files` `add`), links its tests (`set_test_files`), and moves them to `in-review`. Orientation is per root, so each agent orients in its own worktree.
3. **Merge.** Merging the branches brings the graph along with the code. Run `run_check({ after_merge: true })` (CLI `mindplan-mcp check --after-merge`) on the merged checkout and fix each line it reports; where a revision's base is stale it names `rebase_revision` (§8.2).
4. **Ship from the integration branch.** The orchestrator ships with a scoped change walk (`update_node_status({ scope: "change", change, new_status: "ship" })`), passing `nodes` to ship only the finished part (§3.7).

A change whose revisions are spread over worktrees is still one change: the merge gate (§9.6) and the cross-change cycle rule (§5.10) judge it on the merged graph.

### 9.5 Deprecation, cancel, and orphans

Transitioning an Interaction or Interface to `deprecated` (post-ship) or `cancelled` (pre-ship) SHOULD be followed by an orphan review: any Foundation whose only consumers are now retired is a candidate for deprecation or cancel itself. When change is due to a **replacement of scope on live work** rather than retirement, use `open_next` instead — the node keeps its id and edges and simply gains a revision under the same folder until it ships (§3.6); there is no predecessor to auto-deprecate in the stable-id model. Implementations MAY automate orphan checks; the reference implementation leaves it to the operator (the graph query is trivial via `get_mindplan_graph` or `get_blast_radius`).

### 9.6 Offline integrity check (`mindplan-mcp check`)

The package binary exposes an offline CLI (same entry as MCP stdio, no stdio session required) that audits territory without mutating it. Config is `mindplan/config.json` `{ sources, exclude }` (missing → `sources: ["src/**"]`). A config that still has `implementation_packages` hard-fails with `Blocked:` pointing at `upgrade_project`.

| Mode | Command | Checks |
|------|---------|--------|
| Default | `mindplan-mcp check` | Graph load; **exclusivity** (each universe file ≤1 owner); **coverage** (every universe file claimed live or in an open revision of a non-retired node; `Blocked: Coverage` names the probable owner and the fix, §1.2.1); **presence** (in-review/shipped live entries exist on disk, except live entries an open revision has **released** per §1.2; an in-review revision's entries exist; every `tests` entry (§6.1) matches a file once its node is in review or shipped, `Blocked: presence: "<id>" tests entry missing on disk: "<entry>".`); **leftovers** (retired-node claims until deleted/reassigned); **import matrix** (§1.2, including `mounts`, and the test-file scope of §1.2.2); **change cycles** (each `depends_on` cycle across changes, `Blocked: change cycle: …`, §5.10). Warns (never Blocks) about a file that revisions of different changes claim (`exclusivity: "<file>" is claimed by revisions of different changes: …`, §1.2). Warns (never Blocks) about each leftover `state: mirror` next file from a release before 0.8.0: `legacy: "<id>" has a leftover mirror twin (<path>); call upgrade_project to remove it.` Warns (never Blocks) about each hotspot, highest rank first (§5.15): `hotspot: "<id>" ships far more often than the rest of the graph lately (rate X against a median of Y), and N nodes depend on it directly; …`. Warns (never Blocks, never changes `ok` or the exit code) about each pre-ship node whose fan-out reaches `fan_out.warn_at`, highest count first, then by id (§5.15): `fan-out: <id> depends on <N> other changes (<a>, <b>, …). …`. With `change`, adds `Info: additivity: <summary>` (§5.15). Does **not** run dirty-src. Does **not** fail because nodes are mid-pipeline. |
| Dirty-src (opt-in) | `mindplan-mcp check --base <ref>` | Default checks plus dirty universe ownership vs `<ref>` using the implements index: **uncommitted** paths require `in-progress` (or an open revision in-progress, or Bug `fixing`/`in-review`), or a shipped (`stable`/`unstable`) owner with no open revision (neighbors edit in place, §3.7); **committed** paths vs `base...HEAD` allow review/shipped/cancelled/deprecated, but while revisions are open only a revision in `in-progress`/`in-review` counts. Changed file with no owner fails. Explicit `--base` fails closed on git errors. Changed paths are relative to the project root: when the project sits below the repository top, paths outside it are ignored. |
| Merge gate (opt-in) | `mindplan-mcp check --merge` | Default checks plus the rule that the default branch holds only done (`stable` / `unstable`) or still-building (`draft`, `ready`, `in-progress`) work. A Foundation, Interaction, or Interface with a slot in `in-review` (each open revision on its own, under its change, else live; a leftover `mirror` file is not open), and a Bug in `in-review`, each fail with `Blocked: Merge: "<id>" (<type>, [revision ]<state>, change "<change>" \| no change): …` and the fix: `update_node_status({ scope: "change", change, new_status: "ship" })` (no change: `{ node_id, new_status: "ship" }`; a Bug: `"resolved"`), or move it back to `in-progress` (a Bug: `fixing`) if the work is unfinished. Lines are ordered by change id (nodes with none last), then node id. Retired nodes pass. Run it on pull requests to the default branch (`setup_project({ ci: "github" })`, below). |
| Strict merge gate (opt-in) | `mindplan-mcp check --merge=strict [--base <ref>]` | Merge gate plus `Blocked: Merge (strict): …` for each `in-progress` active slot whose claims cover a path changed against the base (`<base>...HEAD` plus the working tree, deletions included), listing up to five paths. The base is `--base`, else the merge base of `HEAD` with the default branch: `main` (else `master`), using the newer of the local branch and `origin/<branch>` when both exist, so a local branch that was never pulled cannot count already-merged commits; with neither (or outside git) the check fails with `Blocked: Merge (strict): no git base …`. Opt-in because it blocks the incremental PRs of a large feature. An explicit `--base` also runs dirty-src (above); both share one git probe, and a failed probe is reported once. `--merge` and `--merge=strict` together are `Blocked:`. |
| After merge (opt-in) | `mindplan-mcp check --after-merge` | Default checks plus what a git merge of two branches that both changed `mindplan/` can leave behind, each a `Blocked: after-merge: …` line naming its fix: git conflict markers in a file under `mindplan/` (file and line); a node id in two folders; a decision id recorded in two files of one node (re-record one with `supersedes`); a revision file that does not parse; a tracked `mindplan/map.md` (`git rm --cached`, list it in `mindplan/.gitignore`); a `mindplan/version.json` that is missing, unreadable, or behind the graph (`upgrade_project`), or newer than this server (install the `mindplan-mcp` version it names). The file-level findings run even when the graph fails to load, so whatever broke the load is named. An open revision whose `base` no longer matches live (live moved on the other branch) is a `Warning: after-merge: …` naming `rebase_revision({ node_id, change })` and then `resolve_conflict`. Run it after merging a branch that changed the graph (§9.4). |
| Another checkout | `mindplan-mcp check --root <path>` | Any mode, on the checkout at `<path>` instead of `MINDPLAN_ROOT` / the working directory (the MCP tools take `root`, §8). |
| Version | any check mode | Before anything else: a graph whose status is not `current` (§1.1.2) fails with one `Blocked: Version — <warning>` line and no other check runs (off with `MINDPLAN_VERSION_GATE=off`) |
| Invalid config | any check mode | Fail immediately if `mindplan/config.json` exists but is invalid (bad JSON / shape / lingering `implementation_packages`) |

**Import fixes.** Every illegal-import failure ends with its fix: `Fix: link_nodes({"source_id":…,"target_id":…,"edge_type":…}).` when an edge would make it legal (`depends_on`, `exposes`, or `mounts`), or `not allowed: …` when none can (for example an Interaction importing an Interface).

**Imports over every claim.** The import matrix scans each universe file, and each file a non-retired node claims outside the universe (the in-review gate scans every claimed file, so the check must not pass what the gate Blocks), as every node that claims it — its live owner, each open revision that claims it, and a **released** live owner (a file an open revision dropped) — and resolves import targets through released claims too. A violation that only this wider scan finds (a released file, a target that is only released, or a file's second claimant) is reported as `Warning: imports (next slot): …` in this release so existing graphs keep passing; it becomes `Blocked:` in the next release.

**Description warnings.** For every non-retired node (its open revision's description while exactly one is open) the check prints `Warning: description: …` when the description is empty or repeats the title, is longer than 300 characters (descriptions are search rows; detail belongs in the body), is an Interaction's and names no actor (a loose word list: visitor, editor, owner, customer, admin, agent, …), or uses revision wording (`now`, `no longer`, `was changed to`, `used to`, `previously`, `anymore`) that belongs in the revision's body. They never fail the check.

**Warnings.** The check also prints `Warning:` lines that never change the exit code or `ok`. They flag territory text that no longer matches the repo, for nodes in review (`in-review`, or an open revision in review; nodes still being built are skipped, since they may name files not written yet): a body names a repo path in backticks that does not exist; a claimed file changed after the body was last updated; checkboxes are unticked. The same warnings come back on moves to `in-review` and `ship`, and `run_check` with `change` computes them for every member. The missing-path signal skips closed checklist items, which record what was done rather than claims about the current code: an item the Completion Check counts as done (`- [x] …`, with `— note:` or with `— n/a: <reason>`; an `— n/a:` with no reason is not closed), together with its continuation lines (indented lines, nested non-checkbox bullets, and lazy lines up to a blank line). For a shipped node with no open revision, whatever its state, the check warns `stale:` for a body path that does not exist and for each `added_claims` entry (§1.2, §6.1) the live body does not name verbatim; when one of its claimed files changed against the base (`--base`, else the default-branch merge base: the commits since it plus the working tree, from the probe dirty-src and the strict merge gate share), it gets every signal above, because the branch edited it in place. Without git or a base it gets the path signals only, and nothing reports the missing base. The check also warns about every decision-worthy open revision with no decision yet, at any pre-ship state (`Warning: decision: …`, §5.13), about next-slot imports (above), about a Foundation, Interaction, or Interface in review with no linked tests (`Warning: tests: "<id>" is in review with no linked tests; …`; for a revision, `… (revision "<c>"); link … with set_test_files({ node_id, change: "<c>", add: [...] })`, since `set_test_files` without `change` writes live), and about a **route family split** between owners (§1.2.3): `Warning: routes: route family "<dir>/" is split: "<id>" (Assembler) owns …; "<id>" (Interface) owns …`. It warns `shape: …` for each node whose active slot is `draft`, and each Bug before `in-review`, that misses a required section (§6.5).

**Info.** After the warnings the check prints `Info:` lines, which never change the exit code or `ok` and are not drift. A slot that is still a plan — `draft` or `ready`, with none of its claimed files on disk — names files it has not built, so its missing body paths are not `stale:`: they come back as one `Info: planned: "<id>" names N path(s) not on disk yet (…).` line per node. A path named on a line that says "at build time" is planned on every node. Unticked `review` and `deploy` items (§3.3) of live pre-ship nodes and open revisions come back as one line, grouped per node and revision: `Info: waiting on people: <id>[ (revision <change>)]: <item id or text> (<kind>), …; …`. `run_check` returns these lines as `info`. With `change`, each source of planned edges (§3.7) adds one `Info: planned edges: …` line, and a planned edge that is no longer legal is a `Blocked: change "<id>": planned edge …` failure. Presence also requires each `attributed` file (§3.7) on disk once the slot that holds it is in review.

The `run_check` tool (§8.1) returns this same output to agents with `compact: false`; by default it returns the compact form (counts, failures, new warnings with ids, info). Exit code `0` on success, `1` with `Blocked: …` lines on failure. This repo’s CI builds from source and runs default `node dist/index.js check` only (graph + file ownership). Consumer repos SHOULD use the published bin after npm release.

**CI merge gate.** `setup_project({ ci: "github" })` (§8.2) installs `.github/workflows/mindplan-merge-gate.yml` at the repository top, where GitHub reads workflows (outside git: under the project root), from template `templates/ci/github/mindplan-merge-gate.yml`. Its steps run in the project root (`defaults.run.working-directory`, `.` when the project is the repository top): on `pull_request`, a job named `mindplan merge gate`, run only when the PR targets the repository's default branch, runs `npx -y mindplan-mcp@<major.minor> check --merge` (the version that installed it). The file is repo-owned: an existing one is kept as it is. A repository SHOULD make the job a required status check on the default branch; without that, a red gate does not stop a merge. No workflow is installed without `--ci`.

Plan and ship handoff (§3.7) require the graph to match the implementation, then this default check, before self-`ready`, `in-review`, `ship` / `resolved`, or claiming the session is done. When the implementation is done and a merge is requested, `ship` the node. The check command does not run a host typechecker.

### 9.7 Server startup and exit

- **Initialize first.** Nothing before the MCP `initialize` reply reads the graph: no graph load, migration check, search index, or model load, so the reply takes only the time to import the modules, whatever the graph's size. The background search warm-up (§8.1.1) starts on the client's `initialized` notification, on a later turn of the event loop, and tool calls never wait on it.
- **Logged exits.** stdout carries only the protocol; the server logs to stderr. An uncaught exception or unhandled rejection anywhere (the warm-up included) writes `mindplan-mcp: fatal: <message>` and its stack, then exits 1. The server writes `mindplan-mcp: exiting (<reason>)` when stdin closes (exit 0 at once when the client leaves before `initialize`) and on `SIGINT` / `SIGTERM` (exit 0).
- **Diagnosis.** `doctor` (§8.1) reports the version, root, graph state, load time, caches, start time, and uptime from a tool call, in every graph state.

---

## 10. External UI Synchronization (GitOps Integration)

MindPlan supports one-way mirroring into standard project-management platforms (Jira, Linear, GitHub Projects) so stakeholders retain their dashboards without reintroducing drift.

### 10.1 Principles

1. **Execution in Git.** Developers and agents work entirely within the IDE: states move via MCP tools, Atomic Ops are checked off in Markdown. The repository is the write side.
2. **Read-only UI mirror.** The external board is a projection. Humans MUST NOT move tickets there; any manual board change is overwritten by the next sync. This is what eliminates "Jira Drift" — there is nothing to drift *from*, because the board has no authority.

### 10.2 Sync pipeline

On every merge to the main branch (or on a schedule), a CI step runs a lightweight parser that:

1. scans territory frontmatter for node states and outgoing edge arrays;
2. expands edge arrays into flat edge triples;
3. reads each node's `<id>.mdx` checklist (and, informationally, each open revision's checklist) to compute completion percentages;
4. fires idempotent API payloads to the external tracker: create missing tickets (keyed by node `id`), move tickets to the column mapped from the node state, update checklist progress as a comment or custom field.

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
| Capability `incubation`/`evolving`/`stable` | Epic status field |

### 10.3 Implementation status

The sync parser is deliberately outside the MCP server (it is a CI concern, not an agent concern) and is **not included** in the reference implementation. The stable interfaces it consumes — §6.1 (frontmatter + checklist syntax) and §7 (graph assembly) — are the compatibility contract for building one.

---

## 11. Compliance Checklist

An implementation is MindPlan-compliant if and only if:

- [ ] All state lives under `mindplan/` per §1.1; no external database.
- [ ] Build taxonomy (Capability, Interaction, Interface, Foundation) + defect layer and all five edge types are enforced per §2.
- [ ] Build pipeline, Bug lifecycle, and computed `stable`/`unstable` are enforced per §3.
- [ ] The stable-id revision model (`open_next` / `revisions/<change>/` / ship with rebase / `resolve_conflict` / `discard_next`, gates judging live plus one change) is enforced per §3.6, with no version-lineage edge and no dependent relinking.
- [ ] Capability states are computed from member Interactions, never settable, per §4 (including open-revision activity); Bugs and Interfaces do not affect Capabilities.
- [ ] Rules 1–11 are enforced pre-write, fail-fast, per §5 (including Interaction Independence, Behavior First, no Dependency Closure; Rule 10 as `open_next`/revision ship and rebase/`discard_next`; Rule 11 as `force_unship`).
- [ ] Every rejection message starts with `Blocked: ` per §5.1.
- [ ] `<id>.mdx` and revision-file frontmatter is server-mirrored per §6 (state, edge arrays, revision deltas); decisions are one file each (§6.1.2).
- [ ] The MDX component contract holds per §6.4: reserved names respected, project components opaque, no guardrail parses JSX.
- [ ] Edges persist in source-node `<id>.mdx` frontmatter and assemble at runtime per §7; a revision's edge deltas are not live graph edges.
- [ ] The thirty-seven-tool MCP surface matches §8 (names, inputs, outputs, errors), including `setup_project`, `upgrade_project`, `get_skill`, the version gate (§1.1.2), Interaction `reachability` on blast radius / orient, orient `depth`, `get_project` (with `check`), `get_rules`, `run_check`, node `rules` on orient and context, `rules_impact` on blast radius, `patch_node_rules`, `record_decision` / `list_decisions` and the `decisions` outputs, small writes with `verbose`, section/`replace` patches, scoped `update_node_status` with `dry_run`, `resolve_conflict`, `rebase_revision`, `acknowledge_warning`, `doctor`, `root` on every tool, compact `run_check` with `after_merge`, and `change` on every tool that reads or writes a revision.
- [ ] Mutations are deterministic and atomic per §9.
- [ ] Symbol-level mapping inside a file is absent (§1.4) — ownership is `implements` claims (files or directories ending in `/`), not a prescribed `src/<type>/<id>/` tree.

---

## Appendix A — Canonical error catalog

| Rule | Example message |
|---|---|
| Unknown node | `Blocked: node "i-x" does not exist in mindplan territory.` |
| Duplicate node | `Blocked: node "i-checkout" already exists.` |
| Illegal edge shape | `Blocked: belongs_to edges must go Interaction -> Capability. Got Foundation "f-db" -> Capability "c-ordering".` |
| Capability dependency | `Blocked: a Capability cannot depend on a Foundation. Capabilities are permanent containers with no direct code execution.` |
| Duplicate edge | `Blocked: edge i-checkout -depends_on-> f-db already exists.` |
| Manual Capability state | `Blocked: Capability states are computed automatically from their Interactions and cannot be set manually.` |
| Manual stability | `Blocked: stable/unstable are computed from open Bugs and cannot be set manually. Use ship from in-review.` |
| Invalid state name | `Blocked: "active" is not a valid state. Valid build states: draft -> ready -> in-progress -> in-review -> ship -> stable/unstable -> deprecated.` |
| Illegal transition | `Blocked: illegal transition "in-progress" -> "stable" for node "i-tips". Allowed from "in-progress": in-review, ready.` |
| Rule 1 (Ghost Interaction) | `Blocked: Ghost Interaction. "i-checkout" has no belongs_to edge to a Capability. Link it with link_nodes before moving it to "ready".` |
| Rule 1 (Ghost Interaction, no Foundation) | `Blocked: Ghost Interaction. "i-checkout" has no depends_on edge to a Foundation. Link it with link_nodes before moving it to "ready".` |
| Rule 2 (Ghost Interface) | `Blocked: Ghost Interface. "if-checkout-page" has no exposes edge to an Interaction. Link it with link_nodes before moving it to "ready".` |
| Rule 3 (Infra First) | `Blocked: Infrastructure First. Interaction "i-checkout" cannot ship while linked Foundations are not stable: "f-db" (in-review). A dependency counts once stable, or in-review with every build item ticked.` |
| Rule 4 (Behavior First) | `Blocked: Behavior First. Interface "if-checkout-page" cannot ship while exposed Interactions are not stable: "i-checkout" (in-progress).` |
| Interaction Independence | `Blocked: Interaction Independence. Interactions must not depend_on each other. Share state through a Foundation instead. Got Interaction "i-a" -> Interaction "i-b".` |
| Dependency cycle | `Blocked: depends_on edge f-a -> f-b would create a dependency cycle.` |
| Cycle across changes | `Blocked: depends_on "f-a" -> "f-b" (change "pay") would close a dependency cycle across changes "pay", "tax": f-a -> f-b -> f-a. The changes could never ship in any order; move the shared part into a Foundation both depend on.` |
| open_next: not shipped | `Blocked: only shipped Foundations/Interactions/Interfaces (stable or unstable) open revisions. "i-checkout" is currently "in-progress".` |
| open_next: no change | `Blocked: open_next needs change: every revision of a shipped node belongs to one change id (a slug, e.g. "add-export"). Retry with open_next({ node_id: "i-checkout", change: "<change-id>" }).` |
| open_next: already open | `Blocked: "i-checkout" already has an open revision of change "split-pay". Edit it (pass change: "split-pay"), ship it, or discard_next({ node_id: "i-checkout", change: "split-pay" }).` |
| Several revisions, no change | `Blocked: "i-checkout" has open revisions "split-pay", "tips"; pass change.` |
| ship: revision not in-review | `Blocked: ship is only allowed from next in-review. "i-checkout" next is currently "in-progress".` |
| Rebase conflict | `Blocked: revision "tips" of "i-checkout" holds unresolved conflicts (section:## Spec) left by a sibling revision that shipped; it cannot move to in-review. Resolve each with resolve_conflict({ node_id: "i-checkout", change: "tips", section: "## Spec", take: "revision" \| "live" \| "text" }), then retry.` |
| discard_next: nothing to discard | `Blocked: node "i-checkout" has no open revision to discard (a leftover mirror file is not a revision; upgrade_project removes it).` |
| force_unship with revisions | `Blocked: "i-checkout" has open revisions ("tips"); ship or discard_next each before force_unship.` |
| Claims replace | `Blocked: set_implementation_files files replaces the whole list only with replace: true. Pass add / remove to change entries (add is the default), or files with replace: true.` |
| Rule 5 (Completion) | `Blocked: Completion Check. 3 unchecked checkbox(es) remain in i-checkout/<id>.mdx. All [ ] items must be [x] before moving to "ship".` |
| Impact section | `Blocked: Minimum Territory Shape. "if-checkout-page"/<id>.mdx section "## Impact" is empty or a stub. Write what this node adapted so the already-shipped contract still holds.` |
| Batch with no move | `Blocked: no item of this batch could move; nothing was written.` followed by one `- "<id>" -> <status>: <reason>` line per item, then the change hints |
| Change hint | (last line of a Blocked move of a change member) `To move the whole change: update_node_status({ scope: "change", change: "pay", new_status: "ship", skip_review: true })` |
| Not a member | `Blocked: "i-tax" is not a member of change "pay"; its members: "f-ledger", "i-pay".` |
| Rule 6 (Ghost Bug) | `Blocked: Ghost Bug. "bug-race" has no affects edge. Link it to an Interaction, Interface, or Foundation before moving it to "triaged".` |
| Stability flip | (informational) `stability_recomputed: [{ "id": "i-checkout", "state": "unstable" }]` in tool response |
| No edge to remove | `Blocked: no edge exists between "i-tips" and "f-db".` |
| Shipped scope freeze | `Blocked: Use open_next for material scope changes on live work.` |
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
| Root without a graph | `Blocked: root "D:/work/feature-x" has no mindplan/ folder` |
| Root not a directory | `Blocked: root "D:/work/feature-y" is not an existing directory` |
| After merge | `Blocked: after-merge: node id "i-pay" is in 2 folders (…). Keep one: merge what the others hold into it and delete them.` |
| Supersede out of reach | `Blocked: "d-soft-delete" is held by "i-cancel", which "i-reschedule" does not inherit decisions from. …` |

## Appendix B — Reference lifecycle walkthrough

```
create_node(c-ordering, Capability)              → c-ordering: draft (computed)
create_node(f-db, Foundation)                 → f-db: draft
create_node(i-checkout, Interaction)          → i-checkout: draft
create_node(if-checkout-page, Interface)      → if-checkout-page: draft
update_node_status(i-checkout, ready)         → Blocked: Ghost Interaction (no Capability link)
link_nodes(i-checkout, c-ordering, belongs_to)
link_nodes(i-checkout, f-db, depends_on)
update_node_status(i-checkout, ready)         → ok
update_node_status(i-checkout, in-progress)   → ok; c-ordering → incubation
… agent implements Interaction, checks off Atomic Ops …
update_node_status(i-checkout, in-review)     → ok (all [x])
update_node_status(i-checkout, ship)          → Blocked: Infrastructure First (f-db is in-review)
… f-db: draft → ready → in-progress → in-review → ship → stable …
update_node_status(i-checkout, ship)          → ok; i-checkout: stable; c-ordering → stable

link_nodes(if-checkout-page, i-checkout, exposes)
update_node_status(if-checkout-page, ready)   → ok (exposes present)
… implement Interface package …
update_node_status(if-checkout-page, in-review) → ok
update_node_status(if-checkout-page, ship)    → ok (Behavior First: i-checkout stable)

create_node(bug-race, Bug)                    → bug-race: open
update_node_status(bug-race, triaged)         → Blocked: Ghost Bug (no affects edge)
link_nodes(bug-race, i-checkout, affects)     → i-checkout: unstable (stability recomputed)
update_node_status(bug-race, triaged)         → ok; c-ordering unchanged (still stable)
… fix bug, check off Fix Checklist …
update_node_status(bug-race, resolved)        → ok; i-checkout: stable

link_nodes(i-a, i-b, depends_on)              → Blocked: Interaction Independence
link_nodes(i-checkout, i-tip, leads_to)       → ok (navigation; not a gate)

… months later, checkout gains split-payment support (same id, no new node) …
open_next(i-checkout, change: split-pay)       → i-checkout: still stable (<id>.mdx untouched); revisions/split-pay/<id>.mdx created in draft
open_next(i-checkout, change: tips)            → a second revision, revisions/tips/<id>.mdx, in draft; each judged against live plus itself
update_node_status(i-checkout, ready, change: split-pay)  → revision split-pay → ready (tips untouched)
update_node_status(i-checkout, in-progress, change: split-pay) → split-pay → in-progress; c-ordering → evolving
… agent implements, checks off Atomic Ops in revisions/split-pay/<id>.mdx …
update_node_status(i-checkout, in-review, change: split-pay) → ok (all [x] in the revision)
update_node_status(i-checkout, ship, change: split-pay)      → ok; live ⊕ split-pay written to <id>.mdx (same id "i-checkout");
                                                  revisions/split-pay/ deleted; tips rebased: rebased: [{ change: "tips", conflicts: ["section:## PRD"] }];
                                                  i-checkout: stable; c-ordering → stable
resolve_conflict(i-checkout, change: tips, section: "## PRD", take: "text", text: …) → conflicts: []; tips may now move to in-review
```
