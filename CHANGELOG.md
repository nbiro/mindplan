# Changelog

## 0.7.0 — summary-first orientation and the write gate

Every behavior change in this release. SPEC sections in brackets.

- **`orient_for_work` returns summaries first.** A query alone returns ranked rows: `{ id, type, state, title, description (70 characters), area?, score }`, 8 by default. There is no body, neighborhood, blast radius, rules, or decisions, and 10 rows stay under 2 KB. When the top row is a clear winner (the query is its exact id, it is the only match, or it scores at least twice the next row), the full node comes back with the rows, marked `auto_focus: true`. `orient_for_work({ node_id })` returns the full node: record, body, rules, own decisions, owned files (`files`), and the blast radius at `depth: "full"`. **Breaking:** a client that read `context`, `rules`, or `blast_radius` from a query-only reply must pass `node_id` or check `auto_focus`. [§8.1]
- **Write gate.** A write that acts on a node is `Blocked: Orientation` until that node got a full reply in this MCP session, and again after the rules that reach it change. A full reply comes from `orient_for_work` with `node_id` or `auto_focus`, `get_node_context`, the node's own `create_node`, or a link that changed its rules. The block names the fixing call. Gated tools: `set_implementation_files`, `set_test_files`, `update_node_status`, `patch_node_territory`, `patch_node_rules`, `open_next`, `record_decision`, `link_nodes` / `unlink_nodes` (on the source). `put_attachment`, `remove_attachment`, and `force_unship` are gated too. `create_node` is never blocked, and while the gate is on its result carries `rules`. `get_node_context` now returns `resolved_rules` (every rule that reaches the node). The rules shown and fingerprinted include those that an open revision's proposed edges bring. The CLI is never gated, and `MINDPLAN_ORIENT_GATE=off` turns the gate off for a server process. [§8.1.2]
- **`find_related_nodes`** matches gain an `area` field (Journey titles).
- **New Foundation `f-orientation-ledger`** holds the per-session record and its rules fingerprints.
- **Docs.** Playbook step 1 is now orient with a query, pick a row, `orient_for_work({ node_id })`, act. The plan-project skill, SPEC, and README match, and the `npx` examples use `mindplan-mcp@0.7`.

## 0.6.0 — rules version tags

Every behavior change in this release. SPEC sections in brackets.

- **`get_rules` returns `rules_version`.** The tag is the first 12 hex characters of the SHA-256 of the rules. Pass the last tag you saw as `known_version`: when the rules are unchanged, the reply is `{ path, rules_version, unchanged: true }` with no text (78 bytes in the test, against about 1.5k tokens for this repo's rules). Any other value, or none, returns the full text, so a client that passes nothing sees no change. [§8.1]
- **`get_project` returns `rules_version`** too, so the first `get_rules` of a session can already be the short form. [§8.1]
- **Node rules in `orient_for_work`.** Each `rules` entry carries `version`. `known_rules_versions` (node id → version) leaves out the text of entries the caller already holds, which come back with `unchanged: true`. [§8.1]
- **Docs.** Playbook rule 1, the `AGENTS.md` stub that init installs, the tool descriptions, SPEC, and README describe the short form. The `npx` examples use `mindplan-mcp@0.6`.

## 0.5.0 — own decisions by default

Every behavior change in this release. SPEC sections in brackets.

- **`orient_for_work` returns the focus node's own decisions.** `decisions.entries` now holds only the decisions recorded on the focus (`via: self`; a Bug: those of the nodes it affects directly). `decisions.inherited_decisions: { count, nodes }` names the Journeys and Foundations whose decisions also reach it. `include_inherited_decisions: true` adds `inherited_decisions.entries`: whole records at distance 1 (compact at `depth: "rules"`) and one line `{ id, node_id, distance, decision }` beyond. On a node shaped like a real 54-node graph's contact form, the default reply carries one decision instead of thirteen. **Breaking:** a client that read inherited decisions from `decisions.entries` must pass the flag and read `inherited_decisions.entries`. [§8.1]
- **`get_node_context`** adds `inherited_decisions` (the same summary) and takes `include_inherited_decisions`. [§8.1]
- **`get_blast_radius`** returns the focus's own decisions plus `dependent_decisions: { count, nodes }`; `include_dependent_decisions: true` adds the dependents' one-line rows as before. The radius `orient_for_work` embeds at `depth: "full"` is the default one. The change radius counts each non-member holder once. [§8.1]
- **Unchanged:** the decision gate at `in-review`, `list_decisions`, and supersession.
- **Docs.** Playbook rule 10 names `inherited_decisions` and the flag; the README tool table and the `npx` examples (`mindplan-mcp@0.5`) are updated.

## 0.4.0 — semantic search

Every behavior change in this release. SPEC sections in brackets.

- **Hybrid ranking.** `find_related_nodes` and `orient_for_work` rank with keyword search (SQLite FTS5 `bm25`, porter stemming) and semantic search (cosine over local embeddings) merged by reciprocal rank fusion, plus a one-rank-step boost for nodes linked to the top 3. An exact id is always first, and a file path ranks the node that claims it. The indexed text per node is its type, title, description, area (Journey titles), entry points (exposing Interfaces), and section headings, from the open `next` slot while a revision is open; ids and claimed paths are indexed as words. The `RankedMatch` shape is unchanged; `score` is now the fused score, comparable only within one reply. On the repo's search test set (48 English queries over a 63-node site-builder graph and this repo's graph), the top hit is right 81% of the time (was 46%), and MRR is 0.87 (was 0.58). [§8.1, §8.1.1]
- **Search cache.** A derived cache in `.mindplan-cache/index.db` (Node's built-in `node:sqlite`) holds node rows, the FTS5 index, one vector per node, and edges. The `.mdx` files stay the only source of truth: every search re-syncs the cache from the loaded graph, so a `git pull` or branch switch is searchable on the next call; writes re-sync it and embed only what changed. It is gitignored (by its own `.gitignore`, and `init` now adds `.mindplan-cache/` to the repo's `.gitignore`), never in `changed_files`, never in the coverage universe, and safe to delete. [§1.1, §8.1.1]
- **Local embedding model.** `Xenova/bge-small-en-v1.5` through `@huggingface/transformers`, now an optional dependency. It downloads once per machine (about 30 MB) into `~/.cache/mindplan/models` and loads in the background at server start; a tool call never waits for it. Until it is ready, or when it cannot load, search is keyword-only and never fails. Where SQLite has no FTS5 (Node 22.13's bundled build), the keyword half is the same BM25 in plain JS, which scores the test set as FTS5 does. `MINDPLAN_SEARCH=keyword`, `MINDPLAN_SEARCH_OFFLINE=1`, and `MINDPLAN_MODEL_CACHE` tune it per process. [§8.1.1]
- **`search` settings.** `mindplan/config.json` takes `search: { enabled?, model? }`, written by `patch_config({ search })`; `enabled: false` turns semantic ranking off, and a new `model` rebuilds the cache. [§1.2.1, §8.2]
- **Node 22.13 or later.** `engines.node` is now `>=22.13`, the first 22.x release where `node:sqlite` needs no flag. Node 18 and 20 are no longer supported; CI runs 22.13, 22, and 24. In MCP mode every console method writes to stderr, so no dependency can write to the stdio channel.
- **Docs.** README has a Search section; the `npx` examples use `mindplan-mcp@0.4`.

## 0.3.0 — linked tests

Every behavior change in this release. SPEC sections in brackets.

- **`tests` on nodes.** A Foundation, Interaction, or Interface can list the test files, directories ending in `/`, or globs that verify it, in a new optional `tests` frontmatter list. It is not ownership: the files are still claimed through `implements`, and several nodes may list one suite. The list is slot-independent like `## Rules`: it sits on live and on an open `next` alike, promotion keeps it, and discard leaves live as it is. `GRAPH_VERSION` stays `1`; a graph without it loads as before. [§6.1, §6.2]
- **`set_test_files`.** A new write tool (twenty-eight in all) replaces a node's `tests` list. It never needs `open_next`, never resets readiness, re-syncs the mirror twin, and takes `change` like the other in-place writes (a neighbor label on a shipped node with no open `next`). Journeys, Bugs, retired nodes, and bad paths are Blocked. [§8.2]
- **Presence and the untested warning.** A `tests` entry that matches nothing on disk fails the check (`presence`) and the move to `in-review` or `ship` once its node is in review or shipped; a draft plan may link tests it has not written yet. A revision in review with no linked tests prints `Warning: tests: …`, which never fails the check. [§9.6]
- **Tests to run.** `get_blast_radius` returns `tests`: the expanded linked tests of the focus and every owner in `affected_files`; the change radius merges its members'. Node records carry `tests`. [§8.1]
- **Docs.** The playbook's handoff step links the tests that verify a node before `in-review`; the README tool table lists `set_test_files`.

## 0.2.3 — repin PR wording

- **Where the repin PR's CI shows.** The 0.2.2 release opened the first repin PR, and the CI dispatched on its branch ran green. That run shows under Actions → CI for the branch, not as checks on the PR. GitHub does create the PR's own `pull_request` run, but it waits for a maintainer's approval. The 0.2.2 notes said a GitHub Actions PR starts no `pull_request` run at all, which was wrong. The repin PR's body, the workflow comments, and CONTRIBUTING now say what actually happens. Release tooling only; the published package is unchanged.

## 0.2.2 — repin the self-dependency after each release

- **Repin PR from the release workflow.** The Publish workflow has a new `repin` job. It runs right after a successful publish and tag, and opens a PR that pins this repo's exact `mindplan-mcp` devDependency to the new release (bumping no version, so merging it publishes nothing). It then dispatches CI on that branch, because a PR opened by GitHub Actions starts no `pull_request` run. CI gains a `workflow_dispatch` trigger for this. The Dependabot config added in 0.2.1 is removed: it checked at most daily. Needs the repository setting that allows GitHub Actions to create pull requests. Release tooling only; the published package is unchanged.

## 0.2.1 — publish waits for the registry

- **Registry check.** After `npm publish`, the release script now waits up to 10 minutes (polling every 15 seconds) for npm to list the new version, instead of about one minute. npm accepts a publish before it lists it, and the 0.2.0 release job failed its check after a successful publish, which skipped the `v0.2.0` tag. CONTRIBUTING documents pushing the tag by hand when that happens.

## 0.2.0 — shipped claims and change neighbors

Every behavior change in this release. SPEC sections in brackets.

- **Additive claims on shipped nodes.** `set_implementation_files` on a shipped node with no open `next` (with or without `slot: "current"`) now writes the live list in place when the change is additive: every old entry is kept or covered by a new directory entry, and each new entry is a file whose parent folder the node dominates (it already claims a file there and no other non-retired node claims or covers anything under it) or a directory over such a folder. Removing, moving, globs, and claims outside a dominated folder still need `open_next`, and so does any migration or schema file (config `decisions.schema_files`): an exact file that matches, or a folder entry over a schema folder or holding a matching file. Such a claim is decision-worthy, and only a revision reaches the decision gate. The write re-syncs the mirror twin and returns `added_in_place` and a `hint`. A new file that belongs beside a neighbor's own files no longer has to go into some other folder the node claims as a directory. The Coverage fix for a file in a folder its shipped owner dominates is the claim alone, without `open_next`, unless the file is a migration or schema file. [§1.2, §1.2.1, §3.7, §8.2]
- **`added_claims`.** Entries added in place are listed in the live file's `added_claims` frontmatter. `run_check` warns `stale:` for each one the body does not name as a whole path (`src/a.ts` is not named by `src/a.tsx`, and `src/a/` is not named by `src/a/b.ts`), a territory patch that names it removes it, and promotion of a `next` drops the list. [§6.1, §6.2, §9.6]
- **Folder-claim hint.** Any `set_implementation_files` result may carry `folder_claims: [{ folder, files, note }]` when every file under a folder is already one of the node's per-file claims and nobody else claims under it. [§8.2]
- **Neighbors join a change.** On a shipped node with no open `next`, `patch_node_territory`, `record_decision`, and `set_implementation_files` (new `change` param) accept `change` and write it as the node's neighbor label on the live file; results report `neighbor_of`, and `replaced_change` when the label replaces another (`""` clears). `change_ref` on a neighbor is Blocked; title, description, and role on a shipped live slot stay Blocked. On an open revision or pre-ship node, `set_implementation_files`'s `change` sets the slot's change id. `open_next` on a labeled node inherits the label as the revision's change unless it passes another, which clears the live label, and so does moving the open revision's change id later (`patch_node_territory` or `set_implementation_files` on the next slot; result reports `replaced_change`); `force_unship` and deprecation clear it too. `record_decision` on a neighbor without `change` records the decision under the neighbor's label. [§3.7, §6.2, §8.1, §8.2]
- **Members include neighbors.** A change's members are its revisions plus its labeled neighbors. `run_check({ change })` runs the import, ownership, and stale-text rules on neighbors too and lists members with `kind: "revision" | "neighbor"`; decision warnings stay revision-only. `get_blast_radius({ change })` merges neighbors' radius and files. `update_node_status` `scope: "change"` walks revisions only. A neighbor-only change has members, so it is no longer Blocked as empty. [§3.7, §8.1, §8.2]
- **Labels clear with the change.** When a write leaves a change with no revisions that had one before it (its last revision ships, is cancelled, or is discarded with `discard_next`, or has its change id moved or cleared), the server clears that change's neighbor labels once, after the write, and reports `cleared_neighbors`. A batch or scoped walk does this once for the whole call. A neighbor-only change is closed by a `scope: "change"` walk to `ship`. [§3.7, §8.2]
- **Docs.** The playbook tells agents to pass `change` on a neighbor's in-place writes and that a new file beside a node's own, in a folder nobody else claims into, is claimed in place; the `plan-project` and `define-entities` skills and the README tool table say the same. [§3.7]

## 0.1.0 — npm release and version stamp

Every behavior change in this release. SPEC sections in brackets.

- **Install from npm.** `mindplan-mcp` publishes to the public registry. A project with a `package.json` adds it as a dev dependency and registers `npx mindplan-mcp`; any other project registers `npx -y mindplan-mcp@<range>`. `mcp.json.example` and every integration guide now use `npx`. `npm run publish:release` (by hand, first claim) and `.github/workflows/publish.yml` (every merge to `main` that bumps `package.json` `version`, OIDC Trusted Publishing, then a `vX.Y.Z` tag) share one publish script.
- **Version stamp.** `mindplan-mcp init` writes `mindplan/version.json` (`{ package, graph }`). When the stamp is missing, unreadable, or older than the running server, `get_project` returns a `version` warning and `check` prints `Warning: version: …`; neither fails. Rerunning init rewrites the package-owned agent files (playbook, skills, integrations, MCP example, host skill copies, Cursor rule) without `--force` and leaves `AGENTS.md`, `CLAUDE.md`, `.cursorignore`, `.cursor/permissions.json`, and `project.md` alone. A stamp newer than the server warns too, and init refuses it without `--force`. **Upgrade step:** existing projects have no stamp, so they see the warning until they rerun `mindplan-mcp init` once. [§1.1.2, §8.1, §9.6]

## 0.1.0 — MCP audit fixes

Every behavior change in this release. SPEC sections in brackets.

- **Tool annotations.** Every tool now carries MCP `annotations` derived from one kind: read tools `readOnlyHint: true` (and `idempotentHint: true`), `unlink_nodes` / `remove_attachment` / `discard_next` / `force_unship` `destructiveHint: true`, every other tool a plain write; `openWorldHint` is always `false`. Hosts that auto-approve read-only tools stop prompting on `get_rules` and `orient_for_work`, and prompt on the destructive four. [§8]
- **Result envelope.** Successful results are compact JSON text (no indentation) plus a `structuredContent` mirror for object payloads; error results are unchanged. No `outputSchema` is declared. **Breaking** only for a client that compared the pretty-printed text byte for byte: parse it instead. [§8]
- **Descriptions describe the tool.** The "Follow the plan-project skill" routing left the fourteen graph-write descriptions and lives once in the server `instructions`, which now names the graph writes the skill covers. `force_unship` keeps its `confirm` token contract and drops the DANGEROUS prose; `destructiveHint` tells the host to prompt. [§8]
- **Version from package.json.** `initialize` reports the package's `version` field; `server.ts` holds no literal. An unreadable package.json yields `0.0.0` with a stderr note. [§8]
- **Paged graph.** `get_mindplan_graph` takes `offset` and `limit` (default 200, max 500) and returns `total_nodes`, `total_edges`, `offset`, `limit`, and `next_offset` while nodes remain; `edges` holds the edges whose source is in the page. A graph that fits one page returns the whole graph plus the totals. [§8.1]
- **Bounded export.** `export_mindplan_view` takes `output` (repo-relative, inside the root, outside `mindplan/`) and then returns `written_to` instead of `diagram`; without `output`, a diagram over 80,000 characters is `Blocked:` with its size and the two fixes (`focus`, `output`). The CLI never applies the budget. [§8.1]

## 0.1.0 — decision records

Every behavior change in this release. SPEC sections in brackets.

- **Decision records.** A node carries decisions in a `## Decisions` section: id, the decision, the alternatives considered, why, optional consequences and `supersedes`, and the change id and date. `record_decision` is the only writer and only appends; body writes keep the section and Block a body that contains one. Decisions belong to a slot: while a shipped node evolves they go to its next file, ship with it, and are dropped by `discard_next`. Recording never resets readiness. [§6.1.2, §8.1]
- **Superseding, not editing.** A new decision with `supersedes` replaces an active one held by the same node, its Journeys, or its Foundations. Status is computed, not written into the old entry, so discarding the superseding revision makes the old decision active again; deprecating the superseding node does not. An id that a `supersedes` still names stays taken. `list_decisions` returns a node's, a change's, or the graph's decisions; superseded ones with `include_superseded`. [§6.1.2, §8.1]
- **Decisions reach the agent.** `orient_for_work` returns a `decisions` block next to `rules`, at every depth, inherited like rules and labeled by source; `get_node_context` returns `decisions` (and `next.decisions`) and its `body` no longer contains the section; `get_blast_radius` lists the active decisions of the focus and its dependents; `export_mindplan_view` takes `decisions: true` for per-node counts. [§8.1]
- **Decision gate (Rule 12).** An open revision is decision-worthy when it changes a shipped Foundation's contract, claims a new migration or schema file (including one the branch adds inside an already-claimed folder), has more dependents than `decisions.blast_radius`, or adds or removes a `depends_on` edge of a shipped node. Without a decision under its change id (recorded since the revision opened; `open_next` now writes `opened_at`) or on the node, `run_check` warns from draft on and a move to `in-review` is `Blocked: Decision` with the `record_decision` call. One decision under a change clears every member. A first build's initial edges are never gated, and inside git a first build's schema file counts only when the branch adds it. **Breaking:** a shipped Foundation's revision, or a first build that claims a schema file, now needs a recorded decision before `in-review`. [§5.13, §9.6]
- **Gate settings.** `mindplan/config.json` takes an optional `decisions: { blast_radius, schema_files }` (defaults `5` and database migration/schema globs); `patch_config` writes it and rejects an unknown key. [§1.2.1, §8.2]
- **Shared branch base.** The dirty-src check and the decision gate measure "this branch" from the same merge base (`main`, `origin/main`, `master`, `origin/master`). [§9.6]
- **Twenty-seven tools.** `record_decision` and `list_decisions` are new. The playbook gains one line on recording decisions. [§8]

## 0.1.0 — graph honesty

Every behavior change in this release. SPEC sections in brackets.

### The graph no longer says "fine" when it does not match the code

- **Readiness reset.** A contract write to a revision in `ready` moves it back to `draft`: `patch_node_territory` (title, description, role, body, section, replace, toggle_checkboxes), `set_implementation_files` (when the list changes), and `link_nodes` / `unlink_nodes` on the source. The reset lives in the territory store's contract writers, so `mindplan-mcp init`'s legacy claim migration also sends a `ready` node whose claims it rewrites back to `draft`. The result carries the new `state` / `next_state` and `readiness_reset: { slot, from, to, note }`. `patch_node_rules`, change-id writes, attachments, and writes to `draft` / `in-progress` / `in-review` slots never reset. [§3.1]
- **Coverage names the fix.** An unclaimed file inside the configured `sources` is `Blocked: Coverage: …` with the probable owner (longest shared claim prefix) and the exact `set_implementation_files` call, preceded by `open_next` for a shipped owner. A file two or more folders deep needs at least two shared folders before a probable owner is named. A retired node's claim no longer counts as coverage; such a file is still reported once, by the leftovers rule, so no graph gains a failure. [§1.2.1, §9.6]
- **Imports over next-slot and released claims.** The import matrix now scans every claimant of a file (live, next slot, released) and resolves targets through released claims. Violations only this wider scan finds print as `Warning: imports (next slot): …` in this release and **will Block in the next release**. [§9.6]
- **Scoped walks do not skip review.** `update_node_status` with `scope` to `ship` is Blocked when a selected node is not yet `in-review`, unless `skip_review: true`; with it the node still walks through `in-review` (gate included) and the result lists `skipped_review`. `dry_run` now lists every transition (one `id: from -> to` line per step), not one line per node. **Breaking:** callers that walked `in-progress` nodes straight to `ship` must walk to `in-review` first or pass `skip_review: true`. [§3.7, §8.2]

### Tool usability

- **Unambiguous checkbox toggles.** A `toggle_checkboxes` `contains` that matches several checkbox lines is Blocked and lists them, unless `all: true`. Matching still uses the whole line, marker included. The result returns `toggled`, the lines as written. **Breaking:** an ambiguous `contains` used to tick the first match silently. [§8.1]
- **Honest closing of an item.** `toggle_checkboxes` takes `note` (ticks and appends ` — note: …`) and `not_applicable` (ticks and appends ` — n/a: <reason>`). Both pass the Completion Check; an `— n/a:` with no reason counts as unchecked. Unticking strips the annotation. [§3.3, §5.6]

### Modeling

- **Change ids.** `create_node` and `open_next` take `change` / `change_ref`; `patch_node_territory` sets or clears them. `update_node_status` gains `scope: "change"`, `get_blast_radius` takes `change` (merged radius), and `run_check` takes `change` (in-review gate on every member; violations the global check already reports are not repeated). Shipping ends membership. Node records show `change` / `change_ref`. [§3.7]
- **Glob claims.** `implements` entries may use `*`, `**`, and `?` (`[` `]` stay literal). Globs expand to concrete files in the check, `get_node_implementation`, and path lookup; exclusivity stays per file. Glob expansions are cached for the length of one call. Directory and glob expansion now skip `.git/` and `node_modules/`. [§1.2]
- **Shared app routes.** SPEC defines route ownership in multi-template apps: the Assembler owns routes that dispatch to the active template; a template's entry point owns only its own routes. The check warns (`Warning: routes: …`) when one route family has more than one owner. Only `app/` folders with a root layout count as routers. [§1.2.3, §9.6]

### Docs

- SPEC, the bundled playbook, and the `define-entities` / `plan-project` skills describe all of the above.
