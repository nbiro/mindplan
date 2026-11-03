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

/** The derived Mermaid snapshot: rewritten after every write, never listed in changed_files. */
const MAP = "mindplan/map.md";

/** Paths created, changed, or deleted between two snapshots (map.md excepted). */
function touched(before, after) {
  const out = [];
  for (const [rel, text] of after) if (rel !== MAP && before.get(rel) !== text) out.push(rel);
  for (const rel of before.keys()) if (rel !== MAP && !after.has(rel)) out.push(rel);
  return out;
}

let diffMisses = 0;

/** Call a tool and check that its changed_files covers every file it touched on disk. */
async function call(tool, args) {
  const before = snapshot();
  const res = await client.callTool({ name: tool, arguments: tool === "run_check" ? { compact: false, ...args } : args });
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
  const res = await client.callTool({ name: tool, arguments: tool === "run_check" ? { compact: false, ...args } : args });
  const text = res.content?.[0]?.text ?? "";
  if (!res.isError) return null;
  const wrote = touched(before, snapshot());
  if (wrote.length > 0) check(`Blocked ${tool} wrote nothing`, false, JSON.stringify(wrote));
  return text;
}

const liveOf = (id) => `mindplan/foundations/${id}/${id}.mdx`;
const nextOf = (id) => `mindplan/foundations/${id}/${id}.next.mdx`;
const revOf = (id, change) => `mindplan/foundations/${id}/revisions/${change}/${id}.mdx`;
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

/** A list field (`tests_add`, `tests_remove`, ...) in a revision file's frontmatter. */
function listIn(rel, key) {
  const fm = readRel(rel).match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  const block = fm.match(new RegExp(`^${key}:\\r?\\n((?:\\s+-\\s+.*(?:\\r?\\n|$))*)`, "m"))?.[1] ?? "";
  return block
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s+-\s+/, "").replace(/^"|"$/g, "").trim())
    .filter(Boolean);
}

/**
 * True when a shipped node with no open revision has no `<id>.next.mdx` and no `revisions/`
 * folder beside its live file.
 */
function noNextFile(id) {
  const dir = path.join(root, "mindplan", "foundations", id);
  return (
    fs.existsSync(path.join(root, ...liveOf(id).split("/"))) &&
    !fs.existsSync(path.join(root, ...nextOf(id).split("/"))) &&
    !fs.existsSync(path.join(dir, "revisions"))
  );
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
  await call("set_implementation_files", { node_id: id, add: [`src/${id}/`] });
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
    add: ["tests/dep.test.mjs", "./tests/dep.test.mjs", "tests/later.test.mjs"],
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
  const res = await call("set_test_files", { node_id: "f-core", files: ["tests/core.test.mjs"], replace: true });
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
  await call("set_test_files", { node_id: "f-dep", files: ["tests/dep.test.mjs"], replace: true });
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
    files: ["tests/core.test.mjs", "tests/extra/"], replace: true,
  });
  check(
    "set_test_files on a shipped node writes only live, opening no revision",
    same(res.changed_files, [liveOf("f-core")]) &&
      res.next_state === null &&
      noNextFile("f-core"),
    JSON.stringify(res)
  );
  await call("set_test_files", { node_id: "f-core", files: ["tests/core.test.mjs", "tests/gone.test.mjs"], replace: true });
  const ran = await call("run_check", {});
  check(
    "a shipped node's missing linked test fails the check",
    !ran.ok && ran.failures.some((f) => f.includes('presence: "f-core" tests entry missing on disk: "tests/gone.test.mjs"')),
    JSON.stringify(ran.failures)
  );
  await call("set_test_files", { node_id: "f-core", files: ["tests/core.test.mjs", "tests/extra/"], replace: true });
  check("an unchanged list writes nothing", (await call("set_test_files", { node_id: "f-core", files: ["tests/extra/", "tests/core.test.mjs"], replace: true })).changed_files.length === 0);
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
  const labeled = await blocked("set_test_files", { node_id: "f-bare", files: [], replace: true, change: "c-tests" });
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

// --- an open revision: a tests delta on the revision file, kept through body and claim writes, applied at ship ---
{
  await call("open_next", { node_id: "f-core", change: "c-core" });
  const liveBefore = testsIn(liveOf("f-core"));
  const res = await call("set_test_files", {
    node_id: "f-core",
    files: ["tests/core.test.mjs", "tests/extra/one.test.mjs"], replace: true,
  });
  const delta = () => ({ add: listIn(revOf("f-core", "c-core"), "tests_add"), remove: listIn(revOf("f-core", "c-core"), "tests_remove") });
  check(
    "set_test_files with an open revision writes the revision's tests delta and leaves live alone",
    same(testsIn(liveOf("f-core")), liveBefore) &&
      same(res.tests, ["tests/core.test.mjs", "tests/extra/one.test.mjs"]) &&
      same(delta(), { add: ["tests/extra/one.test.mjs"], remove: ["tests/extra/"] }) &&
      same(res.changed_files, [revOf("f-core", "c-core")]),
    JSON.stringify({ res, live: testsIn(liveOf("f-core")), delta: delta() })
  );
  await call("patch_node_territory", { node_id: "f-core", description: "Infra — core, revised" });
  await call("set_implementation_files", { node_id: "f-core", add: ["src/f-core/"] });
  check(
    "territory and claim writes keep the revision's tests delta",
    same(delta(), { add: ["tests/extra/one.test.mjs"], remove: ["tests/extra/"] }),
    JSON.stringify(delta())
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
    "ship applies the revision's tests to live and deletes the revision folder",
    same(testsIn(liveOf("f-core")), ["tests/core.test.mjs", "tests/extra/one.test.mjs"]) && noNextFile("f-core"),
    JSON.stringify(testsIn(liveOf("f-core")))
  );
}

// --- discard keeps the live list; an empty list removes the field ---
{
  await call("open_next", { change: "rev-f-dep", node_id: "f-dep" });
  await call("set_test_files", { node_id: "f-dep", files: ["tests/dep.test.mjs", "tests/core.test.mjs"], replace: true });
  await call("discard_next", { node_id: "f-dep" });
  check(
    "discard_next drops the tests written during the revision, keeps live, and deletes the revision folder",
    same(testsIn(liveOf("f-dep")), ["tests/dep.test.mjs"]) && noNextFile("f-dep"),
    JSON.stringify(testsIn(liveOf("f-dep")))
  );
  await call("set_test_files", { node_id: "f-dep", files: [], replace: true });
  check(
    "an empty list removes the field",
    !/^tests:/m.test(readRel(liveOf("f-dep"))) && noNextFile("f-dep"),
    readRel(liveOf("f-dep")).slice(0, 400)
  );
}

// --- Blocked cases write nothing ---
{
  for (const bad of ["../outside.test.mjs", "/abs/x.test.mjs", "mindplan/x.test.mjs"]) {
    const text = await blocked("set_test_files", { node_id: "f-core", files: [bad], replace: true });
    check(`an invalid tests path is Blocked: ${bad}`, text?.includes("Blocked:") && text.includes("tests path"), text ?? "accepted");
  }
  await call("create_node", { id: "j-area", type: "Capability", title: "Area", description: "An area" });
  const capability = await blocked("set_test_files", { node_id: "j-area", files: ["tests/core.test.mjs"], replace: true });
  check("a Capability takes no tests", capability?.includes("only a Foundation, Interaction, or Interface"), capability ?? "accepted");
  await call("create_node", { id: "bug-x", type: "Bug", title: "Broken", description: "Breaks core", severity: "low" });
  const bug = await blocked("set_test_files", { node_id: "bug-x", files: ["tests/core.test.mjs"], replace: true });
  check("a Bug takes no tests", bug?.includes("only a Foundation, Interaction, or Interface"), bug ?? "accepted");
  await call("create_node", { id: "f-gone", type: "Foundation", title: "Gone", description: "Infra — gone", role: "infra" });
  await call("update_node_status", { node_id: "f-gone", new_status: "cancelled" });
  const retired = await blocked("set_test_files", { node_id: "f-gone", files: ["tests/core.test.mjs"], replace: true });
  check("a retired node takes no tests", retired?.includes("retired"), retired ?? "accepted");
}

const final = await call("run_check", {});
check("the sandbox passes the check at the end", final.ok, JSON.stringify(final.failures));

// --- add / remove / replace: files alone is Blocked; add and remove change entries ---
{
  const noReplace = await blocked("set_test_files", { node_id: "f-core", files: ["tests/core.test.mjs"] });
  check(
    "set_test_files files without replace: true is Blocked, naming add / remove and replace: true",
    noReplace?.includes("Blocked:") && noReplace.includes("add / remove") && noReplace.includes("replace: true"),
    noReplace ?? "accepted"
  );
  const claimNoReplace = await blocked("set_implementation_files", { node_id: "f-core", files: ["src/f-core/"] });
  check(
    "set_implementation_files files without replace: true is Blocked, naming add / remove and replace: true",
    claimNoReplace?.includes("add / remove") && claimNoReplace.includes("replace: true"),
    claimNoReplace ?? "accepted"
  );
  const before = testsIn(liveOf("f-core"));
  const added = await call("set_test_files", { node_id: "f-core", add: ["tests/extra/two.test.mjs"] });
  check(
    "set_test_files add keeps the other entries",
    same(added.tests, [...new Set([...before, "tests/extra/two.test.mjs"])].sort()),
    JSON.stringify(added.tests)
  );
  const removed = await call("set_test_files", { node_id: "f-core", remove: ["tests/extra/two.test.mjs"] });
  check("set_test_files remove drops only that entry", same(removed.tests, before), JSON.stringify(removed.tests));
  const replaced = await call("set_test_files", { node_id: "f-core", files: ["tests/core.test.mjs"], replace: true });
  check("set_test_files files with replace: true replaces the list", same(replaced.tests, ["tests/core.test.mjs"]), JSON.stringify(replaced.tests));

  await call("create_node", { id: "f-claims", type: "Foundation", title: "Claims", description: "Infra — claims", role: "infra" });
  write("src/f-claims/a.ts", "export const a = 1;\n");
  write("src/f-claims/b.ts", "export const b = 1;\n");
  const both = await call("set_implementation_files", { node_id: "f-claims", add: ["src/f-claims/a.ts", "src/f-claims/b.ts"] });
  const one = await call("set_implementation_files", { node_id: "f-claims", remove: ["src/f-claims/a.ts"] });
  const dir = await call("set_implementation_files", { node_id: "f-claims", files: ["src/f-claims/"], replace: true });
  check(
    "set_implementation_files add, remove, and replace on a draft node",
    same(both.implements, ["src/f-claims/a.ts", "src/f-claims/b.ts"]) &&
      same(one.implements, ["src/f-claims/b.ts"]) &&
      same(dir.implements, ["src/f-claims/"]),
    JSON.stringify([both.implements, one.implements, dir.implements])
  );
}

// --- open revisions: edits write add / remove deltas into the revision's folder ---
{
  process.env.MINDPLAN_ROOT = root;
  const { loadGraph } = await import("../../../dist/foundations/f-territory-store/store.js");
  const { openRevision, parseRevisionFile, writeRevisionState } = await import(
    "../../../dist/foundations/f-territory-store/revisions.js"
  );
  const { closeGraphCaches } = await import("../../../dist/foundations/f-graph-cache/cache.js");

  await foundation("f-rev");
  await call("link_nodes", { source_id: "f-rev", target_id: "f-core", edge_type: "depends_on" });
  await walk("f-rev", ["ready", "in-progress", "in-review", "ship"]);
  const shipped = loadGraph().nodes.find((n) => n.id === "f-rev");
  openRevision(shipped, "c-one", {});
  openRevision(shipped, "c-two", {});
  closeGraphCaches();

  const revOf = (change) => `mindplan/foundations/f-rev/revisions/${change}/f-rev.mdx`;
  const rev = (change) => parseRevisionFile(readRel(revOf(change)), "f-rev");
  const liveBefore = readRel(liveOf("f-rev"));

  const ambiguous = await blocked("link_nodes", { source_id: "f-rev", target_id: "f-dep", edge_type: "depends_on" });
  check(
    "link_nodes on a node with two open revisions and no change is Blocked, listing both",
    ambiguous?.includes("Blocked:") && ambiguous.includes('"c-one"') && ambiguous.includes('"c-two"'),
    ambiguous ?? "accepted"
  );
  const one = await call("link_nodes", { source_id: "f-rev", target_id: "f-dep", edge_type: "depends_on", change: "c-one" });
  const two = await call("link_nodes", { source_id: "f-rev", target_id: "f-bare", edge_type: "depends_on", change: "c-two" });
  check(
    "link_nodes with each change writes an add delta to that revision's folder only",
    one.changed_files.includes(revOf("c-one")) &&
      two.changed_files.includes(revOf("c-two")) &&
      same(rev("c-one").revision.edges.depends_on, { add: ["f-dep"], remove: [] }) &&
      same(rev("c-two").revision.edges.depends_on, { add: ["f-bare"], remove: [] }) &&
      readRel(liveOf("f-rev")) === liveBefore,
    JSON.stringify([rev("c-one").revision.edges, rev("c-two").revision.edges, one.changed_files])
  );
  const dup = await blocked("link_nodes", { source_id: "f-rev", target_id: "f-core", edge_type: "depends_on", change: "c-one" });
  check("linking an edge the revision already has (live) is Blocked", dup?.includes("already exists"), dup ?? "accepted");

  await call("unlink_nodes", { source_id: "f-rev", target_id: "f-core", change: "c-two" });
  await call("unlink_nodes", { source_id: "f-rev", target_id: "f-dep", change: "c-one" });
  check(
    "unlink_nodes writes a remove delta for a live edge and drops an added one",
    same(rev("c-two").revision.edges.depends_on, { add: ["f-bare"], remove: ["f-core"] }) &&
      rev("c-one").revision.edges.depends_on === undefined &&
      readRel(liveOf("f-rev")) === liveBefore,
    JSON.stringify([rev("c-one").revision.edges, rev("c-two").revision.edges])
  );
  await call("link_nodes", { source_id: "f-rev", target_id: "f-core", edge_type: "depends_on", change: "c-two" });
  check(
    "re-linking a removed live edge clears the remove delta",
    same(rev("c-two").revision.edges.depends_on, { add: ["f-bare"], remove: [] }),
    JSON.stringify(rev("c-two").revision.edges)
  );

  // Readiness: a contract write to a ready revision sends it back to draft.
  writeRevisionState(loadGraph().nodes.find((n) => n.id === "f-rev"), "c-one", "ready");
  closeGraphCaches();
  const reset = await call("link_nodes", { source_id: "f-rev", target_id: "f-dep", edge_type: "depends_on", change: "c-one" });
  check(
    "a link on a ready revision resets it to draft",
    reset.readiness_reset?.to === "draft" && rev("c-one").revision.state === "draft",
    JSON.stringify(reset)
  );

  const testsAmbiguous = await blocked("set_test_files", { node_id: "f-rev", add: ["tests/core.test.mjs"] });
  check("set_test_files with two open revisions and no change is Blocked", testsAmbiguous?.includes('"c-one"'), testsAmbiguous ?? "accepted");
  const testRes = await call("set_test_files", { node_id: "f-rev", add: ["tests/core.test.mjs"], change: "c-one" });
  check(
    "set_test_files add on a revision writes a tests delta there, live untouched",
    same(rev("c-one").revision.tests, { add: ["tests/core.test.mjs"], remove: [] }) &&
      same(testRes.changed_files, [revOf("c-one")]) &&
      readRel(liveOf("f-rev")) === liveBefore,
    JSON.stringify(testRes)
  );
  const claimAdd = await call("set_implementation_files", { node_id: "f-rev", add: ["src/f-rev/extra.ts"], change: "c-one" });
  const claimReplace = await call("set_implementation_files", { node_id: "f-rev", files: [], replace: true, change: "c-two" });
  check(
    "set_implementation_files add and replace on revisions write implements deltas against live",
    same(rev("c-one").revision.implements, { add: ["src/f-rev/extra.ts"], remove: [] }) &&
      same(rev("c-two").revision.implements, { add: [], remove: ["src/f-rev/"] }) &&
      same(claimAdd.implements, ["src/f-rev/", "src/f-rev/extra.ts"]) &&
      same(claimReplace.implements, []) &&
      readRel(liveOf("f-rev")) === liveBefore,
    JSON.stringify([rev("c-one").revision.implements, rev("c-two").revision.implements])
  );

  const patched = await call("patch_node_territory", {
    node_id: "f-rev",
    change: "c-two",
    replace: { find: "Node-tests filled territory.", with: "Revised in c-two.", all: true },
    title: "f-rev two",
  });
  check(
    "patch_node_territory with change edits that revision's body and title only",
    rev("c-two").body.includes("Revised in c-two.") &&
      rev("c-two").revision.title === "f-rev two" &&
      !rev("c-one").body.includes("Revised in c-two.") &&
      readRel(liveOf("f-rev")) === liveBefore &&
      patched.path === revOf("c-two"),
    JSON.stringify(patched)
  );
  const moved = await blocked("patch_node_territory", { node_id: "f-rev", change: "c-three", description: "x" });
  check("patching a revision's change is Blocked", moved?.includes("folder name"), moved ?? "accepted");
  const att = await call("put_attachment", { node_id: "f-rev", change: "c-two", filename: "note.txt", content_base64: "aGk=" });
  check(
    "put_attachment with change writes to the revision's attachments/",
    att.path === "mindplan/foundations/f-rev/revisions/c-two/attachments/note.txt" &&
      fs.existsSync(path.join(root, ...att.path.split("/"))),
    JSON.stringify(att)
  );
  await call("remove_attachment", { node_id: "f-rev", change: "c-two", filename: "note.txt" });
  check("remove_attachment with change deletes it", !fs.existsSync(path.join(root, ...att.path.split("/"))));
  const c1 = readRel(revOf("c-one"));
  const aliased = await call("patch_node_territory", { node_id: "f-rev", change: "c-one", aliases: ["revision words"] });
  check(
    "aliases on a node with open revisions go to live only",
    /^aliases:/m.test(readRel(liveOf("f-rev"))) && readRel(revOf("c-one")) === c1 && same(aliased.aliases, ["revision words"]),
    JSON.stringify(aliased)
  );
  closeGraphCaches();
}
check("every write listed every mindplan/ file it touched", diffMisses === 0, `${diffMisses} write(s) missed files`);

await client.close();
if (failures > 0) {
  console.log(`\nnode-tests.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nnode-tests.test.mjs: all ok");
