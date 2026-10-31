/**
 * Claim files — owned by i-claim-files: set_implementation_files (claims, in-place growth on a
 * shipped node, attributed files) and set_test_files.
 */

import {
  isInactiveNode,
  isNeighborNode,
  isPipelineNodeType,
  isProductionState,
  type MindPlanGraph,
  type MindPlanNode,
} from "../../foundations/f-domain-model/types.js";
import {
  loadGraph,
  loadProjectConfig,
  projectRoot,
  validateChangeInput,
  writeChangeFrontmatter,
  writeImplementsFrontmatter,
  writeTestsFrontmatter,
  writeAttributedFrontmatter,
  type TerritorySlot,
} from "../../foundations/f-territory-store/store.js";
import {
  claimCoversPath,
  claimListKeeps,
  expandClaims,
  isGlobClaim,
  normalizeClaimList,
} from "../../foundations/f-source-index/claims.js";
import { decisionGateSettings } from "../../foundations/f-source-index/config.js";
import { buildOwnershipIndex, exclusiveOwner } from "../../foundations/f-source-index/ownership.js";
import {
  collectOtherClaims,
  folderClaimSuggestions,
  isDominatedFolder,
  schemaClaimEntries,
  type OtherClaims,
} from "../../foundations/f-source-index/dominance.js";
import { blocked, findNode } from "../../foundations/f-compiler-rules/rules.js";
import { findImportViolationsForClaim } from "../../foundations/f-compiler-rules/integrity.js";
import * as fs from "fs";
import * as path from "path";
import {
  changedFiles,
  gateWrite,
  labelNeighbor,
  mutationTail,
  readinessFields,
  readinessResult,
  refreshPersistedMap,
  territoryPath,
  withNeighborCleanup,
} from "../../foundations/f-plan-writes/writes.js";

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
  /** Replaces the claims; omitted (with `attributed`) keeps them. */
  files?: string[];
  /** Replaces the revision's files in another node's claimed folder. */
  attributed?: string[];
  slot?: TerritorySlot;
  change?: string;
};

/**
 * Checks a revision's attributed files: each an exact repo path (no glob, no trailing `/`) that
 * another active node's claim covers and this node's own claims do not. Returns the normalized list.
 */
function validateAttributed(graph: MindPlanGraph, node: MindPlanNode, entries: string[], ownClaims: string[]): string[] {
  const normalized = normalizeClaimList(entries);
  for (const f of normalized) {
    if (isGlobClaim(f) || f.endsWith("/")) {
      throw blocked(`attributed "${f}" must be one exact file (no glob, no trailing /): attribution names the files a revision adds.`);
    }
    if (ownClaims.some((c) => claimCoversPath(c, f))) {
      throw blocked(`"${node.id}" already claims "${f}"; attributed is for files in another node's folder.`);
    }
    const owner = graph.nodes.find(
      (o) =>
        o.id !== node.id &&
        isPipelineNodeType(o.type) &&
        !isInactiveNode(o) &&
        ((o.next ? o.next.implements : o.implements) ?? []).some((c) => claimCoversPath(c, f))
    );
    if (!owner) {
      throw blocked(
        `no other node claims "${f}", so there is nothing to attribute it from: claim it with set_implementation_files({ node_id: "${node.id}", files: [...] }).`
      );
    }
  }
  return normalized;
}

/**
 * Replace the implements list for a pipeline node on the appropriate slot.
 * A shipped node with no open next writes its live slot in place, additive only.
 */
export function setImplementationFiles(args: SetImplementationArgs): Record<string, unknown> {
  gateWrite(null, [args.node_id], "set_implementation_files");
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

  if (args.files === undefined && args.attributed === undefined) {
    throw blocked("set_implementation_files needs files, attributed, or both.");
  }
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

  // Without files, the claims of the written slot stay as they are.
  const normalized = normalizeClaimList(
    args.files ?? ((slot === "next" ? node.next?.implements : node.implements) ?? [])
  );
  let attributed: string[] | undefined;
  if (args.attributed !== undefined) {
    if (retired) throw blocked(`"${node.id}" is ${node.state}; a retired node attributes no files.`);
    if (inPlace) {
      throw blocked(
        `shipped "${node.id}" has no open revision: attributed files belong to a revision. Call open_next({ node_id: "${node.id}" }) first.`
      );
    }
    attributed = validateAttributed(graph, node, args.attributed, normalized);
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
  const attributedWrite = attributed ? writeAttributedFrontmatter(node, attributed, slot) : null;
  refreshPersistedMap();
  const pathWritten = territoryPath(node, slot);
  const readiness = readinessResult(
    node,
    slot,
    claimWrite.readinessReset || Boolean(attributedWrite?.readinessReset)
  );
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
    ...(attributed ? { attributed } : {}),
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
      [pathWritten, ...readiness.files, ...changeWrite.files],
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
  gateWrite(null, [args.node_id], "set_test_files");
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
