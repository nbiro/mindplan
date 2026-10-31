/**
 * Tree diff — a content snapshot of mindplan/ so setup_project and upgrade_project can list every
 * path they added, changed, or deleted in changed_files. Owned by Foundation f-graph-migrations.
 */

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { MINDPLAN_DIR, mindplanRoot } from "../f-territory-store/store.js";

export type TreeSnapshot = Map<string, string>;

/** Repo-relative POSIX path → content hash for every file under mindplan/. */
export function snapshotTree(): TreeSnapshot {
  const snapshot: TreeSnapshot = new Map();
  const walk = (abs: string, rel: string): void => {
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.isFile()) snapshot.set(childRel, createHash("sha1").update(fs.readFileSync(childAbs)).digest("hex"));
    }
  };
  walk(mindplanRoot(), MINDPLAN_DIR);
  return snapshot;
}

/** Paths added, changed, or deleted under mindplan/ since the snapshot, sorted. */
export function changedSince(before: TreeSnapshot): string[] {
  const after = snapshotTree();
  const changed = new Set<string>();
  for (const [p, hash] of after) if (before.get(p) !== hash) changed.add(p);
  for (const p of before.keys()) if (!after.has(p)) changed.add(p);
  return [...changed].sort();
}
