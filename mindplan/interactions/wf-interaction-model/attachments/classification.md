# Self-hosted graph classification (Stage 6)

Authoritative remapping for Workflow → Interaction-centric re-model.

## Become Foundations

| Old id | New id | Notes |
|--------|--------|-------|
| wf-console-shell | f-console-shell | Shared console shell substrate |
| wf-test-harness | f-test-harness | Infra — test harness |
| wf-framework-docs | f-framework-docs | Docs substrate; absorbs wf-agent-integrations |

When a Workflow becomes a Foundation: **delete all `belongs_to` edges** (Foundations cannot `belongs_to` Journeys). Keep Foundation→Foundation `depends_on` as appropriate; drop former Workflow→Workflow deps.

## Become Interactions (+ new Interfaces)

| Old id | New Interaction | Interface(s) | Notes |
|--------|-----------------|--------------|-------|
| wf-query-graph | i-orient-plan | if-mcp-tools | MCP read tools |
| wf-mutate-graph | i-steer-plan | if-mcp-tools | MCP mutate tools |
| wf-export-views | i-export-map | if-mcp-tools | Mermaid/DOT export |
| wf-integrity-check | i-check-integrity | if-cli | CLI check |
| wf-project-init | i-init-project | if-cli | Absorbs wf-layout-free config mode |
| wf-territory-viewer | i-browse-territory | if-console-territory | Console page |
| wf-status-board | i-view-status | if-console-status | Console page |
| wf-graph-explore | i-explore-graph | if-console-graph | Console page |
| wf-console-mutate | i-mutate-plan | if-console-mutate | Console page |
| wf-model-plan | i-model-plan | if-console-model | Console page |
| wf-npm-publish | i-npm-publish | if-publish-script | Shared script moves conceptually into f-npm-registry |
| wf-npm-tag-publish | i-npm-tag-publish | if-release-tag | CI/tag webhook Interface |

## Absorbed (no successor node)

| Old id | Absorbed into |
|--------|---------------|
| wf-impl-packages | f-territory-store territory |
| wf-layout-free | i-init-project (config mode) |
| wf-agent-integrations | f-framework-docs |
| **wf-interaction-model** | **Cancel after Stage 6 verify** — this migration Workflow is temporary scaffolding. After the graph has zero other Workflows and packages/docs are green, `update_node_status → cancelled` (or delete territory) so AC "no Workflow nodes" holds. Do not rename it to an Interaction. |

## Mechanical rename only (retired nodes)

Deprecated `wf-export-views-v2`, `wf-framework-docs-v3`, `wf-project-init-v2`, `wf-query-graph-v2`, and cancelled `wf-workflow-affected-files` become **Interactions keeping the same ids** — no deep re-model. Update `type:` frontmatter only; keep `belongs_to` / `depends_on` if still legal (Foundation deps ok; drop any Workflow deps).

## Bug `affects` retargeting

When a Workflow id is renamed, rewrite every Bug `affects` target:

| Old target | New target |
|------------|------------|
| wf-framework-docs-v3 | wf-framework-docs-v3 (mechanical Interaction id kept) |
| wf-npm-publish | i-npm-publish |
| wf-project-init | i-init-project |
| wf-test-harness | f-test-harness |
| wf-mutate-graph | i-steer-plan |
| wf-integrity-check | i-check-integrity |
| wf-framework-docs | f-framework-docs |
| f-* targets | unchanged |

Bugs that `affects` absorbed nodes (wf-impl-packages, wf-layout-free, wf-agent-integrations): retarget to the absorb destination Foundation/Interaction.

## Edge rules after remapping

- Dissolve all former Workflow→Workflow `depends_on` edges.
- Interactions `depends_on` Foundations only.
- Foundations that used to be Workflows: remove `belongs_to`; keep only Foundation-legal `depends_on`.
- Add `exposes` from each Interface to its Interaction(s).
- Add initial `leads_to` per Journey, e.g.:
  - i-orient-plan → i-steer-plan → i-export-map
  - i-init-project → i-orient-plan

## Package moves

- Behavior packages: `src/workflows/<old>/` → `src/interactions/<new-id>/`
- Reclassified Foundations: `src/workflows/<old>/` → `src/foundations/<new-id>/`
- New Interfaces: scaffold `src/interfaces/<if-*>/`
- Fix all TS import paths after moves
- Empty `mindplan/workflows/` and `src/workflows/` after migration (except during cancel of wf-interaction-model)
