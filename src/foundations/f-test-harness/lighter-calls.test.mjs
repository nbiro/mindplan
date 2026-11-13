/**
 * Lighter calls (npm test): replies stay under the reply budget (lists cut with a next_page cursor,
 * rule text never cut); rule text is sent once per session; a section read returns that part only;
 * get_blast_radius defaults to a summary; orient_for_work({ node_ids }) orients on several nodes;
 * open_next / patch_node_territory / set_implementation_files orient on their own; ship closes the
 * default spec and impl items and a passing run_check({ run_tests }) closes verify; fan-in from one
 * glob claim counts once and drops the registry / split advice.
 */
// Fixtures build graphs without a version stamp; the gate has its own suite (version.test.mjs).
process.env.MINDPLAN_VERSION_GATE ??= "off";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
process.env.MINDPLAN_SEARCH ??= "keyword";
delete process.env.MINDPLAN_ORIENT_GATE;

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-lighter-"));
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
write("mindplan/config.json", JSON.stringify({ sources: ["src/**"], exclude: [] }) + "\n");
write("src/solo/solo.ts", "export const solo = 1;\n");
write("src/solo/solo.test.mjs", "\n");

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`ok   ${label}`);
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

/** A fresh server is a fresh session: nothing oriented or sent yet. */
let client;
async function session() {
  if (client) await client.close();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env, MINDPLAN_ROOT: root },
    stderr: "pipe",
  });
  client = new Client({ name: "lighter-calls-test", version: "0.1.0" });
  await client.connect(transport);
  await client.callTool({ name: "get_project", arguments: {} });
}
await session();
const raw = async (tool, args) => {
  const res = await client.callTool({ name: tool, arguments: args });
  return { error: !!res.isError, text: res.content?.[0]?.text ?? "" };
};
const call = async (tool, args) => {
  const r = await raw(tool, args);
  if (r.error) throw new Error(`${tool}: ${r.text}`);
  return JSON.parse(r.text);
};
const bytes = (r) => Buffer.byteLength(r.text);

// --- a Foundation with many dependents and a long body ---
await call("create_node", { id: "f-core", type: "Foundation", role: "infra", title: "Core", description: "Infra — the core." });
await call("patch_node_rules", { node_id: "f-core", rules: "- Core writes are append-only.\n- Never call the network from the core." });
const longText = Array.from({ length: 200 }, (_, i) => `Line ${i} of the substrate spec, long enough to weigh something.`).join("\n");
await call("patch_node_territory", { node_id: "f-core", section: "## Shared Substrate Spec", text: longText });
for (let i = 0; i < 30; i++) {
  await call("create_node", {
    id: `i-use-${i}`,
    type: "Interaction",
    title: `Use the core ${i}`,
    description: `Someone uses the core for purpose ${i}, with enough words to make each row of the blast radius weigh something.`,
  });
  await call("link_nodes", { source_id: `i-use-${i}`, target_id: "f-core", edge_type: "depends_on" });
}

// --- 1: section reads return that part only, rule text once per session ---
const first = await raw("get_node_context", { node_id: "f-core", section: "## Purpose" });
const firstJson = JSON.parse(first.text);
check(
  "a section read returns the minimal record and that section only",
  Object.keys(firstJson.record).sort().join() === "id,state,title,type" &&
    firstJson.section === "## Purpose" &&
    !firstJson.body.includes("Line 3 of the substrate") &&
    !("attachments" in firstJson) &&
    !("shape" in firstJson),
  first.text.slice(0, 300)
);
// This session wrote f-core's rules, so it already holds their text (patch_node_rules records it).
check(
  "the author's first read leaves out rule text it wrote itself",
  firstJson.resolved_rules.entries.some((e) => e.node_id === "f-core" && e.unchanged === true && !("rules" in e)),
  JSON.stringify(firstJson.resolved_rules)
);
const second = JSON.parse((await raw("get_node_context", { node_id: "f-core", section: "## Purpose" })).text);
const entry = second.resolved_rules.entries.find((e) => e.node_id === "f-core");
check(
  "a later read sends { node_id, version, unchanged: true } without the text",
  entry?.unchanged === true && !("rules" in entry) && /^[0-9a-f]{12}$/.test(entry.version),
  JSON.stringify(second.resolved_rules)
);
const resent = JSON.parse((await raw("get_node_context", { node_id: "f-core", section: "## Purpose", resend_rules: true })).text);
check(
  "resend_rules returns the text again",
  resent.resolved_rules.entries.some((e) => e.node_id === "f-core" && e.rules?.includes("append-only"))
);
const big = await raw("get_node_context", { node_id: "f-core", section: "## Shared Substrate Spec" });
check(`a large section read stays a section (${bytes(big)} bytes)`, bytes(big) < 16000 && JSON.parse(big.text).body.includes("Line 199"));

// --- 3: blast radius summary by default ---
const summary = await raw("get_blast_radius", { node_id: "f-core" });
const s = JSON.parse(summary.text);
check(
  `get_blast_radius defaults to a summary under 8 KB (${bytes(summary)} bytes)`,
  s.detail === "summary" &&
    bytes(summary) < 8192 &&
    s.counts.affected === 30 &&
    s.counts.by_type.Interaction === 30 &&
    s.top_dependents.length === 10 &&
    Array.isArray(s.decision_ids) &&
    Array.isArray(s.tests) &&
    !("affected" in s),
  summary.text.slice(0, 300)
);
await call("patch_config", { replies: { budget_bytes: 2000 } });
const full = await raw("get_blast_radius", { node_id: "f-core", detail: "full" });
const f = JSON.parse(full.text);
const cut = f.truncated?.find((t) => t.path === "affected");
check(
  `detail "full" is paged by the reply budget (${bytes(full)} bytes, affected ${cut?.shown}/${cut?.total})`,
  f.detail === "full" && cut?.total === 30 && f.affected.length === cut.shown && typeof cut.cursor === "string",
  full.text.slice(0, 300)
);
let seen = f.affected.length;
let cursor = cut?.cursor;
while (cursor) {
  const page = await call("next_page", { cursor });
  seen += page.items.length;
  cursor = page.next_cursor;
}
check("next_page walks the rest of the list", seen === 30, String(seen));
const blocked = await raw("next_page", { cursor: "nope" });
check("an unknown cursor is Blocked", blocked.error && blocked.text.startsWith("Blocked:"), blocked.text);

// Rule text is never cut, even over the budget.
await call("patch_config", { replies: { budget_bytes: 300 } });
const tiny = JSON.parse((await raw("orient_for_work", { node_id: "f-core", depth: "rules", resend_rules: true })).text);
check(
  "rule text is never cut by the budget",
  tiny.rules.entries.some((e) => e.node_id === "f-core" && e.rules?.includes("Never call the network")),
  JSON.stringify(tiny.rules)
);
await call("patch_config", { replies: { budget_bytes: 8192 } });

// --- 4: several nodes in one orient; writes orient on their own (a new session: create_node orients) ---
await session();
const many = await call("orient_for_work", { node_ids: ["i-use-0", "i-use-1", "f-core"] });
check(
  "orient_for_work({ node_ids }) returns each node lean and each rule source once",
  many.members.length === 3 &&
    many.members.every((m) => Array.isArray(m.rules_from)) &&
    many.rules.filter((r) => r.node_id === "f-core").length === 1,
  JSON.stringify(many).slice(0, 300)
);
// i-use-4 … i-use-25: the nodes below stay unoriented for the checks that follow.
const batch = await raw("orient_for_work", { node_ids: Array.from({ length: 22 }, (_, i) => `i-use-${i + 4}`) });
check("a 22-node batch orients in one call", !batch.error && JSON.parse(batch.text).node_ids.length === 22, batch.text.slice(0, 200));
const tooMany = await raw("orient_for_work", { node_ids: Array.from({ length: 51 }, (_, i) => `n-${i}`) });
check("more than 50 node_ids is refused", tooMany.error, tooMany.text.slice(0, 200));
const gatedAfter = await raw("patch_node_rules", { node_id: "i-use-1", rules: "- Use only the public API." });
check("a gated write on a node oriented by node_ids goes through", !gatedAfter.error, gatedAfter.text.slice(0, 160));
const implicit = await call("set_implementation_files", { node_id: "i-use-2", files: ["src/use-2/"], replace: true });
check(
  "set_implementation_files on an unoriented node orients it and carries its rules",
  implicit.oriented === true &&
    implicit.rules.oriented_on.includes("i-use-2") &&
    // f-core's text reached this session with the node_ids orient: only its version comes back.
    implicit.rules.entries.some((e) => e.node_id === "f-core" && e.unchanged === true),
  JSON.stringify(implicit).slice(0, 300)
);
const stillGated = await raw("record_decision", { node_id: "i-use-3", decision: "x", alternatives: ["y"], why: "z" });
check("other writes still Block on an unoriented node", stillGated.error && stillGated.text.startsWith("Blocked: Orientation"));

// --- 8: ship closes spec and impl; passing linked tests close verify ---
await call("create_node", { id: "f-solo", type: "Foundation", role: "infra", title: "Solo", description: "Infra — a lone module." });
const soloFile = path.join(root, "mindplan/foundations/f-solo/f-solo.mdx");
let soloText = fs.readFileSync(soloFile, "utf-8");
soloText = soloText.replace(/^_.*?_$/gm, (line) => (line.includes("attachments/") ? line : "Solo territory."));
fs.writeFileSync(soloFile, soloText);
await call("set_implementation_files", { node_id: "f-solo", files: ["src/solo/solo.ts"], replace: true });
await call("set_test_files", { node_id: "f-solo", files: ["src/solo/solo.test.mjs"], replace: true });
for (const new_status of ["ready", "in-progress", "in-review"]) await call("update_node_status", { node_id: "f-solo", new_status });
const early = await raw("update_node_status", { node_id: "f-solo", new_status: "ship" });
check(
  "ship with spec and impl unticked Blocks only on verify, naming run_tests",
  early.error && early.text.includes("1 unchecked checkbox") && early.text.includes("run_tests"),
  early.text
);
const noCommand = await raw("run_check", { run_tests: true, nodes: ["f-solo"] });
check("run_tests without tests.command is Blocked with the patch_config call", noCommand.error && noCommand.text.includes("tests.command"), noCommand.text);
await call("patch_config", { tests: { command: 'node -e "process.exit(3)" {files}' } });
const failing = await call("run_check", { run_tests: true, nodes: ["f-solo"] });
check(
  "a failing test run fails the check with Blocked: Tests",
  failing.ok === false && failing.tests?.passed === false && failing.failures.some((l) => l.startsWith("Blocked: Tests:")),
  JSON.stringify(failing.tests)
);
check("verify stays open after a failing run", (await raw("update_node_status", { node_id: "f-solo", new_status: "ship" })).error);
await call("patch_config", { tests: { command: 'node -e "process.exit(0)" {files}' } });
const passing = await call("run_check", { run_tests: true, nodes: ["f-solo"] });
check(
  "a passing run records the node's tests as green",
  passing.tests?.passed === true && passing.tests.nodes.includes("f-solo") && passing.tests.files.includes("src/solo/solo.test.mjs"),
  JSON.stringify(passing.tests)
);
const shipped = await raw("update_node_status", { node_id: "f-solo", new_status: "ship" });
check("ship then passes with no box ticked by hand", !shipped.error, shipped.text.slice(0, 200));

// --- the reported session, replayed: 5 revisions, ~20 drifting files, replies under 8 KB ---
const shippedIds = ["f-solo"];
for (let n = 1; n <= 4; n++) {
  const id = `f-s${n}`;
  write(`src/s${n}/main.ts`, `export const s${n} = 1;\n`);
  write(`src/s${n}/main.test.mjs`, "\n");
  await call("create_node", { id, type: "Foundation", role: "infra", title: `Module ${n}`, description: `Infra — module ${n}.` });
  const file = path.join(root, `mindplan/foundations/${id}/${id}.mdx`);
  fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replace(/^_.*?_$/gm, (line) => (line.includes("attachments/") ? line : `Module ${n} territory.`)));
  await call("set_implementation_files", { node_id: id, files: [`src/s${n}/`], replace: true });
  await call("set_test_files", { node_id: id, files: [`src/s${n}/main.test.mjs`], replace: true });
  for (const new_status of ["ready", "in-progress", "in-review"]) await call("update_node_status", { node_id: id, new_status });
  shippedIds.push(id);
}
await call("run_check", { run_tests: true, nodes: shippedIds.slice(1) });
for (const id of shippedIds.slice(1)) await call("update_node_status", { node_id: id, new_status: "ship" });
const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf-8" });
git("init", "-q");
git("config", "user.email", "test@example.com");
git("config", "user.name", "Test");
git("add", ".");
git("commit", "-qm", "baseline");
for (let n = 1; n <= 4; n++) for (let k = 0; k < 5; k++) write(`src/s${n}/extra-${k}.ts`, `export const x${k} = ${n};\n`);

await session();
const sizes = [];
let retries = 0;
for (const id of shippedIds) {
  const r = await raw("open_next", { node_id: id, change: "legal-pages", reason: "behavior" });
  sizes.push(bytes(r));
  if (r.error && r.text.startsWith("Blocked: Orientation")) retries++;
  check(`open_next on ${id} needs no orient first`, !r.error, r.text.slice(0, 200));
}
check(`no orientation retries across ${shippedIds.length} revisions`, retries === 0);
const read1 = await raw("get_node_context", { node_id: "f-s1", slot: "next", section: "## Purpose" });
const read1Json = JSON.parse(read1.text);
sizes.push(bytes(read1));
check(
  "the first read lists the drifting paths once",
  read1Json.drift?.count === 20 && read1Json.drift.new_since_last_reply.length === 20,
  JSON.stringify(read1Json.drift).slice(0, 200)
);
const read2 = await raw("orient_for_work", { node_id: "f-s2", section: "## Purpose" });
const read2Json = JSON.parse(read2.text);
sizes.push(bytes(read2));
check(
  "later replies carry the count only",
  read2Json.drift?.count === 20 && read2Json.drift.new_since_last_reply.length === 0,
  JSON.stringify(read2Json.drift)
);
const radius = await raw("get_blast_radius", { node_id: "f-core" });
sizes.push(bytes(radius));
const coreSection = await raw("get_node_context", { node_id: "f-core", section: "## Shared Substrate Spec" });
const coreBody = JSON.parse(coreSection.text).body;
check(
  `a large section read is the section plus a small envelope (${bytes(coreSection)} bytes, body ${Buffer.byteLength(coreBody)})`,
  bytes(coreSection) - Buffer.byteLength(JSON.stringify(coreBody)) < 2048
);
check(`every scenario reply is under 8 KB (largest ${Math.max(...sizes)} bytes)`, sizes.every((b) => b < 8192), sizes.join(","));

await client.close();

// --- 9: fan-in from one glob claim counts as one dependent ---
const openClosed = await import(pathToFileURL(path.join(toolRoot, "dist/foundations/f-compiler-rules/open-closed.js")).href);
const node = (id, type, implementsList) => ({ id, type, state: "stable", title: id, description: "", implements: implementsList });
const graph = {
  nodes: [
    node("i-legal", "Interaction", ["src/templates/*/blocks/Legal/"]),
    node("if-a", "Interface", ["src/templates/a/"]),
    node("if-b", "Interface", ["src/templates/b/"]),
    node("if-c", "Interface", ["src/templates/c/"]),
    // Inside a template folder, but beside blocks/Legal: the glob does not reach it.
    node("if-d", "Interface", ["src/templates/d/views/"]),
    node("if-web", "Interface", ["src/web/"]),
  ],
  edges: ["if-a", "if-b", "if-c", "if-d", "if-web"].map((source) => ({ source, target: "i-legal", type: "exposes" })),
};
const fan = openClosed.fanIn(graph, graph.nodes[0]);
check(
  "dependents one glob claim reaches count once, the rest one each",
  fan.count === 3 && fan.raw_count === 5 && fan.glob_groups?.[0]?.nodes.join() === "if-a,if-b,if-c",
  JSON.stringify(fan)
);
check("a claim above the glob's wildcard does not overlap it", !openClosed.claimsOverlap("src/", "src/templates/*/blocks/Legal/"));
const plain = openClosed.fanIn({ ...graph, nodes: [node("i-legal", "Interaction", ["src/legal/"]), ...graph.nodes.slice(1)] }, node("i-legal", "Interaction", ["src/legal/"]));
check("without a glob claim every dependent counts", plain.count === 5 && plain.raw_count === undefined, JSON.stringify(plain));
const hotspot = {
  node_id: "i-legal",
  type: "Interaction",
  rate: 4,
  median: 1,
  fan_in: 1,
  single_glob: "src/templates/*/blocks/Legal/",
  diagnosis: { kind: "split", wiring: 1, behavior: 3, unrecorded: 0 },
  changes: [],
};
const text = openClosed.hotspotWarning(hotspot);
check(
  "a single-glob hotspot keeps the reason mix and drops the registry and split advice",
  text.includes("rate by reason") === false && text.includes("Rate by reason: wiring 1, behavior 3") && !text.includes("registry Foundation") && !text.includes("split it into"),
  text
);

// --- the budget never hides rule text, and does not shred lists for rule text it cannot cut ---
const pages = await import(pathToFileURL(path.join(toolRoot, "dist/foundations/f-tool-kit/pages.js")).href);
const bigRule = "x".repeat(5000);
const cutReply = pages.budgetReply(
  { oriented_rules: { entries: [{ rules: bigRule }, { rules: bigRule }] }, decisions: { entries: [{ d: "a" }, { d: "b" }, { d: "c" }] } },
  1000
);
check(
  "oriented_rules is never cut, and small lists beside protected text stay whole",
  cutReply.oriented_rules.entries.length === 2 && cutReply.decisions.entries.length === 3 && cutReply.truncated === undefined,
  JSON.stringify(cutReply.truncated)
);
const mixed = pages.budgetReply({ rules: { entries: [{ rules: bigRule }] }, rows: Array.from({ length: 400 }, (_, i) => ({ i, pad: "y".repeat(40) })) }, 1000);
check(
  "with protected text over the cap, the lists are still cut to near its size",
  mixed.rules.entries[0].rules === bigRule && mixed.rows.length < 400 && mixed.truncated?.[0]?.path === "rows",
  String(mixed.rows.length)
);

fs.rmSync(root, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\nlighter-calls.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nlighter-calls.test.mjs: all ok");
