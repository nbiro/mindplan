/**
 * orient_for_work `sections`: return only the named parts of a reply, plus its identity fields.
 * A reply orients (clears the write gate) only when it carries the rules section.
 */

import { blocked } from "../../foundations/f-compiler-rules/rules.js";

/** The parts of an orient_for_work reply `sections` can name. */
export const ORIENT_SECTIONS = [
  "rules",
  "decisions",
  "record",
  "body",
  "files",
  "shape",
  "revisions",
  "open_items",
  "blast_radius",
  "stability",
  "neighborhood",
  "drift",
] as const;

export type OrientSection = (typeof ORIENT_SECTIONS)[number];

/** Fields every cut reply keeps: which node or change it is about. */
const IDENTITY = ["query", "focus", "auto_focus", "unlocks", "change", "node_ids", "members", "next"];

/** Reply keys each section maps to (record and body are cut from `context`). */
const TOP_LEVEL: Partial<Record<OrientSection, string[]>> = {
  rules: ["rules", "rules_more", "project_rules"],
  decisions: ["decisions"],
  files: ["files"],
  shape: ["shape"],
  revisions: ["revisions"],
  open_items: ["open_items"],
  blast_radius: ["blast_radius"],
  stability: ["stability"],
  neighborhood: ["nodes", "edges"],
  // The full drift list: the MCP envelope attaches it after the cut (`drift` names no handler key).
  drift: ["drift"],
};

/** The sections as given, Blocked on an unknown name (listing the valid ones). */
export function parseSections(sections: string[] | undefined): Set<OrientSection> | undefined {
  if (sections === undefined) return undefined;
  const unknown = sections.filter((s) => !(ORIENT_SECTIONS as readonly string[]).includes(s));
  if (unknown.length > 0) {
    throw blocked(
      `orient_for_work sections ${unknown.map((u) => JSON.stringify(u)).join(", ")} unknown; valid: ${ORIENT_SECTIONS.join(", ")}.`
    );
  }
  return new Set(sections as OrientSection[]);
}

/** Whether a reply with these sections orients on its node(s): only with the rules. */
export function orients(sections: Set<OrientSection> | undefined): boolean {
  return sections === undefined || sections.has("rules");
}

/** The reply cut to `sections` (unchanged without them). */
export function cutReply(reply: Record<string, unknown>, sections: Set<OrientSection> | undefined): Record<string, unknown> {
  if (sections === undefined) return reply;
  const out: Record<string, unknown> = {};
  for (const key of IDENTITY) if (key in reply) out[key] = reply[key];
  for (const section of sections) {
    for (const key of TOP_LEVEL[section] ?? []) if (key in reply) out[key] = reply[key];
  }
  const context = reply.context as Record<string, unknown> | undefined;
  if (context && (sections.has("record") || sections.has("body"))) {
    const cut: Record<string, unknown> = {};
    const next = context.next as { record?: unknown; body?: unknown } | string | null | undefined;
    const nextCut: Record<string, unknown> = {};
    if (sections.has("record")) {
      for (const [key, value] of Object.entries(context)) {
        if (key !== "body" && key !== "next" && key !== "section" && key !== "rules") cut[key] = value;
      }
      if (next && typeof next === "object" && "record" in next) nextCut.record = next.record;
    }
    if (sections.has("body")) {
      if ("body" in context) cut.body = context.body;
      if ("section" in context) cut.section = context.section;
      if (next && typeof next === "object" && "body" in next) nextCut.body = next.body;
    }
    if (Object.keys(nextCut).length > 0) cut.next = nextCut;
    else if (typeof next === "string") cut.next = next;
    out.context = cut;
  }
  return out;
}
