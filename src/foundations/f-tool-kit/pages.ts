/**
 * Reply budget — keeps one MCP reply under a size cap (`replies.budget_bytes`, default 8 KB). Past
 * the cap the longest lists are cut, the rest is kept in this session under a cursor, and the reply
 * says so in `truncated: [{ path, shown, total, cursor }]`; `next_page({ cursor })` returns the next
 * part. Rule text, failures, and changed_files are never cut: a reply may stay over the cap rather
 * than hide a rule or a Blocked line. Owned by f-tool-kit.
 */

/** Keys whose lists are never cut, wherever they sit in a reply. */
const PROTECTED_KEYS = new Set([
  "rules",
  "project_rules",
  "resolved_rules",
  "oriented_rules",
  "failures",
  "changed_files",
  "truncated",
]);

type Stored = { path: string; items: unknown[]; offset: number; total: number };

/** Cursor → the rest of a cut list. Bounded: the oldest cursors go first. */
const store = new Map<string, Stored>();
const MAX_STORED = 64;
let counter = 0;

/** Forget every stored page (tests). */
export function resetPages(): void {
  store.clear();
  counter = 0;
}

function keep(entry: Stored): string {
  counter += 1;
  const cursor = `p${counter.toString(36)}`;
  store.set(cursor, entry);
  while (store.size > MAX_STORED) store.delete(store.keys().next().value as string);
  return cursor;
}

const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? "", "utf-8");

type Candidate = { path: string; parent: Record<string, unknown> | unknown[]; key: string | number; list: unknown[]; bytes: number };

/** Every list in the reply that may be cut, with its path (`a.b.0.c`). */
function candidates(value: unknown, path: string, out: Candidate[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      if (Array.isArray(item)) out.push({ path: `${path}.${i}`, parent: value, key: i, list: item, bytes: size(item) });
      candidates(item, `${path}.${i}`, out);
    });
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (PROTECTED_KEYS.has(key)) continue;
    const childPath = path ? `${path}.${key}` : key;
    if (Array.isArray(child) && child.length > 1) {
      out.push({ path: childPath, parent: value as Record<string, unknown>, key, list: child, bytes: size(child) });
    }
    candidates(child, childPath, out);
  }
}

/** How many leading items of `list` fit in `room` bytes (at least one). */
function fitting(list: unknown[], room: number): number {
  let used = 2;
  for (let i = 0; i < list.length; i++) {
    used += size(list[i]) + 1;
    if (used > room) return Math.max(1, i);
  }
  return list.length;
}

/**
 * The reply cut to `budget` bytes: the largest lists first, each to what still fits, until the
 * reply is under the cap or nothing more can be cut. A string, number, or a reply already under the
 * cap comes back unchanged; `budget` 0 turns the cap off.
 */
export function budgetReply(payload: unknown, cap: number): unknown {
  let budget = cap;
  if (budget <= 0 || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  let total = size(payload);
  if (total <= budget) return payload;
  const reply = structuredClone(payload) as Record<string, unknown>;
  // What cutting can remove at most. Rule text and other protected parts stay whole, so when they
  // alone are near the cap the target becomes their size plus room for a little of each list:
  // cutting every list to one item would hide them without bringing the reply under the cap.
  const cuttable = (() => {
    const found: Candidate[] = [];
    candidates(reply, "", found);
    // Top-level-most lists only: a nested list's bytes are inside its parent's.
    const paths = found.map((c) => c.path);
    return found
      .filter((c) => !paths.some((p) => p !== c.path && c.path.startsWith(`${p}.`)))
      .reduce((sum, c) => sum + c.bytes, 0);
  })();
  budget = Math.max(budget, total - cuttable + 2048);
  if (total <= budget) return payload;
  const truncated: { path: string; shown: number; total: number; cursor: string }[] = [];
  const cut = new Set<string>();
  for (;;) {
    const found: Candidate[] = [];
    candidates(reply, "", found);
    const next = found
      .filter((c) => !cut.has(c.path) && c.list.length > 1)
      .sort((a, b) => b.bytes - a.bytes)[0];
    if (!next) break;
    const excess = total - budget + 400;
    const shown = fitting(next.list, Math.max(0, next.bytes - excess));
    cut.add(next.path);
    if (shown >= next.list.length) continue;
    const rest = next.list.slice(shown);
    const cursor = keep({ path: next.path, items: rest, offset: shown, total: next.list.length });
    truncated.push({ path: next.path, shown, total: next.list.length, cursor });
    (next.parent as Record<string | number, unknown>)[next.key] = next.list.slice(0, shown);
    total = size(reply) + size(truncated);
    if (total <= budget) break;
  }
  if (truncated.length === 0) return payload;
  reply.truncated = truncated;
  reply.next_page = `This reply was cut to about ${budget} bytes: next_page({ cursor }) returns the rest of each list in truncated.`;
  return reply;
}

/**
 * The next part of a cut list: `{ path, items, from, total, next_cursor? }`, as many items as fit
 * the budget (at least one). Blocked on an unknown or expired cursor.
 */
export function nextPage(cursor: string, budget: number): Record<string, unknown> {
  const entry = store.get(cursor);
  if (!entry) {
    throw new Error(
      `Blocked: cursor "${cursor}" is unknown or expired (cursors live for this session, the latest ${MAX_STORED} only). Repeat the original call.`
    );
  }
  const room = budget > 0 ? budget - 300 : Number.POSITIVE_INFINITY;
  const count = Number.isFinite(room) ? fitting(entry.items, room) : entry.items.length;
  const items = entry.items.slice(0, count);
  const rest = entry.items.slice(count);
  const out: Record<string, unknown> = { path: entry.path, from: entry.offset, items, total: entry.total };
  if (rest.length > 0) {
    out.next_cursor = keep({ path: entry.path, items: rest, offset: entry.offset + count, total: entry.total });
  }
  return out;
}
