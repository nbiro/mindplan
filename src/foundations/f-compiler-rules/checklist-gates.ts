/**
 * Checklist-kind gates: `build` items are the agent's, `review` and `deploy` items wait on people.
 * A dependency in-review with every build item ticked no longer holds up its dependents (Infrastructure
 * First / Behavior First), while it still ships only with every item ticked (Completion Check).
 */

import type { MindPlanGraph, MindPlanNode } from "../f-domain-model/types.js";
import { isPipelineNodeType } from "../f-domain-model/types.js";
import { openChanges, revisionFor, withRevision } from "../f-revision-model/index.js";
import { parseChecklistItems, type ChecklistKind } from "../f-territory-store/checklist.js";
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

/** True when every `build` item of the text's checklist is ticked (review and deploy items may stay open). */
export function buildItemsTicked(text: string): boolean {
  return parseChecklistItems(text).every((i) => i.kind !== "build" || i.done);
}

/**
 * Whether `dep` lets a dependent ship (Infrastructure First / Behavior First): it is stable, or its
 * active slot is in-review with every build item ticked. The active slot is the live file of a
 * pre-ship node, else its open revision (`next` on a revision view, as `revisionGraph` gives it).
 */
export function dependencySatisfied(dep: MindPlanNode): boolean {
  if (dep.state === "stable") return true;
  if (dep.shipped_at) {
    if (dep.next?.state !== "in-review") return false;
    const text = slotText(dep, "next");
    return text !== null && buildItemsTicked(text);
  }
  if (dep.state !== "in-review") return false;
  const text = slotText(dep, "current");
  return text !== null && buildItemsTicked(text);
}

function humanItems(text: string | null, node_id: string, change?: string): OpenHumanItem[] {
  if (text === null) return [];
  return parseChecklistItems(text)
    .filter((i) => i.kind !== "build" && !i.done)
    .map((i) => ({ node_id, ...(change ? { change } : {}), ...(i.id ? { id: i.id } : {}), kind: i.kind, text: i.text }));
}

/**
 * Unticked review / deploy items across live pre-ship pipeline nodes and every open revision (a
 * legacy next file counts as its change's revision), sorted by node.
 */
export function openHumanItems(graph: MindPlanGraph): OpenHumanItem[] {
  const out: OpenHumanItem[] = [];
  const nodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));
  for (const node of nodes) {
    if (!isPipelineNodeType(node.type)) continue;
    if (!node.shipped_at) {
      if (node.state === "cancelled" || node.state === "deprecated") continue;
      out.push(...humanItems(slotText(node, "current"), node.id));
      continue;
    }
    for (const change of openChanges(node)) {
      out.push(...humanItems(slotText(withRevision(node, change), "next"), node.id, change));
    }
    if (node.next && !(node.next.change && revisionFor(node, node.next.change))) {
      out.push(...humanItems(slotText(node, "next"), node.id, node.next.change));
    }
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
