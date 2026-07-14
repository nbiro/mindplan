/**
 * File system persistence for MindPlan.
 *
 * Layout (relative to the project root, i.e. MINDPLAN_ROOT or process.cwd()):
 *   /.mindplan/mindplan.json
 *   /.mindplan/components/              — project-specific MDX components (opaque to the compiler)
 *   /.mindplan/journeys/<id>/context.mdx
 *   /.mindplan/journeys/<id>/attachments/...
 *   /.mindplan/foundations/<id>/context.mdx
 *   /.mindplan/foundations/<id>/attachments/...
 *   /.mindplan/workflows/<id>/context.mdx
 *   /.mindplan/workflows/<id>/attachments/...
 *   /.mindplan/bugs/<id>/context.mdx
 *   /.mindplan/bugs/<id>/attachments/...
 */

import * as fs from "fs";
import * as path from "path";
import type { MindPlanGraph, MindPlanNode, NodeType } from "./types.js";

const TYPE_DIRS: Record<NodeType, string> = {
  Journey: "journeys",
  Foundation: "foundations",
  Workflow: "workflows",
  Bug: "bugs",
};

export const MINDPLAN_DIR = ".mindplan";
export const CONTEXT_FILENAME = "context.mdx";
export const ATTACHMENTS_DIR = "attachments";
export const COMPONENTS_DIR = "components";

export function mindplanRoot(): string {
  return path.join(process.env.MINDPLAN_ROOT ?? process.cwd(), MINDPLAN_DIR);
}

function graphPath(): string {
  return path.join(mindplanRoot(), "mindplan.json");
}

export function typeDir(type: NodeType): string {
  return TYPE_DIRS[type];
}

/** Absolute path to an entity's folder, e.g. /.mindplan/workflows/wf-checkout */
export function entityDir(node: Pick<MindPlanNode, "id" | "type">): string {
  return path.join(mindplanRoot(), TYPE_DIRS[node.type], node.id);
}

/** Project-relative path to an entity folder, e.g. .mindplan/workflows/wf-checkout */
export function entityRelativePath(node: Pick<MindPlanNode, "id" | "type">): string {
  return path.posix.join(MINDPLAN_DIR, TYPE_DIRS[node.type], node.id);
}

export function markdownPath(node: Pick<MindPlanNode, "id" | "type">): string {
  return path.join(entityDir(node), CONTEXT_FILENAME);
}

export function attachmentsDir(node: Pick<MindPlanNode, "id" | "type">): string {
  return path.join(entityDir(node), ATTACHMENTS_DIR);
}

/** Lists filenames in the entity's attachments/ folder (non-recursive). */
export function listAttachments(node: Pick<MindPlanNode, "id" | "type">): string[] {
  const dir = attachmentsDir(node);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name !== ".gitkeep")
    .map((e) => e.name)
    .sort();
}

export type InitResult = {
  root: string;
  created: boolean;
};

/** Scaffolds an empty .mindplan/ tree in the consumer project (idempotent). */
export function initProject(): InitResult {
  const root = mindplanRoot();
  const graphFile = graphPath();
  const exists = fs.existsSync(graphFile);
  if (!exists) {
    writeGraph({ version: 1, nodes: [], edges: [] });
  } else {
    ensureDirectories();
  }
  return { root, created: !exists };
}

/** Creates /.mindplan, top-level type directories, and components/ if missing. */
export function ensureDirectories(): void {
  fs.mkdirSync(mindplanRoot(), { recursive: true });
  for (const dir of Object.values(TYPE_DIRS)) {
    fs.mkdirSync(path.join(mindplanRoot(), dir), { recursive: true });
  }
  const componentsDir = path.join(mindplanRoot(), COMPONENTS_DIR);
  fs.mkdirSync(componentsDir, { recursive: true });
  const keep = path.join(componentsDir, ".gitkeep");
  if (!fs.existsSync(keep)) {
    fs.writeFileSync(keep, "", "utf-8");
  }
}

function ensureEntityDir(node: Pick<MindPlanNode, "id" | "type">): void {
  ensureDirectories();
  fs.mkdirSync(entityDir(node), { recursive: true });
  fs.mkdirSync(attachmentsDir(node), { recursive: true });
}

export function readGraph(): MindPlanGraph {
  const file = graphPath();
  if (!fs.existsSync(file)) {
    return { version: 1, nodes: [], edges: [] };
  }
  const raw = fs.readFileSync(file, "utf-8");
  return JSON.parse(raw) as MindPlanGraph;
}

export function writeGraph(graph: MindPlanGraph): void {
  ensureDirectories();
  fs.writeFileSync(graphPath(), JSON.stringify(graph, null, 2) + "\n", "utf-8");
}

export function readMarkdown(node: Pick<MindPlanNode, "id" | "type">): string {
  const file = markdownPath(node);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Blocked: context file not found for node "${node.id}" (expected at ${file}).`
    );
  }
  return fs.readFileSync(file, "utf-8");
}

export function writeMarkdown(node: Pick<MindPlanNode, "id" | "type">, content: string): void {
  ensureEntityDir(node);
  fs.writeFileSync(markdownPath(node), content, "utf-8");
}

/** Rewrites the `state:` field inside context.mdx YAML frontmatter, if present. */
export function syncMarkdownState(node: MindPlanNode): void {
  const file = markdownPath(node);
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, "utf-8");
  const frontmatter = raw.match(/^---\r?\n[\s\S]*?\r?\n---/);
  if (!frontmatter) return;
  const patched = frontmatter[0].replace(/^state:.*$/m, `state: ${node.state}`);
  if (patched !== frontmatter[0]) {
    fs.writeFileSync(file, raw.replace(frontmatter[0], patched), "utf-8");
  }
}

/** Scaffolds an entity folder: context.mdx + empty attachments/ directory. */
export function scaffoldEntity(node: MindPlanNode): void {
  ensureEntityDir(node);
  const attachmentsKeep = path.join(attachmentsDir(node), ".gitkeep");
  if (!fs.existsSync(attachmentsKeep)) {
    fs.writeFileSync(attachmentsKeep, "", "utf-8");
  }

  const frontmatter = [
    "---",
    `id: ${node.id}`,
    `type: ${node.type}`,
    `title: ${JSON.stringify(node.title)}`,
    `state: ${node.state}`,
    `created_at: ${node.created_at}`,
    "---",
  ].join("\n");

  let body: string;
  switch (node.type) {
    case "Journey":
      body = [
        `# ${node.title}`,
        "",
        node.description,
        "",
        "## Overview",
        "",
        "_Describe the macro user flow this Journey covers._",
        "",
        "## Linked Workflows",
        "",
        "_Workflows attach themselves here via `belongs_to` edges. The Journey state is computed automatically._",
        "",
        "## Attachments",
        "",
        `_Place supporting files in \`attachments/\` alongside this file. Reference them with relative links, e.g. \`![diagram](attachments/diagram.png)\`._`,
        "",
        "{/* This file is MDX. MindPlan standard components (AtomicOp, AcceptanceCriteria, Attachment, StateBadge, DependsOn, BelongsTo) may be used here; see SPEC.md §6.4. */}",
        "",
      ].join("\n");
      break;
    case "Foundation":
      body = [
        `# ${node.title}`,
        "",
        node.description,
        "",
        "## Infrastructure Spec",
        "",
        "_Document schemas, API integrations, and contracts here._",
        "",
        "## Checklist",
        "",
        "- [ ] Spec written",
        "- [ ] Implementation complete",
        "- [ ] Verified in target environment",
        "",
        "## Attachments",
        "",
        `_Schemas, OpenAPI exports, ER diagrams, etc. go in \`attachments/\`._`,
        "",
        "{/* This file is MDX. MindPlan standard components (AtomicOp, AcceptanceCriteria, Attachment, StateBadge, DependsOn, BelongsTo) may be used here; see SPEC.md §6.4. */}",
        "",
      ].join("\n");
      break;
    case "Workflow":
      body = [
        `# ${node.title}`,
        "",
        node.description,
        "",
        "## Execution Logic",
        "",
        "_Describe the business logic / feature behaviour step by step._",
        "",
        "## Checklist",
        "",
        "- [ ] Requirements defined",
        "- [ ] Implementation complete",
        "- [ ] Tests passing",
        "",
        "## Attachments",
        "",
        `_Wireframes, screenshots, and spec PDFs go in \`attachments/\`._`,
        "",
        "{/* This file is MDX. MindPlan standard components (AtomicOp, AcceptanceCriteria, Attachment, StateBadge, DependsOn, BelongsTo) may be used here; see SPEC.md §6.4. */}",
        "",
      ].join("\n");
      break;
    case "Bug":
      body = [
        `# ${node.title}`,
        "",
        node.description,
        "",
        "## Summary",
        "",
        "_One-line description of the defect._",
        "",
        "## Repro Steps",
        "",
        "1. _Step one_",
        "2. _Step two_",
        "",
        "## Expected / Actual",
        "",
        "**Expected:** _What should happen_",
        "",
        "**Actual:** _What happens instead_",
        "",
        "## Fix Checklist",
        "",
        "- [ ] Root cause identified",
        "- [ ] Fix implemented",
        "- [ ] Regression test added",
        "",
        "## Attachments",
        "",
        `_Logs, screenshots, and HAR files go in \`attachments/\`._`,
        "",
        "{/* MDX: Affects, ReproSteps, Severity, ExpectedActual — see SPEC.md §6.4. */}",
        "",
      ].join("\n");
      break;
  }

  writeMarkdown(node, `${frontmatter}\n\n${body}`);
}

/**
 * Completion Check helper: returns the number of unchecked `[ ]` checkboxes
 * in context.mdx. Markdown checkboxes are `- [ ]` / `- [x]` list items.
 * JSX in the file is never parsed; guardrails gate on markdown syntax only.
 */
export function countUncheckedBoxes(node: Pick<MindPlanNode, "id" | "type">): number {
  const raw = readMarkdown(node);
  const matches = raw.match(/^\s*[-*+]\s+\[ \]/gm);
  return matches ? matches.length : 0;
}
