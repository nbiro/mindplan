/**
 * Offline integrity check for MindPlan territory + declared file ownership.
 * Used by `mindplan-mcp check` (CLI) — not MCP stdio.
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { MindPlanGraph, MindPlanNode } from "../../foundations/f-domain-model/types.js";
import {
  isPipelineNodeType,
  isProductionState,
} from "../../foundations/f-domain-model/types.js";
import {
  effectiveRole,
  importAllowed,
} from "../../foundations/f-compiler-rules/rules.js";
import {
  buildOwnershipIndex,
  exclusiveOwner,
  ownerOfFile,
  releasedClaimEntries,
  type OwnershipBuckets,
} from "../../foundations/f-source-index/ownership.js";
import { expandClaims } from "../../foundations/f-source-index/claims.js";
import { listResolvedImports } from "../../foundations/f-source-index/imports.js";
import { listUniverseFiles } from "../../foundations/f-source-index/universe.js";
import {
  isChecklistComplete,
  loadGraph,
  loadProjectConfig,
  projectRoot,
  readMarkdown,
} from "../../foundations/f-territory-store/store.js";

const RETIRED_STATES = new Set(["cancelled", "deprecated"]);
const MID_PIPELINE = new Set(["in-progress", "in-review"]);
const BUG_MID_PIPELINE = new Set(["fixing", "in-review"]);
const ACTIVE_BUILD = new Set(["in-progress"]);
const CLAIMED_OR_CONCLUDED = new Set([
  "in-progress",
  "in-review",
  "stable",
  "unstable",
  "cancelled",
  "deprecated",
]);

export type { OwnershipBuckets };
export { buildOwnershipIndex, exclusiveOwner, ownerOfFile };
export interface CheckOptions {
  /**
   * When set, also enforce dirty-src ownership vs this git base.
   * Default check skips dirty-src (graph + ownership only).
   */
  base?: string;
  /** Override project root (tests). */
  cwd?: string;
}

export interface CheckResult {
  ok: boolean;
  failures: string[];
}

export interface DirtySrcPaths {
  workingTree: string[];
  commits: string[];
}

class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

function fail(failures: string[], message: string): void {
  failures.push(message.startsWith("Blocked:") ? message : `Blocked: ${message}`);
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function git(args: string[], cwd: string, required: boolean): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    if (!required) return "";
    const detail =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr?: Buffer | string }).stderr ?? "").trim()
        : err instanceof Error
          ? err.message
          : String(err);
    throw new GitError(
      `git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}.`
    );
  }
}

function resolveDefaultBase(cwd: string): string | null {
  for (const branch of ["main", "master"]) {
    const mb = git(["merge-base", "HEAD", branch], cwd, false);
    if (mb) return mb;
    const remote = git(["merge-base", "HEAD", `origin/${branch}`], cwd, false);
    if (remote) return remote;
  }
  return null;
}

function parsePorcelainSrcPaths(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    const rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    const file = arrow >= 0 ? rest.slice(arrow + 4) : rest;
    const cleaned = file.replace(/^"|"$/g, "").trim();
    if (cleaned) paths.push(toPosix(cleaned));
  }
  return paths;
}

/**
 * Working-tree dirtiness vs commits ahead of base, filtered to universe later.
 */
export function collectDirtySrcPaths(cwd: string, base?: string): DirtySrcPaths {
  const explicitBase = base !== undefined;
  const inside = git(["rev-parse", "--is-inside-work-tree"], cwd, false);
  if (inside !== "true") {
    if (explicitBase) {
      throw new GitError(`--base requires a git repository (got base "${base}").`);
    }
    return { workingTree: [], commits: [] };
  }

  const porcelain = git(["status", "--porcelain", "-uall"], cwd, true);
  const workingTree = [...new Set(parsePorcelainSrcPaths(porcelain))].sort((a, b) =>
    a.localeCompare(b)
  );

  const commits = new Set<string>();
  const baseRef = base ?? resolveDefaultBase(cwd);
  if (baseRef) {
    const diff = git(["diff", "--name-only", `${baseRef}...HEAD`], cwd, explicitBase);
    for (const line of diff.split("\n")) {
      const p = line.trim();
      if (p) commits.add(toPosix(p));
    }
  } else if (explicitBase) {
    throw new GitError(`could not resolve git base "${base}".`);
  }

  return {
    workingTree,
    commits: [...commits].sort((a, b) => a.localeCompare(b)),
  };
}

function checkExclusivity(
  graph: MindPlanGraph,
  root: string,
  failures: string[]
): OwnershipBuckets {
  const claims: { file: string; owner: string }[] = [];

  for (const node of graph.nodes) {
    if (!isPipelineNodeType(node.type)) continue;
    if (RETIRED_STATES.has(node.state)) continue;
    if (node.next) {
      for (const f of expandClaims(node.next.implements, root)) {
        claims.push({ file: f, owner: node.id });
      }
      const nextSet = new Set(expandClaims(node.next.implements, root));
      for (const f of expandClaims(node.implements, root)) {
        if (nextSet.has(f)) claims.push({ file: f, owner: node.id });
      }
    } else {
      for (const f of expandClaims(node.implements, root)) {
        claims.push({ file: f, owner: node.id });
      }
    }
  }

  const byFile = new Map<string, Set<string>>();
  for (const c of claims) {
    let set = byFile.get(c.file);
    if (!set) {
      set = new Set();
      byFile.set(c.file, set);
    }
    set.add(c.owner);
  }
  for (const [file, owners] of byFile) {
    if (owners.size > 1) {
      fail(
        failures,
        `exclusivity: "${file}" claimed by multiple nodes: ${[...owners]
          .sort()
          .map((id) => `"${id}"`)
          .join(", ")}.`
      );
    }
  }

  return buildOwnershipIndex(graph, root);
}

function checkCoverage(
  buckets: OwnershipBuckets,
  root: string,
  failures: string[]
): void {
  const universe = listUniverseFiles(root);
  for (const file of universe) {
    const owner = ownerOfFile(buckets, file);
    if (!owner) {
      fail(failures, `coverage: universe file "${file}" has no owner (implements claim).`);
    }
  }
}

function checkPresence(graph: MindPlanGraph, root: string, failures: string[]): void {
  for (const node of graph.nodes) {
    if (!isPipelineNodeType(node.type)) continue;
    if (RETIRED_STATES.has(node.state)) continue;

    const checkSlot = (
      entries: string[] | undefined,
      label: string,
      require: boolean,
      skip?: Set<string>
    ) => {
      if (!require) return;
      const list = entries ?? [];
      for (const entry of list) {
        if (skip?.has(entry)) continue;
        const abs = path.join(root, ...entry.replace(/\/$/, "").split("/"));
        const exists = entry.endsWith("/")
          ? fs.existsSync(abs) && fs.statSync(abs).isDirectory()
          : fs.existsSync(abs) && fs.statSync(abs).isFile();
        if (!exists) {
          fail(
            failures,
            `presence: "${node.id}" ${label} implements entry missing on disk: "${entry}".`
          );
        }
      }
    };

    const liveNeedsPresence =
      node.state === "in-review" || isProductionState(node.state);
    const released = liveNeedsPresence
      ? releasedClaimEntries(node, root)
      : undefined;
    checkSlot(node.implements, "live", liveNeedsPresence, released);

    if (node.next && node.next.state === "in-review") {
      checkSlot(node.next.implements, "next", true);
    }
  }
}

function checkLeftovers(
  graph: MindPlanGraph,
  buckets: OwnershipBuckets,
  root: string,
  failures: string[]
): void {
  for (const node of graph.nodes) {
    if (!isPipelineNodeType(node.type)) continue;
    if (!RETIRED_STATES.has(node.state)) continue;
    for (const f of expandClaims(node.implements, root)) {
      const abs = path.join(root, ...f.split("/"));
      if (!fs.existsSync(abs)) continue;
      // Still on disk and still listed by retired node → leftover unless also owned elsewhere actively
      const active = exclusiveOwner(buckets, f);
      if (active && active !== node.id) continue;
      fail(
        failures,
        `leftovers: retired "${node.id}" still lists "${f}" which exists on disk. ` +
          `Delete the file or reassign it via set_implementation_files.`
      );
    }
  }
}

function checkImports(
  graph: MindPlanGraph,
  buckets: OwnershipBuckets,
  root: string,
  failures: string[]
): void {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const universe = listUniverseFiles(root);
  for (const file of universe) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)) continue;
    const fromOwnerId = exclusiveOwner(buckets, file);
    if (!fromOwnerId) continue;
    const fromOwner = byId.get(fromOwnerId);
    if (!fromOwner) continue;

    for (const edge of listResolvedImports(file, root)) {
      const toOwnerId = exclusiveOwner(buckets, edge.to);
      if (!toOwnerId) continue;
      const toOwner = byId.get(toOwnerId);
      if (!toOwner) continue;
      if (importAllowed(fromOwner, toOwner, graph)) continue;
      fail(
        failures,
        `imports: "${file}" (owner "${fromOwnerId}") may not import "${edge.to}" ` +
          `(owner "${toOwnerId}" / ${toOwner.type}` +
          `${toOwner.type === "Foundation" ? ` role=${effectiveRole(toOwner) ?? "?"}` : ""}).`
      );
    }
  }
}

function bugAllowsDirty(graph: MindPlanGraph, nodeId: string): boolean {
  return graph.nodes.some(
    (n) =>
      n.type === "Bug" &&
      BUG_MID_PIPELINE.has(n.state) &&
      (n.affects ?? []).includes(nodeId)
  );
}

function ownerAllowsWorkingTree(graph: MindPlanGraph, node: MindPlanNode): boolean {
  if (node.next) {
    if (ACTIVE_BUILD.has(node.next.state)) return true;
    return bugAllowsDirty(graph, node.id);
  }
  if (ACTIVE_BUILD.has(node.state)) return true;
  return bugAllowsDirty(graph, node.id);
}

function ownerAllowsCommitDiff(graph: MindPlanGraph, node: MindPlanNode): boolean {
  if (node.next) {
    if (MID_PIPELINE.has(node.next.state)) return true;
    return bugAllowsDirty(graph, node.id);
  }
  if (CLAIMED_OR_CONCLUDED.has(node.state)) return true;
  return bugAllowsDirty(graph, node.id);
}

function describeOwner(node: MindPlanNode): string {
  return `"${node.id}" is "${node.state}"` + (node.next ? ` (next: ${node.next.state})` : "");
}

function checkDirtySrc(
  graph: MindPlanGraph,
  buckets: OwnershipBuckets,
  cwd: string,
  base: string | undefined,
  failures: string[]
): void {
  let dirty: DirtySrcPaths;
  try {
    dirty = collectDirtySrcPaths(cwd, base);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(failures, `dirty-src git probe failed: ${message}`);
    return;
  }

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const universe = new Set(listUniverseFiles(cwd));
  const workingSet = new Set(dirty.workingTree);

  const checkPath = (
    rel: string,
    allow: (g: MindPlanGraph, n: MindPlanNode) => boolean,
    hint: string
  ): void => {
    if (!universe.has(rel) && !exclusiveOwner(buckets, rel) && !ownerOfFile(buckets, rel)) {
      // Outside universe and unowned — ignore (docs, config, etc.)
      // But if it's in universe and unowned, fail.
    }
    if (universe.has(rel) && !ownerOfFile(buckets, rel)) {
      fail(failures, `unowned dirty path "${rel}" (no implements owner).`);
      return;
    }
    const ownerId = exclusiveOwner(buckets, rel) ?? ownerOfFile(buckets, rel)?.id;
    if (!ownerId) return; // not in universe / not owned — skip lifecycle
    const node = byId.get(ownerId);
    if (!node) {
      fail(failures, `dirty path "${rel}" maps to unknown node "${ownerId}".`);
      return;
    }
    if (!allow(graph, node)) {
      fail(
        failures,
        `dirty file "${rel}" while ${describeOwner(node)}. ${hint}`
      );
    }
  };

  for (const rel of dirty.workingTree) {
    if (!fs.existsSync(path.join(cwd, ...rel.split("/")))) continue;
    if (!universe.has(rel) && !ownerOfFile(buckets, rel)) continue;
    checkPath(
      rel,
      ownerAllowsWorkingTree,
      "Uncommitted changes require in-progress (or next in-progress), or a Bug in fixing/in-review."
    );
  }

  for (const rel of dirty.commits) {
    if (workingSet.has(rel)) continue;
    if (!fs.existsSync(path.join(cwd, ...rel.split("/")))) continue;
    if (!universe.has(rel) && !ownerOfFile(buckets, rel)) continue;
    checkPath(
      rel,
      ownerAllowsCommitDiff,
      "Committed diffs require in-progress/in-review/stable/unstable/cancelled/deprecated, or next in-progress/in-review, or a Bug in fixing/in-review."
    );
  }
}

const BUILDING_CHECKLIST_STATES = new Set([
  "draft",
  "ready",
  "in-progress",
  "open",
  "triaged",
  "fixing",
]);

function checkChecklistBuilding(graph: MindPlanGraph, failures: string[]): void {
  for (const node of graph.nodes) {
    const slots: Array<{ slot: "current" | "next"; state: string }> = [
      { slot: "current", state: node.state },
    ];
    if (node.next) {
      slots.push({ slot: "next", state: node.next.state });
    }
    for (const { slot, state } of slots) {
      if (!BUILDING_CHECKLIST_STATES.has(state)) continue;
      try {
        const raw = readMarkdown(node, slot);
        if (!isChecklistComplete(raw)) continue;
      } catch {
        continue;
      }
      fail(
        failures,
        `Checklist Complete. All checkboxes are checked while "${node.id}" ` +
          `${slot === "next" ? "next " : ""}is "${state}". ` +
          `Leave an Atomic Op open while building, or advance to in-review.`
      );
    }
  }
}

/**
 * Run integrity checks. Loads the territory graph from disk.
 */
export function runIntegrityCheck(options: CheckOptions = {}): CheckResult {
  const failures: string[] = [];
  const root = options.cwd ? path.resolve(options.cwd) : projectRoot();
  const prev = process.env.MINDPLAN_ROOT;
  if (options.cwd) {
    process.env.MINDPLAN_ROOT = root;
  }

  let graph: MindPlanGraph;
  try {
    // Config must load (Blocked on legacy implementation_packages).
    loadProjectConfig(root);
    graph = loadGraph();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(failures, `graph load failed: ${message}`);
    if (options.cwd) {
      if (prev === undefined) delete process.env.MINDPLAN_ROOT;
      else process.env.MINDPLAN_ROOT = prev;
    }
    return { ok: false, failures };
  }

  try {
    checkChecklistBuilding(graph, failures);
    const buckets = checkExclusivity(graph, root, failures);
    checkCoverage(buckets, root, failures);
    checkPresence(graph, root, failures);
    checkLeftovers(graph, buckets, root, failures);
    checkImports(graph, buckets, root, failures);
    if (options.base !== undefined) {
      checkDirtySrc(graph, buckets, root, options.base, failures);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(failures, message);
  } finally {
    if (options.cwd) {
      if (prev === undefined) delete process.env.MINDPLAN_ROOT;
      else process.env.MINDPLAN_ROOT = prev;
    }
  }

  return { ok: failures.length === 0, failures };
}
