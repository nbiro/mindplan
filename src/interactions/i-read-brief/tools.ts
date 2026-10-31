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
        "Call before the first answer or code change in a session, and again after the product description or rules change. Not before every action. " +
        "Returns the systems dialect and this product's description and standing rules " +
        "({ path, description, rules, rules_version, playbook, check, version? }). playbook is the bundled MindPlan dialect; description/rules come from mindplan/project.md. " +
        "rules_version tags the rules: pass it to get_rules as known_version. " +
        "version appears only when the graph needs setup or an upgrade, or the server is older than the graph, and names the fix (setup_project, upgrade_project, or the package to install); until then every other graph tool is Blocked.",
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
        "Call when you need a specific MindPlan rule (lifecycle, required sections, change ids, neighbors, decisions, imports, orientation) instead of guessing or retrying. " +
        "Returns one part of the running server's own SPEC.md ({ topic, version, text }) by stable topic id, or a tool's SPEC entry by tool name. " +
        "Without topic it lists the topic ids and tool names.",
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
        "Call before each action, before orient_for_work. Returns the mandatory project rules " +
        "({ path, rules, rules_version }) from mindplan/project.md. Empty string when the section is empty. " +
        "While you still hold the rules text, pass its rules_version as known_version: when the rules are unchanged the reply is { path, rules_version, unchanged: true } " +
        "and that text still applies; otherwise it carries the new text and tag. Without the text in context (a new session, a summarized one), pass nothing. " +
        "These are the global rules only; node rules arrive through orient_for_work. " +
        "Does not return the playbook or description.",
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
        "Call when the playbook or the server instructions name a skill, before acting on it. " +
        "Returns the skill served by this server: { name, text, files } (text is SKILL.md without frontmatter; files are its supporting files). " +
        "Pass file to read one supporting file ({ name, file, text }). Without name it lists the skills ({ name, description, files }).",
      inputSchema: {
        name: z.string().min(1).optional().describe("Skill name, e.g. plan-project or define-entities. Omit to list them."),
        file: z.string().min(1).optional().describe("A supporting file of the skill, as listed in files (e.g. examples.md). Needs name."),
      },
    },
    ({ name, file }) => getSkill({ name, file })
  ),
];
