/**
 * Orientation ledger: which nodes had their full context (with their rules) fetched in this MCP
 * session, and the rules they were fetched with. A write that acts on a node is Blocked until the
 * node was fetched, and again after its rules (own or inherited) changed, so node rules can never
 * be skipped by writing without orienting. In-memory only: one server process is one session. The
 * CLI never enables it (it has no session).
 */

import { createHash } from "crypto";
import type { MindPlanGraph, RuleEntry } from "../f-domain-model/types.js";
import { resolveNodeRules } from "../f-graph-search/rules.js";
import { resolveProjectRoot, rootKey } from "../f-source-index/root-scope.js";

/** Keyed by project root + "\0" + node id: orienting in one checkout never unlocks another. */
/**
 * The value maps each rule source that reached the node when it was recorded to the ledger's tag of
 * that source's text (`ruleTextTag`).
 */
const fetched = new Map<string, Map<string, string>>();

function ledgerKey(nodeId: string): string {
  return `${rootKey(resolveProjectRoot())}\0${nodeId}`;
}
let enabled = false;

/** Turn the gate on for this process (the MCP server does, unless `MINDPLAN_ORIENT_GATE=off`). */
export function enableOrientationGate(): void {
  enabled = process.env.MINDPLAN_ORIENT_GATE !== "off";
}

/** Whether writes are gated in this process. */
export function orientationGateEnabled(): boolean {
  return enabled;
}

/** Forget every fetch, every served project rules version, and every sent rule and decision (tests). */
export function resetOrientationLedger(): void {
  fetched.clear();
  servedRules.clear();
  sentRules.clear();
  sentTags.clear();
  sentDecisions.clear();
  hotspotWarned.clear();
}

/** Keyed by project root + node id + change: the hotspot warnings this session already gave. */
const hotspotWarned = new Set<string>();

/**
 * True the first time this session warns about `nodeId` being a hotspot under `change` (and records
 * it); false after that, so the warning comes once per node per change, not on every reply.
 */
export function firstHotspotWarning(nodeId: string, change: string): boolean {
  const key = `${rootKey(resolveProjectRoot())}\0${nodeId}\0${change}`;
  if (hotspotWarned.has(key)) return false;
  hotspotWarned.add(key);
  return true;
}

// ---------------------------------------------------------------------------
// Node rules and decisions already sent in this session
// ---------------------------------------------------------------------------

/** Keyed by project root + "\0" + rule source id: the rules version whose text this session received. */
const sentRules = new Map<string, string>();

/**
 * Keyed by project root + "\0" + rule source id: the ledger's tag (`ruleTextTag`) of the text this
 * session last received from that source. The gate compares these, never the `rulesVersion`
 * strings replies use for `unchanged` (computed in f-plan-views, which the ledger does not import).
 */
const sentTags = new Map<string, string>();

/** Keyed by project root + "\0" + decision id: the decision's tag (status + text) last sent. */
const sentDecisions = new Map<string, string>();

/**
 * Whether replies leave out what this session already received: on while the gate is on, unless
 * `replies.legacy` asks for the 0.22 shapes (the caller passes it) or the caller asks to resend.
 */
export function tracksSentText(legacy: boolean): boolean {
  return enabled && !legacy;
}

/** Rule source id → the version whose text reached this session (this root only). */
export function sentRulesVersions(): Record<string, string> {
  const prefix = `${rootKey(resolveProjectRoot())}\0`;
  const out: Record<string, string> = {};
  for (const [key, version] of sentRules) if (key.startsWith(prefix)) out[key.slice(prefix.length)] = version;
  return out;
}

/**
 * Record the rule texts a reply carried: every entry with its `rules` text and `version` (entries
 * that came back as one line or `unchanged` carried no text and record nothing).
 */
export function recordRulesSent(entries: Record<string, unknown>[]): void {
  if (!enabled) return;
  const root = rootKey(resolveProjectRoot());
  for (const e of entries) {
    if (typeof e.rules !== "string" || typeof e.node_id !== "string") continue;
    if (typeof e.version === "string") sentRules.set(`${root}\0${e.node_id}`, e.version);
    sentTags.set(`${root}\0${e.node_id}`, ruleTextTag(e.rules));
  }
}

/** A decision's tag: equal tags mean the agent already holds what it says now. */
function decisionTag(d: { decision?: unknown; why?: unknown; status?: unknown; superseded_by?: unknown }): string {
  return createHash("sha1").update(JSON.stringify([d.decision, d.why, d.status, d.superseded_by])).digest("hex");
}

/**
 * Split decision entries into those this session has not received at their current text (returned
 * and recorded as sent) and the count of those it has. Off (everything new) while not tracking.
 */
export function unsentDecisions<T extends { id?: unknown }>(
  entries: T[],
  track: boolean,
  limit = Number.POSITIVE_INFINITY
): { fresh: T[]; known: number; more: number } {
  if (!track) return { fresh: entries, known: 0, more: 0 };
  const root = rootKey(resolveProjectRoot());
  const fresh: T[] = [];
  let known = 0;
  let more = 0;
  for (const e of entries) {
    const key = `${root}\0${String(e.id)}`;
    const tag = decisionTag(e as never);
    if (sentDecisions.get(key) === tag) {
      known += 1;
      continue;
    }
    // Past the limit a new decision is not sent, so it is not recorded: a later reply carries it.
    if (fresh.length >= limit) {
      more += 1;
      continue;
    }
    sentDecisions.set(key, tag);
    fresh.push(e);
  }
  return { fresh, known, more };
}

// ---------------------------------------------------------------------------
// Project rules: which version of mindplan/project.md's rules reached this session
// ---------------------------------------------------------------------------

/** Keyed by project root: the rules_version last served there in this session. */
const servedRules = new Map<string, string>();

/** The project rules as callers load them (`loadProjectBrief` + `rulesVersion`). */
export type ProjectRulesBrief = { path: string | null; rules: string; rules_version: string };

/** Record that the project rules at this version reached the agent (get_project, get_rules, a push). */
export function recordProjectRulesServed(version: string): void {
  servedRules.set(rootKey(resolveProjectRoot()), version);
}

/** Why the project rules gate would fail: never served, or changed since; null when current or the gate is off. */
export function projectRulesGap(version: string): "unserved" | "changed" | null {
  if (!enabled) return null;
  const served = servedRules.get(rootKey(resolveProjectRoot()));
  if (served === undefined) return "unserved";
  return served === version ? null : "changed";
}

/**
 * `{ project_rules }` when the rules are missing from this session or changed since they were
 * served (and records them as served), else `{}`. Replies that orient spread it; a write needs none, since the gate made the rules current first.
 */
export function pushProjectRules(brief: ProjectRulesBrief): { project_rules?: ProjectRulesBrief } {
  if (projectRulesGap(brief.rules_version) === null) return {};
  recordProjectRulesServed(brief.rules_version);
  return { project_rules: brief };
}

/** Blocked: Rules unless the project rules reached this session at their current version. */
export function assertProjectRulesServed(version: string, tool: string): void {
  const gap = projectRulesGap(version);
  if (gap === "unserved") {
    throw new Error(
      `Blocked: Rules: ${tool} acts before the project rules reached you in this session. Call get_project (or get_rules), with the same root when you passed one, read the rules, then retry.`
    );
  }
  if (gap === "changed") {
    throw new Error(
      `Blocked: Rules: the project rules changed since they reached you. Call get_rules, read them, then retry ${tool}.`
    );
  }
}

/**
 * The graph with every open revision's proposed `belongs_to` / `depends_on` edges added to its
 * live ones (the union over all of a node's revisions, plus a legacy next file's): a revision is
 * built against the rules its new edges bring, before it ships, and orienting once covers writes
 * to any of the node's revisions.
 */
export function withProposedEdges(graph: MindPlanGraph): MindPlanGraph {
  const union = (a: string[] | undefined, b: string[]) => (b.length ? [...new Set([...(a ?? []), ...b])] : a);
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const revisions = n.open_revisions ?? [];
      if (!n.next && revisions.length === 0) return n;
      const belongs = [...(n.next?.belongs_to ?? []), ...revisions.flatMap((r) => r.edges.belongs_to?.add ?? [])];
      const depends = [...(n.next?.depends_on ?? []), ...revisions.flatMap((r) => r.edges.depends_on?.add ?? [])];
      return { ...n, belongs_to: union(n.belongs_to, belongs), depends_on: union(n.depends_on, depends) };
    }),
  };
}

/**
 * The node rules that reach a node for the work at hand: `resolveNodeRules` over live edges plus
 * the proposed edges of every open revision. What orientation shows and what the gate fingerprints.
 */
export function reachingRules(graph: MindPlanGraph, nodeId: string): RuleEntry[] {
  return resolveNodeRules(withProposedEdges(graph), nodeId);
}

/** The ledger's own tag of one source's rule text. */
export function ruleTextTag(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/**
 * The rule sources that reach a node, each with the tag of its current text. Order and distance
 * are not part of it, so an edge that only brings a source closer changes nothing.
 */
export function reachingTags(graph: MindPlanGraph, nodeId: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const e of reachingRules(graph, nodeId)) tags.set(e.node_id, ruleTextTag(e.rules));
  return tags;
}

/** Record that these nodes' full context, rules included, reached the agent. */
export function recordOriented(graph: MindPlanGraph, nodeIds: string[]): void {
  for (const id of nodeIds) {
    if (graph.nodes.some((n) => n.id === id)) fetched.set(ledgerKey(id), reachingTags(graph, id));
  }
}

/**
 * Why a node's write is not allowed yet, or null. `unfetched`: never recorded. `rules_changed`: a
 * source reaching it now carries text whose tag matches neither the node's record nor the text this
 * session last received from that source in any reply. A source that stopped reaching the node, one
 * that only moved, and a new source whose current text the session already holds all pass.
 */
export function orientationGap(graph: MindPlanGraph, nodeId: string): "unfetched" | "rules_changed" | null {
  if (!enabled) return null;
  const recorded = fetched.get(ledgerKey(nodeId));
  if (recorded === undefined) return "unfetched";
  const root = rootKey(resolveProjectRoot());
  for (const [source, tag] of reachingTags(graph, nodeId)) {
    if (recorded.get(source) === tag) continue;
    if (sentTags.get(`${root}\0${source}`) === tag) continue;
    return "rules_changed";
  }
  return null;
}

/**
 * Blocked: Orientation naming every node in `nodeIds` that was not fetched this session, or whose
 * rules changed since, in one message with the call that fixes it: one gap keeps the one-node
 * wording; several are listed, and a walk over one change (`opts.change`) names the change-wide
 * orient. No-op while the gate is off.
 */
export function assertOriented(
  graph: MindPlanGraph,
  nodeIds: string[],
  tool: string,
  opts: { change?: string } = {}
): void {
  if (!enabled) return;
  const gaps: { id: string; gap: "unfetched" | "rules_changed" }[] = [];
  for (const id of new Set(nodeIds)) {
    // An unknown id is the handler's own Blocked ("does not exist"), not an orientation gap.
    if (!graph.nodes.some((n) => n.id === id)) continue;
    const gap = orientationGap(graph, id);
    if (gap) gaps.push({ id, gap });
  }
  if (gaps.length === 0) {
    // Every source's text reached the agent: bring the records up to date with what reaches now.
    recordOriented(graph, [...new Set(nodeIds)]);
    return;
  }
  if (gaps.length === 1) {
    const { id, gap } = gaps[0];
    const reason =
      gap === "unfetched"
        ? `"${id}" was not oriented on in this session, so its node rules have not reached you`
        : `the rules that apply to "${id}" changed since you oriented on it`;
    throw new Error(
      `Blocked: Orientation: ${tool} acts on ${reason}. Call orient_for_work({ node_id: "${id}" }) (or get_node_context), read the rules it returns, then retry.`
    );
  }
  const list = gaps
    .map(({ id, gap }) => `"${id}" (${gap === "unfetched" ? "not oriented on in this session" : "rules changed since"})`)
    .join(", ");
  const fix = opts.change
    ? `Call orient_for_work({ change: "${opts.change}" }) to orient on every member at once`
    : `Call orient_for_work({ node_id }) for each (or get_node_context)`;
  throw new Error(
    `Blocked: Orientation: ${tool} acts on ${gaps.length} nodes whose node rules have not reached you: ${list}. ${fix}, read the rules it returns, then retry.`
  );
}
