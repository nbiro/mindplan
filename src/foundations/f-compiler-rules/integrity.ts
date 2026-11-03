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
import { isInactiveNode, isPipelineNodeType, isProductionState } from "../f-domain-model/types.js";
import {
  claimEntryExists,
  expandClaims,
  isGlobClaim,
  namesPath,
  validateClaimPath,
} from "../f-source-index/claims.js";
import { decisionGateSettings, loadProjectConfig } from "../f-source-index/config.js";
import {
  collectOtherClaims,
  isDominatedFolder,
  schemaClaimEntries,
  type OtherClaims,
} from "../f-source-index/dominance.js";
import { applyDelta, openChanges, revisionFor } from "../f-revision-model/index.js";
import { listResolvedImports } from "../f-source-index/imports.js";
import {
  buildOwnershipIndex,
  claimantsOf,
  exclusiveOwner,
  type OwnershipBuckets,
} from "../f-source-index/ownership.js";
import { listUniverseFiles } from "../f-source-index/universe.js";
import {
  countCheckboxesInText,
  splitContext,
  withoutOwnedSections,
} from "../f-territory-store/store.js";
import {
  assertAcyclicDependsOn,
  assertNoRevisionConflicts,
  blocked,
  effectiveRole,
  importAllowed,
  liveGraph,
  nodeUnder,
  revisionGraph,
  revisionViews,
} from "./rules.js";
import { slotSource } from "./shape.js";
import { testImportAllowed } from "./test-imports.js";

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
  /** The change whose open revision claims the file, when the owner claims it only through revisions. */
  change?: string;
};

/**
 * The change a per-node gate judges `node` under: `change` when given, else the change of the
 * revision its `next` views (a `nodeUnder` / `graphUnder` node, or the loader's single-revision
 * view), else none (live).
 */
export function gateChange(node: MindPlanNode, change?: string): string | null {
  if (change !== undefined) return change;
  const viewed = node.next?.change;
  return viewed && revisionFor(node, viewed) ? viewed : null;
}

/** The graph a gate judges under: live plus that change's revisions, or live. */
function judgeGraph(graph: MindPlanGraph, change: string | null): MindPlanGraph {
  return change === null ? liveGraph(graph) : revisionGraph(graph, change);
}

/** The node as it stands in `g` (a view), or the input when `g` does not hold it. */
function inGraph(g: MindPlanGraph, node: MindPlanNode): MindPlanNode {
  return g.nodes.find((n) => n.id === node.id) ?? node;
}

/** The claim entries of a node's active slot in its graph view: its revision's next view, or live. */
function activeClaims(node: MindPlanNode): string[] {
  return (node.next ? node.next.implements : node.implements) ?? [];
}

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
      if (importAllowed(owner, to, graph) || testImportAllowed(graph, buckets, file, to)) continue;
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
 * One view of the graph the import and ownership rules run under: live when `change` is null, else live plus that change's open revisions only.
 */
type RulePass = { change: string | null; graph: MindPlanGraph; buckets: OwnershipBuckets };

function rulePass(graph: MindPlanGraph, root: string, change: string | null): RulePass {
  const g = judgeGraph(graph, change);
  return { change, graph: g, buckets: buildOwnershipIndex(g, root) };
}

/**
 * The change a pre-ship member is judged under: a pre-ship, active Foundation, Interaction, or
 * Interface sees its own change's revisions on shipped co-members (an edge the change adds to a
 * shipped node is in place for it). Null for any other node.
 */
export function preShipChange(node: MindPlanNode): string | null {
  if (!isPipelineNodeType(node.type) || node.shipped_at || isInactiveNode(node)) return null;
  return node.change || null;
}

/**
 * The live pass for `node`: live, except that a pre-ship member of a change
 * sees that change's revisions (`revisionGraph`). Its `change` stays null: the node's own claims
 * are live ones, so violations are not tagged as a revision's.
 */
function livePassFor(graph: MindPlanGraph, root: string, node: MindPlanNode): RulePass {
  const own = preShipChange(node);
  if (own === null) return rulePass(graph, root, null);
  const g = revisionGraph(graph, own);
  return { change: null, graph: g, buckets: buildOwnershipIndex(g, root) };
}

/** One owner's view of one file: the pass it is judged under and whether that claim alone is advisory. */
type OwnerView = { pass: RulePass; owner: MindPlanNode; advisory: boolean };

/**
 * The import rule on one owner's files under one pass: the single scan both the check and the
 * per-transition gate run (`scanFiles` over the pass's graph and ownership).
 */
function scanUnder(pass: RulePass, root: string, owner: MindPlanNode, files: string[], self?: Set<string>, releasedTargets = false): ImportViolation[] {
  const found = scanFiles(pass.graph, pass.buckets, root, owner, files, self, { releasedTargets });
  return pass.change === null ? found : found.map((v) => ({ ...v, change: pass.change! }));
}

/**
 * Every illegal import across the ownership universe (the check's import rule). Each file is
 * scanned as every node that claims it, in every view it claims it in: live (live and released
 * claims, under the live graph) and each open revision (under `revisionGraph` of
 * its change, its file owners resolved for that change). An import is reported for an owner only
 * when every view in which that owner claims the file finds it illegal, so a revision that adds
 * the edge an import needs clears it. Import targets resolve through released claims too. A
 * violation the exclusive-owner scan alone would not find is `advisory`. `buckets` is accepted for
 * callers that built one; each view builds its own.
 */
export function findAllImportViolations(
  graph: MindPlanGraph,
  _buckets: OwnershipBuckets,
  root: string,
  universe: string[] = listUniverseFiles(root)
): ImportViolation[] {
  const live = rulePass(graph, root, null);
  const passes = new Map<string, RulePass>();
  const passFor = (change: string): RulePass => {
    let p = passes.get(change);
    if (!p) passes.set(change, (p = rulePass(graph, root, change)));
    return p;
  };
  // A pre-ship member of a change is judged seeing that change's revisions (`livePassFor`).
  const memberPasses = new Map<string, RulePass>();
  const livePass = (owner: MindPlanNode): RulePass => {
    const own = preShipChange(owner);
    if (own === null) return live;
    let p = memberPasses.get(own);
    if (!p) memberPasses.set(own, (p = livePassFor(graph, root, owner)));
    return p;
  };
  const out: ImportViolation[] = [];
  for (const file of universe) {
    const views = new Map<string, OwnerView[]>();
    const add = (id: string, view: OwnerView) => views.set(id, [...(views.get(id) ?? []), view]);
    const exclusive = exclusiveOwner(live.buckets, file);
    for (const c of claimantsOf(live.buckets, file)) {
      if (c.via === "revision") continue;
      const liveOwner = live.graph.nodes.find((n) => n.id === c.id);
      if (!liveOwner) continue;
      const pass = livePass(liveOwner);
      if (views.get(c.id)?.some((v) => v.pass === pass)) continue;
      const owner = inGraph(pass.graph, liveOwner);
      // A live claim every open revision of its owner drops is released: its scan only warns.
      const open = openChanges(owner);
      const released = open.length > 0 && open.every((ch) => live.buckets.releasedByChange.get(ch)?.get(file) === owner.id);
      add(c.id, { pass, owner, advisory: c.id !== exclusive || released });
    }
    for (const r of live.buckets.revisions.get(file) ?? []) {
      const pass = passFor(r.change);
      const owner = pass.graph.nodes.find((n) => n.id === r.id);
      if (owner) add(r.id, { pass, owner, advisory: false });
    }
    for (const ownerViews of views.values()) {
      const found = ownerViews.map((v) =>
        scanUnder(v.pass, root, v.owner, [file], undefined, true).map((x) => ({ ...x, advisory: x.advisory || v.advisory }))
      );
      for (const v of pickEveryView(found)) out.push(v);
    }
  }
  return out;
}

/**
 * The violations every view found (keyed by imported file), one per import: the first view's,
 * not advisory when any view's is not.
 */
function pickEveryView(found: ImportViolation[][]): ImportViolation[] {
  if (found.length === 0) return [];
  if (found.length === 1) return found[0];
  const out: ImportViolation[] = [];
  for (const v of found[0]) {
    const same = found.map((list) => list.find((x) => x.imports === v.imports));
    if (same.some((x) => !x)) continue;
    const strict = same.find((x) => !x!.advisory);
    out.push(strict ?? v);
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
    const revisionAdds = (node.open_revisions ?? []).flatMap((r) => r.implements.add);
    for (const raw of [...(node.implements ?? []), ...(node.next?.implements ?? []), ...revisionAdds]) {
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

/**
 * What one check run shares across its Coverage fixes: the schema globs (config read once) and
 * each shipped owner's view of the other nodes' claims (expanded once per owner, not per file).
 */
export interface CoverageFixContext {
  schemaGlobs: string[];
  othersByOwner: Map<string, OtherClaims>;
}

export function createCoverageFixContext(root: string): CoverageFixContext {
  return {
    schemaGlobs: decisionGateSettings(loadProjectConfig(root)).schema_files,
    othersByOwner: new Map(),
  };
}

/**
 * The calls that add `file` to the owner's active claim list: its open revision (named by change
 * when it has several), else live. A shipped owner with no open revision opens one first, unless
 * the file's folder is one it dominates and the file is not a migration or schema file (then the
 * claim is additive in place).
 */
export function coverageFix(
  graph: MindPlanGraph,
  root: string,
  owner: MindPlanNode,
  file: string,
  ctx: CoverageFixContext = createCoverageFixContext(root)
): CoverageFixCall[] {
  const inPlace = (): boolean => {
    if (schemaClaimEntries([file], ctx.schemaGlobs, root).length > 0) return false;
    let others = ctx.othersByOwner.get(owner.id);
    if (!others) {
      others = collectOtherClaims(graph, owner.id, root);
      ctx.othersByOwner.set(owner.id, others);
    }
    return isDominatedFolder(graph, owner.id, path.posix.dirname(file), root, [file], others);
  };
  // The claim goes into the owner's open revision; with several, the first, named by change.
  const open = openChanges(owner);
  if (open.length > 0) {
    return [
      {
        tool: "set_implementation_files",
        args: open.length > 1 ? { node_id: owner.id, change: open[0], add: [file] } : { node_id: owner.id, add: [file] },
      },
    ];
  }
  if (owner.shipped_at && !inPlace()) {
    return [
      { tool: "open_next", args: { node_id: owner.id, change: "<change-id>" } },
      { tool: "set_implementation_files", args: { node_id: owner.id, change: "<change-id>", add: [file] } },
    ];
  }
  return [{ tool: "set_implementation_files", args: { node_id: owner.id, add: [file] } }];
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
  return `"${node.id}" (${node.type})`;
}

/**
 * Warnings for route families whose route files have more than one owner. The rule: the
 * Assembler owns routes that dispatch to whichever template is active; a template's
 * Interface owns only routes that exist for that template alone.
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
        `a template's Interface owns only routes that exist for that template alone. ` +
        `Move the family's routes to one owner with set_implementation_files.`
    );
  }
  return warnings;
}

/**
 * Illegal imports of the files `claimed` by `node` (claim entries; directories end in `/`).
 * Used when files are claimed, so a missing edge is reported with its link_nodes call. With
 * `change`, the claim is judged under `revisionGraph(graph, change)` (the node's revision of it).
 */
export function findImportViolationsForClaim(
  graph: MindPlanGraph,
  root: string,
  node: MindPlanNode,
  claimed: string[],
  change?: string
): ImportViolation[] {
  if (!isPipelineNodeType(node.type)) return [];
  const pass = change === undefined ? { change: null, graph, buckets: buildOwnershipIndex(graph, root) } : rulePass(graph, root, change);
  const files = expandClaims(claimed, root);
  return scanUnder(pass, root, inGraph(pass.graph, node), files, new Set(files));
}

/**
 * Illegal imports of the node's active-slot files: its revision of `gateChange(node, change)`
 * under that change's graph, else its live files under the live graph. The same
 * scan the check runs, restricted to this owner and view.
 */
export function findImportViolationsForNode(
  graph: MindPlanGraph,
  root: string,
  node: MindPlanNode,
  change?: string
): ImportViolation[] {
  if (!isPipelineNodeType(node.type)) return [];
  const c = gateChange(node, change);
  const pass = c === null ? livePassFor(graph, root, node) : rulePass(graph, root, c);
  const owner = inGraph(pass.graph, node);
  const files = expandClaims(activeClaims(owner), root);
  return scanUnder(pass, root, owner, files, new Set(files));
}

/** Two nodes claiming one file in one view; `change` is the view's (null for live). */
export type OwnershipConflict = { file: string; a: string; b: string; change: string | null };

/**
 * The ownership rule under one view: every file two non-retired pipeline nodes claim in their
 * active slot there (next or revision view, else live). Under a change, only pairs where a node
 * claims the file through its revision of that change (pairs live alone already has are the live
 * view's). Two revisions of the same change claiming one file conflict; revisions of different
 * changes never meet in one view (see `crossChangeClaimWarnings`).
 */
function ownershipConflictsUnder(
  pass: { change: string | null; graph: MindPlanGraph },
  root: string,
  filesOf: (n: MindPlanNode) => string[] = (n) => expandClaims(activeClaims(n), root)
): OwnershipConflict[] {
  const claims = new Map<string, string[]>();
  for (const n of pass.graph.nodes) {
    if (!isPipelineNodeType(n.type) || n.state === "cancelled" || n.state === "deprecated") continue;
    for (const f of new Set(filesOf(n))) claims.set(f, [...(claims.get(f) ?? []), n.id]);
  }
  const byId = new Map(pass.graph.nodes.map((n) => [n.id, n]));
  const revised = (id: string) => pass.change !== null && Boolean(revisionFor(byId.get(id)!, pass.change));
  const out: OwnershipConflict[] = [];
  for (const [file, ids] of claims) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (pass.change !== null && !revised(ids[i]) && !revised(ids[j])) continue;
        out.push({ file, a: ids[i], b: ids[j], change: pass.change });
      }
    }
  }
  return out;
}

/**
 * Every ownership conflict: the live view's, then each open change's (live plus that change's
 * revisions). The check and the per-transition gate (`findOwnershipConflicts`) share it. Live
 * claims are expanded once; a change's view re-expands only the nodes it revises.
 */
export function findAllOwnershipConflicts(graph: MindPlanGraph, root: string): OwnershipConflict[] {
  const changes = new Set<string>();
  for (const n of graph.nodes) for (const c of openChanges(n)) changes.add(c);
  const live = liveGraph(graph);
  const liveFiles = new Map(live.nodes.map((n) => [n.id, expandClaims(activeClaims(n), root)]));
  const all = [
    ...ownershipConflictsUnder({ change: null, graph: live }, root, (n) => liveFiles.get(n.id)!),
    ...[...changes].sort().flatMap((c) =>
      ownershipConflictsUnder({ change: c, graph: revisionGraph(graph, c) }, root, (n) =>
        revisionFor(n, c) ? expandClaims(activeClaims(n), root) : liveFiles.get(n.id) ?? expandClaims(activeClaims(n), root)
      )
    ),
  ];
  // A pair live already has (a revision kept the claim) is reported once, as live's.
  const seen = new Set<string>();
  return all.filter((p) => {
    const key = `${p.file}\n${[p.a, p.b].sort().join("\n")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Active-slot files also claimed by another node, in the node's view (`gateChange`): its revision
 * of that change against live plus that change, else live. A filter of the check's rule.
 */
export function findOwnershipConflicts(
  graph: MindPlanGraph,
  root: string,
  node: MindPlanNode,
  change?: string
): string[] {
  const c = gateChange(node, change);
  return ownershipConflictsUnder({ change: c, graph: judgeGraph(graph, c) }, root)
    .filter((p) => p.a === node.id || p.b === node.id)
    .map((p) => `ownership: "${p.file}" claimed by "${node.id}" and "${p.a === node.id ? p.b : p.a}".`);
}

/**
 * The import and ownership rules on every member of `change` (`findImportViolationsForNode` and
 * `findOwnershipConflicts`, each member judged through its revision of the change, else live),
 * in one pass: each view's ownership index and conflicts are computed once and filtered per member.
 * Keyed by member id.
 */
export function changeMemberViolations(
  graph: MindPlanGraph,
  root: string,
  members: MindPlanNode[],
  change: string
): Map<string, { imports: ImportViolation[]; ownership: string[] }> {
  const passes = new Map<string, RulePass>();
  const conflicts = new Map<string | null, OwnershipConflict[]>();
  const out = new Map<string, { imports: ImportViolation[]; ownership: string[] }>();
  for (const node of members) {
    const c = gateChange(node, revisionFor(node, change) ? change : undefined);
    let imports: ImportViolation[] = [];
    if (isPipelineNodeType(node.type)) {
      // A live pass depends only on the change a pre-ship member sees (`livePassFor`).
      const key = c === null ? `live\0${preShipChange(node) ?? ""}` : `change\0${c}`;
      let pass = passes.get(key);
      if (!pass) passes.set(key, (pass = c === null ? livePassFor(graph, root, node) : rulePass(graph, root, c)));
      const owner = inGraph(pass.graph, node);
      const files = expandClaims(activeClaims(owner), root);
      imports = scanUnder(pass, root, owner, files, new Set(files));
    }
    let pairs = conflicts.get(c);
    if (!pairs) conflicts.set(c, (pairs = ownershipConflictsUnder({ change: c, graph: judgeGraph(graph, c) }, root)));
    const ownership = pairs
      .filter((p) => p.a === node.id || p.b === node.id)
      .map((p) => `ownership: "${p.file}" claimed by "${node.id}" and "${p.a === node.id ? p.b : p.a}".`);
    out.set(node.id, { imports, ownership });
  }
  return out;
}

/**
 * Warnings (never Blocks) for a file claimed through open revisions of different changes on
 * different nodes, where neither node claims it live: allowed while the changes stay separate,
 * but whichever ships second must drop or take over the claim.
 */
export function crossChangeClaimWarnings(graph: MindPlanGraph, root: string): string[] {
  const buckets = buildOwnershipIndex(liveGraph(graph), root);
  const out: string[] = [];
  for (const [file, claims] of [...buckets.revisions].sort(([a], [b]) => a.localeCompare(b))) {
    const fresh = claims.filter((c) => buckets.liveClaims.get(file) !== c.id);
    for (let i = 0; i < fresh.length; i++) {
      for (let j = i + 1; j < fresh.length; j++) {
        const [x, y] = [fresh[i], fresh[j]];
        if (x.id === y.id || x.change === y.change) continue;
        out.push(
          `ownership: "${file}" is claimed by "${x.id}" (revision "${x.change}") and "${y.id}" (revision "${y.change}"). ` +
            `Allowed while the changes are separate; whichever ships second must drop the claim or take it over.`
        );
      }
    }
  }
  return out;
}

/**
 * Ship-gate: the check's import and ownership rules on one node's files, in its view
 * (`gateChange(node, change)`). Throws `Blocked:` with every violation and its fix.
 */
export function assertCheckCleanForNode(
  graph: MindPlanGraph,
  root: string,
  node: MindPlanNode,
  targetLabel: string,
  change?: string
): void {
  if (!isPipelineNodeType(node.type)) return;
  const c = gateChange(node, change);
  const view = c === null ? node : nodeUnder(node, c);
  const problems = [
    ...findImportViolationsForNode(graph, root, node, c ?? undefined).map((v) => v.message),
    ...findOwnershipConflicts(graph, root, node, c ?? undefined),
    ...missingTestMessages(view, root),
  ];
  if (problems.length === 0) return;
  const label = c !== null && revisionFor(node, c) && (node.open_revisions?.length ?? 0) > 1 ? `"${node.id}" revision "${c}"` : `"${node.id}"`;
  throw blocked(
    `Check failed for ${label} before "${targetLabel}" (${problems.length} violation(s)):\n` +
      problems.map((p) => `- ${p}`).join("\n")
  );
}

/**
 * Ship-gate for one open revision: unresolved rebase conflicts Block first (in-review / ship),
 * then the check's import, ownership, and linked-test rules on the revision's files under
 * live plus `change`.
 */
export function assertCheckCleanForRevision(
  graph: MindPlanGraph,
  root: string,
  node: MindPlanNode,
  change: string,
  targetLabel: string
): void {
  if (targetLabel === "in-review" || targetLabel === "ship") assertNoRevisionConflicts(node, change);
  assertCheckCleanForNode(graph, root, node, targetLabel, change);
}

// ---------------------------------------------------------------------------
// Linked tests
// ---------------------------------------------------------------------------

/** One `presence:` line per `tests` entry that matches nothing on disk, whatever the node's state. */
function missingTestMessages(node: MindPlanNode, root: string): string[] {
  return (node.tests ?? [])
    .filter((entry) => !claimEntryExists(entry, root))
    .map((entry) => `presence: "${node.id}" tests entry missing on disk: "${entry}".`);
}

/**
 * Linked tests missing on disk, once the node is in review or shipped (live in-review or
 * stable/unstable, or its next in-review). A draft plan may link tests it has not written yet.
 */
export function testPresenceFailures(node: MindPlanNode, root: string): string[] {
  if (!isPipelineNodeType(node.type) || isInactiveNode(node)) return [];
  const due =
    node.state === "in-review" || isProductionState(node.state) || node.next?.state === "in-review";
  const out = due ? missingTestMessages(node, root) : [];
  // An in-review revision's linked tests (live with its test delta) are due too.
  for (const view of revisionViews(node)) {
    if (view.next?.state !== "in-review") continue;
    for (const m of missingTestMessages(view, root)) if (!out.includes(m)) out.push(m);
  }
  return out;
}

/** A nudge, never a Block: a Foundation, Interaction, or Interface in review with no linked tests. */
export function untestedWarning(node: MindPlanNode): string | null {
  if (!isPipelineNodeType(node.type) || isInactiveNode(node)) return null;
  const views = node.next || !node.open_revisions?.length ? [node] : revisionViews(node);
  const untested = views.some((v) => {
    const active = v.next ? v.next.state : v.state;
    return active === "in-review" && (v.tests?.length ?? 0) === 0;
  });
  if (!untested) return null;
  return `tests: "${node.id}" is in review with no linked tests; link the files that verify it with set_test_files.`;
}

// ---------------------------------------------------------------------------
// Stale-text warnings
// ---------------------------------------------------------------------------

const PATH_TOKEN = /`([A-Za-z0-9_.\-][A-Za-z0-9_.\-/]*\/[A-Za-z0-9_.\-/]*)`/g;
const CHECKBOX_ITEM_LINE = /^([ \t]*)[-*+][ \t]+\[[ xX]\]/;
const LIST_ITEM_LINE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]/;
const HEADING_LINE = /^#{1,6}[ \t]/;

/**
 * The body without its closed checklist items: they record what was done, not claims about the
 * current code. An item is closed when the completion rule counts it as checked (so an `— n/a:`
 * with no reason stays). Its continuation lines go with it: indented lines and nested non-checkbox
 * bullets, and lazy lines up to a blank line, until the next list item at its level or a heading.
 */
function withoutClosedChecklistItems(body: string): string {
  const kept: string[] = [];
  let closedIndent = -1; // marker indent of the closed item being skipped; -1 when none
  let afterBlank = false;
  for (const line of body.split(/\r\n|\r|\n/)) {
    const checkbox = line.match(CHECKBOX_ITEM_LINE);
    if (checkbox) {
      closedIndent = countCheckboxesInText(line).checked === 1 ? checkbox[1].length : -1;
      afterBlank = false;
      if (closedIndent < 0) kept.push(line);
      continue;
    }
    if (closedIndent >= 0) {
      if (line.trim() === "") {
        afterBlank = true;
        kept.push(line);
        continue;
      }
      const indent = line.length - line.trimStart().length;
      const newBlock = HEADING_LINE.test(line) || (LIST_ITEM_LINE.test(line) && indent <= closedIndent);
      if (!newBlock && (indent > closedIndent || !afterBlank)) {
        afterBlank = false;
        continue;
      }
      closedIndent = -1;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/** Which stale-text signals to compute. A node still being built is expected to name files it has not written. */
export type StaleTextScope = { paths: boolean; changed_files: boolean; checkboxes: boolean };

export const STALE_ALL: StaleTextScope = { paths: true, changed_files: true, checkboxes: true };
export const STALE_PATHS_ONLY: StaleTextScope = { paths: true, changed_files: false, checkboxes: false };

/** Stale-text signals: `warnings` that the text no longer matches the repo, and `info` that is not drift. */
export type StaleTextSignals = { warnings: string[]; info: string[] };

/** A line that says its paths come into being later ("created at build time"). */
const AT_BUILD_TIME = /\bat build time\b/i;

/** Planned paths named in one `planned:` line, at most this many shown. */
const PLANNED_SHOWN = 3;

/**
 * A slot that is still a plan: `draft` or `ready`, and none of its claimed files exists yet. Its
 * missing paths are files it has not written, not drift.
 */
function isPlanOnlySlot(node: MindPlanNode, slot: "current" | "next", root: string): boolean {
  const state = slot === "next" && node.next ? node.next.state : node.state;
  if (state !== "draft" && state !== "ready") return false;
  const claimed = (slot === "next" && node.next ? node.next.implements : node.implements) ?? [];
  return !claimed.some((entry) => claimEntryExists(entry, root));
}

/**
 * Non-blocking signals that the territory text no longer matches the repo, as `warnings`:
 * a body names a path that does not exist, a claim added in place (`added_claims`) is not
 * named by the body, a claimed file changed after the body was last written, or checkboxes
 * are still open. Missing paths of a plan-only slot, and paths on an "at build time" line, are
 * not stale: they come back as one `planned:` line per node in `info`. With `change`, the node's
 * open revision of that change is judged (its file, its claims), whatever `slot` says.
 */
export function staleTextWarnings(
  graph: MindPlanGraph,
  root: string,
  input: MindPlanNode,
  slotArg?: "current" | "next",
  scope: StaleTextScope = STALE_ALL,
  change?: string
): StaleTextSignals {
  const warnings: string[] = [];
  const info: string[] = [];
  const revised = change !== undefined && Boolean(revisionFor(input, change));
  const node = revised ? nodeUnder(input, change!) : input;
  const slot: "current" | "next" = revised ? "next" : (slotArg ?? (node.next ? "next" : "current"));
  if (!isPipelineNodeType(node.type)) return { warnings, info };
  const source = slotSource(node, slot);
  let body = "";
  try {
    if (source.text === null) throw new Error("missing");
    const split = splitContext(source.text);
    // Recorded decisions may name paths a later revision removed; they are history, not stale text.
    body = withoutOwnedSections(split?.body ?? "");
  } catch {
    return { warnings, info };
  }

  const openText = withoutClosedChecklistItems(body);
  const planOnly = scope.paths && isPlanOnlySlot(node, slot, root);
  const seen = new Set<string>();
  const planned: string[] = [];
  for (const line of scope.paths ? openText.split(/\r?\n/) : []) {
    for (const m of line.matchAll(PATH_TOKEN)) {
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
      if (fs.existsSync(path.join(root, ...token.replace(/\/$/, "").split("/")))) continue;
      if (planOnly || AT_BUILD_TIME.test(line)) planned.push(token);
      else warnings.push(`stale: "${node.id}" body names \`${token}\` which does not exist.`);
    }
  }
  if (planned.length > 0) {
    const shown = planned.slice(0, PLANNED_SHOWN).map((t) => `\`${t}\``).join(", ");
    const more = planned.length > PLANNED_SHOWN ? ", ..." : "";
    info.push(`planned: "${node.id}" names ${planned.length} path(s) not on disk yet (${shown}${more}).`);
  }

  // Claims a shipped node added in place stay flagged until the live body names them.
  if (scope.paths && !node.next && !revised) {
    for (const entry of node.added_claims ?? []) {
      if (namesPath(body, entry)) continue;
      warnings.push(
        `stale: "${node.id}" claims \`${entry}\` added in place without a revision; name it in the body (patch_node_territory).`
      );
    }
  }

  // Compare against the territory file's own mtime, not a recorded timestamp: a fresh checkout
  // writes code and territory together, so only an edit made after the body counts.
  let updated = NaN;
  try {
    updated = fs.statSync(path.join(root, ...source.relPath.split("/"))).mtimeMs;
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
  return { warnings, info };
}

/** A description longer than this warns: descriptions are search rows; detail belongs in the body. */
export const DESCRIPTION_MAX_CHARS = 300;

/**
 * Words that name who acts. Loose on purpose: an Interaction description that names none of them
 * only warns, and a project can always phrase around it.
 */
const ACTOR_WORDS = new Set(
  (
    "visitor visitors user users customer customers client clients editor editors owner owners admin admins " +
    "administrator operator operators agent agents human humans developer developers maintainer maintainers " +
    "guest guests shopper shoppers buyer buyers seller sellers member members reader readers author authors " +
    "staff team teams manager managers employee employees student students teacher teachers patient patients " +
    "player players subscriber subscribers merchant merchants host hosts driver drivers rider riders anyone someone " +
    "people person viewer viewers caller callers reviewer reviewers contributor contributors"
  ).split(" ")
);

/** Revision wording that belongs in a revision's body, not in what the node does now. */
const REVISION_WORDING = /\b(now|no longer|was changed to|used to be|previously|anymore|instead of the old)\b/i;

const comparable = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();

/**
 * Description quality warnings (never failures) for one node's active slot: empty or a repeat of
 * the title, longer than `DESCRIPTION_MAX_CHARS`, an Interaction that names no actor, or revision
 * wording ("now", "no longer", "was changed to", …) that belongs in the revision's body. With
 * `change`, the node's open revision of that change is judged (named when it has several).
 */
export function descriptionWarnings(input: MindPlanNode, change?: string): string[] {
  if (isInactiveNode(input)) return [];
  const node = change !== undefined ? nodeUnder(input, change) : input;
  const title = node.next?.title ?? node.title;
  const description = (node.next?.description ?? node.description ?? "").trim();
  // Each open revision is judged on its own; with several, the line names which one.
  const viewed = node.next?.change;
  const where = !node.next
    ? `"${node.id}"`
    : viewed && (node.open_revisions?.length ?? 0) > 1
      ? `"${node.id}" (revision "${viewed}")`
      : `"${node.id}" (next)`;
  const out: string[] = [];
  if (!description) {
    out.push(`description: ${where} has no description; say what the node does in one sentence (search ranks it).`);
    return out;
  }
  if (comparable(description) === comparable(title)) {
    out.push(`description: ${where} repeats its title; say what the node does, not its name again.`);
  }
  if (description.length > DESCRIPTION_MAX_CHARS) {
    out.push(
      `description: ${where} is ${description.length} characters (over ${DESCRIPTION_MAX_CHARS}); descriptions are search rows, so move the detail into the body.`
    );
  }
  if (node.type === "Interaction") {
    const words = comparable(description).split(" ");
    if (!words.some((w) => ACTOR_WORDS.has(w))) {
      out.push(`description: ${where} names no actor; say who does what (for example "Visitor sends …").`);
    }
  }
  // A Bug's description describes a regression ("no longer shows the total"): that is its job.
  const revision = node.type === "Bug" ? null : REVISION_WORDING.exec(description);
  if (revision) {
    out.push(
      `description: ${where} says "${revision[0]}"; a description says what the node does, and the change history belongs in the revision's body.`
    );
  }
  return out;
}
