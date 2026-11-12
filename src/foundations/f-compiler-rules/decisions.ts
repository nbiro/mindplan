/**
 * The decision gate. MindPlan never makes or judges a decision; it asks for one only where a
 * missing one is costly. An open revision is decision-worthy when it changes a shipped
 * Foundation's contract, claims a new migration or schema file, has more dependents than the
 * configured blast radius, or adds or removes a `depends_on` edge of a shipped node. Such a
 * revision warns while no decision is recorded for it and is `Blocked: Decision` on its move to
 * `in-review`. Any other revision is never gated.
 *
 * A shipped node may hold several open revisions, one per change: every function here takes an
 * optional `change` naming the revision it judges (`withRevision` gives the live-plus-revision
 * view, `revisionGraph` the graph that revision is judged against). Without one, a node with exactly
 * one open revision is judged on it; otherwise the node's own fields are read (live, or a pre-ship
 * node).
 */

import {
  activeChange,
  isInactiveNode,
  isPipelineNodeType,
  type DecisionRecord,
  type MindPlanGraph,
  type MindPlanNode,
  type Revision,
} from "../f-domain-model/types.js";
import { openChanges, pickRevision, revisionFor } from "../f-revision-model/index.js";
import { claimCoversPath, expandClaims } from "../f-source-index/claims.js";
import {
  decisionGateSettings,
  loadProjectConfig,
  type DecisionGateSettings,
} from "../f-source-index/config.js";
import { matchesSchemaFile, newFilesSinceBase } from "../f-source-index/git.js";
import { blastRadiusDependents, blocked, liveGraph, revisionGraph } from "./rules.js";

export type DecisionTriggerKind = "foundation_contract" | "schema" | "blast_radius" | "depends_on";

/** Why a revision is decision-worthy. `message` reads after the node id. */
export type DecisionTrigger = { kind: DecisionTriggerKind; message: string };

/** Settings plus a git probe that runs at most once, and only when a trigger needs it. */
export type DecisionContext = {
  root: string;
  settings: DecisionGateSettings;
  newFiles(): Set<string> | null;
};

export function createDecisionContext(root: string, settings?: DecisionGateSettings): DecisionContext {
  const resolved = settings ?? decisionGateSettings(loadProjectConfig(root));
  let probed = false;
  let files: Set<string> | null = null;
  return {
    root,
    settings: resolved,
    newFiles() {
      if (!probed) {
        files = newFilesSinceBase(root);
        probed = true;
      }
      return files;
    },
  };
}

function isRetired(node: MindPlanNode): boolean {
  return node.state === "cancelled" || node.state === "deprecated";
}

/**
 * The revision a gate call judges. `change` names it (`null`: the node's own fields, no revision
 * folder); `undefined` means the only open revision when there is exactly one, else the node's own
 * fields. `view` is live plus that revision (`withRevision`), `graph` the graph it is judged
 * against (`revisionGraph`), and `change` the change id the revision belongs to (for a pre-ship node
 * or a legacy next file, its `activeChange`).
 */
type Subject = {
  node: MindPlanNode;
  view: MindPlanNode;
  /** The loaded graph, every node live. */
  base: MindPlanGraph;
  /** The graph the revision is judged against. */
  graph: MindPlanGraph;
  change?: string;
  revision?: Revision;
};

/**
 * The revision `change` names on `node` (`pickRevision`, never Blocked): the given change's, or
 * the only open revision's when omitted; `null` names live.
 */
function picked(node: MindPlanNode, change?: string | null): ReturnType<typeof pickRevision> {
  return change === null ? { change: null, view: node } : pickRevision(node, change, { strict: false });
}

/** Live plus the named revision (`withRevision`), or the node itself when it has none of it. */
function viewOf(node: MindPlanNode, change?: string | null): MindPlanNode {
  return picked(node, change).view;
}

function subjectOf(graph: MindPlanGraph, node: MindPlanNode, change?: string | null): Subject {
  const { change: named, view } = picked(node, change);
  if (named !== null && isPipelineNodeType(node.type)) {
    return { node, view, base: graph, graph: revisionGraph(graph, named), change: named, revision: revisionFor(node, named) };
  }
  // A change the node has no revision of still names the change a pre-ship node is judged under.
  return { node, view: node, base: graph, graph: liveGraph(graph), change: change ?? activeChange(node) };
}

/**
 * An open revision: a shipped Foundation/Interaction/Interface with an open revision of `change`
 * (or, without one, any open revision), a revision view (its `next` is a revision, see
 * `withRevision`), or a pre-ship, non-retired one at any pre-ship state. Capabilities and Bugs are
 * never revisions.
 */
export function isOpenRevision(node: MindPlanNode, change?: string | null): boolean {
  if (!isPipelineNodeType(node.type)) return false;
  if (change) {
    if (revisionFor(node, change)) return true;
  } else if (change === undefined && (node.open_revisions?.length ?? 0) > 0) {
    return true;
  }
  if (node.next) return true;
  if (node.shipped_at) return false;
  return !isRetired(node);
}

function quoteList(ids: string[], cap = 3): string {
  const shown = ids.slice(0, cap).map((id) => `"${id}"`).join(", ");
  return ids.length > cap ? `${shown}, ...` : shown;
}

/**
 * Migration or schema files the revision claims, or attributes to itself in another node's folder,
 * that are new in this revision. `change` picks the revision (see `subjectOf`).
 */
export function newSchemaFiles(node: MindPlanNode, ctx: DecisionContext, change?: string | null): string[] {
  const view = viewOf(node, change);
  const attributed = ((view.next ? view.next.attributed : view.attributed) ?? []).filter((f) =>
    matchesSchemaFile(f, ctx.settings.schema_files)
  );
  // An attributed file is new when the branch adds it (or always outside git): attributing a
  // migration the repository already had is modeling, not a schema change.
  const addedAttributed = () => {
    if (attributed.length === 0) return [];
    const added = ctx.newFiles();
    return added ? attributed.filter((f) => added.has(f)) : attributed;
  };
  const claimed = newClaimedSchemaFiles(view, ctx);
  return [...new Set([...claimed, ...addedAttributed()])];
}

/** Migration or schema files the revision (`node.next` of a view) claims that are new in it. */
function newClaimedSchemaFiles(node: MindPlanNode, ctx: DecisionContext): string[] {
  const claims = (node.next ? node.next.implements : node.implements) ?? [];
  const schema = expandClaims(claims, ctx.root).filter((f) =>
    matchesSchemaFile(f, ctx.settings.schema_files)
  );
  if (schema.length === 0) return [];
  if (!node.shipped_at) {
    // A first build claims everything for the first time, but a file the repository already had
    // (a brownfield node modeling existing code) is not a new schema: ask git when there is one.
    const added = ctx.newFiles();
    return added ? schema.filter((f) => added.has(f)) : schema;
  }
  // A shipped node's revision: a file its live claims do not cover is new to it.
  const liveClaims = node.implements ?? [];
  const byClaims = schema.filter((f) => !liveClaims.some((c) => claimCoversPath(c, f)));
  if (byClaims.length > 0) return byClaims;
  // A new migration usually lands in a folder the owner already claims: ask git what the branch adds.
  const added = ctx.newFiles();
  return added ? schema.filter((f) => added.has(f)) : [];
}

/** Why the subject's revision is decision-worthy; `[]` when it is not (or is not open). */
function triggersOf(s: Subject, ctx: DecisionContext): DecisionTrigger[] {
  const node = s.view;
  if (!isOpenRevision(node, null)) return [];
  const triggers: DecisionTrigger[] = [];
  if (node.type === "Foundation" && node.next) {
    triggers.push({
      kind: "foundation_contract",
      message: "contract changes (an open revision of a shipped Foundation)",
    });
  }
  const schema = newSchemaFiles(node, ctx, null);
  if (schema.length > 0) {
    triggers.push({
      kind: "schema",
      message: `claims new migration or schema file(s) ${quoteList(schema)}`,
    });
  }
  const dependents = blastRadiusDependents(s.graph, node.id).affected.filter(
    ({ node: n }) => !isRetired(n)
  );
  // A pre-ship Foundation's concentration is the fan-in signal's (f-fan-in): only a split or a
  // keep_whole decision answers it, so any decision must not clear it here.
  const preShipFoundation = node.type === "Foundation" && !node.shipped_at;
  if (!preShipFoundation && dependents.length > ctx.settings.blast_radius) {
    triggers.push({
      kind: "blast_radius",
      message: `has ${dependents.length} dependents (more than the blast_radius setting of ${ctx.settings.blast_radius})`,
    });
  }
  // A first build adds its initial edges by definition; only a shipped node's revision is gated on them.
  if (node.next && node.shipped_at) {
    const live = new Set(node.depends_on ?? []);
    const next = new Set(node.next.depends_on ?? []);
    const added = [...next].filter((id) => !live.has(id)).sort();
    const removed = [...live].filter((id) => !next.has(id)).sort();
    if (added.length > 0 || removed.length > 0) {
      const parts = [
        ...(added.length > 0 ? [`adds depends_on ${quoteList(added)}`] : []),
        ...(removed.length > 0 ? [`removes depends_on ${quoteList(removed)}`] : []),
      ];
      triggers.push({ kind: "depends_on", message: parts.join(" and ") });
    }
  }
  return triggers;
}

/**
 * The day a revision view started (`YYYY-MM-DD`): when its revision opened, or when a pre-ship
 * node was created. Undefined for a next file opened before `opened_at` existed.
 */
function revisionStartDay(view: MindPlanNode): string | undefined {
  const started = view.next ? view.next.opened_at : view.created_at;
  return started?.slice(0, 10);
}

/** Whether `n` is an open revision of `change`, and the day that revision started. */
function memberStart(n: MindPlanNode, change: string): { member: boolean; day?: string } {
  const revision = revisionFor(n, change);
  if (revision) return { member: true, day: revision.opened_at?.slice(0, 10) };
  if (!isPipelineNodeType(n.type) || activeChange(n) !== change) return { member: false };
  if (n.next) return { member: true, day: n.next.opened_at?.slice(0, 10) };
  if (n.shipped_at || isRetired(n)) return { member: false };
  return { member: true, day: n.created_at?.slice(0, 10) };
}

/**
 * The day a change started: the earliest start among its open revisions, so a member added later
 * still gets credit for a decision recorded earlier in the same change. Undefined (no bound) when
 * any member's start is unknown.
 */
function changeStartDay(graph: MindPlanGraph, change: string): string | undefined {
  let earliest: string | undefined;
  for (const n of graph.nodes) {
    const { member, day } = memberStart(n, change);
    if (!member) continue;
    if (!day) return undefined;
    if (!earliest || day < earliest) earliest = day;
  }
  return earliest;
}

/**
 * Every decision a node holds: live (section and `decisions/*.md`), a legacy next file's, and each
 * open revision's, the latter tagged with the revision's change when untagged.
 */
function heldDecisions(node: MindPlanNode): DecisionRecord[] {
  const out: DecisionRecord[] = [...(node.decisions ?? []), ...(node.next?.decisions ?? [])];
  for (const rev of node.open_revisions ?? []) {
    for (const d of rev.decisions ?? []) out.push(d.change ? d : { ...d, change: rev.change });
  }
  return out;
}

/**
 * True when a decision is recorded for the revision of `change` on `node` (see `subjectOf` for an
 * omitted `change`):
 * - any active node holds a decision under the revision's change id recorded on or after the day
 *   the change started (so a reused change id is not satisfied by an earlier change's decisions);
 * - or any active node holds a decision that lists this node in `nodes`, under that change or
 *   none, recorded since then;
 * - or the revision holds a decision of its own: its `decisions/` folder is not empty (a revision
 *   folder), an id the live file does not hold (a legacy next file), or any own decision before
 *   first ship.
 */
export function revisionHasDecision(graph: MindPlanGraph, node: MindPlanNode, change?: string | null): boolean {
  return hasDecision(subjectOf(graph, node, change));
}

/** Every decision each active node holds (`heldDecisions`), with its holder. */
function* activeDecisions(graph: MindPlanGraph): Generator<{ holder: MindPlanNode; decision: DecisionRecord }> {
  for (const holder of graph.nodes) {
    if (isInactiveNode(holder)) continue;
    for (const decision of heldDecisions(holder)) yield { holder, decision };
  }
}

/**
 * The decisions another active node holds under `change` that list `node` in `nodes`, once each:
 * one decision that shapes several nodes, recorded once. The decision gate (`hasDecision`) and the
 * hotspot signals (`answeredUnder`, `nodeChurn`) read this one walk.
 */
export function decisionsNaming(graph: MindPlanGraph, node: Pick<MindPlanNode, "id">, change: string): DecisionRecord[] {
  const out = new Map<string, DecisionRecord>();
  for (const { holder, decision } of activeDecisions(graph)) {
    if (holder.id === node.id || decision.change !== change || !decision.nodes?.includes(node.id)) continue;
    if (!out.has(decision.id)) out.set(decision.id, decision);
  }
  return [...out.values()];
}

function hasDecision(s: Subject): boolean {
  const node = s.node;
  const since = s.change ? changeStartDay(s.base, s.change) : revisionStartDay(s.view);
  const dated = (d: DecisionRecord) => !since || !d.date || d.date >= since;
  for (const { decision: d } of activeDecisions(s.base)) {
    if (!dated(d)) continue;
    if (s.change && d.change === s.change) return true;
    if (d.nodes?.includes(node.id) && (!d.change || d.change === s.change)) return true;
  }
  if (s.revision) return (s.revision.decisions?.length ?? 0) > 0;
  const view = s.view;
  if (!view.next) return !view.shipped_at && heldDecisions(view).length > 0;
  const live = new Set((node.decisions ?? []).map((d) => d.id));
  return (view.next.decisions ?? []).some((d) => !live.has(d.id));
}

export type DecisionFix = {
  tool: "record_decision";
  args: {
    node_id: string;
    decision: string;
    alternatives: string[];
    why: string;
    change?: string;
  };
};

export type DecisionGap = {
  node_id: string;
  change: string | null;
  triggers: DecisionTrigger[];
  fix: DecisionFix;
};

function gapOf(s: Subject, ctx: DecisionContext): DecisionGap | null {
  if (!isOpenRevision(s.view, null) || hasDecision(s)) return null;
  const triggers = triggersOf(s, ctx);
  if (triggers.length === 0) return null;
  const change = s.change ?? null;
  return {
    node_id: s.node.id,
    change,
    triggers,
    fix: {
      tool: "record_decision",
      args: {
        node_id: s.node.id,
        decision: "<one sentence: what was chosen>",
        alternatives: ["<what else was considered, and why it lost>"],
        why: "<the constraint or trade-off that decided it>",
        ...(change ? { change } : {}),
      },
    },
  };
}

/**
 * The missing decision of a decision-worthy revision, with the call that records it; null when
 * none is missing. `change` picks the revision (see `subjectOf`).
 */
export function decisionGap(
  graph: MindPlanGraph,
  node: MindPlanNode,
  ctx: DecisionContext,
  change?: string | null
): DecisionGap | null {
  return gapOf(subjectOf(graph, node, change), ctx);
}

/**
 * The missing decision of the revision of `change` on `node` (`null`: the node's own pre-ship or
 * legacy revision), or null when none is missing or the revision is not decision-worthy.
 * The entry point for gates that walk a node's revisions one change at a time.
 */
export function decisionGapFor(
  graph: MindPlanGraph,
  root: string,
  node: MindPlanNode,
  change: string | null,
  ctx: DecisionContext = createDecisionContext(root)
): DecisionGap | null {
  return gapOf(subjectOf(graph, node, change), ctx);
}

function describeTriggers(gap: DecisionGap, node: MindPlanNode): string {
  const which =
    gap.change && (node.open_revisions?.length ?? 0) > 1 ? ` (revision "${gap.change}")` : "";
  return `"${gap.node_id}"${which} ${gap.triggers.map((t) => t.message).join("; ")}`;
}

/**
 * `decision:` warnings for a decision-worthy revision with no decision; `[]` otherwise. Without
 * `change`, a node with several open revisions gets one warning per revision missing one.
 */
export function decisionWarnings(
  graph: MindPlanGraph,
  node: MindPlanNode,
  ctx: DecisionContext,
  change?: string | null
): string[] {
  const changes: (string | null | undefined)[] =
    change === undefined && (node.open_revisions?.length ?? 0) > 1 ? openChanges(node) : [change];
  const out: string[] = [];
  for (const c of changes) {
    const gap = decisionGap(graph, node, ctx, c);
    if (!gap) continue;
    out.push(
      `decision: ${describeTriggers(gap, node)}; record the choice and the alternative you rejected with record_decision before in-review.`
    );
  }
  return out;
}

/**
 * The in-review gate: `Blocked: Decision` with the `record_decision` call when a decision is
 * missing for the revision of `change` (see `subjectOf` for an omitted `change`).
 */
export function assertDecisionForReview(
  graph: MindPlanGraph,
  root: string,
  node: MindPlanNode,
  ctx: DecisionContext = createDecisionContext(root),
  change?: string | null
): void {
  const gap = decisionGap(graph, node, ctx, change);
  if (!gap) return;
  const where = gap.change ? `under change "${gap.change}" or on the node` : "on the node";
  // Reopening a shipped, shared contract is where an additive design was most likely possible.
  const additive =
    node.shipped_at && gap.triggers.some((t) => t.kind === "foundation_contract" || t.kind === "blast_radius")
    ? `An additive alternative leaves "${gap.node_id}" closed: a new node that depends_on it, or a split of it; ` +
      `name it in alternatives if you rejected it. `
    : "";
  throw blocked(
    `Decision. ${describeTriggers(gap, node)}, and no decision is recorded for this revision (${where}). ` +
      `Record the choice and the alternative you rejected. ${additive}` +
      `Fix: record_decision(${JSON.stringify(gap.fix.args)}).`
  );
}
