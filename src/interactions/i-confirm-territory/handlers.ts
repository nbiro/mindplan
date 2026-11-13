/**
 * Confirm territory — owned by i-confirm-territory: confirm_territory records on a shipped node
 * with no open revision that its live text still describes its changed claimed files, pinned by
 * content hash in `confirmed.json`, so the merge gate's stale-territory rule passes it without an
 * invented prose patch.
 */

import { isInactiveNode, isPipelineNodeType } from "../../foundations/f-domain-model/types.js";
import { loadGraph, oneLineValue, projectRoot } from "../../foundations/f-territory-store/store.js";
import {
  appendConfirmation,
  confirmationHash,
  confirmer,
  type Confirmation,
} from "../../foundations/f-territory-store/confirmations.js";
import { collectDirtySrcPaths, defaultBaseRef } from "../../foundations/f-source-index/git.js";
import { changedClaimed } from "../../foundations/f-source-index/dominance.js";
import { claimCoversPath } from "../../foundations/f-source-index/claims.js";
import { decisionGateSettings, loadProjectConfig } from "../../foundations/f-source-index/config.js";
import { buildOwnershipIndex, ownerOfFile } from "../../foundations/f-source-index/ownership.js";
import { toPosix } from "../../foundations/f-source-index/root-scope.js";
import { blocked, findNode } from "../../foundations/f-compiler-rules/rules.js";
import { changedFiles, gateWriteOrOrient } from "../../foundations/f-plan-writes/writes.js";

/** A project-relative POSIX path from what the caller typed (`./a\b` → `a/b`); null when it leaves the project. */
function normalizeFile(input: string): string | null {
  let rel = toPosix(input.trim());
  while (rel.startsWith("./")) rel = rel.slice(2);
  if (!rel || rel.startsWith("/") || /^[A-Za-z]:/.test(rel) || rel.split("/").includes("..")) return null;
  return rel;
}

/**
 * Append one confirmation to the node's `confirmed.json`: by (git user), at (now), note, and the
 * content hash of each confirmed file. `files` defaults to the node's claimed files changed
 * against the default-branch merge base (the merge gate's set); given, each must be claimed by
 * the node. Writes nothing else: no state, readiness, text, or map change.
 */
export function confirmTerritory(args: { node_id: string; files?: string[]; note: string }): Record<string, unknown> {
  const graph = loadGraph();
  // A confirmation changes no text, edge, or state the rules could shape: it orients the node itself.
  const finish = gateWriteOrOrient(graph, [args.node_id], "confirm_territory");
  const node = findNode(graph, args.node_id);
  if (!isPipelineNodeType(node.type)) {
    throw blocked(
      `"${node.id}" is a ${node.type}; confirm_territory confirms a shipped Foundation, Interaction, or Interface. ` +
        `The merge gate does not hold a ${node.type} to its claimed files.`
    );
  }
  if (isInactiveNode(node)) {
    throw blocked(`"${node.id}" is ${node.state}; a retired node is not held to its claimed files, so there is nothing to confirm.`);
  }
  if (!node.shipped_at) {
    throw blocked(
      `"${node.id}" is ${node.state} and has never shipped; the merge gate does not hold a pre-ship node to its text, so there is nothing to confirm.`
    );
  }
  const open = (node.open_revisions ?? []).map((r) => r.change);
  if (node.next || open.length > 0) {
    throw blocked(
      `"${node.id}" has an open revision${open.length ? ` (${open.map((c) => `"${c}"`).join(", ")})` : ""}; ` +
        `the revision ships its own text. Write it so it matches the code and ship it, or discard_next it and confirm the live text.`
    );
  }
  const note = oneLineValue(args.note ?? "");
  if (!note) {
    throw blocked(`confirm_territory needs note: one line saying why "${node.id}"'s text still describes the changed files.`);
  }

  const root = projectRoot();
  const claims = node.implements ?? [];
  let files: string[];
  if (args.files !== undefined) {
    files = [];
    const notClaimed: string[] = [];
    for (const raw of args.files) {
      const rel = normalizeFile(raw ?? "");
      if (!rel) throw blocked(`files names "${raw}", which is not a project-relative path.`);
      if (!claims.some((claim) => claimCoversPath(claim, rel))) notClaimed.push(rel);
      else if (!files.includes(rel)) files.push(rel);
    }
    if (notClaimed.length > 0) {
      const buckets = buildOwnershipIndex(graph, root);
      const lines = notClaimed.map((rel) => {
        const owner = ownerOfFile(buckets, rel);
        return owner ? `"${rel}" (owned by "${owner.id}")` : `"${rel}" (claimed by no node)`;
      });
      throw blocked(
        `"${node.id}" does not claim ${lines.join(", ")}. A node confirms only its own claimed files; confirm another node's files on that node.`
      );
    }
  } else {
    const base = defaultBaseRef(root);
    if (!base) {
      throw blocked(
        `confirm_territory found no git base (no main or master merge base) to find the changed files; pass files to name them.`
      );
    }
    let changed: string[];
    try {
      const dirty = collectDirtySrcPaths(root, base);
      changed = [...new Set([...dirty.commits, ...dirty.workingTree])].sort((a, b) => a.localeCompare(b));
    } catch (err) {
      throw blocked(`confirm_territory: git probe failed: ${err instanceof Error ? err.message : String(err)} Pass files to name them.`);
    }
    files = changedClaimed(changed, claims, decisionGateSettings(loadProjectConfig(root)).schema_files);
  }
  if (files.length === 0) {
    throw blocked(`"${node.id}": nothing changed against the default branch; no confirmation needed.`);
  }

  const entry: Confirmation = {
    by: confirmer(root),
    at: new Date().toISOString(),
    note,
    files: Object.fromEntries(files.map((rel) => [rel, confirmationHash(rel, root)])),
  };
  const rel = appendConfirmation(node, entry);
  return finish({
    node_id: node.id,
    confirmed: { by: entry.by, at: entry.at, note: entry.note, files },
    changed_files: changedFiles([rel]),
  });
}
