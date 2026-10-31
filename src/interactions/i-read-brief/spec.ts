/**
 * SPEC sections by stable topic id, read from the running package's own SPEC.md so an agent never
 * reads a stale copy from an npx cache. Topics name headings by their text without section numbers,
 * so renumbering SPEC does not change what a topic returns.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { blocked } from "../../foundations/f-compiler-rules/rules.js";
import { packageVersion } from "../../foundations/f-territory-store/version.js";

/** Stable topic ids: each names the SPEC headings it returns, in order. */
export const SPEC_TOPICS: Record<string, { title: string; headings: string[] }> = {
  "territory-shape": {
    title: "Required sections per node type and the gates that check them",
    headings: ["Minimum Territory Shape"],
  },
  lifecycle: {
    title: "Build pipeline states and transitions",
    headings: ["Build pipeline (Foundation / Interaction / Interface)"],
  },
  bugs: { title: "Bug lifecycle", headings: ["Bug lifecycle", "Bug initial state"] },
  "atomic-ops": {
    title: "Atomic Ops and the Completion Check",
    headings: ["Atomic Operations", "Rule 5 — The Completion Check"],
  },
  versioning: { title: "Shipped nodes, open_next, and Territory Completeness", headings: ["Versioning"] },
  "change-ids": { title: "Change ids and one status call per change", headings: ["Change ids", "One status call"] },
  neighbors: { title: "Source, neighbor, or unaffected in a blast radius", headings: ["Pull-in", "Classes"] },
  "planned-wiring": {
    title: "Planned edges on shipped nodes, and files a revision adds in another node's folder",
    headings: ["Planned edges", "Attributed files"],
  },
  decisions: { title: "The decision gate and decision records", headings: ["Rule 12 — Decision gate", "Decision records"] },
  "open-closed": { title: "Fan-in, churn, hotspots, and change additivity", headings: ["Open–closed signals"] },
  imports: {
    title: "The import matrix, package ownership, and the check gate",
    headings: ["Ownership split (Interaction owns the body; Interface mounts)", "Rule 9 — Taxonomy enforcement and Interaction Independence"],
  },
  ownership: { title: "Declared file ownership and the source universe", headings: ["Declared file ownership"] },
  orientation: { title: "The orientation write gate", headings: ["Orientation gate"] },
  rules: { title: "Project rules and node rules", headings: ["Project brief (`mindplan/project.md`)", "Node rules"] },
  checks: { title: "The offline integrity check", headings: ["Offline integrity check (`mindplan-mcp check`)"] },
  errors: { title: "Canonical Blocked messages", headings: ["Appendix A — Canonical error catalog"] },
};

/** A file shipped with the package (templates/, SPEC.md), found by walking up from this module. */
export function findPackageFile(...segments: string[]): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, ...segments);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

type Heading = { line: number; level: number; title: string };

/** Markdown headings outside code fences, with their section numbers stripped. */
function headings(lines: string[]): Heading[] {
  const out: Heading[] = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) return;
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (!m) return;
    out.push({ line: i, level: m[1].length, title: m[2].replace(/^\d+(\.\d+)*\.?\s+/, "") });
  });
  return out;
}

/** The heading's text up to the next heading of the same or a higher level. */
function sectionText(lines: string[], all: Heading[], h: Heading): string {
  const end = all.find((o) => o.line > h.line && o.level <= h.level)?.line ?? lines.length;
  return lines.slice(h.line, end).join("\n").trim();
}

function loadSpec(): string[] {
  const file = findPackageFile("SPEC.md");
  if (!file) {
    throw blocked("get_spec could not find SPEC.md. Reinstall mindplan-mcp so the specification ships with the package.");
  }
  return fs.readFileSync(file, "utf-8").replace(/\r\n?/g, "\n").split("\n");
}

/** Topic ids with their titles, and the tools whose SPEC entry a tool name returns. */
function topicList(all: Heading[]): Record<string, unknown> {
  const tools = all
    .map((h) => /^`([a-z_]+)`$/.exec(h.title)?.[1])
    .filter((t): t is string => Boolean(t));
  return {
    topics: Object.entries(SPEC_TOPICS).map(([id, t]) => ({ id, title: t.title })),
    tools,
  };
}

/**
 * One part of the running package's SPEC.md: `{ topic, version, text }`. `topic` is a stable id
 * from `SPEC_TOPICS` or a tool name (its `#### \`<tool>\`` entry). Without one it lists the ids.
 */
export function getSpec(args: { topic?: string } = {}): Record<string, unknown> {
  const lines = loadSpec();
  const all = headings(lines);
  const version = packageVersion();
  const topic = args.topic?.trim();
  if (!topic) return { version, ...topicList(all) };

  const known = SPEC_TOPICS[topic];
  const wanted = known ? known.headings : [`\`${topic}\``];
  const found = wanted.map((title) => all.find((h) => h.title === title));
  if (!known && !found[0]) {
    throw blocked(
      `get_spec: unknown topic "${topic}". Valid topics: ${Object.keys(SPEC_TOPICS).join(", ")}; ` +
        `or a tool name such as run_check. Call get_spec() to list them.`
    );
  }
  const missing = wanted.filter((_, i) => !found[i]);
  if (missing.length > 0) {
    throw blocked(
      `get_spec: SPEC.md ${version} has no heading ${missing.map((m) => `"${m}"`).join(", ")} for topic "${topic}". ` +
        `Reinstall mindplan-mcp; if it persists, report it.`
    );
  }
  return {
    topic,
    version,
    text: found.map((h) => sectionText(lines, all, h!)).join("\n\n"),
  };
}
