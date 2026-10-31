/**
 * Open–closed signals. A feature should mostly add nodes, and rarely reopen a shipped node that
 * many others depend on. These read graph facts only (edges, decisions, change ids), never code,
 * and every signal is a warning or an informational field: none of them Blocks.
 */

import {
  decayChurn,
  isInactiveNode,
  isPipelineNodeType,
  type DecisionRecord,
  type MindPlanGraph,
  type MindPlanNode,
} from "../f-domain-model/types.js";
import type { HotspotSettings } from "../f-source-index/config.js";
import { changeMembership } from "./planned.js";

/** Edges into a node that a change to its contract reaches first. */
const FAN_IN_EDGES = new Set(["depends_on", "exposes", "mounts"]);

const isRetired = isInactiveNode;

/** Target id → the active nodes with a fan-in edge into it, from one pass over the live edges. */
export type FanInIndex = Map<string, Set<string>>;

export function fanInIndex(graph: MindPlanGraph): FanInIndex {
  const active = new Set(graph.nodes.filter((n) => !isRetired(n)).map((n) => n.id));
  const index: FanInIndex = new Map();
  for (const edge of graph.edges) {
    if (!FAN_IN_EDGES.has(edge.type) || !active.has(edge.source)) continue;
    let sources = index.get(edge.target);
    if (!sources) index.set(edge.target, (sources = new Set()));
    sources.add(edge.source);
  }
  return index;
}

/**
 * The distinct active nodes with a direct live edge into `node`: `depends_on` from any source, an
 * Interface that `exposes` an Interaction, a composition root that `mounts` an Interface. Edges
 * that exist only in an open next slot or as planned edges do not count until they ship. Callers
 * that ask for many nodes pass one `fanInIndex`.
 */
export function fanIn(
  graph: MindPlanGraph,
  node: MindPlanNode,
  index: FanInIndex = fanInIndex(graph)
): { count: number; nodes: string[] } {
  const nodes = [...(index.get(node.id) ?? [])].sort();
  return { count: nodes.length, nodes };
}

export type ChurnEntry = { change: string; date?: string; reasons: string[] };

/**
 * The distinct changes that shaped `node`, oldest first: the change id of each of its decisions
 * (live and open next, superseded included, since a superseded decision still records a revision;
 * the first build's change counts like any other) plus a shipped node's open revision's change.
 * `reasons` are the decision sentences recorded under that change. The node keeps no revision
 * log; decisions are the record and git keeps the rest.
 */
export function nodeChurn(node: MindPlanNode): ChurnEntry[] {
  const records = new Map<string, DecisionRecord>();
  for (const d of [...(node.decisions ?? []), ...(node.next?.decisions ?? [])]) records.set(d.id, d);
  const byChange = new Map<string, ChurnEntry>();
  for (const d of records.values()) {
    if (!d.change) continue;
    let entry = byChange.get(d.change);
    if (!entry) {
      entry = { change: d.change, reasons: [] };
      byChange.set(d.change, entry);
    }
    if (d.date && (!entry.date || d.date < entry.date)) entry.date = d.date;
    entry.reasons.push(d.decision);
  }
  const open = node.next?.change;
  if (open && !byChange.has(open)) byChange.set(open, { change: open, reasons: [] });
  // Undated entries (the open revision's change with no decision yet) sort last: they are newest.
  return [...byChange.values()].sort(
    (a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.change.localeCompare(b.change)
  );
}

/**
 * How often the node shipped lately: its stored `churn` (a decayed ship count as of its last ship)
 * decayed on to `now`, plus one while a revision is open (or about to open). 0 for a node with no
 * stored value yet.
 */
export function recentRate(
  node: MindPlanNode,
  settings: HotspotSettings,
  now: Date = new Date(),
  opening = false
): number {
  const stored = node.churn ?? 0;
  const base = node.shipped_at ? decayChurn(stored, node.shipped_at, now.toISOString(), settings.half_life_days) : 0;
  return base + (node.next || opening ? 1 : 0);
}

function rateCandidates(graph: MindPlanGraph): MindPlanNode[] {
  return graph.nodes.filter((n) => isPipelineNodeType(n.type) && n.shipped_at && !isRetired(n));
}

/** The median recent rate of the shipped, active pipeline nodes: the project's own pace. */
export function graphRateMedian(graph: MindPlanGraph, settings: HotspotSettings, now: Date = new Date()): number {
  // Open revisions are not ships yet: a change that opens many nodes must not raise the bar for all.
  const rates = rateCandidates(graph)
    .map((n) => recentRate({ ...n, next: undefined }, settings, now))
    .sort((a, b) => a - b);
  if (rates.length === 0) return 0;
  const mid = Math.floor(rates.length / 2);
  return rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;
}

/** Ids of every decision some active record supersedes, anywhere in the graph. */
function supersededIds(graph: MindPlanGraph): Set<string> {
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (isRetired(n)) continue;
    for (const d of [...(n.decisions ?? []), ...(n.next?.decisions ?? [])]) if (d.supersedes) ids.add(d.supersedes);
  }
  return ids;
}

/**
 * True while the node holds a `keep_whole` decision no record supersedes: the owner decided it
 * stays one node. `superseded` comes from `hotspotContext` when many nodes are asked.
 */
export function keepsWhole(node: MindPlanNode, superseded: Set<string>): boolean {
  return [...(node.decisions ?? []), ...(node.next?.decisions ?? [])].some(
    (d) => d.keep_whole && !superseded.has(d.id)
  );
}

export type Hotspot = {
  node_id: string;
  type: MindPlanNode["type"];
  /** Recent ship rate (decayed ship count). */
  rate: number;
  /** The graph's median rate it was compared with. */
  median: number;
  fan_in: number;
  /** The most recent change groups its decisions record. */
  changes: ChurnEntry[];
  split_into?: string[];
};

/** Precomputed once per check or reply: one fan-in index, the median, superseded ids, and the time. */
export type HotspotContext = { index: FanInIndex; median: number; superseded: Set<string>; now: Date };

export function hotspotContext(graph: MindPlanGraph, settings: HotspotSettings, now: Date = new Date()): HotspotContext {
  return {
    index: fanInIndex(graph),
    median: graphRateMedian(graph, settings, now),
    superseded: supersededIds(graph),
    now,
  };
}

const GROUPS_SHOWN = 3;
const round = (n: number) => Math.round(n * 10) / 10;

/**
 * A shipped, active Foundation, Interaction, or Interface whose recent ship rate is at least
 * `min_rate` and at least `outlier_ratio` times the graph's median (a median below 1 counts as 1),
 * unless an active `keep_whole` decision exempts it. Fan-in never decides it: it only ranks.
 */
export function hotspotFor(
  graph: MindPlanGraph,
  node: MindPlanNode,
  settings: HotspotSettings,
  ctx: HotspotContext = hotspotContext(graph, settings),
  opening = false
): Hotspot | null {
  if (!isPipelineNodeType(node.type) || !node.shipped_at || isRetired(node) || keepsWhole(node, ctx.superseded)) {
    return null;
  }
  const rate = recentRate(node, settings, ctx.now, opening);
  if (rate < settings.min_rate || rate < settings.outlier_ratio * Math.max(1, ctx.median)) return null;
  return {
    node_id: node.id,
    type: node.type,
    rate: round(rate),
    median: round(ctx.median),
    fan_in: fanIn(graph, node, ctx.index).count,
    changes: nodeChurn(node).slice(-GROUPS_SHOWN),
    ...(node.split_into?.length ? { split_into: [...node.split_into] } : {}),
  };
}

/** Every hotspot, highest rank (rate × fan-in) first. */
export function hotspots(graph: MindPlanGraph, settings: HotspotSettings, now: Date = new Date()): Hotspot[] {
  const ctx = hotspotContext(graph, settings, now);
  const rank = (h: Hotspot) => h.rate * Math.max(1, h.fan_in);
  return graph.nodes
    .map((n) => hotspotFor(graph, n, settings, ctx))
    .filter((h): h is Hotspot => h !== null)
    .sort((a, b) => rank(b) - rank(a) || a.node_id.localeCompare(b.node_id));
}

const REASONS_SHOWN = 2;
const REASON_CHARS = 80;

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > REASON_CHARS ? `${flat.slice(0, REASON_CHARS - 1)}…` : flat;
}

function describeGroups(changes: ChurnEntry[]): string {
  if (changes.length === 0) return "none recorded (no decision names its change)";
  return changes
    .map((c) => {
      if (c.reasons.length === 0) return `change "${c.change}" (no decision recorded)`;
      const shown = c.reasons.slice(0, REASONS_SHOWN).map(shorten);
      const more = c.reasons.length > REASONS_SHOWN ? `; +${c.reasons.length - REASONS_SHOWN} more` : "";
      return `change "${c.change}" (${shown.join("; ")}${more})`;
    })
    .join(", ");
}

function pace(h: Hotspot): string {
  const since = h.split_into?.length ? ` since it split into ${h.split_into.join(", ")}` : "";
  return `ships far more often than the rest of the graph lately (rate ${h.rate} against a median of ${h.median})${since}`;
}

function dependents(n: number): string {
  return n === 1 ? "1 node depends on it directly" : `${n} nodes depend on it directly`;
}

/**
 * How to split each type without breaking the import rules: a Foundation stays the composition
 * root and imports its parts; an Interaction splits into Interactions, one behavior each; an
 * Interface moves behavior into the Interactions it exposes.
 */
function splitAdvice(h: Hotspot): string {
  if (h.type === "Interaction") {
    return `split it into separate Interactions, one behavior each, sharing state through Foundations`;
  }
  if (h.type === "Interface") {
    return `move the behavior into the Interactions it exposes and leave the entry point mounting them`;
  }
  return (
    `move each into its own Foundation that "${h.node_id}" depends_on (mark them on the revision with ` +
    `patch_node_territory split_into, so its ship records the split)`
  );
}

/** The `hotspot:` warning, with a split that keeps imports pointing the way the import rules allow. */
export function hotspotWarning(h: Hotspot): string {
  return (
    `hotspot: "${h.node_id}" ${pace(h)}, and ${dependents(h.fan_in)}; ` +
    `it may change for several reasons. Its recent changes fall into these groups: ${describeGroups(h.changes)}. ` +
    `If they are separate reasons, ${splitAdvice(h)}, so a later feature revises one part and the rest stays ` +
    `closed; if it should stay one node, record that with record_decision({ keep_whole: true }).`
  );
}

/**
 * The warning for `open_next` on a shipped node that is a hotspot counting the revision it opens;
 * null for a node at the graph's pace or one kept whole.
 */
export function openClosedWarning(
  graph: MindPlanGraph,
  node: MindPlanNode,
  settings: HotspotSettings
): string | null {
  if (!node.shipped_at) return null;
  const hotspot = hotspotFor(graph, node, settings, hotspotContext(graph, settings), true);
  if (!hotspot) return null;
  return (
    `Warning: "${node.id}" ${pace(hotspot)}, and this revision reaches its ${hotspot.fan_in} direct ` +
    `dependent${hotspot.fan_in === 1 ? "" : "s"}. Prefer extending it: add a new node that depends_on "${node.id}", ` +
    `or split it so this change revises a smaller part (recent changes: ${describeGroups(hotspot.changes)}). ` +
    `If revising it is still right, record why with record_decision and name the additive alternative you rejected.`
  );
}

export type AdditivityRow = { id: string; state: string; fan_in: number };

export type ChangeAdditivity = {
  summary: string;
  new_nodes: string[];
  revised: AdditivityRow[];
  neighbors: string[];
  planned: AdditivityRow[];
};

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function listRows(rows: AdditivityRow[]): string {
  return rows.map((r) => `${r.id}, fan-in ${r.fan_in}`).join("; ");
}

/**
 * Whether a change is additive: its never-shipped revisions are new nodes, its shipped revisions
 * reopen closed ones (with their fan-in), its neighbors are edited in place, and its planned
 * sources will be reopened when the change opens them.
 */
export function changeAdditivity(
  graph: MindPlanGraph,
  change: string,
  membership: ReturnType<typeof changeMembership> = changeMembership(graph, change)
): ChangeAdditivity {
  const { revisions, neighbors, planned } = membership;
  const index = fanInIndex(graph);
  const row = (n: MindPlanNode): AdditivityRow => ({ id: n.id, state: n.state, fan_in: fanIn(graph, n, index).count });
  const byFanIn = (a: AdditivityRow, b: AdditivityRow) => b.fan_in - a.fan_in || a.id.localeCompare(b.id);
  const new_nodes = revisions.filter((n) => !n.shipped_at).map((n) => n.id).sort();
  const revised = revisions.filter((n) => n.shipped_at).map(row).sort(byFanIn);
  const plannedRows = planned.map(row).sort(byFanIn);
  const neighborIds = neighbors.map((n) => n.id).sort();
  const parts = [
    count(new_nodes.length, "new node", "new nodes"),
    count(revised.length, "revised shipped node", "revised shipped nodes") +
      (revised.length > 0 ? ` (${listRows(revised)})` : ""),
    count(neighborIds.length, "neighbor", "neighbors"),
  ];
  if (plannedRows.length > 0) {
    parts.push(`${count(plannedRows.length, "planned revision", "planned revisions")} (${listRows(plannedRows)})`);
  }
  const additive = revised.length === 0 && plannedRows.length === 0;
  return {
    summary: `change "${change}": ${parts.join(", ")}${additive ? "; purely additive" : ""}`,
    new_nodes,
    revised,
    neighbors: neighborIds,
    planned: plannedRows,
  };
}
