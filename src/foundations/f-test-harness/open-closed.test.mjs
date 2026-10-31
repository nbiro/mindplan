/**
 * Open–closed signals: fan-in and churn from graph facts, the revision count and split record
 * (written at ship, backfilled by init from git), the hotspot warning, a change's additivity
 * summary, the open_next fan-in warning with its decision prompt, the hotspots config, and the
 * additive alternative in the decision gate's Blocked message. Run via npm test.
 */
import * as fs from "fs";
import { spawnSync } from "child_process";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// Spawned servers rank by keyword only: no model download or load during tests.
process.env.MINDPLAN_SEARCH ??= "keyword";
process.env.MINDPLAN_ORIENT_GATE ??= "off";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");
const oc = await import(pathToFileURL(path.join(toolRoot, "dist/foundations/f-compiler-rules/open-closed.js")).href);
const config = await import(pathToFileURL(path.join(toolRoot, "dist/foundations/f-source-index/config.js")).href);

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`ok   ${label}`);
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

// --- pure signals on an in-memory graph ---
{
  const NOW = new Date("2026-10-31T00:00:00.000Z");
  const decision = (id, change, date, text = `decision ${id}`, extra = {}) => ({
    id,
    decision: text,
    alternatives: ["other"],
    why: "because",
    change,
    date,
    ...extra,
  });
  const core = {
    id: "f-core",
    type: "Foundation",
    state: "stable",
    shipped_at: "2026-10-30T00:00:00.000Z",
    revisions: 9,
    churn: 6,
    decisions: [
      decision("d-1", "c-accounts", "2026-10-01", "Accounts live in the core schema."),
      decision("d-2", "c-media", "2026-10-02", "Media uploads go through the core adapter."),
      decision("d-3", "c-media", "2026-10-03"),
      decision("d-4", "c-cache", "2026-10-04"),
      decision("d-5", "c-site", "2026-10-05"),
      decision("d-6", "c-content", "2026-10-06"),
      { id: "d-old", decision: "No change id.", alternatives: ["x"], why: "y" },
    ],
  };
  // Forty established dependents, last shipped a month ago: the project's ordinary pace.
  const dependents = Array.from({ length: 40 }, (_, i) => ({
    id: `f-dep-${String(i).padStart(2, "0")}`,
    type: "Foundation",
    state: "stable",
    shipped_at: "2026-10-01T00:00:00.000Z",
    revisions: 3,
    churn: 1,
  }));
  // Auth: everything depends on it, and it ships at the same pace as the rest.
  const auth = { id: "f-auth", type: "Foundation", state: "stable", shipped_at: "2026-10-01T00:00:00.000Z", revisions: 4, churn: 1 };
  // A busy action nobody depends on.
  const busy = { id: "i-busy", type: "Interaction", state: "stable", shipped_at: "2026-10-30T00:00:00.000Z", revisions: 8, churn: 7 };
  const retired = { id: "f-gone", type: "Foundation", state: "deprecated", shipped_at: "2026-10-30T00:00:00.000Z", churn: 9 };
  const draft = { id: "f-new", type: "Foundation", state: "draft", change: "c-split" };
  const graph = {
    version: 1,
    nodes: [core, auth, busy, ...dependents, retired, draft],
    edges: [
      ...dependents.map((d) => ({ source: d.id, type: "depends_on", target: "f-core" })),
      ...dependents.map((d) => ({ source: d.id, type: "depends_on", target: "f-auth" })),
      { source: "f-gone", type: "depends_on", target: "f-core" },
      { source: "f-new", type: "depends_on", target: "f-core" },
    ],
  };
  const defaults = config.hotspotSettings({ sources: [], exclude: [] });
  check(
    "hotspot defaults are half_life_days 30, outlier_ratio 3, min_rate 2",
    defaults.half_life_days === 30 && defaults.outlier_ratio === 3 && defaults.min_rate === 2,
    JSON.stringify(defaults)
  );

  const fan = oc.fanIn(graph, core);
  check("fan-in counts active direct dependents only (40 + one draft, not the deprecated one)", fan.count === 41, JSON.stringify(fan.count));
  check(
    "fan-in from one index equals fan-in computed alone",
    oc.fanIn(graph, core, oc.fanInIndex(graph)).count === oc.fanIn(graph, core).count
  );

  const rate = oc.recentRate(core, defaults, NOW);
  check("the recent rate decays the stored churn from the last ship to now", rate > 5.8 && rate < 6, String(rate));
  check(
    "a month halves it",
    Math.abs(oc.recentRate(dependents[0], defaults, NOW) - 0.5) < 0.01,
    String(oc.recentRate(dependents[0], defaults, NOW))
  );
  check("an open revision adds one", oc.recentRate({ ...core, next: { state: "draft" } }, defaults, NOW) - rate === 1);
  check("a node with no stored churn has rate 0", oc.recentRate({ ...core, churn: undefined }, defaults, NOW) === 0);
  const median = oc.graphRateMedian(graph, defaults, NOW);
  check("the median rate is the project's ordinary pace", Math.abs(median - 0.5) < 0.01, String(median));
  const fresh = Array.from({ length: 60 }, (_, i) => ({
    id: `i-new-${i}`,
    type: "Interaction",
    state: "stable",
    shipped_at: "2026-10-31T00:00:00.000Z",
    revisions: 1,
    churn: 1,
  }));
  const justSplit = { id: "f-root", type: "Foundation", state: "stable", shipped_at: "2026-10-31T00:00:00.000Z", revisions: 5, split_at: 5, churn: 0 };
  check(
    "nodes shipped once and a root that just split leave the median alone",
    Math.abs(oc.graphRateMedian({ ...graph, nodes: [...graph.nodes, ...fresh, justSplit] }, defaults, NOW) - median) < 0.001
  );

  const churn = oc.nodeChurn(core);
  check(
    "change groups are the distinct change ids on the decisions, oldest first",
    churn.map((c) => c.change).join(",") === "c-accounts,c-media,c-cache,c-site,c-content",
    JSON.stringify(churn)
  );
  check("a group holds every decision recorded under its change", churn[1].reasons.length === 2, JSON.stringify(churn[1]));
  check("a never-shipped node's own change is no group", oc.nodeChurn(draft).length === 0);

  const ctx = oc.hotspotContext(graph, defaults, NOW);
  const hotspot = oc.hotspotFor(graph, core, defaults, ctx);
  check("a node shipping far above the median is a hotspot", hotspot?.fan_in === 41 && hotspot.rate === 5.9, JSON.stringify(hotspot));
  const warning = hotspot ? oc.hotspotWarning(hotspot) : "";
  check(
    "the warning gives the pace against the median, the recent change groups, and a downward split",
    warning.startsWith('hotspot: "f-core" ships far more often than the rest of the graph lately (rate 5.9 against a median of 0.5), and 41 nodes depend on it directly;') &&
      warning.includes('change "c-cache" (decision d-4), change "c-site" (decision d-5), change "c-content" (decision d-6)') &&
      !warning.includes("c-accounts") &&
      warning.includes('its own Foundation that "f-core" depends_on') &&
      warning.includes("keep_whole: true"),
    warning
  );
  check("auth, depended on by everything at the ordinary pace, is no hotspot", oc.hotspotFor(graph, auth, defaults, ctx) === null);
  const busyHot = oc.hotspotFor(graph, busy, defaults, ctx);
  check(
    "fan-in never gates: a busy action nobody depends on is a hotspot, with advice for an Interaction",
    busyHot?.fan_in === 0 && oc.hotspotWarning(busyHot).includes("separate Interactions, one behavior each"),
    JSON.stringify(busyHot)
  );
  check(
    "hotspots rank by rate times fan-in",
    oc.hotspots(graph, defaults, NOW).map((h) => h.node_id).join(",") === "f-core,i-busy"
  );
  check(
    "the same node busy a year ago is no hotspot now",
    oc.hotspotFor(graph, { ...core, shipped_at: "2025-10-30T00:00:00.000Z" }, defaults, ctx) === null
  );
  check("a higher outlier ratio clears it", oc.hotspotFor(graph, core, { ...defaults, outlier_ratio: 7 }, ctx) === null);
  check("a pre-ship node is never a hotspot", oc.hotspotFor(graph, draft, defaults, ctx) === null);
  check("a retired node is never a hotspot", oc.hotspotFor(graph, retired, defaults, ctx) === null);
  check(
    "a split resets the stored churn, so the root is no hotspot",
    oc.hotspotFor(graph, { ...core, churn: 0, split_at: 9, split_into: ["f-a"] }, defaults, ctx) === null
  );
  const afterSplit = oc.hotspotFor(graph, { ...core, churn: 4, split_at: 5, split_into: ["f-a", "f-b"] }, defaults, ctx);
  check(
    "a root busy again after its split names the parts",
    afterSplit !== null && oc.hotspotWarning(afterSplit).includes("since it split into f-a, f-b"),
    JSON.stringify(afterSplit)
  );

  const kept = { ...core, decisions: [...core.decisions, decision("d-keep", "c-keep", "2026-10-20", "Core stays one node.", { keep_whole: true })] };
  const keptGraph = { ...graph, nodes: graph.nodes.map((n) => (n.id === "f-core" ? kept : n)) };
  check(
    "an active keep_whole decision exempts the node",
    oc.hotspotFor(keptGraph, kept, defaults, oc.hotspotContext(keptGraph, defaults, NOW)) === null
  );
  const superseding = { ...auth, decisions: [decision("d-unkeep", "c-x", "2026-10-25", "Split the core after all.", { supersedes: "d-keep" })] };
  const unkeptGraph = { ...keptGraph, nodes: keptGraph.nodes.map((n) => (n.id === "f-auth" ? superseding : n)) };
  check(
    "superseding the keep_whole decision makes it a hotspot again",
    oc.hotspotFor(unkeptGraph, kept, defaults, oc.hotspotContext(unkeptGraph, defaults, NOW)) !== null
  );

  const ocw = oc.openClosedWarning(graph, core, defaults);
  check(
    "openClosedWarning names the pace, the reach, and the depends_on alternative",
    ocw?.startsWith('Warning: "f-core" ships') && ocw.includes("reaches its 41 direct dependents") && ocw.includes('a new node that depends_on "f-core"'),
    ocw ?? "null"
  );
  check("openClosedWarning is null for auth at the ordinary pace", oc.openClosedWarning(graph, auth, defaults) === null);

  // Additivity: f-new is a new node of c-split, f-core a reopened shipped node, f-dep-00 a neighbor.
  const split = {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (n.id === "f-core") return { ...n, next: { state: "draft", change: "c-split" } };
      if (n.id === "f-dep-00") return { ...n, change: "c-split" };
      return n;
    }),
  };
  const add = oc.changeAdditivity(split, "c-split");
  check(
    "the additivity summary counts new nodes, revised shipped nodes with fan-in, and neighbors",
    add.summary === 'change "c-split": 1 new node, 1 revised shipped node (f-core, fan-in 41), 1 neighbor',
    add.summary
  );
  const additiveOnly = oc.changeAdditivity(graph, "c-split");
  check(
    "a change that reopens nothing shipped is purely additive",
    additiveOnly.summary === 'change "c-split": 1 new node, 0 revised shipped nodes, 0 neighbors; purely additive' &&
      additiveOnly.revised.length === 0,
    additiveOnly.summary
  );
}

// --- what each type splits into ---
{
  const journey = { id: "j-a", type: "Journey", state: "stable" };
  const root = { id: "i-root", type: "Interaction", state: "stable", shipped_at: "2026-10-01T00:00:00.000Z", belongs_to: ["j-a"], next: { state: "draft", belongs_to: ["j-a"], split_into: ["i-part", "i-far"] } };
  const part = { id: "i-part", type: "Interaction", state: "stable", shipped_at: "2026-10-30T00:00:00.000Z", belongs_to: ["j-a"] };
  const far = { id: "i-far", type: "Interaction", state: "stable", shipped_at: "2026-10-30T00:00:00.000Z", belongs_to: ["j-b"] };
  const lib = { id: "f-lib", type: "Foundation", state: "stable", shipped_at: "2026-10-30T00:00:00.000Z" };
  const entry = { id: "if-entry", type: "Interface", state: "stable", shipped_at: "2026-10-01T00:00:00.000Z", exposes: ["i-root"], next: { state: "draft", exposes: ["i-root", "i-part"] } };
  const g = { version: 1, nodes: [journey, root, part, far, lib, entry], edges: [] };
  check("an Interaction splits into Interactions", oc.splitPartProblem(g, root, "i-part") === null);
  check("an Interaction cannot split into a Foundation", oc.splitPartProblem(g, root, "f-lib")?.includes("not another active Interaction"));
  check("an Interface splits into Interactions", oc.splitPartProblem(g, entry, "i-part") === null);
  check("a part sharing the Interaction's area counts at ship", oc.splitPartLinked(g, root, "i-part") === true);
  check("a part in another area does not count yet", oc.splitPartLinked(g, root, "i-far") === false);
  check("an Interface's part counts once it exposes it", oc.splitPartLinked(g, entry, "i-part") === true && oc.splitPartLinked(g, entry, "i-far") === false);
  check("the hint names the edge each type needs", oc.splitLinkHint(root).includes("belongs_to") && oc.splitLinkHint(entry).includes("exposes"));
}

// --- config validation ---
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-open-closed-config-"));
  fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
  const cfgFile = path.join(root, "mindplan", "config.json");
  const load = (obj) => {
    fs.writeFileSync(cfgFile, JSON.stringify(obj));
    try {
      return config.loadProjectConfig(root);
    } catch (err) {
      return err;
    }
  };
  const plain = load({ sources: ["src/**"], exclude: [] });
  check("a config without hotspots loads without them", !(plain instanceof Error) && plain.hotspots === undefined);
  for (const [label, hotspots] of [
    ["zero", { outlier_ratio: 0 }],
    ["negative", { min_rate: -1 }],
    ["string", { half_life_days: "30" }],
    ["unknown key", { fan_in: 3 }],
  ]) {
    const res = load({ sources: [], exclude: [], hotspots });
    check(`a ${label} hotspots setting is Blocked as invalid config`, res instanceof Error && res.message.startsWith("Blocked: invalid"), String(res?.message ?? res));
  }
  const ok = load({ sources: [], exclude: [], hotspots: { outlier_ratio: 2.5 } });
  const settings = config.hotspotSettings(ok);
  check("a stored setting overrides only its default", settings.outlier_ratio === 2.5 && settings.half_life_days === 30 && settings.min_rate === 2);
}

// --- through the MCP server ---
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-open-closed-"));
console.log("Open-closed sandbox:", root);
fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
fs.writeFileSync(path.join(root, "mindplan", "config.json"), JSON.stringify({ sources: ["src/**"], exclude: [] }, null, 2) + "\n");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, MINDPLAN_ROOT: root },
});
const client = new Client({ name: "open-closed-test", version: "0.1.0" });
await client.connect(transport);

async function raw(tool, args) {
  const res = await client.callTool({ name: tool, arguments: args });
  return { error: Boolean(res.isError), text: res.content?.[0]?.text ?? "" };
}
async function call(tool, args) {
  const res = await raw(tool, args);
  if (res.error) throw new Error(`${tool}: ${res.text}`);
  return JSON.parse(res.text || "{}");
}

function write(rel, content) {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** A Foundation that claims its own source file, its scaffold filled and every box ticked, at draft. */
async function foundation(id) {
  await call("create_node", { id, type: "Foundation", title: id, description: `Infra — ${id}`, role: "infra" });
  write(`src/${id}/index.ts`, `export const ${id.replace(/-/g, "_")} = 1;\n`);
  await call("set_implementation_files", { node_id: id, files: [`src/${id}/`] });
  const file = path.join(root, "mindplan", "foundations", id, `${id}.mdx`);
  let text = fs.readFileSync(file, "utf-8");
  text = text.replace(/^_.*?_$/gm, (line) => (line.includes("attachments/") ? line : "Open-closed filled territory."));
  fs.writeFileSync(file, text.replaceAll("- [ ]", "- [x]"));
}
async function ship(id) {
  for (const new_status of ["ready", "in-progress", "in-review", "ship"]) {
    await call("update_node_status", { node_id: id, new_status });
  }
}

try {
  await foundation("f-core");
  await ship("f-core");
  for (const id of ["f-a", "f-b"]) {
    await foundation(id);
    await call("link_nodes", { source_id: id, target_id: "f-core", edge_type: "depends_on" });
    await ship(id);
  }
  await call("record_decision", { node_id: "f-core", decision: "Accounts live in the core.", alternatives: ["A separate node"], why: "One schema.", change: "c-1" });
  await call("record_decision", { node_id: "f-core", decision: "Media goes through the core.", alternatives: ["A media node"], why: "One adapter.", change: "c-2" });
  await call("patch_node_territory", { node_id: "f-core", change: "" });

  const record = (await call("orient_for_work", { node_id: "f-core", depth: "rules" })).context.record;
  check("first ship writes revisions: 1 and churn: 1", record.revisions === 1 && record.churn === 1, JSON.stringify(record));

  const cleanCheck = await call("run_check", {});
  check("nodes at one pace print no hotspot warning", !cleanCheck.warnings.some((w) => w.startsWith("hotspot:")), JSON.stringify(cleanCheck.warnings));

  const below = await call("open_next", { node_id: "f-a", change: "c-x" });
  check("open_next on a node at the graph's pace has no warnings or decision_prompt", below.warnings === undefined && below.decision_prompt === undefined, JSON.stringify(below));
  await call("discard_next", { node_id: "f-a" });

  const patched = await call("patch_config", { hotspots: { outlier_ratio: 1.5, min_rate: 1.5 } });
  check(
    "patch_config writes hotspots and keeps sources",
    patched.config.hotspots?.outlier_ratio === 1.5 && patched.config.hotspots?.min_rate === 1.5 && patched.config.sources[0] === "src/**",
    JSON.stringify(patched.config)
  );
  const rejected = await raw("patch_config", { hotspots: { fan_in: 2 } });
  check("patch_config rejects an unknown hotspots key", rejected.error && rejected.text.includes("fan_in"), rejected.text);
  const zero = await raw("patch_config", { hotspots: { outlier_ratio: 0 } });
  check("patch_config rejects a setting that is not positive", zero.error && zero.text.includes("outlier_ratio"), zero.text);
  const later = await call("patch_config", { decisions: { blast_radius: 7 } });
  check(
    "a later patch_config without hotspots keeps the stored settings",
    later.config.hotspots?.outlier_ratio === 1.5 && later.config.decisions?.blast_radius === 7,
    JSON.stringify(later.config)
  );
  const both = await call("patch_config", { hotspots: { min_rate: 1.5 } });
  check("patch_config with hotspots keeps stored decisions", both.config.decisions?.blast_radius === 7, JSON.stringify(both.config));

  // Opening f-core makes it ship faster than its neighbors: rate 2 against a median of 1.
  const opened = await call("open_next", { node_id: "f-core", change: "c-3" });
  check(
    "open_next on a node shipping above the graph's pace warns and returns the decision prompt",
    opened.warnings?.[0]?.startsWith('Warning: "f-core" ships') &&
      opened.warnings[0].includes("reaches its 2 direct dependents") &&
      opened.decision_prompt?.tool === "record_decision" &&
      opened.decision_prompt.args.node_id === "f-core" &&
      opened.decision_prompt.args.change === "c-3" &&
      opened.decision_prompt.args.alternatives[0].includes('depends_on "f-core"') &&
      opened.next_state === "draft",
    JSON.stringify(opened)
  );

  const hotCheck = await call("run_check", {});
  const hot = hotCheck.warnings.find((w) => w.startsWith('hotspot: "f-core"'));
  check(
    "run_check warns about the hotspot with its recent change groups, and ok stays true",
    hotCheck.ok &&
      hot?.includes("(rate 2 against a median of 0)") &&
      hot.includes('change "c-2" (Media goes through the core.)') &&
      hotCheck.output.includes("Warning: hotspot:"),
    JSON.stringify(hotCheck.warnings)
  );

  const oriented = await call("orient_for_work", { node_id: "f-core" });
  check(
    "a full orient reply carries stability with the rate, the median, and the hotspot line",
    oriented.stability?.fan_in === 2 &&
      oriented.stability?.rate === 2 &&
      oriented.stability?.median_rate === 0 &&
      oriented.stability?.revisions === 1 &&
      oriented.stability?.hotspot?.startsWith("hotspot:"),
    JSON.stringify(oriented.stability)
  );
  const shallow = await call("orient_for_work", { node_id: "f-core", depth: "body" });
  check("depth body leaves stability out", shallow.stability === undefined);

  await foundation("f-new");
  await call("patch_node_territory", { node_id: "f-new", change: "c-3" });
  await call("patch_node_territory", { node_id: "f-a", change: "c-3" });
  const radius = await call("get_blast_radius", { change: "c-3" });
  check(
    "the change blast radius carries the additivity summary",
    radius.additivity?.summary === 'change "c-3": 1 new node, 1 revised shipped node (f-core, fan-in 2), 1 neighbor' &&
      radius.additivity.new_nodes[0] === "f-new",
    JSON.stringify(radius.additivity)
  );
  const changeCheck = await call("run_check", { change: "c-3" });
  check(
    "run_check({ change }) prints the additivity info line and carries change.additivity",
    changeCheck.info.includes(`additivity: ${radius.additivity.summary}`) &&
      changeCheck.output.includes("Info: additivity:") &&
      changeCheck.change?.additivity?.summary === radius.additivity.summary,
    JSON.stringify(changeCheck.info)
  );

  // The in-review gate on a shipped Foundation's revision names the additive alternative.
  await call("patch_node_territory", { node_id: "f-core", toggle_checkboxes: [{ contains: "- [ ]", checked: true, all: true }] });
  for (const new_status of ["ready", "in-progress"]) await call("update_node_status", { node_id: "f-core", new_status });
  const gate = await raw("update_node_status", { node_id: "f-core", new_status: "in-review" });
  check(
    "Blocked: Decision on a shipped Foundation names the additive alternative",
    gate.error && gate.text.includes("Blocked: Decision.") && gate.text.includes('An additive alternative leaves "f-core" closed'),
    gate.text
  );

  // keep_whole: the owner decides the node stays one node.
  const keep = await call("record_decision", {
    node_id: "f-core",
    id: "d-core-stays-whole",
    decision: "The core stays one node.",
    alternatives: ["Split it by collection"],
    why: "Every change touches one schema.",
    change: "c-3",
    keep_whole: true,
  });
  check("record_decision writes keep_whole", keep.decision?.keep_whole === true, JSON.stringify(keep.decision));
  const keptCheck = await call("run_check", {});
  check("an active keep_whole decision silences the hotspot", !keptCheck.warnings.some((w) => w.startsWith('hotspot: "f-core"')), JSON.stringify(keptCheck.warnings));
  await call("record_decision", {
    node_id: "f-core",
    decision: "Split media out of the core.",
    alternatives: ["Keep the core whole"],
    why: "Every feature queued on it.",
    change: "c-3",
    supersedes: "d-core-stays-whole",
  });
  const unkept = await call("run_check", {});
  check("superseding it brings the hotspot back", unkept.warnings.some((w) => w.startsWith('hotspot: "f-core"')), JSON.stringify(unkept.warnings));

  // Splitting a part out of f-core: the part ships first, then the root's revision that depends_on it.
  await foundation("f-part");
  await ship("f-part");
  const early = await call("patch_node_territory", { node_id: "f-core", split_into: ["f-part"] });
  check("marking a part the revision does not depend_on yet warns", early.warnings?.[0]?.includes('does not yet depend_on it (link_nodes depends_on) for "f-part"'), JSON.stringify(early));
  await call("link_nodes", { source_id: "f-core", target_id: "f-part", edge_type: "depends_on" });
  const notFoundation = await raw("patch_node_territory", { node_id: "f-core", split_into: ["f-core"] });
  check("split_into on the node itself is Blocked", notFoundation.error && notFoundation.text.includes("not another active Foundation"), notFoundation.text);
  const noRevision = await raw("patch_node_territory", { node_id: "f-a", split_into: ["f-part"] });
  check("split_into without an open revision is Blocked", noRevision.error && noRevision.text.includes("open_next first"), noRevision.text);
  const unlinkedMark = await call("patch_node_territory", { node_id: "f-core", split_into: ["f-lonely-part-missing"] }).catch((e) => ({ error: String(e) }));
  check("split_into on a missing node is Blocked", String(unlinkedMark.error ?? "").includes("not another active Foundation"), JSON.stringify(unlinkedMark));
  const marked = await call("patch_node_territory", { node_id: "f-core", split_into: ["f-part"] });
  check(
    "split_into marks the revision and keeps it in progress",
    marked.split_into?.join(",") === "f-part" && marked.next_state === "in-progress" && marked.changed_files.includes("mindplan/foundations/f-core/f-core.next.mdx"),
    JSON.stringify(marked)
  );
  for (const new_status of ["in-review", "ship"]) await call("update_node_status", { node_id: "f-core", new_status });
  const split = await call("orient_for_work", { node_id: "f-core" });
  check(
    "promoting a revision that depends_on a part shipped under it records the split and resets churn",
    split.context.record.revisions === 2 &&
      split.context.record.split_at === 2 &&
      split.context.record.split_into?.join(",") === "f-part" &&
      split.context.record.churn === 0 &&
      split.stability?.rate === 0 &&
      split.stability?.hotspot === undefined,
    JSON.stringify({ record: split.context.record, stability: split.stability })
  );
  const afterSplit = await call("run_check", {});
  check("after the split run_check no longer reports the root as a hotspot", !afterSplit.warnings.some((w) => w.startsWith('hotspot: "f-core"')), JSON.stringify(afterSplit.warnings));
  const part = (await call("orient_for_work", { node_id: "f-part", depth: "rules" })).context.record;
  check("a part's first ship counts one revision", part.revisions === 1 && part.churn === 1, JSON.stringify(part));

  // A revision that only starts using a new building block splits nothing.
  await call("open_next", { node_id: "f-a", change: "c-4" });
  await foundation("f-lib");
  await ship("f-lib");
  await call("link_nodes", { source_id: "f-a", target_id: "f-lib", edge_type: "depends_on" });
  await call("patch_node_territory", { node_id: "f-a", toggle_checkboxes: [{ contains: "- [ ]", checked: true, all: true }] });
  await call("record_decision", { node_id: "f-a", decision: "Use the new lib.", alternatives: ["Inline it"], why: "Shared.", change: "c-4" });
  for (const new_status of ["ready", "in-progress", "in-review", "ship"]) await call("update_node_status", { node_id: "f-a", new_status });
  const user = (await call("orient_for_work", { node_id: "f-a", depth: "rules" })).context.record;
  check(
    "a revision that gains a new dependency without split_into records no split and counts the ship",
    user.revisions === 2 && user.split_at === undefined && user.split_into === undefined && user.churn > 1.9,
    JSON.stringify(user)
  );

  // force_unship then reship counts one more ship and keeps the rate instead of resetting it.
  await call("force_unship", { node_id: "f-b", confirm: "unship:f-b", new_status: "ready" });
  const unshipped = (await call("orient_for_work", { node_id: "f-b", depth: "rules" })).context.record;
  check("force_unship keeps the rate with the time it is as of", unshipped.churn > 0.9 && typeof unshipped.churn_at === "string", JSON.stringify(unshipped));
  await call("patch_node_territory", { node_id: "f-b", toggle_checkboxes: [{ contains: "- [ ]", checked: true, all: true }] });
  for (const new_status of ["ready", "in-progress", "in-review", "ship"]) await call("update_node_status", { node_id: "f-b", new_status });
  const reshipped = (await call("orient_for_work", { node_id: "f-b", depth: "rules" })).context.record;
  check(
    "a reship after force_unship counts a second ship, keeps the rate, and drops churn_at",
    reshipped.revisions === 2 && reshipped.churn > 1.9 && reshipped.churn_at === undefined,
    JSON.stringify(reshipped)
  );
} finally {
  await client.close();
}

// --- the stored churn ---
{
  const types = await import(pathToFileURL(path.join(toolRoot, "dist/foundations/f-domain-model/types.js")).href);
  const yearLater = types.churnAfterShip(3, "2025-10-31T00:00:00.000Z", "2026-10-31T00:00:00.000Z", 30);
  check("a ship a year after the last one carries almost nothing over", yearLater > 1 && yearLater < 1.01, String(yearLater));
  check("a first ship stores 1", types.churnAfterShip(undefined, undefined, "2026-10-31T00:00:00.000Z", 30) === 1);
  check("a ship one half-life later carries half", types.churnAfterShip(2, "2026-10-01T00:00:00.000Z", "2026-10-31T00:00:00.000Z", 30) === 2);
}

// --- init backfills revisions and splits from git ---
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-open-closed-git-"));
  const git = (args, date) =>
    spawnSync("git", args, {
      cwd: repo,
      encoding: "utf-8",
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  const nodeFile = (id, shippedAt, dependsOn = []) => {
    const lines = [
      "---",
      `id: ${id}`,
      "type: Foundation",
      `title: "${id}"`,
      `description: "Infra — ${id}"`,
      "state: stable",
      `shipped_at: ${shippedAt}`,
      "created_at: 2026-01-01T00:00:00.000Z",
      `updated_at: ${shippedAt}`,
      ...(dependsOn.length ? ["depends_on:", ...dependsOn.map((d) => `  - ${d}`)] : []),
      "role: infra",
      "---",
      "",
      `# ${id}`,
      "",
    ];
    const rel = path.join(repo, "mindplan", "foundations", id, `${id}.mdx`);
    fs.mkdirSync(path.dirname(rel), { recursive: true });
    fs.writeFileSync(rel, lines.join("\n"));
  };
  fs.mkdirSync(path.join(repo, "mindplan"), { recursive: true });
  fs.writeFileSync(path.join(repo, "mindplan", "config.json"), JSON.stringify({ sources: [], exclude: [] }) + "\n");
  git(["init", "-q"], "2026-01-01T00:00:00Z");
  nodeFile("f-root", "2026-01-02T00:00:00.000Z");
  git(["add", "-A"], "2026-01-02T00:00:00Z");
  git(["commit", "-qm", "ship 1"], "2026-01-02T00:00:00Z");
  // A side branch that merges an older copy back (no shipped_at, then the same one) is not a ship.
  const rootFile = path.join(repo, "mindplan", "foundations", "f-root", "f-root.mdx");
  const shipped1 = fs.readFileSync(rootFile, "utf-8");
  fs.writeFileSync(rootFile, shipped1.replace(/^shipped_at:.*\n/m, ""));
  git(["commit", "-qam", "older copy"], "2026-01-02T06:00:00Z");
  fs.writeFileSync(rootFile, shipped1);
  git(["commit", "-qam", "same ship again"], "2026-01-02T12:00:00Z");
  nodeFile("f-root", "2026-01-03T00:00:00.000Z");
  git(["commit", "-qam", "ship 2"], "2026-01-03T00:00:00Z");
  nodeFile("f-a", "2026-01-04T00:00:00.000Z");
  nodeFile("f-b", "2026-01-04T00:00:00.000Z");
  nodeFile("f-root", "2026-01-04T00:00:00.000Z", ["f-a", "f-b"]);
  git(["add", "-A"], "2026-01-04T00:00:00Z");
  git(["commit", "-qm", "ship 3: split"], "2026-01-04T00:00:00Z");
  const init = () =>
    spawnSync(process.execPath, [serverEntry, "init", "--host", "claude"], {
      cwd: repo,
      encoding: "utf-8",
      env: { ...process.env, MINDPLAN_ROOT: repo },
    });
  // A shipped node file git has never seen (renamed by this init, not yet committed) waits.
  nodeFile("f-fresh", "2026-01-05T00:00:00.000Z");
  const first = init();
  const freshText = fs.readFileSync(path.join(repo, "mindplan", "foundations", "f-fresh", "f-fresh.mdx"), "utf-8");
  check("a node file git has never seen gets no revision count yet", !/^revisions:/m.test(freshText), freshText);
  const rootText = fs.readFileSync(path.join(repo, "mindplan", "foundations", "f-root", "f-root.mdx"), "utf-8");
  check(
    "init writes the ship count and the split it finds in git",
    /^revisions: 3$/m.test(rootText) && /^churn: 0$/m.test(rootText) && /^split_at: 3$/m.test(rootText) && rootText.includes("split_into:\n  - f-a\n  - f-b"),
    first.stdout + first.stderr + rootText
  );
  check("init reports the split", first.stdout.includes("Found a split in git: f-root split into f-a, f-b"), first.stdout);
  const partText = fs.readFileSync(path.join(repo, "mindplan", "foundations", "f-a", "f-a.mdx"), "utf-8");
  check("a part shipped once gets revisions: 1, churn: 1, and no split", /^revisions: 1$/m.test(partText) && /^churn: 1$/m.test(partText) && !partText.includes("split_"), partText);
  const second = init();
  check(
    "a second init writes no revision counts",
    !second.stdout.includes("Wrote the revision count") &&
      fs.readFileSync(path.join(repo, "mindplan", "foundations", "f-root", "f-root.mdx"), "utf-8") === rootText,
    second.stdout
  );

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-open-closed-nogit-"));
  fs.mkdirSync(path.join(plain, "mindplan"), { recursive: true });
  fs.writeFileSync(path.join(plain, "mindplan", "config.json"), JSON.stringify({ sources: [], exclude: [] }) + "\n");
  fs.mkdirSync(path.join(plain, "mindplan", "foundations", "f-solo"), { recursive: true });
  fs.writeFileSync(
    path.join(plain, "mindplan", "foundations", "f-solo", "f-solo.mdx"),
    rootText.replace(/^id: f-root$/m, "id: f-solo").replace(/^revisions:.*\n|^split_at:.*\n|^split_into:\n(  - .*\n)*|^depends_on:\n(  - .*\n)*/gm, "")
  );
  spawnSync(process.execPath, [serverEntry, "init", "--host", "claude"], { cwd: plain, encoding: "utf-8", env: { ...process.env, MINDPLAN_ROOT: plain, GIT_CEILING_DIRECTORIES: path.dirname(plain) } });
  const solo = fs.readFileSync(path.join(plain, "mindplan", "foundations", "f-solo", "f-solo.mdx"), "utf-8");
  check("outside git init writes revisions: 1", /^revisions: 1$/m.test(solo), solo);
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll open-closed checks passed.");
