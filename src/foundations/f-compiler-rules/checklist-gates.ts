/**
 * Checklist-kind gates: `build` items are the agent's, `review` and `deploy` items wait on people.
 * A dependency in-review with every build item ticked no longer holds up its dependents (Infrastructure
 * First / Behavior First), while it still ships only with every item ticked (Completion Check).
 */

import type { MindPlanGraph, MindPlanNode } from "../f-domain-model/types.js";
import { isPipelineNodeType } from "../f-domain-model/types.js";
import { openChanges, withRevision } from "../f-revision-model/index.js";
import { parseChecklistItems, type ChecklistItem, type ChecklistKind } from "../f-territory-store/checklist.js";
import { slotSource } from "./shape.js";

/** An unticked review or deploy item: work that waits on a person, not the agent. */
export type OpenHumanItem = {
  node_id: string;
  /** Set for an open revision's item; absent for a live pre-ship node's. */
  change?: string;
  id?: string;
  kind: ChecklistKind;
  text: string;
};

function slotText(node: MindPlanNode, slot: "current" | "next"): string | null {
  return slotSource(node, slot).text;
}

/**
 * True when the text has at least one checklist item and every `build` item is ticked (review and
 * deploy items may stay open). Every counted checkbox that is not tagged review or deploy is a
 * build item, an Acceptance Criteria box included; a text with no item at all proves nothing.
 */
export function buildItemsTicked(text: string): boolean {
  return buildItemsTickedIn(parseChecklistItems(text));
}

/** `buildItemsTicked` over items already parsed. */
export function buildItemsTickedIn(items: ChecklistItem[]): boolean {
  return items.length > 0 && items.every((i) => i.kind !== "build" || i.done);
}

/** The active slot of `dep` is in-review with every build item ticked (the relaxed rule, this node only). */
function relaxedReady(dep: MindPlanNode): boolean {
  if (dep.shipped_at) {
    if (dep.next?.state !== "in-review") return false;
    const text = slotText(dep, "next");
    return text !== null && buildItemsTicked(text);
  }
  if (dep.state !== "in-review") return false;
  const text = slotText(dep, "current");
  return text !== null && buildItemsTicked(text);
}

/**
 * What `dep` itself waits on, in the slot the relaxed rule judges: its depends_on targets, and for
 * an Interface its exposed Interactions (Behavior First). A shipped node's open revision carries
 * its own lists; otherwise the graph's live edges.
 */
function prerequisites(graph: MindPlanGraph, dep: MindPlanNode): string[] {
  if (dep.shipped_at && dep.next) {
    return [...(dep.next.depends_on ?? []), ...(dep.type === "Interface" ? (dep.next.exposes ?? []) : [])];
  }
  return graph.edges
    .filter((e) => e.source === dep.id && (e.type === "depends_on" || (dep.type === "Interface" && e.type === "exposes")))
    .map((e) => e.target);
}

/**
 * Whether dependencies let a dependent ship (Infrastructure First / Behavior First), memoized per
 * graph: a dependency is stable, or its active slot is in-review with at least one checklist item
 * and every build item ticked, and each of its own prerequisites (depends_on, and an Interface's
 * exposes) is satisfied the same way, transitively. The active slot is the live file of a pre-ship
 * node, else its open revision (`next` on a revision view, as `revisionGraph` gives it). A cycle
 * is never satisfied by the relaxed rule.
 */
export function dependencyGate(graph: MindPlanGraph): (dep: MindPlanNode) => boolean {
  const memo = new Map<string, boolean>();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const satisfied = (dep: MindPlanNode): boolean => {
    if (dep.state === "stable") return true;
    const known = memo.get(dep.id);
    if (known !== undefined) return known;
    // In progress: a cycle back to this node is not satisfied.
    memo.set(dep.id, false);
    let ok = relaxedReady(dep);
    if (ok) {
      for (const id of prerequisites(graph, dep)) {
        const target = byId.get(id);
        if (!target || !satisfied(target)) {
          ok = false;
          break;
        }
      }
    }
    memo.set(dep.id, ok);
    return ok;
  };
  return satisfied;
}

/** One-off `dependencyGate(graph)(dep)`. */
export function dependencySatisfied(graph: MindPlanGraph, dep: MindPlanNode): boolean {
  return dependencyGate(graph)(dep);
}

function humanItems(text: string | null, node_id: string, change?: string): OpenHumanItem[] {
  if (text === null) return [];
  return parseChecklistItems(text)
    .filter((i) => i.kind !== "build" && !i.done)
    .map((i) => ({ node_id, ...(change ? { change } : {}), ...(i.id ? { id: i.id } : {}), kind: i.kind, text: i.text }));
}

/**
 * Unticked review / deploy items across live pre-ship pipeline nodes and every open revision,
 * sorted by node.
 */
export function openHumanItems(graph: MindPlanGraph): OpenHumanItem[] {
  const nodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));
  return nodes.flatMap(openHumanItemsOfNode);
}

/**
 * One node's unticked review / deploy items: its live slot while pre-ship (none once cancelled or
 * deprecated), else each open revision's.
 */
export function openHumanItemsOfNode(node: MindPlanNode): OpenHumanItem[] {
  if (!isPipelineNodeType(node.type)) return [];
  if (!node.shipped_at) {
    if (node.state === "cancelled" || node.state === "deprecated") return [];
    return humanItems(slotText(node, "current"), node.id);
  }
  const out: OpenHumanItem[] = [];
  for (const change of openChanges(node)) {
    out.push(...humanItems(slotText(withRevision(node, change), "next"), node.id, change));
  }
  return out;
}

/** The open human items of change `change`: its open revisions' and its live pre-ship members'. */
export function openHumanItemsOfChange(graph: MindPlanGraph, change: string): OpenHumanItem[] {
  const liveChange = new Map(graph.nodes.map((n) => [n.id, n.shipped_at ? undefined : n.change]));
  return openHumanItems(graph).filter((i) =>
    i.change !== undefined ? i.change === change : liveChange.get(i.node_id) === change
  );
}

/**
 * The run_check info line: `waiting on people: <node>[ (revision <c>)]: <id or text> (<kind>); …`,
 * grouped per node and revision. Null when nothing waits.
 */
export function waitingOnPeopleLine(graph: MindPlanGraph): string | null {
  const items = openHumanItems(graph);
  if (items.length === 0) return null;
  const groups = new Map<string, OpenHumanItem[]>();
  for (const item of items) {
    const key = `${item.node_id}${item.change ? ` (revision ${item.change})` : ""}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const parts = [...groups].map(
    ([key, list]) => `${key}: ${list.map((i) => `${i.id ?? i.text} (${i.kind})`).join(", ")}`
  );
  return `waiting on people: ${parts.join("; ")}`;
}
