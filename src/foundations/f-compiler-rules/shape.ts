/**
 * Minimum Territory Shape — the structural document gate (not semantic Territory Completeness).
 * One constant names the required sections per node type; the transition gate, the per-section
 * report that `create_node` and orientation return, the check's draft warning, and the table the
 * docs embed all read it, so an agent can learn the shape before the first transition.
 */

import type { FoundationRole, MindPlanNode } from "../f-domain-model/types.js";
import { isInactiveNode, isOpenBugState, isPipelineNodeType } from "../f-domain-model/types.js";
import { readMarkdown, splitContext, territorySlotFilename } from "../f-territory-store/store.js";

export type ShapedNodeType = "Foundation" | "Interaction" | "Interface" | "Bug";
export type ShapeGate = "ready" | "in-review" | "ship" | "resolved";

export type ShapeSectionSpec = {
  /** prose: real text, not a create_node stub; checklist: at least one Markdown checkbox. */
  kind: "prose" | "checklist";
  /** The canonical heading first, then accepted alternatives. */
  headings: string[];
};

export type TypeShape = {
  sections: ShapeSectionSpec[];
  /** Transitions that run the gate. */
  gates: ShapeGate[];
  /** A Foundation needs a role (frontmatter `role` or a role tag at the start of its description). */
  role?: true;
};

const PIPELINE_GATES: ShapeGate[] = ["ready", "in-review", "ship"];

/** The required sections per type: the only copy. */
export const TERRITORY_SHAPE: Record<ShapedNodeType, TypeShape> = {
  Foundation: {
    sections: [
      { kind: "prose", headings: ["Purpose"] },
      { kind: "prose", headings: ["Shared Substrate Spec"] },
      { kind: "prose", headings: ["Acceptance Criteria"] },
      { kind: "checklist", headings: ["Atomic Ops", "Checklist"] },
    ],
    gates: PIPELINE_GATES,
    role: true,
  },
  Interaction: {
    sections: [
      { kind: "prose", headings: ["Purpose"] },
      { kind: "prose", headings: ["Actor & Trigger"] },
      { kind: "prose", headings: ["PRD / Execution Logic", "Execution Logic", "PRD"] },
      { kind: "prose", headings: ["Acceptance Criteria"] },
      { kind: "checklist", headings: ["Atomic Ops"] },
    ],
    gates: PIPELINE_GATES,
  },
  Interface: {
    sections: [
      { kind: "prose", headings: ["Purpose"] },
      { kind: "prose", headings: ["Kind"] },
      { kind: "prose", headings: ["Spec"] },
      { kind: "prose", headings: ["Acceptance Criteria"] },
      { kind: "checklist", headings: ["Atomic Ops"] },
    ],
    gates: PIPELINE_GATES,
  },
  Bug: {
    sections: [
      { kind: "prose", headings: ["Summary"] },
      { kind: "prose", headings: ["Repro Steps"] },
      { kind: "checklist", headings: ["Fix Checklist"] },
    ],
    gates: ["in-review", "resolved"],
  },
};

const FOUNDATION_ROLE_TAG = /^(Assembler|Infra|Design system|Adapter)\b/i;

/** Known create_node scaffold italic stubs — leaving these unedited fails Minimum Territory Shape. */
const SCAFFOLD_PLACEHOLDER_MARKERS = [
  "Say what the product does in this Capability",
  "Self-contained unit of behavior initiated by an actor",
  "Who initiates this Interaction and how",
  "Inputs consumed and outputs produced",
  "Describe the behavior step by step",
  "Checkable outcomes for this Interaction",
  "How an actor enters or accesses Interactions: Page, Dialog",
  "List Interactions this Interface exposes",
  "Presentation/transport/exposure only",
  "Checkable outcomes for this Interface",
  "Role belongs in frontmatter `description` at create time",
  "One-line description of the defect",
  "_Step one_",
  "What should happen",
  "What happens instead",
  "Name the purpose of this Foundation",
  "Checkable outcomes for this Foundation",
  "Name the purpose of this Interface",
] as const;

function shapeBlocked(message: string): Error {
  return new Error(`Blocked: ${message}`);
}

function isShapedType(type: string): type is ShapedNodeType {
  return type in TERRITORY_SHAPE;
}

function extractSection(body: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lines = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const headingRe = new RegExp(`^##\\s+${escaped}\\s*$`, "i");
  const start = lines.findIndex((line) => headingRe.test(line.replace(/\r$/, "")));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i].replace(/\r$/, ""))) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

function normalizeSectionText(section: string): string {
  return section
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, "")
    .trim();
}

function sectionLooksLikeScaffold(section: string): boolean {
  const normalized = normalizeSectionText(section);
  if (!normalized) return true;
  for (const marker of SCAFFOLD_PLACEHOLDER_MARKERS) {
    if (normalized.includes(marker)) return true;
  }
  const substantive = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^_.*_$/.test(line));
  return substantive.length === 0;
}

function sectionHasCheckbox(section: string): boolean {
  return /^\s*[-*+]\s+\[[ xX]\]/m.test(section);
}

export type ShapeSectionStatus = {
  /** The heading found in the body, else the canonical one. */
  heading: string;
  kind: "prose" | "checklist";
  /** stub: a prose section that is empty or still holds placeholder text, or a checklist with no checkbox. */
  status: "present" | "missing" | "stub";
};

/** One gap, with its text in a one-problem Blocked and in a list of several. */
type ShapeProblem = { single: string; item: string };

function slotBody(node: MindPlanNode, slot: "current" | "next"): string {
  try {
    return splitContext(readMarkdown(node, slot))?.body ?? "";
  } catch {
    return "";
  }
}

function slotRole(node: MindPlanNode, slot: "current" | "next"): { role?: FoundationRole; description?: string } {
  if (slot === "next" && node.next) {
    return { role: node.next.role ?? node.role, description: node.next.description };
  }
  return { role: node.role, description: node.description };
}

function sectionStatuses(shape: TypeShape, body: string): ShapeSectionStatus[] {
  return shape.sections.map((spec) => {
    for (const heading of spec.headings) {
      const section = extractSection(body, heading);
      if (section === null) continue;
      const stub =
        spec.kind === "checklist" ? !sectionHasCheckbox(section) : sectionLooksLikeScaffold(section);
      return { heading: `## ${heading}`, kind: spec.kind, status: stub ? "stub" : "present" };
    }
    return { heading: `## ${spec.headings[0]}`, kind: spec.kind, status: "missing" };
  });
}

function roleMissing(node: MindPlanNode, slot: "current" | "next"): boolean {
  const { role, description } = slotRole(node, slot);
  return !role && !FOUNDATION_ROLE_TAG.test(description ?? "");
}

/** Every Minimum Territory Shape gap of a slot, in gate order: Impact, role, then sections. */
function shapeProblems(node: MindPlanNode, slot: "current" | "next"): ShapeProblem[] {
  if (!isShapedType(node.type)) return [];
  const shape = TERRITORY_SHAPE[node.type];
  const file = territorySlotFilename(node, slot);
  const body = slotBody(node, slot);
  const where = `"${node.id}"/${file}`;
  const problems: ShapeProblem[] = [];

  const impact = extractSection(body, "Impact");
  if (impact !== null && sectionLooksLikeScaffold(impact)) {
    problems.push({
      single:
        `${where} section "## Impact" is empty or a stub. ` +
        `Write what this node adapted so the already-shipped contract still holds.`,
      item: `section "## Impact" is empty or a stub`,
    });
  }

  if (shape.role && roleMissing(node, slot)) {
    problems.push({
      single:
        `Foundation "${node.id}" must have frontmatter role ` +
        `(assembler|infra|design-system|adapter) or a description starting with a role tag ` +
        `(Assembler / Infra / Design system / Adapter), e.g. "Infra — …".`,
      item: `no role (frontmatter role, or a description starting with a role tag)`,
    });
  }

  const statuses = sectionStatuses(shape, body);
  shape.sections.forEach((spec, i) => {
    const s = statuses[i];
    if (s.status === "missing") {
      const alternatives =
        spec.headings.length > 1 ? ` (or ## ${spec.headings.slice(1).join(" / ## ")})` : "";
      problems.push({
        single:
          `${where} is missing required section "${s.heading}"${alternatives}. ` +
          `Replace scaffold stubs before leaving draft / entering in-review / shipping.`,
        item: `missing required section "${s.heading}"${alternatives}`,
      });
    } else if (s.status === "stub" && spec.kind === "checklist") {
      problems.push({
        single: `${where} section "${s.heading}" must include at least one Markdown checkbox (- [ ] / - [x]).`,
        item: `section "${s.heading}" has no Markdown checkbox (- [ ] / - [x])`,
      });
    } else if (s.status === "stub") {
      problems.push({
        single:
          `${where} section "${s.heading}" is empty or still contains create_node scaffold placeholder text. ` +
          `Write a real contract before leaving draft / entering in-review / shipping.`,
        item: `section "${s.heading}" is empty or still holds create_node placeholder text`,
      });
    }
  });
  return problems;
}

/**
 * The gate: Blocked once with every gap of the slot. One gap keeps its single-section wording;
 * several are listed in one message so the agent fixes them in one pass.
 */
export function assertMinimumTerritoryShape(
  node: MindPlanNode,
  slot: "current" | "next" = "current"
): void {
  const problems = shapeProblems(node, slot);
  if (problems.length === 0) return;
  if (problems.length === 1) {
    throw shapeBlocked(`Minimum Territory Shape. ${problems[0].single}`);
  }
  const file = territorySlotFilename(node, slot);
  const list = problems.map((p, i) => `(${i + 1}) ${p.item}`).join("; ");
  throw shapeBlocked(
    `Minimum Territory Shape. "${node.id}"/${file} has ${problems.length} problems: ${list}. ` +
      `Write each section before leaving draft / entering in-review / shipping.`
  );
}

export type ShapeReport = {
  slot: "current" | "next";
  gates: ShapeGate[];
  sections: ShapeSectionStatus[];
  /** Present only when a Foundation has no role. */
  role?: "missing";
};

/** The slot whose shape the next transition checks: the open next while one exists. */
function activeShapeSlot(node: MindPlanNode): "current" | "next" | null {
  if (!isShapedType(node.type) || isInactiveNode(node)) return null;
  if (node.type === "Bug") return isOpenBugState(node.state) ? "current" : null;
  if (node.next) return "next";
  return node.shipped_at ? null : "current";
}

/**
 * Required sections of the slot a node's next transition checks, each present, missing, or stub.
 * Null for a Capability, a retired node, a closed Bug, and a shipped node with no open revision.
 */
export function shapeReport(node: MindPlanNode): ShapeReport | null {
  const slot = activeShapeSlot(node);
  if (!slot || !isShapedType(node.type)) return null;
  const shape = TERRITORY_SHAPE[node.type];
  const report: ShapeReport = {
    slot,
    gates: shape.gates,
    sections: sectionStatuses(shape, slotBody(node, slot)),
  };
  if (shape.role && roleMissing(node, slot)) report.role = "missing";
  return report;
}

/**
 * `shape: "<id>" is missing "## X" and has stub "## Y" (required before ready)` for a draft slot,
 * or a Bug before in-review; null when the shape is complete or the node is past that point.
 */
export function shapeWarning(node: MindPlanNode): string | null {
  const slot = activeShapeSlot(node);
  if (!slot) return null;
  const state = slot === "next" ? node.next!.state : node.state;
  const isBug = node.type === "Bug";
  if (isBug ? state === "in-review" : state !== "draft") return null;
  const report = shapeReport(node);
  if (!report) return null;
  const missing = report.sections.filter((s) => s.status === "missing").map((s) => `"${s.heading}"`);
  const stubs = report.sections.filter((s) => s.status === "stub").map((s) => `"${s.heading}"`);
  const parts: string[] = [];
  if (missing.length) parts.push(`is missing ${missing.join(", ")}`);
  if (stubs.length) parts.push(`has stub ${stubs.join(", ")}`);
  if (report.role) parts.push("has no role");
  if (parts.length === 0) return null;
  const label = slot === "next" ? `"${node.id}" (next)` : `"${node.id}"`;
  return `shape: ${label} ${parts.join(" and ")} (required before ${isBug ? "in-review" : "ready"}).`;
}

/** Start and end markers around the generated table in the define-entities skill and SPEC. */
export const SHAPE_TABLE_START = "<!-- shape-table:start -->";
export const SHAPE_TABLE_END = "<!-- shape-table:end -->";

/** The per-type table the docs embed, generated from `TERRITORY_SHAPE`. */
export function shapeTableMarkdown(): string {
  const rows = (Object.keys(TERRITORY_SHAPE) as ShapedNodeType[]).map((type) => {
    const shape = TERRITORY_SHAPE[type];
    const sections = shape.sections.map((spec) => {
      const [first, ...rest] = spec.headings.map((h) => `\`## ${h}\``);
      const alt = rest.length ? ` (or ${rest.join(" / ")})` : "";
      return `${first}${alt}${spec.kind === "checklist" ? " with a checkbox" : ""}`;
    });
    if (shape.role) sections.push("and a `role` (frontmatter, or a role tag starting the description)");
    const gates = shape.gates.map((g) => `\`${g}\``).join(", ");
    return `| ${type} | ${sections.join(", ")} | ${gates} |`;
  });
  return [
    "| Type | Required sections | Checked when moving to |",
    "|---|---|---|",
    ...rows,
    "",
    "A prose section must not be empty or hold only `create_node` placeholder text. An optional `## Impact` must not be a stub. Capabilities have no required sections. `create_node` and `orient_for_work` return `shape`: each required section marked `present`, `missing`, or `stub`.",
  ].join("\n");
}
