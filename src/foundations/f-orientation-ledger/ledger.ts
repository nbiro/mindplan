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
 * Blocked: Orientation for the first node in `nodeIds` that was not fetched this session, or
 * whose rules changed since; the message names the call that fixes it. No-op while the gate is off.
 */
export function assertOriented(graph: MindPlanGraph, nodeIds: string[], tool: string): void {
  if (!enabled) return;
  for (const id of nodeIds) {
    // An unknown id is the handler's own Blocked ("does not exist"), not an orientation gap.
    if (!graph.nodes.some((n) => n.id === id)) continue;
    const gap = orientationGap(graph, id);
    if (!gap) continue;
    const reason =
      gap === "unfetched"
        ? `"${id}" was not oriented on in this session, so its node rules have not reached you`
        : `the rules that apply to "${id}" changed since you oriented on it`;
    throw new Error(
      `Blocked: Orientation: ${tool} acts on ${reason}. Call orient_for_work({ node_id: "${id}" }) (or get_node_context), read the rules it returns, then retry.`
    );
  }
}
