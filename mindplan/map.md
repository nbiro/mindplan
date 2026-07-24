# MindPlan map

_Auto-generated after each graph mutation (34 nodes, 78 edges). Do not edit by hand._

```mermaid
flowchart TB
  subgraph foundations["Foundations"]
    f_compiler_rules["f-compiler-rules · Compiler rules engine · stable"]
    f_console_bridge["f-console-bridge · Console bridge · ready"]
    f_design_system["f-design-system · Console design system · ready"]
    f_domain_model["f-domain-model · Domain model · stable"]
    f_github_actions["f-github-actions · GitHub Actions assembler · stable"]
    f_graph_search["f-graph-search · Graph search · stable"]
    f_mcp_runtime["f-mcp-runtime · MCP stdio runtime · stable"]
    f_nextjs["f-nextjs · Next.js assembler · ready"]
    f_npm_registry["f-npm-registry · npm registry adapter · ready"]
    f_territory_store["f-territory-store · Territory filesystem store · stable"]
    f_view_projection["f-view-projection · View projection · stable"]
    f_xyflow["f-xyflow · XYFlow adapter · ready"]
  end
  subgraph journey_j_agent_onboarding["j-agent-onboarding · Adopt MindPlan · evolving"]
    wf_agent_integrations__in__j_agent_onboarding["wf-agent-integrations · Agent integrations · stable"]
    wf_framework_docs__in__j_agent_onboarding["wf-framework-docs · Framework docs · stable"]
    wf_layout_free__in__j_agent_onboarding["wf-layout-free · Layout-free adoption · stable"]
    wf_npm_publish__in__j_agent_onboarding["wf-npm-publish · Publish to npm · ready"]
    wf_project_init__in__j_agent_onboarding["wf-project-init · Init a consumer project · stable"]
  end
  subgraph journey_j_npm_publish["j-npm-publish · Ship to npm · draft"]
    wf_npm_publish__in__j_npm_publish["wf-npm-publish · Publish to npm · ready"]
    wf_npm_tag_publish__in__j_npm_publish["wf-npm-tag-publish · Tag-driven npm publish · ready"]
  end
  subgraph journey_j_plan_console["j-plan-console · See and steer the plan · draft"]
    wf_console_mutate__in__j_plan_console["wf-console-mutate · Steer the plan · ready"]
    wf_console_shell__in__j_plan_console["wf-console-shell · Console shell · ready"]
    wf_graph_explore__in__j_plan_console["wf-graph-explore · Explore the graph · ready"]
    wf_model_plan__in__j_plan_console["wf-model-plan · Model the plan · ready"]
    wf_status_board__in__j_plan_console["wf-status-board · Status board · ready"]
    wf_territory_viewer__in__j_plan_console["wf-territory-viewer · Read territory · ready"]
  end
  subgraph journey_j_territory_sdlc["j-territory-sdlc · Plan software · evolving"]
    wf_export_views__in__j_territory_sdlc["wf-export-views · See the map · stable"]
    wf_framework_docs__in__j_territory_sdlc["wf-framework-docs · Framework docs · stable"]
    wf_impl_packages__in__j_territory_sdlc["wf-impl-packages · Prescribe implementation packages · stable"]
    wf_integrity_check__in__j_territory_sdlc["wf-integrity-check · Integrity check CLI · stable"]
    wf_mutate_graph__in__j_territory_sdlc["wf-mutate-graph · Mutate graph · stable"]
    wf_query_graph__in__j_territory_sdlc["wf-query-graph · Orient on the plan · stable"]
    wf_test_harness__in__j_territory_sdlc["wf-test-harness · Test harness · stable"]
  end
  f_compiler_rules --> f_domain_model
  f_console_bridge --> f_compiler_rules
  f_console_bridge --> f_graph_search
  f_console_bridge --> f_mcp_runtime
  f_console_bridge --> f_territory_store
  f_github_actions --> f_npm_registry
  f_graph_search --> f_domain_model
  f_mcp_runtime --> f_compiler_rules
  f_mcp_runtime --> f_territory_store
  f_territory_store --> f_domain_model
  f_view_projection --> f_domain_model
  f_xyflow --> f_design_system
  wf_agent_integrations__in__j_agent_onboarding --> f_mcp_runtime
  wf_console_mutate__in__j_plan_console --> f_console_bridge
  wf_console_mutate__in__j_plan_console --> f_design_system
  wf_console_mutate__in__j_plan_console --> wf_console_shell__in__j_plan_console
  wf_console_mutate__in__j_plan_console --> wf_territory_viewer__in__j_plan_console
  wf_console_shell__in__j_plan_console --> f_console_bridge
  wf_console_shell__in__j_plan_console --> f_design_system
  wf_console_shell__in__j_plan_console --> f_nextjs
  wf_export_views__in__j_territory_sdlc --> f_mcp_runtime
  wf_export_views__in__j_territory_sdlc --> f_territory_store
  wf_export_views__in__j_territory_sdlc --> f_view_projection
  wf_framework_docs__in__j_agent_onboarding --> f_domain_model
  wf_framework_docs__in__j_territory_sdlc --> f_domain_model
  wf_graph_explore__in__j_plan_console --> f_console_bridge
  wf_graph_explore__in__j_plan_console --> f_design_system
  wf_graph_explore__in__j_plan_console --> f_xyflow
  wf_graph_explore__in__j_plan_console --> wf_console_shell__in__j_plan_console
  wf_impl_packages__in__j_territory_sdlc --> f_mcp_runtime
  wf_impl_packages__in__j_territory_sdlc --> f_territory_store
  wf_integrity_check__in__j_territory_sdlc --> f_compiler_rules
  wf_integrity_check__in__j_territory_sdlc --> f_mcp_runtime
  wf_integrity_check__in__j_territory_sdlc --> f_territory_store
  wf_layout_free__in__j_agent_onboarding --> f_mcp_runtime
  wf_layout_free__in__j_agent_onboarding --> f_territory_store
  wf_layout_free__in__j_agent_onboarding --> wf_framework_docs__in__j_agent_onboarding
  wf_layout_free__in__j_agent_onboarding --> wf_project_init__in__j_agent_onboarding
  wf_model_plan__in__j_plan_console --> f_console_bridge
  wf_model_plan__in__j_plan_console --> f_design_system
  wf_model_plan__in__j_plan_console --> wf_console_shell__in__j_plan_console
  wf_model_plan__in__j_plan_console --> wf_graph_explore__in__j_plan_console
  wf_mutate_graph__in__j_territory_sdlc --> f_compiler_rules
  wf_mutate_graph__in__j_territory_sdlc --> f_mcp_runtime
  wf_npm_publish__in__j_agent_onboarding --> f_mcp_runtime
  wf_npm_publish__in__j_npm_publish --> f_mcp_runtime
  wf_npm_publish__in__j_agent_onboarding --> f_npm_registry
  wf_npm_publish__in__j_npm_publish --> f_npm_registry
  wf_npm_tag_publish__in__j_npm_publish --> f_github_actions
  wf_npm_tag_publish__in__j_npm_publish --> f_npm_registry
  wf_npm_tag_publish__in__j_npm_publish --> wf_npm_publish__in__j_agent_onboarding
  wf_project_init__in__j_agent_onboarding --> f_territory_store
  wf_query_graph__in__j_territory_sdlc --> f_graph_search
  wf_query_graph__in__j_territory_sdlc --> f_mcp_runtime
  wf_status_board__in__j_plan_console --> f_console_bridge
  wf_status_board__in__j_plan_console --> f_design_system
  wf_status_board__in__j_plan_console --> wf_console_shell__in__j_plan_console
  wf_territory_viewer__in__j_plan_console --> f_console_bridge
  wf_territory_viewer__in__j_plan_console --> f_design_system
  wf_territory_viewer__in__j_plan_console --> wf_console_shell__in__j_plan_console
  wf_test_harness__in__j_territory_sdlc --> f_mcp_runtime
```
