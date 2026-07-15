/**
 * File system persistence for MindPlan.
 *
 * Layout (relative to the project root, i.e. MINDPLAN_ROOT or process.cwd()):
 *   /mindplan/components/              — project-specific MDX components (opaque to the compiler)
 *   /mindplan/journeys/<id>/context.mdx
 *   /mindplan/journeys/<id>/attachments/...
 *   /mindplan/foundations/<id>/context.mdx
 *   /mindplan/foundations/<id>/attachments/...
 *   /mindplan/workflows/<id>/context.mdx
 *   /mindplan/workflows/<id>/attachments/...
 *   /mindplan/bugs/<id>/context.mdx
 *   /mindplan/bugs/<id>/attachments/...
 *
 * Node records and outgoing edge arrays live in context.mdx YAML frontmatter.
 */

import * as fs from "fs";
import * as path from "path";
import type { BugSeverity, EdgeType, MindPlanEdge, MindPlanGraph, MindPlanNode, NodeType } from "./types.js";
import { BUG_SEVERITIES, GRAPH_VERSION, NODE_TYPES } from "./types.js";

const TYPE_DIRS: Record<NodeType, string> = {
  Journey: "journeys",
  Foundation: "foundations",
  Workflow: "workflows",
  Bug: "bugs",
};

const DIR_TO_TYPE: Record<string, NodeType> = {
  journeys: "Journey",
  foundations: "Foundation",
  workflows: "Workflow",
  bugs: "Bug",
};

const EDGE_FIELDS = ["belongs_to", "depends_on", "affects", "supersedes"] as const;
type EdgeField = (typeof EDGE_FIELDS)[number];

export const MINDPLAN_DIR = "mindplan";
export const CONTEXT_FILENAME = "context.mdx";
export const ATTACHMENTS_DIR = "attachments";
export const COMPONENTS_DIR = "components";

export function mindplanRoot(): string {
  return path.join(process.env.MINDPLAN_ROOT ?? process.cwd(), MINDPLAN_DIR);
}

export function typeDir(type: NodeType): string {
  return TYPE_DIRS[type];
}

/** Absolute path to an entity's folder, e.g. /mindplan/workflows/wf-checkout */
export function entityDir(node: Pick<MindPlanNode, "id" | "type">): string {
  return path.join(mindplanRoot(), TYPE_DIRS[node.type], node.id);
}

/** Project-relative path to an entity folder, e.g. mindplan/workflows/wf-checkout */
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

export type InstallAgentRuleResult = {
  installed: boolean;
  path: string;
};

export type InstallSkillResult = {
  installed: boolean;
  path: string;
};

function projectRoot(): string {
  return process.env.MINDPLAN_ROOT ?? process.cwd();
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** Copies the bundled agent rule into .cursor/rules/mindplan.mdc (idempotent). */
export function installAgentRule(packageRoot: string): InstallAgentRuleResult {
  const templatePath = path.join(packageRoot, "templates", "mindplan-agent.mdc");
  const destPath = path.join(projectRoot(), ".cursor", "rules", "mindplan.mdc");

  if (fs.existsSync(destPath)) {
    return { installed: false, path: destPath };
  }

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Agent rule template not found at ${templatePath}`);
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(templatePath, destPath);
  return { installed: true, path: destPath };
}

/** Copies the define-entities skill into .cursor/skills/mindplan-define-entities/ (idempotent). */
export function installDefineEntitiesSkill(packageRoot: string): InstallSkillResult {
  const templateDir = path.join(packageRoot, "templates", "mindplan-define-entities");
  const destDir = path.join(projectRoot(), ".cursor", "skills", "mindplan-define-entities");

  if (fs.existsSync(destDir)) {
    return { installed: false, path: destDir };
  }

  if (!fs.existsSync(templateDir)) {
    throw new Error(`Skill template not found at ${templateDir}`);
  }

  copyDirRecursive(templateDir, destDir);
  return { installed: true, path: destDir };
}

/** Scaffolds an empty mindplan/ tree in the consumer project (idempotent). */
export function initProject(): InitResult {
  const root = mindplanRoot();
  const existed = fs.existsSync(root);
  ensureDirectories();
  return { root, created: !existed };
}

/** Creates /mindplan, top-level type directories, and components/ if missing. */
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

export type ParsedFrontmatter = {
  scalars: Record<string, string>;
  arrays: Record<EdgeField, string[]>;
};

function isEdgeField(key: string): key is EdgeField {
  return (EDGE_FIELDS as readonly string[]).includes(key);
}

/** Parses YAML frontmatter scalars and MCP edge array fields. */
export function parseFrontmatter(raw: string): ParsedFrontmatter | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const scalars: Record<string, string> = {};
  const arrays: Record<EdgeField, string[]> = {
    belongs_to: [],
    depends_on: [],
    affects: [],
    supersedes: [],
  };

  const lines = match[1].split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const keyOnly = line.match(/^([\w]+):\s*$/);
    if (keyOnly && isEdgeField(keyOnly[1])) {
      const field = keyOnly[1];
      const items: string[] = [];
      i++;
      while (i < lines.length && /^\s+-\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s+-\s+/, "").trim());
        i++;
      }
      arrays[field] = items;
      continue;
    }

    const inlineArray = line.match(/^([\w]+):\s*\[(.*)\]\s*$/);
    if (inlineArray && isEdgeField(inlineArray[1])) {
      const field = inlineArray[1];
      const inner = inlineArray[2].trim();
      arrays[field] = inner
        ? inner.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
      i++;
      continue;
    }

    const scalar = line.match(/^([\w]+):\s*(.*)$/);
    if (scalar) {
      let val = scalar[2].trim();
      if (val.startsWith('"')) {
        try {
          val = JSON.parse(val) as string;
        } catch {
          /* use raw */
        }
      }
      scalars[scalar[1]] = val;
    }
    i++;
  }

  return { scalars, arrays };
}

function stripEdgeFieldLines(inner: string): string {
  const lines = inner.split(/\r?\n/);
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (/^(belongs_to|depends_on|affects|supersedes):/.test(lines[i])) {
      i++;
      while (i < lines.length && /^\s+-\s+/.test(lines[i])) i++;
      continue;
    }
    result.push(lines[i]);
    i++;
  }
  return result.join("\n").replace(/\n+$/, "");
}

function formatEdgeFieldLines(arrays: Partial<Record<EdgeField, string[]>>): string {
  const parts: string[] = [];
  for (const field of EDGE_FIELDS) {
    const ids = arrays[field];
    if (!ids || ids.length === 0) continue;
    parts.push(`${field}:`);
    for (const id of ids) parts.push(`  - ${id}`);
  }
  return parts.join("\n");
}

function parseNodeFromFrontmatter(
  folderId: string,
  expectedType: NodeType,
  contextFile: string
): MindPlanNode {
  const raw = fs.readFileSync(contextFile, "utf-8");
  const parsed = parseFrontmatter(raw);
  if (!parsed) {
    throw new Error(
      `Blocked: context file for "${folderId}" has no YAML frontmatter (expected at ${contextFile}).`
    );
  }
  const fm = parsed.scalars;
  const id = fm.id ?? folderId;
  const type = fm.type as NodeType;
  if (id !== folderId) {
    throw new Error(
      `Blocked: folder "${folderId}" does not match frontmatter id "${id}" in ${contextFile}.`
    );
  }
  if (!NODE_TYPES.includes(type)) {
    throw new Error(`Blocked: invalid type "${fm.type}" in ${contextFile}.`);
  }
  if (type !== expectedType) {
    throw new Error(
      `Blocked: frontmatter type "${type}" does not match directory type "${expectedType}" for "${folderId}".`
    );
  }
  if (!fm.state || !fm.created_at || !fm.updated_at) {
    throw new Error(
      `Blocked: context frontmatter for "${folderId}" must include state, created_at, and updated_at.`
    );
  }
  const node: MindPlanNode = {
    id,
    type,
    title: fm.title ?? "",
    description: fm.description ?? "",
    state: fm.state as MindPlanNode["state"],
    created_at: fm.created_at,
    updated_at: fm.updated_at,
  };
  if (fm.shipped_at) node.shipped_at = fm.shipped_at;
  if (fm.severity && (BUG_SEVERITIES as readonly string[]).includes(fm.severity)) {
    node.severity = fm.severity as BugSeverity;
  }
  if (parsed.arrays.belongs_to.length > 0) node.belongs_to = [...parsed.arrays.belongs_to];
  if (parsed.arrays.depends_on.length > 0) node.depends_on = [...parsed.arrays.depends_on];
  if (parsed.arrays.affects.length > 0) node.affects = [...parsed.arrays.affects];
  if (parsed.arrays.supersedes.length > 0) node.supersedes = [...parsed.arrays.supersedes];
  return node;
}

/** Scans territory folders and assembles nodes from context.mdx frontmatter. */
export function discoverNodes(): MindPlanNode[] {
  const nodes: MindPlanNode[] = [];
  const root = mindplanRoot();
  if (!fs.existsSync(root)) return nodes;

  for (const [dirName, nodeType] of Object.entries(DIR_TO_TYPE)) {
    const typePath = path.join(root, dirName);
    if (!fs.existsSync(typePath)) continue;
    for (const entry of fs.readdirSync(typePath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const contextFile = path.join(typePath, entry.name, CONTEXT_FILENAME);
      if (!fs.existsSync(contextFile)) continue;
      nodes.push(parseNodeFromFrontmatter(entry.name, nodeType, contextFile));
    }
  }
  return nodes.sort((a, b) => a.id.localeCompare(b.id));
}

/** Expands outgoing edge arrays on nodes into flat edge triples. */
export function discoverEdges(nodes: MindPlanNode[]): MindPlanEdge[] {
  const edges: MindPlanEdge[] = [];
  for (const node of nodes) {
    if (node.belongs_to) {
      for (const target of node.belongs_to) {
        edges.push({ source: node.id, target, type: "belongs_to" });
      }
    }
    if (node.depends_on) {
      for (const target of node.depends_on) {
        edges.push({ source: node.id, target, type: "depends_on" });
      }
    }
    if (node.affects) {
      for (const target of node.affects) {
        edges.push({ source: node.id, target, type: "affects" });
      }
    }
    if (node.supersedes) {
      for (const target of node.supersedes) {
        edges.push({ source: node.id, target, type: "supersedes" });
      }
    }
  }
  return edges.sort((a, b) => {
    const ka = `${a.source}:${a.type}:${a.target}`;
    const kb = `${b.source}:${b.type}:${b.target}`;
    return ka.localeCompare(kb);
  });
}

export function loadGraph(): MindPlanGraph {
  const nodes = discoverNodes();
  return { version: GRAPH_VERSION, nodes, edges: discoverEdges(nodes) };
}

/** Returns { id, type } if a territory folder exists for this id. */
export function findNodeRef(id: string): Pick<MindPlanNode, "id" | "type"> {
  for (const [dirName, nodeType] of Object.entries(DIR_TO_TYPE)) {
    const contextFile = path.join(mindplanRoot(), dirName, id, CONTEXT_FILENAME);
    if (fs.existsSync(contextFile)) {
      return { id, type: nodeType };
    }
  }
  throw new Error(`Blocked: node "${id}" does not exist in mindplan territory.`);
}

export function nodeExists(id: string): boolean {
  for (const dirName of Object.values(TYPE_DIRS)) {
    if (fs.existsSync(path.join(mindplanRoot(), dirName, id, CONTEXT_FILENAME))) {
      return true;
    }
  }
  return false;
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

/** Patches server-owned state fields in context.mdx frontmatter. */
export function patchFrontmatter(
  node: Pick<MindPlanNode, "id" | "type" | "state" | "updated_at" | "shipped_at">
): void {
  const file = markdownPath(node);
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, "utf-8");
  const frontmatter = raw.match(/^---\r?\n[\s\S]*?\r?\n---/);
  if (!frontmatter) return;

  let patched = frontmatter[0]
    .replace(/^state:.*$/m, `state: ${node.state}`)
    .replace(/^updated_at:.*$/m, `updated_at: ${node.updated_at}`);

  if (node.shipped_at) {
    if (/^shipped_at:/m.test(patched)) {
      patched = patched.replace(/^shipped_at:.*$/m, `shipped_at: ${node.shipped_at}`);
    } else {
      patched = patched.replace(/^(state:.*)$/m, `$1\nshipped_at: ${node.shipped_at}`);
    }
  }

  if (patched !== frontmatter[0]) {
    fs.writeFileSync(file, raw.replace(frontmatter[0], patched), "utf-8");
  }
}

/** Patches MCP-owned outgoing edge arrays in context.mdx frontmatter. */
export function patchFrontmatterEdges(
  node: Pick<MindPlanNode, "id" | "type">,
  edges: Partial<Record<EdgeField, string[]>>,
  updated_at: string
): void {
  const file = markdownPath(node);
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, "utf-8");
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return;

  const parsed = parseFrontmatter(raw);
  if (!parsed) return;

  const merged: Record<EdgeField, string[]> = {
    belongs_to: edges.belongs_to ?? parsed.arrays.belongs_to,
    depends_on: edges.depends_on ?? parsed.arrays.depends_on,
    affects: edges.affects ?? parsed.arrays.affects,
    supersedes: edges.supersedes ?? parsed.arrays.supersedes,
  };

  let inner = stripEdgeFieldLines(match[1]);
  inner = inner.replace(/^updated_at:.*$/m, `updated_at: ${updated_at}`);

  const edgeLines = formatEdgeFieldLines(merged);
  const rebuiltInner = edgeLines ? `${inner}\n${edgeLines}` : inner;
  const rebuilt = `---\n${rebuiltInner}\n---`;
  fs.writeFileSync(file, raw.replace(match[0], rebuilt), "utf-8");
}

/** Appends a target id to the source node's outgoing edge array for edge_type. */
export function addEdgeToFrontmatter(
  node: Pick<MindPlanNode, "id" | "type">,
  edgeType: EdgeType,
  targetId: string
): void {
  const raw = readMarkdown(node);
  const parsed = parseFrontmatter(raw);
  if (!parsed) return;

  const field = edgeType as EdgeField;
  const current = [...parsed.arrays[field]];
  if (!current.includes(targetId)) current.push(targetId);
  const now = new Date().toISOString();
  patchFrontmatterEdges(node, { [field]: current }, now);
}

/** Removes target_id from all outgoing edge arrays on the source node. */
export function removeEdgesFromFrontmatter(
  node: Pick<MindPlanNode, "id" | "type">,
  targetId: string
): void {
  const raw = readMarkdown(node);
  const parsed = parseFrontmatter(raw);
  if (!parsed) return;

  const now = new Date().toISOString();
  patchFrontmatterEdges(
    node,
    {
      belongs_to: parsed.arrays.belongs_to.filter((id) => id !== targetId),
      depends_on: parsed.arrays.depends_on.filter((id) => id !== targetId),
      affects: parsed.arrays.affects.filter((id) => id !== targetId),
      supersedes: parsed.arrays.supersedes.filter((id) => id !== targetId),
    },
    now
  );
}

/** Scaffolds an entity folder: context.mdx + empty attachments/ directory. */
export function scaffoldEntity(
  node: Pick<MindPlanNode, "id" | "type" | "state" | "created_at" | "updated_at">,
  meta: Pick<MindPlanNode, "title" | "description">
): void {
  ensureEntityDir(node);
  const attachmentsKeep = path.join(attachmentsDir(node), ".gitkeep");
  if (!fs.existsSync(attachmentsKeep)) {
    fs.writeFileSync(attachmentsKeep, "", "utf-8");
  }

  const frontmatter = [
    "---",
    `id: ${node.id}`,
    `type: ${node.type}`,
    `title: ${JSON.stringify(meta.title)}`,
    `description: ${JSON.stringify(meta.description)}`,
    `state: ${node.state}`,
    `created_at: ${node.created_at}`,
    `updated_at: ${node.updated_at}`,
    "---",
  ].join("\n");

  let body: string;
  switch (node.type) {
    case "Journey":
      body = [
        `# ${meta.title}`,
        "",
        meta.description,
        "",
        "## Overview",
        "",
        "_Describe the macro user flow this Journey covers._",
        "",
        "## Linked Workflows",
        "",
        "_Workflows link here via `belongs_to` in their frontmatter. The Journey state is computed automatically._",
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
        `# ${meta.title}`,
        "",
        meta.description,
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
        `# ${meta.title}`,
        "",
        meta.description,
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
        `# ${meta.title}`,
        "",
        meta.description,
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
