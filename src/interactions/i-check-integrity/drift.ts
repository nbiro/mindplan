/**
 * Lean drift — owned by i-check-integrity: what replies say about uncommitted source drift. A reply
 * carries `{ count, new_since_last_reply }`: how many paths drift, and only those this session was
 * not shown yet (a path listed once is not listed again while it keeps drifting the same way, and
 * one that stopped and came back is new). `get_drift` returns the full list.
 */

import { buildDriftReport, type DriftPath } from "./check.js";
import { resolveProjectRoot, rootKey } from "../../foundations/f-source-index/root-scope.js";

/** One drifting path as the lean report lists it. */
export type DriftEntry = Partial<Omit<DriftPath, "class">> & { path: string; class: string };

/** Per project root: the drift entries this session was already shown (path, class, owner). */
const shown = new Map<string, Set<string>>();

const entryKey = (e: DriftEntry) => `${e.path}\u0000${e.class}\u0000${e.owner_id ?? ""}`;

/** At most this many new drift entries per reply. */
export const NEW_DRIFT_SHOWN = 20;

/** Forget which drift entries were shown (tests). */
export function resetDriftLedger(): void {
  shown.clear();
}

/** Every drifting path, unscoped and uncapped; null when there is none or git cannot be read. */
function fullEntries(): { entries: DriftEntry[]; reminder: string; expected: number } | null {
  const report = buildDriftReport({ cap: false });
  if (!report) return null;
  const entries: DriftEntry[] = [
    ...report.paths,
    ...report.unowned.map((p) => ({ path: p, class: "unowned" })),
  ];
  return { entries, reminder: report.reminder, expected: report.expected };
}

/** Remember the entries as shown; entries that stopped drifting are forgotten, so a return is new. */
function markShown(entries: DriftEntry[], current: DriftEntry[]): Set<string> {
  const key = rootKey(resolveProjectRoot());
  const before = shown.get(key) ?? new Set<string>();
  const live = new Set(current.map(entryKey));
  const next = new Set([...before].filter((k) => live.has(k)));
  for (const e of entries) next.add(entryKey(e));
  shown.set(key, next);
  return before;
}

/**
 * The full drift report (`get_drift`, orient_for_work `sections: ["drift"]`): every path, each
 * recorded as shown. `{ count: 0, paths: [] }` when nothing drifts.
 */
export function fullDrift(): Record<string, unknown> {
  const all = fullEntries();
  if (!all) {
    shown.delete(rootKey(resolveProjectRoot()));
    return { count: 0, paths: [] };
  }
  markShown(all.entries, all.entries);
  return { count: all.entries.length, paths: all.entries, expected: all.expected, reminder: all.reminder };
}

/** `{ count, new_since_last_reply }`, or null when nothing drifts. */
export function leanDrift(): Record<string, unknown> | null {
  const all = fullEntries();
  if (!all || all.entries.length === 0) {
    shown.delete(rootKey(resolveProjectRoot()));
    return null;
  }
  const before = shown.get(rootKey(resolveProjectRoot())) ?? new Set<string>();
  const fresh = all.entries.filter((e) => !before.has(entryKey(e)));
  // A bounded list, so the reply budget never cuts it: only what is listed counts as shown, and the
  // rest is listed on the next replies (or by get_drift).
  const listed = fresh.slice(0, NEW_DRIFT_SHOWN);
  markShown(listed, all.entries);
  return {
    count: all.entries.length,
    new_since_last_reply: listed,
    ...(fresh.length > listed.length ? { more_new: fresh.length - listed.length } : {}),
    ...(fresh.length > 0 ? { reminder: all.reminder, full: "get_drift lists every path" } : {}),
  };
}

