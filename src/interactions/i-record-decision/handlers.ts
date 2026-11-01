/**
 * Record a decision — owned by i-record-decision: record_decision with supersession and
 * keep_whole.
 */

import {
  DECISION_ID_PATTERN,
  activeChange,
  isInactiveNode,
  type DecisionRecord,
} from "../../foundations/f-domain-model/types.js";
import { appendDecision, loadGraph, validateChangeInput } from "../../foundations/f-territory-store/store.js";
import { blocked, findNode } from "../../foundations/f-compiler-rules/rules.js";
import { inheritanceSources } from "../../foundations/f-graph-search/rules.js";
import {
  decisionIds,
  findDecision,
  generateDecisionId,
  listDecisions,
  supersessionIndex,
} from "../../foundations/f-graph-search/decisions.js";
import { changedFiles, gateWrite, mutationTail } from "../../foundations/f-plan-writes/writes.js";

/** Trims a value and collapses its line breaks: decision fields are single lines. */
function oneLine(value: string | undefined): string {
  return (value ?? "").replace(/\s*\r?\n\s*/g, " ").trim();
}

/**
 * Append one decision record to a node's active slot. Records are never rewritten: changing a
 * decision means recording a new one that supersedes it; the old one's status becomes superseded.
 * Never resets readiness and does not rewrite the map.
 */
export function recordDecision(args: {
  verbose?: boolean;
  node_id: string;
  decision: string;
  alternatives: string[];
  why: string;
  consequences?: string;
  supersedes?: string;
  change?: string;
  id?: string;
  keep_whole?: boolean;
}): Record<string, unknown> {
  gateWrite(null, [args.node_id], "record_decision");
  const graph = loadGraph();
  const node = findNode(graph, args.node_id);
  if (node.type === "Bug") {
    const targets = node.affects ?? [];
    throw blocked(
      `"${node.id}" is a Bug; record the decision on the node the fix shapes` +
        (targets.length ? ` (it affects ${targets.map((t) => `"${t}"`).join(", ")}).` : ".")
    );
  }
  if (isInactiveNode(node)) {
    throw blocked(`"${node.id}" is ${node.state}; decisions cannot be recorded on a retired node.`);
  }
  const decision = oneLine(args.decision);
  if (!decision) throw blocked("record_decision needs decision: one sentence saying what was chosen.");
  const why = oneLine(args.why);
  if (!why) throw blocked("record_decision needs why: the constraint or trade-off that decided it.");
  const alternatives = (args.alternatives ?? []).map(oneLine).filter(Boolean);
  if (alternatives.length === 0) {
    throw blocked("record_decision needs at least one alternative: what else was considered, one line each.");
  }
  const consequences = oneLine(args.consequences);
  validateChangeInput({ change: args.change });
  const change = args.change || activeChange(node);

  let id: string;
  if (args.id !== undefined) {
    if (!DECISION_ID_PATTERN.test(args.id)) {
      throw blocked(`decision id "${args.id}" must be "d-" followed by a slug, e.g. d-capacity-on-booking.`);
    }
    if (decisionIds(graph).has(args.id)) {
      const holder = findDecision(graph, args.id);
      throw blocked(
        `decision id "${args.id}" is already used ` +
          (holder ? `by "${holder.node.id}"` : "(a recorded decision still names it in supersedes)") +
          `. Pick another id, or omit id.`
      );
    }
    id = args.id;
  } else {
    id = generateDecisionId(graph, decision);
  }

  let superseded: { id: string; node_id: string } | undefined;
  if (args.supersedes !== undefined && args.supersedes !== "") {
    const target = findDecision(graph, args.supersedes);
    if (!target) throw blocked(`supersedes names "${args.supersedes}", which is not a recorded decision.`);
    const by = supersessionIndex(graph).get(args.supersedes);
    if (by) {
      throw blocked(
        `"${args.supersedes}" is already superseded by "${by}". Supersede "${by}" instead if it no longer holds.`
      );
    }
    // Reach: the node itself and the nodes it inherits decisions from (its Capabilities and Foundations).
    const reach = inheritanceSources(graph, node.id)
      .filter((s) => s.via !== "affects")
      .map((s) => s.node.id);
    if (!reach.includes(target.node.id)) {
      throw blocked(
        `"${args.supersedes}" is held by "${target.node.id}", which "${node.id}" does not inherit decisions from. ` +
          `A decision may supersede only one on the same node, its Capabilities, or its Foundations.`
      );
    }
    superseded = { id: args.supersedes, node_id: target.node.id };
  }

  const record: DecisionRecord = {
    id,
    decision,
    alternatives,
    why,
    ...(consequences ? { consequences } : {}),
    ...(superseded ? { supersedes: superseded.id } : {}),
    ...(change ? { change } : {}),
    date: new Date().toISOString().slice(0, 10),
    ...(args.keep_whole ? { keep_whole: true } : {}),
  };
  // The record carries its change id; the node's change label is left alone. A label groups live
  // work, and a change that only records decisions never opens a revision, so nothing would clear it.
  const written = appendDecision(node, record);
  const after = loadGraph();
  const entry = listDecisions(after, { node_id: node.id, include_superseded: true }).find(
    (d) => d.id === id
  );
  return {
    node_id: node.id,
    slot: written.slot,
    decision: entry ?? record,
    ...(superseded ? { supersedes: superseded } : {}),
    changed_files: changedFiles(written.paths),
    ...mutationTail(after, node.id, args.verbose),
  };
}
