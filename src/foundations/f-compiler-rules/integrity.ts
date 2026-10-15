/**
 * Import and stale-text integrity rules shared by the check, the claim step, and the
 * ship gate. Pure graph + disk reads: no territory writes.
 */

import * as fs from "fs";
import * as path from "path";
import type {
  EdgeType,
  MindPlanGraph,
  MindPlanNode,
} from "../f-domain-model/types.js";
import { isPipelineNodeType } from "../f-domain-model/types.js";
import { expandClaims } from "../f-source-index/claims.js";
import { listResolvedImports } from "../f-source-index/imports.js";
import {
  buildOwnershipIndex,
  exclusiveOwner,
  type OwnershipBuckets,
} from "../f-source-index/ownership.js";
import { listUniverseFiles } from "../f-source-index/universe.js";
import {
  markdownRelativePath,
  readMarkdown,
  splitContext,
  splitNodeRules,
} from "../f-territory-store/store.js";
import {
  assertAcyclicDependsOn,
  blocked,
  effectiveRole,
  importAllowed,
} from "./rules.js";

const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** The exact write that makes an import legal, when one exists. */
export type ImportFix = {
  tool: "link_nodes";
  args: { source_id: string; target_id: string; edge_type: EdgeType };
};

export type ImportViolation = {
  file: string;
  imports: string;
  from_owner: string;
  to_owner: string;
  /** Present when a graph edge would make the import legal. */
  fix: ImportFix | null;
  /** Present when no edge can make the import legal. */
  not_allowed: string | null;
  message: string;
};

function formatFix(fix: ImportFix): string {
  return `Fix: ${fix.tool}(${JSON.stringify(fix.args)}).`;
}

function wouldCycle(graph: MindPlanGraph, source: string, target: string): boolean {
  try {
    assertAcyclicDependsOn(graph, source, target);
    return false;
  } catch {
    return true;
  }
}

/** What to do about an illegal import `from` -> `to`: an edge to add, or why it can never be legal. */
function resolveImportRemedy(
  from: MindPlanNode,
  to: MindPlanNode,
  graph: MindPlanGraph
): { fix: ImportFix | null; not_allowed: string | null } {
  const link = (edge_type: EdgeType): ImportFix => ({
    tool: "link_nodes",
    args: { source_id: from.id, target_id: to.id, edge_type },
  });

  if (from.type === "Interaction") {
    if (to.type === "Foundation") return { fix: link("depends_on"), not_allowed: null };
    if (to.type === "Interaction") {
      return {
        fix: null,
        not_allowed:
          "not allowed: an Interaction may not import another Interaction (Interaction Independence). Move the shared code into a Foundation both depend on.",
      };
    }
    return { fix: null, not_allowed: "not allowed: an Interaction may not import an Interface." };
  }

  if (from.type === "Interface") {
    if (to.type === "Foundation") return { fix: link("depends_on"), not_allowed: null };
    if (to.type === "Interaction") return { fix: link("exposes"), not_allowed: null };
    return { fix: null, not_allowed: "not allowed: an Interface may not import another Interface." };
  }

  if (from.type === "Foundation") {
    if (to.type === "Foundation") {
      if (wouldCycle(graph, from.id, to.id)) {
        return {
          fix: null,
          not_allowed: `not allowed: "${from.id}" depends_on "${to.id}" would create a dependency cycle.`,
        };
      }
      return { fix: link("depends_on"), not_allowed: null };
    }
    if (to.type === "Interface") {
      return {
        fix: link("mounts"),
        not_allowed:
          "not allowed: a Foundation may not import an Interface unless it mounts it. If this file is a composition root (registry, route dispatcher), declare the mount.",
      };
    }
    return { fix: null, not_allowed: "not allowed: a Foundation may not import an Interaction." };
  }

  return { fix: null, not_allowed: "not allowed." };
}

function describeTarget(to: MindPlanNode): string {
  return (
    `owner "${to.id}" / ${to.type}` +
    `${to.type === "Foundation" ? ` role=${effectiveRole(to) ?? "?"}` : ""}`
  );
}

/**
 * Illegal imports of `files`, all owned by `owner`. Targets resolve through `buckets`;
 * a target the buckets do not own yet but `selfFiles` contains counts as the owner's own.
 */
function scanFiles(
  graph: MindPlanGraph,
  buckets: OwnershipBuckets,
  root: string,
  owner: MindPlanNode,
  files: string[],
  selfFiles?: Set<string>
): ImportViolation[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: ImportViolation[] = [];
  for (const file of files) {
    if (!SOURCE_FILE.test(file)) continue;
    for (const edge of listResolvedImports(file, root)) {
      if (selfFiles?.has(edge.to)) continue;
      const toOwnerId = exclusiveOwner(buckets, edge.to);
      if (!toOwnerId) continue;
      const to = byId.get(toOwnerId);
      if (!to) continue;
      if (importAllowed(owner, to, graph)) continue;
      const remedy = resolveImportRemedy(owner, to, graph);
      const base =
        `imports: "${file}" (owner "${owner.id}") may not import "${edge.to}" (${describeTarget(to)}).`;
      const message = remedy.fix
        ? `${base} ${formatFix(remedy.fix)}`
        : `${base} ${remedy.not_allowed ?? ""}`.trimEnd();
      out.push({
        file,
        imports: edge.to,
        from_owner: owner.id,
        to_owner: to.id,
        fix: remedy.fix,
        not_allowed: remedy.fix ? null : remedy.not_allowed,
        message,
      });
    }
  }
  return out;
}

/** Every illegal import across the ownership universe (the check's import rule). */
export function findAllImportViolations(
  graph: MindPlanGraph,
  buckets: OwnershipBuckets,
  root: string
): ImportViolation[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: ImportViolation[] = [];
  for (const file of listUniverseFiles(root)) {
    const ownerId = exclusiveOwner(buckets, file);
    const owner = ownerId ? byId.get(ownerId) : undefined;
    if (!owner) continue;
    out.push(...scanFiles(graph, buckets, root, owner, [file]));
  }
  return out;
}

/**
 * Illegal imports of the files `claimed` by `node` (claim entries; directories end in `/`).
 * Used when files are claimed, so a missing edge is reported with its link_nodes call.
 */
export function findImportViolationsForClaim(
  graph: MindPlanGraph,
  root: string,
  node: MindPlanNode,
  claimed: string[]
): ImportViolation[] {
  if (!isPipelineNodeType(node.type)) return [];
  const files = expandClaims(claimed, root);
  const buckets = buildOwnershipIndex(graph, root);
  return scanFiles(graph, buckets, root, node, files, new Set(files));
}

/** Illegal imports of the node's active-slot files (next while evolving, else current). */
export function findImportViolationsForNode(
  graph: MindPlanGraph,
  root: string,
  node: MindPlanNode
): ImportViolation[] {
  const claimed = node.next ? node.next.implements : node.implements;
  return findImportViolationsForClaim(graph, root, node, claimed ?? []);
}

/** Active-slot files also claimed by another node. */
export function findOwnershipConflicts(
  graph: MindPlanGraph,
  root: string,
  node: MindPlanNode
): string[] {
  const claimed = node.next ? node.next.implements : node.implements;
  const mine = new Set(expandClaims(claimed ?? [], root));
  const conflicts: string[] = [];
  for (const other of graph.nodes) {
    if (other.id === node.id || !isPipelineNodeType(other.type)) continue;
    if (other.state === "cancelled" || other.state === "deprecated") continue;
    const theirs = expandClaims(other.next ? other.next.implements : other.implements, root);
    for (const f of theirs) {
      if (mine.has(f)) {
        conflicts.push(`ownership: "${f}" claimed by "${node.id}" and "${other.id}".`);
      }
    }
  }
  return conflicts;
}

/**
 * Ship-gate: the check's import and ownership rules on one node's files.
 * Throws `Blocked:` with every violation and its fix.
 */
export function assertCheckCleanForNode(
  graph: MindPlanGraph,
  root: string,
  node: MindPlanNode,
  targetLabel: string
): void {
  if (!isPipelineNodeType(node.type)) return;
  const problems = [
    ...findImportViolationsForNode(graph, root, node).map((v) => v.message),
    ...findOwnershipConflicts(graph, root, node),
  ];
  if (problems.length === 0) return;
  throw blocked(
    `Check failed for "${node.id}" before "${targetLabel}" (${problems.length} violation(s)):\n` +
      problems.map((p) => `- ${p}`).join("\n")
  );
}

// ---------------------------------------------------------------------------
// Stale-text warnings
// ---------------------------------------------------------------------------

const PATH_TOKEN = /`([A-Za-z0-9_.\-][A-Za-z0-9_.\-/]*\/[A-Za-z0-9_.\-/]*)`/g;

/** Which stale-text signals to compute. A node still being built is expected to name files it has not written. */
export type StaleTextScope = { paths: boolean; changed_files: boolean; checkboxes: boolean };

export const STALE_ALL: StaleTextScope = { paths: true, changed_files: true, checkboxes: true };
export const STALE_PATHS_ONLY: StaleTextScope = { paths: true, changed_files: false, checkboxes: false };

/**
 * Non-blocking warnings that the territory text no longer matches the repo:
 * a body names a path that does not exist, a claimed file changed after the body
 * was last written, or checkboxes are still open.
 */
export function staleTextWarnings(
  graph: MindPlanGraph,
  root: string,
  node: MindPlanNode,
  slot: "current" | "next" = node.next ? "next" : "current",
  scope: StaleTextScope = STALE_ALL
): string[] {
  if (!isPipelineNodeType(node.type)) return [];
  const warnings: string[] = [];
  let body = "";
  try {
    const split = splitContext(readMarkdown(node, slot));
    body = splitNodeRules(split?.body ?? "").body;
  } catch {
    return warnings;
  }

  const seen = new Set<string>();
  for (const m of scope.paths ? body.matchAll(PATH_TOKEN) : []) {
    const token = m[1];
    if (seen.has(token)) continue;
    seen.add(token);
    if (/[*<>{}]/.test(token) || token.startsWith("mindplan/")) continue;
    // Relative references point outside the repo root's own layout; their top segment is "." or "..".
    if (token.startsWith("./") || token.startsWith("../")) continue;
    const top = token.split("/")[0];
    // Only repo paths: the first segment must be a real top-level directory.
    const topAbs = path.join(root, top);
    if (!fs.existsSync(topAbs) || !fs.statSync(topAbs).isDirectory()) continue;
    if (!fs.existsSync(path.join(root, ...token.replace(/\/$/, "").split("/")))) {
      warnings.push(`stale: "${node.id}" body names \`${token}\` which does not exist.`);
    }
  }

  // Compare against the territory file's own mtime, not a recorded timestamp: a fresh checkout
  // writes code and territory together, so only an edit made after the body counts.
  let updated = NaN;
  try {
    updated = fs.statSync(path.join(root, ...markdownRelativePath(node, slot).split("/"))).mtimeMs;
  } catch {
    /* no territory file: nothing to compare against */
  }
  if (scope.changed_files && Number.isFinite(updated)) {
    const claimed = slot === "next" && node.next ? node.next.implements : node.implements;
    const newer: string[] = [];
    for (const f of expandClaims(claimed ?? [], root)) {
      try {
        if (fs.statSync(path.join(root, ...f.split("/"))).mtimeMs > updated + 2000) newer.push(f);
      } catch {
        /* missing file is a presence concern, not a stale-text one */
      }
    }
    if (newer.length > 0) {
      const shown = newer.slice(0, 3).map((f) => `"${f}"`).join(", ");
      warnings.push(
        `stale: ${newer.length} claimed file(s) of "${node.id}" changed after its body was last updated ` +
          `(${shown}${newer.length > 3 ? ", ..." : ""}). Re-read the body against the code.`
      );
    }
  }

  const unchecked = scope.checkboxes ? (body.match(/^\s*[-*+]\s+\[ \]/gm) ?? []).length : 0;
  if (unchecked > 0) {
    warnings.push(`stale: "${node.id}" has ${unchecked} unticked checkbox(es); ship Blocks until they are [x].`);
  }
  return warnings;
}
