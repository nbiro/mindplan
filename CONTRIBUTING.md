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
| `templates/agent/playbook.md` | Always-on SDLC execution process installed into consumer projects by `init` |
| `templates/agent/skills/define-entities/` | Entity-definition guide installed by `init` |
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

```bash
npm version patch   # or minor / major
npm publish
```

`prepublishOnly` builds `dist/` automatically. Do not commit `dist/` to git.

## Reporting issues

Open a GitHub issue with:

- What you expected (per SPEC.md if applicable)
- What happened (include `Blocked: ...` messages verbatim)
- Steps to reproduce
