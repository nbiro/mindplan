/**
 * Deterministic typed-DAG graph projections for humans (Mermaid / DOT).
 * Projections are derived — only `persistMindPlanMap` writes `mindplan/map.md`
 * as a generated snapshot (not part of the node record graph).
 */

import * as fs from "fs";
import * as path from "path";
import { expandNeighborhood } from "./search.js";
import { mindplanRoot } from "./store.js";
import type { MindPlanEdge, MindPlanGraph, MindPlanNode, NodeType } from "./types.js";
import { GRAPH_VERSION } from "./types.js";

/** Generated Mermaid snapshot under the territory root (not a typed node). */
export const MAP_FILENAME = "map.md";

export const VIEW_FORMATS = ["mermaid", "dot"] as const;
export type ViewFormat = (typeof VIEW_FORMATS)[number];

export interface ViewOptions {
  /** When set, render focus + 1-hop neighborhood only. */
  focus?: string;
  /** Include deprecated nodes and closed bugs (`resolved` / `wontfix`). Default false. */
  include_retired?: boolean;
}

export interface ExportMindPlanViewResult {
  format: ViewFormat;
  focus: string | null;
  include_retired: boolean;
  node_count: number;
  edge_count: number;
  diagram: string;
}

const CLOSED_BUG_STATES = new Set(["resolved", "wontfix"]);

function isRetired(node: MindPlanNode): boolean {
  if (node.state === "deprecated") return true;
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

function nodeLabel(node: MindPlanNode): string {
  return escapeLabel(`${node.id} · ${node.title} · ${node.state}`);
}

function belongsToJourneys(node: MindPlanNode, edges: MindPlanEdge[]): string[] {
  if (node.type !== "Workflow") return [];
  const fromEdges = edges
    .filter((e) => e.source === node.id && e.type === "belongs_to")
    .map((e) => e.target);
  const fromFm = node.belongs_to ?? [];
  return [...new Set([...fromEdges, ...fromFm])].sort((a, b) => a.localeCompare(b));
}

/**
 * Mermaid node id for a workflow placed in a journey cluster.
 * Multi-membership: one visual instance per Journey.
 */
function workflowInstanceId(workflowId: string, journeyId: string): string {
  return mermaidSafeId(`${workflowId}__in__${journeyId}`);
}

function workflowCanonicalId(workflowId: string): string {
  return mermaidSafeId(workflowId);
}

/** Resolve display id for an edge endpoint (prefer a known instance). */
function resolveEndpointId(
  nodeId: string,
  byId: Map<string, MindPlanNode>,
  instanceMap: Map<string, string[]>,
  preferJourney?: string
): string {
  const instances = instanceMap.get(nodeId);
  if (instances && instances.length > 0) {
    if (preferJourney) {
      const match = instances.find((i) => i.endsWith(`__in__${mermaidSafeId(preferJourney)}`));
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
  const lines: string[] = ["flowchart TB"];

  const journeys = view.nodes.filter((n) => n.type === "Journey").sort((a, b) => a.id.localeCompare(b.id));
  const foundations = view.nodes
    .filter((n) => n.type === "Foundation")
    .sort((a, b) => a.id.localeCompare(b.id));
  const workflows = view.nodes
    .filter((n) => n.type === "Workflow")
    .sort((a, b) => a.id.localeCompare(b.id));
  const bugs = view.nodes.filter((n) => n.type === "Bug").sort((a, b) => a.id.localeCompare(b.id));

  /** workflowId → list of mermaid instance ids */
  const instanceMap = new Map<string, string[]>();

  if (foundations.length > 0) {
    lines.push(`  subgraph foundations["Foundations"]`);
    for (const f of foundations) {
      lines.push(`    ${mermaidSafeId(f.id)}["${nodeLabel(f)}"]`);
    }
    lines.push(`  end`);
  }

  const journeyIds = new Set(journeys.map((j) => j.id));
  const unassigned: MindPlanNode[] = [];

  for (const j of journeys) {
    const sgId = mermaidSafeId(`journey_${j.id}`);
    lines.push(`  subgraph ${sgId}["${escapeLabel(`${j.id} · ${j.title} · ${j.state}`)}"]`);
    for (const wf of workflows) {
      const owners = belongsToJourneys(wf, view.edges).filter((id) => journeyIds.has(id));
      if (!owners.includes(j.id)) continue;
      const inst = workflowInstanceId(wf.id, j.id);
      const list = instanceMap.get(wf.id) ?? [];
      list.push(inst);
      instanceMap.set(wf.id, list);
      lines.push(`    ${inst}["${nodeLabel(wf)}"]`);
    }
    lines.push(`  end`);
  }

  for (const wf of workflows) {
    const owners = belongsToJourneys(wf, view.edges).filter((id) => journeyIds.has(id));
    if (owners.length === 0) {
      unassigned.push(wf);
      const inst = workflowCanonicalId(wf.id);
      instanceMap.set(wf.id, [inst]);
    }
  }

  if (unassigned.length > 0) {
    lines.push(`  subgraph unassigned["Unassigned workflows"]`);
    for (const wf of unassigned) {
      lines.push(`    ${workflowCanonicalId(wf.id)}["${nodeLabel(wf)}"]`);
    }
    lines.push(`  end`);
  }

  for (const bug of bugs) {
    lines.push(`  ${mermaidSafeId(bug.id)}["${nodeLabel(bug)}"]`);
  }

  // Edges: omit belongs_to (encoded by clustering); style depends_on / affects
  for (const e of view.edges) {
    if (e.type === "belongs_to") continue;
    if (!byId.has(e.source) || !byId.has(e.target)) continue;

    const targetNode = byId.get(e.target)!;

    if (e.type === "depends_on") {
      const srcInstances = instanceMap.get(e.source) ?? [mermaidSafeId(e.source)];
      const tgt =
        targetNode.type === "Workflow"
          ? (instanceMap.get(e.target) ?? [mermaidSafeId(e.target)])[0]
          : mermaidSafeId(e.target);
      for (const src of srcInstances) {
        lines.push(`  ${src} --> ${tgt}`);
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

function dotLabel(node: MindPlanNode): string {
  return `${node.id}\\n${node.title}\\n(${node.state})`.replace(/"/g, '\\"');
}

function shapeFor(type: NodeType): string {
  switch (type) {
    case "Journey":
      return "folder";
    case "Foundation":
      return "box";
    case "Workflow":
      return "ellipse";
    case "Bug":
      return "octagon";
    default:
      return "ellipse";
  }
}

export function graphToDot(graph: MindPlanGraph, options: ViewOptions = {}): string {
  const view = prepareViewGraph(graph, options);
  const lines: string[] = [
    "digraph MindPlan {",
    '  rankdir=TB;',
    '  node [fontname="Helvetica"];',
    '  edge [fontname="Helvetica"];',
  ];

  const journeys = view.nodes.filter((n) => n.type === "Journey").sort((a, b) => a.id.localeCompare(b.id));
  const foundations = view.nodes
    .filter((n) => n.type === "Foundation")
    .sort((a, b) => a.id.localeCompare(b.id));
  const workflows = view.nodes
    .filter((n) => n.type === "Workflow")
    .sort((a, b) => a.id.localeCompare(b.id));
  const bugs = view.nodes.filter((n) => n.type === "Bug").sort((a, b) => a.id.localeCompare(b.id));
  const journeyIds = new Set(journeys.map((j) => j.id));

  if (foundations.length > 0) {
    lines.push("  subgraph cluster_foundations {");
    lines.push('    label="Foundations";');
    lines.push("    style=rounded;");
    for (const f of foundations) {
      lines.push(
        `    ${dotSafeId(f.id)} [label="${dotLabel(f)}", shape=${shapeFor("Foundation")}];`
      );
    }
    lines.push("  }");
  }

  for (const j of journeys) {
    const clusterId = j.id.replace(/[^a-zA-Z0-9_]/g, "_");
    const clusterLabel = `${j.id} · ${j.title} · ${j.state}`.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    lines.push(`  subgraph cluster_${clusterId} {`);
    lines.push(`    label="${clusterLabel}";`);
    lines.push("    style=rounded;");
    lines.push(
      `    ${dotSafeId(j.id)} [label="${dotLabel(j)}", shape=${shapeFor("Journey")}, style=dashed];`
    );
    for (const wf of workflows) {
      const owners = belongsToJourneys(wf, view.edges).filter((id) => journeyIds.has(id));
      if (!owners.includes(j.id)) continue;
      // DOT cluster membership is exclusive — place in lexicographically first owning Journey.
      const primary = owners[0];
      if (primary !== j.id) continue;
      const multi =
        owners.length > 1 ? `\\n[also: ${owners.slice(1).join(", ")}]` : "";
      lines.push(
        `    ${dotSafeId(wf.id)} [label="${dotLabel(wf)}${multi}", shape=${shapeFor("Workflow")}];`
      );
    }
    lines.push("  }");
  }

  const assigned = new Set<string>();
  for (const wf of workflows) {
    const owners = belongsToJourneys(wf, view.edges).filter((id) => journeyIds.has(id));
    if (owners.length > 0) {
      assigned.add(wf.id);
    }
  }

  for (const wf of workflows) {
    if (assigned.has(wf.id)) continue;
    lines.push(
      `  ${dotSafeId(wf.id)} [label="${dotLabel(wf)}", shape=${shapeFor("Workflow")}];`
    );
  }

  for (const bug of bugs) {
    lines.push(
      `  ${dotSafeId(bug.id)} [label="${dotLabel(bug)}", shape=${shapeFor("Bug")}];`
    );
  }

  for (const e of view.edges) {
    if (e.type === "belongs_to") continue;
    const style = e.type === "affects" ? "style=dashed" : "style=solid";
    lines.push(`  ${dotSafeId(e.source)} -> ${dotSafeId(e.target)} [${style}];`);
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
  const focus = args.focus ?? null;
  const options: ViewOptions = {
    focus: focus ?? undefined,
    include_retired,
  };
  const view = prepareViewGraph(graph, options);
  const diagram = format === "dot" ? graphToDot(graph, options) : graphToMermaid(graph, options);

  return {
    format,
    focus,
    include_retired,
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
