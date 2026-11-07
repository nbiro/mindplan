/**
 * No mirror twin: a shipped Foundation/Interaction/Interface has no `<id>.next.mdx` unless a
 * revision is open. Live writes on a shipped node (stability recompute on link/unlink and status
 * moves, live territory patches, live edge writes, rules, tests, aliases, decisions) touch only
 * `<id>.mdx`; no write ever creates a `state: mirror` file. open_next creates
 * `revisions/<change>/<id>.mdx`; ship and discard_next delete the revision folder and list every
 * deleted path. A hand-written leftover `state: mirror` file loads as no revision, warns in
 * run_check, is removed by open_next, and is deleted by force_unship; a `<id>.next.mdx` evolution
 * from an older release is never read (the version gate names upgrade_project). Every write here is also
 * diffed against the sandbox on disk: each mindplan/ file it created, changed, or deleted (the
 * derived map.md excepted) must be in its changed_files, and map.md never is.
 * Run via npm test.
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-twins-"));
console.log("Twins sandbox:", root);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, MINDPLAN_ROOT: root },
});
const client = new Client({ name: "twins-test", version: "0.1.0" });
await client.connect(transport);
// A session reads the project rules first (writes are Blocked: Rules until then), as an agent does.
await client.callTool({ name: "get_project", arguments: {} });

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

/** Derived after every write and never listed in changed_files. */
const MAP = "mindplan/map.md";

/** Paths created, changed, or deleted between two snapshots (the derived map excluded). */
function touched(before, after) {
  const out = [];
  for (const [rel, text] of after) if (rel !== MAP && before.get(rel) !== text) out.push(rel);
  for (const rel of before.keys()) if (rel !== MAP && !after.has(rel)) out.push(rel);
  return out;
}

let diffedWrites = 0;
let diffMisses = 0;
let mirrorWrites = 0;

/** Call a write tool and check that its changed_files covers every file it touched on disk. */
async function call(tool, args) {
  const before = snapshot();
  const res = await client.callTool({ name: tool, arguments: tool === "run_check" ? { compact: false, ...args } : args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(`${tool}: ${text}`);
  const result = JSON.parse(text || "{}");
  const after = snapshot();
  const changed = touched(before, after);
  // No write may leave a mirror file behind.
  const mirrors = changed.filter((rel) => after.has(rel) && /^state: mirror\s*$/m.test(after.get(rel)));
  if (mirrors.length > 0) {
    mirrorWrites++;
    check(`${tool} ${JSON.stringify(args).slice(0, 80)} writes no mirror file`, false, JSON.stringify(mirrors));
  }
  if (Array.isArray(result.changed_files)) {
    diffedWrites++;
    const missing = changed.filter((rel) => !result.changed_files.includes(rel));
    if (result.changed_files.includes(MAP)) {
      diffMisses++;
      check(`${tool} ${JSON.stringify(args).slice(0, 80)} never lists ${MAP}`, false, JSON.stringify(result.changed_files));
    }
    // Report only misses: every write in this file runs through here.
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

/** Call a tool expecting a Blocked error; returns its text, or null when it did not block. */
async function blocked(tool, args) {
  const res = await client.callTool({ name: tool, arguments: tool === "run_check" ? { compact: false, ...args } : args });
  return res.isError ? (res.content?.[0]?.text ?? "") : null;
}

const nextOf = (kind, id) => `mindplan/${kind}/${id}/${id}.next.mdx`;
const liveOf = (kind, id) => `mindplan/${kind}/${id}/${id}.mdx`;
const attachDirOf = (kind, id) => `mindplan/${kind}/${id}/next-attachments`;
const revDirOf = (kind, id, change) => `mindplan/${kind}/${id}/revisions/${change}`;
const revOf = (kind, id, change) => `${revDirOf(kind, id, change)}/${id}.mdx`;
const abs = (rel) => path.join(root, ...rel.split("/"));
const exists = (rel) => fs.existsSync(abs(rel));
const read = (rel) => fs.readFileSync(abs(rel), "utf-8");

/** No `.next.mdx` path in changed_files, and no next file on disk. */
function liveOnly(label, result, kind, id) {
  const nextPaths = (result.changed_files ?? []).filter((f) => f.endsWith(".next.mdx"));
  check(
    label,
    nextPaths.length === 0 && !exists(nextOf(kind, id)) && !exists(attachDirOf(kind, id)),
    JSON.stringify(result)
  );
}

/** Fill create_node scaffold stubs with real text and tick every checkbox. */
function fillAndTick(kind, id) {
  const file = abs(liveOf(kind, id));
  let text = fs.readFileSync(file, "utf-8");
  text = text.replace(/^_.*?_$/gm, (line) => (line.includes("attachments/") ? line : "Twins-test filled territory."));
  text = text.replace(/^## Checklist\s*$/m, "## Atomic Ops");
  if (!/^\s*[-*+]\s+\[[ xX]\]/m.test(text)) text += "\n- [ ] Done\n";
  text = text.replaceAll("- [ ]", "- [x]");
  fs.writeFileSync(file, text);
}

function write(rel, content) {
  const file = abs(rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Hand-write a leftover mirror twin (as releases before 0.8.0 kept): the live file with state: mirror. */
function writeLeftoverMirror(kind, id) {
  write(nextOf(kind, id), read(liveOf(kind, id)).replace(/^state:.*$/m, "state: mirror"));
}

async function walk(id, steps) {
  for (const new_status of steps) await call("update_node_status", { node_id: id, new_status });
}

/** A Bug's written contract with its fix checklist done, so it can walk to resolved. */
const BUG_BODY = [
  "# Core bug",
  "",
  "## Summary",
  "",
  "Core returns the wrong value.",
  "",
  "## Repro Steps",
  "",
  "1. Call core",
  "2. Read the value",
  "",
  "## Expected / Actual",
  "",
  "**Expected:** 1",
  "",
  "**Actual:** 2",
  "",
  "## Fix Checklist",
  "",
  "- [x] Root cause identified",
  "- [x] Fix implemented",
  "- [x] Regression test added",
  "",
].join("\n");

fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
fs.writeFileSync(
  path.join(root, "mindplan", "config.json"),
  JSON.stringify({ sources: ["src/**"], exclude: [] }, null, 2) + "\n"
);

// --- base graph: a shipped Foundation and a shipped Interaction; first ship writes no next file ---
await call("create_node", { id: "j-app", type: "Capability", title: "App", description: "App area" });
await call("create_node", { id: "f-core", type: "Foundation", title: "Core", description: "Infra — core", role: "infra" });
await call("create_node", { id: "i-a", type: "Interaction", title: "A", description: "Action A" });
await call("create_node", { id: "i-b", type: "Interaction", title: "B", description: "Action B" });
await call("link_nodes", { source_id: "i-a", target_id: "j-app", edge_type: "belongs_to" });
await call("link_nodes", { source_id: "i-a", target_id: "f-core", edge_type: "depends_on" });
await call("link_nodes", { source_id: "i-b", target_id: "j-app", edge_type: "belongs_to" });
await call("link_nodes", { source_id: "i-b", target_id: "f-core", edge_type: "depends_on" });
write("src/f-core/index.ts", "export const core = 1;\n");
write("src/i-a/a.ts", 'import { core } from "../f-core/index.js";\nexport const a = core;\n');
write("src/i-b/b.ts", 'import { core } from "../f-core/index.js";\nexport const b = core;\n');
write("tests/core.test.ts", "export {};\n");
await call("set_implementation_files", { replace: true, node_id: "f-core", files: ["src/f-core/index.ts"] });
await call("set_implementation_files", { replace: true, node_id: "i-a", files: ["src/i-a/a.ts"] });
await call("set_implementation_files", { replace: true, node_id: "i-b", files: ["src/i-b/b.ts"] });
fillAndTick("foundations", "f-core");
fillAndTick("interactions", "i-a");
await walk("f-core", ["ready", "in-progress", "in-review"]);
{
  const shipped = await call("update_node_status", { node_id: "f-core", new_status: "ship" });
  liveOnly("first ship writes no next file and lists none", shipped, "foundations", "f-core");
}
await walk("i-a", ["ready", "in-progress", "in-review", "ship"]);
check(
  "shipped nodes have no next file",
  !exists(nextOf("foundations", "f-core")) && !exists(nextOf("interactions", "i-a"))
);
check(
  "get_node_context of a shipped node with no open revision Blocks the next slot",
  (await blocked("get_node_context", { node_id: "f-core", slot: "next" })) !== null
);

// --- link_nodes affects: the stability recompute touches only the live file ---
{
  await call("create_node", { id: "bug-core", type: "Bug", title: "Core bug", description: "Core breaks" });
  const linked = await call("link_nodes", { source_id: "bug-core", target_id: "f-core", edge_type: "affects" });
  check(
    "link_nodes affects lists the live file of the node it made unstable",
    linked.stability_recomputed.some((n) => n.id === "f-core" && n.state === "unstable") &&
      linked.changed_files.includes(liveOf("foundations", "f-core")),
    JSON.stringify(linked)
  );
  liveOnly("link_nodes affects writes no next file", linked, "foundations", "f-core");
  check("the live file is unstable", /^state: unstable\s*$/m.test(read(liveOf("foundations", "f-core"))));
}

// --- Bug resolved: the stability recompute touches only the live file ---
{
  await call("patch_node_territory", { node_id: "bug-core", body: BUG_BODY });
  await walk("bug-core", ["triaged", "fixing", "in-review"]);
  const resolved = await call("update_node_status", { node_id: "bug-core", new_status: "resolved" });
  check(
    "Bug resolved lists the live file of the node it made stable",
    resolved.stability_recomputed.some((n) => n.id === "f-core" && n.state === "stable") &&
      resolved.changed_files.includes(liveOf("foundations", "f-core")),
    JSON.stringify(resolved)
  );
  liveOnly("Bug resolved writes no next file", resolved, "foundations", "f-core");
}

// --- unlink_nodes affects and a batch status call touch only live files too ---
{
  await call("create_node", { id: "bug-two", type: "Bug", title: "Second bug", description: "Core breaks again" });
  await call("link_nodes", { source_id: "bug-two", target_id: "f-core", edge_type: "affects" });
  const unlinked = await call("unlink_nodes", { source_id: "bug-two", target_id: "f-core" });
  check(
    "unlink_nodes affects lists the recomputed live file",
    unlinked.changed_files.includes(liveOf("foundations", "f-core")),
    JSON.stringify(unlinked)
  );
  liveOnly("unlink_nodes affects writes no next file", unlinked, "foundations", "f-core");
  await call("link_nodes", { source_id: "bug-two", target_id: "f-core", edge_type: "affects" });
  await call("patch_node_territory", { node_id: "bug-two", body: BUG_BODY });
  await call("update_node_status", {
    revisions: [{ node_id: "bug-two", new_status: "triaged" }],
  });
  await walk("bug-two", ["fixing", "in-review"]);
  const batch = await call("update_node_status", {
    revisions: [{ node_id: "bug-two", new_status: "resolved" }],
  });
  check(
    "a batch status call lists the recomputed live file",
    batch.changed_files.includes(liveOf("foundations", "f-core")),
    JSON.stringify(batch)
  );
  liveOnly("a batch status call writes no next file", batch, "foundations", "f-core");
}

// --- patch_node_territory on a shipped node's live slot (no open revision) ---
{
  const patched = await call("patch_node_territory", {
    node_id: "f-core",
    replace: { find: "Twins-test filled territory.", with: "Twins-test patched live.", all: true },
  });
  check(
    "patch_node_territory on a shipped live node writes the live slot",
    patched.slot === "current" && patched.changed_files.includes(liveOf("foundations", "f-core")) && !("twin" in patched),
    JSON.stringify(patched)
  );
  liveOnly("patch_node_territory on a shipped live node writes no next file", patched, "foundations", "f-core");
  const aliased = await call("patch_node_territory", { node_id: "f-core", aliases: ["core"] });
  liveOnly("an alias write on a shipped node writes no next file", aliased, "foundations", "f-core");
  const ruled = await call("patch_node_rules", { node_id: "f-core", rules: "- Core keeps one export." });
  liveOnly("patch_node_rules on a shipped node writes no next file", ruled, "foundations", "f-core");
  const tested = await call("set_test_files", { replace: true, node_id: "f-core", files: ["tests/core.test.ts"] });
  liveOnly("set_test_files on a shipped node writes no next file", tested, "foundations", "f-core");
}

// --- live edge writes on a shipped source node ---
{
  // f-core's rules changed above, and they reach i-a: re-orient before writing it.
  await client.callTool({ name: "orient_for_work", arguments: { node_id: "i-a" } });
  const linked = await call("link_nodes", { source_id: "i-a", target_id: "i-b", edge_type: "leads_to" });
  check(
    "link_nodes on a shipped source writes its live slot",
    linked.slot === "current" && linked.changed_files.includes(liveOf("interactions", "i-a")),
    JSON.stringify(linked)
  );
  liveOnly("link_nodes on a shipped source writes no next file", linked, "interactions", "i-a");
  const unlinked = await call("unlink_nodes", { source_id: "i-a", target_id: "i-b" });
  liveOnly("unlink_nodes on a shipped source writes no next file", unlinked, "interactions", "i-a");
}

// --- record_decision on a shipped node with no open revision ---
{
  const recorded = await call("record_decision", {
    node_id: "f-core",
    decision: "Core keeps one export.",
    alternatives: ["Split core into two modules"],
    why: "One caller needs it.",
  });
  check(
    "record_decision lists the decision file it wrote",
    recorded.slot === "current" &&
      recorded.changed_files.length === 1 &&
      recorded.changed_files[0] === "mindplan/foundations/f-core/decisions/d-core-keeps-one-export.md",
    JSON.stringify(recorded)
  );
  liveOnly("record_decision on a shipped node writes no next file", recorded, "foundations", "f-core");
}

// --- open_next creates a revision folder; ship deletes it and lists what it deleted ---
{
  const opened = await call("open_next", { reason: "behavior", node_id: "f-core", change: "twins" });
  const revText = exists(revOf("foundations", "f-core", "twins")) ? read(revOf("foundations", "f-core", "twins")) : "";
  check(
    "open_next creates revisions/<change>/<id>.mdx as a draft with unticked Atomic Ops and lists it",
    opened.changed_files.includes(revOf("foundations", "f-core", "twins")) &&
      /^state: draft\s*$/m.test(revText) &&
      /^## Atomic Ops/m.test(revText) &&
      revText.includes("- [ ]") &&
      !exists(nextOf("foundations", "f-core")) &&
      opened.revisions?.length === 1 &&
      opened.revisions[0].change === "twins",
    JSON.stringify(opened)
  );
  // The revision's text, ticks, and decision are written in its folder (the edit tools have their own suites).
  const revFile = revOf("foundations", "f-core", "twins");
  write(revFile, read(revFile).replaceAll("Twins-test patched live.", "Twins-test next revision.").replaceAll("- [ ]", "- [x]"));
  write(
    `${revDirOf("foundations", "f-core", "twins")}/decisions/d-core-revised.md`,
    [
      "### d-core-revised",
      "",
      "- Decision: Core text is revised.",
      "- Alternatives:",
      "  - Keep the old text",
      "- Why: The twins test ships a revision.",
      "- Change: twins",
      `- Date: ${new Date().toISOString().slice(0, 10)}`,
      "",
    ].join("\n")
  );
  write(`${revDirOf("foundations", "f-core", "twins")}/attachments/sketch.txt`, "revision sketch\n");
  await walk("f-core", ["ready", "in-progress", "in-review"]);
  const shipped = await call("update_node_status", { node_id: "f-core", new_status: "ship" });
  check(
    "shipping a revision writes the live file, deletes the revision folder, and lists every path",
    read(liveOf("foundations", "f-core")).includes("Twins-test next revision.") &&
      shipped.promoted_next === true &&
      shipped.changed_files.includes(liveOf("foundations", "f-core")) &&
      shipped.changed_files.includes(revOf("foundations", "f-core", "twins")) &&
      shipped.changed_files.includes("mindplan/foundations/f-core/attachments/sketch.txt") &&
      shipped.changed_files.includes("mindplan/foundations/f-core/decisions/d-core-revised.md") &&
      !exists(revDirOf("foundations", "f-core", "twins")) &&
      !exists("mindplan/foundations/f-core/revisions"),
    JSON.stringify(shipped)
  );
  check(
    "after ship the node has no open revision",
    (await blocked("get_node_context", { node_id: "f-core", slot: "next" })) !== null
  );
}

// --- discard_next deletes the revision folder with its attachments ---
{
  await call("open_next", { reason: "behavior", node_id: "i-a", change: "drop" });
  write(`${revDirOf("interactions", "i-a", "drop")}/attachments/note.txt`, "revision note\n");
  const discarded = await call("discard_next", { node_id: "i-a" });
  check(
    "discard_next deletes the revision folder and lists every deleted path, never map.md",
    discarded.discarded === true &&
      discarded.change === "drop" &&
      discarded.changed_files.includes(revOf("interactions", "i-a", "drop")) &&
      discarded.changed_files.includes(`${revDirOf("interactions", "i-a", "drop")}/attachments/note.txt`) &&
      !discarded.changed_files.includes("mindplan/map.md") &&
      !exists("mindplan/interactions/i-a/revisions"),
    JSON.stringify(discarded)
  );
  check(
    "discard_next with no open revision is Blocked",
    (await blocked("discard_next", { node_id: "i-a" })) !== null
  );
}

// --- a hand-written leftover mirror is not a revision: it warns, open_next removes it ---
{
  writeLeftoverMirror("foundations", "f-core");
  check(
    "a leftover mirror loads as no open revision",
    (await blocked("get_node_context", { node_id: "f-core", slot: "next" })) !== null
  );
  const discardMsg = await blocked("discard_next", { node_id: "f-core" });
  check(
    "discard_next on a leftover mirror is Blocked and names it",
    discardMsg !== null && discardMsg.includes("leftover mirror"),
    String(discardMsg)
  );
  const r = await call("run_check", {});
  const expected = `legacy: "f-core" has a leftover mirror twin (${nextOf("foundations", "f-core")}); call upgrade_project to remove it.`;
  check("run_check warns about the leftover mirror and passes", r.ok === true && r.warnings.includes(expected), JSON.stringify({ ok: r.ok, warnings: r.warnings, failures: r.failures }));
  const mirrorBefore = read(nextOf("foundations", "f-core"));
  const livePatch = await call("patch_node_territory", {
    node_id: "f-core",
    replace: { find: "Twins-test next revision.", with: "Twins-test live again.", all: true },
  });
  check(
    "a patch beside a leftover mirror writes the live slot and leaves the mirror alone",
    livePatch.slot === "current" &&
      !livePatch.changed_files.includes(nextOf("foundations", "f-core")) &&
      read(nextOf("foundations", "f-core")) === mirrorBefore,
    JSON.stringify(livePatch)
  );
  const opened = await call("open_next", { reason: "behavior", node_id: "f-core", change: "again" });
  const text = read(revOf("foundations", "f-core", "again"));
  check(
    "open_next deletes a leftover mirror, lists it, and opens a draft revision",
    opened.changed_files.includes(nextOf("foundations", "f-core")) &&
      !exists(nextOf("foundations", "f-core")) &&
      /^state: draft\s*$/m.test(text) &&
      text.includes("Twins-test live again."),
    JSON.stringify(opened)
  );
  const after = await call("run_check", {});
  check("the leftover warning is gone once open_next removed it", !after.warnings.some((w) => w.startsWith("legacy:")), JSON.stringify(after.warnings));
  await call("discard_next", { node_id: "f-core", change: "again" });
  check("discarding that revision leaves no revision folder", !exists("mindplan/foundations/f-core/revisions"));
}

// --- a <id>.next.mdx evolution from an older release is never read (the version gate, off here,
// sends the graph to upgrade_project: version.test.mjs) ---
{
  const legacy = nextOf("foundations", "f-core");
  write(legacy, read(liveOf("foundations", "f-core")).replace(/^state:.*$/m, "state: draft"));
  const ctx = JSON.parse((await client.callTool({ name: "get_node_context", arguments: { node_id: "f-core" } })).content[0].text);
  check("a legacy next file loads as no revision", ctx.next === null && !ctx.revisions, JSON.stringify(ctx.next));
  fs.rmSync(abs(legacy));
}

// --- force_unship deletes a leftover mirror ---
{
  writeLeftoverMirror("interactions", "i-a");
  const unshipped = await call("force_unship", { node_id: "i-a", confirm: "unship:i-a" });
  check(
    "force_unship deletes a leftover next file and lists it",
    unshipped.changed_files.includes(nextOf("interactions", "i-a")) && !exists(nextOf("interactions", "i-a")),
    JSON.stringify(unshipped)
  );
}

check(`each of ${diffedWrites} writes listed every mindplan/ file it touched`, diffMisses === 0, `${diffMisses} write(s) missed files`);
check("no write created or changed a state: mirror file", mirrorWrites === 0, `${mirrorWrites} write(s)`);

await client.close();
if (failures > 0) {
  console.log(`\ntwins.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ntwins.test.mjs: all ok");
