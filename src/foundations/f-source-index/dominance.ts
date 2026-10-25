/**
 * Folder dominance — where a shipped node may claim one more file in place (no revision), and
 * which per-file claim lists one folder claim would replace.
 */

import * as path from "path";
import type { MindPlanGraph } from "../f-domain-model/types.js";
import { isPipelineNodeType } from "../f-domain-model/types.js";
import { claimCoversPath, expandClaims, isGlobClaim, validateClaimPath } from "./claims.js";
import { matchesSchemaFile } from "./git.js";
import { RETIRED_STATES } from "./ownership.js";
import { matchGlob } from "./universe.js";

/** Every other non-retired pipeline node's claim entries (live and open next) and their files. */
export type OtherClaims = { entries: string[]; files: string[] };

/**
 * The claims of every non-retired pipeline node other than `nodeId`. Compute once and pass to
 * `isDominatedFolder` when testing several folders for the same node.
 */
export function collectOtherClaims(graph: MindPlanGraph, nodeId: string, root?: string): OtherClaims {
  const entries: string[] = [];
  for (const other of graph.nodes) {
    if (other.id === nodeId || !isPipelineNodeType(other.type)) continue;
    if (RETIRED_STATES.has(other.state)) continue;
    for (const raw of [...(other.implements ?? []), ...(other.next?.implements ?? [])]) {
      entries.push(validateClaimPath(raw));
    }
  }
  return { entries, files: expandClaims(entries, root) };
}

/** A glob entry's static prefix: the segments before its first glob segment ("" at the root). */
function globStaticPrefix(entry: string): string {
  const parts = entry.replace(/\/$/, "").split("/");
  const firstGlob = parts.findIndex((p) => isGlobClaim(p));
  return parts.slice(0, firstGlob < 0 ? parts.length : firstGlob).join("/");
}

/**
 * True when a glob rooted above `folder` can match a path beneath it: it has `**`, or its
 * leading segments match the folder and it has segments left for what lies under it.
 */
function globReachesUnder(entry: string, folder: string): boolean {
  if (entry.includes("**")) return true;
  const segs = entry.replace(/\/$/, "").split("/");
  const depth = folder.split("/").length;
  const deeper = segs.length > depth || (entry.endsWith("/") && segs.length === depth);
  return deeper && matchGlob(segs.slice(0, depth).join("/"), folder);
}

/**
 * True when another node claims anything under `folder`: an entry at or under it, an entry
 * covering it or one of `probes` (an ancestor directory or a glob), a glob whose static prefix is
 * the folder or under it, a glob rooted above it that can reach beneath it (conservative: it may
 * match files the folder holds later), or an expanded file beneath it.
 */
function othersClaimUnder(others: OtherClaims, folder: string, probes: string[]): boolean {
  const prefix = `${folder}/`;
  const paths = [prefix, ...probes];
  for (const entry of others.entries) {
    if (entry.startsWith(prefix)) return true;
    if (isGlobClaim(entry)) {
      const stat = globStaticPrefix(entry);
      if (stat === folder || stat.startsWith(prefix)) return true;
      if ((stat === "" || folder.startsWith(`${stat}/`)) && globReachesUnder(entry, folder)) return true;
    }
    if (paths.some((p) => claimCoversPath(entry, p))) return true;
  }
  return others.files.some((f) => f.startsWith(prefix));
}

/** Normalized folder (repo-relative POSIX, no trailing slash), or null for the repo root. */
function normalizeFolder(folder: string): string | null {
  const trimmed = folder.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!trimmed || trimmed === ".") return null;
  return validateClaimPath(trimmed);
}

/**
 * True when `folder` is dominated by `nodeId`: the node's live claims expand to at least one file
 * directly in the folder, and no other non-retired pipeline node (live or open next) claims the
 * folder, anything under it, an ancestor or glob covering it (or one of `probes`, the paths about
 * to be claimed), has a glob whose static prefix is at, under, or above it, or has an expanded
 * file beneath it. The repo root is never dominated. `others` is `collectOtherClaims(graph,
 * nodeId, root)`, precomputed by callers that test several folders.
 */
export function isDominatedFolder(
  graph: MindPlanGraph,
  nodeId: string,
  folder: string,
  root?: string,
  probes: string[] = [],
  others?: OtherClaims
): boolean {
  const f = normalizeFolder(folder);
  if (!f) return false;
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node || !isPipelineNodeType(node.type)) return false;
  const own = expandClaims(node.implements, root);
  if (!own.some((file) => path.posix.dirname(file) === f)) return false;
  return !othersClaimUnder(others ?? collectOtherClaims(graph, nodeId, root), f, probes);
}

/** A file name that stands for "a file added to this folder later" when matching schema globs. */
const NEW_FILE_PROBE = "new-file";

/**
 * The claim entries that reach a migration or schema file under `globs` (the decision gate's
 * `schema_files`): an exact file that matches, or `F/` when a file under F matches or F is itself
 * a schema folder (a file added to it later would match). Claiming one is decision-worthy, so it
 * is never added in place.
 */
export function schemaClaimEntries(entries: string[], globs: string[], root?: string): string[] {
  return entries.filter((e) => {
    if (!e.endsWith("/")) return matchesSchemaFile(e, globs);
    if (matchesSchemaFile(`${e}${NEW_FILE_PROBE}`, globs)) return true;
    return expandClaims([e], root).some((f) => matchesSchemaFile(f, globs));
  });
}

export type FolderClaimSuggestion = { folder: string; files: string[]; note: string };

/**
 * Folders where `entries` lists two or more exact files (not already covered by a directory or
 * glob entry in the same list), every file on disk under the folder is covered by `entries`, and
 * no other node claims anything under it: one `folder/` entry would claim the same files.
 */
export function folderClaimSuggestions(
  graph: MindPlanGraph,
  nodeId: string,
  entries: string[],
  root?: string
): FolderClaimSuggestion[] {
  const list = entries.map((e) => validateClaimPath(e));
  const wide = list.filter((e) => e.endsWith("/") || isGlobClaim(e));
  const byFolder = new Map<string, string[]>();
  for (const e of list) {
    if (e.endsWith("/") || isGlobClaim(e)) continue;
    if (wide.some((w) => claimCoversPath(w, e))) continue;
    const folder = path.posix.dirname(e);
    if (folder === ".") continue;
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), e]);
  }
  const out: FolderClaimSuggestion[] = [];
  let others: OtherClaims | null = null;
  for (const [folder, files] of [...byFolder].sort(([a], [b]) => a.localeCompare(b))) {
    if (files.length < 2) continue;
    const onDisk = expandClaims([`${folder}/`], root);
    if (onDisk.length === 0) continue;
    if (!onDisk.every((f) => list.some((e) => claimCoversPath(e, f)))) continue;
    others ??= collectOtherClaims(graph, nodeId, root);
    if (othersClaimUnder(others, folder, onDisk)) continue;
    out.push({
      folder: `${folder}/`,
      files: onDisk,
      note: `${folder}/ would cover these ${onDisk.length} files`,
    });
  }
  return out;
}
