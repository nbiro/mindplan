/**
 * MCP tool definitions owned by i-edit-territory: names, when-to-call descriptions, input schemas, and
 * handlers. if-mcp-tools mounts them with the shared envelope.
 */

import { z } from "zod";
import {
  FOUNDATION_ROLES,
} from "../../foundations/f-domain-model/types.js";
import {
  defineTool,
  type ToolDef,
  VERBOSE,
  NODE_ID,
  CHANGE_REF,
  ALIASES,
  READINESS_HINT,
} from "../../foundations/f-tool-kit/tool.js";
import {
  patchNodeRules,
  patchNodeTerritory,
  putAttachment,
  removeAttachment,
} from "./handlers.js";

/** The MCP tools i-edit-territory owns; if-mcp-tools mounts them. */
export const TOOLS: ToolDef[] = [
  defineTool(
    "patch_node_territory",
    {
      kind: "write",
      title: "Patch node territory",
      description:
        "Call when a node's title, description, or body should match the work, before the feature code. " +
        "Required writer for territory prose: body (whole body), section + text (rewrite one ## section), " +
        "replace { find, with } (one exact edit), toggle_checkboxes, optional title/description/role " +
        "(pre-ship or open evolution). Prefer section/replace for small fixes: they do not resend the body. " +
        "Do not edit mindplan/ MDX with host file tools. " +
        "When a shipped node has an open evolution, patches default to next. Optional slot: current|next. " +
        READINESS_HINT +
        " change / change_ref set the revision's change id (grouping only: never resets readiness); moving the last revision off a change drops its planned edges (cleared_planned). " +
        "On a shipped node with no open next both are Blocked: edit its files in place, it needs no change id. " +
        "aliases replaces the node's search aliases on any node, shipped included, live and an open next alike, without open_next or a readiness reset.",
      inputSchema: {
        verbose: VERBOSE,
        node_id: NODE_ID.describe("Node whose territory to patch."),
        aliases: ALIASES,
        title: z
          .string()
          .min(1)
          .optional()
          .describe("New title (pre-ship or next slot)."),
        description: z
          .string()
          .optional()
          .describe("New description (pre-ship or next slot)."),
        role: z
          .enum(FOUNDATION_ROLES)
          .optional()
          .describe("Foundation role (pre-ship or next slot)."),
        body: z.string().optional().describe("Replace entire territory body below frontmatter."),
        section: z
          .string()
          .optional()
          .describe(
            'Heading of one section to rewrite, e.g. "## Purpose". Needs text. Other sections and the heading line stay as they are.'
          ),
        text: z
          .string()
          .optional()
          .describe("Replacement text for the section named by section."),
        replace: z
          .object({
            find: z.string().min(1).describe("Exact text to find in the body (must be unique unless all)."),
            with: z.string().describe("Replacement text."),
            all: z.boolean().optional().describe("Replace every occurrence."),
          })
          .optional()
          .describe("Replace one exact piece of the body without resending it."),
        toggle_checkboxes: z
          .array(
            z.object({
              contains: z.string().min(1).describe("Substring to match on a checkbox line."),
              checked: z
                .boolean()
                .optional()
                .describe("true for [x], false for [ ]. Optional with note or not_applicable (both tick)."),
              all: z
                .boolean()
                .optional()
                .describe("Toggle every matching line. Without it, a substring matching several lines is Blocked."),
              note: z
                .string()
                .optional()
                .describe('Tick with a note, written as " — note: <text>" after the item.'),
              not_applicable: z
                .string()
                .optional()
                .describe('Tick as not applicable with a reason, written as " — n/a: <reason>". Counts as done.'),
            })
          )
          .optional()
          .describe(
            "Toggle markdown checkboxes by matching line content. Returns toggled: the lines as written. " +
              "Close an item honestly with note or not_applicable instead of rewording it."
          ),
        change: z
          .string()
          .optional()
          .describe(
            "Set this revision's change id (a slug); empty string clears it. Blocked on a shipped node with no open next."
          ),
        change_ref: CHANGE_REF,
        slot: z
          .enum(["current", "next"])
          .optional()
          .describe("Territory slot to patch. Defaults to next when an open evolution exists."),
        split_into: z
          .array(NODE_ID)
          .optional()
          .describe(
            "Foundation with an open revision only: the Foundations this revision splits out of it. Shipping the revision records the split (split_at, split_into) for those it depends_on, and resets its hotspot rate."
          ),
      },
    },
    
      ({
        node_id,
        title,
        description,
        role,
        body,
        section,
        text,
        replace,
        toggle_checkboxes,
        change,
        change_ref,
        slot,
        aliases,
        split_into,
        verbose,
      }) =>
        patchNodeTerritory({
          node_id,
          title,
          description,
          role,
          body,
          section,
          text,
          replace,
          toggle_checkboxes,
          change,
          change_ref,
          slot,
          aliases,
          split_into,
          verbose,
        })
  ),
  defineTool(
    "patch_node_rules",
    {
      kind: "write",
      title: "Patch node rules",
      description:
        "Call when a rule applies to one node and the work that inherits from it, not everywhere " +
        "(use patch_project_rules for rules that apply everywhere). " +
        "Replaces the ## Rules section of that node; an empty string clears it. Works on any non-retired node, " +
        "including shipped ones, without open_next. Returns rules_impact: the nodes whose work the rules reach.",
      inputSchema: {
        node_id: NODE_ID.describe("Node whose rules to replace."),
        rules: z
          .string()
          .describe(
            "Replace the node's ## Rules section. Empty string clears it. No level-1 or level-2 headings."
          ),
      },
    },
    ({ node_id, rules }) => patchNodeRules({ node_id, rules })
  ),
  defineTool(
    "put_attachment",
    {
      kind: "write",
      title: "Put node attachment",
      description:
        "Call when a supporting file should sit beside a node. " +
        "Writes a file under attachments/ (or next-attachments/ while evolving) as base64. " +
        "Slot defaults to next when an open evolution exists.",
      inputSchema: {
        verbose: VERBOSE,
        node_id: NODE_ID.describe("Node that owns the attachment."),
        filename: z.string().min(1).describe("Basename only (no path separators)."),
        content_base64: z.string().describe("File bytes encoded as base64."),
        slot: z.enum(["current", "next"]).optional().describe("Attachment slot override."),
      },
    },
    
      ({ node_id, filename, content_base64, slot, verbose }) =>
        putAttachment({ node_id, filename, content_base64, slot, verbose })
  ),
  defineTool(
    "remove_attachment",
    {
      kind: "destructive",
      title: "Remove node attachment",
      description:
        "Call when a supporting file should leave a node. " +
        "Deletes a file under attachments/ (or next-attachments/ while evolving). " +
        "Slot defaults to next when an open evolution exists.",
      inputSchema: {
        verbose: VERBOSE,
        node_id: NODE_ID.describe("Node that owns the attachment."),
        filename: z.string().min(1).describe("Basename only (no path separators)."),
        slot: z.enum(["current", "next"]).optional().describe("Attachment slot override."),
      },
    },
    
      ({ node_id, filename, slot, verbose }) =>
        removeAttachment({ node_id, filename, slot, verbose })
  ),
];
