/**
 * No mirror twin: a shipped Foundation/Interaction/Interface has no `<id>.next.mdx` unless a
 * revision is open. Live writes on a shipped node (stability recompute on link/unlink and status
 * moves, live territory patches, live edge writes, rules, tests, aliases, decisions) touch only
 * `<id>.mdx`; no write ever creates a `state: mirror` file. open_next creates
 * the next file; ship and discard_next delete it and list every deleted path. A hand-written
 * leftover `state: mirror` file loads as no revision, warns in run_check, is replaced by
 * open_next, and is deleted by force_unship. Every write here is also diffed against the sandbox
 * on disk: each mindplan/ file it created, changed, or deleted must be in its changed_files.
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
let mirrorWrites = 0;

/** Call a write tool and check that its changed_files covers every file it touched on disk. */
async function call(tool, args) {
  const before = snapshot();
  const res = await client.callTool({ name: tool, arguments: args });
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
  const res = await client.callTool({ name: tool, arguments: args });
  return res.isError ? (res.content?.[0]?.text ?? "") : null;
}

const nextOf = (kind, id) => `mindplan/${kind}/${id}/${id}.next.mdx`;
const liveOf = (kind, id) => `mindplan/${kind}/${id}/${id}.mdx`;
const attachDirOf = (kind, id) => `mindplan/${kind}/${id}/next-attachments`;
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
await call("create_node", { id: "j-app", type: "Journey", title: "App", description: "App area" });
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
await call("set_implementation_files", { node_id: "f-core", files: ["src/f-core/index.ts"] });
await call("set_implementation_files", { node_id: "i-a", files: ["src/i-a/a.ts"] });
await call("set_implementation_files", { node_id: "i-b", files: ["src/i-b/b.ts"] });
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
  const tested = await call("set_test_files", { node_id: "f-core", files: ["tests/core.test.ts"] });
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
    "record_decision lists the live file",
    recorded.slot === "current" && recorded.changed_files.includes(liveOf("foundations", "f-core")),
    JSON.stringify(recorded)
  );
  liveOnly("record_decision on a shipped node writes no next file", recorded, "foundations", "f-core");
}

// --- open_next creates the next file; patches land there; ship deletes it and lists what it deleted ---
{
  const opened = await call("open_next", { node_id: "f-core" });
  const nextText = exists(nextOf("foundations", "f-core")) ? read(nextOf("foundations", "f-core")) : "";
  check(
    "open_next creates the next file as a draft with unticked Atomic Ops and lists it",
    opened.changed_files.includes(nextOf("foundations", "f-core")) &&
      opened.changed_files.includes(`${attachDirOf("foundations", "f-core")}/.gitkeep`) &&
      /^state: draft\s*$/m.test(nextText) &&
      /^## Atomic Ops/m.test(nextText) &&
      nextText.includes("- [ ]") &&
      exists(`${attachDirOf("foundations", "f-core")}/.gitkeep`),
    JSON.stringify(opened)
  );
  const liveBefore = read(liveOf("foundations", "f-core"));
  const nextPatch = await call("patch_node_territory", {
    node_id: "f-core",
    replace: { find: "Twins-test patched live.", with: "Twins-test next revision.", all: true },
  });
  check(
    "a patch on an open revision lists only the next file",
    nextPatch.slot === "next" &&
      nextPatch.changed_files.includes(nextOf("foundations", "f-core")) &&
      !nextPatch.changed_files.includes(liveOf("foundations", "f-core")) &&
      read(liveOf("foundations", "f-core")) === liveBefore,
    JSON.stringify(nextPatch)
  );
  // The revision ticks its own fresh ops and records its decision before it ships.
  await call("patch_node_territory", { node_id: "f-core", toggle_checkboxes: [{ contains: "- [ ]", checked: true, all: true }] });
  await call("record_decision", {
    node_id: "f-core",
    decision: "Core text is revised.",
    alternatives: ["Keep the old text"],
    why: "The twins test ships a revision.",
  });
  await walk("f-core", ["ready", "in-progress", "in-review"]);
  const shipped = await call("update_node_status", { node_id: "f-core", new_status: "ship" });
  check(
    "shipping a revision writes the live file, deletes the next file and next-attachments/, and lists them",
    read(liveOf("foundations", "f-core")).includes("Twins-test next revision.") &&
      shipped.changed_files.includes(liveOf("foundations", "f-core")) &&
      shipped.changed_files.includes(nextOf("foundations", "f-core")) &&
      shipped.changed_files.includes(`${attachDirOf("foundations", "f-core")}/.gitkeep`) &&
      !exists(nextOf("foundations", "f-core")) &&
      !exists(attachDirOf("foundations", "f-core")),
    JSON.stringify(shipped)
  );
  check(
    "after ship the node has no open revision",
    (await blocked("get_node_context", { node_id: "f-core", slot: "next" })) !== null
  );
}

// --- discard_next deletes the next file, its attachments, and the folder ---
{
  await call("open_next", { node_id: "i-a" });
  await call("put_attachment", {
    node_id: "i-a",
    filename: "note.txt",
    content_base64: Buffer.from("revision note\n").toString("base64"),
  });
  check("the attachment lands under next-attachments/", exists(`${attachDirOf("interactions", "i-a")}/note.txt`));
  const discarded = await call("discard_next", { node_id: "i-a" });
  const dir = attachDirOf("interactions", "i-a");
  check(
    "discard_next deletes the next file and next-attachments/ and lists every deleted path and map.md",
    discarded.discarded === true &&
      !("restored_mirror" in discarded) &&
      discarded.changed_files.includes(nextOf("interactions", "i-a")) &&
      discarded.changed_files.includes(`${dir}/.gitkeep`) &&
      discarded.changed_files.includes(`${dir}/note.txt`) &&
      discarded.changed_files.some((f) => f === dir || f === `${dir}/`) &&
      discarded.changed_files.includes("mindplan/map.md") &&
      !exists(nextOf("interactions", "i-a")) &&
      !exists(dir),
    JSON.stringify(discarded)
  );
  check(
    "discard_next with no open revision is Blocked",
    (await blocked("discard_next", { node_id: "i-a" })) !== null
  );
}

// --- a hand-written leftover mirror is not a revision: it warns, open_next replaces it ---
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
  const opened = await call("open_next", { node_id: "f-core" });
  const text = read(nextOf("foundations", "f-core"));
  check(
    "open_next replaces a leftover mirror with a draft revision",
    opened.changed_files.includes(nextOf("foundations", "f-core")) &&
      /^state: draft\s*$/m.test(text) &&
      !/^state: mirror\s*$/m.test(text) &&
      text.includes("Twins-test live again."),
    JSON.stringify(opened)
  );
  const after = await call("run_check", {});
  check("the leftover warning is gone once open_next replaced it", !after.warnings.some((w) => w.startsWith("legacy:")), JSON.stringify(after.warnings));
  await call("discard_next", { node_id: "f-core" });
  check("discarding that revision leaves no next file", !exists(nextOf("foundations", "f-core")));
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
