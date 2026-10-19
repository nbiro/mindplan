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
import { expandClaims, isGlobClaim, validateClaimPath } from "../f-source-index/claims.js";
import { listResolvedImports } from "../f-source-index/imports.js";
import {
  buildOwnershipIndex,
  claimantsOf,
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
  /**
   * Found only through a next-slot or released claim, which the check did not scan before.
   * The check reports it as a warning for one release before it Blocks.
   */
  advisory: boolean;
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
  selfFiles?: Set<string>,
  opts: { releasedTargets?: boolean } = {}
): ImportViolation[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: ImportViolation[] = [];
  for (const file of files) {
    if (!SOURCE_FILE.test(file)) continue;
    for (const edge of listResolvedImports(file, root)) {
      if (selfFiles?.has(edge.to)) continue;
      let toOwnerId = exclusiveOwner(buckets, edge.to);
      let viaReleased = false;
      if (!toOwnerId && opts.releasedTargets && buckets.released.has(edge.to)) {
        toOwnerId = buckets.released.get(edge.to)!;
        viaReleased = true;
      }
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
        advisory: viaReleased,
      });
    }
  }
  return out;
}

/**
 * Every illegal import across the ownership universe (the check's import rule). Each file is
 * scanned as every node that claims it (live, next slot, released), and import targets resolve
 * through released claims too. A violation the exclusive-owner scan alone would not find is
 * `advisory`.
 */
export function findAllImportViolations(
  graph: MindPlanGraph,
  buckets: OwnershipBuckets,
  root: string,
  universe: string[] = listUniverseFiles(root)
): ImportViolation[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: ImportViolation[] = [];
  for (const file of universe) {
    const exclusive = exclusiveOwner(buckets, file);
    const ownerIds = new Set(claimantsOf(buckets, file).map((c) => c.id));
    for (const ownerId of ownerIds) {
      const owner = byId.get(ownerId);
      if (!owner) continue;
      const found = scanFiles(graph, buckets, root, owner, [file], undefined, {
        releasedTargets: true,
      });
      for (const v of found) {
        out.push({ ...v, advisory: v.advisory || ownerId !== exclusive });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Coverage fixes
// ---------------------------------------------------------------------------

/** One call of the fix that claims an unclaimed file for its probable owner. */
export type CoverageFixCall = {
  tool: "open_next" | "set_implementation_files";
  args: Record<string, unknown>;
};

/** Leading directory segments a claim names before any glob or file name. */
function claimDirSegments(claim: string): string[] {
  const parts = claim.replace(/\/$/, "").split("/");
  const firstGlob = parts.findIndex((p) => isGlobClaim(p));
  if (firstGlob >= 0) return parts.slice(0, firstGlob);
  return claim.endsWith("/") ? parts : parts.slice(0, -1);
}

/**
 * The non-retired pipeline node whose claim shares the longest directory prefix with `file`
 * (ties go to the lower id). Sharing only a top-level folder such as `src/` says nothing about
 * ownership, so a file two or more folders deep needs at least two shared folders. Null when
 * no claim is that close.
 */
export function probableOwner(graph: MindPlanGraph, file: string): MindPlanNode | null {
  const fileDirs = file.split("/").slice(0, -1);
  const minScore = Math.min(2, fileDirs.length);
  let best: { node: MindPlanNode; score: number } | null = null;
  const nodes = graph.nodes
    .filter(
      (n) => isPipelineNodeType(n.type) && n.state !== "cancelled" && n.state !== "deprecated"
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const node of nodes) {
    for (const raw of [...(node.implements ?? []), ...(node.next?.implements ?? [])]) {
      let claim: string;
      try {
        claim = validateClaimPath(raw);
      } catch {
        continue;
      }
      const dirs = claimDirSegments(claim);
      let score = 0;
      while (score < dirs.length && score < fileDirs.length && dirs[score] === fileDirs[score]) {
        score++;
      }
      if (score > 0 && score >= minScore && (!best || score > best.score)) best = { node, score };
    }
  }
  return best?.node ?? null;
}

/** The calls that add `file` to the owner's active claim list, opening an evolution first when shipped. */
export function coverageFix(owner: MindPlanNode, file: string): CoverageFixCall[] {
  const shippedIdle = Boolean(owner.shipped_at) && !owner.next;
  const current = (owner.next ? owner.next.implements : owner.implements) ?? [];
  const files = [...new Set([...current, file])].sort((a, b) => a.localeCompare(b));
  const claim: CoverageFixCall = {
    tool: "set_implementation_files",
    args: { node_id: owner.id, files },
  };
  return shippedIdle ? [{ tool: "open_next", args: { node_id: owner.id } }, claim] : [claim];
}

/** `Fix: a({...}) then b({...}).` */
export function formatCoverageFix(calls: CoverageFixCall[]): string {
  return `Fix: ${calls.map((c) => `${c.tool}(${JSON.stringify(c.args)})`).join(" then ")}.`;
}

// ---------------------------------------------------------------------------
// Route families
// ---------------------------------------------------------------------------

const ROUTE_FILE =
  /^(page|route|layout|template|loading|error|not-found|default)\.(ts|tsx|js|jsx|mjs|cjs|md|mdx)$/;

/** A route segment that names a fixed path (not `[param]`, `(group)`, or `@slot`). */
function isStaticSegment(segment: string): boolean {
  return !/^[[(@]/.test(segment);
}

const LAYOUT_FILE = /^layout\.(ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * App Router roots: `app/` folders (at any depth) that hold a root layout, directly or inside a
 * route group (`app/(site)/layout.tsx`). An `app/` folder without one is not a router.
 */
export function appRouterRoots(universe: string[]): Set<string> {
  const roots = new Set<string>();
  for (const file of universe) {
    const parts = file.split("/");
    if (!LAYOUT_FILE.test(parts[parts.length - 1])) continue;
    const dirs = parts.slice(0, -1);
    const last = dirs[dirs.length - 1];
    if (last === "app") roots.add(dirs.join("/"));
    else if (dirs.length >= 2 && /^\(.*\)$/.test(last) && dirs[dirs.length - 2] === "app") {
      roots.add(dirs.slice(0, -1).join("/"));
    }
  }
  return roots;
}

/**
 * The route family of an App Router route file: its folder cut after the last static segment
 * below the router root, so `app/sites/[site]/[lang]/blog/[slug]/page.tsx` → `app/sites/[site]/[lang]/blog/`.
 * Null for a file that is not a route file under one of `roots` (see `appRouterRoots`).
 */
export function routeFamilyOf(file: string, roots: Set<string>): string | null {
  const parts = file.split("/");
  if (!ROUTE_FILE.test(parts[parts.length - 1])) return null;
  const dirs = parts.slice(0, -1);
  let appIndex = -1;
  for (let i = 0; i < dirs.length; i++) {
    if (dirs[i] === "app" && roots.has(dirs.slice(0, i + 1).join("/"))) {
      appIndex = i;
      break;
    }
  }
  if (appIndex < 0) return null;
  let end = appIndex;
  for (let i = appIndex + 1; i < dirs.length; i++) {
    if (isStaticSegment(dirs[i])) end = i;
  }
  return `${dirs.slice(0, end + 1).join("/")}/`;
}

function describeRouteOwner(node: MindPlanNode): string {
  if (node.type === "Foundation") {
    const role = effectiveRole(node);
    return `"${node.id}" (${role === "assembler" ? "Assembler" : `Foundation${role ? ` ${role}` : ""}`})`;
  }
  return `"${node.id}" (${node.type === "Interface" ? "entry point" : node.type})`;
}

/**
 * Warnings for route families whose route files have more than one owner. The rule: the
 * Assembler owns routes that dispatch to whichever template is active; a template's entry
 * point owns only routes that exist for that template alone.
 */
export function routeFamilySplits(
  graph: MindPlanGraph,
  buckets: OwnershipBuckets,
  universe: string[]
): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const families = new Map<string, Map<string, string[]>>();
  const roots = appRouterRoots(universe);
  for (const file of universe) {
    const family = routeFamilyOf(file, roots);
    if (!family) continue;
    const ownerId = exclusiveOwner(buckets, file);
    if (!ownerId) continue;
    let owners = families.get(family);
    if (!owners) {
      owners = new Map();
      families.set(family, owners);
    }
    owners.set(ownerId, [...(owners.get(ownerId) ?? []), file]);
  }
  const warnings: string[] = [];
  for (const [family, owners] of [...families].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (owners.size < 2) continue;
    const list = [...owners.keys()]
      .sort()
      .map((id) => {
        const node = byId.get(id);
        const files = owners.get(id)!;
        const shown = files.slice(0, 2).map((f) => `"${f}"`).join(", ");
        return `${node ? describeRouteOwner(node) : `"${id}"`} owns ${shown}${files.length > 2 ? ", ..." : ""}`;
      })
      .join("; ");
    warnings.push(
      `routes: route family "${family}" is split: ${list}. ` +
        `The Assembler owns routes that dispatch to whichever template is active; ` +
        `a template's entry point owns only routes that exist for that template alone. ` +
        `Move the family's routes to one owner with set_implementation_files.`
    );
  }
  return warnings;
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
