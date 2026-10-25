/**
 * Change neighbors: a shipped node with no open next that a change edits in place carries the
 * change id on its live file. Labeling (patch_node_territory, record_decision,
 * set_implementation_files), relabel and clear, the change-scoped check and blast radius, and the
 * labels clearing when the change's last revision ships, is discarded, or is cancelled, or when a
 * neighbor-only change is walked to ship. Every write is diffed against the sandbox on disk: each
 * mindplan/ file it created, changed, or deleted must be in its changed_files.
 * Run via npm test.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// Spawned servers rank by keyword only: no model download or load during tests.
process.env.MINDPLAN_SEARCH ??= "keyword";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-neighbors-"));
console.log("Change-neighbors sandbox:", root);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, MINDPLAN_ROOT: root },
});
const client = new Client({ name: "change-neighbors-test", version: "0.1.0" });
await client.connect(transport);

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`ok   ${label}`);
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

/** Every file under mindplan/, keyed by repo-relative path. */
function snapshot() {
  const files = new Map();
  const walkDir = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walkDir(childAbs, childRel);
      else files.set(childRel, fs.readFileSync(childAbs, "utf-8"));
    }
  };
  walkDir(path.join(root, "mindplan"), "mindplan");
  return files;
}

/** Paths created, changed, or deleted between two snapshots. */
function touched(before, after) {
  const out = [];
  for (const [rel, text] of after) if (before.get(rel) !== text) out.push(rel);
  for (const rel of before.keys()) if (!after.has(rel)) out.push(rel);
  return out;
}

let diffedWrites = 0;
let diffMisses = 0;

async function raw(tool, args) {
  const before = snapshot();
  const res = await client.callTool({ name: tool, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (!res.isError) {
    const result = JSON.parse(text || "{}");
    if (Array.isArray(result.changed_files)) {
      diffedWrites++;
      const missing = touched(before, snapshot()).filter((rel) => !result.changed_files.includes(rel));
      if (missing.length > 0) {
        diffMisses++;
        check(
          `${tool} ${JSON.stringify(args).slice(0, 80)} lists every file it wrote`,
          false,
          `missing ${JSON.stringify(missing)} from ${JSON.stringify(result.changed_files)}`
        );
      }
    }
  }
  return { error: !!res.isError, text };
}
async function call(tool, args) {
  const { error, text } = await raw(tool, args);
  if (error) throw new Error(`${tool}: ${text}`);
  return JSON.parse(text || "{}");
}
async function blocked(tool, args) {
  const { error, text } = await raw(tool, args);
  return error && text.startsWith("Blocked:") ? text : null;
}

const twinOf = (kind, id) => `mindplan/${kind}/${id}/${id}.next.mdx`;
const liveOf = (kind, id) => `mindplan/${kind}/${id}/${id}.mdx`;
const readRel = (rel) => fs.readFileSync(path.join(root, ...rel.split("/")), "utf-8");

/** True when the twin is the live file with only `state:` changed to mirror. */
function twinInSync(kind, id) {
  const live = readRel(liveOf(kind, id));
  const twin = readRel(twinOf(kind, id));
  const strip = (text) => text.replace(/^state:.*$/m, "state: <ignored>");
  return /^state: mirror$/m.test(twin) && strip(live) === strip(twin);
}

/** The live `change` label of a node, read from its record. */
async function labelOf(id) {
  return (await call("get_node_context", { node_id: id })).record.change;
}

/** Fill create_node scaffold stubs with real text and tick every checkbox (before any twin exists). */
function fillAndTick(kind, id) {
  const file = path.join(root, "mindplan", kind, id, `${id}.mdx`);
  let text = fs.readFileSync(file, "utf-8");
  text = text.replace(/^_.*?_$/gm, (line) => (line.includes("attachments/") ? line : "Neighbors-test filled territory."));
  text = text.replace(/^## Checklist\s*$/m, "## Atomic Ops");
  if (!/^\s*[-*+]\s+\[[ xX]\]/m.test(text)) text += "\n- [ ] Done\n";
  text = text.replaceAll("- [ ]", "- [x]");
  fs.writeFileSync(file, text);
}

function write(rel, content) {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const SHIP = ["ready", "in-progress", "in-review", "ship"];
async function walk(id, steps) {
  let last;
  for (const new_status of steps) last = await call("update_node_status", { node_id: id, new_status });
  return last;
}

/** A pre-ship Interaction in a change: claimed, filled, and linked so it can ship. */
async function newRevision(id, change) {
  await call("create_node", { id, type: "Interaction", title: id, description: `Action ${id}`, change });
  await call("link_nodes", { source_id: id, target_id: "j-app", edge_type: "belongs_to" });
  await call("link_nodes", { source_id: id, target_id: "f-core", edge_type: "depends_on" });
  write(`src/${id}/x.ts`, 'import { core } from "../f-core/index.js";\nexport const x = core;\n');
  await call("set_implementation_files", { node_id: id, files: [`src/${id}/x.ts`] });
  fillAndTick("interactions", id);
}

fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
fs.writeFileSync(
  path.join(root, "mindplan", "config.json"),
  JSON.stringify({ sources: ["src/**"], exclude: [] }, null, 2) + "\n"
);

// --- base graph: shipped Foundations and Interactions, each with a mirror twin ---
await call("create_node", { id: "j-app", type: "Journey", title: "App", description: "App area" });
await call("create_node", { id: "f-core", type: "Foundation", title: "Core", description: "Infra — core", role: "infra" });
await call("create_node", { id: "f-util", type: "Foundation", title: "Util", description: "Infra — util", role: "infra" });
await call("create_node", { id: "i-a", type: "Interaction", title: "A", description: "Action A" });
await call("create_node", { id: "i-b", type: "Interaction", title: "B", description: "Action B" });
for (const id of ["i-a", "i-b"]) {
  await call("link_nodes", { source_id: id, target_id: "j-app", edge_type: "belongs_to" });
  await call("link_nodes", { source_id: id, target_id: "f-core", edge_type: "depends_on" });
}
write("src/f-core/index.ts", "export const core = 1;\n");
write("src/f-util/index.ts", "export const util = 1;\n");
write("src/i-a/a.ts", 'import { core } from "../f-core/index.js";\nexport const a = core;\n');
write("src/i-b/b.ts", 'import { core } from "../f-core/index.js";\nexport const b = core;\n');
await call("set_implementation_files", { node_id: "f-core", files: ["src/f-core/index.ts"] });
await call("set_implementation_files", { node_id: "f-util", files: ["src/f-util/index.ts"] });
await call("set_implementation_files", { node_id: "i-a", files: ["src/i-a/a.ts"] });
await call("set_implementation_files", { node_id: "i-b", files: ["src/i-b/b.ts"] });
for (const [kind, id] of [
  ["foundations", "f-core"],
  ["foundations", "f-util"],
  ["interactions", "i-a"],
  ["interactions", "i-b"],
]) {
  fillAndTick(kind, id);
}
for (const id of ["f-core", "f-util", "i-a", "i-b"]) await walk(id, SHIP);
check(
  "shipped nodes start with in-sync mirror twins",
  ["f-core", "f-util"].every((id) => twinInSync("foundations", id)) &&
    ["i-a", "i-b"].every((id) => twinInSync("interactions", id))
);

// --- patch_node_territory labels a shipped node with no open next ---
await newRevision("i-new", "feat");
await newRevision("i-new2", "feat");
{
  const labeled = await call("patch_node_territory", { node_id: "f-util", change: "feat" });
  check(
    "change on a shipped live slot labels it a neighbor and lists the re-synced twin",
    labeled.neighbor_of === "feat" &&
      labeled.replaced_change === undefined &&
      labeled.changed_files.includes(liveOf("foundations", "f-util")) &&
      labeled.changed_files.includes(twinOf("foundations", "f-util")),
    JSON.stringify(labeled)
  );
  check(
    "the label is on the live file and the twin is still a state-only copy",
    (await labelOf("f-util")) === "feat" &&
      /^change: "feat"$/m.test(readRel(liveOf("foundations", "f-util"))) &&
      twinInSync("foundations", "f-util")
  );

  const ref = await blocked("patch_node_territory", { node_id: "f-util", change_ref: "feat/x" });
  check("change_ref on a neighbor is Blocked", ref?.includes("change_ref belongs to a revision"), String(ref));
  const both = await blocked("patch_node_territory", { node_id: "f-util", change: "feat", change_ref: "feat/x" });
  check(
    "change with change_ref on a neighbor is Blocked and writes nothing",
    !!both && !/^change_ref:/m.test(readRel(liveOf("foundations", "f-util"))),
    String(both)
  );

  const relabeled = await call("patch_node_territory", { node_id: "f-util", change: "other" });
  check(
    "labeling with another id replaces the label and reports replaced_change",
    relabeled.neighbor_of === "other" && relabeled.replaced_change === "feat" && (await labelOf("f-util")) === "other",
    JSON.stringify(relabeled)
  );
  const cleared = await call("patch_node_territory", { node_id: "f-util", change: "" });
  check(
    "an empty change clears the label and re-syncs the twin",
    cleared.neighbor_of === undefined &&
      (await labelOf("f-util")) === undefined &&
      !/^change:/m.test(readRel(liveOf("foundations", "f-util"))) &&
      twinInSync("foundations", "f-util"),
    JSON.stringify(cleared)
  );
  await call("patch_node_territory", { node_id: "f-util", change: "feat" });

  await call("open_next", { node_id: "i-b" });
  const explicitCurrent = await blocked("patch_node_territory", { node_id: "i-b", slot: "current", change: "feat" });
  check(
    "change on the live slot of a node with an open next stays Blocked",
    explicitCurrent?.includes("belongs to an open revision"),
    String(explicitCurrent)
  );
  const discarded = await call("discard_next", { node_id: "i-b" });
  check("discarding a revision with no change clears nothing", discarded.cleared_neighbors === undefined, JSON.stringify(discarded));
}

// --- run_check and get_blast_radius see the neighbor ---
{
  const report = await call("run_check", { change: "feat" });
  const kinds = Object.fromEntries((report.change?.members ?? []).map((m) => [m.id, m.kind]));
  check(
    "run_check with change lists revisions and the neighbor with kind",
    report.ok && kinds["i-new"] === "revision" && kinds["i-new2"] === "revision" && kinds["f-util"] === "neighbor",
    JSON.stringify(report)
  );

  write("src/f-util/index.ts", 'import { a } from "../i-a/a.js";\nexport const util = a;\n');
  const violated = await call("run_check", { change: "feat" });
  check(
    "run_check with change reports the neighbor's import violation",
    !violated.ok && violated.failures.some((f) => f.includes("src/f-util/index.ts")),
    JSON.stringify(violated.failures)
  );
  write("src/f-util/index.ts", "export const util = 1;\n");

  const radius = await call("get_blast_radius", { change: "feat" });
  const neighborMember = radius.members.find((m) => m.id === "f-util");
  const utilFiles = radius.affected_files.find((g) => g.owner_id === "f-util");
  check(
    "get_blast_radius with change includes the neighbor (kind) and its files",
    neighborMember?.kind === "neighbor" &&
      radius.members.find((m) => m.id === "i-new")?.kind === "revision" &&
      utilFiles?.files.includes("src/f-util/index.ts"),
    JSON.stringify(radius)
  );
}

// --- record_decision and set_implementation_files label neighbors too ---
{
  const decided = await call("record_decision", {
    node_id: "i-a",
    decision: "A reads core in place.",
    alternatives: ["Copy core into A (drifts)"],
    why: "One source of truth.",
    change: "feat",
  });
  check(
    "record_decision with change on a shipped node with no open next labels it",
    decided.neighbor_of === "feat" &&
      decided.decision.change === "feat" &&
      decided.changed_files.includes(twinOf("interactions", "i-a")) &&
      (await labelOf("i-a")) === "feat" &&
      twinInSync("interactions", "i-a"),
    JSON.stringify(decided)
  );

  const claimed = await call("set_implementation_files", { node_id: "i-b", files: ["src/i-b/b.ts"], change: "feat" });
  check(
    "set_implementation_files with change on a shipped node with no open next labels it",
    claimed.neighbor_of === "feat" &&
      claimed.changed_files.includes(twinOf("interactions", "i-b")) &&
      (await labelOf("i-b")) === "feat" &&
      twinInSync("interactions", "i-b"),
    JSON.stringify(claimed)
  );
  const members = (await call("run_check", { change: "feat" })).change.members;
  check(
    "the change now has three neighbors",
    members.filter((m) => m.kind === "neighbor").map((m) => m.id).sort().join() === "f-util,i-a,i-b",
    JSON.stringify(members)
  );
}

// --- the last revision out clears the labels ---
{
  const first = await walk("i-new", SHIP);
  check(
    "shipping an earlier revision keeps the labels",
    first.cleared_neighbors === undefined && (await labelOf("f-util")) === "feat",
    JSON.stringify(first)
  );
  const last = await walk("i-new2", SHIP);
  check(
    "shipping the last revision clears every neighbor's label",
    [...(last.cleared_neighbors ?? [])].sort().join() === "f-util,i-a,i-b" &&
      (await labelOf("f-util")) === undefined &&
      (await labelOf("i-a")) === undefined &&
      (await labelOf("i-b")) === undefined,
    JSON.stringify(last)
  );
  check(
    "each cleared neighbor's twin is still a state-only copy",
    twinInSync("foundations", "f-util") && twinInSync("interactions", "i-a") && twinInSync("interactions", "i-b")
  );
  check("a change with no members fails run_check", !(await call("run_check", { change: "feat" })).ok);
}

// --- discarding the last revision clears the labels ---
{
  await call("open_next", { node_id: "i-a", change: "fix" });
  await call("patch_node_territory", { node_id: "f-util", change: "fix" });
  const discarded = await call("discard_next", { node_id: "i-a" });
  check(
    "discard_next of the last revision clears the labels",
    discarded.cleared_neighbors?.join() === "f-util" && (await labelOf("f-util")) === undefined,
    JSON.stringify(discarded)
  );
}

// --- cancelling the last revision clears the labels ---
{
  await call("create_node", { id: "i-drop", type: "Interaction", title: "Drop", description: "Dropped action", change: "drop" });
  await call("patch_node_territory", { node_id: "f-core", change: "drop" });
  const cancelled = await call("update_node_status", { node_id: "i-drop", new_status: "cancelled" });
  check(
    "cancelling the last revision clears the labels",
    cancelled.cleared_neighbors?.join() === "f-core" && (await labelOf("f-core")) === undefined,
    JSON.stringify(cancelled)
  );
}

// --- a neighbor-only change ---
{
  await call("patch_node_territory", { node_id: "f-core", change: "tidy" });
  const report = await call("run_check", { change: "tidy" });
  check(
    "run_check works on a change with only neighbors",
    report.ok && report.change.members.length === 1 && report.change.members[0].kind === "neighbor",
    JSON.stringify(report)
  );
  const radius = await call("get_blast_radius", { change: "tidy" });
  check(
    "get_blast_radius works on a change with only neighbors",
    radius.members.map((m) => m.id).join() === "f-core" && radius.affected.some((n) => n.id === "i-a"),
    JSON.stringify(radius)
  );
  const toReady = await call("update_node_status", { scope: "change", change: "tidy", new_status: "ready" });
  check(
    "a scoped walk of it to ready is not Blocked and keeps the label",
    toReady.lines.length === 0 && toReady.cleared_neighbors === undefined && (await labelOf("f-core")) === "tidy",
    JSON.stringify(toReady)
  );
  const dry = await call("update_node_status", { scope: "change", change: "tidy", new_status: "ship", dry_run: true });
  check(
    "a dry run to ship writes nothing",
    dry.blocked === null && (await labelOf("f-core")) === "tidy",
    JSON.stringify(dry)
  );
  const shipped = await call("update_node_status", { scope: "change", change: "tidy", new_status: "ship" });
  check(
    "a scoped walk of it to ship clears its labels",
    shipped.cleared_neighbors?.join() === "f-core" &&
      (await labelOf("f-core")) === undefined &&
      twinInSync("foundations", "f-core"),
    JSON.stringify(shipped)
  );
  const empty = await blocked("update_node_status", { scope: "change", change: "tidy", new_status: "ship" });
  check("a change with no members is Blocked", empty?.includes("has no members"), String(empty));
}

// --- open_next drops a live label that differs from the revision's change ---
{
  await call("patch_node_territory", { node_id: "f-util", change: "m1" });
  const opened = await call("open_next", { node_id: "f-util", change: "m1b" });
  check(
    "open_next with another change clears the live label and reports replaced_change",
    opened.replaced_change === "m1" &&
      opened.changed_files.includes(liveOf("foundations", "f-util")) &&
      !/^change:/m.test(readRel(liveOf("foundations", "f-util"))) &&
      /^change: "m1b"$/m.test(readRel(twinOf("foundations", "f-util"))),
    JSON.stringify(opened)
  );
  await call("discard_next", { node_id: "f-util" });
  check(
    "discard_next after it does not restore the stale label",
    (await labelOf("f-util")) === undefined && twinInSync("foundations", "f-util")
  );

  await call("patch_node_territory", { node_id: "f-util", change: "m1" });
  const inherited = await call("open_next", { node_id: "f-util" });
  check(
    "open_next with no change inherits the label and keeps it on live",
    inherited.replaced_change === undefined &&
      inherited.next.change === "m1" &&
      /^change: "m1"$/m.test(readRel(liveOf("foundations", "f-util"))) &&
      /^change: "m1"$/m.test(readRel(twinOf("foundations", "f-util"))),
    JSON.stringify(inherited)
  );
  const dropped = await call("discard_next", { node_id: "f-util" });
  check(
    "discarding that revision clears the change's labels, its own included",
    dropped.cleared_neighbors?.join() === "f-util" &&
      (await labelOf("f-util")) === undefined &&
      twinInSync("foundations", "f-util"),
    JSON.stringify(dropped)
  );

  // Moving the revision's change off an inherited label drops that label from live at once, so a
  // later close of the label's change and a discard cannot bring the node back into it.
  await call("create_node", { id: "i-m1r", type: "Interaction", title: "M1 R", description: "Keeps m2 open", change: "m2" });
  await call("patch_node_territory", { node_id: "f-util", change: "m2" });
  await call("open_next", { node_id: "f-util" });
  const movedOff = await call("patch_node_territory", { node_id: "f-util", change: "m2c" });
  check(
    "moving the revision's change off an inherited label drops the live label and reports it",
    movedOff.replaced_change === "m2" &&
      movedOff.changed_files.includes(liveOf("foundations", "f-util")) &&
      !/^change:/m.test(readRel(liveOf("foundations", "f-util"))),
    JSON.stringify(movedOff)
  );
  await call("update_node_status", { node_id: "i-m1r", new_status: "cancelled" });
  const moved = await call("discard_next", { node_id: "f-util" });
  check(
    "discard_next after the label's change closed restores no label",
    (await labelOf("f-util")) === undefined && twinInSync("foundations", "f-util"),
    JSON.stringify(moved)
  );
  await call("patch_node_territory", { node_id: "f-util", change: "m3" });
  const reopened = await call("open_next", { node_id: "f-util" });
  const movedSet = await call("set_implementation_files", {
    node_id: "f-util",
    files: reopened.next.implements ?? [],
    change: "m3b",
  });
  check(
    "set_implementation_files moving the next slot's change off the label drops it and reports it",
    movedSet.replaced_change === "m3" &&
      movedSet.changed_files.includes(liveOf("foundations", "f-util")) &&
      (await labelOf("f-util")) === undefined,
    JSON.stringify(movedSet)
  );
  await call("discard_next", { node_id: "f-util" });
}

// --- moving a revision off its change clears the labels it leaves behind ---
{
  await call("create_node", { id: "i-l2", type: "Interaction", title: "L2", description: "Moved action", change: "l2" });
  await call("patch_node_territory", { node_id: "f-core", change: "l2" });
  const moved = await call("patch_node_territory", { node_id: "i-l2", change: "l2b" });
  check(
    "patch_node_territory moving the last revision to another change clears the old change's labels",
    moved.cleared_neighbors?.join() === "f-core" &&
      moved.changed_files.includes(twinOf("foundations", "f-core")) &&
      (await labelOf("f-core")) === undefined &&
      twinInSync("foundations", "f-core"),
    JSON.stringify(moved)
  );
  const same = await call("patch_node_territory", { node_id: "i-l2", change: "l2b" });
  check("rewriting the same change clears nothing", same.cleared_neighbors === undefined, JSON.stringify(same));

  await call("create_node", { id: "i-l3", type: "Interaction", title: "L3", description: "Unchanged action", change: "l3" });
  write("src/i-l3/x.ts", "export const x = 1;\n");
  await call("patch_node_territory", { node_id: "f-core", change: "l3" });
  const unset = await call("set_implementation_files", { node_id: "i-l3", files: ["src/i-l3/x.ts"], change: "" });
  check(
    "set_implementation_files clearing the last revision's change clears its labels",
    unset.cleared_neighbors?.join() === "f-core" &&
      (await labelOf("f-core")) === undefined &&
      twinInSync("foundations", "f-core"),
    JSON.stringify(unset)
  );
}

// --- deprecating a labeled shipped node drops its label ---
{
  await call("patch_node_territory", { node_id: "f-util", change: "dep" });
  const deprecated = await call("update_node_status", { node_id: "f-util", new_status: "deprecated" });
  check(
    "deprecating a shipped neighbor clears its live label and lists the file",
    deprecated.new_state === "deprecated" &&
      deprecated.cleared_change === "dep" &&
      deprecated.changed_files.includes(liveOf("foundations", "f-util")) &&
      !/^change:/m.test(readRel(liveOf("foundations", "f-util"))),
    JSON.stringify(deprecated)
  );
}

// --- record_decision on a labeled neighbor defaults to its label ---
{
  await call("create_node", { id: "i-rd", type: "Interaction", title: "RD", description: "Keeps rd open", change: "rd" });
  await call("patch_node_territory", { node_id: "f-core", change: "rd" });
  const decided = await call("record_decision", {
    node_id: "f-core",
    decision: "Core keeps a single export.",
    alternatives: ["Split core into several modules (more churn for dependents)"],
    why: "Dependents import one name.",
  });
  const listed = await call("list_decisions", { change: "rd" });
  check(
    "record_decision on a labeled neighbor without change records it under the label",
    decided.decision.change === "rd" &&
      listed.decisions.some((d) => d.node_id === "f-core" && d.decision === "Core keeps a single export.") &&
      (await labelOf("f-core")) === "rd" &&
      twinInSync("foundations", "f-core"),
    `${JSON.stringify(decided)} | ${JSON.stringify(listed)}`
  );
}

// --- a revisions batch that ships a change's last revisions clears its labels once ---
{
  await newRevision("i-b1", "bt");
  await newRevision("i-b2", "bt");
  await call("patch_node_territory", { node_id: "f-core", change: "bt" });
  for (const id of ["i-b1", "i-b2"]) await walk(id, ["ready", "in-progress", "in-review"]);
  const batch = await call("update_node_status", {
    revisions: [
      { node_id: "i-b1", new_status: "ship" },
      { node_id: "i-b2", new_status: "ship" },
    ],
  });
  check(
    "a batch shipping both revisions lists the neighbor once in cleared_neighbors",
    JSON.stringify(batch.cleared_neighbors) === JSON.stringify(["f-core"]) &&
      batch.changed_files.includes(liveOf("foundations", "f-core")) &&
      (await labelOf("f-core")) === undefined &&
      twinInSync("foundations", "f-core"),
    JSON.stringify(batch)
  );
}

check(`each of ${diffedWrites} writes listed every mindplan/ file it touched`, diffMisses === 0, `${diffMisses} write(s) missed files`);

await client.close();
if (failures > 0) {
  console.log(`\nchange-neighbors.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nchange-neighbors.test.mjs: all ok");
