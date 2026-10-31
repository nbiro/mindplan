/**
 * MCP tool definitions owned by i-claim-files: names, when-to-call descriptions, input schemas, and
 * handlers. if-mcp-tools mounts them with the shared envelope.
 */

import { z } from "zod";
import {
  defineTool,
  type ToolDef,
  VERBOSE,
  NODE_ID,
  CHANGE_ID,
  READINESS_HINT,
} from "../../foundations/f-tool-kit/tool.js";
import {
  setImplementationFiles,
  setTestFiles,
} from "./handlers.js";

/** The MCP tools i-claim-files owns; if-mcp-tools mounts them. */
export const TOOLS: ToolDef[] = [
  defineTool(
    "set_implementation_files",
    {
      kind: "write",
      title: "Set implementation files",
      description:
        "Call before writing a file the node does not yet claim. " +
        "Replaces the server-owned implements list for an Interaction, Interface, or Foundation. " +
        "Pre-ship writes current; shipped with an open next writes next; " +
        "shipped with no open next writes live in place, additive only: every old entry kept (or under a new dir entry), " +
        "each new entry an exact file (or F/) in a folder F the node dominates (it already claims a file directly in F, no other node claims under F); " +
        "removing, moving, globbing, claiming elsewhere, or claiming a migration or schema file (config decisions.schema_files) is Blocked → open_next. " +
        "In-place results list added_in_place; name each in the body with patch_node_territory (run_check warns until then). " +
        "retired nodes may only shrink. Rejects bad paths and ownership conflicts. " +
        "Results may carry folder_claims: a folder/ entry that would replace several per-file entries. " +
        "Entries are files, directories ending in /, or globs (* ** ?; [ ] stay literal), e.g. src/templates/*/actions/i-read-post/. " +
        "attributed names files a revision adds in another node's claimed folder (a migration in a composition root's single migrations folder): ownership stays with that node, " +
        "but the decision gate and the blast radius count them for this revision; each must be an exact file another active node claims, and a shipped node needs an open next. " +
        READINESS_HINT,
      inputSchema: {
        verbose: VERBOSE,
        node_id: NODE_ID.describe("Pipeline node whose implements list to replace."),
        files: z
          .array(z.string())
          .optional()
          .describe(
            "Repo-relative POSIX paths (files, or directories ending in /). Replaces the slot list. Omit with attributed to keep the claims."
          ),
        attributed: z
          .array(z.string())
          .optional()
          .describe(
            "Exact repo-relative files this revision adds in another node's claimed folder. Replaces the list; [] clears it."
          ),
        slot: z
          .enum(["current", "next"])
          .optional()
          .describe("Optional slot override. Defaults by lifecycle."),
        change: CHANGE_ID.or(z.literal(""))
          .optional()
          .describe(
            "Change id for the written slot; on a shipped node with no open next it labels the node a neighbor (returns neighbor_of). Empty string clears it."
          ),
      },
    },
    
      ({ node_id, files, attributed, slot, change, verbose }) =>
        setImplementationFiles({ node_id, files, attributed, slot, change, verbose })
  ),
  defineTool(
    "set_test_files",
    {
      kind: "write",
      title: "Set test files",
      description:
        "Call when tests that verify a node exist, before moving it to in-review. " +
        "Replaces the node's linked tests list for an Interaction, Interface, or Foundation. " +
        "The list is evidence, not a claim: it does not own the files (claim them with set_implementation_files), several nodes may list one file, " +
        "and it is written to live and an open next alike, so a shipped node needs no open_next and readiness is never reset. " +
        "run_check Blocks an entry missing on disk once the node is in review or shipped, and warns about a revision in review with none. " +
        "get_blast_radius lists the linked tests a change should run. " +
        "Entries are files, directories ending in /, or globs (* ** ?). An empty list removes it.",
      inputSchema: {
        verbose: VERBOSE,
        node_id: NODE_ID.describe("Pipeline node whose linked tests to replace."),
        files: z
          .array(z.string())
          .describe("Repo-relative POSIX test paths (files, directories ending in /, or globs). Replaces the list."),
        change: CHANGE_ID.or(z.literal(""))
          .optional()
          .describe(
            "Change id for the active slot; on a shipped node with no open next it labels the node a neighbor (returns neighbor_of). Empty string clears it."
          ),
      },
    },
    
      ({ node_id, files, change, verbose }) => setTestFiles({ node_id, files, change, verbose })
  ),
];
