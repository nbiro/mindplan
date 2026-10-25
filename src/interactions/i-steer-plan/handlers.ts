/**
 * Mutate MCP tool handlers — owned by i-steer-plan.
 * Return plain payloads with changed_files + anchor; if-mcp-tools wraps with ok/guarded.
 * Map refresh via persistMindPlanMap from f-view-projection (not i-export-map).
 */

import * as fs from "fs";
import * as path from "path";
import {
  DECISION_ID_PATTERN,
  EDGE_TYPES,
  activeChange,
  initialStateForType,
  isFoundationRole,
  isInactiveNode,
  isNeighborNode,
  isNextPipelineState,
  isPipelineNodeType,
  isProductionState,
  type DecisionRecord,
  type FoundationRole,
  type MindPlanGraph,
  type MindPlanNode,
  type NodeType,
} from "../../foundations/f-domain-model/types.js";
import {
  ATTACHMENTS_DIR,
  NEXT_ATTACHMENTS_DIR,
  addEdgeToFrontmatter,
  appendDecision,
  attachmentsDir,
  deleteNextSlotFiles,
  discardNextSlot,
  edgeWriteSlot,
  ensureDirectories,
  entityRelativePath,
  loadGraph,
  markdownRelativePath,
  loadProjectConfig,
  nextAttachmentsDir,
  nodeExists,
  nodeToRecord,
  projectRoot,
  openNextSlot,
  patchFrontmatter,
  patchNodeTerritory as patchNodeTerritoryStore,
  promoteNextSlot,
  readMarkdown,
  territoryBodyReader,
  removeEdgesFromFrontmatter,
  scaffoldEntity,
  splitContext,
  validateChangeInput,
  clearAddedClaims,
  writeChangeFrontmatter,
  writeImplementsFrontmatter,
  writeTestsFrontmatter,
  writeMirrorTwin,
  writeNeighborLabel,
  type CheckboxToggle,
  writeNodeRules,
  writeProjectConfig,
  type TerritorySlot,
} from "../../foundations/f-territory-store/store.js";
import {
  PROJECT_RELATIVE_PATH,
  writeProjectBrief,
} from "../../foundations/f-territory-store/project.js";
import {
  claimCoversPath,
  claimListKeeps,
  expandClaims,
  isGlobClaim,
  normalizeClaimList,
} from "../../foundations/f-source-index/claims.js";
import { decisionGateSettings } from "../../foundations/f-source-index/config.js";
import {
  buildOwnershipIndex,
  exclusiveOwner,
} from "../../foundations/f-source-index/ownership.js";
import {
  collectOtherClaims,
  folderClaimSuggestions,
  isDominatedFolder,
  schemaClaimEntries,
  type OtherClaims,
} from "../../foundations/f-source-index/dominance.js";
import {
  assertAcyclicDependsOn,
  assertPipelineTerritoryScalarsEditable,
  blocked,
  changeMembers,
  changeNeighbors,
  changesWithRevisions,
  findNode,
  recomputeJourneyStates,
  recomputeStability,
  resolveForceUnship,
  resolveStatusChange,
  validateLink,
  validateOpenNext,
} from "../../foundations/f-compiler-rules/rules.js";
import {
  assertCheckCleanForNode,
  findImportViolationsForClaim,
  staleTextWarnings,
} from "../../foundations/f-compiler-rules/integrity.js";
import {
  assertDecisionForReview,
  createDecisionContext,
  type DecisionContext,
} from "../../foundations/f-compiler-rules/decisions.js";
import {
  DEFAULT_FIND_LIMIT,
  findRelatedNodes,
  refreshSearchIndex,
} from "../../foundations/f-graph-search/search.js";
import { inheritanceSources, rulesImpact } from "../../foundations/f-graph-search/rules.js";
import {
  decisionIds,
  findDecision,
  generateDecisionId,
  listDecisions,
  supersessionIndex,
} from "../../foundations/f-graph-search/decisions.js";
import { persistMindPlanMap } from "../../foundations/f-view-projection/view.js";

/** Persist recomputed states. Returns each node's live path plus any mirror twin re-synced. */
export function syncNodes(nodes: MindPlanNode[]): string[] {
  const paths: string[] = [];
  for (const n of nodes) {
    const twin = patchFrontmatter(n);
    paths.push(territoryPath(n), ...(twin ? [twin] : []));
  }
  return paths;
}

/**
 * Accept empty payloads (empty files) and standard or unpadded base64.
 * Node's Buffer.from does not throw on invalid input, so charset/shape are checked here.
 */
function isBase64Payload(value: string): boolean {
  if (value.length === 0) return true;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(
    value
  );
}

function assertAttachmentBasename(filename: string, raw: string): void {
  if (
    !filename ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename === "." ||
    filename === ".." ||
    path.basename(filename) !== filename
  ) {
    throw blocked(`invalid attachment filename "${raw}".`);
  }
}

/** Project-relative path of the auto-persisted Mermaid snapshot. */
export const MAP_REL = "mindplan/map.md";

/** Repo-relative path of a node's live or evolution territory MDX. */
export function territoryPath(
  node: Pick<MindPlanNode, "id" | "type">,
  slot: TerritorySlot = "current"
): string {
  return markdownRelativePath(node, slot);
}

/** Deduplicate changed paths (null: nothing written), optionally appending the map snapshot. */
export function changedFiles(paths: (string | null)[], includeMap = false): string[] {
  const out = [...new Set(paths.filter((p): p is string => Boolean(p)))];
  if (includeMap && !out.includes(MAP_REL)) out.push(MAP_REL);
  return out;
}

/**
 * Paths touched when discarding or promoting a next slot.
 * When `includeCopiedAttachments` is true (promote), also lists
 * `attachments/<file>` targets for each non-.gitkeep next-attachment file.
 */
export function nextSlotFsChangedFiles(
  node: Pick<MindPlanNode, "id" | "type">,
  opts: { includeCopiedAttachments: boolean }
): string[] {
  const rel = entityRelativePath(node);
  const nextAttRel = `${rel}/${NEXT_ATTACHMENTS_DIR}`;
  const attRel = `${rel}/${ATTACHMENTS_DIR}`;
  const files = [markdownRelativePath(node, "next"), nextAttRel];
  const abs = nextAttachmentsDir(node);
  if (fs.existsSync(abs)) {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      files.push(`${nextAttRel}/${entry.name}`);
      if (opts.includeCopiedAttachments && entry.name !== ".gitkeep") {
        files.push(`${attRel}/${entry.name}`);
      }
    }
  }
  return files;
}

/**
 * Reload territory after a successful mutation: refresh `mindplan/map.md`, and sync the search
 * cache (outside mindplan/, so never in changed_files) with the embeddings of what changed
 * computed in the background.
 */
export function refreshPersistedMap(): void {
  const graph = loadGraph();
  persistMindPlanMap(graph);
  refreshSearchIndex(graph, projectRoot(), territoryBodyReader());
}

/**
 * Re-anchor payload for successful graph mutations: active-slot record + 1-hop
 * neighborhood so agents need not call find_related_nodes after every write.
 */
export function buildMutationAnchor(
  graph: MindPlanGraph,
  nodeId: string
): {
  anchor: {
    record: Record<string, unknown>;
    neighborhood: ReturnType<typeof findRelatedNodes>;
    next: Record<string, unknown> | null;
  };
} {
  const node = findNode(graph, nodeId);
  const neighborhood = findRelatedNodes(graph, {
    query: "",
    node_id: nodeId,
    limit: DEFAULT_FIND_LIMIT,
  });
  return {
    anchor: {
      record: nodeToRecord(node),
      neighborhood,
      next: node.next
        ? {
            state: node.next.state,
            title: node.next.title,
            description: node.next.description,
            updated_at: node.next.updated_at,
            ...(node.next.belongs_to?.length ? { belongs_to: node.next.belongs_to } : {}),
            ...(node.next.depends_on?.length ? { depends_on: node.next.depends_on } : {}),
            ...(node.next.exposes?.length ? { exposes: node.next.exposes } : {}),
            ...(node.next.leads_to?.length ? { leads_to: node.next.leads_to } : {}),
            ...(node.next.implements?.length ? { implements: node.next.implements } : {}),
            ...(node.next.role ? { role: node.next.role } : {}),
          }
        : null,
    },
  };
}

/**
 * Default write tail: the touched node's state and next_state. Neighborhood and
 * record come only with `verbose: true` (`buildMutationAnchor`).
 */
export function mutationTail(
  graph: MindPlanGraph,
  nodeId: string,
  verbose?: boolean
): Record<string, unknown> {
  const node = findNode(graph, nodeId);
  const tail: Record<string, unknown> = {
    state: node.state,
    next_state: node.next?.state ?? null,
  };
  return verbose ? { ...tail, ...buildMutationAnchor(graph, nodeId) } : tail;
}

/** What a readiness reset reports: the slot that left `ready`. */
export type ReadinessReset = {
  slot: TerritorySlot;
  from: "ready";
  to: "draft";
  note: string;
};

const READINESS_NOTE =
  "This revision was ready; a contract write sent it back to draft. Review the contract and self-ready it again.";

/**
 * Report a readiness reset the store made during a contract write (`demoteReadySlot`).
 * A ready → draft move never changes a Journey state, so only the map is refreshed.
 */
function readinessResult(
  node: Pick<MindPlanNode, "id" | "type">,
  slot: TerritorySlot,
  demoted: boolean
): { reset: ReadinessReset | null; files: string[] } {
  if (!demoted) return { reset: null, files: [] };
  refreshPersistedMap();
  return {
    reset: { slot, from: "ready", to: "draft", note: READINESS_NOTE },
    files: [territoryPath(node, slot)],
  };
}

function readinessFields(reset: ReadinessReset | null): Record<string, unknown> {
  return reset ? { readiness_reset: reset } : {};
}

/**
 * Label a neighbor of `change` (live `change` scalar + mirror twin). Returns the result fields
 * (`neighbor_of`, `replaced_change`) and the files written.
 */
function labelNeighbor(
  node: MindPlanNode,
  change: string
): { fields: Record<string, unknown>; files: string[] } {
  const label = writeNeighborLabel(node, change);
  return {
    fields: {
      ...(change ? { neighbor_of: change } : {}),
      ...(label.replaced ? { replaced_change: label.replaced } : {}),
    },
    files: label.twin ? [territoryPath(node), label.twin] : [],
  };
}

/**
 * A change with no open revisions left has no neighbors either: clear each of these changes'
 * labels from every neighbor in `graph` (each twin re-synced). Returns the cleared node ids and
 * the files.
 */
function clearOrphanedNeighbors(
  graph: MindPlanGraph,
  changes: string[]
): { cleared: string[]; files: string[] } {
  const cleared: string[] = [];
  const files: string[] = [];
  for (const change of new Set(changes)) {
    if (changeMembers(graph, change).length > 0) continue;
    for (const neighbor of changeNeighbors(graph, change)) {
      files.push(...labelNeighbor(neighbor, "").files);
      cleared.push(neighbor.id);
    }
  }
  return { cleared, files };
}

/**
 * Run a write that can end change memberships (a status move, a discard, a change id moved or
 * cleared), then clear the neighbor labels of every change that had an open revision before the
 * write and has none after. Every such write goes through here, so a new write path cannot forget
 * the cleanup, and a neighbor-only change (no revisions before either) keeps its labels. The
 * cleanup also runs when the write throws part-way (a batch keeps its earlier transitions); the
 * result then carries nothing, as before.
 */
function withNeighborCleanup(write: () => Record<string, unknown>): Record<string, unknown> {
  const before = changesWithRevisions(loadGraph());
  let result: Record<string, unknown> | undefined;
  try {
    result = write();
  } finally {
    if (before.size > 0) {
      const graph = loadGraph();
      const after = changesWithRevisions(graph);
      const closed = [...before].filter((c) => !after.has(c));
      const orphaned = closed.length ? clearOrphanedNeighbors(graph, closed) : { cleared: [], files: [] };
      if (result && orphaned.cleared.length > 0) {
        const prior = (result.cleared_neighbors as string[] | undefined) ?? [];
        const files = (result.changed_files as string[] | undefined) ?? [];
        result = {
          ...result,
          cleared_neighbors: [...new Set([...prior, ...orphaned.cleared])],
          changed_files: [...new Set([...files, ...orphaned.files])],
        };
      }
    }
  }
  return result!;
}

function clearedFields(cleared: string[]): Record<string, unknown> {
  return cleared.length ? { cleared_neighbors: cleared } : {};
}

export function createNode(args: {
  verbose?: boolean;
  id: string;
  type: NodeType;
  title: string;
  description: string;
  role?: FoundationRole;
  change?: string;
  change_ref?: string;
}): Record<string, unknown> {
  const { id, type, title, description } = args;
  // Validate config before writing territory.
  loadProjectConfig();
  if (nodeExists(id)) {
    throw blocked(`node "${id}" already exists.`);
  }
  let role: FoundationRole | undefined;
  let desc = description;
  if (type === "Foundation") {
    if (!args.role || !isFoundationRole(args.role)) {
      throw blocked(
        `create_node Foundation requires role: assembler | infra | design-system | adapter.`
      );
    }
    role = args.role;
    const tag =
      role === "assembler"
        ? "Assembler"
        : role === "design-system"
          ? "Design system"
          : role === "adapter"
            ? "Adapter"
            : "Infra";
    if (!new RegExp(`^${tag}\\b`, "i").test(desc)) {
      desc = `${tag} — ${desc}`;
    }
  } else if (args.role !== undefined) {
    throw blocked(`role is only valid when creating a Foundation (got ${type}).`);
  }
  if ((args.change !== undefined || args.change_ref !== undefined) && !isPipelineNodeType(type)) {
    throw blocked(`change applies to Foundations, Interactions, and Interfaces (got ${type}).`);
  }
  validateChangeInput(args);
  const now = new Date().toISOString();
  const node: MindPlanNode = {
    id,
    type,
    title,
    description: desc,
    state: initialStateForType(type),
    created_at: now,
    updated_at: now,
    ...(role ? { role } : {}),
  };
  ensureDirectories();
  scaffoldEntity(node, { title, description: desc });
  writeChangeFrontmatter(node, { change: args.change, change_ref: args.change_ref });
  const rel = entityRelativePath(node);
  const current = territoryPath(node, "current");
  const attachments = `${rel}/${ATTACHMENTS_DIR}`;
  refreshPersistedMap();
  const files = [current, `${attachments}/.gitkeep`];
  const graph = loadGraph();
  return {
    created: node,
    folder: rel,
    current,
    context: current,
    attachments,
    changed_files: changedFiles(files, true),
    ...mutationTail(graph, id, args.verbose),
  };
}

/**
 * Checks an in-place claim write on a shipped node with no open next and returns the new entries.
 * Additive only: every old entry stays verbatim or under a new non-glob directory entry, and each
 * new entry is an exact file in a folder the node dominates or `F/` for a dominated folder F. A
 * migration or schema file (config `decisions.schema_files`) is never added in place: claiming one
 * is decision-worthy, and only a revision reaches the decision gate.
 */
function assertAdditiveInPlace(
  graph: MindPlanGraph,
  node: MindPlanNode,
  normalized: string[]
): string[] {
  const root = projectRoot();
  const needsRevision =
    "Removing, moving, globbing, or claiming outside a dominated folder needs a revision: call open_next first.";
  const old = normalizeClaimList(node.implements ?? []);
  for (const e of old) {
    if (!claimListKeeps(normalized, e)) {
      throw blocked(
        `shipped "${node.id}" can only add claims in place; the new list drops "${e}". ${needsRevision}`
      );
    }
  }
  const added = normalized.filter((e) => !old.includes(e));
  const schema = schemaClaimEntries(
    added.filter((e) => !isGlobClaim(e)),
    decisionGateSettings(loadProjectConfig(root)).schema_files,
    root
  );
  if (schema.length > 0) {
    throw blocked(
      `shipped "${node.id}" cannot claim ${schema.map((e) => `"${e}"`).join(", ")} in place: a migration or schema file ` +
        `(config decisions.schema_files) is decision-worthy and needs a revision, so the decision gate sees it: call open_next first.`
    );
  }
  // The other nodes' claims, collected once for every added entry.
  let others: OtherClaims | undefined;
  for (const e of added) {
    if (isGlobClaim(e)) {
      throw blocked(`shipped "${node.id}" cannot add the glob "${e}" in place. ${needsRevision}`);
    }
    let folder: string;
    if (e.endsWith("/")) {
      folder = e.slice(0, -1);
    } else {
      const abs = path.join(root, ...e.split("/"));
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
        throw blocked(
          `shipped "${node.id}" can only add an exact file or "<folder>/" in place; "${e}" is a directory (end it in "/"). ${needsRevision}`
        );
      }
      folder = path.posix.dirname(e);
    }
    others ??= collectOtherClaims(graph, node.id, root);
    if (!isDominatedFolder(graph, node.id, folder, root, [e], others)) {
      throw blocked(
        `shipped "${node.id}" cannot claim "${e}" in place: "${folder}/" is not a folder it dominates ` +
          `(it must already claim a file directly in it, and no other node may claim anything under it). ${needsRevision}`
      );
    }
  }
  return added;
}

type SetImplementationArgs = {
  verbose?: boolean;
  node_id: string;
  files: string[];
  slot?: TerritorySlot;
  change?: string;
};

/**
 * Replace the implements list for a pipeline node on the appropriate slot.
 * A shipped node with no open next writes its live slot in place, additive only.
 */
export function setImplementationFiles(args: SetImplementationArgs): Record<string, unknown> {
  // A change id moved off a revision may leave its old change with no revisions.
  return args.change === undefined
    ? writeImplementationFiles(args)
    : withNeighborCleanup(() => writeImplementationFiles(args));
}

function writeImplementationFiles(args: SetImplementationArgs): Record<string, unknown> {
  loadProjectConfig();
  validateChangeInput({ change: args.change });
  const graph = loadGraph();
  const node = findNode(graph, args.node_id);
  if (!isPipelineNodeType(node.type)) {
    throw blocked(
      `set_implementation_files only applies to Interaction, Interface, and Foundation; "${node.id}" is a ${node.type}.`
    );
  }
  if (args.change !== undefined && isInactiveNode(node)) {
    throw blocked(`"${node.id}" is ${node.state}; a retired node takes no change id.`);
  }

  const normalized = normalizeClaimList(args.files);
  const retired = node.state === "cancelled" || node.state === "deprecated";
  let slot: TerritorySlot;
  // A shipped node with no open next may only grow its live claims in a folder it dominates.
  let inPlace = false;

  if (args.slot) {
    slot = args.slot;
    if (slot === "next" && !node.next) {
      throw blocked(`cannot set implements on next: "${node.id}" has no open evolution.`);
    }
    if (slot === "current" && isProductionState(node.state) && !retired) {
      if (node.next) {
        throw blocked(
          `shipped "${node.id}" can only change implements on an open next slot. Call open_next first.`
        );
      }
      inPlace = true;
    }
  } else if (retired) {
    slot = "current";
  } else if (isProductionState(node.state)) {
    if (node.next) {
      slot = "next";
    } else {
      slot = "current";
      inPlace = true;
    }
  } else {
    slot = "current";
  }

  const addedInPlace = inPlace ? assertAdditiveInPlace(graph, node, normalized) : [];

  if (retired) {
    if (slot !== "current") {
      throw blocked(`retired "${node.id}" can only shrink implements on current.`);
    }
    const prevFiles = new Set(expandClaims(node.implements));
    for (const f of expandClaims(normalized)) {
      if (!prevFiles.has(f)) {
        throw blocked(
          `retired "${node.id}" may only shrink implements (cannot add "${f}").`
        );
      }
    }
    for (const e of normalized) {
      const covered = (node.implements ?? []).some(
        (p) => p === e || (!isGlobClaim(e) && claimCoversPath(p, e))
      );
      if (!covered) {
        throw blocked(
          `retired "${node.id}" may only shrink implements (cannot add entry "${e}").`
        );
      }
    }
  }

  const buckets = buildOwnershipIndex(graph);
  for (const f of expandClaims(normalized)) {
    const other = exclusiveOwner(buckets, f);
    if (other && other !== node.id) {
      throw blocked(`implements conflict: "${f}" is already claimed by "${other}".`);
    }
  }

  const claimWrite = writeImplementsFrontmatter(node, normalized, slot, addedInPlace);
  refreshPersistedMap();
  const pathWritten = territoryPath(node, slot);
  const readiness = readinessResult(node, slot, claimWrite.readinessReset);
  // Scan the claimed files now, so a missing edge is reported with the exact call that fixes it.
  const claimedGraph = loadGraph();
  const claimedNode = findNode(claimedGraph, node.id);
  const importViolations = findImportViolationsForClaim(
    claimedGraph,
    projectRoot(),
    claimedNode,
    normalized
  ).map((v) => ({
    file: v.file,
    imports: v.imports,
    ...(v.fix ? { fix: v.fix } : { not_allowed: v.not_allowed }),
  }));
  const folderClaims = folderClaimSuggestions(claimedGraph, node.id, normalized, projectRoot());
  // A shipped node with no open next is edited in place: change labels it a neighbor.
  // Otherwise change is the written slot's change id.
  let changeWrite: { fields: Record<string, unknown>; files: string[] } = { fields: {}, files: [] };
  if (args.change !== undefined) {
    if (isNeighborNode(node)) {
      changeWrite = labelNeighbor(node, args.change);
    } else {
      // On the next slot the store also drops a live label the revision's change moved off.
      const replaced = writeChangeFrontmatter(node, { change: args.change }, slot);
      if (replaced) {
        changeWrite = { fields: { replaced_change: replaced }, files: [territoryPath(node, "current")] };
      }
    }
  }
  return {
    node_id: node.id,
    slot,
    implements: normalized,
    ...changeWrite.fields,
    ...(inPlace ? { added_in_place: addedInPlace } : {}),
    ...(addedInPlace.length
      ? {
          hint:
            `Claimed in place without a revision. Name each new path in "${node.id}"'s body ` +
            `with patch_node_territory; run_check warns until it does.`,
        }
      : {}),
    ...(folderClaims.length ? { folder_claims: folderClaims } : {}),
    ...(importViolations.length ? { import_violations: importViolations } : {}),
    ...readinessFields(readiness.reset),
    changed_files: changedFiles(
      [pathWritten, claimWrite.twin, ...readiness.files, ...changeWrite.files],
      true
    ),
    ...mutationTail(loadGraph(), node.id, args.verbose),
  };
}

type SetTestFilesArgs = {
  verbose?: boolean;
  node_id: string;
  files: string[];
  change?: string;
};

/**
 * Replace a node's linked test files. Evidence, not contract: the same list goes to live and an
 * open next, a shipped node needs no `open_next`, and readiness is never reset.
 */
export function setTestFiles(args: SetTestFilesArgs): Record<string, unknown> {
  // A change id moved off a revision may leave its old change with no revisions.
  return args.change === undefined
    ? writeTestFiles(args)
    : withNeighborCleanup(() => writeTestFiles(args));
}

function writeTestFiles(args: SetTestFilesArgs): Record<string, unknown> {
  validateChangeInput({ change: args.change });
  const graph = loadGraph();
  const node = findNode(graph, args.node_id);
  const testsWrite = writeTestsFrontmatter(node, args.files);
  // A shipped node with no open next is edited in place: change labels it a neighbor.
  // Otherwise change is the active slot's change id.
  let changeWrite: { fields: Record<string, unknown>; files: string[] } = { fields: {}, files: [] };
  if (args.change !== undefined) {
    if (isNeighborNode(node)) {
      changeWrite = labelNeighbor(node, args.change);
    } else {
      const slot: TerritorySlot = node.next ? "next" : "current";
      const replaced = writeChangeFrontmatter(node, { change: args.change }, slot);
      changeWrite = {
        fields: replaced ? { replaced_change: replaced } : {},
        files: [territoryPath(node, slot), ...(replaced ? [territoryPath(node, "current")] : [])],
      };
    }
  }
  return {
    node_id: node.id,
    tests: node.tests ?? [],
    ...changeWrite.fields,
    changed_files: changedFiles([...testsWrite.paths, ...changeWrite.files]),
    ...mutationTail(loadGraph(), node.id, args.verbose),
  };
}

export function linkNodes(args: {
  verbose?: boolean;
  source_id: string;
  target_id: string;
  edge_type: (typeof EDGE_TYPES)[number];
}): Record<string, unknown> {
  const { source_id, target_id, edge_type } = args;
  const graph = loadGraph();
  const source = findNode(graph, source_id);
  const target = findNode(graph, target_id);
  validateLink(source, target, edge_type);

  if (edge_type === "depends_on") {
    assertAcyclicDependsOn(graph, source_id, target_id);
  }

  const writeSlot = edgeWriteSlot(source, edge_type);
  const existingOnSlot =
    writeSlot === "next" && source.next
      ? edge_type === "belongs_to"
        ? (source.next.belongs_to ?? []).includes(target_id)
        : edge_type === "depends_on"
          ? (source.next.depends_on ?? []).includes(target_id)
          : edge_type === "exposes"
            ? (source.next.exposes ?? []).includes(target_id)
            : edge_type === "leads_to"
              ? (source.next.leads_to ?? []).includes(target_id)
              : edge_type === "mounts"
                ? (source.next.mounts ?? []).includes(target_id)
                : false
      : graph.edges.some(
          (e) => e.source === source_id && e.target === target_id && e.type === edge_type
        );

  if (existingOnSlot) {
    throw blocked(`edge ${source_id} -${edge_type}-> ${target_id} already exists.`);
  }

  if (writeSlot === "current") {
    graph.edges.push({ source: source_id, target: target_id, type: edge_type });
  } else if (source.next) {
    if (edge_type === "belongs_to") {
      source.next.belongs_to = [...(source.next.belongs_to ?? []), target_id];
    } else if (edge_type === "depends_on") {
      source.next.depends_on = [...(source.next.depends_on ?? []), target_id];
    } else if (edge_type === "exposes") {
      source.next.exposes = [...(source.next.exposes ?? []), target_id];
    } else if (edge_type === "leads_to") {
      source.next.leads_to = [...(source.next.leads_to ?? []), target_id];
    } else if (edge_type === "mounts") {
      source.next.mounts = [...(source.next.mounts ?? []), target_id];
    }
  }
  const edgeWrite = addEdgeToFrontmatter(source, edge_type, target_id);

  const changedJourneys = recomputeJourneyStates(graph);
  const changedStability = recomputeStability(graph);
  const synced = syncNodes([...changedJourneys, ...changedStability]);
  refreshPersistedMap();
  const readiness = readinessResult(source, writeSlot, edgeWrite.readinessReset);
  const files = [territoryPath(source, writeSlot), edgeWrite.twin, ...synced, ...readiness.files];
  return {
    linked: { source: source_id, target: target_id, type: edge_type },
    slot: writeSlot,
    journeys_recomputed: changedJourneys.map((j) => ({ id: j.id, state: j.state })),
    stability_recomputed: changedStability.map((n) => ({ id: n.id, state: n.state })),
    ...readinessFields(readiness.reset),
    changed_files: changedFiles(files, true),
    ...mutationTail(loadGraph(), source_id, args.verbose),
  };
}

export function unlinkNodes(args: {
  verbose?: boolean;
  source_id: string;
  target_id: string;
}): Record<string, unknown> {
  const { source_id, target_id } = args;
  const graph = loadGraph();
  const source = findNode(graph, source_id);
  findNode(graph, target_id);
  const before = graph.edges.length;
  graph.edges = graph.edges.filter(
    (e) => !(e.source === source_id && e.target === target_id)
  );
  let removed = before - graph.edges.length;

  if (source.next) {
    const nextBelongs = source.next.belongs_to ?? [];
    const nextDepends = source.next.depends_on ?? [];
    const nextExposes = source.next.exposes ?? [];
    const nextLeadsTo = source.next.leads_to ?? [];
    const nextMounts = source.next.mounts ?? [];
    if (
      nextBelongs.includes(target_id) ||
      nextDepends.includes(target_id) ||
      nextExposes.includes(target_id) ||
      nextLeadsTo.includes(target_id) ||
      nextMounts.includes(target_id)
    ) {
      source.next.belongs_to = nextBelongs.filter((id) => id !== target_id);
      source.next.depends_on = nextDepends.filter((id) => id !== target_id);
      source.next.exposes = nextExposes.filter((id) => id !== target_id);
      source.next.leads_to = nextLeadsTo.filter((id) => id !== target_id);
      source.next.mounts = nextMounts.filter((id) => id !== target_id);
      if (source.next.belongs_to.length === 0) delete source.next.belongs_to;
      if (source.next.depends_on?.length === 0) delete source.next.depends_on;
      if (source.next.exposes?.length === 0) delete source.next.exposes;
      if (source.next.leads_to?.length === 0) delete source.next.leads_to;
      if (source.next.mounts?.length === 0) delete source.next.mounts;
      removed += 1;
    }
  }

  if (removed === 0) {
    throw blocked(`no edge exists between "${source_id}" and "${target_id}".`);
  }
  const edgeWrite = removeEdgesFromFrontmatter(source, target_id);
  const changedJourneys = recomputeJourneyStates(graph);
  const changedStability = recomputeStability(graph);
  const synced = syncNodes([...changedJourneys, ...changedStability]);
  refreshPersistedMap();
  const sourceFiles = [territoryPath(source, "current"), edgeWrite.twin];
  if (source.next) sourceFiles.push(territoryPath(source, "next"));
  const readiness = readinessResult(source, source.next ? "next" : "current", edgeWrite.readinessReset);
  const files = [...sourceFiles, ...synced, ...readiness.files];
  return {
    removed,
    journeys_recomputed: changedJourneys.map((j) => ({ id: j.id, state: j.state })),
    stability_recomputed: changedStability.map((n) => ({ id: n.id, state: n.state })),
    ...readinessFields(readiness.reset),
    changed_files: changedFiles(files, true),
    ...mutationTail(loadGraph(), source_id, args.verbose),
  };
}

const STATUS_TIER: Record<string, number> = {
  Foundation: 0,
  Interaction: 1,
  Interface: 2,
  Bug: 3,
};

type StatusRevision = { node_id: string; new_status: string };

/** Which nodes a scoped status call walks. */
export const STATUS_SCOPES = ["all_open_updates", "node_and_dependents", "change"] as const;
export type StatusScope = (typeof STATUS_SCOPES)[number];

/** Forward build pipeline a scoped call walks each node through. */
const WALK_PIPELINE = ["draft", "ready", "in-progress", "in-review", "ship"] as const;

type StatusArgs = {
  node_id?: string;
  new_status?: string;
  revisions?: StatusRevision[];
  scope?: StatusScope;
  /** Change id walked by `scope: "change"`. */
  change?: string;
  /** Let a scoped walk to `ship` move nodes that have not reached in-review. Reported in the result. */
  skip_review?: boolean;
  dry_run?: boolean;
  verbose?: boolean;
};

type StatusMode = "single" | "batch" | "scope";

function normalizeStatusArgs(args: StatusArgs): { mode: StatusMode; items: StatusRevision[] } {
  const list = args.revisions;
  const hasList = Array.isArray(list) && list.length > 0;
  const hasSingle = args.node_id !== undefined || args.new_status !== undefined;
  if (args.scope !== undefined) {
    if (hasList) {
      throw blocked("update_node_status accepts either scope or revisions, not both.");
    }
    if (!(STATUS_SCOPES as readonly string[]).includes(args.scope)) {
      throw blocked(`scope must be one of: ${STATUS_SCOPES.join(", ")}.`);
    }
    if (!args.new_status || !(WALK_PIPELINE as readonly string[]).includes(args.new_status)) {
      throw blocked(
        `scope walks nodes forward to a target: new_status must be one of ${WALK_PIPELINE.join(", ")}.`
      );
    }
    if (args.scope === "node_and_dependents" && !args.node_id) {
      throw blocked('scope "node_and_dependents" requires node_id (the node whose open dependents walk with it).');
    }
    if (args.scope === "all_open_updates" && args.node_id) {
      throw blocked('scope "all_open_updates" takes no node_id; use "node_and_dependents" for one node.');
    }
    if (args.scope === "change") {
      if (!args.change) {
        throw blocked('scope "change" requires change (the change id whose revisions walk together).');
      }
      if (args.node_id) {
        throw blocked('scope "change" takes no node_id; the change names its revisions.');
      }
    } else if (args.change !== undefined) {
      throw blocked('change is only used with scope "change".');
    }
    return { mode: "scope", items: [] };
  }
  if (args.change !== undefined) {
    throw blocked('change is only used with scope "change".');
  }
  if (args.skip_review === true) {
    throw blocked("skip_review only applies to a scoped walk to ship.");
  }
  if (hasList && hasSingle) {
    throw blocked(
      "update_node_status accepts either node_id + new_status, or revisions, not both."
    );
  }
  if (hasList) {
    const ids = new Set<string>();
    for (const item of list!) {
      if (!item?.node_id || !item?.new_status) {
        throw blocked("each revision needs node_id and new_status.");
      }
      if (ids.has(item.node_id)) {
        throw blocked(`duplicate node_id "${item.node_id}" in revisions.`);
      }
      ids.add(item.node_id);
    }
    return { mode: "batch", items: list! };
  }
  if (!args.node_id || args.new_status === undefined || args.new_status === "") {
    throw blocked(
      "update_node_status requires node_id and new_status, a non-empty revisions list, or a scope with new_status."
    );
  }
  return {
    mode: "single",
    items: [{ node_id: args.node_id, new_status: args.new_status }],
  };
}

function orderStatusRevisions(items: StatusRevision[]): StatusRevision[] {
  const graph = loadGraph();
  return items
    .map((item, index) => {
      const node = findNode(graph, item.node_id);
      if (node.type === "Journey") {
        throw blocked(
          "Journey states are computed automatically from their Interactions and cannot be set manually."
        );
      }
      return { item, index, tier: STATUS_TIER[node.type] ?? 99 };
    })
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map((row) => row.item);
}

/** Active-slot state of a pipeline node: next while evolving, else live. */
function activeState(node: MindPlanNode): string {
  return node.next ? node.next.state : node.state;
}

/**
 * A shipped node with an open next, or a pre-ship node that is being built (in-progress or
 * in-review). A draft or ready node is a plan for later work, not an update: `all_open_updates`
 * never walks it. `node_and_dependents` names its seed on purpose, so with `includePlanned`
 * the seed's dependents may be walked from draft or ready too.
 */
function isOpenUpdate(node: MindPlanNode, includePlanned = false): boolean {
  if (!isPipelineNodeType(node.type)) return false;
  if (node.next) return true;
  if (node.shipped_at) return false;
  if (node.state === "in-progress" || node.state === "in-review") return true;
  return includePlanned && (node.state === "draft" || node.state === "ready");
}

/** Nodes a scoped call walks, in the order they must move (Foundations, Interactions, Interfaces). */
function selectScopedNodes(graph: MindPlanGraph, args: StatusArgs): MindPlanNode[] {
  let selected: MindPlanNode[];
  if (args.scope === "all_open_updates") {
    selected = graph.nodes.filter((n) => isOpenUpdate(n));
  } else if (args.scope === "change") {
    // Revisions only: neighbors have nothing to transition (a walk to ship clears their labels).
    selected = changeMembers(graph, args.change!);
    if (selected.length === 0 && changeNeighbors(graph, args.change!).length === 0) {
      throw blocked(
        `change "${args.change}" has no members. Set it with open_next, create_node, or patch_node_territory (change).`
      );
    }
  } else {
    const seed = findNode(graph, args.node_id!);
    const ids = new Set<string>([seed.id]);
    const queue = [seed.id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of graph.edges) {
        const hit =
          (edge.type === "depends_on" && edge.target === current) ||
          (edge.type === "exposes" && edge.target === current);
        if (hit && !ids.has(edge.source)) {
          ids.add(edge.source);
          queue.push(edge.source);
        }
      }
      // Edges proposed on an open next slot count too: that node ships with the new edge.
      for (const other of graph.nodes) {
        if (ids.has(other.id) || !other.next) continue;
        if (
          (other.next.depends_on ?? []).includes(current) ||
          (other.next.exposes ?? []).includes(current)
        ) {
          ids.add(other.id);
          queue.push(other.id);
        }
      }
    }
    selected = graph.nodes.filter((n) => ids.has(n.id) && isOpenUpdate(n, true));
  }
  return orderForWalk(graph, selected);
}

/** Tier order (Foundation, Interaction, Interface), then dependency order within a tier. */
function orderForWalk(graph: MindPlanGraph, nodes: MindPlanNode[]): MindPlanNode[] {
  const inSet = new Set(nodes.map((n) => n.id));
  const done = new Set<string>();
  const out: MindPlanNode[] = [];
  const pending = [...nodes].sort(
    (a, b) =>
      (STATUS_TIER[a.type] ?? 99) - (STATUS_TIER[b.type] ?? 99) || a.id.localeCompare(b.id)
  );
  while (pending.length > 0) {
    const index = pending.findIndex((n) =>
      graph.edges.every(
        (e) =>
          !(e.source === n.id && e.type === "depends_on") ||
          !inSet.has(e.target) ||
          done.has(e.target)
      )
    );
    const [next] = pending.splice(index < 0 ? 0 : index, 1);
    done.add(next.id);
    out.push(next);
  }
  return out;
}

type WalkPlan = { node_id: string; steps: string[] };

/** Steps from a node's active state forward to the target; empty when already there or past. */
function stepsToTarget(node: MindPlanNode, target: string): string[] {
  const from = (WALK_PIPELINE as readonly string[]).indexOf(activeState(node));
  const to = (WALK_PIPELINE as readonly string[]).indexOf(target);
  if (from < 0 || to < 0 || from >= to) return [];
  return WALK_PIPELINE.slice(from + 1, to + 1);
}

/** Replace a node's outgoing edges in the in-memory graph with its current edge fields. */
function rebuildOutgoingEdges(graph: MindPlanGraph, node: MindPlanNode): void {
  graph.edges = graph.edges.filter((e) => e.source !== node.id);
  for (const type of ["belongs_to", "depends_on", "exposes", "leads_to", "mounts", "affects"] as const) {
    for (const target of node[type] ?? []) graph.edges.push({ source: node.id, target, type });
  }
}

/**
 * The in-memory effect of promoting next over live, field for field as promoteNextSlot writes it
 * (contract scalars, edges, claims, role, decisions; the change id is dropped), so a validated walk
 * sees at every later step what the real walk will see.
 */
function promoteInMemory(
  graph: MindPlanGraph,
  node: MindPlanNode,
  state: MindPlanNode["state"],
  shippedAt: string
): void {
  const next = node.next;
  if (!next) return;
  node.title = next.title;
  node.description = next.description;
  node.state = state;
  node.shipped_at = shippedAt;
  node.updated_at = shippedAt;
  const assign = <K extends "belongs_to" | "depends_on" | "exposes" | "leads_to" | "mounts" | "implements">(
    key: K
  ) => {
    const value = next[key];
    if (value && value.length > 0) node[key] = [...value];
    else delete node[key];
  };
  for (const key of ["belongs_to", "depends_on", "exposes", "leads_to", "mounts", "implements"] as const) {
    assign(key);
  }
  if (next.decisions?.length) node.decisions = [...next.decisions];
  else delete node.decisions;
  if (next.role) node.role = next.role;
  delete node.change;
  delete node.change_ref;
  delete node.next;
  rebuildOutgoingEdges(graph, node);
}

/**
 * Validates every step of a plan in memory against a loaded graph, writing nothing.
 * Returns the first Blocked reason (naming the node and step), or null.
 */
function simulateWalk(
  plan: WalkPlan[],
  decisionCtx: DecisionContext = createDecisionContext(projectRoot())
): { blocked: string | null; warnings: string[] } {
  const graph = loadGraph();
  const root = projectRoot();
  const now = new Date().toISOString();
  const warnings = new Set<string>();
  for (const row of plan) {
    const node = findNode(graph, row.node_id);
    for (const step of row.steps) {
      try {
        const resolved = resolveStatusChange(graph, node, step);
        if (step === "in-review" || step === "ship") {
          assertCheckCleanForNode(graph, root, node, step);
          if (step === "in-review") assertDecisionForReview(graph, root, node, decisionCtx);
          for (const w of staleTextWarnings(graph, root, node)) warnings.add(w);
        }
        if (resolved.promote_next) {
          promoteInMemory(graph, node, resolved.state, now);
        } else if (resolved.ship) {
          node.state = resolved.state;
          node.shipped_at = now;
        } else if (node.next && isNextPipelineState(resolved.state)) {
          node.next.state = resolved.state;
        } else {
          node.state = resolved.state;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const reason = message.replace(/^Blocked:\s*/, "");
        return { blocked: `Blocked: ${reason} (at "${row.node_id}" -> ${step})`, warnings: [...warnings] };
      }
    }
  }
  return { blocked: null, warnings: [...warnings] };
}

/** Every transition a plan makes, one `id: from -> to` line per step. */
function describePlan(plan: WalkPlan[], graph: MindPlanGraph): string[] {
  const lines: string[] = [];
  for (const row of plan) {
    let from = activeState(findNode(graph, row.node_id));
    for (const step of row.steps) {
      lines.push(`${row.node_id}: ${from} -> ${step}`);
      from = step;
    }
  }
  return lines;
}

/** Nodes a walk would take to ship without stopping at in-review first. */
function nodesSkippingReview(plan: WalkPlan[], graph: MindPlanGraph): string[] {
  return plan
    .filter(
      (row) =>
        row.steps[row.steps.length - 1] === "ship" &&
        activeState(findNode(graph, row.node_id)) !== "in-review"
    )
    .map((row) => row.node_id);
}

function skipReviewBlocked(ids: string[]): string {
  return (
    `Blocked: this walk would take ${ids.map((id) => `"${id}"`).join(", ")} to ship without a review stop ` +
    `(not in-review yet). Walk to in-review first and review, or pass skip_review: true to walk through ` +
    `in-progress and in-review in this call; skipped reviews are reported.`
  );
}

const WARNING_CAP = 10;

function capWarnings(warnings: Iterable<string>): string[] {
  const list = [...new Set(warnings)];
  if (list.length <= WARNING_CAP) return list;
  return [...list.slice(0, WARNING_CAP), `... ${list.length - WARNING_CAP} more warning(s); run run_check for all.`];
}

/** One line per node: `id: from -> to`, `to` being the next slot state while evolving. */
function statusLine(row: Record<string, unknown>): string {
  const to = (row.next_state as string | null) ?? String(row.new_state);
  return `${String(row.node_id)}: ${String(row.previous_state)} -> ${to}`;
}

export function updateNodeStatus(args: StatusArgs): Record<string, unknown> {
  // A ship, promotion, or retirement ends a revision's membership; a dry run writes nothing.
  return args.dry_run ? applyStatusUpdate(args) : withNeighborCleanup(() => applyStatusUpdate(args));
}

function applyStatusUpdate(args: StatusArgs): Record<string, unknown> {
  const normalized = normalizeStatusArgs(args);
  const verbose = args.verbose === true;

  if (normalized.mode === "scope") {
    const graph = loadGraph();
    const nodes = selectScopedNodes(graph, args);
    const plan: WalkPlan[] = nodes
      .map((n) => ({ node_id: n.id, steps: stepsToTarget(n, args.new_status!) }))
      .filter((row) => row.steps.length > 0);
    const skipping = nodesSkippingReview(plan, graph);
    const reviewBlock =
      skipping.length > 0 && args.skip_review !== true ? skipReviewBlocked(skipping) : null;
    // One decision context (config + git probe) serves the validation and every step.
    const decisionCtx = createDecisionContext(projectRoot());
    const sim = simulateWalk(plan, decisionCtx);
    const skipped = args.skip_review === true && skipping.length > 0 ? { skipped_review: skipping } : {};
    if (args.dry_run) {
      return {
        dry_run: true,
        scope: args.scope,
        ...(args.scope === "change" ? { change: args.change } : {}),
        plan: describePlan(plan, graph),
        blocked: reviewBlock ?? sim.blocked,
        ...skipped,
        ...(sim.warnings.length ? { warnings: capWarnings(sim.warnings) } : {}),
      };
    }
    if (reviewBlock) {
      throw new Error(`${reviewBlock} Nothing was written.`);
    }
    if (sim.blocked) {
      throw new Error(
        `${sim.blocked}. Nothing was written: the whole walk is validated before the first transition.`
      );
    }
    const lines: string[] = [];
    const changed = new Set<string>();
    const cleared = new Set<string>();
    const warnings = new Set<string>(sim.warnings);
    let last: Record<string, unknown> = {};
    for (const row of plan) {
      let first: Record<string, unknown> | null = null;
      for (const step of row.steps) {
        last = applyOneStatus({ node_id: row.node_id, new_status: step, decisionCtx });
        first = first ?? last;
        for (const f of (last.changed_files as string[] | undefined) ?? []) changed.add(f);
      }
      lines.push(statusLine({ ...last, previous_state: first!.previous_state }));
    }
    // A change walked to ship is done. A change that had revisions is cleaned up by
    // withNeighborCleanup; a neighbor-only change never had one, so close it here.
    if (args.scope === "change" && args.new_status === "ship") {
      const orphaned = clearOrphanedNeighbors(loadGraph(), [args.change!]);
      for (const f of orphaned.files) changed.add(f);
      for (const id of orphaned.cleared) cleared.add(id);
    }
    return {
      ordered: true,
      scope: args.scope,
      ...(args.scope === "change" ? { change: args.change } : {}),
      lines,
      ...skipped,
      ...clearedFields([...cleared]),
      changed_files: [...changed],
      ...(warnings.size ? { warnings: capWarnings(warnings) } : {}),
      ...(verbose
        ? {
            journeys_recomputed: last.journeys_recomputed ?? [],
            stability_recomputed: last.stability_recomputed ?? [],
          }
        : {}),
    };
  }

  if (args.dry_run) {
    const graph = loadGraph();
    const items =
      normalized.mode === "batch" ? orderStatusRevisions(normalized.items) : normalized.items;
    const plan: WalkPlan[] = items.map((i) => ({ node_id: i.node_id, steps: [i.new_status] }));
    const sim = simulateWalk(plan);
    return {
      dry_run: true,
      plan: describePlan(plan, graph),
      blocked: sim.blocked,
      ...(sim.warnings.length ? { warnings: capWarnings(sim.warnings) } : {}),
    };
  }

  if (normalized.mode === "single") {
    return applyOneStatus({ ...normalized.items[0], verbose: args.verbose });
  }

  const ordered = orderStatusRevisions(normalized.items);
  const applied: Record<string, unknown>[] = [];
  const decisionCtx = createDecisionContext(projectRoot());
  for (const rev of ordered) {
    try {
      applied.push(applyOneStatus({ ...rev, decisionCtx }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reason = message.replace(/^Blocked:\s*/, "");
      const appliedSummary = applied
        .map((row) => `${String(row.node_id)} (${String(row.new_state)})`)
        .join(", ");
      throw new Error(
        `Blocked: ${reason} Ordered status stopped on "${rev.node_id}"` +
          (appliedSummary
            ? ` after applying: ${appliedSummary}. Earlier nodes stay transitioned.`
            : " before any node in the revision was transitioned.")
      );
    }
  }
  const changed = new Set<string>();
  const warnings = new Set<string>();
  for (const row of applied) {
    const files = row.changed_files;
    if (Array.isArray(files)) {
      for (const file of files) changed.add(String(file));
    }
    const rowWarnings = row.warnings;
    if (Array.isArray(rowWarnings)) {
      for (const w of rowWarnings) warnings.add(String(w));
    }
  }
  const last = applied[applied.length - 1] ?? {};
  return {
    ordered: true,
    lines: applied.map(statusLine),
    changed_files: [...changed],
    ...(warnings.size ? { warnings: capWarnings(warnings) } : {}),
    ...(verbose
      ? {
          applied,
          stopped_on: null,
          journeys_recomputed: last.journeys_recomputed ?? [],
          stability_recomputed: last.stability_recomputed ?? [],
        }
      : {}),
  };
}

function applyOneStatus(args: {
  verbose?: boolean;
  node_id: string;
  new_status: string;
  /** Shared by the steps of one call so config and the git probe are read once. */
  decisionCtx?: DecisionContext;
}): Record<string, unknown> {
  const { node_id, new_status } = args;
  const graph = loadGraph();
  const node = findNode(graph, node_id);

  const resolved = resolveStatusChange(graph, node, new_status);
  // Moves to in-review and ship run the check's import and ownership rules on this node's files.
  let warnings: string[] = [];
  if (new_status === "in-review" || new_status === "ship") {
    assertCheckCleanForNode(graph, projectRoot(), node, new_status);
    // A decision-worthy revision needs its decision recorded before review.
    if (new_status === "in-review") {
      assertDecisionForReview(graph, projectRoot(), node, args.decisionCtx);
    }
    warnings = staleTextWarnings(graph, projectRoot(), node);
  }

  const previous = node.next ? node.next.state : node.state;
  const now = new Date().toISOString();
  let promoted = false;
  let promoteSlotFiles: string[] = [];
  let removedTwin: string[] = [];
  let syncedTwin: string | null = null;
  let clearedLabel: string | undefined;

  if (resolved.promote_next) {
    promoteSlotFiles = nextSlotFsChangedFiles(node, { includeCopiedAttachments: true });
    promoteNextSlot(node, resolved.state, now);
    promoted = true;
    rebuildOutgoingEdges(graph, node);
  } else if (resolved.ship) {
    // A shipped node is no longer an open revision: its change membership ends here.
    writeChangeFrontmatter(node, {
      change: node.change ? "" : undefined,
      change_ref: node.change_ref ? "" : undefined,
    });
    node.shipped_at = now;
    node.state = resolved.state;
    node.updated_at = now;
    patchFrontmatter(node);
    writeMirrorTwin(node);
  } else if (node.next && isNextPipelineState(resolved.state)) {
    node.next.state = resolved.state;
    node.next.updated_at = now;
    patchFrontmatter(
      {
        id: node.id,
        type: node.type,
        state: resolved.state,
        updated_at: now,
      },
      "next"
    );
  } else {
    const retiring =
      resolved.state === "deprecated" || resolved.state === "cancelled";
    // A retired shipped node is nobody's neighbor: drop its live label.
    if (retiring && node.shipped_at && node.change) {
      clearedLabel = node.change;
      writeChangeFrontmatter(node, { change: "" }, "current");
    }
    node.state = resolved.state;
    node.updated_at = now;
    syncedTwin = patchFrontmatter(node);
    if (retiring && isPipelineNodeType(node.type)) {
      removedTwin = deleteNextSlotFiles(node);
    }
  }

  const changedStability = recomputeStability(graph);
  const changedJourneys = recomputeJourneyStates(graph);
  const synced = syncNodes([...changedStability, ...changedJourneys]);
  refreshPersistedMap();

  const primaryPaths: string[] = [];
  if (promoted) {
    primaryPaths.push(territoryPath(node, "current"));
    primaryPaths.push(territoryPath(node, "next"));
    primaryPaths.push(...promoteSlotFiles);
  } else if (resolved.ship) {
    primaryPaths.push(territoryPath(node, "current"));
    primaryPaths.push(territoryPath(node, "next"));
  } else if (node.next && isNextPipelineState(resolved.state)) {
    primaryPaths.push(territoryPath(node, "next"));
  } else {
    primaryPaths.push(territoryPath(node, "current"));
    if (syncedTwin) primaryPaths.push(syncedTwin);
    primaryPaths.push(...removedTwin);
  }
  const files = [...primaryPaths, ...synced];

  return {
    node_id,
    previous_state: previous,
    new_state: node.state,
    next_state: node.next?.state ?? null,
    shipped_at: node.shipped_at,
    promoted_next: promoted,
    ...(clearedLabel ? { cleared_change: clearedLabel } : {}),
    ...(warnings.length ? { warnings: capWarnings(warnings) } : {}),
    stability_recomputed: changedStability.map((n) => ({ id: n.id, state: n.state })),
    journeys_recomputed: changedJourneys.map((j) => ({ id: j.id, state: j.state })),
    changed_files: changedFiles(files, true),
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}

export function forceUnship(args: {
  verbose?: boolean;
  node_id: string;
  confirm: string;
  new_status?: "draft" | "ready" | "in-progress" | "in-review";
}): Record<string, unknown> {
  const { node_id, confirm, new_status } = args;
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  const target = new_status ?? "ready";
  const previous = node.state;

  resolveForceUnship(graph, node, target, confirm);

  // A pre-ship node's live `change` is a revision's membership: drop the shipped node's neighbor
  // label so the unshipped node is not silently a revision of that change. The in-place claim
  // marker belongs to shipped nodes only.
  const clearedChange = node.change;
  if (clearedChange) writeChangeFrontmatter(node, { change: "" }, "current");
  if (node.added_claims?.length) clearAddedClaims(node);

  const now = new Date().toISOString();
  delete node.shipped_at;
  node.state = target;
  node.updated_at = now;
  patchFrontmatter(node, "current", { clearShippedAt: true });
  const removedTwin = deleteNextSlotFiles(node);

  const changedStability = recomputeStability(graph);
  const changedJourneys = recomputeJourneyStates(graph);
  const synced = syncNodes([...changedStability, ...changedJourneys]);
  refreshPersistedMap();

  const files = [territoryPath(node), ...removedTwin, ...synced];

  return {
    node_id,
    previous_state: previous,
    new_state: node.state,
    shipped_at: null,
    force_unship: true,
    ...(clearedChange ? { cleared_change: clearedChange } : {}),
    stability_recomputed: changedStability.map((n) => ({ id: n.id, state: n.state })),
    journeys_recomputed: changedJourneys.map((j) => ({ id: j.id, state: j.state })),
    changed_files: changedFiles(files, true),
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}

type PatchTerritoryArgs = {
  verbose?: boolean;
  node_id: string;
  title?: string;
  description?: string;
  role?: FoundationRole;
  body?: string;
  toggle_checkboxes?: CheckboxToggle[];
  section?: string;
  text?: string;
  replace?: { find: string; with: string; all?: boolean };
  change?: string;
  change_ref?: string;
  slot?: TerritorySlot;
};

export function patchNodeTerritory(args: PatchTerritoryArgs): Record<string, unknown> {
  // A revision moved off (or cleared from) its change may leave that change with no revisions.
  return args.change === undefined
    ? writeNodeTerritory(args)
    : withNeighborCleanup(() => writeNodeTerritory(args));
}

function writeNodeTerritory(args: PatchTerritoryArgs): Record<string, unknown> {
  const { node_id, title, description, role, body, toggle_checkboxes, slot } = args;
  validateChangeInput(args);
  if ((args.section === undefined) !== (args.text === undefined)) {
    throw blocked('patch_node_territory section needs both section ("## Heading") and text.');
  }
  if (body !== undefined && (args.section !== undefined || args.replace !== undefined)) {
    throw blocked("patch_node_territory body replaces the whole body; do not combine it with section or replace.");
  }
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  const resolvedSlot: TerritorySlot =
    slot ??
    (node.next &&
    isPipelineNodeType(node.type) &&
    (node.state === "stable" || node.state === "unstable")
      ? "next"
      : "current");
  if (title !== undefined) {
    assertPipelineTerritoryScalarsEditable(node, "title", resolvedSlot);
  }
  if (description !== undefined) {
    assertPipelineTerritoryScalarsEditable(node, "description", resolvedSlot);
  }
  if (role !== undefined) {
    if (!isFoundationRole(role)) {
      throw blocked(`invalid Foundation role "${role}".`);
    }
    assertPipelineTerritoryScalarsEditable(node, "role", resolvedSlot);
  }
  const changeWrite = args.change !== undefined || args.change_ref !== undefined;
  // change on a shipped live slot with no open next labels the node a neighbor of that change.
  const neighborWrite = resolvedSlot === "current" && isNeighborNode(node);
  if (changeWrite) {
    if (!isPipelineNodeType(node.type)) {
      throw blocked(`change applies to Foundations, Interactions, and Interfaces; "${node_id}" is a ${node.type}.`);
    }
    if (neighborWrite && args.change_ref !== undefined) {
      throw blocked(
        `change_ref belongs to a revision; "${node_id}" is shipped with no open next. Pass change alone to label it a neighbor, or open_next (it takes change_ref).`
      );
    }
    if (resolvedSlot === "current" && node.shipped_at && !neighborWrite) {
      throw blocked(
        `"${node_id}" is shipped; a change id belongs to an open revision. Call open_next (it takes change) or patch the next slot.`
      );
    }
  }
  const replacedChange =
    neighborWrite && args.change && node.change && node.change !== args.change ? node.change : undefined;
  if (
    body !== undefined ||
    args.section !== undefined ||
    args.replace !== undefined ||
    (toggle_checkboxes?.length ?? 0) > 0
  ) {
    const raw = readMarkdown(node, resolvedSlot);
    if (!splitContext(raw)) {
      throw blocked(`${resolvedSlot} file for "${node_id}" has no YAML frontmatter.`);
    }
  }
  const result = patchNodeTerritoryStore(node, {
    title,
    description,
    role,
    body,
    toggle_checkboxes,
    section: args.section !== undefined ? { heading: args.section, text: args.text! } : undefined,
    replace: args.replace,
    change: args.change,
    change_ref: args.change_ref,
    slot: resolvedSlot,
  });
  const pathWritten = territoryPath(node, result.slot);
  const { readinessReset, twin, ...written } = result;
  const readiness = readinessResult(node, result.slot, readinessReset);
  // The store dropped a stale live label when the revision's change moved off it.
  const liveLabelFile = written.replaced_change ? territoryPath(node, "current") : null;
  return {
    node_id,
    ...written,
    path: pathWritten,
    ...(neighborWrite && args.change ? { neighbor_of: args.change } : {}),
    ...(replacedChange ? { replaced_change: replacedChange } : {}),
    ...readinessFields(readiness.reset),
    changed_files: changedFiles(
      [pathWritten, twin, liveLabelFile, ...readiness.files],
      readiness.reset !== null
    ),
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}

/**
 * Replace one node's `## Rules` section. Valid in any non-retired state; never changes state,
 * edges, or checkboxes and never needs open_next. Reports whose work the rules reach.
 */
export function patchNodeRules(args: {
  node_id: string;
  rules: string;
}): Record<string, unknown> {
  const { node_id, rules } = args;
  if (rules === undefined) {
    throw blocked("patch_node_rules requires rules.");
  }
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  const written = writeNodeRules(node, rules);
  return {
    node_id,
    rules: node.rules ?? "",
    slots: written.slots,
    rules_impact: rulesImpact(graph, node),
    changed_files: changedFiles(written.paths),
  };
}

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
}): Record<string, unknown> {
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
  // A neighbor has no open revision, so its change is the live label it carries.
  const change = args.change || activeChange(node) || (isNeighborNode(node) ? node.change : undefined);

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
    // Reach: the node itself and the nodes it inherits decisions from (its Journeys and Foundations).
    const reach = inheritanceSources(graph, node.id)
      .filter((s) => s.via !== "affects")
      .map((s) => s.node.id);
    if (!reach.includes(target.node.id)) {
      throw blocked(
        `"${args.supersedes}" is held by "${target.node.id}", which "${node.id}" does not inherit decisions from. ` +
          `A decision may supersede only one on the same node, its Journeys, or its Foundations.`
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
  };
  const written = appendDecision(node, record);
  // A decision under a change on a shipped node with no open next: the change edits it in place.
  const neighbor =
    args.change && isNeighborNode(node)
      ? labelNeighbor(node, args.change)
      : { fields: {}, files: [] };
  const after = loadGraph();
  const entry = listDecisions(after, { node_id: node.id, include_superseded: true }).find(
    (d) => d.id === id
  );
  return {
    node_id: node.id,
    slot: written.slot,
    decision: entry ?? record,
    ...(superseded ? { supersedes: superseded } : {}),
    ...neighbor.fields,
    changed_files: changedFiles([...written.paths, ...neighbor.files]),
    ...mutationTail(after, node.id, args.verbose),
  };
}

export function openNext(args: {
  verbose?: boolean;
  node_id: string;
  title?: string;
  description?: string;
  change?: string;
  change_ref?: string;
}): Record<string, unknown> {
  const { node_id, title, description } = args;
  validateChangeInput(args);
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  validateOpenNext(node);
  const next = openNextSlot(node, { title, description });
  node.next = next;
  // The next slot is a copy of live, so it inherits a neighbor label unless change says otherwise.
  if (args.change === undefined && node.change) next.change = node.change;
  // A live neighbor label that differs from the revision's change is stale: the node is now a
  // revision, not a neighbor. The store clears it so discard_next does not restore it.
  const replacedChange = writeChangeFrontmatter(
    node,
    { change: args.change, change_ref: args.change_ref },
    "next"
  );
  const rel = entityRelativePath(node);
  const current = territoryPath(node, "current");
  const next_path = territoryPath(node, "next");
  refreshPersistedMap();
  return {
    node_id,
    live_state: node.state,
    next,
    folder: rel,
    current,
    next_path,
    ...(replacedChange ? { replaced_change: replacedChange } : {}),
    changed_files: changedFiles(
      [next_path, `${rel}/${NEXT_ATTACHMENTS_DIR}/.gitkeep`, replacedChange ? current : null],
      true
    ),
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}

export function discardNext(args: { node_id: string; verbose?: boolean }): Record<string, unknown> {
  // Discarding a change's last revision closes it. The live label that comes back with the mirror
  // twin can only name the revision's own change (the store drops any other), so that closing
  // clears it too.
  return withNeighborCleanup(() => discardNextSlotWrite(args));
}

function discardNextSlotWrite(args: { node_id: string; verbose?: boolean }): Record<string, unknown> {
  const { node_id } = args;
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  if (!node.next) {
    throw blocked(
      `node "${node_id}" has no open evolution to discard (standing mirror twins are not discarded).`
    );
  }
  const next_path = territoryPath(node, "next");
  const slotFiles = nextSlotFsChangedFiles(node, { includeCopiedAttachments: false });
  discardNextSlot(node);
  delete node.next;
  refreshPersistedMap();
  return {
    node_id,
    discarded: true,
    restored_mirror: true,
    live_state: node.state,
    changed_files: changedFiles([next_path, ...slotFiles], true),
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}

export function patchProjectDescription(args: {
  description: string;
}): Record<string, unknown> {
  if (args.description === undefined) {
    throw blocked("patch_project_description requires description.");
  }
  const result = writeProjectBrief({ description: args.description });
  return {
    path: result.path,
    description: result.description,
    rules: result.rules,
    changed_files: changedFiles([PROJECT_RELATIVE_PATH]),
  };
}

export function patchProjectRules(args: { rules: string }): Record<string, unknown> {
  if (args.rules === undefined) {
    throw blocked("patch_project_rules requires rules.");
  }
  const result = writeProjectBrief({ rules: args.rules });
  return {
    path: result.path,
    description: result.description,
    rules: result.rules,
    changed_files: changedFiles([PROJECT_RELATIVE_PATH]),
  };
}

export function patchConfig(args: {
  sources?: string[];
  exclude?: string[];
  decisions?: { blast_radius?: number; schema_files?: string[] };
  search?: { enabled?: boolean; model?: string };
}): Record<string, unknown> {
  if (
    args.sources === undefined &&
    args.exclude === undefined &&
    args.decisions === undefined &&
    args.search === undefined
  ) {
    throw blocked("patch_config requires sources, exclude, decisions, and/or search.");
  }
  const current = loadProjectConfig();
  // A decision or search setting that is not passed keeps its stored value.
  const merged = <T extends object>(stored: T | undefined, passedArgs: T | undefined): Partial<T> => ({
    ...(stored ?? {}),
    ...Object.fromEntries(Object.entries(passedArgs ?? {}).filter(([, v]) => v !== undefined)),
  });
  const decisions = merged(current.decisions, args.decisions);
  const search = merged(current.search, args.search);
  const next = {
    sources: args.sources ?? current.sources,
    exclude: args.exclude ?? current.exclude,
    ...(Object.keys(decisions).length > 0 ? { decisions } : {}),
    ...(Object.keys(search).length > 0 ? { search } : {}),
  };
  const written = writeProjectConfig(next, { force: true });
  return {
    path: written.path,
    config: written.config,
    changed_files: changedFiles([written.path]),
  };
}

export function putAttachment(args: {
  verbose?: boolean;
  node_id: string;
  filename: string;
  content_base64: string;
  slot?: TerritorySlot;
}): Record<string, unknown> {
  const { node_id } = args;
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  const filename = args.filename.trim();
  assertAttachmentBasename(filename, args.filename);
  const slot: TerritorySlot =
    args.slot ??
    (node.next && isPipelineNodeType(node.type) ? "next" : "current");
  if (slot === "next" && !node.next) {
    throw blocked(
      `cannot put attachment on next for "${node_id}" — no open evolution. Call open_next first.`
    );
  }
  if (!isBase64Payload(args.content_base64)) {
    throw blocked("content_base64 is not valid base64.");
  }
  const bytes = Buffer.from(args.content_base64, "base64");
  const dir = slot === "next" ? nextAttachmentsDir(node) : attachmentsDir(node);
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, filename);
  if (path.resolve(abs) !== path.resolve(dir, filename)) {
    throw blocked(`invalid attachment filename "${args.filename}".`);
  }
  fs.writeFileSync(abs, bytes);
  const rel = `${entityRelativePath(node)}/${slot === "next" ? NEXT_ATTACHMENTS_DIR : ATTACHMENTS_DIR}/${filename}`;
  return {
    node_id,
    slot,
    path: rel,
    bytes: bytes.length,
    changed_files: changedFiles([rel]),
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}

export function removeAttachment(args: {
  verbose?: boolean;
  node_id: string;
  filename: string;
  slot?: TerritorySlot;
}): Record<string, unknown> {
  const { node_id } = args;
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  const filename = args.filename.trim();
  assertAttachmentBasename(filename, args.filename);
  const slot: TerritorySlot =
    args.slot ??
    (node.next && isPipelineNodeType(node.type) ? "next" : "current");
  if (slot === "next" && !node.next) {
    throw blocked(
      `cannot remove attachment on next for "${node_id}" — no open evolution.`
    );
  }
  const dir = slot === "next" ? nextAttachmentsDir(node) : attachmentsDir(node);
  const abs = path.join(dir, filename);
  if (path.resolve(abs) !== path.resolve(dir, filename)) {
    throw blocked(`invalid attachment filename "${args.filename}".`);
  }
  if (!fs.existsSync(abs)) {
    throw blocked(`attachment "${filename}" not found on ${slot} for "${node_id}".`);
  }
  fs.unlinkSync(abs);
  const rel = `${entityRelativePath(node)}/${slot === "next" ? NEXT_ATTACHMENTS_DIR : ATTACHMENTS_DIR}/${filename}`;
  return {
    node_id,
    slot,
    path: rel,
    removed: true,
    changed_files: changedFiles([rel]),
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}
