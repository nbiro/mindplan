# Project

## Description

Everything works great until it doesn’t. MindPlan draws the boundaries your agent won’t. The product is a persistent graph under `mindplan/`; the MCP server is the single write path to graph state. The systems dialect and this brief load through `get_project`.

## Rules

- `SPEC.md` is normative for this package.
- `GRAPH_VERSION` stays `1`. There is no consumer compatibility layer for the former Workflow-centric schema.
- Implementation language is TypeScript under `src/`.
- Verify changes with `npm test`.
- A new feature always starts on a new git branch from latest `main`. Fetch/update `main` first. Do not work on `main` or branch from a stale or feature branch.
- Before handing work off (`ready`, `in-review`, `ship`, Bug `resolved`, or telling the user the work is done), review the diff and fix every finding at medium severity or higher, then review again, until a pass has none. If a bugfix needs an architectural decision (new boundary, public contract, schema or graph-model change, or a choice between viable designs), stop and ask.
- After an MCP tool writes under `mindplan/`, list every `mindplan/` path in that call's `changed_files`.
- Use subagents when work can run in parallel: independent searches, reviews, or changes to separate files that do not wait on each other’s results. Do not use a subagent when there is nothing to run alongside it; do sequential or single-thread work directly.
- Every PR bumps the `package.json` version (and `package-lock.json`) above the version npm already lists, so each merge to `main` publishes a release: patch for fixes only, minor for new or changed behavior while the package is below 1.0. In the same PR, run `mindplan-mcp init` from the new build to restamp `mindplan/version.json`, title the PR's `CHANGELOG.md` section with the new version, and refresh the self devDependency (`"mindplan-mcp": "latest"`) with `npm update mindplan-mcp` so the lockfile pins the latest published release.
