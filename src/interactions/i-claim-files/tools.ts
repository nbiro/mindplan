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
        "Changes the server-owned implements list of a Foundation, Interaction, or Interface: add (default) and remove entries; files replaces the whole list only with replace: true. " +
        "Entries are files, directories ending in /, or globs (* ** ?). Pre-ship writes current; with an open revision it writes a delta (change picks the revision when several are open). " +
        "A shipped node with no open revision may only add exact files in a folder it already dominates (listed in added_in_place: name each in the body with patch_node_territory); " +
        "removing, globbing, claiming elsewhere, or claiming a migration or schema file is Blocked → open_next. Ownership conflicts are rejected. " +
        "attributed lists files this revision adds in another node's claimed folder: that node keeps ownership, the decision gate and blast radius count them here. " +
        READINESS_HINT +
        ' Details: get_spec({ topic: "set_implementation_files" }).',
      inputSchema: {
        verbose: VERBOSE,
        node_id: NODE_ID.describe("Pipeline node whose implements list to change."),
        add: z
          .array(z.string())
          .optional()
          .describe("Repo-relative POSIX paths (files, or directories ending in /) to claim. The default way to claim."),
        remove: z.array(z.string()).optional().describe("Claim entries to drop."),
        files: z
          .array(z.string())
          .optional()
          .describe(
            "The whole new claim list; only with replace: true. Omit (with attributed) to keep the claims."
          ),
        replace: z.boolean().optional().describe("true: files replaces the whole list."),
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
            "On a shipped node with open revisions: which revision to write (may be omitted when only one is open). Otherwise the change id for the written slot; empty string clears it. Blocked on a shipped node with no open next (edit its files in place; it needs no change id)."
          ),
      },
    },

      ({ node_id, files, replace, add, remove, attributed, slot, change, verbose }) =>
        setImplementationFiles({ node_id, files, replace, add, remove, attributed, slot, change, verbose })
  ),
  defineTool(
    "set_test_files",
    {
      kind: "write",
      title: "Set test files",
      description:
        "Call when tests that verify a node exist, before moving it to in-review. " +
        "Changes a Foundation, Interaction, or Interface's linked tests: add (default) and remove entries (files, directories ending in /, or globs); files replaces the whole list only with replace: true. " +
        "Test links are evidence, not ownership: several nodes may list one file, and readiness is never reset. " +
        "Without change the live list is written in place (no open_next needed); with change on a shipped node, that revision takes it as a delta applied on ship. " +
        "run_check Blocks an entry missing on disk once the node is in review or shipped. " +
        'Details: get_spec({ topic: "set_test_files" }).',
      inputSchema: {
        verbose: VERBOSE,
        node_id: NODE_ID.describe("Pipeline node whose linked tests to change."),
        add: z
          .array(z.string())
          .optional()
          .describe("Repo-relative POSIX test paths (files, directories ending in /, or globs) to link. The default way to link."),
        remove: z.array(z.string()).optional().describe("Linked test entries to drop."),
        files: z
          .array(z.string())
          .optional()
          .describe("The whole new list; only with replace: true."),
        replace: z.boolean().optional().describe("true: files replaces the whole list."),
        change: CHANGE_ID.or(z.literal(""))
          .optional()
          .describe(
            "On a shipped node with open revisions: which revision's tests delta to write (omitted: the live list). Otherwise the change id for the active slot; empty string clears it. Blocked on a shipped node with no open next."
          ),
      },
    },

      ({ node_id, files, replace, add, remove, change, verbose }) =>
        setTestFiles({ node_id, files, replace, add, remove, change, verbose })
  ),
];
