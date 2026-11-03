/**
 * Offline integrity check for MindPlan territory + declared file ownership.
 * Used by `mindplan-mcp check` (CLI) — not MCP stdio.
 */

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
  crossChangeClaimWarnings,
  findAllImportViolations,
  findAllOwnershipConflicts,
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
import { revisionGraph } from "../../foundations/f-compiler-rules/rules.js";
import { shapeWarning } from "../../foundations/f-compiler-rules/shape.js";
import { changeCycleFailures } from "../../foundations/f-compiler-rules/change-cycles.js";
import { waitingOnPeopleLine } from "../../foundations/f-compiler-rules/checklist-gates.js";
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
import { toPosix, withRoot } from "../../foundations/f-source-index/root-scope.js";
import { fanOutSettings, hotspotSettings } from "../../foundations/f-source-index/config.js";
import { fanOutContext, fanOutFor, fanOuts, fanOutWarning } from "../../foundations/f-fan-out/index.js";
import {
  changeAdditivity,
  hotspots,
  hotspotWarning,
  type ChangeAdditivity,
} from "../../foundations/f-compiler-rules/open-closed.js";
import { defaultBaseRef, repoPrefix, runGit } from "../../foundations/f-source-index/git.js";
import {
  drainRemovedLegacyFiles,
  loadGraph,
  isLegacyMirror,
  loadProjectConfig,
  markdownRelativePath,
  projectRoot,
  type RemovedLegacyFile,
} from "../../foundations/f-territory-store/store.js";
import { graphStatus } from "../../foundations/f-graph-migrations/status.js";
import { afterMergeFindings } from "./after-merge.js";
import { revisionSummaries } from "../../foundations/f-plan-views/views.js";
import { compactCheckResult, recordSeen, scopeWarnings, warningIds } from "./compact.js";
import { applyDelta, revisionFor, withRevision } from "../../foundations/f-revision-model/index.js";

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
  /** Also report what a git merge of two graph-changing branches left behind (`after-merge.ts`). */
  after_merge?: boolean;
}

export type MergeLevel = true | "strict";

/** One node the merge gate Blocks. `files` lists the changed claimed paths (strict only). */
export interface MergeNode {
  id: string;
  type: string;
  state: string;
  /** `revision`: an open revision stored under `revisions/<change>/`. */
  slot: "live" | "revision";
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
 * revision under the change) or a planned source (a shipped node with planned edges under it).
 */
export interface ChangeCheck {
  id: string;
  members: {
    id: string;
    type: string;
    kind: "revision" | "planned";
    /** The change id, on a revision member. */
    change?: string;
    state: string;
    next_state: string | null;
  }[];
  failures: string[];
  warnings: string[];
  info: string[];
  /** New nodes, reopened shipped nodes (with fan-in), and planned revisions. */
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
 * The slots the check reads on a node: each open revision as its own view (`withRevision`, tagged
 * with its change), else the node itself (live).
 */
function slotViews(node: MindPlanNode): { change: string | null; view: MindPlanNode }[] {
  const open = node.open_revisions ?? [];
  if (open.length === 0) return [{ change: null, view: node }];
  return open.map((r) => ({ change: r.change, view: withRevision(node, r.change) }));
}

/** How a check line names a node's open slot: `next` (a node's only revision), else `revision "<change>"`. */
function slotLabel(node: MindPlanNode, change: string | null): string {
  return change === null || (node.open_revisions?.length ?? 0) <= 1 ? "next" : `revision "${change}"`;
}

/**
 * The in-review gate on every revision of a change, judged on `revisionGraph(graph, change)` (each
 * member's revision of the change, every other node live): import and ownership violations on its
 * active-slot files (Blocked), every stale-text signal (warnings; planned paths go to info), and
 * its decision and fan-out warnings.
 */
function checkChange(
  fullGraph: MindPlanGraph,
  root: string,
  change: string,
  decisionCtx: DecisionContext
): ChangeCheck {
  const graph = revisionGraph(fullGraph, change);
  // Planned sources are listed, not gated: their files do not change until the change opens them.
  const { revisions, planned } = changeMembership(graph, change);
  const failures: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];
  if (revisions.length === 0 && planned.length === 0) {
    failures.push(
      `Blocked: change "${change}" has no members. Set it with open_next, create_node, or patch_node_territory (change).`
    );
  }
  for (const node of revisions) {
    // A shipped member is judged through its revision of this change; a pre-ship member is live.
    const c = revisionFor(node, change) ? change : undefined;
    for (const v of findImportViolationsForNode(fullGraph, root, node, c)) {
      failures.push(`Blocked: change "${change}": ${v.message}`);
    }
    for (const conflict of findOwnershipConflicts(fullGraph, root, node, c)) {
      failures.push(`Blocked: change "${change}": ${conflict}`);
    }
    for (const missing of testPresenceFailures(node, root)) {
      failures.push(`Blocked: change "${change}": ${missing}`);
    }
    const stale = staleTextWarnings(fullGraph, root, node, undefined, STALE_ALL, c);
    warnings.push(...stale.warnings);
    info.push(...stale.info);
  }
  for (const p of plannedEdgeProblems(graph, change)) {
    failures.push(`Blocked: change "${change}": planned edge ${p.source} -${p.type}-> ${p.target}: ${p.problem}`);
  }
  for (const f of changeCycleFailures(fullGraph, change)) failures.push(f.replace(/^Blocked: /, `Blocked: change "${change}": `));
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
  const fanOut = fanOutSettings(loadProjectConfig(root));
  const fanOutCtx = fanOutContext(graph);
  for (const node of revisions) {
    warnings.push(...decisionWarnings(fullGraph, node, decisionCtx, revisionFor(node, change) ? change : null));
    const f = fanOutFor(graph, node, fanOut, fanOutCtx);
    if (f) warnings.push(fanOutWarning(f));
    const untested = untestedWarning(node);
    if (untested) warnings.push(untested);
  }
  const member = (kind: "revision" | "planned") => (n: MindPlanNode) => ({
    id: n.id,
    type: n.type,
    kind,
    ...(kind === "revision" ? { change } : {}),
    state: n.state,
    next_state: n.next?.state ?? null,
  });
  const additivity = changeAdditivity(graph, change, { revisions, planned });
  if (revisions.length + planned.length > 0) info.push(`additivity: ${additivity.summary}`);
  return {
    id: change,
    additivity,
    members: [
      ...revisions.map(member("revision")),
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

function git(args: string[], cwd: string, required: boolean): string {
  try {
    // Trim only the trailing newline. A leading space is the unstaged half of
    // porcelain (` D path`); trimming it corrupts the first path.
    return runGit(args, cwd).replace(/\s+$/, "");
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

/**
 * Exclusivity per view (`findAllOwnershipConflicts`): a file two nodes claim live fails, and under
 * each change a file a revision of that change claims while another node claims it too fails,
 * naming the change. A file only revisions of different changes claim (on different nodes) never
 * meets in one view: it warns (`crossChangeClaimWarnings`), since the second to ship rebases into
 * a claim conflict.
 */
function checkExclusivity(
  graph: MindPlanGraph,
  root: string,
  failures: string[],
  warnings: string[]
): OwnershipBuckets {
  const groups = new Map<string, { file: string; change: string | null; ids: Set<string> }>();
  for (const p of findAllOwnershipConflicts(graph, root)) {
    const key = `${p.file}\n${p.change ?? ""}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { file: p.file, change: p.change, ids: new Set() }));
    g.ids.add(p.a);
    g.ids.add(p.b);
  }
  const failed = new Set<string>();
  const ordered = [...groups.values()].sort(
    (a, b) => (a.change === null ? 0 : 1) - (b.change === null ? 0 : 1) || (a.change ?? "").localeCompare(b.change ?? "")
  );
  for (const g of ordered) {
    if (failed.has(g.file)) continue;
    failed.add(g.file);
    const list = [...g.ids].sort().map((id) => `"${id}"`).join(", ");
    const under = g.change === null ? "" : ` under change "${g.change}"`;
    fail(failures, `exclusivity: "${g.file}" claimed by multiple nodes${under}: ${list}.`);
  }
  for (const w of crossChangeClaimWarnings(graph, root)) {
    const file = /^ownership: "([^"]+)"/.exec(w)?.[1];
    if (file && failed.has(file)) continue;
    warnings.push(w);
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

    // Each open revision on its own: a node may hold several.
    const lines = new Set<string>();
    for (const { change, view } of slotViews(node)) {
      if (view.next && view.next.state === "in-review") {
        checkSlot(view.next.implements, slotLabel(node, change), true);
      }
      for (const missing of testPresenceFailures(view, root)) lines.add(missing);
      // A revision in review must have written the files it attributes to itself.
      const reviewSlot = view.next ? view.next : view;
      if (reviewSlot.state === "in-review") {
        for (const f of reviewSlot.attributed ?? []) {
          if (!fs.existsSync(path.join(root, ...f.split("/")))) {
            lines.add(`presence: "${node.id}" attributed file missing on disk: "${f}".`);
          }
        }
      }
    }
    for (const line of lines) fail(failures, line);
  }
}

/** One `conflicts:` warning per open revision that still holds unresolved rebase conflicts. */
function conflictWarnings(graph: MindPlanGraph): string[] {
  const warnings: string[] = [];
  for (const node of graph.nodes) {
    for (const r of node.open_revisions ?? []) {
      if (r.conflicts.length === 0) continue;
      warnings.push(
        `conflicts: "${node.id}" revision "${r.change}" has ${r.conflicts.length} unresolved rebase conflict(s); resolve_conflict before in-review.`
      );
    }
  }
  return warnings;
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
        `call upgrade_project to remove it.`
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
 * are warnings for one release (existing graphs keep passing), then they Block. Claimed files
 * outside the universe are scanned too: the in-review gate scans every claimed file, so the
 * check must not pass what the gate Blocks.
 */
function checkImports(
  graph: MindPlanGraph,
  buckets: OwnershipBuckets,
  root: string,
  universe: string[],
  failures: string[],
  warnings: string[]
): void {
  const scanned = [
    ...new Set([
      ...universe,
      ...buckets.live.keys(),
      ...buckets.next.keys(),
      ...buckets.released.keys(),
      ...buckets.revisions.keys(),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  const seen = new Set<string>();
  for (const violation of findAllImportViolations(graph, buckets, root, scanned)) {
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
 * with no open update gets only the missing-path signal, unless one of its claimed files is in
 * `changed` (the paths changed against the base): the branch edited it in place, so it gets every
 * signal too. Nodes still being built are skipped: they are expected to name files they have not
 * written yet. A draft slot, or a Bug before review, with shape gaps gets one `shape:` warning, so
 * the sections are known before the gate.
 */
function collectWarnings(
  graph: MindPlanGraph,
  root: string,
  changed: string[] | null
): { warnings: string[]; info: string[] } {
  const editedInPlace = (node: MindPlanNode): boolean =>
    changed !== null && (node.implements ?? []).some((claim) => changed.some((rel) => claimCoversPath(claim, rel)));
  const warnings = new Set<string>();
  const info = new Set<string>();
  for (const node of graph.nodes) {
    // Each open revision is read on its own view (live plus that revision).
    for (const { change, view } of slotViews(node)) {
      // Description quality (every node type; never fails the check), per open revision.
      for (const w of descriptionWarnings(node, change ?? undefined)) warnings.add(w);
      const shape = shapeWarning(view);
      if (shape) warnings.add(shape);
      if (!isPipelineNodeType(node.type)) continue;
      if (RETIRED_STATES.has(node.state)) continue;
      const active = view.next ? view.next.state : view.state;
      const scope =
        active === "in-review"
          ? STALE_ALL
          : !view.next && isProductionState(view.state)
            ? editedInPlace(view)
              ? STALE_ALL
              : STALE_PATHS_ONLY
            : null;
      if (scope) {
        const stale = staleTextWarnings(graph, root, view, undefined, scope);
        for (const w of stale.warnings) warnings.add(w);
        for (const line of stale.info) info.add(line);
      }
      const untested = untestedWarning(view);
      if (untested) warnings.add(untested);
    }
  }
  return { warnings: [...warnings], info: [...info] };
}

/**
 * Decision warnings: every open revision (any pre-ship state, or each stored revision judged
 * under its change) that is decision-worthy and has no decision yet.
 * Moving it to in-review Blocks until one is recorded.
 */
function collectDecisionWarnings(graph: MindPlanGraph, ctx: DecisionContext): string[] {
  const warnings = new Set<string>();
  for (const node of graph.nodes) {
    for (const { change } of slotViews(node)) {
      for (const w of decisionWarnings(graph, node, ctx, change)) warnings.add(w);
    }
  }
  return [...warnings];
}

/**
 * Hotspot warnings, highest rank first: each shipped node that ships far more often than the
 * graph's median lately (config `hotspots`), with its recent change groups as candidate cuts.
 */
function collectHotspotWarnings(graph: MindPlanGraph, root: string): string[] {
  return hotspots(graph, hotspotSettings(loadProjectConfig(root))).map(hotspotWarning);
}

/**
 * Fan-out warnings, highest count first: each pre-ship node whose depends_on targets sit in at
 * least `fan_out.warn_at` other unshipped changes, so it may have to know every feature of a kind.
 */
function collectFanOutWarnings(graph: MindPlanGraph, root: string): string[] {
  return fanOuts(graph, fanOutSettings(loadProjectConfig(root))).map(fanOutWarning);
}

function bugAllowsDirty(graph: MindPlanGraph, nodeId: string): boolean {
  return graph.nodes.some(
    (n) =>
      n.type === "Bug" &&
      BUG_MID_PIPELINE.has(n.state) &&
      (n.affects ?? []).includes(nodeId)
  );
}

/** A node's open slots for the dirty-file rules: each open revision (with its change). Empty when none is open. */
function openSlots(node: MindPlanNode): { change: string; state: string }[] {
  return (node.open_revisions ?? []).map((r) => ({ change: r.change, state: r.state }));
}

/** True when the node's open revision of `change` claims `rel` (live with its delta applied). */
function revisionClaims(buckets: OwnershipBuckets, node: MindPlanNode, change: string, rel: string): boolean {
  return (buckets.revisions.get(rel) ?? []).some((c) => c.id === node.id && c.change === change);
}

/**
 * True when one of the node's open slots in `states` may be touching `rel`: a revision when it
 * claims the file (live ⊕ its delta) or the file is a live claim it releases.
 */
function openSlotAllows(
  buckets: OwnershipBuckets,
  node: MindPlanNode,
  rel: string,
  states: Set<string>
): boolean {
  return openSlots(node).some(
    (s) =>
      states.has(s.state) &&
      (revisionClaims(buckets, node, s.change, rel) || buckets.liveClaims.get(rel) === node.id)
  );
}

function ownerAllowsWorkingTree(
  graph: MindPlanGraph,
  buckets: OwnershipBuckets,
  node: MindPlanNode,
  rel: string
): boolean {
  if (openSlots(node).length > 0) {
    if (openSlotAllows(buckets, node, rel, ACTIVE_BUILD)) return true;
    return bugAllowsDirty(graph, node.id);
  }
  if (ACTIVE_BUILD.has(node.state)) return true;
  // A shipped node's files are edited in place: stable/unstable with no open revision.
  if (isProductionState(node.state)) return true;
  return bugAllowsDirty(graph, node.id);
}

function ownerAllowsCommitDiff(
  graph: MindPlanGraph,
  buckets: OwnershipBuckets,
  node: MindPlanNode,
  rel: string
): boolean {
  if (openSlots(node).length > 0) {
    if (openSlotAllows(buckets, node, rel, MID_PIPELINE)) return true;
    return bugAllowsDirty(graph, node.id);
  }
  if (CLAIMED_OR_CONCLUDED.has(node.state)) return true;
  return bugAllowsDirty(graph, node.id);
}

/** The open revisions of a node with several, as drift and dirty-src lines name them; else undefined. */
/** With several open revisions: each one's change and state, sorted by change; else undefined. */
function revisionStates(node: MindPlanNode): { change: string; state: string }[] | undefined {
  if ((node.open_revisions?.length ?? 0) < 2) return undefined;
  return revisionSummaries(node).map(({ change, state }) => ({ change, state }));
}

function describeOwner(node: MindPlanNode): string {
  const revs = revisionStates(node);
  if (revs) {
    return `"${node.id}" is "${node.state}" (revisions: ${revs.map((r) => `"${r.change}" ${r.state}`).join(", ")})`;
  }
  return `"${node.id}" is "${node.state}"` + (node.next ? ` (next: ${node.next.state})` : "");
}

/**
 * One run's git probe of the changed paths, memoized per base: dirty-src, the strict merge gate,
 * and the in-place stale-text pass share one `git status` / `git diff`, and a failed probe is
 * reported once (`repeat` on later calls). A `quiet` caller ignores failures, so its call does not
 * count as the report.
 */
type DirtyProbe = (
  base: string,
  opts?: { quiet?: boolean }
) => { dirty: DirtySrcPaths } | { error: string; repeat: boolean };

function dirtyProbe(cwd: string): DirtyProbe {
  const results = new Map<string, { dirty: DirtySrcPaths } | { error: string }>();
  const reported = new Set<string>();
  return (base, opts = {}) => {
    let result = results.get(base);
    if (!result) {
      try {
        result = { dirty: collectDirtySrcPaths(cwd, base) };
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) };
      }
      results.set(base, result);
    }
    if (!("error" in result)) return result;
    const repeat = reported.has(base);
    if (!opts.quiet) reported.add(base);
    return { ...result, repeat };
  };
}

/**
 * The paths changed against the base (`base`, else the default-branch merge base), committed and
 * uncommitted, for the in-place stale-text pass; null without git or a base, which reports nothing.
 */
function changedAgainstBase(root: string, probe: DirtyProbe, base: string | undefined): string[] | null {
  const ref = base ?? defaultBaseRef(root);
  if (!ref) return null;
  const probed = probe(ref, { quiet: true });
  if ("error" in probed) return null;
  return [...new Set([...probed.dirty.commits, ...probed.dirty.workingTree])];
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
    allow: (g: MindPlanGraph, b: OwnershipBuckets, n: MindPlanNode, rel: string) => boolean,
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
    if (!allow(graph, buckets, node, rel)) {
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
      "Uncommitted changes require in-progress (or a revision in-progress), a shipped owner with no open revision, or a Bug in fixing/in-review."
    );
  }

  for (const rel of dirty.commits) {
    if (workingSet.has(rel)) continue;
    if (!fs.existsSync(path.join(cwd, ...rel.split("/")))) continue;
    if (!universe.has(rel) && !ownerOfFile(buckets, rel)) continue;
    checkPath(
      rel,
      ownerAllowsCommitDiff,
      "Committed diffs require in-progress/in-review/stable/unstable/cancelled/deprecated, or a revision in-progress/in-review, or a Bug in fixing/in-review."
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
  const slot = node.slot === "live" ? "" : `${node.slot} `;
  const where = `"${node.id}" (${node.type}, ${slot}${node.state}, ${change ? `change "${change}"` : "no change"})`;
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
    // Each open revision is gated on its own, under its change.
    for (const { change: revision, view } of slotViews(node)) {
      const slot = revision !== null ? "revision" : "live";
      const state = view.next ? view.next.state : view.state;
      const change = revision ?? activeChange(view) ?? null;
      if (state === "in-review") {
        found.push({ change, node: { id: node.id, type: node.type, state, slot } });
      } else if (state === "in-progress" && changed) {
        const claims = (view.next ? view.next.implements : view.implements) ?? [];
        const files = changed.filter((rel) => claims.some((claim) => claimCoversPath(claim, rel)));
        if (files.length > 0) {
          found.push({ change, node: { id: node.id, type: node.type, state, slot, files } });
        }
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
  /** Present when the owner has several open revisions (`next_state` is then null). */
  revisions?: { change: string; state: string }[];
  class: DriftClass;
};

function driftRevisions(node: MindPlanNode): { revisions?: { change: string; state: string }[] } {
  const revisions = revisionStates(node);
  return revisions ? { revisions } : {};
}

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
    // Every open revision's claims (live with its delta), then live.
    const slots: { claims: string[] | undefined; viaNext: boolean }[] = [
      ...(node.open_revisions ?? []).map((r) => ({ claims: applyDelta(node.implements, r.implements), viaNext: true })),
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

/**
 * True when the owner has an open update that is allowed to be editing `rel` right now: an
 * in-progress open revision that claims the file (each revision read as live with
 * its delta), a pre-ship node in progress, or a Bug in fixing/in-review.
 */
function hasOpenUpdateFor(
  graph: MindPlanGraph,
  buckets: OwnershipBuckets,
  node: MindPlanNode,
  rel: string
): boolean {
  const slots = openSlots(node);
  if (slots.length > 0) {
    for (const s of slots) {
      if (!ACTIVE_BUILD.has(s.state)) continue;
      if (revisionClaims(buckets, node, s.change, rel)) return true;
    }
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
  return withRoot(options.cwd, () => driftReportInScope(options));
}

function driftReportInScope(options: DriftOptions): DriftReport | null {
  const root = projectRoot();
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
          ...driftRevisions(node),
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
        ...driftRevisions(node),
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
  }
}

/**
 * Run integrity checks. Loads the territory graph from disk.
 */
export function runIntegrityCheck(options: CheckOptions = {}): CheckResult {
  return withRoot(options.cwd, () => integrityCheckInScope(options));
}

function integrityCheckInScope(options: CheckOptions): CheckResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];
  let changeReport: ChangeCheck | undefined;
  let mergeReport: MergeReport | undefined;
  const root = projectRoot();

  // A graph that needs setup or an upgrade is not checked: the code may misread it.
  if (process.env.MINDPLAN_VERSION_GATE !== "off") {
    const status = graphStatus();
    if (status.state !== "current") {
      if (options.after_merge) failures.push(...afterMergeFindings(null, root, { skipVersion: true }).failures);
      fail(failures, `Blocked: Version — ${status.warning}`);
      return { ok: false, failures, warnings, info, removedLegacyFiles: drainRemovedLegacyFiles() };
    }
  }

  let graph: MindPlanGraph;
  try {
    // Config must load (Blocked on legacy implementation_packages).
    loadProjectConfig(root);
    graph = loadGraph();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // After a merge, name what broke the load (conflict markers, a file that no longer parses) first.
    if (options.after_merge) failures.push(...afterMergeFindings(null, root).failures);
    fail(failures, `graph load failed: ${message}`);
    return { ok: false, failures, warnings, info, removedLegacyFiles: drainRemovedLegacyFiles() };
  }

  try {
    if (options.after_merge) {
      const afterMerge = afterMergeFindings(graph, root);
      failures.push(...afterMerge.failures);
      warnings.push(...afterMerge.warnings);
    }
    const buckets = checkExclusivity(graph, root, failures, warnings);
    const universe = listUniverseFiles(root);
    checkCoverage(graph, root, buckets, universe, failures);
    checkPresence(graph, root, failures);
    checkLeftovers(graph, buckets, root, failures);
    checkImports(graph, buckets, root, universe, failures, warnings);
    for (const f of changeCycleFailures(graph)) fail(failures, f);
    const probe = dirtyProbe(root);
    const collected = collectWarnings(graph, root, changedAgainstBase(root, probe, options.base));
    warnings.push(...collected.warnings);
    info.push(...collected.info);
    warnings.push(...legacyMirrorWarnings(graph));
    warnings.push(...conflictWarnings(graph));
    warnings.push(...routeFamilySplits(graph, buckets, universe));
    const decisionCtx = createDecisionContext(root);
    warnings.push(...collectDecisionWarnings(graph, decisionCtx));
    warnings.push(...collectHotspotWarnings(graph, root));
    warnings.push(...collectFanOutWarnings(graph, root));
    const waiting = waitingOnPeopleLine(graph);
    if (waiting) info.push(waiting);
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
 * `run_check` MCP handler. `compact: true` (the MCP default) returns counts, failures, and only the
 * warnings not seen in the previous check nor acknowledged (compact.ts); otherwise it returns
 * the text `mindplan-mcp check` prints, plus the parts split out. `nodes` scopes warnings.
 */
export function runCheckHandler(
  args: {
    base?: string;
    change?: string;
    merge?: MergeLevel;
    after_merge?: boolean;
    compact?: boolean;
    nodes?: string[];
  } = {}
): Record<string, unknown> {
  const result = runIntegrityCheck({
    base: args.base,
    change: args.change,
    merge: args.merge,
    after_merge: args.after_merge,
  });
  const nodes = args.nodes?.length ? new Set(args.nodes) : undefined;
  const root = projectRoot();
  const { kept, outside } = scopeWarnings(result.warnings, nodes);
  const extras = {
    ...(result.change
      ? { change: { id: result.change.id, members: result.change.members, additivity: result.change.additivity } }
      : {}),
    ...(result.merge ? { merge: result.merge } : {}),
    ...(result.removedLegacyFiles.length
      ? { removed_legacy_files: result.removedLegacyFiles.map((f) => f.from) }
      : {}),
  };
  if (args.compact === true) {
    // Only a compact check records what it showed; a full one lists everything and records nothing.
    const ids = warningIds(result.warnings);
    const seen = recordSeen(root, result.warnings, ids, nodes);
    return {
      ...compactCheckResult({
        ok: result.ok,
        failures: result.failures,
        warnings: kept,
        info: result.info,
        outside,
        seen,
        ids,
        root,
        scoped: nodes !== undefined,
      }),
      ...extras,
    };
  }
  const scoped = { ...result, warnings: kept };
  return {
    ok: result.ok,
    output: renderCheckOutput(scoped),
    failures: result.failures,
    warnings: kept,
    info: result.info,
    ...extras,
  };
}
