# Project

## Description

Everything works great until it doesn’t. MindPlan draws the boundaries your agent won’t. The product is a persistent graph under `mindplan/`; the MCP server is the single write path to graph state. The systems dialect and this brief load through `get_project`.

## Rules

- `SPEC.md` is normative for this package.
- `GRAPH_VERSION` stays `1`. There is no consumer compatibility layer for the former Workflow-centric schema.
- Implementation language is TypeScript under `src/`.
- While developing, run only the suites that verify what you changed: `npm run test:files -- <paths>` with the linked tests `get_blast_radius({ change })` lists for the change. Before handing work off (`in-review`, `ship`, Bug `resolved`, or telling the user the work is done), run the full `npm test`; CI runs it on every PR.
- A new feature always starts on a new git branch from latest `main`. Fetch/update `main` first. Do not work on `main` or branch from a stale or feature branch.
- Before handing work off (`ready`, `in-review`, `ship`, Bug `resolved`, or telling the user the work is done), review the diff and fix every finding at medium severity or higher, then review again, until a pass has none. If a bugfix needs an architectural decision (new boundary, public contract, schema or graph-model change, or a choice between viable designs), stop and ask.
- After an MCP tool writes under `mindplan/`, list every `mindplan/` path in that call's `changed_files`.
- Use subagents when work can run in parallel: independent searches, reviews, or changes to separate files that do not wait on each other’s results. Do not use a subagent when there is nothing to run alongside it; do sequential or single-thread work directly.
- Release only when the published package changes. A PR bumps the `package.json` version (and `package-lock.json`) above the version npm already lists only when it changes what `mindplan-mcp` ships: `src/` (built to `dist/`), `templates/`, `README.md`, `SPEC.md`, `LICENSE`, or the `package.json` fields consumers get (`dependencies`, `bin`, `files`, `engines`). Merging that PR to `main` publishes a release: patch for fixes only, minor for new or changed behavior while the package is below 1.0. In the same PR, title the PR's `CHANGELOG.md` section with the new version, and when the release raises `MIGRATION_LEVEL`, run `upgrade_project` from the new build (restart the MCP server first) so `mindplan/version.json` carries the new level. A PR that changes only repo tooling (workflows, tests, the graph under `mindplan/`, `CONTRIBUTING.md`, devDependencies, npm scripts) bumps no version, adds no `CHANGELOG.md` section, and publishes nothing; the self-dependency repin below is one of these.
- The repo pins its own package as an exact devDependency (`"mindplan-mcp": "X.Y.Z"`, no range). After each successful release, the Publish workflow's `repin` job opens the repin PR (`repin/mindplan-mcp-X.Y.Z`) and dispatches CI on it; when that CI run is green, its `merge-repin` job merges the PR. A repin PR still open after its CI run finished needs a maintainer: fix the cause, or merge it by hand once CI is green. Do not bump the self-dependency by hand in other PRs, and do not add a version bump to the repin PR. If the repin job did not run or failed (for example, the publish job failed after publishing), re-run its failed jobs, or open the PR by hand from a new branch off `main` with `npm install --save-dev --save-exact mindplan-mcp@X.Y.Z`, changing nothing else.
