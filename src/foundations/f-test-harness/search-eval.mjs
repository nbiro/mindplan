/**
 * Search-eval helpers: load the fixture graphs and the test set, run a ranker over every case,
 * and score it (top1, top5, mrr). Used by search-eval.test.mjs and by the vector refresh
 * (`node src/foundations/f-test-harness/search-eval.test.mjs --write-vectors`).
 */
// Fixtures build graphs without a version stamp; the gate has its own suite (version.test.mjs).
process.env.MINDPLAN_VERSION_GATE ??= "off";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

export const here = path.dirname(fileURLToPath(import.meta.url));
export const EVAL_FILE = path.join(here, "search-eval.json");
export const METRICS_FILE = path.join(here, "search-eval.metrics.json");
export const VECTORS_FILE = path.join(here, "fixtures", "search-eval.vectors.json");

const EDGE_FIELDS = ["belongs_to", "depends_on", "exposes", "leads_to", "mounts", "affects"];

/** A fixture as a MindPlanGraph, plus each node's stored `##` heading lines. */
export function loadFixtureGraph(name) {
  const raw = JSON.parse(fs.readFileSync(path.join(here, "fixtures", `search-${name}.json`), "utf-8"));
  const bodies = new Map();
  const nodes = raw.nodes.map((n) => {
    bodies.set(n.id, n.body ?? "");
    const { body, ...node } = n;
    return node;
  });
  const ids = new Set(nodes.map((n) => n.id));
  const edges = [];
  for (const n of nodes) {
    for (const field of EDGE_FIELDS) {
      for (const target of n[field] ?? []) {
        if (ids.has(target)) edges.push({ source: n.id, target, type: field });
      }
    }
  }
  return { graph: { version: 1, nodes, edges }, readBody: (node) => bodies.get(node.id) ?? "" };
}

export function loadCases() {
  return JSON.parse(fs.readFileSync(EVAL_FILE, "utf-8")).cases;
}

/** Score ranked id lists against the cases: hit rates and mean reciprocal rank (first 20). */
export function scoreRuns(cases, rankedIds) {
  let top1 = 0;
  let top5 = 0;
  let rr = 0;
  const misses = [];
  cases.forEach((c, i) => {
    const ids = rankedIds[i].slice(0, 20);
    const rank = ids.findIndex((id) => c.expected.includes(id));
    if (rank === 0) top1++;
    if (rank >= 0 && rank < 5) top5++;
    if (rank >= 0) rr += 1 / (rank + 1);
    if (rank !== 0) misses.push({ query: c.query, expected: c.expected, got: ids.slice(0, 3), rank: rank + 1 });
  });
  const n = cases.length;
  const round = (x) => Math.round(x * 1000) / 1000;
  return { metrics: { top1: round(top1 / n), top5: round(top5 / n), mrr: round(rr / n) }, misses };
}
