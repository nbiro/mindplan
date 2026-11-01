/**
 * Deterministic typed-DAG graph projections for humans (Mermaid / DOT).
 * Projections are derived — only `persistMindPlanMap` writes `mindplan/map.md`
 * as a generated snapshot (not part of the node record graph).
 */

import * as fs from "fs";
import * as path from "path";
import { nodeDecisions, supersessionIndex } from "../f-graph-search/decisions.js";
import { expandNeighborhood } from "../f-graph-search/search.js";
import { mindplanRoot } from "../f-territory-store/store.js";
import type { MindPlanEdge, MindPlanGraph, MindPlanNode, NodeType } from "../f-domain-model/types.js";
import { GRAPH_VERSION } from "../f-domain-model/types.js";

/** Generated Mermaid snapshot under the territory root (not a typed node). */
export const MAP_FILENAME = "map.md";

export const VIEW_FORMATS = ["mermaid", "dot"] as const;
export type ViewFormat = (typeof VIEW_FORMATS)[number];

export interface ViewOptions {
  /** When set, render focus + 1-hop neighborhood only. */
  focus?: string;
  /** Include deprecated/cancelled nodes and closed bugs (`resolved` / `wontfix`). Default false. */
  include_retired?: boolean;
  /** Label each node that has active decisions with their count. Default false. */
  decisions?: boolean;
}

export interface ExportMindPlanViewResult {
  format: ViewFormat;
  focus: string | null;
  include_retired: boolean;
  decisions: boolean;
  node_count: number;
  edge_count: number;
  diagram: string;
}

const CLOSED_BUG_STATES = new Set(["resolved", "wontfix"]);

function isRetired(node: MindPlanNode): boolean {
  if (node.state === "deprecated" || node.state === "cancelled") return true;
  if (node.type === "Bug" && CLOSED_BUG_STATES.has(node.state)) return true;
  return false;
}

/** Filter retired nodes/edges; optionally slice to focus neighborhood. */
export function prepareViewGraph(graph: MindPlanGraph, options: ViewOptions = {}): MindPlanGraph {
  const includeRetired = options.include_retired === true;
  let nodes = graph.nodes;
  let edges = graph.edges;

  if (options.focus) {
    const { nodes: summaries, edges: nbrEdges } = expandNeighborhood(graph, options.focus);
    const ids = new Set(summaries.map((n) => n.id));
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    nodes = [...ids]
      .map((id) => byId.get(id))
      .filter((n): n is MindPlanNode => n !== undefined)
      .sort((a, b) => a.id.localeCompare(b.id));
    edges = nbrEdges;
  }

  if (!includeRetired) {
    const kept = new Set(nodes.filter((n) => !isRetired(n)).map((n) => n.id));
    nodes = nodes.filter((n) => kept.has(n.id));
    edges = edges.filter((e) => kept.has(e.source) && kept.has(e.target));
  }

  nodes = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  edges = [...edges].sort((a, b) => {
    const ka = `${a.source}:${a.type}:${a.target}`;
    const kb = `${b.source}:${b.type}:${b.target}`;
    return ka.localeCompare(kb);
  });

  return { version: graph.version ?? GRAPH_VERSION, nodes, edges };
}

function mermaidSafeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_");
}

function escapeLabel(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, "'");
}

/** Active decision count per node id when `decisions` is on; null when off. */
type DecisionCounts = Map<string, number> | null;

function decisionCounts(graph: MindPlanGraph, options: ViewOptions): DecisionCounts {
  if (!options.decisions) return null;
  const index = supersessionIndex(graph);
  const counts = new Map<string, number>();
  for (const node of graph.nodes) {
    const n = nodeDecisions(graph, node, {}, index).length;
    if (n > 0) counts.set(node.id, n);
  }
  return counts;
}

/** ` · N decision(s)` for a node with active decisions when counts are on; otherwise empty. */
function decisionSuffix(node: MindPlanNode, counts: DecisionCounts): string {
  const n = counts?.get(node.id) ?? 0;
  return n > 0 ? ` · ${n} decision${n === 1 ? "" : "s"}` : "";
}

function nodeLabel(node: MindPlanNode, counts: DecisionCounts = null): string {
  return escapeLabel(`${node.id} · ${node.title} · ${node.state}${decisionSuffix(node, counts)}`);
}

function belongsToCapabilities(node: MindPlanNode, edges: MindPlanEdge[]): string[] {
  if (node.type !== "Interaction") return [];
  const fromEdges = edges
    .filter((e) => e.source === node.id && e.type === "belongs_to")
    .map((e) => e.target);
  const fromFm = node.belongs_to ?? [];
  return [...new Set([...fromEdges, ...fromFm])].sort((a, b) => a.localeCompare(b));
}

/**
 * Mermaid node id for an Interaction placed in a Capability cluster.
 * Multi-membership: one visual instance per Capability.
 */
function interactionInstanceId(interactionId: string, capabilityId: string): string {
  return mermaidSafeId(`${interactionId}__in__${capabilityId}`);
}

function interactionCanonicalId(interactionId: string): string {
  return mermaidSafeId(interactionId);
}

/** Resolve display id for an edge endpoint (prefer a known instance). */
function resolveEndpointId(
  nodeId: string,
  byId: Map<string, MindPlanNode>,
  instanceMap: Map<string, string[]>,
  preferCapability?: string
): string {
  const instances = instanceMap.get(nodeId);
  if (instances && instances.length > 0) {
    if (preferCapability) {
      const match = instances.find((i) => i.endsWith(`__in__${mermaidSafeId(preferCapability)}`));
      if (match) return match;
    }
    return instances[0];
  }
  const node = byId.get(nodeId);
  if (node) return mermaidSafeId(node.id);
  return mermaidSafeId(nodeId);
}

export function graphToMermaid(graph: MindPlanGraph, options: ViewOptions = {}): string {
  const view = prepareViewGraph(graph, options);
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const counts = decisionCounts(graph, options);
  const lines: string[] = ["flowchart TB"];

  const capabilities = view.nodes.filter((n) => n.type === "Capability").sort((a, b) => a.id.localeCompare(b.id));
  const foundations = view.nodes
    .filter((n) => n.type === "Foundation")
    .sort((a, b) => a.id.localeCompare(b.id));
  const interactions = view.nodes
    .filter((n) => n.type === "Interaction")
    .sort((a, b) => a.id.localeCompare(b.id));
  const interfaces = view.nodes
    .filter((n) => n.type === "Interface")
    .sort((a, b) => a.id.localeCompare(b.id));
  const bugs = view.nodes.filter((n) => n.type === "Bug").sort((a, b) => a.id.localeCompare(b.id));

  /** interactionId → list of mermaid instance ids */
  const instanceMap = new Map<string, string[]>();

  if (foundations.length > 0) {
    lines.push(`  subgraph foundations["Foundations"]`);
    for (const f of foundations) {
      lines.push(`    ${mermaidSafeId(f.id)}["${nodeLabel(f, counts)}"]`);
    }
    lines.push(`  end`);
  }

  if (interfaces.length > 0) {
    lines.push(`  subgraph interfaces["Interfaces"]`);
    for (const iface of interfaces) {
      lines.push(`    ${mermaidSafeId(iface.id)}{{"${nodeLabel(iface, counts)}"}}`);
    }
    lines.push(`  end`);
  }

  const capabilityIds = new Set(capabilities.map((j) => j.id));
  const unassigned: MindPlanNode[] = [];

  for (const j of capabilities) {
    const sgId = mermaidSafeId(`capability_${j.id}`);
    lines.push(
      `  subgraph ${sgId}["${escapeLabel(`${j.id} · ${j.title} · ${j.state}${decisionSuffix(j, counts)}`)}"]`
    );
    for (const ix of interactions) {
      const owners = belongsToCapabilities(ix, view.edges).filter((id) => capabilityIds.has(id));
      if (!owners.includes(j.id)) continue;
      const inst = interactionInstanceId(ix.id, j.id);
      const list = instanceMap.get(ix.id) ?? [];
      list.push(inst);
      instanceMap.set(ix.id, list);
      lines.push(`    ${inst}["${nodeLabel(ix, counts)}"]`);
    }
    lines.push(`  end`);
  }

  for (const ix of interactions) {
    const owners = belongsToCapabilities(ix, view.edges).filter((id) => capabilityIds.has(id));
    if (owners.length === 0) {
      unassigned.push(ix);
      const inst = interactionCanonicalId(ix.id);
      instanceMap.set(ix.id, [inst]);
    }
  }

  if (unassigned.length > 0) {
    lines.push(`  subgraph unassigned["Unassigned interactions"]`);
    for (const ix of unassigned) {
      lines.push(`    ${interactionCanonicalId(ix.id)}["${nodeLabel(ix, counts)}"]`);
    }
    lines.push(`  end`);
  }

  for (const bug of bugs) {
    lines.push(`  ${mermaidSafeId(bug.id)}["${nodeLabel(bug, counts)}"]`);
  }

  // Edges: omit belongs_to (encoded by clustering); style depends_on / exposes / mounts / leads_to / affects
  for (const e of view.edges) {
    if (e.type === "belongs_to") continue;
    if (!byId.has(e.source) || !byId.has(e.target)) continue;

    const targetNode = byId.get(e.target)!;

    if (e.type === "depends_on") {
      const srcInstances = instanceMap.get(e.source) ?? [mermaidSafeId(e.source)];
      const tgt =
        targetNode.type === "Interaction"
          ? (instanceMap.get(e.target) ?? [mermaidSafeId(e.target)])[0]
          : mermaidSafeId(e.target);
      for (const src of srcInstances) {
        lines.push(`  ${src} --> ${tgt}`);
      }
      continue;
    }

    if (e.type === "exposes") {
      const src = mermaidSafeId(e.source);
      const tgt =
        targetNode.type === "Interaction"
          ? (instanceMap.get(e.target) ?? [mermaidSafeId(e.target)])[0]
          : mermaidSafeId(e.target);
      lines.push(`  ${src} -->|exposes| ${tgt}`);
      continue;
    }

    if (e.type === "mounts") {
      lines.push(`  ${mermaidSafeId(e.source)} ==>|mounts| ${mermaidSafeId(e.target)}`);
      continue;
    }

    if (e.type === "leads_to") {
      const srcInstances = instanceMap.get(e.source) ?? [mermaidSafeId(e.source)];
      const tgt =
        targetNode.type === "Interaction"
          ? (instanceMap.get(e.target) ?? [mermaidSafeId(e.target)])[0]
          : mermaidSafeId(e.target);
      for (const src of srcInstances) {
        lines.push(`  ${src} -.->|leads_to| ${tgt}`);
      }
      continue;
    }

    if (e.type === "affects") {
      const src = mermaidSafeId(e.source);
      const tgt = resolveEndpointId(e.target, byId, instanceMap);
      lines.push(`  ${src} -.-> ${tgt}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function dotSafeId(id: string): string {
  return `"${id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function dotLabel(node: MindPlanNode, counts: DecisionCounts = null): string {
  const n = counts?.get(node.id) ?? 0;
  const suffix = n > 0 ? `\\n${n} decision${n === 1 ? "" : "s"}` : "";
  return `${node.id}\\n${node.title}\\n(${node.state})${suffix}`.replace(/"/g, '\\"');
}

function shapeFor(type: NodeType): string {
  switch (type) {
    case "Capability":
      return "folder";
    case "Foundation":
      return "box";
    case "Interaction":
      return "ellipse";
    case "Interface":
      return "hexagon";
    case "Bug":
      return "octagon";
    default:
      return "ellipse";
  }
}

export function graphToDot(graph: MindPlanGraph, options: ViewOptions = {}): string {
  const view = prepareViewGraph(graph, options);
  const counts = decisionCounts(graph, options);
  const lines: string[] = [
    "digraph MindPlan {",
    '  rankdir=TB;',
    '  node [fontname="Helvetica"];',
    '  edge [fontname="Helvetica"];',
  ];

  const capabilities = view.nodes.filter((n) => n.type === "Capability").sort((a, b) => a.id.localeCompare(b.id));
  const foundations = view.nodes
    .filter((n) => n.type === "Foundation")
    .sort((a, b) => a.id.localeCompare(b.id));
  const interactions = view.nodes
    .filter((n) => n.type === "Interaction")
    .sort((a, b) => a.id.localeCompare(b.id));
  const interfaces = view.nodes
    .filter((n) => n.type === "Interface")
    .sort((a, b) => a.id.localeCompare(b.id));
  const bugs = view.nodes.filter((n) => n.type === "Bug").sort((a, b) => a.id.localeCompare(b.id));
  const capabilityIds = new Set(capabilities.map((j) => j.id));

  if (foundations.length > 0) {
    lines.push("  subgraph cluster_foundations {");
    lines.push('    label="Foundations";');
    lines.push("    style=rounded;");
    for (const f of foundations) {
      lines.push(
        `    ${dotSafeId(f.id)} [label="${dotLabel(f, counts)}", shape=${shapeFor("Foundation")}];`
      );
    }
    lines.push("  }");
  }

  if (interfaces.length > 0) {
    lines.push("  subgraph cluster_interfaces {");
    lines.push('    label="Interfaces";');
    lines.push("    style=rounded;");
    for (const iface of interfaces) {
      lines.push(
        `    ${dotSafeId(iface.id)} [label="${dotLabel(iface, counts)}", shape=${shapeFor("Interface")}];`
      );
    }
    lines.push("  }");
  }

  for (const j of capabilities) {
    const clusterId = j.id.replace(/[^a-zA-Z0-9_]/g, "_");
    const clusterLabel = `${j.id} · ${j.title} · ${j.state}`.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    lines.push(`  subgraph cluster_${clusterId} {`);
    lines.push(`    label="${clusterLabel}";`);
    lines.push("    style=rounded;");
    lines.push(
      `    ${dotSafeId(j.id)} [label="${dotLabel(j, counts)}", shape=${shapeFor("Capability")}, style=dashed];`
    );
    for (const ix of interactions) {
      const owners = belongsToCapabilities(ix, view.edges).filter((id) => capabilityIds.has(id));
      if (!owners.includes(j.id)) continue;
      // DOT cluster membership is exclusive — place in lexicographically first owning Capability.
      const primary = owners[0];
      if (primary !== j.id) continue;
      const multi =
        owners.length > 1 ? `\\n[also: ${owners.slice(1).join(", ")}]` : "";
      lines.push(
        `    ${dotSafeId(ix.id)} [label="${dotLabel(ix, counts)}${multi}", shape=${shapeFor("Interaction")}];`
      );
    }
    lines.push("  }");
  }

  const assigned = new Set<string>();
  for (const ix of interactions) {
    const owners = belongsToCapabilities(ix, view.edges).filter((id) => capabilityIds.has(id));
    if (owners.length > 0) {
      assigned.add(ix.id);
    }
  }

  for (const ix of interactions) {
    if (assigned.has(ix.id)) continue;
    lines.push(
      `  ${dotSafeId(ix.id)} [label="${dotLabel(ix, counts)}", shape=${shapeFor("Interaction")}];`
    );
  }

  for (const bug of bugs) {
    lines.push(
      `  ${dotSafeId(bug.id)} [label="${dotLabel(bug, counts)}", shape=${shapeFor("Bug")}];`
    );
  }

  for (const e of view.edges) {
    if (e.type === "belongs_to") continue;
    if (e.type === "depends_on") {
      lines.push(`  ${dotSafeId(e.source)} -> ${dotSafeId(e.target)} [style=solid];`);
      continue;
    }
    if (e.type === "exposes") {
      lines.push(
        `  ${dotSafeId(e.source)} -> ${dotSafeId(e.target)} [style=solid, label="exposes"];`
      );
      continue;
    }
    if (e.type === "mounts") {
      lines.push(
        `  ${dotSafeId(e.source)} -> ${dotSafeId(e.target)} [style=bold, label="mounts"];`
      );
      continue;
    }
    if (e.type === "leads_to") {
      lines.push(
        `  ${dotSafeId(e.source)} -> ${dotSafeId(e.target)} [style=dashed, label="leads_to"];`
      );
      continue;
    }
    if (e.type === "affects") {
      lines.push(`  ${dotSafeId(e.source)} -> ${dotSafeId(e.target)} [style=dashed];`);
    }
  }

  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export function exportMindPlanView(
  graph: MindPlanGraph,
  args: ViewOptions & { format?: ViewFormat } = {}
): ExportMindPlanViewResult {
  const format: ViewFormat = args.format ?? "mermaid";
  const include_retired = args.include_retired === true;
  const decisions = args.decisions === true;
  const focus = args.focus ?? null;
  const options: ViewOptions = {
    focus: focus ?? undefined,
    include_retired,
    decisions,
  };
  const view = prepareViewGraph(graph, options);
  const diagram = format === "dot" ? graphToDot(graph, options) : graphToMermaid(graph, options);

  return {
    format,
    focus,
    include_retired,
    decisions,
    node_count: view.nodes.length,
    edge_count: view.edges.length,
    diagram,
  };
}

/** Absolute path to the auto-generated Mermaid snapshot (`mindplan/map.md`). */
export function mindPlanMapPath(): string {
  return path.join(mindplanRoot(), MAP_FILENAME);
}

/**
 * Writes the full Mermaid projection to `mindplan/map.md`.
 * Called after every successful graph mutation so the map tracks live territory.
 */
export function persistMindPlanMap(graph: MindPlanGraph): string {
  const { diagram, node_count, edge_count } = exportMindPlanView(graph, {
    format: "mermaid",
  });
  const out = mindPlanMapPath();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const body =
    `# MindPlan map\n\n` +
    `_Auto-generated after each graph mutation (${node_count} nodes, ${edge_count} edges). Do not edit by hand._\n\n` +
    "```mermaid\n" +
    `${diagram.trimEnd()}\n` +
    "```\n";
  fs.writeFileSync(out, body, "utf-8");
  return out;
}
