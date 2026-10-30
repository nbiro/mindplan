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

const fetched = new Map<string, string>();
let enabled = false;

/** Turn the gate on for this process (the MCP server does, unless `MINDPLAN_ORIENT_GATE=off`). */
export function enableOrientationGate(): void {
  enabled = process.env.MINDPLAN_ORIENT_GATE !== "off";
}

/** Whether writes are gated in this process. */
export function orientationGateEnabled(): boolean {
  return enabled;
}

/** Forget every fetch (tests). */
export function resetOrientationLedger(): void {
  fetched.clear();
}

/**
 * The graph with each open revision's proposed `belongs_to` / `depends_on` edges added to its
 * live ones: a revision is built against the rules its new edges bring, before it ships.
 */
export function withProposedEdges(graph: MindPlanGraph): MindPlanGraph {
  const union = (a: string[] | undefined, b: string[] | undefined) =>
    b?.length ? [...new Set([...(a ?? []), ...b])] : a;
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.next
        ? { ...n, belongs_to: union(n.belongs_to, n.next.belongs_to), depends_on: union(n.depends_on, n.next.depends_on) }
        : n
    ),
  };
}

/**
 * The node rules that reach a node for the work at hand: `resolveNodeRules` over live edges plus
 * the proposed edges of open revisions. What orientation shows and what the gate fingerprints.
 */
export function reachingRules(graph: MindPlanGraph, nodeId: string): RuleEntry[] {
  return resolveNodeRules(withProposedEdges(graph), nodeId);
}

/** Tag of the rules that reach a node: its own and every inherited entry, with their sources. */
export function rulesFingerprint(graph: MindPlanGraph, nodeId: string): string {
  const entries = reachingRules(graph, nodeId).map((e) => [e.node_id, e.rules]);
  return createHash("sha1").update(JSON.stringify(entries)).digest("hex");
}

/** Record that these nodes' full context, rules included, reached the agent. */
export function recordOriented(graph: MindPlanGraph, nodeIds: string[]): void {
  for (const id of nodeIds) {
    if (graph.nodes.some((n) => n.id === id)) fetched.set(id, rulesFingerprint(graph, id));
  }
}

/** Why a node's write is not allowed yet, or null when it was fetched with its current rules. */
export function orientationGap(graph: MindPlanGraph, nodeId: string): "unfetched" | "rules_changed" | null {
  if (!enabled) return null;
  const at = fetched.get(nodeId);
  if (at === undefined) return "unfetched";
  return at === rulesFingerprint(graph, nodeId) ? null : "rules_changed";
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
  if (gaps.length === 0) return;
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
