/**
 * MCP tools owned by wf-query-graph (registered in f-mcp-runtime/server.ts).
 * Ranking substrate: f-graph-search.
 */
export const QUERY_TOOLS = [
  "get_mindplan_graph",
  "find_related_nodes",
  "get_blast_radius",
  "get_node_context",
  "orient_for_work",
  "get_node_implementation",
] as const;
