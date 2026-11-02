/**
 * Decision-record queries over the loaded graph — pure, no file I/O. A node's decisions are its
 * held decisions (`heldDecisions`): live (the `## Decisions` section and `decisions/*.md`), a
 * legacy open next file's, and every open revision's (tagged with the revision's change). Status
 * is computed: a decision is superseded while a decision held by an active node names it in
 * `supersedes`.
 */

import {
  isInactiveNode,
  type DecisionEntry,
  type DecisionRecord,
  type MindPlanGraph,
  type MindPlanNode,
  type RuleVia,
} from "../f-domain-model/types.js";
import { inheritanceSources } from "./rules.js";

/**
 * Every decision a node holds, each id once, in this order: live (section entries, then
 * `decisions/*.md`), a legacy `<id>.next.mdx`'s own entries (or a single revision's view), then
 * each open revision's `decisions/` in change order. A revision's decision with no `change` is
 * tagged with the revision's change.
 */
export function heldDecisions(node: MindPlanNode): DecisionRecord[] {
  const out: DecisionRecord[] = [];
  const seen = new Set<string>();
  const add = (d: DecisionRecord) => {
    if (seen.has(d.id)) return;
    seen.add(d.id);
    out.push(d);
  };
  const revisions = [...(node.open_revisions ?? [])].sort((a, b) =>
    a.change < b.change ? -1 : a.change > b.change ? 1 : 0
  );
  // Revision decisions first into the set, so the view copy in `next` keeps the revision's tag.
  const tagged = new Map<string, DecisionRecord>();
  for (const rev of revisions) {
    for (const d of rev.decisions ?? []) {
      if (!tagged.has(d.id)) tagged.set(d.id, d.change ? d : { ...d, change: rev.change });
    }
  }
  for (const d of node.decisions ?? []) add(d);
  for (const d of node.next?.decisions ?? []) add(tagged.get(d.id) ?? d);
  for (const d of tagged.values()) add(d);
  return out;
}

/**
 * Decision id → id of the decision that supersedes it. Only a cancelled node's decisions supersede
 * nothing (that work never shipped); a deprecated node's replacement still stands, or retiring it
 * would bring back the design it replaced.
 */
export function supersessionIndex(graph: MindPlanGraph): Map<string, string> {
  const index = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.state === "cancelled") continue;
    for (const d of heldDecisions(node)) {
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

/** One node's own decisions (`heldDecisions`: live and every open revision), with computed status. */
export function nodeDecisions(
  graph: MindPlanGraph,
  node: MindPlanNode,
  opts: DecisionQueryOptions = {},
  index: Map<string, string> = supersessionIndex(graph)
): DecisionEntry[] {
  return heldDecisions(node).map((d) => toEntry(node, d, index)).filter(keepsEntry(opts));
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
    for (const record of heldDecisions(node)) {
      const entry = toEntry(node, record, index, { via, distance });
      if (keep(entry)) out.push(entry);
    }
  }
  return out;
}

/**
 * Decisions by node, change, or the whole graph. `node_id` lists that node's own decisions
 * (whatever its state); otherwise inactive nodes are skipped. `change` keeps decisions recorded
 * under that change id, including those in that change's revision folders. The filters combine.
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
 * The node holding a decision id (live, legacy next file, or any open revision). Ids are unique
 * across the graph, so there is at most one holder.
 */
export function findDecision(
  graph: MindPlanGraph,
  id: string
): { node: MindPlanNode; record: DecisionRecord } | null {
  for (const node of graph.nodes) {
    const hit = heldDecisions(node).find((d) => d.id === id);
    if (hit) return { node, record: hit };
  }
  return null;
}

/**
 * Every taken decision id: ids every node holds (`heldDecisions`, retired nodes included), plus every id a `supersedes` still names. A superseded decision can disappear with a
 * discarded revision while its superseder stays; reusing that id would make a new decision look
 * superseded.
 */
export function decisionIds(graph: MindPlanGraph): Set<string> {
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    for (const d of heldDecisions(node)) {
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
