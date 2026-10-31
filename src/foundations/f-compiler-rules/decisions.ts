/**
 * The decision gate. MindPlan never makes or judges a decision; it asks for one only where a
 * missing one is costly. An open revision is decision-worthy when it changes a shipped
 * Foundation's contract, claims a new migration or schema file, has more dependents than the
 * configured blast radius, or adds or removes a `depends_on` edge of a shipped node. Such a
 * revision warns while no decision is recorded for it and is `Blocked: Decision` on its move to
 * `in-review`. Any other revision is never gated.
 */

import {
  activeChange,
  activeDecisions,
  isInactiveNode,
  isPipelineNodeType,
  type MindPlanGraph,
  type MindPlanNode,
} from "../f-domain-model/types.js";
import { claimCoversPath, expandClaims } from "../f-source-index/claims.js";
import {
  decisionGateSettings,
  loadProjectConfig,
  type DecisionGateSettings,
} from "../f-source-index/config.js";
import { matchesSchemaFile, newFilesSinceBase } from "../f-source-index/git.js";
import { blastRadiusDependents, blocked, changeMembers } from "./rules.js";

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
 * An open revision: a shipped Foundation/Interaction/Interface with an open next, or a pre-ship,
 * non-retired one at any pre-ship state. Journeys and Bugs are never revisions.
 */
export function isOpenRevision(node: MindPlanNode): boolean {
  if (!isPipelineNodeType(node.type)) return false;
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
 * that are new in this revision.
 */
function newSchemaFiles(node: MindPlanNode, ctx: DecisionContext): string[] {
  const attributed = ((node.next ? node.next.attributed : node.attributed) ?? []).filter((f) =>
    matchesSchemaFile(f, ctx.settings.schema_files)
  );
  // An attributed file is new when the branch adds it (or always outside git): attributing a
  // migration the repository already had is modeling, not a schema change.
  const addedAttributed = () => {
    if (attributed.length === 0) return [];
    const added = ctx.newFiles();
    return added ? attributed.filter((f) => added.has(f)) : attributed;
  };
  const claimed = newClaimedSchemaFiles(node, ctx);
  return [...new Set([...claimed, ...addedAttributed()])];
}

/** Migration or schema files the revision claims that are new in this revision. */
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

/** Why `node` is decision-worthy; `[]` when it is not (or is not an open revision). */
export function decisionTriggers(
  graph: MindPlanGraph,
  node: MindPlanNode,
  ctx: DecisionContext
): DecisionTrigger[] {
  if (!isOpenRevision(node)) return [];
  const triggers: DecisionTrigger[] = [];
  if (node.type === "Foundation" && node.next) {
    triggers.push({
      kind: "foundation_contract",
      message: "contract changes (an open revision of a shipped Foundation)",
    });
  }
  const schema = newSchemaFiles(node, ctx);
  if (schema.length > 0) {
    triggers.push({
      kind: "schema",
      message: `claims new migration or schema file(s) ${quoteList(schema)}`,
    });
  }
  const dependents = blastRadiusDependents(graph, node.id).affected.filter(
    ({ node: n }) => !isRetired(n)
  );
  if (dependents.length > ctx.settings.blast_radius) {
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
 * The day this revision started (`YYYY-MM-DD`): when open_next opened it, or when a pre-ship node
 * was created. Undefined for a next file opened before `opened_at` existed.
 */
function revisionStartDay(node: MindPlanNode): string | undefined {
  const started = node.next ? node.next.opened_at : node.created_at;
  return started?.slice(0, 10);
}

/**
 * The day a change started: the earliest start among its open revisions, so a member added later
 * still gets credit for a decision recorded earlier in the same change. Undefined (no bound) when
 * any member's start is unknown.
 */
function changeStartDay(graph: MindPlanGraph, change: string): string | undefined {
  let earliest: string | undefined;
  for (const member of changeMembers(graph, change)) {
    const day = revisionStartDay(member);
    if (!day) return undefined;
    if (!earliest || day < earliest) earliest = day;
  }
  return earliest;
}

/**
 * True when a decision is recorded for this revision: an active node holds a decision under the
 * revision's change id recorded on or after the day the change started (so a reused change id is
 * not satisfied by an earlier change's decisions), or the node's own active slot holds a decision
 * new in this revision (before first ship: any own decision; with an open next: an id the live
 * file does not hold).
 */
export function revisionHasDecision(graph: MindPlanGraph, node: MindPlanNode): boolean {
  const change = activeChange(node);
  if (change) {
    const since = changeStartDay(graph, change);
    const counts = (d: { change?: string; date?: string }) =>
      d.change === change && (!since || !d.date || d.date >= since);
    for (const other of graph.nodes) {
      if (isInactiveNode(other)) continue;
      if (activeDecisions(other).some(counts)) return true;
    }
  }
  const own = activeDecisions(node);
  if (!node.next) return !node.shipped_at && own.length > 0;
  const live = new Set((node.decisions ?? []).map((d) => d.id));
  return own.some((d) => !live.has(d.id));
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

/** The missing decision of a decision-worthy revision, with the call that records it; null when none is missing. */
export function decisionGap(
  graph: MindPlanGraph,
  node: MindPlanNode,
  ctx: DecisionContext
): DecisionGap | null {
  if (!isOpenRevision(node) || revisionHasDecision(graph, node)) return null;
  const triggers = decisionTriggers(graph, node, ctx);
  if (triggers.length === 0) return null;
  const change = activeChange(node) ?? null;
  return {
    node_id: node.id,
    change,
    triggers,
    fix: {
      tool: "record_decision",
      args: {
        node_id: node.id,
        decision: "<one sentence: what was chosen>",
        alternatives: ["<what else was considered, and why it lost>"],
        why: "<the constraint or trade-off that decided it>",
        ...(change ? { change } : {}),
      },
    },
  };
}

function describeTriggers(gap: DecisionGap): string {
  return `"${gap.node_id}" ${gap.triggers.map((t) => t.message).join("; ")}`;
}

/** `decision:` warnings for a decision-worthy revision with no decision; `[]` otherwise. */
export function decisionWarnings(
  graph: MindPlanGraph,
  node: MindPlanNode,
  ctx: DecisionContext
): string[] {
  const gap = decisionGap(graph, node, ctx);
  if (!gap) return [];
  return [
    `decision: ${describeTriggers(gap)}; record the choice and the alternative you rejected with record_decision before in-review.`,
  ];
}

/** The in-review gate: `Blocked: Decision` with the `record_decision` call when a decision is missing. */
export function assertDecisionForReview(
  graph: MindPlanGraph,
  root: string,
  node: MindPlanNode,
  ctx: DecisionContext = createDecisionContext(root)
): void {
  const gap = decisionGap(graph, node, ctx);
  if (!gap) return;
  const where = gap.change ? `under change "${gap.change}" or on the node` : "on the node";
  // Reopening a shipped, shared contract is where an additive design was most likely possible.
  const additive =
    node.shipped_at && gap.triggers.some((t) => t.kind === "foundation_contract" || t.kind === "blast_radius")
    ? `An additive alternative leaves "${gap.node_id}" closed: a new node that depends_on it, or a split of it; ` +
      `name it in alternatives if you rejected it. `
    : "";
  throw blocked(
    `Decision. ${describeTriggers(gap)}, and no decision is recorded for this revision (${where}). ` +
      `Record the choice and the alternative you rejected. ${additive}` +
      `Fix: record_decision(${JSON.stringify(gap.fix.args)}).`
  );
}
