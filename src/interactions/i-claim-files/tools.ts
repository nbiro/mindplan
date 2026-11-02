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
        "Changes the server-owned implements list for an Interaction, Interface, or Foundation: add (the default) and remove change entries; " +
        "files replaces the whole list only with replace: true (files without replace is Blocked). " +
        "Pre-ship writes current; shipped with an open revision writes it as an add/remove delta against live (change picks the revision when several are open); " +
        "shipped with no open next writes live in place, additive only: every old entry kept (or under a new dir entry), " +
        "each new entry an exact file (or F/) in a folder F the node dominates (it already claims a file directly in F, no other node claims under F); " +
        "removing, moving, globbing, claiming elsewhere, or claiming a migration or schema file (config decisions.schema_files) is Blocked → open_next. " +
        "In-place results list added_in_place; name each in the body with patch_node_territory (run_check warns until then). " +
        "retired nodes may only shrink. Rejects bad paths and ownership conflicts. " +
        "Results may carry folder_claims: a folder/ entry that would replace several per-file entries. " +
        "Entries are files, directories ending in /, or globs (* ** ?; [ ] stay literal), e.g. src/templates/*/actions/i-read-post/. " +
        "attributed names files a revision adds in another node's claimed folder (a migration in a composition root's single migrations folder): ownership stays with that node, " +
        "but the decision gate and the blast radius count them for this revision; each must be an exact file another active node claims, and a shipped node needs an open revision. " +
        READINESS_HINT,
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
        "Changes the node's linked tests list for an Interaction, Interface, or Foundation: add (the default) and remove change entries; " +
        "files replaces the whole list only with replace: true (files without replace is Blocked). " +
        "The list is evidence, not a claim: it does not own the files (claim them with set_implementation_files), several nodes may list one file, " +
        "and readiness is never reset. A shipped node with no open revision is written live in place (no open_next); " +
        "one with an open revision takes it as an add/remove delta on that revision, applied when it ships (change picks the revision when several are open). " +
        "run_check Blocks an entry missing on disk once the node is in review or shipped, and warns about a revision in review with none. " +
        "get_blast_radius lists the linked tests a change should run. " +
        "Entries are files, directories ending in /, or globs (* ** ?). files: [] with replace: true removes it.",
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
            "On a shipped node with open revisions: which revision to write (may be omitted when only one is open). Otherwise the change id for the active slot; empty string clears it. Blocked on a shipped node with no open next."
          ),
      },
    },

      ({ node_id, files, replace, add, remove, change, verbose }) =>
        setTestFiles({ node_id, files, replace, add, remove, change, verbose })
  ),
];
