/**
 * Decision-record queries over the loaded graph — pure, no file I/O. A node's decisions are those
 * of its active slot (`activeDecisions`). Status is computed: a decision is superseded while a
 * decision held by an active node names it in `supersedes`.
 */

import {
  activeDecisions,
  isInactiveNode,
  type DecisionEntry,
  type DecisionRecord,
  type MindPlanGraph,
  type MindPlanNode,
  type RuleVia,
} from "../f-domain-model/types.js";
import { inheritanceSources } from "./rules.js";

/**
 * Decision id → id of the decision that supersedes it. Only a cancelled node's decisions supersede
 * nothing (that work never shipped); a deprecated node's replacement still stands, or retiring it
 * would bring back the design it replaced.
 */
export function supersessionIndex(graph: MindPlanGraph): Map<string, string> {
  const index = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.state === "cancelled") continue;
    for (const d of activeDecisions(node)) {
      if (d.supersedes && d.supersedes !== d.id && !index.has(d.supersedes)) {
        index.set(d.supersedes, d.id);
      }
    }
  }
  return index;
}

function toEntry(
  node: MindPlanNode,
  record: DecisionRecord,
  index: Map<string, string>,
  inherited?: { via: RuleVia; distance: number }
): DecisionEntry {
  const supersededBy = index.get(record.id);
  return {
    ...record,
    alternatives: [...record.alternatives],
    node_id: node.id,
    node_type: node.type,
    status: supersededBy ? "superseded" : "active",
    ...(supersededBy ? { superseded_by: supersededBy } : {}),
    ...(inherited ?? {}),
  };
}

export type DecisionQueryOptions = { include_superseded?: boolean };

/**
 * The one filter every decision reader applies: superseded entries are left out unless
 * `include_superseded`, so list_decisions, orient_for_work, and get_node_context agree by default.
 */
function keepsEntry(opts: DecisionQueryOptions): (entry: DecisionEntry) => boolean {
  return (entry) => Boolean(opts.include_superseded) || entry.status === "active";
}

/** One node's own decisions (its active slot), with computed status. */
export function nodeDecisions(
  graph: MindPlanGraph,
  node: MindPlanNode,
  opts: DecisionQueryOptions = {},
  index: Map<string, string> = supersessionIndex(graph)
): DecisionEntry[] {
  return activeDecisions(node).map((d) => toEntry(node, d, index)).filter(keepsEntry(opts));
}

/**
 * Decision entries of a node's live file (`slot: "current"`) or open next file, with status.
 * Status follows the active slot (`supersessionIndex`), so a live decision superseded by one
 * recorded on the node's open next file is left out of the live list by default too; it comes
 * back if that revision is discarded. Pass `index` to reuse one build across both slots.
 */
export function slotDecisions(
  graph: MindPlanGraph,
  node: MindPlanNode,
  slot: "current" | "next",
  opts: DecisionQueryOptions = {},
  index: Map<string, string> = supersessionIndex(graph)
): DecisionEntry[] {
  const records = slot === "next" ? node.next?.decisions ?? [] : node.decisions ?? [];
  return records.map((d) => toEntry(node, d, index)).filter(keepsEntry(opts));
}

/**
 * The decisions that apply to `nodeId`, labeled with the node they came from: the same walk as
 * node rules (own, `belongs_to`, `depends_on`, and for a Bug `affects`), each node's decisions in
 * recorded order. Superseded entries are left out unless `include_superseded`.
 */
export function resolveNodeDecisions(
  graph: MindPlanGraph,
  nodeId: string,
  opts: DecisionQueryOptions = {}
): DecisionEntry[] {
  const index = supersessionIndex(graph);
  const keep = keepsEntry(opts);
  const out: DecisionEntry[] = [];
  for (const { node, via, distance } of inheritanceSources(graph, nodeId)) {
    for (const record of activeDecisions(node)) {
      const entry = toEntry(node, record, index, { via, distance });
      if (keep(entry)) out.push(entry);
    }
  }
  return out;
}

/**
 * Decisions by node, change, or the whole graph. `node_id` lists that node's own decisions
 * (whatever its state); otherwise inactive nodes are skipped. `change` keeps decisions recorded
 * under that change id. The filters combine.
 */
export function listDecisions(
  graph: MindPlanGraph,
  opts: DecisionQueryOptions & { node_id?: string; change?: string } = {}
): DecisionEntry[] {
  const index = supersessionIndex(graph);
  const nodes = opts.node_id
    ? graph.nodes.filter((n) => n.id === opts.node_id)
    : graph.nodes.filter((n) => !isInactiveNode(n));
  const out: DecisionEntry[] = [];
  for (const node of nodes) {
    for (const entry of nodeDecisions(graph, node, opts, index)) {
      if (opts.change !== undefined && entry.change !== opts.change) continue;
      out.push(entry);
    }
  }
  return out;
}

/**
 * The node holding a decision id in its live or open next file (active slot first). Ids are
 * unique across the graph, so there is at most one holder.
 */
export function findDecision(
  graph: MindPlanGraph,
  id: string
): { node: MindPlanNode; record: DecisionRecord } | null {
  for (const node of graph.nodes) {
    const hit =
      activeDecisions(node).find((d) => d.id === id) ??
      (node.decisions ?? []).find((d) => d.id === id);
    if (hit) return { node, record: hit };
  }
  return null;
}

/**
 * Every taken decision id: ids in the live and open next files of every node (retired ones
 * included), plus every id a `supersedes` still names. A superseded decision can disappear with a
 * discarded revision while its superseder stays; reusing that id would make a new decision look
 * superseded.
 */
export function decisionIds(graph: MindPlanGraph): Set<string> {
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    for (const d of [...(node.decisions ?? []), ...(node.next?.decisions ?? [])]) {
      ids.add(d.id);
      if (d.supersedes) ids.add(d.supersedes);
    }
  }
  return ids;
}

const ID_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "its",
  "of", "on", "or", "that", "the", "this", "to", "we", "when", "which", "with",
]);

/** `d-` plus a slug of the decision's first meaningful words, with a numeric suffix when taken. */
export function generateDecisionId(graph: MindPlanGraph, text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean);
  const meaningful = words.filter((w) => !ID_STOP_WORDS.has(w));
  const picked = (meaningful.length > 0 ? meaningful : words).slice(0, 5);
  let base = `d-${picked.length > 0 ? picked.join("-") : "decision"}`;
  if (base.length > 48) base = base.slice(0, 48).replace(/-+$/, "");
  const taken = decisionIds(graph);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}
