/**
 * MCP tools owned by wf-mutate-graph (registered in f-mcp-runtime/server.ts).
 */
export const MUTATE_TOOLS = [
  "create_node",
  "link_nodes",
  "unlink_nodes",
  "update_node_status",
  "force_unship",
  "patch_node_territory",
  "open_next",
  "discard_next",
] as const;
