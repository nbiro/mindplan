/**
 * File system persistence for MindPlan.
 *
 * Layout (relative to the project root, i.e. MINDPLAN_ROOT or process.cwd()):
 *   /mindplan/map.md                       — auto-generated Mermaid snapshot (after each mutation)
 *   /mindplan/components/                  — project-specific MDX components (opaque to the compiler)
 *   /mindplan/journeys/<id>/current.mdx
 *   /mindplan/foundations/<id>/current.mdx (+ optional next.mdx)
 *   /mindplan/workflows/<id>/current.mdx (+ optional next.mdx)
 *   /mindplan/bugs/<id>/current.mdx
 *   /src/workflows/<id>/                   — Workflow implementation package
 *   /src/foundations/<id>/                 — Foundation implementation package
 *
 * Live node records and outgoing edge arrays live in current.mdx YAML frontmatter.
 * While evolving a shipped Foundation/Workflow, next.mdx holds the draft pipeline + proposed edges.
 */

import * as fs from "fs";
import * as path from "path";
import type {
  BugSeverity,
  EdgeType,
  MindPlanEdge,
  MindPlanGraph,
  MindPlanNode,
  NextPipelineState,
  NextSlot,
  NodeType,
} from "../f-domain-model/types.js";
import { BUG_SEVERITIES, GRAPH_VERSION, isNextPipelineState, NODE_TYPES } from "../f-domain-model/types.js";

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

const EDGE_FIELDS = ["belongs_to", "depends_on", "affects"] as const;
type EdgeField = (typeof EDGE_FIELDS)[number];

export const MINDPLAN_DIR = "mindplan";
export const AGENT_DIR = "agent";
export const SRC_DIR = "src";
export const CURRENT_FILENAME = "current.mdx";
export const NEXT_FILENAME = "next.mdx";
/** @deprecated Use CURRENT_FILENAME */
export const CONTEXT_FILENAME = CURRENT_FILENAME;
export const ATTACHMENTS_DIR = "attachments";
export const NEXT_ATTACHMENTS_DIR = "next-attachments";
export const COMPONENTS_DIR = "components";

export type TerritorySlot = "current" | "next";
export function mindplanRoot(): string {
  return path.join(process.env.MINDPLAN_ROOT ?? process.cwd(), MINDPLAN_DIR);
}

export function agentRoot(): string {
  return path.join(mindplanRoot(), AGENT_DIR);
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

/**
 * Project-relative implementation package root for Workflow/Foundation, or null for Journey/Bug.
 * e.g. src/workflows/wf-checkout
 */
export function implementationRelativePath(
  node: Pick<MindPlanNode, "id" | "type">
): string | null {
  if (node.type !== "Workflow" && node.type !== "Foundation") return null;
  return path.posix.join(SRC_DIR, TYPE_DIRS[node.type], node.id);
}

/** Absolute path to the implementation package directory, or null. */
export function implementationDir(node: Pick<MindPlanNode, "id" | "type">): string | null {
  const rel = implementationRelativePath(node);
  if (!rel) return null;
  return path.join(projectRoot(), ...rel.split("/"));
}

/** Scaffolds src/workflows/<id> or src/foundations/<id> with .gitkeep. No-op for Journey/Bug. */
export function scaffoldImplementationPackage(
  node: Pick<MindPlanNode, "id" | "type">
): string | null {
  const abs = implementationDir(node);
  const rel = implementationRelativePath(node);
  if (!abs || !rel) return null;
  fs.mkdirSync(abs, { recursive: true });
  const keep = path.join(abs, ".gitkeep");
  if (!fs.existsSync(keep)) {
    fs.writeFileSync(keep, "", "utf-8");
  }
  return rel;
}

/**
 * Returns prescribed implementation package info for a Workflow or Foundation.
 * Throws Blocked for Journey/Bug.
 */
export function getNodeImplementation(node: MindPlanNode): {
  node_id: string;
  root: string;
  exists: boolean;
  entries?: string[];
} {
  const root = implementationRelativePath(node);
  if (!root) {
    throw new Error(
      `Blocked: get_node_implementation only applies to Workflow and Foundation nodes; "${node.id}" is a ${node.type}.`
    );
  }
  const abs = implementationDir(node)!;
  const exists = fs.existsSync(abs) && fs.statSync(abs).isDirectory();
  if (!exists) {
    return { node_id: node.id, root, exists: false, entries: [] };
  }
  const entries = fs
    .readdirSync(abs)
    .filter((name) => name !== "." && name !== "..")
    .sort((a, b) => a.localeCompare(b));
  return { node_id: node.id, root, exists: true, entries };
}

export function markdownPath(
  node: Pick<MindPlanNode, "id" | "type">,
  slot: TerritorySlot = "current"
): string {
  return path.join(entityDir(node), slot === "next" ? NEXT_FILENAME : CURRENT_FILENAME);
}

export function attachmentsDir(node: Pick<MindPlanNode, "id" | "type">): string {
  return path.join(entityDir(node), ATTACHMENTS_DIR);
}

export function nextAttachmentsDir(node: Pick<MindPlanNode, "id" | "type">): string {
  return path.join(entityDir(node), NEXT_ATTACHMENTS_DIR);
}

export function nextExists(node: Pick<MindPlanNode, "id" | "type">): boolean {
  return fs.existsSync(markdownPath(node, "next"));
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

export function projectRoot(): string {
  return process.env.MINDPLAN_ROOT ?? process.cwd();
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
    if (/^(belongs_to|depends_on|affects):/.test(lines[i])) {
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
      `Blocked: current file for "${folderId}" has no YAML frontmatter (expected at ${contextFile}).`
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
      `Blocked: current frontmatter for "${folderId}" must include state, created_at, and updated_at.`
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
  return node;
}

function parseNextSlot(folderId: string, nextFile: string): NextSlot {
  const raw = fs.readFileSync(nextFile, "utf-8");
  const parsed = parseFrontmatter(raw);
  if (!parsed) {
    throw new Error(
      `Blocked: next file for "${folderId}" has no YAML frontmatter (expected at ${nextFile}).`
    );
  }
  const fm = parsed.scalars;
  if (!fm.state || !fm.updated_at) {
    throw new Error(
      `Blocked: next frontmatter for "${folderId}" must include state and updated_at.`
    );
  }
  if (!isNextPipelineState(fm.state)) {
    throw new Error(
      `Blocked: next.mdx for "${folderId}" has invalid pipeline state "${fm.state}". ` +
        `Allowed: draft, ready, in-progress, in-review.`
    );
  }
  const slot: NextSlot = {
    state: fm.state as NextPipelineState,
    title: fm.title ?? "",
    description: fm.description ?? "",
    updated_at: fm.updated_at,
  };
  if (parsed.arrays.belongs_to.length > 0) slot.belongs_to = [...parsed.arrays.belongs_to];
  if (parsed.arrays.depends_on.length > 0) slot.depends_on = [...parsed.arrays.depends_on];
  return slot;
}

/** Scans territory folders and assembles nodes from current.mdx (+ optional next.mdx). */
export function discoverNodes(): MindPlanNode[] {
  const nodes: MindPlanNode[] = [];
  const root = mindplanRoot();
  if (!fs.existsSync(root)) return nodes;

  for (const [dirName, nodeType] of Object.entries(DIR_TO_TYPE)) {
    const typePath = path.join(root, dirName);
    if (!fs.existsSync(typePath)) continue;
    for (const entry of fs.readdirSync(typePath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const currentFile = path.join(typePath, entry.name, CURRENT_FILENAME);
      if (!fs.existsSync(currentFile)) continue;
      const node = parseNodeFromFrontmatter(entry.name, nodeType, currentFile);
      const nextFile = path.join(typePath, entry.name, NEXT_FILENAME);
      if (fs.existsSync(nextFile)) {
        if (nodeType !== "Foundation" && nodeType !== "Workflow") {
          throw new Error(
            `Blocked: next.mdx is only allowed for Foundations and Workflows (found on ${nodeType} "${entry.name}").`
          );
        }
        node.next = parseNextSlot(entry.name, nextFile);
      }
      nodes.push(node);
    }
  }
  return nodes.sort((a, b) => a.id.localeCompare(b.id));
}

/** Expands outgoing edge arrays on nodes into flat edge triples (live/current edges only). */
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
    const currentFile = path.join(mindplanRoot(), dirName, id, CURRENT_FILENAME);
    if (fs.existsSync(currentFile)) {
      return { id, type: nodeType };
    }
  }
  throw new Error(`Blocked: node "${id}" does not exist in mindplan territory.`);
}

export function nodeExists(id: string): boolean {
  for (const dirName of Object.values(TYPE_DIRS)) {
    if (fs.existsSync(path.join(mindplanRoot(), dirName, id, CURRENT_FILENAME))) {
      return true;
    }
  }
  return false;
}

export function readMarkdown(
  node: Pick<MindPlanNode, "id" | "type">,
  slot: TerritorySlot = "current"
): string {
  const file = markdownPath(node, slot);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Blocked: ${slot} file not found for node "${node.id}" (expected at ${file}).`
    );
  }
  return fs.readFileSync(file, "utf-8");
}

export function writeMarkdown(
  node: Pick<MindPlanNode, "id" | "type">,
  content: string,
  slot: TerritorySlot = "current"
): void {
  ensureEntityDir(node);
  fs.writeFileSync(markdownPath(node, slot), content, "utf-8");
}

/** Patches server-owned state fields in current.mdx or next.mdx frontmatter. */
export function patchFrontmatter(
  node: Pick<MindPlanNode, "id" | "type" | "state" | "updated_at" | "shipped_at">,
  slot: TerritorySlot = "current"
): void {
  const file = markdownPath(node, slot);
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, "utf-8");
  const frontmatter = raw.match(/^---\r?\n[\s\S]*?\r?\n---/);
  if (!frontmatter) return;

  let patched = frontmatter[0]
    .replace(/^state:.*$/m, `state: ${node.state}`)
    .replace(/^updated_at:.*$/m, `updated_at: ${node.updated_at}`);

  if (slot === "current" && node.shipped_at) {
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

/** Patches MCP-owned outgoing edge arrays in current.mdx or next.mdx frontmatter. */
export function patchFrontmatterEdges(
  node: Pick<MindPlanNode, "id" | "type">,
  edges: Partial<Record<EdgeField, string[]>>,
  updated_at: string,
  slot: TerritorySlot = "current"
): void {
  const file = markdownPath(node, slot);
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
  };

  let inner = stripEdgeFieldLines(match[1]);
  inner = inner.replace(/^updated_at:.*$/m, `updated_at: ${updated_at}`);

  const edgeLines = formatEdgeFieldLines(merged);
  const rebuiltInner = edgeLines ? `${inner}\n${edgeLines}` : inner;
  const rebuilt = `---\n${rebuiltInner}\n---`;
  fs.writeFileSync(file, raw.replace(match[0], rebuilt), "utf-8");
}

/** Resolves which territory slot receives belongs_to/depends_on mutations. */
export function edgeWriteSlot(node: MindPlanNode, edgeType: EdgeType): TerritorySlot {
  if (
    node.next &&
    (edgeType === "belongs_to" || edgeType === "depends_on") &&
    (node.type === "Workflow" || node.type === "Foundation")
  ) {
    return "next";
  }
  return "current";
}

/** Appends a target id to the source node's outgoing edge array for edge_type. */
export function addEdgeToFrontmatter(
  node: MindPlanNode,
  edgeType: EdgeType,
  targetId: string
): void {
  const slot = edgeWriteSlot(node, edgeType);
  const raw = readMarkdown(node, slot);
  const parsed = parseFrontmatter(raw);
  if (!parsed) return;

  const field = edgeType as EdgeField;
  const current = [...parsed.arrays[field]];
  if (!current.includes(targetId)) current.push(targetId);
  const now = new Date().toISOString();
  patchFrontmatterEdges(node, { [field]: current }, now, slot);
}

/** Removes target_id from all outgoing edge arrays on the source node (current and next). */
export function removeEdgesFromFrontmatter(
  node: MindPlanNode,
  targetId: string
): void {
  const now = new Date().toISOString();
  for (const slot of ["current", "next"] as const) {
    if (slot === "next" && !nextExists(node)) continue;
    const raw = readMarkdown(node, slot);
    const parsed = parseFrontmatter(raw);
    if (!parsed) continue;
    patchFrontmatterEdges(
      node,
      {
        belongs_to: parsed.arrays.belongs_to.filter((id) => id !== targetId),
        depends_on: parsed.arrays.depends_on.filter((id) => id !== targetId),
        affects: parsed.arrays.affects.filter((id) => id !== targetId),
      },
      now,
      slot
    );
  }
}

/** Scaffolds an entity folder: current.mdx + empty attachments/ directory. */
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
        "_Name the domain capability this Journey owns and which use cases belong inside it. Journey titles alone should scream the product purpose — not the tech stack._",
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
        "## Shared Substrate Spec",
        "",
        "_Role belongs in frontmatter `description` at create time (e.g. `Assembler — …`, `Infra — …`, `Design system — …`, `Adapter — …`). Document shared substrate here: schemas, adapters, design system, contracts. MUST NOT own stakeholder-recognizable use-case behaviour — that belongs in Workflows. Implement code only under `src/foundations/<id>/`._",
        "",
        "## Checklist",
        "",
        "- [ ] Spec written",
        "- [ ] Implementation complete",
        "- [ ] Verified in target environment",
        "",
        "## Attachments",
        "",
        `_Schemas, OpenAPI exports, ER diagrams, design tokens, etc. go in \`attachments/\`._`,
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
        "_Describe the use case step by step — the application-specific business logic this feature implements. Implement code only under `src/workflows/<id>/`. Before inventing shared UI, depend on a Foundation (e.g. design system)._",
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

  writeMarkdown(node, `${frontmatter}\n\n${body}`, "current");
  scaffoldImplementationPackage(node);
}

/**
 * Completion Check helper: returns the number of unchecked `[ ]` checkboxes
 * in current.mdx or next.mdx. Markdown checkboxes are `- [ ]` / `- [x]` list items.
 */
export function countUncheckedBoxes(
  node: Pick<MindPlanNode, "id" | "type">,
  slot: TerritorySlot = "current"
): number {
  const raw = readMarkdown(node, slot);
  const matches = raw.match(/^\s*[-*+]\s+\[ \]/gm);
  return matches ? matches.length : 0;
}

/** Splits raw territory MDX into YAML frontmatter block and body. */
export function splitContext(raw: string): { frontmatter: string; body: string } | null {
  const match = raw.match(/^(---\r?\n[\s\S]*?\r?\n---)(\r?\n?)([\s\S]*)$/);
  if (!match) return null;
  return { frontmatter: match[1], body: match[3] };
}

/** Authoritative graph slice for MCP read responses (excludes raw frontmatter duplication). */
export function nodeToRecord(node: MindPlanNode): Record<string, unknown> {
  const record: Record<string, unknown> = {
    id: node.id,
    type: node.type,
    state: node.state,
    title: node.title,
    description: node.description,
    created_at: node.created_at,
    updated_at: node.updated_at,
  };
  if (node.shipped_at) record.shipped_at = node.shipped_at;
  if (node.severity) record.severity = node.severity;
  if (node.belongs_to?.length) record.belongs_to = [...node.belongs_to];
  if (node.depends_on?.length) record.depends_on = [...node.depends_on];
  if (node.affects?.length) record.affects = [...node.affects];
  if (node.next) {
    record.next = {
      state: node.next.state,
      title: node.next.title,
      description: node.next.description,
      updated_at: node.next.updated_at,
      ...(node.next.belongs_to?.length ? { belongs_to: [...node.next.belongs_to] } : {}),
      ...(node.next.depends_on?.length ? { depends_on: [...node.next.depends_on] } : {}),
    };
  }
  return record;
}

export type PatchNodeTerritoryInput = {
  title?: string;
  description?: string;
  body?: string;
  toggle_checkboxes?: { contains: string; checked: boolean }[];
  /** Override default slot selection. */
  slot?: TerritorySlot;
};

/**
 * Default patch target: when a shipped Foundation/Workflow has next.mdx, patches go to next.
 * Otherwise current. Explicit `slot` overrides.
 */
export function resolveTerritorySlot(
  node: MindPlanNode,
  explicit?: TerritorySlot
): TerritorySlot {
  if (explicit) {
    if (explicit === "next" && !node.next) {
      throw new Error(`Blocked: node "${node.id}" has no next.mdx evolution slot.`);
    }
    return explicit;
  }
  if (
    node.next &&
    (node.type === "Foundation" || node.type === "Workflow") &&
    (node.state === "stable" || node.state === "unstable")
  ) {
    return "next";
  }
  return "current";
}

function toggleCheckboxesInBody(
  body: string,
  toggles: { contains: string; checked: boolean }[]
): string {
  const lines = body.split(/\r?\n/);
  for (const toggle of toggles) {
    let matched = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/^\s*[-*+]\s+\[[ x]\]/.test(line) || !line.includes(toggle.contains)) continue;
      lines[i] = line.replace(
        /^\s*([-*+]\s+)\[[ x]\]/,
        (_, prefix) => `${prefix}[${toggle.checked ? "x" : " "}]`
      );
      matched = true;
      break;
    }
    if (!matched) {
      throw new Error(
        `Blocked: no checkbox line containing "${toggle.contains}" in territory body.`
      );
    }
  }
  return lines.join("\n");
}

function patchTerritoryScalars(
  frontmatter: string,
  scalars: { title?: string; description?: string },
  updated_at: string
): string {
  let patched = frontmatter;
  if (scalars.title !== undefined) {
    patched = patched.replace(/^title:.*$/m, `title: ${JSON.stringify(scalars.title)}`);
  }
  if (scalars.description !== undefined) {
    patched = patched.replace(
      /^description:.*$/m,
      `description: ${JSON.stringify(scalars.description)}`
    );
  }
  return patched.replace(/^updated_at:.*$/m, `updated_at: ${updated_at}`);
}

/**
 * Patches territory-owned content (body and title/description scalars).
 * Server-owned frontmatter fields (except updated_at on territory edits) are never modified here.
 */
export function patchNodeTerritory(
  node: MindPlanNode,
  input: PatchNodeTerritoryInput
): { patched_fields: string[]; slot: TerritorySlot } {
  const slot = resolveTerritorySlot(node, input.slot);
  const raw = readMarkdown(node, slot);
  const split = splitContext(raw);
  if (!split) {
    throw new Error(`Blocked: ${slot} file for "${node.id}" has no YAML frontmatter.`);
  }

  const patched_fields: string[] = [];
  const now = new Date().toISOString();
  let { frontmatter, body } = split;

  if (input.title !== undefined) {
    frontmatter = patchTerritoryScalars(frontmatter, { title: input.title }, now);
    patched_fields.push("title");
  }
  if (input.description !== undefined) {
    frontmatter = patchTerritoryScalars(frontmatter, { description: input.description }, now);
    patched_fields.push("description");
  }
  if (input.body !== undefined) {
    body = input.body;
    patched_fields.push("body");
    frontmatter = frontmatter.replace(/^updated_at:.*$/m, `updated_at: ${now}`);
  }
  if (input.toggle_checkboxes?.length) {
    body = toggleCheckboxesInBody(body, input.toggle_checkboxes);
    patched_fields.push("toggle_checkboxes");
    frontmatter = frontmatter.replace(/^updated_at:.*$/m, `updated_at: ${now}`);
  }

  if (patched_fields.length === 0) {
    throw new Error(
      "Blocked: patch_node_territory requires at least one of title, description, body, or toggle_checkboxes."
    );
  }

  writeMarkdown(node, `${frontmatter}\n\n${body}`, slot);
  return { patched_fields, slot };
}

/**
 * Opens next.mdx for a shipped Foundation/Workflow by copying current territory into a draft slot.
 */
export function openNextSlot(
  node: MindPlanNode,
  meta?: { title?: string; description?: string }
): NextSlot {
  if (nextExists(node)) {
    throw new Error(`Blocked: "${node.id}" already has a next.mdx evolution slot.`);
  }
  const now = new Date().toISOString();
  const currentRaw = readMarkdown(node, "current");
  const split = splitContext(currentRaw);
  if (!split) {
    throw new Error(`Blocked: current file for "${node.id}" has no YAML frontmatter.`);
  }

  const title = meta?.title ?? node.title;
  const description = meta?.description ?? node.description;

  const frontmatterLines = [
    "---",
    `id: ${node.id}`,
    `type: ${node.type}`,
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    "state: draft",
    `updated_at: ${now}`,
  ];
  if (node.belongs_to?.length) {
    frontmatterLines.push("belongs_to:");
    for (const id of node.belongs_to) frontmatterLines.push(`  - ${id}`);
  }
  if (node.depends_on?.length) {
    frontmatterLines.push("depends_on:");
    for (const id of node.depends_on) frontmatterLines.push(`  - ${id}`);
  }
  frontmatterLines.push("---");

  writeMarkdown(node, `${frontmatterLines.join("\n")}\n\n${split.body}`, "next");
  fs.mkdirSync(nextAttachmentsDir(node), { recursive: true });
  const keep = path.join(nextAttachmentsDir(node), ".gitkeep");
  if (!fs.existsSync(keep)) fs.writeFileSync(keep, "", "utf-8");

  const slot: NextSlot = {
    state: "draft",
    title,
    description,
    updated_at: now,
  };
  if (node.belongs_to?.length) slot.belongs_to = [...node.belongs_to];
  if (node.depends_on?.length) slot.depends_on = [...node.depends_on];
  return slot;
}

/** Deletes next.mdx and next-attachments/, abandoning an in-flight evolution. */
export function discardNextSlot(node: Pick<MindPlanNode, "id" | "type">): void {
  const nextFile = markdownPath(node, "next");
  if (!fs.existsSync(nextFile)) {
    throw new Error(`Blocked: node "${node.id}" has no next.mdx to discard.`);
  }
  fs.unlinkSync(nextFile);
  const nextAtt = nextAttachmentsDir(node);
  if (fs.existsSync(nextAtt)) {
    fs.rmSync(nextAtt, { recursive: true, force: true });
  }
}

/**
 * Promotes next.mdx over current.mdx: copies next body/scalars/edges into current with
 * production state, then deletes the next slot.
 */
export function promoteNextSlot(
  node: MindPlanNode,
  productionState: string,
  shippedAt: string
): void {
  if (!node.next) {
    throw new Error(`Blocked: node "${node.id}" has no next.mdx to promote.`);
  }
  const nextRaw = readMarkdown(node, "next");
  const nextSplit = splitContext(nextRaw);
  if (!nextSplit) {
    throw new Error(`Blocked: next file for "${node.id}" has no YAML frontmatter.`);
  }
  const nextParsed = parseFrontmatter(nextRaw);
  if (!nextParsed) {
    throw new Error(`Blocked: next file for "${node.id}" has no YAML frontmatter.`);
  }

  const title = nextParsed.scalars.title ?? node.next.title;
  const description = nextParsed.scalars.description ?? node.next.description;
  const belongs_to = nextParsed.arrays.belongs_to;
  const depends_on = nextParsed.arrays.depends_on;

  const frontmatterLines = [
    "---",
    `id: ${node.id}`,
    `type: ${node.type}`,
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    `state: ${productionState}`,
    `shipped_at: ${shippedAt}`,
    `created_at: ${node.created_at}`,
    `updated_at: ${shippedAt}`,
  ];
  if (belongs_to.length > 0) {
    frontmatterLines.push("belongs_to:");
    for (const id of belongs_to) frontmatterLines.push(`  - ${id}`);
  }
  if (depends_on.length > 0) {
    frontmatterLines.push("depends_on:");
    for (const id of depends_on) frontmatterLines.push(`  - ${id}`);
  }
  frontmatterLines.push("---");

  writeMarkdown(node, `${frontmatterLines.join("\n")}\n\n${nextSplit.body}`, "current");

  // Merge next-attachments into attachments when present
  const nextAtt = nextAttachmentsDir(node);
  if (fs.existsSync(nextAtt)) {
    const dest = attachmentsDir(node);
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(nextAtt, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name === ".gitkeep") continue;
      fs.copyFileSync(path.join(nextAtt, entry.name), path.join(dest, entry.name));
    }
  }

  discardNextSlot(node);

  node.title = title;
  node.description = description;
  node.state = productionState as MindPlanNode["state"];
  node.shipped_at = shippedAt;
  node.updated_at = shippedAt;
  if (belongs_to.length > 0) node.belongs_to = [...belongs_to];
  else delete node.belongs_to;
  if (depends_on.length > 0) node.depends_on = [...depends_on];
  else delete node.depends_on;
  delete node.next;
}
