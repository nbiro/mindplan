# Contributing to MindPlan

Thanks for your interest in MindPlan. This repo contains the normative spec ([SPEC.md](SPEC.md)) and the reference MCP server (`src/`).

## Development setup

Requirements: Node.js 18+ and npm.

```bash
git clone https://github.com/nbiro/mindplan.git
cd mindplan
npm install
npm run build
npm test
```

`npm test` runs an end-to-end smoke test that exercises every MCP tool and compiler rule against a temporary sandbox.

## Project layout

| Path | Purpose |
|------|---------|
| `SPEC.md` | Framework specification — source of truth for behaviour |
| `templates/agent/playbook.md` | Always-on systems dialect installed into consumer projects by `init` |
| `templates/agent/project.md` | Project brief template copied to `mindplan/project.md` by `init` when missing |
| `templates/agent/skills/define-entities/` | Entity-definition guide installed by `init` |
| `templates/agent/skills/plan-project/` | Plan-only session guide installed by `init` |
| `templates/agent/integrations/` | Per-agent MCP setup guides installed by `init` |
| `src/` | TypeScript MCP server |
| `scripts/smoke.mjs` | Integration smoke test |
| `dist/` | Compiled output (gitignored; built at publish time) |

Planning data (`mindplan/`) lives in **consumer projects**, not in this repo. Consumer projects SHOULD commit `mindplan/` to version control.

## Making changes

1. Update `SPEC.md` first when changing framework behaviour.
2. Implement server changes in `src/` to match the spec.
3. Keep `templates/agent/` in sync with SPEC behaviour agents must follow.
4. Extend `scripts/smoke.mjs` when adding tools or compiler rules.
5. Run `npm run build && npm test` before opening a PR.

## Publishing (maintainers)

One script publishes, by hand or from CI: `src/interactions/i-npm-publish/publish.mjs` (`npm run publish:release`). It checks the package and a clean tree, runs `npm test`, asserts the tarball holds only `dist/`, `templates/`, `README.md`, `SPEC.md`, `LICENSE`, and `package.json`, publishes, and verifies the registry (and, by hand, a fresh `npx mindplan-mcp init`). Add `-- --dry-run` to run everything but the publish. Do not commit `dist/` to git.

**First publish (claims the name).** From a clean checkout of `main`:

```bash
npm login
npm run publish:release
```

Then bind npm Trusted Publishing on npmjs.com (package settings → Trusted Publisher → GitHub Actions): owner `nbiro`, repository `mindplan`, workflow `publish.yml`, environment `npm-publish`. Create the `npm-publish` environment in the GitHub repository settings, with required reviewers if you want an approval step. See `src/foundations/f-npm-registry/README.md`.

**Every later release: bump the version in the PR, then merge.**

```bash
npm version minor --no-git-tag-version   # or patch / major; 0.x: minor for breaking changes
```

On every push to `main`, `.github/workflows/publish.yml` checks whether `package.json`'s version is on npm. When it is not, it runs `npm run publish:release -- --ci` with OIDC (no `NPM_TOKEN`) and pushes the tag `vX.Y.Z`. A merge without a bump publishes nothing and never waits on the `npm-publish` environment. If a release fails after the merge, fix the cause and re-run the workflow (or run it by hand on `main`): the version is still unpublished, so it publishes then. The exception is a run whose `npm publish` succeeded but whose registry check failed (the script waits up to 10 minutes for npm to list the new version): the version is on npm, so a re-run publishes nothing and skips the tag step. Push the tag by hand on the merge commit instead: `git tag vX.Y.Z <merge sha>` and `git push origin refs/tags/vX.Y.Z`. A broken release is fixed by a new patch version, never by moving a tag.

**Versioning.** Until 1.0.0, a minor bump may break: list it in `CHANGELOG.md` with **Breaking** and what a project must do. Any change to the playbook, the skills, or the graph format reaches a project when it reruns `mindplan-mcp init`; `mindplan/version.json` makes `get_project` and `check` remind it.

## Reporting issues

Open a GitHub issue with:

- What you expected (per SPEC.md if applicable)
- What happened (include `Blocked: ...` messages verbatim)
- Steps to reproduce
