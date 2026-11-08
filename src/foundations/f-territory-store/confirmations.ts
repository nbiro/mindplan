/**
 * Territory confirmations — owned by f-territory-store: `confirmed.json` in a node folder records
 * that the node's live text still describes its changed claimed files, each pinned by a content
 * hash. confirm_territory appends to it and the merge gate reads it, so a shipped node whose code
 * moved but whose contract did not needs no invented prose patch. The file never shapes a node
 * record: the graph loader and the graph cache do not read it.
 */

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { MindPlanNode } from "../f-domain-model/types.js";
import { git } from "../f-source-index/git.js";
import { readBytesRetry, readFileRetry, writeFileRetry } from "../f-source-index/io.js";
import { entityDir, entityRelativePath, projectRoot } from "./store.js";

/** The confirmations file's name inside a node folder. */
export const CONFIRMATIONS_FILE = "confirmed.json";
/** Confirmations kept per node; the oldest are dropped past this. */
export const CONFIRMATIONS_KEPT = 10;
/** The hash recorded for a claimed file that is gone from disk. */
export const DELETED_HASH = "deleted";

/** One confirmation: who, when, why, and each confirmed file's content hash at that moment. */
export type Confirmation = {
  by: string;
  at: string;
  note: string;
  files: Record<string, string>;
};

type NodeRef = Pick<MindPlanNode, "id" | "type">;

/** Repo-relative POSIX path of the node's `confirmed.json`. */
export function confirmationsRelativePath(node: NodeRef): string {
  return `${entityRelativePath(node)}/${CONFIRMATIONS_FILE}`;
}

function confirmationsPath(node: NodeRef): string {
  return path.join(entityDir(node), CONFIRMATIONS_FILE);
}

function isConfirmation(value: unknown): value is Confirmation {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  if (typeof c.by !== "string" || typeof c.at !== "string" || typeof c.note !== "string") return false;
  if (!c.files || typeof c.files !== "object" || Array.isArray(c.files)) return false;
  return Object.values(c.files as Record<string, unknown>).every((h) => typeof h === "string");
}

/**
 * The node's confirmations, oldest first; none when the file is absent or does not parse (a
 * damaged file confirms nothing, so the merge gate Blocks as if it were absent).
 */
export function readConfirmations(node: NodeRef): Confirmation[] {
  const file = confirmationsPath(node);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileRetry(file)) as { confirmations?: unknown };
    return Array.isArray(parsed?.confirmations) ? parsed.confirmations.filter(isConfirmation) : [];
  } catch {
    return [];
  }
}

/**
 * Appends one confirmation (newest last, at most CONFIRMATIONS_KEPT kept) and returns the file's
 * repo-relative path.
 */
export function appendConfirmation(node: NodeRef, entry: Confirmation): string {
  const all = [...readConfirmations(node), entry].slice(-CONFIRMATIONS_KEPT);
  writeFileRetry(confirmationsPath(node), JSON.stringify({ confirmations: all }, null, 2) + "\n");
  return confirmationsRelativePath(node);
}

/**
 * SHA-256 hex of a project file's content with CRLF normalized to LF, so a Windows checkout and a
 * Linux CI agree; DELETED_HASH when the file is gone.
 */
export function confirmationHash(rel: string, root: string = projectRoot()): string {
  const abs = path.join(root, ...rel.split("/"));
  let bytes: Buffer;
  try {
    if (!fs.statSync(abs).isFile()) return DELETED_HASH;
    bytes = readBytesRetry(abs);
  } catch {
    return DELETED_HASH;
  }
  const normalized = Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
  return createHash("sha256").update(normalized).digest("hex");
}

/** Who confirms: the project's `git config user.name`, else USER / USERNAME, else "agent". */
export function confirmer(root: string = projectRoot()): string {
  const name = git(["config", "user.name"], root)?.trim();
  return name || process.env.USER?.trim() || process.env.USERNAME?.trim() || "agent";
}

/**
 * How the node's confirmations cover `files` at their current content. Per file the newest
 * confirmation naming it decides: `confirmed` when its hash equals the file's hash now,
 * `changed` when the file moved since, `unconfirmed` when no confirmation names it. `latest` is
 * the newest confirmation that confirmed a file (null when none did).
 */
export type ConfirmationCoverage = {
  confirmed: string[];
  changed: string[];
  unconfirmed: string[];
  latest: Confirmation | null;
};

export function confirmationCoverage(
  node: NodeRef,
  files: string[],
  root: string = projectRoot(),
  confirmations: Confirmation[] = readConfirmations(node)
): ConfirmationCoverage {
  const out: ConfirmationCoverage = { confirmed: [], changed: [], unconfirmed: [], latest: null };
  let latestAt = -1;
  for (const rel of files) {
    let at = -1;
    for (let i = confirmations.length - 1; i >= 0; i--) {
      if (Object.prototype.hasOwnProperty.call(confirmations[i].files, rel)) {
        at = i;
        break;
      }
    }
    if (at === -1) {
      out.unconfirmed.push(rel);
    } else if (confirmations[at].files[rel] === confirmationHash(rel, root)) {
      out.confirmed.push(rel);
      if (at > latestAt) latestAt = at;
    } else {
      out.changed.push(rel);
    }
  }
  out.latest = latestAt === -1 ? null : confirmations[latestAt];
  return out;
}
