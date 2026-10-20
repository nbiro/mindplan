/**
 * Mirror-twin reporting: a write that re-syncs a shipped node's `<id>.next.mdx` twin lists it in
 * changed_files (stability recompute on link/unlink and status moves, live territory patches,
 * live edge writes). Every write here is also diffed against the sandbox on disk: each mindplan/
 * file it created, changed, or deleted must be in its changed_files.
 * Run via npm test.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

/** Call a write tool and check that its changed_files covers every file it touched on disk. */
async function call(tool, args) {
  const before = snapshot();
  const res = await client.callTool({ name: tool, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(`${tool}: ${text}`);
  const result = JSON.parse(text || "{}");
  if (Array.isArray(result.changed_files)) {
    diffedWrites++;
    const missing = touched(before, snapshot()).filter((rel) => !result.changed_files.includes(rel));
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

const twinOf = (kind, id) => `mindplan/${kind}/${id}/${id}.next.mdx`;
const liveOf = (kind, id) => `mindplan/${kind}/${id}/${id}.mdx`;

/** True when the twin is the live file with only `state:` changed to mirror. */
function twinInSync(kind, id) {
  const live = fs.readFileSync(path.join(root, ...liveOf(kind, id).split("/")), "utf-8");
  const twin = fs.readFileSync(path.join(root, ...twinOf(kind, id).split("/")), "utf-8");
  const strip = (raw) => raw.replace(/^state:.*$/m, "state: <ignored>");
  return /^state: mirror$/m.test(twin) && strip(live) === strip(twin);
}

/** Fill create_node scaffold stubs with real text and tick every checkbox (before any twin exists). */
function fillAndTick(kind, id) {
  const file = path.join(root, "mindplan", kind, id, `${id}.mdx`);
  let text = fs.readFileSync(file, "utf-8");
  text = text.replace(/^_.*?_$/gm, (line) => (line.includes("attachments/") ? line : "Twins-test filled territory."));
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

// --- base graph: a shipped Foundation and a shipped Interaction, each with a mirror twin ---
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
await call("set_implementation_files", { node_id: "f-core", files: ["src/f-core/index.ts"] });
await call("set_implementation_files", { node_id: "i-a", files: ["src/i-a/a.ts"] });
await call("set_implementation_files", { node_id: "i-b", files: ["src/i-b/b.ts"] });
fillAndTick("foundations", "f-core");
fillAndTick("interactions", "i-a");
await walk("f-core", ["ready", "in-progress", "in-review", "ship"]);
await walk("i-a", ["ready", "in-progress", "in-review", "ship"]);
check(
  "shipped nodes start with in-sync mirror twins",
  twinInSync("foundations", "f-core") && twinInSync("interactions", "i-a")
);

// --- link_nodes affects: the stability recompute re-syncs the target's twin ---
{
  await call("create_node", { id: "bug-core", type: "Bug", title: "Core bug", description: "Core breaks" });
  const linked = await call("link_nodes", { source_id: "bug-core", target_id: "f-core", edge_type: "affects" });
  check(
    "link_nodes affects lists the re-synced twin of the node it made unstable",
    linked.stability_recomputed.some((n) => n.id === "f-core" && n.state === "unstable") &&
      linked.changed_files.includes(liveOf("foundations", "f-core")) &&
      linked.changed_files.includes(twinOf("foundations", "f-core")),
    JSON.stringify(linked)
  );
  check("the twin matches the unstable live file", twinInSync("foundations", "f-core"));
}

// --- Bug resolved: the stability recompute re-syncs the twin again ---
{
  await call("patch_node_territory", { node_id: "bug-core", body: BUG_BODY });
  await walk("bug-core", ["triaged", "fixing", "in-review"]);
  const resolved = await call("update_node_status", { node_id: "bug-core", new_status: "resolved" });
  check(
    "Bug resolved lists the re-synced twin of the node it made stable",
    resolved.stability_recomputed.some((n) => n.id === "f-core" && n.state === "stable") &&
      resolved.changed_files.includes(twinOf("foundations", "f-core")),
    JSON.stringify(resolved)
  );
  check("the twin matches the stable live file", twinInSync("foundations", "f-core"));
}

// --- unlink_nodes affects and a batch status call report recomputed twins too ---
{
  await call("create_node", { id: "bug-two", type: "Bug", title: "Second bug", description: "Core breaks again" });
  await call("link_nodes", { source_id: "bug-two", target_id: "f-core", edge_type: "affects" });
  const unlinked = await call("unlink_nodes", { source_id: "bug-two", target_id: "f-core" });
  check(
    "unlink_nodes affects lists the re-synced twin",
    unlinked.changed_files.includes(twinOf("foundations", "f-core")),
    JSON.stringify(unlinked)
  );
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
    "a batch status call lists the re-synced twin",
    batch.changed_files.includes(twinOf("foundations", "f-core")),
    JSON.stringify(batch)
  );
}

// --- patch_node_territory on a shipped node's live slot (no open evolution) ---
{
  const patched = await call("patch_node_territory", {
    node_id: "f-core",
    replace: { find: "Twins-test filled territory.", with: "Twins-test patched live.", all: true },
  });
  check(
    "patch_node_territory on a shipped live node lists the re-synced twin",
    patched.slot === "current" &&
      patched.changed_files.includes(liveOf("foundations", "f-core")) &&
      patched.changed_files.includes(twinOf("foundations", "f-core")) &&
      !("twin" in patched),
    JSON.stringify(patched)
  );
  check("the twin carries the live patch", twinInSync("foundations", "f-core"));
}

// --- live edge writes on a shipped source node ---
{
  const linked = await call("link_nodes", { source_id: "i-a", target_id: "i-b", edge_type: "leads_to" });
  check(
    "link_nodes on a shipped source's live slot lists its re-synced twin",
    linked.slot === "current" && linked.changed_files.includes(twinOf("interactions", "i-a")),
    JSON.stringify(linked)
  );
  const unlinked = await call("unlink_nodes", { source_id: "i-a", target_id: "i-b" });
  check(
    "unlink_nodes on a shipped source lists its re-synced twin",
    unlinked.changed_files.includes(twinOf("interactions", "i-a")),
    JSON.stringify(unlinked)
  );
  check("the source twin matches live", twinInSync("interactions", "i-a"));
}

// --- record_decision (the reference) still lists both files; an open evolution leaves live alone ---
{
  const recorded = await call("record_decision", {
    node_id: "f-core",
    decision: "Core keeps one export.",
    alternatives: ["Split core into two modules"],
    why: "One caller needs it.",
  });
  check(
    "record_decision lists the live file and the twin",
    recorded.changed_files.includes(liveOf("foundations", "f-core")) &&
      recorded.changed_files.includes(twinOf("foundations", "f-core")),
    JSON.stringify(recorded)
  );
  await call("open_next", { node_id: "f-core" });
  const nextPatch = await call("patch_node_territory", {
    node_id: "f-core",
    replace: { find: "Twins-test patched live.", with: "Twins-test next revision.", all: true },
  });
  check(
    "a patch on an open evolution lists only the next file",
    nextPatch.slot === "next" &&
      nextPatch.changed_files.includes(twinOf("foundations", "f-core")) &&
      !nextPatch.changed_files.includes(liveOf("foundations", "f-core")),
    JSON.stringify(nextPatch)
  );
}

check(`each of ${diffedWrites} writes listed every mindplan/ file it touched`, diffMisses === 0, `${diffMisses} write(s) missed files`);

await client.close();
if (failures > 0) {
  console.log(`\ntwins.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ntwins.test.mjs: all ok");
