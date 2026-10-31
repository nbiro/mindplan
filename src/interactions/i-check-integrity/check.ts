/**
 * Offline integrity check for MindPlan territory + declared file ownership.
 * Used by `mindplan-mcp check` (CLI) — not MCP stdio.
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { MindPlanGraph, MindPlanNode } from "../../foundations/f-domain-model/types.js";
import {
  activeChange,
  isPipelineNodeType,
  isProductionState,
} from "../../foundations/f-domain-model/types.js";
import {
  STALE_ALL,
  STALE_PATHS_ONLY,
  coverageFix,
  createCoverageFixContext,
  findAllImportViolations,
  findImportViolationsForNode,
  findOwnershipConflicts,
  formatCoverageFix,
  probableOwner,
  routeFamilySplits,
  descriptionWarnings,
  staleTextWarnings,
  testPresenceFailures,
  untestedWarning,
} from "../../foundations/f-compiler-rules/integrity.js";
import { changeMembers, changeNeighbors } from "../../foundations/f-compiler-rules/rules.js";
import { shapeWarning } from "../../foundations/f-compiler-rules/shape.js";
import {
  changeMembership,
  plannedEdgeProblems,
  plannedEdges,
} from "../../foundations/f-compiler-rules/planned.js";
import {
  createDecisionContext,
  decisionWarnings,
  type DecisionContext,
} from "../../foundations/f-compiler-rules/decisions.js";
import {
  buildOwnershipIndex,
  claimantsOf,
  exclusiveOwner,
  ownerOfFile,
  releasedClaimEntries,
  type OwnershipBuckets,
} from "../../foundations/f-source-index/ownership.js";
import {
  claimCoversPath,
  claimEntryExists,
  expandClaims,
} from "../../foundations/f-source-index/claims.js";
import { listUniverseFiles } from "../../foundations/f-source-index/universe.js";
import { hotspotSettings } from "../../foundations/f-source-index/config.js";
import {
  changeAdditivity,
  hotspots,
  hotspotWarning,
  type ChangeAdditivity,
} from "../../foundations/f-compiler-rules/open-closed.js";
import { defaultBaseRef, repoPrefix } from "../../foundations/f-source-index/git.js";
import {
  drainRemovedLegacyFiles,
  loadGraph,
  isLegacyMirror,
  loadProjectConfig,
  markdownRelativePath,
  projectRoot,
  type RemovedLegacyFile,
} from "../../foundations/f-territory-store/store.js";
import { projectVersionStatus } from "../../foundations/f-territory-store/version.js";

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
  /** Also run the in-review gate on every open revision in this change. */
  change?: string;
  /**
   * Merge gate: also Block work the default branch must not hold. `true` Blocks in-review active
   * slots and in-review Bugs; `"strict"` also Blocks in-progress active slots whose claimed files
   * changed against `base` (default: `defaultBaseRef`).
   */
  merge?: MergeLevel;
}

export type MergeLevel = true | "strict";

/** One node the merge gate Blocks. `files` lists the changed claimed paths (strict only). */
export interface MergeNode {
  id: string;
  type: string;
  state: string;
  slot: "live" | "next";
  files?: string[];
}

/** The merge gate's findings, one group per change id (`null` for nodes with none). */
export interface MergeReport {
  level: "default" | "strict";
  base?: string;
  changes: { change: string | null; nodes: MergeNode[] }[];
}

/**
 * One change's members and what the in-review gate finds on them. A member is a revision (an open
 * revision under the change) or a neighbor (a shipped node the change edits in place).
 */
export interface ChangeCheck {
  id: string;
  members: {
    id: string;
    type: string;
    kind: "revision" | "neighbor" | "planned";
    state: string;
    next_state: string | null;
  }[];
  failures: string[];
  warnings: string[];
  info: string[];
  /** New nodes, reopened shipped nodes (with fan-in), neighbors, and planned revisions. */
  additivity: ChangeAdditivity;
}

export interface CheckResult {
  ok: boolean;
  failures: string[];
  /** Non-blocking: territory text that no longer matches the repo. Never changes `ok`. */
  warnings: string[];
  /** Not drift: paths a plan names before building them (`planned:`). Never changes `ok`. */
  info: string[];
  /** Legacy territory files deleted while loading the graph. */
  removedLegacyFiles: RemovedLegacyFile[];
  /** Present when the check ran for a change. Its failures are also in `failures`. */
  change?: ChangeCheck;
  /** Present when the merge gate ran. Its failures are also in `failures`. */
  merge?: MergeReport;
}

/**
 * The in-review gate on every member of a change: import and ownership violations on each
 * revision's active-slot files and each neighbor's live files (Blocked), and every stale-text
 * signal (warnings; planned paths go to info). Decision warnings apply to revisions only.
 */
function checkChange(
  graph: MindPlanGraph,
  root: string,
  change: string,
  decisionCtx: DecisionContext
): ChangeCheck {
  // Planned sources are listed, not gated: their files do not change until the change opens them.
  const { revisions, neighbors, planned } = changeMembership(graph, change);
  const failures: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];
  if (revisions.length === 0 && neighbors.length === 0 && planned.length === 0) {
    failures.push(
      `Blocked: change "${change}" has no members. Set it with open_next, create_node, or patch_node_territory (change).`
    );
  }
  for (const node of [...revisions, ...neighbors]) {
    for (const v of findImportViolationsForNode(graph, root, node)) {
      failures.push(`Blocked: change "${change}": ${v.message}`);
    }
    for (const conflict of findOwnershipConflicts(graph, root, node)) {
      failures.push(`Blocked: change "${change}": ${conflict}`);
    }
    for (const missing of testPresenceFailures(node, root)) {
      failures.push(`Blocked: change "${change}": ${missing}`);
    }
    const stale = staleTextWarnings(graph, root, node, undefined, STALE_ALL);
    warnings.push(...stale.warnings);
    info.push(...stale.info);
  }
  for (const problem of plannedEdgeProblems(graph, change)) {
    failures.push(`Blocked: change "${change}": ${problem}`);
  }
  const bySource = new Map<string, string[]>();
  for (const row of plannedEdges(graph, change)) {
    bySource.set(row.source, [...(bySource.get(row.source) ?? []), `${row.type} ${row.target}`]);
  }
  for (const [source, edges] of bySource) {
    info.push(
      `planned edges: "${source}" plans ${edges.join(", ")} under this change ` +
        `(applied when open_next opens it with this change).`
    );
  }
  for (const node of revisions) {
    warnings.push(...decisionWarnings(graph, node, decisionCtx));
    const untested = untestedWarning(node);
    if (untested) warnings.push(untested);
  }
  const member = (kind: "revision" | "neighbor" | "planned") => (n: MindPlanNode) => ({
    id: n.id,
    type: n.type,
    kind,
    state: n.state,
    next_state: n.next?.state ?? null,
  });
  const additivity = changeAdditivity(graph, change, { revisions, neighbors, planned });
  if (revisions.length + neighbors.length + planned.length > 0) info.push(`additivity: ${additivity.summary}`);
  return {
    id: change,
    additivity,
    members: [
      ...revisions.map(member("revision")),
      ...neighbors.map(member("neighbor")),
      ...planned.map(member("planned")),
    ],
    failures,
    warnings: [...new Set(warnings)],
    info: [...new Set(info)],
  };
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
    // Trim only the trailing newline. A leading space is the unstaged half of
    // porcelain (` D path`); trimming it corrupts the first path.
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/\s+$/, "");
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

  // Porcelain paths are relative to the repository top and claims to the project root: limit the
  // status to the project root and strip its prefix (diff --relative does both for commits).
  const porcelain = git(["status", "--porcelain", "-uall", "--", "."], cwd, true);
  const prefix = repoPrefix(cwd) ?? "";
  const workingTree = [
    ...new Set(
      parsePorcelainSrcPaths(porcelain)
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length))
    ),
  ].sort((a, b) => a.localeCompare(b));

  const commits = new Set<string>();
  const baseRef = base ?? defaultBaseRef(cwd);
  if (baseRef) {
    const diff = git(["diff", "--name-only", "--relative", `${baseRef}...HEAD`], cwd, explicitBase);
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

/**
 * Every in-universe file needs a claim in a current or next slot of a non-retired node.
 * A retired node's claim does not count (the leftovers rule Blocks that file too).
 */
function checkCoverage(
  graph: MindPlanGraph,
  root: string,
  buckets: OwnershipBuckets,
  universe: string[],
  failures: string[]
): void {
  const fixCtx = createCoverageFixContext(root);
  for (const file of universe) {
    if (claimantsOf(buckets, file).length > 0) continue;
    // A retired claim on a file on disk is the leftovers rule's failure; do not report it twice.
    if (buckets.retired.has(file)) continue;
    const owner = probableOwner(graph, file);
    const hint = owner
      ? ` Probable owner by path: "${owner.id}". ${formatCoverageFix(coverageFix(graph, root, owner, file, fixCtx))}`
      : " No node claims a nearby path: create or pick the owning node, then claim the file with set_implementation_files.";
    fail(
      failures,
      `Coverage: "${file}" is inside the configured sources but no node claims it in a current or next slot.${hint}`
    );
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
        if (!claimEntryExists(entry, root)) {
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
    for (const missing of testPresenceFailures(node, root)) fail(failures, missing);
    // A revision in review must have written the files it attributes to itself.
    const reviewSlot = node.next ? node.next : node;
    if (reviewSlot.state === "in-review") {
      for (const f of reviewSlot.attributed ?? []) {
        if (!fs.existsSync(path.join(root, ...f.split("/")))) {
          fail(failures, `presence: "${node.id}" attributed file missing on disk: "${f}".`);
        }
      }
    }
  }
}

/**
 * A shipped node has no next file unless a revision is open. A `state: mirror` file left by a
 * release before 0.8.0 is not a revision; it only warns, with the init call that removes it.
 */
function legacyMirrorWarnings(graph: MindPlanGraph): string[] {
  const warnings: string[] = [];
  for (const node of graph.nodes) {
    if (!isPipelineNodeType(node.type) || node.next) continue;
    if (!isLegacyMirror(node)) continue;
    warnings.push(
      `legacy: "${node.id}" has a leftover mirror twin (${markdownRelativePath(node, "next")}); ` +
        `run mindplan-mcp init to remove it.`
    );
  }
  return warnings;
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

/**
 * Import rule over every claimant of a file. Violations only the next-slot / released scan finds
 * are warnings for one release (existing graphs keep passing), then they Block.
 */
function checkImports(
  graph: MindPlanGraph,
  buckets: OwnershipBuckets,
  root: string,
  universe: string[],
  failures: string[],
  warnings: string[]
): void {
  const seen = new Set<string>();
  for (const violation of findAllImportViolations(graph, buckets, root, universe)) {
    if (seen.has(violation.message)) continue;
    seen.add(violation.message);
    if (violation.advisory) {
      warnings.push(
        `${violation.message.replace(/^imports:/, "imports (next slot):")} ` +
          `This is a warning in this release and Blocks in the next one.`
      );
    } else {
      fail(failures, violation.message);
    }
  }
}

/**
 * Stale-text warnings. A node in review gets every signal (it is about to ship). A shipped node
 * with no open update gets only the missing-path signal. Nodes still being built are skipped:
 * they are expected to name files they have not written yet. A draft slot, or a Bug before
 * review, with shape gaps gets one `shape:` warning, so the sections are known before the gate.
 */
function collectWarnings(graph: MindPlanGraph, root: string): { warnings: string[]; info: string[] } {
  const warnings: string[] = [];
  const info: string[] = [];
  for (const node of graph.nodes) {
    // Description quality (every node type; never fails the check).
    warnings.push(...descriptionWarnings(node));
    const shape = shapeWarning(node);
    if (shape) warnings.push(shape);
    if (!isPipelineNodeType(node.type)) continue;
    if (RETIRED_STATES.has(node.state)) continue;
    const active = node.next ? node.next.state : node.state;
    const scope =
      active === "in-review" ? STALE_ALL : !node.next && isProductionState(node.state) ? STALE_PATHS_ONLY : null;
    if (scope) {
      const stale = staleTextWarnings(graph, root, node, undefined, scope);
      warnings.push(...stale.warnings);
      info.push(...stale.info);
    }
    const untested = untestedWarning(node);
    if (untested) warnings.push(untested);
  }
  return { warnings, info };
}

/**
 * Decision warnings: every open revision (any pre-ship state, or a shipped node's open next) that
 * is decision-worthy and has no decision yet. Moving it to in-review Blocks until one is recorded.
 */
function collectDecisionWarnings(graph: MindPlanGraph, ctx: DecisionContext): string[] {
  const warnings: string[] = [];
  for (const node of graph.nodes) warnings.push(...decisionWarnings(graph, node, ctx));
  return warnings;
}

/**
 * Hotspot warnings, highest rank first: each shipped node that ships far more often than the
 * graph's median lately (config `hotspots`), with its recent change groups as candidate cuts.
 */
function collectHotspotWarnings(graph: MindPlanGraph, root: string): string[] {
  return hotspots(graph, hotspotSettings(loadProjectConfig(root))).map(hotspotWarning);
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
  // Neighbors edit shipped files in place: stable/unstable with no open next.
  if (isProductionState(node.state)) return true;
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

/**
 * One run's git probe of the changed paths, memoized per base: dirty-src and the strict merge gate
 * share one `git status` / `git diff`, and a failed probe is reported once (`repeat` on later calls).
 */
type DirtyProbe = (base: string) => { dirty: DirtySrcPaths } | { error: string; repeat: boolean };

function dirtyProbe(cwd: string): DirtyProbe {
  const results = new Map<string, { dirty: DirtySrcPaths } | { error: string }>();
  return (base) => {
    const known = results.get(base);
    if (known) return "error" in known ? { ...known, repeat: true } : known;
    let result: { dirty: DirtySrcPaths } | { error: string };
    try {
      result = { dirty: collectDirtySrcPaths(cwd, base) };
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) };
    }
    results.set(base, result);
    return "error" in result ? { ...result, repeat: false } : result;
  };
}

function checkDirtySrc(
  graph: MindPlanGraph,
  buckets: OwnershipBuckets,
  cwd: string,
  probe: DirtyProbe,
  base: string,
  failures: string[]
): void {
  const probed = probe(base);
  if ("error" in probed) {
    fail(failures, `dirty-src git probe failed: ${probed.error}`);
    return;
  }
  const dirty = probed.dirty;

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
      "Uncommitted changes require in-progress (or next in-progress), a shipped owner with no open next, or a Bug in fixing/in-review."
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

/** Changed claimed paths a strict merge line lists before it counts the rest. */
const MERGE_FILE_CAP = 5;

/** The ship call for a merge-gate node: the change walk when it has a change, else the node. */
function mergeShipCall(node: MergeNode, change: string | null): string {
  return change
    ? `update_node_status({ scope: "change", change: "${change}", new_status: "ship" })`
    : `update_node_status({ node_id: "${node.id}", new_status: "ship" })`;
}

function mergeLine(node: MergeNode, change: string | null, base: string | undefined): string {
  const where = `"${node.id}" (${node.type}, ${node.slot === "next" ? "next " : ""}${node.state}, ${
    change ? `change "${change}"` : "no change"
  })`;
  if (node.type === "Bug") {
    return (
      `Blocked: Merge: ${where}: the fix is finished but the bug is not resolved. ` +
      `Resolve it: update_node_status({ node_id: "${node.id}", new_status: "resolved" }), ` +
      `or move it back with new_status: "fixing" if the fix is unfinished.`
    );
  }
  if (node.state === "in-progress") {
    const files = node.files ?? [];
    const shown = files.slice(0, MERGE_FILE_CAP).map((f) => `"${f}"`).join(", ");
    const more = files.length > MERGE_FILE_CAP ? ` (+${files.length - MERGE_FILE_CAP} more)` : "";
    return (
      `Blocked: Merge (strict): ${where}: claimed files changed against ${base ?? "the base"}: ${shown}${more}. ` +
      `Finish it: update_node_status({ node_id: "${node.id}", new_status: "in-review" }), then ${mergeShipCall(node, change)}; ` +
      `or merge without --merge=strict if this PR is one piece of a larger feature.`
    );
  }
  return (
    `Blocked: Merge: ${where}: the code is finished but the graph has not shipped it. ` +
    `Ship it: ${mergeShipCall(node, change)}, or move it back with ` +
    `update_node_status({ node_id: "${node.id}", new_status: "in-progress" }) if the work is unfinished.`
  );
}

/**
 * Merge gate: the default branch holds done (stable / unstable) or still-building work, never
 * work in review. Blocks every in-review active slot (the open next while one exists, else live)
 * and every in-review Bug; strict also Blocks in-progress active slots whose claims cover a path
 * changed against the base. Lines are grouped by change id, then sorted by node id.
 */
function checkMerge(
  graph: MindPlanGraph,
  root: string,
  level: MergeLevel,
  base: string | undefined,
  probe: DirtyProbe,
  failures: string[]
): MergeReport {
  const strict = level === "strict";
  const report: MergeReport = { level: strict ? "strict" : "default", changes: [] };
  const found: { change: string | null; node: MergeNode }[] = [];

  let changed: string[] | null = null;
  if (strict) {
    const baseRef = base ?? defaultBaseRef(root);
    report.base = base ?? "the default branch";
    if (!baseRef) {
      fail(
        failures,
        `Merge (strict): no git base to compare against (no main or master merge base). Pass --base <ref> (run_check: base).`
      );
    } else {
      const probed = probe(baseRef);
      if (!("error" in probed)) {
        changed = [...new Set([...probed.dirty.commits, ...probed.dirty.workingTree])].sort((a, b) =>
          a.localeCompare(b)
        );
      } else if (!probed.repeat) {
        fail(failures, `Merge (strict): git probe failed: ${probed.error} Pass --base <ref> with a ref this checkout has.`);
      }
    }
  }

  for (const node of graph.nodes) {
    if (node.type === "Bug") {
      if (node.state === "in-review") {
        found.push({
          change: node.change ?? null,
          node: { id: node.id, type: node.type, state: node.state, slot: "live" },
        });
      }
      continue;
    }
    if (!isPipelineNodeType(node.type)) continue;
    if (RETIRED_STATES.has(node.state)) continue;
    const slot = node.next ? "next" : "live";
    const state = node.next ? node.next.state : node.state;
    const change = activeChange(node) ?? null;
    if (state === "in-review") {
      found.push({ change, node: { id: node.id, type: node.type, state, slot } });
    } else if (state === "in-progress" && changed) {
      const claims = (node.next ? node.next.implements : node.implements) ?? [];
      const files = changed.filter((rel) => claims.some((claim) => claimCoversPath(claim, rel)));
      if (files.length > 0) {
        found.push({ change, node: { id: node.id, type: node.type, state, slot, files } });
      }
    }
  }

  // Group by change id (nodes with none last), then node id.
  found.sort(
    (a, b) =>
      (a.change === null ? 1 : 0) - (b.change === null ? 1 : 0) ||
      (a.change ?? "").localeCompare(b.change ?? "") ||
      a.node.id.localeCompare(b.node.id)
  );
  for (const { change, node } of found) {
    failures.push(mergeLine(node, change, report.base));
    const group = report.changes.find((g) => g.change === change);
    if (group) group.nodes.push(node);
    else report.changes.push({ change, nodes: [node] });
  }
  return report;
}

/**
 * Drift classes (SPEC §5.1 `drift`):
 * - `owner_idle`: the file is owned by a node with no open update (a shipped node with no
 *   open next, or a pre-ship node that is not in-progress).
 * - `claimed_missing`: a node claims a path that is missing from disk (a deleted tracked file).
 * - `unowned`: an in-universe file with no owner.
 * - `expected`: the owner has an open update that claims the file. Reported as a count only.
 */
export type DriftClass = "owner_idle" | "claimed_missing";

export type DriftPath = {
  path: string;
  owner_id: string;
  state: string;
  next_state: string | null;
  class: DriftClass;
};

export type DriftReport = {
  paths: DriftPath[];
  unowned: string[];
  /** Dirty files whose owner has an open update claiming them. */
  expected: number;
  /** Entries beyond the per-list cap (lists are capped so one write stays small). */
  more?: number;
  /** When scoped to nodes: dirty owned files that belong to other nodes. */
  other_count?: number;
  reminder: string;
};

const DRIFT_REMINDER =
  "Update each owner so the graph matches before you say this is done. " +
  "A shipped contract change uses open_next; if the behavior did not change, the graph already matches.";

/** Per-list cap for scoped and default drift lists. */
const DRIFT_LIST_CAP = 20;

/**
 * Owner for a path claim expansion dropped (typically a deleted file).
 * The longest covering claim wins, so a live file claim beats a broader
 * directory claim on another node's open next. Equal length on the same
 * node prefers the next slot.
 */
function ownerFromClaims(graph: MindPlanGraph, rel: string): string | null {
  const nodes = graph.nodes
    .filter((node) => isPipelineNodeType(node.type) && !RETIRED_STATES.has(node.state))
    .sort((a, b) => a.id.localeCompare(b.id));
  let best: { id: string; viaNext: boolean; len: number } | null = null;
  for (const node of nodes) {
    const slots: { claims: string[] | undefined; viaNext: boolean }[] = [
      { claims: node.next?.implements, viaNext: true },
      { claims: node.implements, viaNext: false },
    ];
    for (const slot of slots) {
      for (const claim of slot.claims ?? []) {
        if (!claimCoversPath(claim, rel)) continue;
        const len = claim.trim().replace(/\\/g, "/").length;
        if (!best || len > best.len) {
          best = { id: node.id, viaNext: slot.viaNext, len };
          continue;
        }
        if (len === best.len && best.id === node.id && slot.viaNext && !best.viaNext) {
          best = { id: node.id, viaNext: true, len };
        }
      }
    }
  }
  return best?.id ?? null;
}

/** True when the owner has an open update that is allowed to be editing `rel` right now. */
function hasOpenUpdateFor(
  graph: MindPlanGraph,
  buckets: OwnershipBuckets,
  node: MindPlanNode,
  rel: string
): boolean {
  if (node.next) {
    if (ACTIVE_BUILD.has(node.next.state) && buckets.next.get(rel) === node.id) return true;
    return bugAllowsDirty(graph, node.id);
  }
  if (!node.shipped_at && ACTIVE_BUILD.has(node.state)) return true;
  return bugAllowsDirty(graph, node.id);
}

export interface DriftOptions {
  cwd?: string;
  /** Report only these owners' files in detail; other owned files become `other_count`. */
  nodeIds?: string[];
}

/**
 * Read-only report of uncommitted source files and their implements owners, classified.
 * Returns null when there is nothing to report or git cannot be read. Does not change default check.
 */
export function buildDriftReport(options: DriftOptions = {}): DriftReport | null {
  const root = options.cwd ? path.resolve(options.cwd) : projectRoot();
  const prev = process.env.MINDPLAN_ROOT;
  if (options.cwd) {
    process.env.MINDPLAN_ROOT = root;
  }
  try {
    loadProjectConfig(root);
    const graph = loadGraph();
    let dirty: DirtySrcPaths;
    try {
      dirty = collectDirtySrcPaths(root);
    } catch {
      return null;
    }
    if (dirty.workingTree.length === 0) return null;

    const scope = options.nodeIds && options.nodeIds.length > 0 ? new Set(options.nodeIds) : null;
    const buckets = buildOwnershipIndex(graph, root);
    const universe = new Set(listUniverseFiles(root));
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const paths: DriftPath[] = [];
    const unowned: string[] = [];
    let expected = 0;
    let otherCount = 0;

    for (const rel of dirty.workingTree) {
      const exists = fs.existsSync(path.join(root, ...rel.split("/")));
      const ownerId =
        exclusiveOwner(buckets, rel) ??
        ownerOfFile(buckets, rel)?.id ??
        ownerFromClaims(graph, rel);
      const node = ownerId ? byId.get(ownerId) : undefined;
      if (!node) {
        if (universe.has(rel)) unowned.push(rel);
        continue;
      }
      if (scope && !scope.has(node.id)) {
        otherCount += 1;
        continue;
      }
      if (!exists) {
        paths.push({
          path: rel,
          owner_id: node.id,
          state: node.state,
          next_state: node.next?.state ?? null,
          class: "claimed_missing",
        });
        continue;
      }
      if (hasOpenUpdateFor(graph, buckets, node, rel)) {
        expected += 1;
        continue;
      }
      paths.push({
        path: rel,
        owner_id: node.id,
        state: node.state,
        next_state: node.next?.state ?? null,
        class: "owner_idle",
      });
    }

    let more = 0;
    const capped = <T>(list: T[]): T[] => {
      if (list.length <= DRIFT_LIST_CAP) return list;
      more += list.length - DRIFT_LIST_CAP;
      return list.slice(0, DRIFT_LIST_CAP);
    };
    const report: DriftReport = {
      paths: capped(paths),
      unowned: capped(unowned),
      expected,
      reminder: DRIFT_REMINDER,
    };
    if (more > 0) report.more = more;
    if (scope) report.other_count = otherCount;

    // Only expected edits: a count with no action to take is noise.
    if (paths.length === 0 && unowned.length === 0 && !(scope && otherCount > 0)) return null;
    return report;
  } catch {
    return null;
  } finally {
    if (options.cwd) {
      if (prev === undefined) delete process.env.MINDPLAN_ROOT;
      else process.env.MINDPLAN_ROOT = prev;
    }
  }
}

/**
 * Run integrity checks. Loads the territory graph from disk.
 */
export function runIntegrityCheck(options: CheckOptions = {}): CheckResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];
  let changeReport: ChangeCheck | undefined;
  let mergeReport: MergeReport | undefined;
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
    return { ok: false, failures, warnings, info, removedLegacyFiles: drainRemovedLegacyFiles() };
  }

  try {
    const buckets = checkExclusivity(graph, root, failures);
    const universe = listUniverseFiles(root);
    checkCoverage(graph, root, buckets, universe, failures);
    checkPresence(graph, root, failures);
    checkLeftovers(graph, buckets, root, failures);
    checkImports(graph, buckets, root, universe, failures, warnings);
    const collected = collectWarnings(graph, root);
    warnings.push(...collected.warnings);
    info.push(...collected.info);
    warnings.push(...legacyMirrorWarnings(graph));
    warnings.push(...routeFamilySplits(graph, buckets, universe));
    const decisionCtx = createDecisionContext(root);
    warnings.push(...collectDecisionWarnings(graph, decisionCtx));
    warnings.push(...collectHotspotWarnings(graph, root));
    const version = projectVersionStatus();
    if (version.warning) warnings.push(`version: ${version.warning}`);
    const probe = dirtyProbe(root);
    if (options.base !== undefined) {
      checkDirtySrc(graph, buckets, root, probe, options.base, failures);
    }
    if (options.change !== undefined) {
      changeReport = checkChange(graph, root, options.change, decisionCtx);
    }
    if (options.merge) {
      mergeReport = checkMerge(graph, root, options.merge, options.base, probe, failures);
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

  if (changeReport) {
    // A member violation the global import check already reported is not repeated.
    for (const f of changeReport.failures) {
      const plain = f.replace(/^Blocked: change "[^"]*": /, "Blocked: ");
      if (!failures.includes(plain)) failures.push(f);
    }
    for (const w of changeReport.warnings) if (!warnings.includes(w)) warnings.push(w);
    for (const line of changeReport.info) if (!info.includes(line)) info.push(line);
  }
  return {
    ok: failures.length === 0,
    failures,
    warnings,
    info,
    removedLegacyFiles: drainRemovedLegacyFiles(),
    ...(changeReport ? { change: changeReport } : {}),
    ...(mergeReport ? { merge: mergeReport } : {}),
  };
}

/**
 * The text `mindplan-mcp check` prints: `mindplan-mcp check: ok` or one `Blocked:` line
 * per failure, then any warnings, then info lines. The CLI and the run_check tool share it.
 */
export function renderCheckOutput(result: CheckResult): string {
  const lines = result.ok ? ["mindplan-mcp check: ok"] : [...result.failures];
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  for (const line of result.info) lines.push(`Info: ${line}`);
  return lines.join("\n");
}

/**
 * `run_check` MCP handler: the same text `mindplan-mcp check` prints, plus the parts split out.
 * `output` is `mindplan-mcp check: ok` or one `Blocked:` line per failure, then warnings and info.
 */
export function runCheckHandler(
  args: { base?: string; change?: string; merge?: MergeLevel } = {}
): Record<string, unknown> {
  const result = runIntegrityCheck({ base: args.base, change: args.change, merge: args.merge });
  return {
    ok: result.ok,
    output: renderCheckOutput(result),
    failures: result.failures,
    warnings: result.warnings,
    info: result.info,
    ...(result.change
      ? { change: { id: result.change.id, members: result.change.members, additivity: result.change.additivity } }
      : {}),
    ...(result.merge ? { merge: result.merge } : {}),
    ...(result.removedLegacyFiles.length
      ? { removed_legacy_files: result.removedLegacyFiles.map((f) => f.from) }
      : {}),
  };
}
