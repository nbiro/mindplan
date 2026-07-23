/**
 * MindPlan data model — node records and edges persisted in current.mdx frontmatter.
 * Optional next.mdx holds an in-flight evolution of a shipped Foundation/Workflow.
 */

/** Schema generation reported by get_mindplan_graph (no file on disk). */
export const GRAPH_VERSION = 1;

export const NODE_TYPES = ["Journey", "Foundation", "Workflow", "Bug"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** Manual build pipeline for Foundations and Workflows (pre-production). */
export const EXECUTION_STATES = [
  "draft",
  "ready",
  "in-progress",
  "in-review",
  "cancelled",
  "deprecated",
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

/** Pseudo-transition from in-review to production; sets shipped_at and computed stable/unstable. */
export const SHIP_TRANSITION = "ship" as const;

/** Computed production health for shipped Foundations and Workflows. Never set manually. */
export const PRODUCTION_STATES = ["stable", "unstable"] as const;
export type ProductionState = (typeof PRODUCTION_STATES)[number];

/** Dedicated defect lifecycle for Bugs. */
export const BUG_STATES = ["open", "triaged", "fixing", "in-review", "resolved", "wontfix"] as const;
export type BugState = (typeof BUG_STATES)[number];

/** Bug states that mark a defect as still open for stability computation. */
export const OPEN_BUG_STATES = ["open", "triaged", "fixing", "in-review"] as const;
export type OpenBugState = (typeof OPEN_BUG_STATES)[number];

/**
 * Computed-only states for Journeys. Never set manually.
 * "draft" is the resting state when no Workflow is in-progress/in-review/shipped.
 */
export const JOURNEY_STATES = ["draft", "incubation", "stable", "evolving"] as const;
export type JourneyState = (typeof JOURNEY_STATES)[number];

export type NodeState = ExecutionState | ProductionState | JourneyState | BugState;

export const EDGE_TYPES = ["depends_on", "belongs_to", "affects"] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

export const BUG_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type BugSeverity = (typeof BUG_SEVERITIES)[number];

/** Pre-ship build states allowed on next.mdx (evolution slot). */
export const NEXT_PIPELINE_STATES = ["draft", "ready", "in-progress", "in-review"] as const;
export type NextPipelineState = (typeof NEXT_PIPELINE_STATES)[number];

/** In-flight evolution of a shipped Foundation/Workflow (from next.mdx). */
export interface NextSlot {
  state: NextPipelineState;
  title: string;
  description: string;
  updated_at: string;
  /** Proposed Workflow → Journey ids; applied to current on ship. */
  belongs_to?: string[];
  /** Proposed depends_on targets; applied to current on ship. */
  depends_on?: string[];
}

export interface MindPlanNode {
  id: string;
  type: NodeType;
  title: string;
  description: string;
  state: NodeState;
  created_at: string;
  updated_at: string;
  shipped_at?: string;
  severity?: BugSeverity;
  /** MCP-only. Workflow → Journey ids. */
  belongs_to?: string[];
  /** MCP-only. Workflow → Foundation|Workflow ids; Foundation → Foundation ids. */
  depends_on?: string[];
  /** MCP-only. Bug → Workflow|Foundation ids. */
  affects?: string[];
  /** Present when next.mdx exists (Foundation/Workflow evolution in progress). */
  next?: NextSlot;
}

export interface MindPlanEdge {
  source: string;
  target: string;
  type: EdgeType;
}

/** Runtime graph — nodes and edges assembled from territory frontmatter. */
export interface MindPlanGraph {
  version: number;
  edges: MindPlanEdge[];
  nodes: MindPlanNode[];
}

/** Legal transitions in the manual build pipeline. */
export const EXECUTION_TRANSITIONS: Record<
  ExecutionState,
  readonly (ExecutionState | typeof SHIP_TRANSITION)[]
> = {
  draft: ["ready", "cancelled"],
  ready: ["in-progress", "draft", "cancelled"],
  "in-progress": ["in-review", "ready", "cancelled"],
  "in-review": [SHIP_TRANSITION, "in-progress", "cancelled"],
  cancelled: [],
  deprecated: [],
};

/** From computed production states — retire live code. */
export const PRODUCTION_TRANSITIONS: Record<ProductionState, readonly ExecutionState[]> = {
  stable: ["deprecated"],
  unstable: ["deprecated"],
};

/** Dedicated Bug state machine. */
export const BUG_TRANSITIONS: Record<BugState, readonly BugState[]> = {
  open: ["triaged", "wontfix"],
  triaged: ["fixing", "open"],
  fixing: ["in-review", "triaged", "open"],
  "in-review": ["resolved", "fixing"],
  resolved: [],
  wontfix: [],
};

export function isProductionState(state: string): state is ProductionState {
  return (PRODUCTION_STATES as readonly string[]).includes(state);
}

export function isExecutionState(state: string): state is ExecutionState {
  return (EXECUTION_STATES as readonly string[]).includes(state);
}

export function isBugState(state: string): state is BugState {
  return (BUG_STATES as readonly string[]).includes(state);
}

export function isOpenBugState(state: string): state is OpenBugState {
  return (OPEN_BUG_STATES as readonly string[]).includes(state);
}

export function isNextPipelineState(state: string): state is NextPipelineState {
  return (NEXT_PIPELINE_STATES as readonly string[]).includes(state);
}

/** Pre-ship build states where Workflow description/title may change when scope shifts. */
export const PRE_SHIP_WORKFLOW_STATES = ["draft", "ready", "in-progress", "in-review"] as const;
export type PreShipWorkflowState = (typeof PRE_SHIP_WORKFLOW_STATES)[number];

export function initialStateForType(type: NodeType): NodeState {
  return type === "Bug" ? "open" : "draft";
}
