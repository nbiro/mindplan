/**
 * Offline integrity check for MindPlan territory + prescribed packages.
 * Used by `mindplan-mcp check` (CLI) — not MCP stdio.
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { MindPlanGraph, MindPlanNode } from "../../foundations/f-domain-model/types.js";
import {
  getNodeImplementation,
  implementationPackagesRequired,
  loadGraph,
  projectRoot,
  SRC_DIR,
} from "../../foundations/f-territory-store/store.js";

const PACKAGE_KINDS = ["foundations", "workflows"] as const;
const RETIRED_PACKAGE_STATES = new Set(["cancelled", "deprecated"]);
const MID_PIPELINE = new Set(["in-progress", "in-review"]);
const BUG_MID_PIPELINE = new Set(["fixing", "in-review"]);
/** Working-tree edits require active build. */
const ACTIVE_BUILD = new Set(["in-progress"]);
/** Commit diffs vs base may also be in-review, shipped, or retired (abandoned in-branch). */
const CLAIMED_OR_CONCLUDED = new Set([
  "in-progress",
  "in-review",
  "stable",
  "unstable",
  "cancelled",
  "deprecated",
]);

export interface CheckOptions {
  /** Ban mid-pipeline states (merge-to-main gate). Skips dirty-src-vs-base. */
  forMain?: boolean;
  /** Git base ref for commit diff (default: merge-base with main/master). */
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

function listPackageDirs(root: string, kind: (typeof PACKAGE_KINDS)[number]): string[] {
  const dir = path.join(root, SRC_DIR, kind);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => {
      if (name.startsWith(".")) return false;
      try {
        return fs.statSync(path.join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b));
}

function packageOwnerFromSrcPath(relPosix: string): { kind: string; id: string } | null {
  const m = relPosix.match(/^src\/(foundations|workflows)\/([^/]+)(?:\/|$)/);
  if (!m) return null;
  return { kind: m[1], id: m[2] };
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
  return paths.filter((p) => p.startsWith("src/"));
}

/**
 * Working-tree dirtiness vs commits ahead of base, filtered to src/.
 * When `base` is explicit, git failures are hard errors.
 * Outside a git repo (and without `--base`), dirty-src is skipped (package checks still run).
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

  const porcelain = git(["status", "--porcelain", "-uall", "--", "src"], cwd, true);
  const workingTree = [...new Set(parsePorcelainSrcPaths(porcelain))].sort((a, b) =>
    a.localeCompare(b)
  );

  const commits = new Set<string>();
  const baseRef = base ?? resolveDefaultBase(cwd);
  if (baseRef) {
    const diff = git(
      ["diff", "--name-only", `${baseRef}...HEAD`, "--", "src"],
      cwd,
      explicitBase
    );
    for (const line of diff.split("\n")) {
      const p = line.trim();
      if (p) commits.add(toPosix(p));
    }
  } else if (explicitBase) {
    throw new GitError(`could not resolve git base "${base}".`);
  }

  return {
    workingTree,
    commits: [...commits].filter((p) => p.startsWith("src/")).sort((a, b) => a.localeCompare(b)),
  };
}

function bugAllowsDirty(graph: MindPlanGraph, nodeId: string): boolean {
  return graph.nodes.some(
    (n) =>
      n.type === "Bug" &&
      BUG_MID_PIPELINE.has(n.state) &&
      (n.affects ?? []).includes(nodeId)
  );
}

/** Uncommitted edits: must be actively building (current or next slot). */
function ownerAllowsWorkingTree(graph: MindPlanGraph, node: MindPlanNode): boolean {
  if (node.next) {
    if (ACTIVE_BUILD.has(node.next.state)) return true;
    return bugAllowsDirty(graph, node.id);
  }
  if (ACTIVE_BUILD.has(node.state)) return true;
  return bugAllowsDirty(graph, node.id);
}

/**
 * Committed diffs vs base: allow active build / in-review / shipped / cancelled / deprecated.
 * When `next.mdx` is open, only a claimed next pipeline (`in-progress`/`in-review`)
 * counts — bare stable + next draft/ready must not pass (evolution not claimed).
 * Retired live nodes with no next: committed package history is allowed (abandon left files on disk).
 */
function ownerAllowsCommitDiff(graph: MindPlanGraph, node: MindPlanNode): boolean {
  if (node.next) {
    if (MID_PIPELINE.has(node.next.state)) return true;
    return bugAllowsDirty(graph, node.id);
  }
  if (CLAIMED_OR_CONCLUDED.has(node.state)) return true;
  return bugAllowsDirty(graph, node.id);
}

function checkPackages(graph: MindPlanGraph, root: string, failures: string[]): void {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  for (const node of graph.nodes) {
    if (node.type !== "Foundation" && node.type !== "Workflow") continue;
    if (RETIRED_PACKAGE_STATES.has(node.state)) continue;
    const impl = getNodeImplementation(node);
    if (!impl.exists) {
      fail(
        failures,
        `missing implementation package for ${node.type} "${node.id}" (expected ${impl.root}/).`
      );
    }
  }

  for (const kind of PACKAGE_KINDS) {
    for (const id of listPackageDirs(root, kind)) {
      const node = byId.get(id);
      if (!node) {
        fail(
          failures,
          `orphan package src/${kind}/${id}/ has no matching MindPlan node.`
        );
        continue;
      }
      const expectedKind = node.type === "Foundation" ? "foundations" : "workflows";
      if (node.type !== "Foundation" && node.type !== "Workflow") {
        fail(
          failures,
          `orphan package src/${kind}/${id}/: node "${id}" is a ${node.type}, not a package owner.`
        );
      } else if (kind !== expectedKind) {
        fail(
          failures,
          `package src/${kind}/${id}/ does not match node type ${node.type} (expected src/${expectedKind}/${id}/).`
        );
      }
    }
  }
}

function describeOwner(node: MindPlanNode): string {
  return `"${node.id}" is "${node.state}"` + (node.next ? ` (next: ${node.next.state})` : "");
}

function checkDirtySrc(
  graph: MindPlanGraph,
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
  const workingSet = new Set(dirty.workingTree);

  const checkPath = (
    rel: string,
    allow: (g: MindPlanGraph, n: MindPlanNode) => boolean,
    hint: string
  ): void => {
    const owner = packageOwnerFromSrcPath(rel);
    if (!owner) {
      fail(
        failures,
        `unowned dirty path "${rel}" (must live under src/foundations/<id>/ or src/workflows/<id>/).`
      );
      return;
    }
    const node = byId.get(owner.id);
    if (!node) {
      fail(failures, `dirty path "${rel}" maps to unknown node "${owner.id}".`);
      return;
    }
    if (node.type !== "Foundation" && node.type !== "Workflow") {
      fail(failures, `dirty path "${rel}" owner "${owner.id}" is a ${node.type}.`);
      return;
    }
    if (!allow(graph, node)) {
      fail(
        failures,
        `dirty package src/${owner.kind}/${owner.id}/ while ${describeOwner(node)}. ${hint}`
      );
    }
  };

  for (const rel of dirty.workingTree) {
    checkPath(
      rel,
      ownerAllowsWorkingTree,
      "Uncommitted src/ changes require in-progress (or next in-progress), or a Bug in fixing/in-review."
    );
  }

  for (const rel of dirty.commits) {
    if (workingSet.has(rel)) continue; // already gated by stricter working-tree rule
    checkPath(
      rel,
      ownerAllowsCommitDiff,
      "Committed src/ diffs require in-progress/in-review/stable/unstable/cancelled/deprecated, or next in-progress/in-review (not draft/ready), or a Bug in fixing/in-review."
    );
  }
}

function checkForMain(graph: MindPlanGraph, failures: string[]): void {
  for (const node of graph.nodes) {
    if (node.type === "Foundation" || node.type === "Workflow") {
      if (MID_PIPELINE.has(node.state)) {
        fail(
          failures,
          `main hygiene: ${node.type} "${node.id}" is "${node.state}". ` +
            `Ship, cancel, or retreat to draft/ready before merging to main.`
        );
      }
      if (node.next && MID_PIPELINE.has(node.next.state)) {
        fail(
          failures,
          `main hygiene: ${node.type} "${node.id}" has next.mdx in "${node.next.state}". ` +
            `Ship the evolution, discard_next, or retreat next to draft/ready before merging to main.`
        );
      }
    }
    if (node.type === "Bug" && BUG_MID_PIPELINE.has(node.state)) {
      fail(
        failures,
        `main hygiene: Bug "${node.id}" is "${node.state}". ` +
          `Resolve/retreat the Bug before merging to main.`
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
    const packagesOn = implementationPackagesRequired(root);
    if (packagesOn) {
      checkPackages(graph, root, failures);
    }
    if (options.forMain) {
      checkForMain(graph, failures);
    } else if (packagesOn) {
      checkDirtySrc(graph, root, options.base, failures);
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
