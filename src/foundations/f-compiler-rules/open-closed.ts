/**
 * Open–closed signals. A feature should mostly add nodes, and rarely reopen a shipped node that
 * many others depend on. These read graph facts only (edges, decisions, change ids), never code,
 * and every signal is a warning or an informational field: none of them Blocks.
 */

import {
  countsTowardRate,
  decayChurn,
  isInactiveNode,
  isPipelineNodeType,
  type DecisionRecord,
  type MindPlanGraph,
  type MindPlanNode,
  type RevisionReason,
} from "../f-domain-model/types.js";
import { openChanges } from "../f-revision-model/index.js";
import type { HotspotSettings } from "../f-source-index/config.js";
import { changeMembership } from "./planned.js";

/**
 * Every decision a node holds: live, its open next, and each open revision's (by id, so the
 * loader's single-revision next view does not count one twice).
 */
function allDecisions(node: MindPlanNode): DecisionRecord[] {
  const records = new Map<string, DecisionRecord>();
  const revisionDecisions = (node.open_revisions ?? []).flatMap((r) => r.decisions ?? []);
  for (const d of [...(node.decisions ?? []), ...(node.next?.decisions ?? []), ...revisionDecisions]) records.set(d.id, d);
  return [...records.values()];
}

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
): FanIn {
  const nodes = [...(index.get(node.id) ?? [])].sort();
  const globs = (node.implements ?? []).filter(isGlobClaim);
  if (globs.length === 0 || nodes.length < 2) return { count: nodes.length, nodes };
  // A dependent whose territory one of the focus's glob claims reaches into counts with every other
  // dependent that glob reaches: one claim spread over many folders is one reason to depend.
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const groups = new Map<string, string[]>();
  const loose: string[] = [];
  for (const id of nodes) {
    const claims = byId.get(id)?.implements ?? [];
    const glob = globs.find((g) => claims.some((c) => claimsOverlap(c, g)));
    if (glob) groups.set(glob, [...(groups.get(glob) ?? []), id]);
    else loose.push(id);
  }
  const glob_groups = [...groups].filter(([, members]) => members.length > 1).map(([claim, members]) => ({ claim, nodes: members }));
  if (glob_groups.length === 0) return { count: nodes.length, nodes };
  const grouped = new Set(glob_groups.flatMap((g) => g.nodes));
  const singles = nodes.filter((id) => !grouped.has(id));
  return { count: singles.length + glob_groups.length, nodes, raw_count: nodes.length, glob_groups };
}

/**
 * A node's direct fan-in: `count` the distinct dependents, except that dependents reached by one of
 * the node's glob claims (`src/templates/*\/blocks/Legal/`) count once per claim (`glob_groups`,
 * with `raw_count` the uncollapsed number).
 */
export type FanIn = {
  count: number;
  nodes: string[];
  raw_count?: number;
  glob_groups?: { claim: string; nodes: string[] }[];
};

/** A claim with a wildcard (`*`, `?`, or `[`) in it. */
function isGlobClaim(claim: string): boolean {
  return /[*?[]/.test(claim);
}

function segments(claim: string): string[] {
  return claim.trim().replace(/\\/g, "/").replace(/^\.\//, "").split("/").filter((s) => s !== "");
}

/** One path segment against one glob segment (`*` and `?` within the segment, `[...]` classes). */
function segmentMatches(segment: string, glob: string): boolean {
  if (glob === "**") return true;
  const pattern = glob.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${pattern}$`).test(segment);
}

/**
 * Whether a glob claim reaches into another claim's territory: segment by segment over their common
 * length, each path segment matches the glob's (a `**` matches the rest). Graph facts only: the
 * claim strings, never the files.
 */
export function claimsOverlap(claim: string, glob: string): boolean {
  const a = segments(claim);
  const b = segments(glob);
  // The claim must reach the glob's first wildcard: it lies inside one of the folders the glob spans.
  const wildcard = b.findIndex(isGlobClaim);
  if (wildcard >= 0 && a.length <= wildcard) return false;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (b[i] === "**") return true;
    if (isGlobClaim(a[i])) return false;
    if (!segmentMatches(a[i], b[i])) return false;
  }
  return a.length > 0 && b.length > 0;
}

export type ChurnEntry = { change: string; date?: string; reasons: string[] };

/**
 * The distinct changes that shaped `node`, oldest first: the change id of each of its decisions
 * (live and open next, superseded included, since a superseded decision still records a revision;
 * the first build's change counts like any other) plus the change of each of a shipped node's
 * open revisions.
 * `reasons` are the decision sentences recorded under that change. The node keeps no revision
 * log; decisions are the record and git keeps the rest.
 */
export function nodeChurn(node: MindPlanNode): ChurnEntry[] {
  const byChange = new Map<string, ChurnEntry>();
  for (const d of allDecisions(node)) {
    if (!d.change) continue;
    let entry = byChange.get(d.change);
    if (!entry) {
      entry = { change: d.change, reasons: [] };
      byChange.set(d.change, entry);
    }
    if (d.date && (!entry.date || d.date < entry.date)) entry.date = d.date;
    entry.reasons.push(d.decision);
  }
  const open = new Set(openChanges(node));
  if (node.next?.change) open.add(node.next.change);
  for (const c of [...open].sort()) if (!byChange.has(c)) byChange.set(c, { change: c, reasons: [] });
  // Undated entries (the open revision's change with no decision yet) sort last: they are newest.
  return [...byChange.values()].sort(
    (a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.change.localeCompare(b.change)
  );
}

/**
 * What a revision about to open counts as: `true` for one whose reason is not known (it counts),
 * else its reason (only `behavior` and `wiring` count); `false` when none is opening.
 */
export type Opening = RevisionReason | boolean;

/**
 * The reason of the revision that counts toward the rate right now: the one about to open, else the
 * first open revision whose reason counts (a revision with no reason counts, as `undefined`). `null`
 * when none counts.
 */
function countedOpenReason(node: MindPlanNode, opening: Opening): RevisionReason | undefined | null {
  if (opening !== false) {
    const reason = opening === true ? undefined : opening;
    if (countsTowardRate(reason)) return reason;
  }
  // The loader also sets `next` to the one open revision's view, so read the revisions first; a
  // legacy next file with no revisions behind it counts as a revision with no reason.
  if (node.open_revisions?.length) {
    for (const r of node.open_revisions) if (countsTowardRate(r.reason)) return r.reason;
    return null;
  }
  return node.next ? undefined : null;
}

/**
 * How often the node shipped lately for reasons that say something about its design: its stored
 * `churn` (a decayed count of `behavior`, `wiring`, and unrecorded ships as of its last ship)
 * decayed on to `now`, plus one while a counted revision is open (or about to open). A `fix`,
 * `platform`, `text`, or `refactor` revision never counts. 0 for a node with no stored value yet.
 */
export function recentRate(
  node: MindPlanNode,
  settings: HotspotSettings,
  now: Date = new Date(),
  opening: Opening = false
): number {
  const stored = node.churn ?? 0;
  const base = node.shipped_at ? decayChurn(stored, node.shipped_at, now.toISOString(), settings.half_life_days) : 0;
  return base + (countedOpenReason(node, opening) !== null ? 1 : 0);
}

/** What kind of refactor a hotspot needs, read from the reasons its revisions recorded. */
export type HotspotDiagnosis = {
  /**
   * `invert`: mostly `wiring`: each revision added an edge for one more node, so a split would not
   * help; the dependency should point the other way. `split`: mostly `behavior`: it changes for
   * several features' reasons. `unrecorded`: most of the rate predates recorded reasons.
   */
  kind: "invert" | "split" | "unrecorded";
  /** The rate split by reason (decayed counts, rounded). */
  wiring: number;
  behavior: number;
  unrecorded: number;
};

const round = (n: number) => Math.round(n * 10) / 10;

/** The rate's parts by reason, and the refactor they point to. */
export function diagnoseHotspot(
  node: MindPlanNode,
  settings: HotspotSettings,
  now: Date = new Date(),
  opening: Opening = false
): HotspotDiagnosis {
  const decayed = (v: number | undefined) =>
    v && node.shipped_at ? decayChurn(v, node.shipped_at, now.toISOString(), settings.half_life_days) : 0;
  const open = countedOpenReason(node, opening);
  const wiring = decayed(node.churn_wiring) + (open === "wiring" ? 1 : 0);
  const behavior = decayed(node.churn_behavior) + (open === "behavior" ? 1 : 0);
  const rate = recentRate(node, settings, now, opening);
  const unrecorded = Math.max(0, rate - wiring - behavior);
  const kind = wiring + behavior < unrecorded ? "unrecorded" : wiring >= behavior ? "invert" : "split";
  return { kind, wiring: round(wiring), behavior: round(behavior), unrecorded: round(unrecorded) };
}

/**
 * The nodes whose rate says something about the project's pace: shipped, active, and shipped at
 * least twice since their last split. A node shipped once, or a root that just split, has no pace
 * yet; counting them would let a refactor that adds many nodes drag the median down and make every
 * established node look busy. A node with no count (not backfilled) is counted.
 */
function rateCandidates(graph: MindPlanGraph): MindPlanNode[] {
  return graph.nodes.filter(
    (n) =>
      isPipelineNodeType(n.type) &&
      n.shipped_at &&
      !isRetired(n) &&
      (n.revisions === undefined || n.revisions - (n.split_at ?? 0) >= 2)
  );
}

/** The median recent rate of the established nodes (`rateCandidates`): the project's own pace. */
export function graphRateMedian(graph: MindPlanGraph, settings: HotspotSettings, now: Date = new Date()): number {
  // Open revisions are not ships yet: a change that opens many nodes must not raise the bar for all.
  const rates = rateCandidates(graph)
    .map((n) => recentRate({ ...n, next: undefined, open_revisions: undefined }, settings, now))
    .sort((a, b) => a - b);
  if (rates.length === 0) return 0;
  const mid = Math.floor(rates.length / 2);
  return rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;
}

/**
 * Ids of every decision some active record supersedes, anywhere in the graph: live, a legacy next,
 * and every open revision's decisions.
 */
export function supersededIds(graph: MindPlanGraph): Set<string> {
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (isRetired(n)) continue;
    for (const d of allDecisions(n)) if (d.supersedes) ids.add(d.supersedes);
  }
  return ids;
}

/**
 * True while the node holds a `keep_whole` decision no record supersedes: the owner decided it
 * stays one node. `superseded` comes from `hotspotContext` when many nodes are asked.
 */
export function keepsWhole(node: MindPlanNode, superseded: Set<string>): boolean {
  return allDecisions(node).some((d) => d.keep_whole && !superseded.has(d.id));
}

export type Hotspot = {
  node_id: string;
  type: MindPlanNode["type"];
  /** Recent ship rate (decayed ship count). */
  rate: number;
  /** The graph's median rate it was compared with. */
  median: number;
  fan_in: number;
  /** Set when every dependent comes from this one glob claim of the node: no registry or split applies. */
  single_glob?: string;
  /** The refactor its recorded reasons point to. */
  diagnosis: HotspotDiagnosis;
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
  opening: Opening = false
): Hotspot | null {
  if (!isPipelineNodeType(node.type) || !node.shipped_at || isRetired(node) || keepsWhole(node, ctx.superseded)) {
    return null;
  }
  const rate = recentRate(node, settings, ctx.now, opening);
  if (rate < settings.min_rate || rate < settings.outlier_ratio * Math.max(1, ctx.median)) return null;
  const fan = fanIn(graph, node, ctx.index);
  const single = fan.glob_groups?.length === 1 && fan.count === 1 ? fan.glob_groups[0].claim : undefined;
  return {
    node_id: node.id,
    type: node.type,
    rate: round(rate),
    median: round(ctx.median),
    fan_in: fan.count,
    ...(single ? { single_glob: single } : {}),
    diagnosis: diagnoseHotspot(node, settings, ctx.now, opening),
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

function dependents(h: Hotspot): string {
  if (h.single_glob) return `its dependents all come from one claim ("${h.single_glob}"), so they count as one`;
  return h.fan_in === 1 ? "1 node depends on it directly" : `${h.fan_in} nodes depend on it directly`;
}

/**
 * How to split each type without breaking the import rules: a Foundation stays the composition
 * root and imports its parts; an Interaction splits into Interactions, one behavior each; an
 * Interface moves behavior into the Interactions it exposes.
 */
function splitAdvice(h: Hotspot): string {
  if (h.type === "Interaction") {
    return (
      `split it into separate Interactions, one behavior each, sharing state through Foundations ` +
      `(mark them on the revision with patch_node_territory split_into, so its ship records the split)`
    );
  }
  if (h.type === "Interface") {
    return (
      `move the behavior into the Interactions it exposes and leave the Interface mounting them ` +
      `(mark them with patch_node_territory split_into, so its ship records the split)`
    );
  }
  return (
    `move each into its own Foundation that "${h.node_id}" depends_on (mark them on the revision with ` +
    `patch_node_territory split_into, so its ship records the split)`
  );
}

/**
 * How to invert a node that is reopened to add one edge per new node: the per-node edges move to one
 * registry whose only job is the list, so imports still point from the registry down to the nodes.
 */
function invertAdvice(h: Hotspot): string {
  return (
    `move those per-node edges onto one registry Foundation whose only job is the list: "${h.node_id}" ` +
    `(and every other node wired the same way) depends on the registry alone, and the registry depends_on ` +
    `each new node, so a new node adds one line to the registry and reopens nothing else (record keep_whole ` +
    `on the registry: growing by one edge per node is its job)`
  );
}

function reasonMix(d: HotspotDiagnosis): string {
  const parts = [`wiring ${d.wiring}`, `behavior ${d.behavior}`];
  if (d.unrecorded > 0) parts.push(`no reason recorded ${d.unrecorded}`);
  return parts.join(", ");
}

/** The diagnosis: which refactor the recorded reasons point to, and why. */
function diagnosisAdvice(h: Hotspot): string {
  const d = h.diagnosis;
  // One glob claim spread over many folders is one dependency: a registry or a split would not remove it.
  if (h.single_glob) {
    return (
      `Rate by reason: ${reasonMix(d)}. Its fan-in is one glob claim ("${h.single_glob}"), so neither a registry ` +
      `nor a split applies; if it should stay one node, say so with a decision.`
    );
  }
  if (d.kind === "invert") {
    return (
      `Diagnosis: invert (rate by reason: ${reasonMix(d)}). Most of its revisions only wired it to one more ` +
      `node, so it has one reason to change and a split would not help; ${invertAdvice(h)}. ` +
      `Open that revision with reason "refactor".`
    );
  }
  if (d.kind === "split") {
    return (
      `Diagnosis: split (rate by reason: ${reasonMix(d)}). Most of its revisions changed its own behavior; ` +
      `if they serve separate features, ${splitAdvice(h)}, so a later feature revises one part and the rest ` +
      `stays closed. Open that revision with reason "refactor".`
    );
  }
  return (
    `Diagnosis: unknown (rate by reason: ${reasonMix(d)}): most of its rate predates recorded reasons. ` +
    `If those changes only added an edge for another node, ${invertAdvice(h)}; if they changed separate ` +
    `behaviors, ${splitAdvice(h)}.`
  );
}

/** The `hotspot:` warning: the pace, the refactor its recorded reasons point to, and the evidence. */
export function hotspotWarning(h: Hotspot): string {
  return (
    `hotspot: "${h.node_id}" ${pace(h)}, and ${dependents(h)}. ${diagnosisAdvice(h)} ` +
    `Recent changes: ${describeGroups(h.changes)}. ` +
    `If it should stay one node, record that with record_decision({ keep_whole: true }).`
  );
}

/**
 * The warning for `open_next` on a shipped node that is a hotspot counting the revision it opens;
 * null for a node at the graph's pace or one kept whole.
 */
export function openClosedWarning(
  graph: MindPlanGraph,
  node: MindPlanNode,
  settings: HotspotSettings,
  reason?: RevisionReason,
  change?: string
): { warning: string; hotspot: Hotspot } | null {
  // A fix, an upgrade, a wording change, or the refactor itself is no reason to restructure.
  if (!node.shipped_at || !countsTowardRate(reason)) return null;
  // A decision recorded on the node under this change already answers the warning for it.
  if (change !== undefined && answeredUnder(node, change)) return null;
  const hotspot = hotspotFor(graph, node, settings, hotspotContext(graph, settings), reason ?? true);
  if (!hotspot) return null;
  return {
    hotspot,
    warning:
      `Warning: "${node.id}" ${pace(hotspot)}, and this revision reaches ` +
      (hotspot.single_glob
        ? `dependents that all come from one claim ("${hotspot.single_glob}"). `
        : `its ${hotspot.fan_in} direct dependent${hotspot.fan_in === 1 ? "" : "s"}. `) +
      `${diagnosisAdvice(hotspot)} ` +
      `Recent changes: ${describeGroups(hotspot.changes)}. ` +
      `If revising it as it is still right, record why with record_decision, naming the refactor you rejected.`,
  };
}

/** Whether the node holds a decision recorded under `change` (live or any revision): it answers that change's hotspot warning. */
export function answeredUnder(node: MindPlanNode, change: string): boolean {
  return allDecisions(node).some((d) => d.change === change);
}

/**
 * Whether every counted open revision of the node has a decision under its change: the hotspot
 * warning was answered for the work in flight. False with no open revision.
 */
export function answeredForOpenWork(node: MindPlanNode): boolean {
  const open = openChanges(node);
  return open.length > 0 && open.every((c) => answeredUnder(node, c));
}

export type AdditivityRow = { id: string; state: string; fan_in: number };

export type ChangeAdditivity = {
  summary: string;
  new_nodes: string[];
  revised: AdditivityRow[];
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
 * reopen closed ones (with their fan-in), and its planned sources will be reopened when the change
 * opens them.
 */
export function changeAdditivity(
  graph: MindPlanGraph,
  change: string,
  membership: ReturnType<typeof changeMembership> = changeMembership(graph, change)
): ChangeAdditivity {
  const { revisions, planned } = membership;
  const index = fanInIndex(graph);
  const row = (n: MindPlanNode): AdditivityRow => ({ id: n.id, state: n.state, fan_in: fanIn(graph, n, index).count });
  const byFanIn = (a: AdditivityRow, b: AdditivityRow) => b.fan_in - a.fan_in || a.id.localeCompare(b.id);
  const new_nodes = revisions.filter((n) => !n.shipped_at).map((n) => n.id).sort();
  const revised = revisions.filter((n) => n.shipped_at).map(row).sort(byFanIn);
  const plannedRows = planned.map(row).sort(byFanIn);
  const parts = [
    count(new_nodes.length, "new node", "new nodes"),
    count(revised.length, "revised shipped node", "revised shipped nodes") +
      (revised.length > 0 ? ` (${listRows(revised)})` : ""),
  ];
  if (plannedRows.length > 0) {
    parts.push(`${count(plannedRows.length, "planned revision", "planned revisions")} (${listRows(plannedRows)})`);
  }
  const additive = revised.length === 0 && plannedRows.length === 0;
  return {
    summary: `change "${change}": ${parts.join(", ")}${additive ? "; purely additive" : ""}`,
    new_nodes,
    revised,
    planned: plannedRows,
  };
}

/** What a node of each type splits into: a Foundation into Foundations, the rest into Interactions. */
export function splitPartType(type: MindPlanNode["type"]): "Foundation" | "Interaction" | null {
  if (type === "Foundation") return "Foundation";
  if (type === "Interaction" || type === "Interface") return "Interaction";
  return null;
}

/** Why `partId` cannot be marked as a part `node` splits into, or null when it can. */
export function splitPartProblem(graph: MindPlanGraph, node: MindPlanNode, partId: string): string | null {
  const kind = splitPartType(node.type);
  if (!kind) return `"${node.id}" is a ${node.type}; only a Foundation, Interaction, or Interface splits.`;
  const part = graph.nodes.find((n) => n.id === partId);
  if (!part || part.type !== kind || isInactiveNode(part) || part.id === node.id) {
    return `split_into names "${partId}", which is not another active ${kind}.`;
  }
  return null;
}

// The split-part rules are pure revision rules: the store's ship and the walk's dry run share them.
export { splitPartLinked, splitParts } from "../f-revision-model/index.js";

/** The edge a marked part still needs before the ship records it, for the split_into warning. */
export function splitLinkHint(node: MindPlanNode): string {
  if (node.type === "Foundation") return `depend_on it (link_nodes depends_on)`;
  if (node.type === "Interface") return `expose it (link_nodes exposes)`;
  return `share one of its Capabilities (link_nodes belongs_to from the part to one of them)`;
}
