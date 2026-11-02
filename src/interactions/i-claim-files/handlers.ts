/**
 * Claim files — owned by i-claim-files: set_implementation_files (claims, in-place growth on a
 * shipped node, attributed files) and set_test_files.
 */

import {
  isInactiveNode,
  isShippedWithoutNext,
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
import { blocked, findNode, revisionGraph } from "../../foundations/f-compiler-rules/rules.js";
import {
  applyDelta,
  diffDelta,
  resolveRevisionChange,
  revisionFor,
} from "../../foundations/f-revision-model/index.js";
import {
  writeRevisionDelta,
  writeRevisionScalars,
  writeRevisionState,
} from "../../foundations/f-territory-store/revisions.js";
import type { EdgeDelta } from "../../foundations/f-domain-model/types.js";
import { findImportViolationsForClaim } from "../../foundations/f-compiler-rules/integrity.js";
import * as fs from "fs";
import * as path from "path";
import {
  READINESS_NOTE,
  changedFiles,
  gateWrite,
  shippedChangeBlocked,
  mutationTail,
  readinessFields,
  readinessResult,
  refreshPersistedMap,
  territoryPath,
  withChangeCleanup,
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

/** How a call changes a file list: entries added and removed, or the whole list replaced. */
type ListEdit = { replace: string[] } | { add: string[]; remove: string[] };

type ListEditArgs = { files?: string[]; replace?: boolean; add?: string[]; remove?: string[] };

/**
 * The list edit a set_implementation_files / set_test_files call asks for, or null when it names
 * none. `files` replaces the whole list only with `replace: true`; add / remove change entries.
 */
function listEdit(tool: string, args: ListEditArgs): ListEdit | null {
  if (args.files !== undefined && args.replace !== true) {
    throw blocked(
      `${tool} files replaces the whole list only with replace: true. Pass add / remove to change entries (add is the default), or files with replace: true.`
    );
  }
  if (args.replace === true && args.files === undefined) {
    throw blocked(`${tool} replace: true needs files (the whole new list).`);
  }
  if (args.files !== undefined && (args.add !== undefined || args.remove !== undefined)) {
    throw blocked(`${tool} files with replace: true replaces the whole list; do not combine it with add or remove.`);
  }
  if (args.files !== undefined) return { replace: args.files };
  if (args.add !== undefined || args.remove !== undefined) return { add: args.add ?? [], remove: args.remove ?? [] };
  return null;
}

/** `base` with the edit applied, normalized (each entry validated, deduped, sorted). */
function applyListEdit(base: string[], edit: ListEdit, field: "implements" | "tests"): string[] {
  if ("replace" in edit) return normalizeClaimList(edit.replace, field);
  const removed = new Set(normalizeClaimList(edit.remove, field));
  return normalizeClaimList([...base.filter((e) => !removed.has(e)), ...edit.add], field);
}

function sameDelta(a: EdgeDelta | undefined, b: EdgeDelta): boolean {
  const key = (d: EdgeDelta | undefined) => JSON.stringify([[...(d?.add ?? [])].sort(), [...(d?.remove ?? [])].sort()]);
  return key(a) === key(b);
}

/** A contract write to a ready revision sends it back to draft; returns the reset and files. */
function resetReadyRevision(
  node: MindPlanNode,
  change: string
): { reset: Record<string, unknown> | null; files: string[] } {
  if (revisionFor(node, change)?.state !== "ready") return { reset: null, files: [] };
  const written = writeRevisionState(node, change, "draft");
  return {
    reset: { slot: "next", change, from: "ready", to: "draft", note: READINESS_NOTE },
    files: written.changed_files,
  };
}

type SetImplementationArgs = {
  verbose?: boolean;
  node_id: string;
  /** The whole new claim list; only with `replace: true`. */
  files?: string[];
  replace?: boolean;
  /** Claims to add (the default way to claim). */
  add?: string[];
  /** Claims to drop. */
  remove?: string[];
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
        `no other node claims "${f}", so there is nothing to attribute it from: claim it with set_implementation_files({ node_id: "${node.id}", add: ["${f}"] }).`
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
    : withChangeCleanup(() => writeImplementationFiles(args));
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
  if (args.change !== undefined && !node.open_revisions?.length && isShippedWithoutNext(node)) throw shippedChangeBlocked(node);

  const edit = listEdit("set_implementation_files", args);
  if (edit === null && args.attributed === undefined) {
    throw blocked("set_implementation_files needs add, remove, files with replace: true, or attributed.");
  }
  if (node.open_revisions?.length) {
    if (args.slot === "current") {
      if (isProductionState(node.state)) {
        throw blocked(
          `shipped "${node.id}" can only change implements on an open revision. Omit slot (or pass slot: "next" with change).`
        );
      }
    } else {
      return writeRevisionClaims(graph, node, resolveRevisionChange(node, args.change)!, edit, args);
    }
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

  // Without an edit, the claims of the written slot stay as they are.
  const slotClaims = (slot === "next" ? node.next?.implements : node.implements) ?? [];
  const normalized = edit ? applyListEdit(slotClaims, edit, "implements") : normalizeClaimList(slotClaims);
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
  // change is the written slot's change id (a shipped node with no open next was Blocked above).
  if (args.change !== undefined) writeChangeFrontmatter(node, { change: args.change }, slot);
  return {
    node_id: node.id,
    slot,
    implements: normalized,
    ...(attributed ? { attributed } : {}),
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
      [pathWritten, ...readiness.files],
      true
    ),
    ...mutationTail(loadGraph(), node.id, args.verbose),
  };
}

/**
 * set_implementation_files on an open revision: the claims become an add / remove delta against
 * live (`diffDelta(live, requested)`), attributed the revision's own list. Ownership conflicts and
 * attribution are checked first; a changed delta or attribution resets a ready revision to draft.
 */
function writeRevisionClaims(
  graph: MindPlanGraph,
  node: MindPlanNode,
  change: string,
  edit: ListEdit | null,
  args: SetImplementationArgs
): Record<string, unknown> {
  const revision = revisionFor(node, change)!;
  const live = node.implements ?? [];
  const current = applyDelta(live, revision.implements);
  const normalized = edit ? applyListEdit(current, edit, "implements") : current;
  const attributed = args.attributed !== undefined ? validateAttributed(graph, node, args.attributed, normalized) : undefined;
  const buckets = buildOwnershipIndex(graph);
  for (const f of expandClaims(normalized)) {
    const other = exclusiveOwner(buckets, f);
    if (other && other !== node.id) {
      throw blocked(`implements conflict: "${f}" is already claimed by "${other}".`);
    }
  }
  const paths: string[] = [];
  let contract = false;
  if (edit) {
    const delta = diffDelta(live, normalized);
    if (!sameDelta(revision.implements, delta)) {
      paths.push(...writeRevisionDelta(node, change, "implements", delta).changed_files);
      contract = true;
    }
  }
  if (attributed && JSON.stringify([...(revision.attributed ?? [])].sort()) !== JSON.stringify([...attributed].sort())) {
    paths.push(...writeRevisionScalars(node, change, { attributed }).changed_files);
    contract = true;
  }
  const readiness = contract ? resetReadyRevision(node, change) : { reset: null, files: [] };
  if (paths.length > 0) refreshPersistedMap();
  const claimedGraph = revisionGraph(loadGraph(), change);
  const claimedNode = findNode(claimedGraph, node.id);
  const importViolations = findImportViolationsForClaim(claimedGraph, projectRoot(), claimedNode, normalized).map((v) => ({
    file: v.file,
    imports: v.imports,
    ...(v.fix ? { fix: v.fix } : { not_allowed: v.not_allowed }),
  }));
  const folderClaims = folderClaimSuggestions(claimedGraph, node.id, normalized, projectRoot());
  return {
    node_id: node.id,
    slot: "next",
    change,
    implements: normalized,
    implements_delta: revisionFor(node, change)?.implements ?? diffDelta(live, normalized),
    ...(attributed ? { attributed } : {}),
    ...(folderClaims.length ? { folder_claims: folderClaims } : {}),
    ...(importViolations.length ? { import_violations: importViolations } : {}),
    ...(readiness.reset ? { readiness_reset: readiness.reset } : {}),
    changed_files: changedFiles([...paths, ...readiness.files], paths.length > 0),
    ...mutationTail(loadGraph(), node.id, args.verbose),
  };
}

type SetTestFilesArgs = {
  verbose?: boolean;
  node_id: string;
  /** The whole new list; only with `replace: true`. */
  files?: string[];
  replace?: boolean;
  /** Test files to link (the default way to link). */
  add?: string[];
  /** Test files to unlink. */
  remove?: string[];
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
    : withChangeCleanup(() => writeTestFiles(args));
}

function writeTestFiles(args: SetTestFilesArgs): Record<string, unknown> {
  validateChangeInput({ change: args.change });
  const graph = loadGraph();
  const node = findNode(graph, args.node_id);
  const edit = listEdit("set_test_files", args);
  if (edit === null) throw blocked("set_test_files needs add, remove, or files with replace: true.");
  if (node.open_revisions?.length) {
    // An open revision holds its test links as a delta against live, applied when it ships.
    const change = resolveRevisionChange(node, args.change)!;
    const live = node.tests ?? [];
    const revision = revisionFor(node, change)!;
    const requested = applyListEdit(applyDelta(live, revision.tests), edit, "tests");
    const delta = diffDelta(live, requested);
    const files = sameDelta(revision.tests, delta) ? [] : writeRevisionDelta(node, change, "tests", delta).changed_files;
    return {
      node_id: node.id,
      slot: "next",
      change,
      tests: requested,
      tests_delta: revisionFor(node, change)?.tests ?? delta,
      changed_files: changedFiles(files),
      ...mutationTail(loadGraph(), node.id, args.verbose),
    };
  }
  // Only a revision carries a change id; a shipped node with no open next is edited in place.
  if (args.change !== undefined && isShippedWithoutNext(node)) throw shippedChangeBlocked(node);
  const testsWrite = writeTestsFrontmatter(node, applyListEdit(node.tests ?? [], edit, "tests"));
  // change is the active slot's change id.
  const changeFiles: string[] = [];
  if (args.change !== undefined) {
    const slot: TerritorySlot = node.next ? "next" : "current";
    writeChangeFrontmatter(node, { change: args.change }, slot);
    changeFiles.push(territoryPath(node, slot));
  }
  return {
    node_id: node.id,
    tests: node.tests ?? [],
    changed_files: changedFiles([...testsWrite.paths, ...changeFiles]),
    ...mutationTail(loadGraph(), node.id, args.verbose),
  };
}
