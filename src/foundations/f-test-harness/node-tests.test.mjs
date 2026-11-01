/**
 * Linked tests: set_test_files writes a node's `tests` list to live and an open next alike, with no
 * open_next and no readiness reset; the check Blocks a missing entry once the node is in review or
 * shipped and warns about an in-review revision with none; the blast radius lists the tests to run.
 * Every write here is also diffed against the sandbox: each mindplan/ file it touched must be in
 * its changed_files. Run via npm test.
 */
// Fixtures build graphs without a version stamp; the gate has its own suite (version.test.mjs).
process.env.MINDPLAN_VERSION_GATE ??= "off";
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-node-tests-"));
console.log("Node-tests sandbox:", root);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, MINDPLAN_ROOT: root },
});
const client = new Client({ name: "node-tests-test", version: "0.1.0" });
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

let diffMisses = 0;

/** Call a tool and check that its changed_files covers every file it touched on disk. */
async function call(tool, args) {
  const before = snapshot();
  const res = await client.callTool({ name: tool, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(`${tool}: ${text}`);
  const result = JSON.parse(text || "{}");
  if (Array.isArray(result.changed_files)) {
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
  return result;
}

/** The Blocked text of a call expected to fail (null when it succeeded), with nothing written. */
async function blocked(tool, args) {
  const before = snapshot();
  const res = await client.callTool({ name: tool, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (!res.isError) return null;
  const wrote = touched(before, snapshot());
  if (wrote.length > 0) check(`Blocked ${tool} wrote nothing`, false, JSON.stringify(wrote));
  return text;
}

const liveOf = (id) => `mindplan/foundations/${id}/${id}.mdx`;
const nextOf = (id) => `mindplan/foundations/${id}/${id}.next.mdx`;
const readRel = (rel) => fs.readFileSync(path.join(root, ...rel.split("/")), "utf-8");

/** The `tests` list in a territory file's frontmatter. */
function testsIn(rel) {
  const fm = readRel(rel).match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  const block = fm.match(/^tests:\r?\n((?:\s+-\s+.*(?:\r?\n|$))*)/m)?.[1] ?? "";
  return block
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s+-\s+/, "").trim())
    .filter(Boolean);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** True when a shipped node with no open revision has no `<id>.next.mdx` beside its live file. */
function noNextFile(id) {
  return fs.existsSync(path.join(root, ...liveOf(id).split("/"))) && !fs.existsSync(path.join(root, ...nextOf(id).split("/")));
}

/** Fill create_node scaffold stubs with real text and tick every checkbox (before first ship). */
function fillAndTick(id) {
  const file = path.join(root, "mindplan", "foundations", id, `${id}.mdx`);
  let text = fs.readFileSync(file, "utf-8");
  text = text.replace(/^_.*?_$/gm, (line) => (line.includes("attachments/") ? line : "Node-tests filled territory."));
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

async function walk(id, steps) {
  for (const new_status of steps) await call("update_node_status", { node_id: id, new_status });
}

/** A Foundation that claims its own source file, filled and ticked, left at draft. */
async function foundation(id) {
  await call("create_node", { id, type: "Foundation", title: id, description: `Infra — ${id}`, role: "infra" });
  write(`src/${id}/index.ts`, `export const ${id.replace(/-/g, "_")} = 1;\n`);
  await call("set_implementation_files", { node_id: id, files: [`src/${id}/`] });
  fillAndTick(id);
}

fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
fs.writeFileSync(
  path.join(root, "mindplan", "config.json"),
  JSON.stringify({ sources: ["src/**"], exclude: [] }, null, 2) + "\n"
);
write("tests/core.test.mjs", "// core\n");
write("tests/dep.test.mjs", "// dep\n");
write("tests/extra/one.test.mjs", "// one\n");
write("tests/extra/two.test.mjs", "// two\n");

// --- a draft plan may link tests it has not written yet; an edge write keeps the list ---
await foundation("f-core");
await foundation("f-dep");
{
  const res = await call("set_test_files", {
    node_id: "f-dep",
    files: ["tests/dep.test.mjs", "./tests/dep.test.mjs", "tests/later.test.mjs"],
  });
  check(
    "set_test_files on a draft node dedupes, sorts, and writes only the live file",
    same(res.tests, ["tests/dep.test.mjs", "tests/later.test.mjs"]) &&
      same(res.changed_files, [liveOf("f-dep")]),
    JSON.stringify(res)
  );
  const ran = await call("run_check", {});
  check(
    "a draft node's missing linked test does not fail the check",
    ran.ok && !ran.failures.some((f) => f.includes("tests entry missing")),
    JSON.stringify(ran.failures)
  );
  await call("link_nodes", { source_id: "f-dep", target_id: "f-core", edge_type: "depends_on" });
  check(
    "link_nodes keeps the tests list",
    same(testsIn(liveOf("f-dep")), ["tests/dep.test.mjs", "tests/later.test.mjs"]),
    JSON.stringify(testsIn(liveOf("f-dep")))
  );
  const ctx = await call("get_node_context", { node_id: "f-dep" });
  check(
    "get_node_context returns the node's tests",
    same(ctx.record?.tests, ["tests/dep.test.mjs", "tests/later.test.mjs"]),
    JSON.stringify(ctx.record)
  );
}

// --- readiness is never reset ---
{
  await call("update_node_status", { node_id: "f-core", new_status: "ready" });
  const res = await call("set_test_files", { node_id: "f-core", files: ["tests/core.test.mjs"] });
  check(
    "set_test_files on a ready node keeps it ready",
    res.state === "ready" && !("readiness_reset" in res),
    JSON.stringify(res)
  );
}

// --- the in-review gate and the untested warning ---
{
  await walk("f-core", ["in-progress", "in-review", "ship"]);
  await call("update_node_status", { node_id: "f-dep", new_status: "ready" });
  await call("update_node_status", { node_id: "f-dep", new_status: "in-progress" });
  const gate = await blocked("update_node_status", { node_id: "f-dep", new_status: "in-review" });
  check(
    "a missing linked test Blocks the move to in-review",
    gate?.includes("Blocked:") && gate.includes('presence: "f-dep" tests entry missing on disk: "tests/later.test.mjs"'),
    gate ?? "accepted"
  );
  await call("set_test_files", { node_id: "f-dep", files: ["tests/dep.test.mjs"] });
  await call("update_node_status", { node_id: "f-dep", new_status: "in-review" });
  check("with every linked test on disk the move to in-review passes", true);

  await foundation("f-bare");
  await walk("f-bare", ["ready", "in-progress", "in-review"]);
  const ran = await call("run_check", {});
  const untested = (id) => ran.warnings.some((w) => w.startsWith(`tests: "${id}" is in review with no linked tests`));
  check(
    "an in-review revision with no tests warns, and one with tests does not",
    ran.ok && untested("f-bare") && !untested("f-dep"),
    JSON.stringify(ran.warnings)
  );
  await walk("f-dep", ["ship"]);
  await walk("f-bare", ["ship"]);
}

// --- a shipped node changes its tests in place: live only, no open_next ---
{
  const res = await call("set_test_files", {
    node_id: "f-core",
    files: ["tests/core.test.mjs", "tests/extra/"],
  });
  check(
    "set_test_files on a shipped node writes only live, opening no revision",
    same(res.changed_files, [liveOf("f-core")]) &&
      res.next_state === null &&
      noNextFile("f-core"),
    JSON.stringify(res)
  );
  await call("set_test_files", { node_id: "f-core", files: ["tests/core.test.mjs", "tests/gone.test.mjs"] });
  const ran = await call("run_check", {});
  check(
    "a shipped node's missing linked test fails the check",
    !ran.ok && ran.failures.some((f) => f.includes('presence: "f-core" tests entry missing on disk: "tests/gone.test.mjs"')),
    JSON.stringify(ran.failures)
  );
  await call("set_test_files", { node_id: "f-core", files: ["tests/core.test.mjs", "tests/extra/"] });
  check("an unchanged list writes nothing", (await call("set_test_files", { node_id: "f-core", files: ["tests/extra/", "tests/core.test.mjs"] })).changed_files.length === 0);
}

// --- the blast radius lists the tests to run ---
{
  const radius = await call("get_blast_radius", { node_id: "f-core" });
  check(
    "get_blast_radius lists the focus's and its dependents' expanded tests",
    same(radius.tests, [
      "tests/core.test.mjs",
      "tests/dep.test.mjs",
      "tests/extra/one.test.mjs",
      "tests/extra/two.test.mjs",
    ]),
    JSON.stringify(radius.tests)
  );
  const labeled = await blocked("set_test_files", { node_id: "f-bare", files: [], change: "c-tests" });
  check("change on a shipped node with no open next is Blocked", labeled?.includes("needs no change id"), String(labeled));
  await call("open_next", { node_id: "f-dep", change: "c-tests" });
  const merged = await call("get_blast_radius", { change: "c-tests" });
  check(
    "the change blast radius merges its members' tests",
    same(merged.tests, ["tests/dep.test.mjs"]),
    JSON.stringify(merged.tests)
  );
  await call("discard_next", { node_id: "f-dep" });
}

// --- an open revision: both files, kept through body and claim writes, and through ship ---
{
  await call("open_next", { node_id: "f-core", change: "c-core" });
  const res = await call("set_test_files", {
    node_id: "f-core",
    files: ["tests/core.test.mjs", "tests/extra/one.test.mjs"],
  });
  check(
    "set_test_files with an open revision writes live and next alike",
    same(testsIn(liveOf("f-core")), ["tests/core.test.mjs", "tests/extra/one.test.mjs"]) &&
      same(testsIn(nextOf("f-core")), ["tests/core.test.mjs", "tests/extra/one.test.mjs"]) &&
      res.changed_files.includes(liveOf("f-core")) &&
      res.changed_files.includes(nextOf("f-core")),
    JSON.stringify(res)
  );
  await call("patch_node_territory", { node_id: "f-core", description: "Infra — core, revised" });
  await call("set_implementation_files", { node_id: "f-core", files: ["src/f-core/"] });
  check(
    "territory and claim writes keep the tests list on next",
    same(testsIn(nextOf("f-core")), ["tests/core.test.mjs", "tests/extra/one.test.mjs"]),
    JSON.stringify(testsIn(nextOf("f-core")))
  );
  await call("record_decision", {
    node_id: "f-core",
    decision: "Keep the core tests split.",
    alternatives: ["One suite"],
    why: "Each part runs alone.",
  });
  // open_next starts a fresh ledger, so the revision ticks its own ops before it ships.
  await call("patch_node_territory", { node_id: "f-core", toggle_checkboxes: [{ contains: "- [ ]", checked: true, all: true }] });
  await walk("f-core", ["ready", "in-progress", "in-review", "ship"]);
  check(
    "ship keeps the tests list on live and deletes the next file",
    same(testsIn(liveOf("f-core")), ["tests/core.test.mjs", "tests/extra/one.test.mjs"]) && noNextFile("f-core"),
    JSON.stringify(testsIn(liveOf("f-core")))
  );
}

// --- discard keeps the live list; an empty list removes the field ---
{
  await call("open_next", { node_id: "f-dep" });
  await call("set_test_files", { node_id: "f-dep", files: ["tests/dep.test.mjs", "tests/core.test.mjs"] });
  await call("discard_next", { node_id: "f-dep" });
  check(
    "discard_next keeps the tests written during the revision on live and deletes the next file",
    same(testsIn(liveOf("f-dep")), ["tests/core.test.mjs", "tests/dep.test.mjs"]) && noNextFile("f-dep"),
    JSON.stringify(testsIn(liveOf("f-dep")))
  );
  await call("set_test_files", { node_id: "f-dep", files: [] });
  check(
    "an empty list removes the field",
    !/^tests:/m.test(readRel(liveOf("f-dep"))) && noNextFile("f-dep"),
    readRel(liveOf("f-dep")).slice(0, 400)
  );
}

// --- Blocked cases write nothing ---
{
  for (const bad of ["../outside.test.mjs", "/abs/x.test.mjs", "mindplan/x.test.mjs"]) {
    const text = await blocked("set_test_files", { node_id: "f-core", files: [bad] });
    check(`an invalid tests path is Blocked: ${bad}`, text?.includes("Blocked:") && text.includes("tests path"), text ?? "accepted");
  }
  await call("create_node", { id: "j-area", type: "Capability", title: "Area", description: "An area" });
  const capability = await blocked("set_test_files", { node_id: "j-area", files: ["tests/core.test.mjs"] });
  check("a Capability takes no tests", capability?.includes("only a Foundation, Interaction, or Interface"), capability ?? "accepted");
  await call("create_node", { id: "bug-x", type: "Bug", title: "Broken", description: "Breaks core", severity: "low" });
  const bug = await blocked("set_test_files", { node_id: "bug-x", files: ["tests/core.test.mjs"] });
  check("a Bug takes no tests", bug?.includes("only a Foundation, Interaction, or Interface"), bug ?? "accepted");
  await call("create_node", { id: "f-gone", type: "Foundation", title: "Gone", description: "Infra — gone", role: "infra" });
  await call("update_node_status", { node_id: "f-gone", new_status: "cancelled" });
  const retired = await blocked("set_test_files", { node_id: "f-gone", files: ["tests/core.test.mjs"] });
  check("a retired node takes no tests", retired?.includes("retired"), retired ?? "accepted");
}

const final = await call("run_check", {});
check("the sandbox passes the check at the end", final.ok, JSON.stringify(final.failures));
check("every write listed every mindplan/ file it touched", diffMisses === 0, `${diffMisses} write(s) missed files`);

await client.close();
if (failures > 0) {
  console.log(`\nnode-tests.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nnode-tests.test.mjs: all ok");
