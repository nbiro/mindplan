/**
 * MCP tool definitions owned by i-read-brief: names, when-to-call descriptions, input schemas, and
 * handlers. if-mcp-tools mounts them with the shared envelope.
 */

import { z } from "zod";
import {
  defineTool,
  type ToolDef,
} from "../../foundations/f-tool-kit/tool.js";
import {
  getProject,
  getRules,
} from "./handlers.js";
import {
  getSpec,
} from "./spec.js";
import {
  getSkill,
} from "./skills.js";

/** The MCP tools i-read-brief owns; if-mcp-tools mounts them. */
export const TOOLS: ToolDef[] = [
  defineTool(
    "get_project",
    {
      kind: "read",
      drift: false,
      gate: false,
      title: "Get project brief",
      description:
        "Call before the first answer or code change in a session, and again after the product description or rules change. Returns the MindPlan playbook and this product's description and rules ({ path, description, rules, rules_version, playbook, check, version?, restart? }). version appears only when the graph needs setup_project, upgrade_project, or a newer server; until then other graph tools are Blocked. restart means a different mindplan-mcp was installed under this server: have the user restart it, then call again. Details: get_spec({ topic: \"get_project\" }).",
      inputSchema: {},
    },
    () => getProject()
  ),
  defineTool(
    "get_spec",
    {
      kind: "read",
      drift: false,
      gate: false,
      title: "Read the specification",
      description:
        "Call when you need a specific MindPlan rule (lifecycle, required sections, change ids, decisions, orientation) instead of guessing or retrying. Returns one part of the running server's SPEC.md ({ topic, version, text }) by topic id, or a tool's entry by tool name; without topic it lists them. Details: get_spec({ topic: \"get_spec\" }).",
      inputSchema: {
        topic: z
          .string()
          .min(1)
          .optional()
          .describe("A topic id (e.g. territory-shape, lifecycle, change-ids, neighbors, decisions) or a tool name (e.g. run_check). Omit to list them."),
      },
    },
    ({ topic }) => getSpec({ topic })
  ),
  defineTool(
    "get_rules",
    {
      kind: "read",
      drift: false,
      gate: false,
      title: "Get project rules",
      description:
        "Call to re-read the project rules explicitly: after a context summary, or when a rules push was missed. Returns the mandatory project rules ({ path, rules, rules_version }) from mindplan/project.md and records them as served to this session. Pass known_version only while you still hold that text; unchanged: true means it still applies. Node rules arrive through orient_for_work. Details: get_spec({ topic: \"get_rules\" }).",
      inputSchema: {
        known_version: z
          .string()
          .optional()
          .describe("The rules_version of rules text you still hold (from get_project or get_rules); the text is left out when it still matches. Omit it when you no longer have the text."),
      },
    },
    ({ known_version }) => getRules({ known_version })
  ),
  defineTool(
    "get_skill",
    {
      kind: "read",
      drift: false,
      gate: false,
      title: "Load a MindPlan skill",
      description:
        "Call when the playbook or the server instructions name a skill, before acting on it. Returns { name, text, files } (text is SKILL.md without frontmatter); pass file to read one supporting file; without name it lists the skills. Details: get_spec({ topic: \"get_skill\" }).",
      inputSchema: {
        name: z.string().min(1).optional().describe("Skill name, e.g. plan-project or define-entities. Omit to list them."),
        file: z.string().min(1).optional().describe("A supporting file of the skill, as listed in files (e.g. examples.md). Needs name."),
      },
    },
    ({ name, file }) => getSkill({ name, file })
  ),
];
