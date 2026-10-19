# Changelog

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
