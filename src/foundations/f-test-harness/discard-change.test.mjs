/**
 * discard_change (npm test): one call drops a whole unshipped change — its open revisions, its
 * never-shipped nodes with their decisions, and its planned edges (also those pointing at a node
 * it removes) — and refuses, writing nothing, while a node that stays points at one that goes, or a
 * member once shipped.
 */
// Fixtures build graphs without a version stamp; the gate has its own suite (version.test.mjs).
process.env.MINDPLAN_VERSION_GATE ??= "off";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
process.env.MINDPLAN_SEARCH ??= "keyword";
delete process.env.MINDPLAN_ORIENT_GATE;

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-discard-change-"));
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const exists = (rel) => fs.existsSync(path.join(root, rel));
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf-8");
write("mindplan/config.json", JSON.stringify({ sources: ["src/**"], exclude: [] }) + "\n");
for (const dir of ["db", "old", "dash", "keep", "n1"]) write(`src/${dir}/${dir}.ts`, `export const ${dir} = 1;\n`);

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`ok   ${label}`);
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

async function session() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env, MINDPLAN_ROOT: root },
    stderr: "pipe",
  });
  const client = new Client({ name: "discard-change-test", version: "0.1.0" });
  await client.connect(transport);
  await client.callTool({ name: "get_project", arguments: {} });
  const raw = async (tool, args) => {
    const res = await client.callTool({ name: tool, arguments: tool === "run_check" ? { compact: false, ...args } : args });
    return { error: !!res.isError, text: res.content?.[0]?.text ?? "" };
  };
  const call = async (tool, args) => {
    const r = await raw(tool, args);
    if (r.error) throw new Error(`${tool}: ${r.text}`);
    return JSON.parse(r.text);
  };
  return { client, raw, call };
}

const SECTIONS = {
  Foundation: ["## Purpose", "## Shared Substrate Spec", "## Acceptance Criteria"],
  Interaction: ["## Purpose", "## Actor & Trigger", "## PRD / Execution Logic", "## Acceptance Criteria"],
  Interface: ["## Purpose", "## Kind", "## Spec", "## Acceptance Criteria"],
};

{
  const { client, raw, call } = await session();
  const complete = async (id, type, files) => {
    for (const heading of SECTIONS[type]) {
      await call("patch_node_territory", { node_id: id, section: heading, text: `Real ${heading.slice(3).toLowerCase()} for ${id}.` });
    }
    await call("patch_node_territory", { node_id: id, toggle_checkboxes: [{ id: "spec", checked: true }, { id: "impl", checked: true }, { id: "verify", checked: true }] });
    await call("set_implementation_files", { replace: true, node_id: id, files });
  };
  // A shipped base.
  await call("create_node", { id: "j-site", type: "Capability", title: "Site", description: "Visitors use the site." });
  await call("create_node", { id: "f-db", type: "Foundation", title: "Database", description: "Adapter — database access", role: "adapter", change: "base" });
  await call("create_node", { id: "i-old", type: "Interaction", title: "Read a page", description: "Visitor reads a page.", change: "base" });
  await call("create_node", { id: "i-keep", type: "Interaction", title: "Keep a page", description: "Staff keeps a page.", change: "base" });
  await call("create_node", { id: "if-dash", type: "Interface", title: "Dashboard", description: "Dashboard entry point for staff.", change: "base" });
  await call("link_nodes", {
    edges: [
      { source_id: "i-old", target_id: "j-site", edge_type: "belongs_to" },
      { source_id: "i-old", target_id: "f-db", edge_type: "depends_on" },
      { source_id: "i-keep", target_id: "j-site", edge_type: "belongs_to" },
      { source_id: "i-keep", target_id: "f-db", edge_type: "depends_on" },
      { source_id: "if-dash", target_id: "i-old", edge_type: "exposes" },
    ],
  });
  await complete("f-db", "Foundation", ["src/db/"]);
  await complete("i-old", "Interaction", ["src/old/"]);
  await complete("i-keep", "Interaction", ["src/keep/"]);
  await complete("if-dash", "Interface", ["src/dash/"]);
  const base = await raw("update_node_status", { scope: "change", change: "base", new_status: "ship", skip_review: true });
  check("the base ships", !base.error, base.text.slice(0, 200));

  // Change x: a revision, two draft nodes with a decision, three planned edges, a tag-only decision.
  await call("open_next", { node_id: "i-old", change: "x", reason: "behavior" });
  await call("patch_node_territory", { node_id: "i-old", change: "x", section: "## Purpose", text: "Revised purpose." });
  await call("create_node", { id: "i-n1", type: "Interaction", title: "Draft one", description: "Staff drafts a page.", change: "x" });
  await call("create_node", { id: "f-n2", type: "Foundation", title: "Draft two", description: "Infra — drafts store", role: "infra", change: "x" });
  await call("link_nodes", {
    edges: [
      { source_id: "i-n1", target_id: "j-site", edge_type: "belongs_to" },
      { source_id: "i-n1", target_id: "f-n2", edge_type: "depends_on" },
    ],
  });
  await call("set_implementation_files", { replace: true, node_id: "i-n1", files: ["src/n1/"] });
  await call("record_decision", { node_id: "i-n1", decision: "Drafts are per page.", alternatives: ["Per site"], why: "Pages differ." });
  const planned = await call("link_nodes", {
    change: "x",
    edges: [
      { source_id: "if-dash", target_id: "i-n1", edge_type: "exposes" },
      { source_id: "f-db", target_id: "f-n2", edge_type: "depends_on" },
      { source_id: "i-keep", target_id: "i-n1", edge_type: "leads_to" },
    ],
  });
  check("three planned edges recorded", planned.edges?.every((e) => e.planned), JSON.stringify(planned.edges));
  await call("record_decision", { node_id: "i-keep", change: "x", decision: "Keeping stays manual.", alternatives: ["Automatic"], why: "Staff decide." });
  const liveOld = read("mindplan/interactions/i-old/i-old.mdx");
  await client.close();

  // A fresh session must orient first.
  const s2 = await session();
  const gated = await s2.raw("discard_change", { change: "x" });
  check(
    "an unoriented session is Blocked once, naming orient_for_work({ change })",
    gated.error && gated.text.startsWith("Blocked: Orientation") && gated.text.includes('orient_for_work({ change: "x" })'),
    gated.text.slice(0, 240)
  );
  await s2.call("orient_for_work", { change: "x" });

  // A node of another change that points at a node that goes Blocks it.
  await s2.call("create_node", { id: "i-other", type: "Interaction", title: "Other", description: "Staff does other things.", change: "y" });
  await s2.call("link_nodes", { source_id: "i-other", target_id: "i-n1", edge_type: "leads_to" });
  const pointed = await s2.raw("discard_change", { change: "x" });
  check(
    "a staying node pointing at a removed one Blocks, naming the edge and the unlink call, and nothing is deleted",
    pointed.error && pointed.text.includes('"i-other" leads_to "i-n1" (live)') && pointed.text.includes("unlink_nodes") && exists("mindplan/interactions/i-n1/i-n1.mdx"),
    pointed.text.slice(0, 300)
  );
  await s2.call("unlink_nodes", { source_id: "i-other", target_id: "i-n1" });

  const done = await s2.call("discard_change", { change: "x" });
  check(
    "the reply names the discarded revision, nodes, and planned edges",
    done.discarded?.revisions?.includes("i-old") &&
      done.discarded.nodes?.includes("i-n1") &&
      done.discarded.nodes.includes("f-n2") &&
      done.discarded.planned?.length === 3 &&
      done.discarded.decisions === 1,
    JSON.stringify(done).slice(0, 400)
  );
  check("no revision folder of the change is left", !exists("mindplan/interactions/i-old/revisions/x"));
  check("the never-shipped nodes' folders are gone, decisions included", !exists("mindplan/interactions/i-n1") && !exists("mindplan/foundations/f-n2"));
  const planLeft = ["mindplan/interfaces/if-dash/if-dash.mdx", "mindplan/foundations/f-db/f-db.mdx", "mindplan/interactions/i-keep/i-keep.mdx"].filter((f) =>
    /^planned:/m.test(read(f))
  );
  check("no planned entry of the change is left, the ones pointing at removed nodes included", planLeft.length === 0, planLeft.join(", "));
  check("the revised node's live file is unchanged", read("mindplan/interactions/i-old/i-old.mdx") === liveOld);
  check(
    "a decision beside a staying live file is kept and listed",
    done.kept_decisions?.some((d) => d.node_id === "i-keep") && fs.readdirSync(path.join(root, "mindplan/interactions/i-keep/decisions")).length === 1,
    JSON.stringify(done.kept_decisions)
  );
  check("a claimed file of a removed node is listed as unclaimed", done.unclaimed_files?.includes("src/n1/n1.ts"), JSON.stringify(done.unclaimed_files));
  fs.rmSync(path.join(root, "src/n1"), { recursive: true, force: true });
  const checked = await s2.raw("run_check", {});
  check("run_check passes after the discard (once the unclaimed file is gone)", !checked.error && JSON.parse(checked.text).ok === true, checked.text.slice(0, 300));

  const none = await s2.raw("discard_change", { change: "x" });
  check("a change with no members is Blocked", none.error && none.text.includes("no members"), none.text.slice(0, 160));

  // A node force_unship returned to a pre-ship state keeps its history: it is never removed.
  write("src/z/z.ts", "export const z = 1;\n");
  await s2.call("create_node", { id: "f-z", type: "Foundation", title: "Zed", description: "Infra — zed store", role: "infra", change: "z" });
  for (const heading of SECTIONS.Foundation) {
    await s2.call("patch_node_territory", { node_id: "f-z", section: heading, text: `Real ${heading.slice(3).toLowerCase()}.` });
  }
  await s2.call("patch_node_territory", { node_id: "f-z", toggle_checkboxes: [{ id: "spec", checked: true }, { id: "impl", checked: true }, { id: "verify", checked: true }] });
  await s2.call("set_implementation_files", { replace: true, node_id: "f-z", files: ["src/z/"] });
  await s2.call("update_node_status", { scope: "change", change: "z", new_status: "ship", skip_review: true });
  await s2.call("force_unship", { node_id: "f-z", confirm: "unship:f-z" });
  // Ship cleared its change id; an agent that puts one back makes it a member again.
  await s2.call("patch_node_territory", { node_id: "f-z", change: "z" });
  const unshipped = await s2.raw("discard_change", { change: "z" });
  check(
    "a force-unshipped member Blocks the call with both ways out, and nothing is deleted",
    unshipped.error && unshipped.text.includes("shipped before") && unshipped.text.includes("cancelled") && exists("mindplan/foundations/f-z/f-z.mdx"),
    unshipped.text.slice(0, 300)
  );

  const { tools } = await s2.client.listTools();
  const tool = tools.find((t) => t.name === "discard_change");
  check("tools/list shows discard_change as destructive", tool?.annotations?.destructiveHint === true, JSON.stringify(tool?.annotations));
  await s2.client.close();
}

fs.rmSync(root, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} discard-change check(s) failed.`);
  process.exit(1);
}
console.log("\nAll discard-change checks passed.");
