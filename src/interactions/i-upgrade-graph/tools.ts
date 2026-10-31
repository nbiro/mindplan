/**
 * MCP tool definitions owned by i-upgrade-graph: names, when-to-call descriptions, input schemas, and
 * handlers. if-mcp-tools mounts them with the shared envelope.
 */

import {
  defineTool,
  type ToolDef,
} from "../../foundations/f-tool-kit/tool.js";
import {
  upgradeProject,
} from "./handlers.js";

/** The MCP tools i-upgrade-graph owns; if-mcp-tools mounts them. */
export const TOOLS: ToolDef[] = [
  defineTool(
    "upgrade_project",
    {
      kind: "write",
      drift: false,
      gate: false,
      title: "Upgrade the graph",
      description:
        "Call when get_project's version, a Blocked: Version, or the check names upgrade_project: the graph is behind this server, and every other graph tool is Blocked until it is upgraded. " +
        "Runs every migration (each is idempotent), stamps mindplan/version.json with this server's migration level, and returns " +
        "{ from_level, to_level, changed_files, migrations, leftovers, pointer_outdated, pointer, guide }: leftovers are agent files older releases installed outside mindplan/ (delete them), " +
        "pointer_outdated says MINDPLAN.md or the agent files need the pointer text, and guide lists the steps. Commit the upgrade on its own. " +
        "Blocked without a graph (call setup_project) or when the graph is newer than this server.",
      inputSchema: {},
    },
    () => upgradeProject()
  ),
];
