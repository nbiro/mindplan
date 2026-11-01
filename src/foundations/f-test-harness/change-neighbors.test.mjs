/**
 * Change ids on shipped nodes: only a revision carries one. A shipped node with no open next is
 * edited in place: change (or change_ref) on patch_node_territory, set_implementation_files, and
 * set_test_files is Blocked and writes nothing, while the same writes without change pass.
 * record_decision tags its decision only. A decision-only change has no members for the check,
 * the graph filter, or a scoped walk, and orient_for_work({ change }) lists its decision holders.
 * In a git sandbox the plain check gives a shipped node whose claimed file changed against main
 * the full stale-text pass. Every write is diffed against the sandbox on disk: each mindplan/ file
 * it created, changed, or deleted must be in its changed_files.
 * Run via npm test.
 */
// Fixtures build graphs without a version stamp; the gate has its own suite (version.test.mjs).
process.env.MINDPLAN_VERSION_GATE ??= "off";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SHIP, fillAndTick as fillScaffold } from "./ship-fixture.mjs";
// Spawned servers rank by keyword only: no model download or load during tests.
process.env.MINDPLAN_SEARCH ??= "keyword";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-neighbors-"));
console.log("Change-ids sandbox:", root);

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

const nextOf = (kind, id) => `mindplan/${kind}/${id}/${id}.next.mdx`;
const liveOf = (kind, id) => `mindplan/${kind}/${id}/${id}.mdx`;
const readRel = (rel) => fs.readFileSync(path.join(root, ...rel.split("/")), "utf-8");

/** True when a shipped node with no open revision has no `<id>.next.mdx` beside its live file. */
function noNextFile(kind, id) {
  return fs.existsSync(path.join(root, ...liveOf(kind, id).split("/"))) && !fs.existsSync(path.join(root, ...nextOf(kind, id).split("/")));
}

/** True when a live write's changed_files lists the live file and no next file. */
function liveOnly(changed, kind, id) {
  return Array.isArray(changed) && changed.includes(liveOf(kind, id)) && !changed.includes(nextOf(kind, id));
}

/** The live `change` of a node, read from its record. */
async function changeOf(id) {
  return (await call("get_node_context", { node_id: id })).record.change;
}

/** Fill create_node scaffold stubs with real text and tick every checkbox (before first ship). */
function fillAndTick(kind, id) {
  fillScaffold(path.join(root, "mindplan", kind, id, `${id}.mdx`), "Change-ids test filled territory.");
}

function write(rel, content) {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

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

/** git in the sandbox, with its own identity and no commit signing. */
function git(...args) {
  const r = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    cwd: root,
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** Push a file's mtime into the future, so it is newer than its owner's territory file. */
function touchAhead(rel) {
  const when = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(root, ...rel.split("/")), when, when);
}

const IN_PLACE = "is shipped with no open next: edit its files in place; it needs no change id (open_next if its contract changes).";

fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
fs.writeFileSync(
  path.join(root, "mindplan", "config.json"),
  JSON.stringify({ sources: ["src/**"], exclude: [] }, null, 2) + "\n"
);

// --- base graph: shipped Foundations and Interactions, committed on main ---
await call("create_node", { id: "j-app", type: "Capability", title: "App", description: "App area" });
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
  "shipped nodes start with no next file and no change id",
  ["f-core", "f-util"].every((id) => noNextFile("foundations", id)) &&
    ["i-a", "i-b"].every((id) => noNextFile("interactions", id)) &&
    (await changeOf("f-util")) === undefined
);
git("init", "-q", "-b", "main");
git("add", "-A");
git("commit", "-q", "-m", "base");
git("switch", "-q", "-c", "feature");

// --- change on a shipped node with no open next is Blocked and writes nothing ---
{
  const liveBefore = readRel(liveOf("foundations", "f-util"));
  for (const [tool, args] of [
    ["patch_node_territory", { node_id: "f-util", change: "feat" }],
    ["patch_node_territory", { node_id: "f-util", change: "" }],
    ["patch_node_territory", { node_id: "f-util", change_ref: "feat/x" }],
    ["patch_node_territory", { node_id: "f-util", replace: { find: "Change-ids test", with: "Edited" }, change: "feat" }],
    ["set_implementation_files", { node_id: "f-util", files: ["src/f-util/index.ts"], change: "feat" }],
    ["set_implementation_files", { node_id: "f-util", files: ["src/f-util/index.ts"], change: "" }],
    ["set_test_files", { node_id: "f-util", files: ["tests/util.test.mjs"], change: "feat" }],
  ]) {
    const text = await blocked(tool, args);
    check(
      `${tool} ${JSON.stringify(args)} on a shipped node with no open next is Blocked naming in-place edits`,
      text?.includes(`"f-util" ${IN_PLACE}`),
      String(text)
    );
  }
  check(
    "the Blocked writes left the live file untouched and opened no revision",
    readRel(liveOf("foundations", "f-util")) === liveBefore && noNextFile("foundations", "f-util")
  );

  const tested = await call("set_test_files", { node_id: "f-util", files: ["tests/util.test.mjs"] });
  const claimed = await call("set_implementation_files", { node_id: "f-util", files: ["src/f-util/index.ts"] });
  check(
    "the same writes without change pass in place, with no label fields",
    liveOnly(tested.changed_files, "foundations", "f-util") &&
      [tested, claimed].every((r) => !("neighbor_of" in r) && !("replaced_change" in r)) &&
      (await changeOf("f-util")) === undefined,
    `${JSON.stringify(tested)} | ${JSON.stringify(claimed)}`
  );
  await call("set_test_files", { node_id: "f-util", files: [] });
}

// --- a revision carries the change id; the live file never does ---
{
  await newRevision("i-new", "feat");
  const opened = await call("open_next", { node_id: "i-b", change: "feat" });
  check(
    "open_next writes the change to the next file only, with no replaced_change",
    !("replaced_change" in opened) && opened.next.change === "feat" && !/^change:/m.test(readRel(liveOf("interactions", "i-b"))),
    JSON.stringify(opened)
  );
  const moved = await call("patch_node_territory", { node_id: "i-b", change: "feat2" });
  check(
    "moving the revision's change writes the next file only",
    !moved.changed_files.includes(liveOf("interactions", "i-b")) && !("replaced_change" in moved),
    JSON.stringify(moved)
  );
  await call("patch_node_territory", { node_id: "i-b", change: "feat" });
  const report = await call("run_check", { change: "feat" });
  const kinds = Object.fromEntries((report.change?.members ?? []).map((m) => [m.id, m.kind]));
  check(
    "run_check with change lists only revisions",
    report.ok && kinds["i-new"] === "revision" && kinds["i-b"] === "revision" && Object.keys(kinds).length === 2,
    JSON.stringify(report.change)
  );
  const radius = await call("get_blast_radius", { change: "feat" });
  check(
    "the change radius lists revisions, and its additivity names no neighbors",
    radius.members.every((m) => m.kind === "revision") && !("neighbors" in radius.additivity) && !/neighbor/.test(radius.additivity.summary),
    JSON.stringify(radius.additivity)
  );
}

// --- record_decision tags the decision only ---
{
  const onRevision = await call("record_decision", {
    node_id: "i-b",
    decision: "B reads core in place.",
    alternatives: ["Copy core into B (drifts)"],
    why: "One source of truth.",
  });
  check(
    "record_decision without change on a revision records under the revision's change",
    onRevision.decision.change === "feat",
    JSON.stringify(onRevision)
  );
  const untagged = await call("record_decision", {
    node_id: "f-util",
    decision: "Util stays one module.",
    alternatives: ["Split util (no second reason to change)"],
    why: "It changes for one reason.",
  });
  check(
    "record_decision without change on a shipped node with no open next records no change",
    untagged.decision.change === undefined && (await changeOf("f-util")) === undefined,
    JSON.stringify(untagged)
  );
  const tagged = await call("record_decision", {
    node_id: "i-a",
    decision: "A keeps its own copy of the label text.",
    alternatives: ["Read it from core (one more import)"],
    why: "It is one string.",
    change: "feat",
  });
  check(
    "record_decision with change on a shipped node tags the decision and writes no change id on the node",
    tagged.decision.change === "feat" &&
      !("neighbor_of" in tagged) &&
      liveOnly(tagged.changed_files, "interactions", "i-a") &&
      (await changeOf("i-a")) === undefined &&
      !(await call("run_check", { change: "feat" })).change.members.some((m) => m.id === "i-a"),
    JSON.stringify(tagged)
  );
  const oriented = await call("orient_for_work", { change: "feat" });
  const kinds = Object.fromEntries(oriented.members.map((m) => [m.id, m.kind]));
  check(
    "orient_for_work({ change }) keeps a revision that holds the change's decision a revision and lists a shipped holder as a decision member",
    kinds["i-b"] === "revision" && kinds["i-a"] === "decision" && oriented.members.filter((m) => m.id === "i-b").length === 1,
    JSON.stringify(oriented.members)
  );
}

// --- the change ships: no label fields, the shipped nodes carry no change id ---
{
  await call("patch_node_territory", { node_id: "i-b", toggle_checkboxes: [{ contains: "- [ ]", checked: true, all: true }] });
  const walked = await call("update_node_status", { scope: "change", change: "feat", new_status: "ship", skip_review: true });
  check(
    "a change walked to ship reports no cleared_neighbors and leaves no change id on its nodes",
    !("cleared_neighbors" in walked) && (await changeOf("i-b")) === undefined && (await changeOf("i-new")) === undefined,
    JSON.stringify(walked)
  );
  const empty = await blocked("update_node_status", { scope: "change", change: "feat", new_status: "ship" });
  check("a scoped walk over a change with no open revision is Blocked", empty?.includes("has no members"), String(empty));
}

// --- a decision-only change has no members, but orients on its decision holders ---
{
  for (const id of ["i-a", "f-core"]) {
    await call("record_decision", {
      node_id: id,
      decision: `${id} stays whole.`,
      alternatives: ["Split it (no second reason to change)"],
      why: "It changes for one reason.",
      keep_whole: true,
      change: "hotspot-triage",
    });
  }
  const graph = await call("get_mindplan_graph", { change: "hotspot-triage", edges: false });
  const checked = await call("run_check", { change: "hotspot-triage" });
  check(
    "the decision-only change has no graph members and its change check is Blocked with no members",
    graph.total_nodes === 0 && checked.failures.some((f) => f.includes('change "hotspot-triage" has no members')),
    `${JSON.stringify(graph)} | ${JSON.stringify(checked.failures)}`
  );
  const oriented = await call("orient_for_work", { change: "hotspot-triage" });
  check(
    "orient_for_work on the decision-only change lists its decision holders with kind decision",
    oriented.members.map((m) => `${m.id}:${m.kind}`).sort().join() === "f-core:decision,i-a:decision" &&
      oriented.decisions.nodes.slice().sort().join() === "f-core,i-a",
    JSON.stringify(oriented)
  );
}

// --- the plain check gives a shipped node edited in place the full stale-text pass ---
{
  git("add", "-A");
  git("commit", "-q", "-m", "plan");
  // Both claimed files end up newer than their territory files; only f-util's changed against main.
  write("src/f-util/index.ts", "export const util = 2;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "edit util in place");
  touchAhead("src/f-util/index.ts");
  touchAhead("src/f-core/index.ts");
  const stale = (warnings, id) => warnings.some((w) => w.startsWith(`stale: 1 claimed file(s) of "${id}" changed after its body`));
  const ran = await call("run_check", {});
  check(
    "a shipped node whose claimed file changed against main gets the changed-file stale warning; an untouched one does not",
    ran.ok && stale(ran.warnings, "f-util") && !stale(ran.warnings, "f-core"),
    JSON.stringify(ran.warnings)
  );
  fs.rmSync(path.join(root, ".git"), { recursive: true, force: true });
  const noGit = await call("run_check", {});
  check(
    "without git the check falls back to the path signals and reports nothing about git",
    noGit.ok && !stale(noGit.warnings, "f-util") && !/git/i.test(noGit.output),
    JSON.stringify(noGit.warnings)
  );
}

check(`each of ${diffedWrites} writes listed every mindplan/ file it touched`, diffMisses === 0, `${diffMisses} write(s) missed files`);

await client.close();
fs.rmSync(root, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\nchange-neighbors.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nchange-neighbors.test.mjs: all ok");
