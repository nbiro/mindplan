/**
 * Tool kit — what an action needs to define its MCP tools: the tool kind (which drives annotations,
 * drift, and verbose), the config shape, `defineTool`, and the schema fragments several actions
 * share. The entry point (if-mcp-tools) mounts the definitions; owned by f-tool-kit.
 */

import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod";

/**
 * What a tool does to the graph. One kind per tool derives both its MCP annotations and its
 * envelope behavior (drift, verbose), so the hint the host prompts from and the result shape
 * cannot disagree. `destructive` removes data or edges that no undo restores.
 */
export type ToolKind = "read" | "write" | "destructive";

export type ToolConfig<Args extends ZodRawShapeCompat> = {
  kind: ToolKind;
  title: string;
  description: string;
  inputSchema: Args;
  /** `false` for read tools that must never carry drift (get_project, get_rules, run_check). */
  drift?: boolean;
  /**
   * `false` for tools that answer before the graph is set up or upgraded (get_project, get_rules,
   * get_spec, get_skill, run_check, setup_project, upgrade_project); every other tool passes the
   * version gate before its handler.
   */
  gate?: boolean;
};

/** One tool an action defines: its name, config, and handler. */
export type ToolDef = {
  name: string;
  config: ToolConfig<ZodRawShapeCompat>;
  handler: (args: never) => unknown;
};

/** A tool definition with its handler typed from its input schema. */
export function defineTool<Args extends ZodRawShapeCompat>(
  name: string,
  config: ToolConfig<Args>,
  handler: (args: ShapeOutput<Args>) => unknown
): ToolDef {
  return { name, config: config as ToolConfig<ZodRawShapeCompat>, handler: handler as (args: never) => unknown };
}

export const VERBOSE = z
  .boolean()
  .optional()
  .describe(
    "Also return the node's record, its 1-hop neighborhood, and drift. Default false: a write returns { node_id, state, next_state, changed_files }."
  );

export const NODE_ID = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-_]*$/, "ids must be kebab_case/slug style: lowercase letters, digits, - and _");

export const CHANGE_ID = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-_]*$/, "change ids are slugs: lowercase letters, digits, - and _");

export const CHANGE_REF = z
  .string()
  .optional()
  .describe("Optional branch name or PR URL for the change. Empty string clears it.");

/** A Journey id (from list_areas) that limits ranking to that Journey's members. */
export const AREA = NODE_ID.optional().describe(
  "A Journey id (list_areas): rank only that Journey's Interactions, the Interfaces exposing them, and the Foundations they depend on. Omit for a question that cuts across Journeys."
);

/** Search aliases: the words people will use for a node that its text does not contain. */
export const ALIASES = z
  .array(z.string().min(1).max(60))
  .max(20)
  .optional()
  .describe(
    "Search aliases: synonyms, the words users will say, other languages (e.g. quote, request a quote, ofertă). Replaces the list; [] clears it. At most 20, each up to 60 characters."
  );

/** The one flag that adds inherited decisions to orient_for_work and get_node_context. */
export const INCLUDE_INHERITED_DECISIONS = z
  .boolean()
  .optional()
  .describe(
    "Also return the decisions inherited through belongs_to / depends_on (a Bug: past the nodes it affects): whole at distance 1, one line { id, node_id, distance, decision } beyond. Default false: only their count and nodes."
  );

/** One level-2 section of each returned body (orient_for_work and get_node_context). */
export const SECTION_READ = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Return only this section of each body, e.g. "## Spec"; a missing heading is Blocked and lists the sections. Read a large node a section at a time.'
  );

/** Which writes send a ready revision back to draft; repeated in the write tools' hints. */
export const READINESS_HINT =
  "A contract write to a slot in state ready (territory text or checkboxes, claims, links) moves that slot back to draft and returns readiness_reset; self-ready it again after review.";
