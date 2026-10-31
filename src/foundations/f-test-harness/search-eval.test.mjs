/**
 * Search ranking eval (npm test): runs the test set in search-eval.json over the fixture graphs
 * in keyword-only mode (no model, the fallback) and hybrid mode (keyword + semantic, with the
 * committed fixture vectors), each with the JS BM25 keyword half and, where SQLite has FTS5, the
 * FTS5 one, and fails when a metric drops below search-eval.metrics.json or the
 * hybrid ranking does not beat the committed baseline (the token ranking before hybrid search).
 * Needs no network: hybrid mode embeds from fixtures/search-eval.vectors.json.
 *
 * Flags (maintainers, with the model available):
 *   --write-vectors   embed every fixture node and query with the live model into the vectors file
 *   --write-metrics   commit the current keyword and hybrid numbers as the new floor
 *   --model <id>      live model for --write-vectors / --live (default: the search default)
 *   --live            hybrid mode with the live model instead of the fixture vectors
 */
// Fixtures build graphs without a version stamp; the gate has its own suite (version.test.mjs).
process.env.MINDPLAN_VERSION_GATE ??= "off";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { searchNodes } from "../../../dist/foundations/f-graph-search/search.js";
import { closeSearchIndexes } from "../../../dist/foundations/f-search-index/service.js";
import { SearchIndex } from "../../../dist/foundations/f-search-index/index-db.js";
import { DEFAULT_SEARCH_MODEL, readyEmbedder, warmModel } from "../../../dist/foundations/f-search-index/embedder.js";
import { METRICS_FILE, VECTORS_FILE, loadCases, loadFixtureGraph, scoreRuns } from "./search-eval.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const modelArg = args.includes("--model") ? args[args.indexOf("--model") + 1] : DEFAULT_SEARCH_MODEL;

const cases = loadCases();
const graphNames = [...new Set(cases.map((c) => c.graph))];
const fixtures = Object.fromEntries(graphNames.map((g) => [g, loadFixtureGraph(g)]));
const roots = Object.fromEntries(
  graphNames.map((g) => [g, fs.mkdtempSync(path.join(os.tmpdir(), `mindplan-eval-${g}-`))])
);

const vectorKey = (kind, text) => `${kind}:${createHash("sha1").update(text).digest("hex")}`;

/** int8-quantized unit vectors as base64, so the committed file stays small. */
function encodeVector(v) {
  const q = Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * 127))));
  return Buffer.from(q.buffer).toString("base64");
}
function decodeVector(b64) {
  const bytes = Buffer.from(b64, "base64");
  const q = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Float32Array.from(q, (x) => x / 127);
}

async function liveEmbedder(model) {
  await warmModel(model);
  const embedder = readyEmbedder(model);
  if (!embedder) throw new Error(`model ${model} could not load (see stderr)`);
  return embedder;
}

/** Embedder over the committed vectors; records the keys it was asked for. */
function fixtureEmbedder(file) {
  const asked = new Set();
  const missing = new Set();
  const store = file.vectors;
  return {
    asked,
    missing,
    embedder: {
      model: file.model,
      dims: file.dims,
      async embed(texts, kind) {
        return texts.map((t) => {
          const key = vectorKey(kind, t);
          asked.add(key);
          if (!store[key]) {
            missing.add(key);
            return new Float32Array(file.dims);
          }
          return decodeVector(store[key]);
        });
      },
    },
  };
}

/** Records every text it embeds (for --write-vectors), delegating to the live model. */
function recordingEmbedder(inner, sink) {
  return {
    model: inner.model,
    dims: inner.dims,
    async embed(texts, kind) {
      const out = await inner.embed(texts, kind);
      texts.forEach((t, i) => (sink[vectorKey(kind, t)] = encodeVector(out[i])));
      return out;
    },
  };
}

async function runAll(embedder, label, engine = "auto") {
  const ranked = [];
  for (const c of cases) {
    const { graph, readBody } = fixtures[c.graph];
    const matches = await searchNodes(graph, c.query, {
      root: path.join(roots[c.graph], label),
      readBody,
      limit: 20,
      embedder,
      keywordEngine: engine,
    });
    ranked.push(matches.map((m) => m.id));
  }
  return ranked;
}

function report(label, result) {
  console.log(`${label}: ${JSON.stringify(result.metrics)}`);
  for (const m of result.misses) {
    console.log(`  miss (rank ${m.rank || "-"}) "${m.query}" -> ${m.got.join(", ")}`);
  }
}

try {
  if (flag("--write-vectors")) {
    const live = await liveEmbedder(modelArg);
    const sink = {};
    await runAll(recordingEmbedder(live, sink), `write-${Date.now()}`);
    fs.writeFileSync(
      VECTORS_FILE,
      `${JSON.stringify({ model: live.model, dims: live.dims, vectors: sink })}\n`
    );
    console.log(`wrote ${Object.keys(sink).length} vectors (${live.model}) -> ${VECTORS_FILE}`);
    process.exit(0);
  }

  let committed = JSON.parse(fs.readFileSync(METRICS_FILE, "utf-8"));
  // FTS5 depends on the SQLite build Node ships (Node 22.13's has none); the JS BM25 runs everywhere.
  const probe = SearchIndex.open(roots[graphNames[0]], { model: "probe" }, { file: ":memory:" });
  const fts = probe?.fts === true;
  probe?.close();

  let hybridEmbedder;
  let fixture = null;
  if (flag("--live")) {
    hybridEmbedder = await liveEmbedder(modelArg);
  } else {
    const file = JSON.parse(fs.readFileSync(VECTORS_FILE, "utf-8"));
    fixture = fixtureEmbedder(file);
    hybridEmbedder = fixture.embedder;
  }

  // Modes: keyword and hybrid, each with the FTS5 keyword half (when available) and the JS BM25.
  const modes = [
    { name: "keyword_js", embedder: null, engine: "js" },
    { name: "hybrid_js", embedder: hybridEmbedder, engine: "js" },
    ...(fts
      ? [
          { name: "keyword", embedder: null, engine: "auto" },
          { name: "hybrid", embedder: hybridEmbedder, engine: "auto" },
        ]
      : []),
  ];
  if (!fts) console.log("note: this runtime's SQLite has no FTS5; the FTS5 modes are skipped and search uses the JS BM25");
  const runs = {};
  const results = {};
  for (const mode of modes) {
    runs[mode.name] = await runAll(mode.embedder, mode.name, mode.engine);
    results[mode.name] = scoreRuns(cases, runs[mode.name]);
    report(mode.name, results[mode.name]);
  }
  if (fixture) {
    assert.equal(
      fixture.missing.size,
      0,
      `${fixture.missing.size} texts have no committed vector: the indexed text or the test set changed. ` +
        "Refresh with `node src/foundations/f-test-harness/search-eval.test.mjs --write-vectors` (needs the model)."
    );
  }

  if (flag("--write-metrics")) {
    const next = { ...committed };
    for (const mode of modes) next[mode.name] = results[mode.name].metrics;
    fs.writeFileSync(METRICS_FILE, `${JSON.stringify(next, null, 2)}\n`);
    committed = next;
    console.log(`wrote metrics floor -> ${METRICS_FILE}`);
  }

  for (const mode of modes) {
    const got = results[mode.name].metrics;
    const floor = committed[mode.name];
    assert.ok(floor, `no committed floor for ${mode.name}; run with --write-metrics`);
    for (const metric of ["top1", "top5", "mrr"]) {
      if (!(flag("--live") && mode.embedder)) {
        assert.ok(got[metric] >= floor[metric], `${mode.name} ${metric} ${got[metric]} fell below the committed ${floor[metric]}`);
      }
      if (mode.embedder) {
        assert.ok(
          got[metric] > committed.baseline[metric],
          `${mode.name} ${metric} ${got[metric]} does not beat the baseline ${committed.baseline[metric]}`
        );
      }
    }
  }
  const idx = (q) => cases.findIndex((c) => c.query === q);
  // The plan's measured misses: both rank i-send-enquiry first in hybrid mode, and in keyword-only
  // mode through its "quote" alias (the fixture gives it the aliases skyloom's node should carry).
  for (const name of fts ? ["hybrid", "hybrid_js"] : ["hybrid_js"]) {
    for (const q of ["contact form quote request", "request a quote skyloom"]) {
      assert.equal(runs[name][idx(q)][0], "i-send-enquiry", `${name}: "${q}" ranks i-send-enquiry first`);
    }
  }
  for (const name of fts ? ["keyword", "keyword_js"] : ["keyword_js"]) {
    assert.equal(runs[name][idx("request a quote skyloom")][0], "i-send-enquiry", `${name}: the "quote" alias ranks i-send-enquiry first`);
  }
  console.log("ok   search eval: every mode at or above its committed floor; hybrid beats the baseline");
  console.log("SEARCH EVAL PASSED");
} finally {
  closeSearchIndexes();
  for (const dir of Object.values(roots)) fs.rmSync(dir, { recursive: true, force: true });
}
