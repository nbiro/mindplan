/**
 * Search index coverage (npm test): the derived cache syncs incrementally, drops vectors when the
 * model changes, recovers from a corrupt file, keeps itself out of git, ranks exact ids and paths
 * first, never serves a graph that changed outside MCP, and meets the timing budget on 1,000
 * nodes (incremental sync after one write < 200 ms, a search < 50 ms).
 */
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SearchIndex, embedText, ftsQuery } from "../../../dist/foundations/f-search-index/index-db.js";
import { keywordRankDocs, keywordTerms } from "../../../dist/foundations/f-search-index/keyword-js.js";
import { closeSearchIndexes } from "../../../dist/foundations/f-search-index/service.js";
import { fuseRankings, searchDocs, searchNodes, sectionHeadings } from "../../../dist/foundations/f-graph-search/search.js";
// Spawned servers rank by keyword only: no model download or load during tests.
process.env.MINDPLAN_SEARCH ??= "keyword";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `mindplan-search-${label}-`));
const ok = (label) => console.log(`ok   ${label}`);

const mkNode = (id, type, title, description, extra = {}) => ({
  id,
  type,
  title,
  description,
  state: "stable",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...extra,
});

/** Deterministic unit vectors from word hashes: enough for ranking plumbing, no model needed. */
function fakeEmbedder(dims = 32) {
  const calls = [];
  const vec = (text) => {
    const v = new Float32Array(dims);
    for (const w of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
      let h = 0;
      for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      v[h % dims] += 1;
    }
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  };
  return {
    calls,
    embedder: {
      model: "test/fake",
      dims,
      async embed(texts, kind) {
        calls.push({ kind, count: texts.length });
        return texts.map(vec);
      },
    },
  };
}

const graph = {
  version: 1,
  nodes: [
    mkNode("j-enquiries", "Journey", "Enquiries", "A visitor sends a form enquiry."),
    mkNode("i-send-enquiry", "Interaction", "Send an enquiry", "Visitor sends the business a message from the contact form.", {
      belongs_to: ["j-enquiries"],
      depends_on: ["f-mail"],
      implements: ["src/actions/i-send-enquiry/"],
    }),
    mkNode("f-mail", "Foundation", "Mail", "Adapter — sends form mail.", { implements: ["src/foundations/f-mail/"] }),
    mkNode("if-site", "Interface", "Public site", "The site template.", { exposes: ["i-send-enquiry"] }),
    mkNode("i-old", "Interaction", "Old enquiry form", "Send enquiry the old way.", { state: "deprecated" }),
  ],
  edges: [
    { source: "i-send-enquiry", target: "j-enquiries", type: "belongs_to" },
    { source: "i-send-enquiry", target: "f-mail", type: "depends_on" },
    { source: "if-site", target: "i-send-enquiry", type: "exposes" },
  ],
};

// --- pure helpers ---
assert.deepEqual(sectionHeadings("# T\n\n## Purpose\n\n## Booking rules\n## Booking rules\n## Atomic Ops\n"), ["Booking rules"]);
assert.equal(ftsQuery("the NEAR NOT"), '"near" OR "not"', "FTS syntax words are quoted terms, stopwords dropped");
assert.equal(ftsQuery("a the"), null);
// The JS BM25 (the keyword half where SQLite has no FTS5) ranks like FTS5's porter + unicode61.
assert.deepEqual(keywordTerms("Enquiries about Ofertă booking"), ["enquiri", "about", "oferta", "book"]);
{
  const jsDocs = searchDocs(graph);
  const live = new Set(jsDocs.filter((d) => !d.retired).map((d) => d.id));
  assert.equal(keywordRankDocs(jsDocs, "send enquiry", live, 5)[0], "i-send-enquiry", "JS BM25: id words and title match");
  assert.ok(keywordRankDocs(jsDocs, "enquiries", live, 5).includes("i-send-enquiry"), "JS BM25: stemming matches enquiry");
  assert.equal(keywordRankDocs(jsDocs, "old enquiry form", live, 5).includes("i-old"), false, "JS BM25: retired docs never rank");
}
const docs = searchDocs(graph);
const enquiry = docs.find((d) => d.id === "i-send-enquiry");
assert.deepEqual(enquiry.area, ["Enquiries"]);
assert.deepEqual(enquiry.entry, ["Public site"]);
assert.equal(docs.find((d) => d.id === "i-old").retired, true);
assert.match(embedText(enquiry), /^Interaction: Send an enquiry\. .* Area: Enquiries\. Entry points: Public site\.$/);
{
  const evolving = {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === "f-mail" ? { ...n, next: { state: "draft", title: "Mail delivery", description: "Adapter — delivers mail.", updated_at: n.updated_at } } : n
    ),
  };
  assert.equal(searchDocs(evolving).find((d) => d.id === "f-mail").title, "Mail delivery", "an open next is found by its new wording");
}
ok("search docs: headings, area, entry points, retired flag, next-slot wording");

{
  const docsMap = new Map(docs.map((d) => [d.id, d]));
  const clear = fuseRankings([["f-mail", "if-site", "i-send-enquiry", "j-enquiries"]], { docs: docsMap });
  assert.equal(clear[0].id, "f-mail", "the graph boost never reorders a clear winner");
  const tie = fuseRankings([["if-site", "i-send-enquiry"], ["i-send-enquiry", "if-site"]], { docs: docsMap });
  assert.equal(tie[0].id, "i-send-enquiry", "on an exact tie the node linked to more of the top 3 wins");
  const exact = fuseRankings([["f-mail"]], { docs: docsMap, exact: "j-enquiries" });
  assert.equal(exact[0].id, "j-enquiries", "an exact id is always first");
}
ok("rank fusion: clear winners stay, ties break toward linked nodes, exact id first");

// --- the cache ---
{
  const root = tmp("cache");
  const identity = { model: "test/fake", dims: 32 };
  const index = SearchIndex.open(root, identity);
  assert.ok(index, "node:sqlite is available on the supported Node versions");
  // Node 22.13's bundled SQLite has no FTS5; then the keyword half is the JS BM25 (checked above).
  const fts = index.fts;
  if (!fts) console.log("     note: this runtime's SQLite has no FTS5; the FTS5 row checks are skipped");
  assert.equal(
    fs.readFileSync(path.join(root, ".mindplan-cache", ".gitignore"), "utf-8").includes("*"),
    true,
    "the cache ignores itself"
  );
  assert.deepEqual(index.sync(docs).changed.length, docs.length);
  assert.deepEqual(index.sync(docs), { changed: [], removed: [] }, "an unchanged graph writes nothing");
  const edited = docs.map((d) => (d.id === "f-mail" ? { ...d, description: "Adapter — sends every form's mail." } : d));
  assert.deepEqual(index.sync(edited).changed, ["f-mail"]);
  assert.deepEqual(index.sync(edited.filter((d) => d.id !== "if-site")).removed, ["if-site"]);
  const live = new Set(edited.filter((d) => !d.retired && d.id !== "if-site").map((d) => d.id));
  if (fts) {
    assert.equal(index.keyword("send enquiry", live, 5)[0], "i-send-enquiry", "id words and title match");
    assert.equal(index.keyword("enquiries", live, 5).includes("i-send-enquiry"), true, "porter stemming matches enquiry");
    assert.equal(index.keyword("i-old", live, 5).includes("i-old"), false, "candidates exclude retired nodes");
  } else {
    assert.equal(index.keyword("send enquiry", live, 5), null, "without FTS5 the cache says so and the caller ranks in JS");
  }

  const stale = index.staleVectors();
  assert.equal(stale.length, live.size, "every live node starts without a vector");
  index.putVectors(stale.map((s, i) => ({ ...s, vector: new Float32Array(32).fill(i + 1) })));
  assert.equal(index.staleVectors().length, 0);
  const renamed = edited
    .filter((d) => d.id !== "if-site")
    .map((d) => (d.id === "j-enquiries" ? { ...d, title: "Leads" } : d));
  index.sync(renamed);
  assert.deepEqual(index.staleVectors().map((s) => s.id), ["j-enquiries"], "only changed text is re-embedded");
  index.close();

  const reopened = SearchIndex.open(root, identity);
  reopened.sync(renamed);
  assert.deepEqual(reopened.staleVectors().map((s) => s.id), ["j-enquiries"], "stored vectors survive a restart");
  reopened.close();
  const other = SearchIndex.open(root, { model: "test/other", dims: 32 });
  other.sync(edited);
  assert.equal(other.staleVectors().length, edited.filter((d) => !d.retired).length, "a new model drops every vector");
  other.close();

  fs.writeFileSync(path.join(root, ".mindplan-cache", "index.db"), "not a database");
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(path.join(root, ".mindplan-cache", `index.db${suffix}`), { force: true });
  const recovered = SearchIndex.open(root, identity);
  assert.ok(recovered, "a corrupt cache file is rebuilt");
  assert.equal(recovered.sync(docs).changed.length, docs.length);
  recovered.close();
  fs.rmSync(root, { recursive: true, force: true });
}
ok("cache: incremental sync, self-ignoring folder, stemming, vectors kept per text and dropped per model, corrupt file rebuilt");

// --- review regressions: SQL-side filters, rowid reuse across connections, orphan vectors ---
{
  const root = tmp("regress");
  const identity = { model: "test/fake" };
  const many = [];
  for (let i = 0; i < 300; i++) {
    many.push({ ...docs[1], id: `i-widget-${i}`, title: `Widget ${i}`, description: "Widget widget widget.", edges: [] });
  }
  many.push({ ...docs[1], id: "bug-widget", type: "Bug", title: "Widget bug", description: "A widget breaks.", edges: [] });
  const a = SearchIndex.open(root, identity);
  a.sync(many);
  const live = new Set(many.map((d) => d.id));
  if (a.fts) {
    assert.deepEqual(a.keyword("widget", live, 5, { type: "Bug" }), ["bug-widget"], "the type filter applies before the row limit");
  }

  // Two connections on one file: A removes the newest row and adds another; B's view must follow.
  const b = SearchIndex.open(root, identity);
  b.sync(many);
  const withoutBug = many.filter((d) => d.id !== "bug-widget");
  a.sync(withoutBug);
  const withZ = [...withoutBug, { ...docs[1], id: "i-zebra", title: "Zebra crossing", description: "Cross the road.", edges: [] }];
  a.sync(withZ);
  b.sync(withZ);
  const liveZ = new Set(withZ.map((d) => d.id));
  if (a.fts) {
    assert.deepEqual(a.keyword("zebra", liveZ, 5), ["i-zebra"], "a second connection's sync never deletes a reused row");
    assert.deepEqual(b.keyword("zebra", liveZ, 5), ["i-zebra"]);
  }
  // A stale second server drops i-zebra; this connection's own write in between must not hide
  // that change, so its next sync puts the row back.
  b.sync(withoutBug);
  a.putVectors([{ id: "i-zebra", hash: "h", vector: new Float32Array(8).fill(1) }]);
  const resync = a.sync(withZ);
  assert.ok(resync.changed.includes("i-zebra"), "another connection's write is never absorbed by an own commit");
  if (a.fts) assert.deepEqual(a.keyword("zebra", liveZ, 5), ["i-zebra"]);
  b.sync(withZ);

  // The vector hash names the model, so a vector a process on another model writes for the same
  // text (after this file was rebuilt for a new model) reads as stale and is embedded again.
  const m1 = SearchIndex.open(root, { model: "test/m1" }, { file: ":memory:" });
  const m2 = SearchIndex.open(root, { model: "test/m2" }, { file: ":memory:" });
  m1.sync(withZ);
  m2.sync(withZ);
  const m1Hash = m1.staleVectors().find((s) => s.id === "i-zebra").hash;
  m2.putVectors([{ id: "i-zebra", hash: m1Hash, vector: new Float32Array(8).fill(1) }]);
  assert.ok(m2.staleVectors().some((s) => s.id === "i-zebra"), "a vector made with another model is stale");
  m1.close();
  m2.close();

  // A vector computed for a node removed meanwhile is dropped, not stored as an orphan.
  b.putVectors([{ id: "bug-widget", hash: "x", vector: new Float32Array(8).fill(1) }]);
  assert.equal(b.semantic(new Float32Array(8).fill(1), new Set(["bug-widget"]), 5).length, 0);
  a.close();
  b.close();
  fs.rmSync(root, { recursive: true, force: true });
}
ok("cache: type filter before the row limit, rowid reuse across connections, no orphan vectors");

// --- offline mode loads a model that is already in the cache ---
{
  const cached = (() => {
    const dir = process.env.MINDPLAN_MODEL_CACHE ?? path.join(os.homedir(), ".cache", "mindplan", "models");
    return fs.existsSync(path.join(dir, "Xenova", "bge-small-en-v1.5", "onnx"));
  })();
  if (!cached) {
    console.log("skip offline model load: Xenova/bge-small-en-v1.5 is not in the model cache");
  } else {
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(new URL("../../../dist/foundations/f-search-index/embedder.js", import.meta.url).href)});` +
          `await m.warmModel(m.DEFAULT_SEARCH_MODEL); const e = m.readyEmbedder(m.DEFAULT_SEARCH_MODEL);` +
          `process.stdout.write(e ? String(e.dims) : JSON.stringify(m.modelStatus(m.DEFAULT_SEARCH_MODEL)));`,
      ],
      { env: { ...process.env, MINDPLAN_SEARCH_OFFLINE: "1" }, encoding: "utf-8", timeout: 120000 }
    );
    assert.equal(probe.stdout.trim(), "384", `offline mode loads the cached model (${probe.stdout}${probe.stderr.slice(-300)})`);
    ok("offline mode loads the cached model");
  }
}

// --- hybrid search over the cache ---
{
  const root = tmp("hybrid");
  const { embedder } = fakeEmbedder();
  const r = (q, opts = {}) => searchNodes(graph, q, { root, embedder, ...opts }).then((m) => m.map((x) => x.id));
  assert.equal((await r("i-send-enquiry"))[0], "i-send-enquiry", "exact id first");
  assert.equal((await r("src/foundations/f-mail/mail.ts"))[0], "f-mail", "a file path ranks its claim's owner first");
  assert.equal((await r("enquiry", { type: "Journey" }))[0], "j-enquiries", "the type filter applies before ranking");
  assert.equal((await r("old enquiry form")).includes("i-old"), false, "retired nodes never rank");
  const keywordOnly = await searchNodes(graph, "send enquiry", { root, embedder: null });
  assert.equal(keywordOnly[0].id, "i-send-enquiry", "keyword-only mode still ranks");
  assert.equal(typeof keywordOnly[0].score, "number");
  closeSearchIndexes();
  fs.rmSync(root, { recursive: true, force: true });
}
ok("searchNodes: exact id, path, type filter, retired nodes, keyword-only mode");

// --- timing on 1,000 nodes ---
{
  const root = tmp("perf");
  const nodes = [];
  for (let i = 0; i < 1000; i++) {
    nodes.push(
      mkNode(`i-action-${i}`, "Interaction", `Action number ${i} ${i % 7 === 0 ? "booking" : "listing"}`, `Visitor does thing ${i} with widgets ${i % 13}.`, {
        implements: [`src/actions/i-action-${i}/`],
      })
    );
  }
  const big = { version: 1, nodes, edges: [] };
  const { embedder } = fakeEmbedder(384);
  let t = performance.now();
  await searchNodes(big, "booking widgets", { root, embedder });
  const cold = performance.now() - t;
  big.nodes[500] = { ...big.nodes[500], title: "Renamed action", updated_at: "2026-02-01T00:00:00.000Z" };
  t = performance.now();
  await searchNodes(big, "renamed action", { root, embedder });
  const incremental = performance.now() - t;
  const runs = [];
  for (let i = 0; i < 5; i++) {
    t = performance.now();
    await searchNodes(big, `listing widgets ${i}`, { root, embedder });
    runs.push(performance.now() - t);
  }
  const search = runs.sort((a, b) => a - b)[2];
  console.log(`     1,000 nodes: cold index ${cold.toFixed(0)} ms, one-node update + search ${incremental.toFixed(0)} ms, search ${search.toFixed(1)} ms (median)`);
  assert.ok(incremental < 200, `an incremental update after one write takes under 200 ms (took ${incremental.toFixed(0)})`);
  assert.ok(search < 50, `a search takes under 50 ms (took ${search.toFixed(1)})`);
  closeSearchIndexes();
  fs.rmSync(root, { recursive: true, force: true });
}
ok("timing: incremental update < 200 ms and search < 50 ms on 1,000 nodes");

// --- MCP: the index follows edits made outside MCP, and stays out of changed_files ---
{
  const root = tmp("mcp");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(toolRoot, "dist/index.js")],
    env: { ...process.env, MINDPLAN_ROOT: root },
    stderr: "pipe",
  });
  const client = new Client({ name: "search-test", version: "0.1.0" });
  await client.connect(transport);
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    if (res.isError) throw new Error(`${name}: ${res.content[0].text}`);
    return JSON.parse(res.content[0].text);
  };
  const created = await call("create_node", { id: "j-shop", type: "Journey", title: "Shop", description: "Buying things." });
  assert.equal(created.changed_files.some((f) => f.includes(".mindplan-cache")), false, "the cache is never a changed file");
  await call("create_node", { id: "i-checkout", type: "Interaction", title: "Check out", description: "Shopper pays for the basket." });
  let found = await call("find_related_nodes", { query: "pay for basket" });
  assert.equal(found.focus, "i-checkout");
  assert.ok(fs.existsSync(path.join(root, ".mindplan-cache", "index.db")), "the cache lives in .mindplan-cache/");

  // A branch switch or git pull rewrites the file without MCP.
  const file = path.join(root, "mindplan", "interactions", "i-checkout", "i-checkout.mdx");
  fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replace("Shopper pays for the basket.", "Shopper redeems a gift voucher."));
  found = await call("find_related_nodes", { query: "gift voucher" });
  assert.equal(found.focus, "i-checkout", "an edit made outside MCP is searchable on the next call");
  const orient = await call("orient_for_work", { query: "gift voucher", depth: "rules" });
  assert.equal(orient.focus, "i-checkout");
  // A body-only edit (new section heading, frontmatter untouched) is searchable too.
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replace("## Purpose", "## Loyalty stamps\n\nCards.\n\n## Purpose"));
  found = await call("find_related_nodes", { query: "loyalty stamps" });
  assert.equal(found.focus, "i-checkout", "a heading added outside MCP is searchable on the next call");

  // An async handler's Blocked: takes the same error envelope as a synchronous one.
  const missing = await client.callTool({ name: "find_related_nodes", arguments: { node_id: "i-missing", query: "x" } });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /^Blocked:/);
  assert.equal(missing.structuredContent, undefined, "the error envelope is text-only");

  // Search settings round-trip through patch_config, and a sources-only write keeps them.
  const patched = await call("patch_config", { search: { enabled: false } });
  assert.deepEqual(patched.config.search, { enabled: false });
  const kept = await call("patch_config", { sources: ["src/**", "lib/**"] });
  assert.deepEqual(kept.config.search, { enabled: false }, "a partial write keeps the stored search settings");
  const merged = await call("patch_config", { search: { model: "Xenova/all-MiniLM-L6-v2" } });
  assert.deepEqual(merged.config.search, { enabled: false, model: "Xenova/all-MiniLM-L6-v2" });
  const typo = await client.callTool({ name: "patch_config", arguments: { search: { enable: true } } });
  assert.equal(typo.isError, true, "an unknown search key is rejected, not stripped");
  await client.close();

  // init adds the cache to .gitignore once and keeps what was there.
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/");
  const init = () =>
    spawnSync(process.execPath, [path.join(toolRoot, "dist/index.js"), "init", "--host", "claude"], {
      cwd: root,
      env: { ...process.env, MINDPLAN_ROOT: root },
      encoding: "utf-8",
    });
  assert.equal(init().status, 0);
  assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf-8"), "node_modules/\n# MindPlan search cache (derived; safe to delete)\n.mindplan-cache/\n");
  assert.equal(init().status, 0);
  assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf-8").match(/\.mindplan-cache/g).length, 1, "a rerun does not add it again");
  fs.rmSync(root, { recursive: true, force: true });
}
ok("MCP: outside edits reach search on the next call; async Blocked envelope; search settings; init ignores the cache once");

// --- MCP with semantic ranking on: calls answer while the model loads, stdout stays clean ---
{
  const root = tmp("semantic");
  const env = { ...process.env, MINDPLAN_ROOT: root, MINDPLAN_SEARCH_OFFLINE: "1" };
  delete env.MINDPLAN_SEARCH;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(toolRoot, "dist/index.js")],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "search-semantic-test", version: "0.1.0" });
  await client.connect(transport);
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    if (res.isError) throw new Error(`${name}: ${res.content[0].text}`);
    return JSON.parse(res.content[0].text);
  };
  await call("create_node", { id: "j-dining", type: "Journey", title: "Dining", description: "Eating out." });
  await call("create_node", { id: "i-book-table", type: "Interaction", title: "Book a table", description: "Guest books a table." });
  // Offline: a cached model loads in the background, a missing one fails quietly to stderr.
  // Either way every call answers, and a stray stdout line would break the JSON-RPC stream.
  for (let i = 0; i < 3; i++) {
    const found = await call("find_related_nodes", { query: "book a table" });
    assert.equal(found.focus, "i-book-table");
    await new Promise((r) => setTimeout(r, 1500));
  }
  await client.close();
  fs.rmSync(root, { recursive: true, force: true });
}
ok("MCP with semantic on: calls answer while the model loads or fails, over a clean stdout");

console.log("SEARCH INDEX TESTS PASSED");
