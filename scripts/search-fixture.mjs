/**
 * Snapshot a MindPlan graph into a search-eval fixture: each node's record, edges, claims, and
 * section headings (the fields search indexes). Repo tooling; not shipped.
 *
 *   node scripts/search-fixture.mjs <project root> <out.json>
 */
import * as fs from "fs";
import * as path from "path";

const [rootArg, outArg] = process.argv.slice(2);
if (!rootArg || !outArg) {
  console.error("usage: node scripts/search-fixture.mjs <project root> <out.json>");
  process.exit(2);
}
process.env.MINDPLAN_ROOT = path.resolve(rootArg);
const store = await import("../dist/foundations/f-territory-store/store.js");

const graph = store.loadGraph();
const EDGE_FIELDS = ["belongs_to", "depends_on", "exposes", "leads_to", "mounts", "affects"];
const nodes = graph.nodes
  .map((n) => {
    const slot = n.next ? "next" : "current";
    const out = {
      id: n.id,
      type: n.type,
      title: n.title,
      description: n.description,
      state: n.state,
      created_at: n.created_at,
      updated_at: n.updated_at,
      body: store.withoutOwnedSections(store.splitContext(store.readMarkdown(n, slot))?.body ?? "")
        .split(/\r?\n/)
        .filter((line) => /^##\s/.test(line))
        .join("\n"),
    };
    if (n.shipped_at) out.shipped_at = n.shipped_at;
    if (n.role) out.role = n.role;
    for (const f of EDGE_FIELDS) if (n[f]?.length) out[f] = n[f];
    if (n.implements?.length) out.implements = n.implements;
    if (n.aliases?.length) out.aliases = n.aliases;
    if (n.next) out.next = { state: n.next.state, title: n.next.title, description: n.next.description, updated_at: n.next.updated_at };
    return out;
  })
  .sort((a, b) => a.id.localeCompare(b.id));
fs.writeFileSync(outArg, `${JSON.stringify({ source: path.basename(process.env.MINDPLAN_ROOT), nodes }, null, 1)}\n`);
console.log(`${nodes.length} nodes -> ${outArg}`);
