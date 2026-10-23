# Changelog

## Unreleased — npm release and version stamp

Every behavior change in this release. SPEC sections in brackets.

- **Install from npm.** `mindplan-mcp` publishes to the public registry. A project with a `package.json` adds it as a dev dependency and registers `npx mindplan-mcp`; any other project registers `npx -y mindplan-mcp@<range>`. `mcp.json.example` and every integration guide now use `npx`. `npm run publish:release` (by hand, first claim) and `.github/workflows/publish.yml` (every merge to `main` that bumps `package.json` `version`, OIDC Trusted Publishing, then a `vX.Y.Z` tag) share one publish script.
- **Version stamp.** `mindplan-mcp init` writes `mindplan/version.json` (`{ package, graph }`). When the stamp is missing, unreadable, or older than the running server, `get_project` returns a `version` warning and `check` prints `Warning: version: …`; neither fails. Rerunning init rewrites the package-owned agent files (playbook, skills, integrations, MCP example, host skill copies, Cursor rule) without `--force` and leaves `AGENTS.md`, `CLAUDE.md`, `.cursorignore`, `.cursor/permissions.json`, and `project.md` alone. A stamp newer than the server warns too, and init refuses it without `--force`. **Upgrade step:** existing projects have no stamp, so they see the warning until they rerun `mindplan-mcp init` once. [§1.1.2, §8.1, §9.6]

## Unreleased — MCP audit fixes

Every behavior change in this release. SPEC sections in brackets.

- **Tool annotations.** Every tool now carries MCP `annotations` derived from one kind: read tools `readOnlyHint: true` (and `idempotentHint: true`), `unlink_nodes` / `remove_attachment` / `discard_next` / `force_unship` `destructiveHint: true`, every other tool a plain write; `openWorldHint` is always `false`. Hosts that auto-approve read-only tools stop prompting on `get_rules` and `orient_for_work`, and prompt on the destructive four. [§8]
- **Result envelope.** Successful results are compact JSON text (no indentation) plus a `structuredContent` mirror for object payloads; error results are unchanged. No `outputSchema` is declared. **Breaking** only for a client that compared the pretty-printed text byte for byte: parse it instead. [§8]
- **Descriptions describe the tool.** The "Follow the plan-project skill" routing left the fourteen graph-write descriptions and lives once in the server `instructions`, which now names the graph writes the skill covers. `force_unship` keeps its `confirm` token contract and drops the DANGEROUS prose; `destructiveHint` tells the host to prompt. [§8]
- **Version from package.json.** `initialize` reports the package's `version` field; `server.ts` holds no literal. An unreadable package.json yields `0.0.0` with a stderr note. [§8]
- **Paged graph.** `get_mindplan_graph` takes `offset` and `limit` (default 200, max 500) and returns `total_nodes`, `total_edges`, `offset`, `limit`, and `next_offset` while nodes remain; `edges` holds the edges whose source is in the page. A graph that fits one page returns the whole graph plus the totals. [§8.1]
- **Bounded export.** `export_mindplan_view` takes `output` (repo-relative, inside the root, outside `mindplan/`) and then returns `written_to` instead of `diagram`; without `output`, a diagram over 80,000 characters is `Blocked:` with its size and the two fixes (`focus`, `output`). The CLI never applies the budget. [§8.1]

## Unreleased — decision records

Every behavior change in this release. SPEC sections in brackets.

- **Decision records.** A node carries decisions in a `## Decisions` section: id, the decision, the alternatives considered, why, optional consequences and `supersedes`, and the change id and date. `record_decision` is the only writer and only appends; body writes keep the section and Block a body that contains one. Decisions belong to a slot: while a shipped node evolves they go to its next file, ship with it, and are dropped by `discard_next`. Recording never resets readiness. [§6.1.2, §8.1]
- **Superseding, not editing.** A new decision with `supersedes` replaces an active one held by the same node, its Journeys, or its Foundations. Status is computed, not written into the old entry, so discarding the superseding revision makes the old decision active again; deprecating the superseding node does not. An id that a `supersedes` still names stays taken. `list_decisions` returns a node's, a change's, or the graph's decisions; superseded ones with `include_superseded`. [§6.1.2, §8.1]
- **Decisions reach the agent.** `orient_for_work` returns a `decisions` block next to `rules`, at every depth, inherited like rules and labeled by source; `get_node_context` returns `decisions` (and `next.decisions`) and its `body` no longer contains the section; `get_blast_radius` lists the active decisions of the focus and its dependents; `export_mindplan_view` takes `decisions: true` for per-node counts. [§8.1]
- **Decision gate (Rule 12).** An open revision is decision-worthy when it changes a shipped Foundation's contract, claims a new migration or schema file (including one the branch adds inside an already-claimed folder), has more dependents than `decisions.blast_radius`, or adds or removes a `depends_on` edge of a shipped node. Without a decision under its change id (recorded since the revision opened; `open_next` now writes `opened_at`) or on the node, `run_check` warns from draft on and a move to `in-review` is `Blocked: Decision` with the `record_decision` call. One decision under a change clears every member. A first build's initial edges are never gated, and inside git a first build's schema file counts only when the branch adds it. **Breaking:** a shipped Foundation's revision, or a first build that claims a schema file, now needs a recorded decision before `in-review`. [§5.13, §9.6]
- **Gate settings.** `mindplan/config.json` takes an optional `decisions: { blast_radius, schema_files }` (defaults `5` and database migration/schema globs); `patch_config` writes it and rejects an unknown key. [§1.2.1, §8.2]
- **Shared branch base.** The dirty-src check and the decision gate measure "this branch" from the same merge base (`main`, `origin/main`, `master`, `origin/master`). [§9.6]
- **Twenty-seven tools.** `record_decision` and `list_decisions` are new. The playbook gains one line on recording decisions. [§8]

## Unreleased — graph honesty

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
