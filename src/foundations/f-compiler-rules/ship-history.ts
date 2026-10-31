/**
 * A node file's ship history from git, and what it says about the node's revisions: how often it
 * shipped, its decayed ship rate, and the ships at which a Foundation split parts out of itself.
 * Read by init's backfill and by clearing a wrong split record.
 */

import { churnAfterShip, type MindPlanGraph, type MindPlanNode } from "../f-domain-model/types.js";
import { claimCoversPath } from "../f-source-index/claims.js";
import { fileHistory } from "../f-source-index/git.js";
import { markdownRelativePath, parseFrontmatter } from "../f-territory-store/store.js";

/** One ship in a node file's history: its commit date, `shipped_at`, and edges and claims then. */
export type ShipRecord = { date: string; shipped_at: string; depends_on: string[]; implements: string[] };

/**
 * The ships in a node file's git history, oldest first: one per distinct `shipped_at` value, at the
 * first commit that has it (a side branch merging an older copy back does not count twice), parsed
 * with the store's own frontmatter reader. `null` outside git; `[]` when git has not seen the file.
 */
export function shipHistory(relPath: string): ShipRecord[] | null {
  const versions = fileHistory(relPath);
  if (versions === null) return null;
  const ships: ShipRecord[] = [];
  const seen = new Set<string>();
  for (const v of versions) {
    const parsed = parseFrontmatter(v.text);
    const shippedAt = parsed?.scalars.shipped_at;
    if (!parsed || !shippedAt || seen.has(shippedAt)) continue;
    seen.add(shippedAt);
    ships.push({
      date: v.date,
      shipped_at: shippedAt,
      depends_on: [...parsed.arrays.depends_on],
      implements: [...parsed.implements],
    });
  }
  return ships.sort((a, b) => a.shipped_at.localeCompare(b.shipped_at));
}

/** The ship history of a node's live file. */
export function nodeShipHistory(node: MindPlanNode): ShipRecord[] | null {
  return shipHistory(markdownRelativePath(node, "current"));
}

/** Two claim entries reach the same files: equal, one a folder holding the other, or a glob covering it. */
export function claimsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith("/") && b.startsWith(a)) return true;
  if (b.endsWith("/") && a.startsWith(b)) return true;
  return claimCoversPath(a, b) || claimCoversPath(b, a);
}

const covered = (claims: string[], entry: string) => claims.some((c) => claimsOverlap(c, entry));

/**
 * The ships (indexes into `ships`) at which a Foundation split parts out of itself, with the parts,
 * judged from claims rather than edges: at ship j it gained `depends_on` on a Foundation that first
 * shipped after ship j-1 and no later than ship j, and some claim that part had at its first ship
 * was covered by the node's claims at ship j-1 and is no longer covered at ship j. A node that only
 * starts using a new Foundation moved nothing, so it did not split. `partShips` holds the
 * history of each candidate part (missing: its live claims and live `shipped_at` stand in).
 */
export function inferredSplits(
  graph: MindPlanGraph,
  node: MindPlanNode,
  ships: ShipRecord[],
  partShips: Map<string, ShipRecord[] | null>
): Map<number, string[]> {
  const splits = new Map<number, string[]>();
  if (node.type !== "Foundation") return splits;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (let j = 1; j < ships.length; j++) {
    const before = ships[j - 1];
    const now = ships[j];
    const from = Date.parse(before.date);
    const to = Date.parse(now.date);
    const parts = now.depends_on.filter((id) => {
      const part = byId.get(id);
      if (!part || part.type !== "Foundation" || before.depends_on.includes(id)) return false;
      const first = partShips.get(id)?.[0];
      const firstAt = Date.parse(first ? first.date : part.shipped_at ?? "");
      if (!(firstAt > from && firstAt <= to)) return false;
      const partClaims = first ? first.implements : part.implements ?? [];
      return partClaims.some((c) => covered(before.implements, c) && !covered(now.implements, c));
    });
    if (parts.length > 0) splits.set(j, parts.sort());
  }
  return splits;
}

/**
 * The stored rate a node has after `shipTimes` (its `shipped_at` values, oldest first): each ship
 * decays the previous value and adds 1, and a ship in `splitShips` resets it to 0.
 */
export function replayChurn(shipTimes: string[], splitShips: Set<number>, halfLifeDays: number): number {
  let churn = 0;
  shipTimes.forEach((at, j) => {
    churn = splitShips.has(j) ? 0 : churnAfterShip(churn, j > 0 ? shipTimes[j - 1] : undefined, at, halfLifeDays);
  });
  return churn;
}

/** The ship times to replay: the history's, plus the live `shipped_at` when it is not committed yet. */
export function shipTimesOf(node: MindPlanNode, ships: ShipRecord[]): string[] {
  const times = ships.map((s) => s.shipped_at);
  if (node.shipped_at && times[times.length - 1] !== node.shipped_at) times.push(node.shipped_at);
  return times;
}
