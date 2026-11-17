/**
 * run_check output (planning-friction): a hotspot is answered by a decision under its change that
 * names it in `nodes`, and such a decision adds its reason to the node's change group; run_check
 * prints one short `hotspot:` line per node pointing at get_spec({ topic: "open-closed" }); with
 * `change` the warnings naming a member come first; a compact reply cut by the reply budget counts
 * only the warnings it lists as seen; and a confirmation pinning a shipped node's changed files ends
 * its full stale pass. Run via npm test.
 */
// Fixtures build graphs without a version stamp; the gate has its own suite (version.test.mjs).
process.env.MINDPLAN_VERSION_GATE ??= "off";
process.env.MINDPLAN_SEARCH ??= "keyword";
import assert from "assert/strict";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as oc from "../../../dist/foundations/f-compiler-rules/open-closed.js";
import { decisionsNaming } from "../../../dist/foundations/f-compiler-rules/decisions.js";
import { runCheckHandler } from "../../../dist/interactions/i-check-integrity/check.js";
import { confirmTerritory } from "../../../dist/interactions/i-confirm-territory/handlers.js";
import { formatRevisionFile } from "../../../dist/foundations/f-territory-store/revisions.js";

const ok = (label) => console.log(`ok   ${label}`);
const NOW = new Date();
const TODAY = NOW.toISOString().slice(0, 10);
const RECENT = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
const STAMP = "2026-01-01T00:00:00.000Z";

function inRoot(root, fn) {
  const prev = process.env.MINDPLAN_ROOT;
  process.env.MINDPLAN_ROOT = root;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.MINDPLAN_ROOT;
    else process.env.MINDPLAN_ROOT = prev;
  }
}

// --- pure: naming decisions answer a hotspot and add reasons to an existing group ----------------
{
  const decision = (id, change, text, nodes) => ({
    id,
    decision: text,
    alternatives: ["other"],
    why: "because",
    change,
    date: "2026-11-01",
    ...(nodes ? { nodes } : {}),
  });
  const hot = {
    id: "f-hot",
    type: "Foundation",
    state: "stable",
    shipped_at: "2026-11-01T00:00:00.000Z",
    revisions: 6,
    churn: 6,
    churn_wiring: 5,
    decisions: [decision("d-own", "c-old", "Its own reason.")],
    open_revisions: [{ change: "c-new", state: "draft", reason: "behavior", decisions: [] }],
  };
  const other = {
    id: "f-other",
    type: "Foundation",
    state: "stable",
    shipped_at: "2026-11-01T00:00:00.000Z",
    decisions: [
      decision("d-names", "c-new", "One choice that shapes both.", ["f-hot"]),
      decision("d-old-names", "c-old", "Also shapes the old change.", ["f-hot"]),
      decision("d-elsewhere", "c-far", "Names it under a change it never had.", ["f-hot"]),
      decision("d-silent", "c-quiet", "Under a change, naming nobody."),
    ],
  };
  const gone = {
    id: "f-gone",
    type: "Foundation",
    state: "deprecated",
    decisions: [decision("d-gone", "c-new", "A retired node's decision.", ["f-hot"])],
  };
  const graph = { version: 1, nodes: [hot, other, gone], edges: [] };

  assert.deepEqual(decisionsNaming(graph, hot, "c-new").map((d) => d.id), ["d-names"]);
  ok("decisionsNaming lists the active nodes' decisions under the change that name the node");

  const churn = oc.nodeChurn(graph, hot);
  assert.deepEqual(churn.map((c) => c.change), ["c-old", "c-new"], JSON.stringify(churn));
  assert.deepEqual(churn[0].reasons, ["Its own reason.", "Also shapes the old change."]);
  assert.deepEqual(churn[1].reasons, ["One choice that shapes both."]);
  ok("a naming decision adds its reason to a group the node has (own decision or open revision) and creates none");

  assert.equal(oc.answeredUnder(graph, hot, "c-new"), true);
  assert.equal(oc.answeredUnder(graph, hot, "c-quiet"), false);
  assert.equal(oc.answeredForOpenWork(graph, hot), true);
  // Quiet established nodes set the median; f-other has no pace yet.
  const quiet = [1, 2, 3].map((i) => ({
    id: `f-quiet-${i}`,
    type: "Foundation",
    state: "stable",
    shipped_at: "2026-11-01T00:00:00.000Z",
    revisions: 3,
    churn: 0.5,
  }));
  const unnamed = {
    ...graph,
    nodes: [hot, { ...other, revisions: 1, decisions: [decision("d-x", "c-new", "Does not name it.")] }, ...quiet],
  };
  assert.equal(oc.answeredUnder(unnamed, hot, "c-new"), false);
  assert.equal(oc.answeredForOpenWork(unnamed, hot), false);
  ok("a decision under the change answers the hotspot only when the node holds it or it names the node");

  const settings = { half_life_days: 30, outlier_ratio: 3, min_rate: 2 };
  const h = oc.hotspotFor(unnamed, hot, settings, oc.hotspotContext(unnamed, settings, new Date("2026-11-02T00:00:00.000Z")));
  assert.ok(h, "f-hot is a hotspot");
  const line = oc.hotspotLine(h);
  assert.ok(line.startsWith('hotspot: "f-hot" ships far more often than the rest of the graph lately'), line);
  assert.ok(line.includes("Diagnosis: invert (rate by reason:"), line);
  assert.ok(line.includes('Recent changes: change "c-old" (Its own reason.)'), line);
  assert.ok(line.includes('get_spec({ topic: "open-closed" })'), line);
  assert.ok(line.includes("invert it onto a registry Foundation"), line);
  assert.ok(line.includes("keep_whole: true"), line);
  assert.ok(!line.includes("whose only job is the list") && !line.includes("patch_node_territory"), line);
  assert.ok(line.length < oc.hotspotWarning(h).length, "the line is shorter than the full warning");
  ok("hotspotLine names the diagnosis, the change groups, and the spec topic, without the registry or split paragraph");
}

// --- on disk: five hotspot lines, an answered hotspot, members first, shown means seen ----------
const FOLDERS = { Foundation: "foundations", Interaction: "interactions" };

function frontmatter(fields) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const v of value) lines.push(`  - ${v}`);
    } else lines.push(`${key}: ${value}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

function decisionFile(id, { text, change, nodes }) {
  return [
    `### ${id}`,
    "",
    `- Decision: ${text}`,
    "- Alternatives:",
    "  - Something else",
    "- Why: A fixture reason.",
    `- Change: ${change}`,
    `- Date: ${TODAY}`,
    ...(nodes ? [`- Nodes: ${nodes.join(", ")}`] : []),
    "",
  ].join("\n");
}

/** A shipped Foundation claiming `src/<id>/`; `change` opens a draft revision of it. */
function writeNode(root, { id, churn, revisions = 6, change, decisions = [], shippedAt = RECENT, updatedAt = RECENT }) {
  const type = "Foundation";
  const dir = path.join(root, "mindplan", FOLDERS[type], id);
  fs.mkdirSync(dir, { recursive: true });
  const fields = {
    id,
    type,
    title: `"Node ${id}"`,
    description: `"Infra — ${id} for the check output fixture."`,
    state: "stable",
    role: "infra",
    shipped_at: shippedAt,
    revisions,
    churn,
    created_at: STAMP,
    updated_at: updatedAt,
    implements: [`src/${id}/`],
  };
  const body = `# Node ${id}\n\n## Purpose\n\nFixture body for ${id}.\n`;
  fs.writeFileSync(path.join(dir, `${id}.mdx`), frontmatter(fields) + "\n" + body, "utf-8");
  for (const d of decisions) {
    fs.mkdirSync(path.join(dir, "decisions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "decisions", `${d.id}.md`), decisionFile(d.id, d), "utf-8");
  }
  if (change) {
    const revision = {
      change,
      state: "draft",
      opened_at: RECENT,
      updated_at: RECENT,
      reason: "behavior",
      title: `Node ${id}`,
      description: `Infra — ${id} for the check output fixture.`,
      edges: {},
      implements: { add: [], remove: [] },
      tests: { add: [], remove: [] },
      base: { scalars: {}, sections: {} },
      conflicts: [],
    };
    const revDir = path.join(dir, "revisions", change);
    fs.mkdirSync(revDir, { recursive: true });
    fs.writeFileSync(path.join(revDir, `${id}.mdx`), formatRevisionFile(id, type, revision, body), "utf-8");
  }
  fs.mkdirSync(path.join(root, "src", id), { recursive: true });
  fs.writeFileSync(path.join(root, "src", id, "index.ts"), `export const v = "${id}";\n`, "utf-8");
}

function sandbox(label, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mindplan-check-output-${label}-`));
  fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "mindplan", "config.json"),
    JSON.stringify({ sources: ["src/**"], exclude: [], ...config }, null, 2) + "\n"
  );
  return root;
}

/** Three quiet nodes set the median; hot ones ship far above it. */
function hotGraph(root, hot) {
  // More quiet nodes than hot ones, so the median is the quiet pace.
  for (let i = 1; i <= 20; i++) writeNode(root, { id: `f-quiet-${i}`, churn: 0.5, revisions: 3 });
  for (const n of hot) writeNode(root, { revisions: 6, ...n });
}

{
  const root = sandbox("lines");
  hotGraph(root, [
    { id: "f-hot-1", churn: 6, change: "c-b" },
    { id: "f-hot-2", churn: 6, change: "c-b" },
    { id: "f-hot-3", churn: 6, change: "c-b" },
    { id: "f-hot-4", churn: 6, change: "c-b" },
    { id: "f-hot-5", churn: 6, change: "c-b" },
    // Answered: a decision under c-b on another node names it.
    { id: "f-hot-6", churn: 6, change: "c-b" },
  ]);
  // Rewrite a quiet node with the naming decision (it holds no revision itself).
  writeNode(root, {
    id: "f-quiet-1",
    churn: 0.5,
    revisions: 3,
    decisions: [{ id: "d-shapes-hot-6", text: "One choice that shapes f-hot-6.", change: "c-b", nodes: ["f-hot-6"] }],
  });
  const result = inRoot(root, () => runCheckHandler({ compact: false }));
  const lines = result.warnings.filter((w) => w.startsWith("hotspot:"));
  assert.equal(lines.length, 5, JSON.stringify(lines, null, 2));
  for (const line of lines) {
    assert.ok(line.includes('get_spec({ topic: "open-closed" })'), line);
    assert.ok(!line.includes("whose only job is the list") && !line.includes("patch_node_territory"), line);
  }
  ok("five hotspots under work print five short hotspot lines, each naming the open-closed spec topic");
  assert.ok(!lines.some((w) => w.startsWith('hotspot: "f-hot-6"')), JSON.stringify(lines));
  ok("a hotspot whose change has a decision on another node naming it prints no hotspot line");
  assert.equal(result.ok, true, result.failures.join("\n"));
}

{
  const root = sandbox("members");
  hotGraph(root, [
    { id: "f-other-1", churn: 8, change: "c-other" },
    { id: "f-other-2", churn: 8, change: "c-other" },
    { id: "f-mine", churn: 4, change: "c-mine" },
  ]);
  const plain = inRoot(root, () => runCheckHandler({ compact: false }));
  const hotIds = (warnings) =>
    warnings.filter((w) => w.startsWith("hotspot:")).map((w) => /^hotspot: "([^"]+)"/.exec(w)[1]);
  assert.deepEqual(hotIds(plain.warnings).slice(-1), ["f-mine"], JSON.stringify(plain.warnings));
  const full = inRoot(root, () => runCheckHandler({ compact: false, change: "c-mine" }));
  const firstOther = full.warnings.findIndex((w) => !w.includes('"f-mine"'));
  const lastMine = full.warnings.map((w) => w.includes('"f-mine"')).lastIndexOf(true);
  assert.ok(lastMine >= 0 && (firstOther === -1 || lastMine < firstOther), JSON.stringify(full.warnings, null, 2));
  assert.equal(full.warnings.length, new Set([...plain.warnings, ...full.warnings]).size, "nothing dropped");
  assert.ok(full.warnings.some((w) => w.startsWith('hotspot: "f-other-1"')), "another change's warnings follow");
  assert.ok(full.output.indexOf('"f-mine"') < full.output.indexOf('hotspot: "f-other-1"'), full.output);
  const compact = inRoot(root, () => runCheckHandler({ compact: true, change: "c-mine" }));
  const texts = compact.warnings.map((w) => w.text);
  const cFirstOther = texts.findIndex((w) => !w.includes('"f-mine"'));
  const cLastMine = texts.map((w) => w.includes('"f-mine"')).lastIndexOf(true);
  assert.ok(cLastMine >= 0 && (cFirstOther === -1 || cLastMine < cFirstOther), JSON.stringify(texts, null, 2));
  ok("with change, the warnings naming a member come first in compact and full output, nothing dropped");
}

{
  const root = sandbox("seen", { replies: { budget_bytes: 1000 } });
  hotGraph(
    root,
    Array.from({ length: 12 }, (_, i) => ({ id: `f-hot-${String(i).padStart(2, "0")}`, churn: 6, change: "c-many" }))
  );
  const first = inRoot(root, () => runCheckHandler({ compact: true }));
  const cut = (first.truncated ?? []).find((t) => t.path === "warnings");
  assert.ok(cut, JSON.stringify(first.truncated));
  assert.ok(first.warnings.length < cut.total, JSON.stringify(first.warnings));
  const shownFirst = new Set(first.warnings.map((w) => w.id));
  const second = inRoot(root, () => runCheckHandler({ compact: true }));
  assert.ok(second.warnings.length > 0, "the cut warnings are listed again");
  assert.ok(second.warnings.every((w) => !shownFirst.has(w.id)), JSON.stringify(second.warnings));
  assert.equal(second.unchanged, shownFirst.size, JSON.stringify(second));
  ok("a compact check cut by the budget counts only the listed warnings as seen; the next lists the cut ones");
}

// --- a confirmation ends the full stale pass of a shipped node edited in place -------------------
{
  const root = sandbox("confirm");
  writeNode(root, { id: "f-edited", churn: 1, revisions: 2, shippedAt: STAMP, updatedAt: STAMP });
  // The body was last written an hour ago: a claimed file edited now is newer than it.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(path.join(root, "mindplan", "foundations", "f-edited", "f-edited.mdx"), hourAgo, hourAgo);
  const git = (...args) => {
    const r = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf-8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Ada Confirmer");
  git("config", "core.autocrlf", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("switch", "-q", "-c", "feature");
  const staleOf = (r) => r.warnings.filter((w) => w.startsWith("stale:") && w.includes("f-edited"));

  fs.writeFileSync(path.join(root, "src", "f-edited", "index.ts"), 'export const v = "bumped";\n', "utf-8");
  git("add", "-A");
  git("commit", "-q", "-m", "bump");
  const before = inRoot(root, () => runCheckHandler({ compact: false }));
  assert.ok(staleOf(before).length > 0, JSON.stringify(before.warnings));

  inRoot(root, () => confirmTerritory({ node_id: "f-edited", note: "only a constant moved" }));
  const after = inRoot(root, () => runCheckHandler({ compact: false }));
  assert.deepEqual(staleOf(after), [], JSON.stringify(after.warnings));
  assert.equal(after.ok, true, after.failures.join("\n"));
  ok("after confirm_territory the plain check prints no stale line for the confirmed files");

  fs.writeFileSync(path.join(root, "src", "f-edited", "index.ts"), 'export const v = "bumped again";\n', "utf-8");
  const again = inRoot(root, () => runCheckHandler({ compact: false }));
  assert.ok(staleOf(again).length > 0, JSON.stringify(again.warnings));
  ok("editing a confirmed file again brings the stale line back");
}
