/**
 * Search ranking eval (npm test): runs the test set in search-eval.json over the fixture graphs
 * in keyword-only mode (no model, the fallback) and hybrid mode (keyword + semantic, with the
 * committed fixture vectors), and fails when a metric drops below search-eval.metrics.json or the
 * hybrid ranking does not beat the committed baseline (the token ranking before hybrid search).
 * Needs no network: hybrid mode embeds from fixtures/search-eval.vectors.json.
 *
 * Flags (maintainers, with the model available):
 *   --write-vectors   embed every fixture node and query with the live model into the vectors file
 *   --write-metrics   commit the current keyword and hybrid numbers as the new floor
 *   --model <id>      live model for --write-vectors / --live (default: the search default)
 *   --live            hybrid mode with the live model instead of the fixture vectors
 */
import assert from "node:assert/strict";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { searchNodes } from "../../../dist/foundations/f-graph-search/search.js";
import { closeSearchIndexes } from "../../../dist/foundations/f-search-index/service.js";
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

async function runAll(embedder, label) {
  const ranked = [];
  for (const c of cases) {
    const { graph, readBody } = fixtures[c.graph];
    const matches = await searchNodes(graph, c.query, {
      root: path.join(roots[c.graph], label),
      readBody,
      limit: 20,
      embedder,
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

  const committed = JSON.parse(fs.readFileSync(METRICS_FILE, "utf-8"));
  const keyword = scoreRuns(cases, await runAll(null, "keyword"));
  report("keyword", keyword);

  let hybridEmbedder;
  let fixture = null;
  if (flag("--live")) {
    hybridEmbedder = await liveEmbedder(modelArg);
  } else {
    const file = JSON.parse(fs.readFileSync(VECTORS_FILE, "utf-8"));
    fixture = fixtureEmbedder(file);
    hybridEmbedder = fixture.embedder;
  }
  const hybridRuns = await runAll(hybridEmbedder, "hybrid");
  const hybrid = scoreRuns(cases, hybridRuns);
  report("hybrid", hybrid);
  if (fixture) {
    assert.equal(
      fixture.missing.size,
      0,
      `${fixture.missing.size} texts have no committed vector: the indexed text or the test set changed. ` +
        "Refresh with `node src/foundations/f-test-harness/search-eval.test.mjs --write-vectors` (needs the model)."
    );
  }

  if (flag("--write-metrics")) {
    const next = { ...committed, keyword: keyword.metrics, hybrid: hybrid.metrics };
    fs.writeFileSync(METRICS_FILE, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`wrote metrics floor -> ${METRICS_FILE}`);
  }

  for (const metric of ["top1", "top5", "mrr"]) {
    assert.ok(
      keyword.metrics[metric] >= committed.keyword[metric],
      `keyword ${metric} ${keyword.metrics[metric]} fell below the committed ${committed.keyword[metric]}`
    );
    if (!flag("--live")) {
      assert.ok(
        hybrid.metrics[metric] >= committed.hybrid[metric],
        `hybrid ${metric} ${hybrid.metrics[metric]} fell below the committed ${committed.hybrid[metric]}`
      );
    }
    assert.ok(
      hybrid.metrics[metric] > committed.baseline[metric],
      `hybrid ${metric} ${hybrid.metrics[metric]} does not beat the baseline ${committed.baseline[metric]}`
    );
  }
  const idx = (q) => cases.findIndex((c) => c.query === q);
  // "request a quote skyloom" shares no word with i-send-enquiry and the model does not bridge
  // quote to enquiry; it is reached through an alias (aliases.test.mjs).
  assert.equal(hybridRuns[idx("contact form quote request")][0], "i-send-enquiry", "contact form quote request ranks i-send-enquiry first");
  console.log("ok   search eval: keyword and hybrid at or above the committed floor; hybrid beats the baseline");
  console.log("SEARCH EVAL PASSED");
} finally {
  closeSearchIndexes();
  for (const dir of Object.values(roots)) fs.rmSync(dir, { recursive: true, force: true });
}
