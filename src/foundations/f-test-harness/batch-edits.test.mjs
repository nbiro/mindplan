/**
 * Fewer calls for big plans (npm test): link_nodes takes a batch of edges (checked as one, all or
 * none, one rules block), a planned link orients its source itself, change on a never-shipped node
 * of another change is Blocked, patch_node_territory takes a list of replacements (all or none),
 * and the CLI answers --version.
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
process.env.MINDPLAN_SEARCH ??= "keyword";
// The batch and planned-link replies carry rules only while the gate is on.
delete process.env.MINDPLAN_ORIENT_GATE;

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-batch-"));
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
write("mindplan/config.json", JSON.stringify({ sources: ["src/**"], exclude: [] }) + "\n");
write("src/db/db.ts", "export const db = 1;\n");
write("src/old/old.ts", "export const old = 1;\n");
write("src/dash/page.ts", "export const page = 1;\n");

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`ok   ${label}`);
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

/** A fresh server is a fresh session. */
async function session() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env, MINDPLAN_ROOT: root },
    stderr: "pipe",
  });
  const client = new Client({ name: "batch-edits-test", version: "0.1.0" });
  await client.connect(transport);
  await client.callTool({ name: "get_project", arguments: {} });
  const raw = async (tool, args) => {
    const res = await client.callTool({ name: tool, arguments: args });
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

// --- session 1: a shipped base, then batches ---
{
  const { client, raw, call } = await session();
  await call("create_node", { id: "j-site", type: "Capability", title: "Site", description: "Visitors use the site." });
  await call("create_node", { id: "f-db", type: "Foundation", title: "Database", description: "Adapter — database access", role: "adapter", change: "base" });
  await call("create_node", { id: "i-old", type: "Interaction", title: "Read a page", description: "Visitor reads a page.", change: "base" });
  await call("create_node", { id: "if-dash", type: "Interface", title: "Dashboard", description: "Dashboard entry point for staff.", change: "base" });
  await call("patch_node_rules", { node_id: "f-db", rules: "- Every query is parameterized." });

  const base = await call("link_nodes", {
    edges: [
      { source_id: "i-old", target_id: "j-site", edge_type: "belongs_to" },
      { source_id: "i-old", target_id: "f-db", edge_type: "depends_on" },
      { source_id: "if-dash", target_id: "i-old", edge_type: "exposes" },
    ],
  });
  check(
    "a batch writes every edge and returns one rules block naming each rule source once",
    base.edges?.length === 3 &&
      base.rules?.entries?.filter((e) => e.node_id === "f-db").length === 1 &&
      base.rules.entries.find((e) => e.node_id === "f-db").rules?.includes("parameterized"),
    JSON.stringify(base).slice(0, 400)
  );
  check(
    "the batch's changed_files name each written file once",
    new Set(base.changed_files).size === base.changed_files.length && base.changed_files.some((f) => f.endsWith("i-old.mdx")),
    JSON.stringify(base.changed_files)
  );

  const both = await raw("link_nodes", { source_id: "i-old", target_id: "f-db", edge_type: "depends_on", edges: [{ source_id: "i-old", target_id: "f-db", edge_type: "depends_on" }] });
  check("edges together with source_id is Blocked", both.error && both.text.includes("not both"), both.text.slice(0, 160));

  await call("create_node", { id: "f-a", type: "Foundation", title: "A", description: "Infra — a", role: "infra" });
  await call("create_node", { id: "f-b", type: "Foundation", title: "B", description: "Infra — b", role: "infra" });
  const before = fs.readFileSync(path.join(root, "mindplan/foundations/f-a/f-a.mdx"), "utf-8");
  const cycle = await raw("link_nodes", {
    edges: [
      { source_id: "f-a", target_id: "f-b", edge_type: "depends_on" },
      { source_id: "f-b", target_id: "f-a", edge_type: "depends_on" },
    ],
  });
  check(
    "two edges that close a cycle only together are Blocked, naming edge 2",
    cycle.error && cycle.text.includes("edge 2 of 2") && cycle.text.includes("cycle"),
    cycle.text.slice(0, 240)
  );
  check("a Blocked batch writes nothing", fs.readFileSync(path.join(root, "mindplan/foundations/f-a/f-a.mdx"), "utf-8") === before);
  const illegal = await raw("link_nodes", {
    edges: [
      { source_id: "f-a", target_id: "f-b", edge_type: "depends_on" },
      { source_id: "f-a", target_id: "j-site", edge_type: "belongs_to" },
      { source_id: "f-a", target_id: "f-b", edge_type: "depends_on" },
    ],
  });
  check(
    "each failing edge is named by its position from 1, a duplicate inside the batch included",
    illegal.error && illegal.text.includes("edge 2 of 3") && illegal.text.includes("edge 3 of 3") && !illegal.text.includes("edge 1 of 3"),
    illegal.text.slice(0, 300)
  );

  // Ship the base so planned edges have a shipped source.
  for (const [id, type] of [["f-db", "Foundation"], ["i-old", "Interaction"], ["if-dash", "Interface"]]) {
    for (const heading of SECTIONS[type]) {
      await call("patch_node_territory", { node_id: id, section: heading, text: `Real ${heading.slice(3).toLowerCase()} for ${id}.` });
    }
    await call("patch_node_territory", { node_id: id, toggle_checkboxes: [{ id: "spec", checked: true }, { id: "impl", checked: true }, { id: "verify", checked: true }] });
  }
  await call("set_implementation_files", { replace: true, node_id: "f-db", files: ["src/db/"] });
  await call("set_implementation_files", { replace: true, node_id: "i-old", files: ["src/old/"] });
  await call("set_implementation_files", { replace: true, node_id: "if-dash", files: ["src/dash/"] });
  const shipped = await raw("update_node_status", { scope: "change", change: "base", new_status: "ship", skip_review: true });
  check("the base ships", !shipped.error, shipped.text.slice(0, 200));

  // change on a never-shipped node of another change.
  await call("create_node", { id: "i-new", type: "Interaction", title: "Edit a page", description: "Staff edits a page.", change: "a" });
  const wrongPlan = await raw("link_nodes", { source_id: "i-new", target_id: "j-site", edge_type: "belongs_to", change: "b" });
  check(
    "change on a draft node of another change is Blocked naming both ways out",
    wrongPlan.error && wrongPlan.text.includes('change "a"') && wrongPlan.text.includes("Drop change") && wrongPlan.text.includes("once"),
    wrongPlan.text.slice(0, 240)
  );
  const ownPlan = await raw("link_nodes", { source_id: "i-new", target_id: "j-site", edge_type: "belongs_to", change: "a" });
  check("change equal to the node's own writes the live edge", !ownPlan.error, ownPlan.text.slice(0, 160));
  await call("create_node", { id: "bug-x", type: "Bug", title: "X broke", description: "Pages fail to load." });
  const bug = await raw("link_nodes", { source_id: "bug-x", target_id: "f-db", edge_type: "affects", change: "b" });
  check("a Bug's affects is linked whatever change is passed", !bug.error, bug.text.slice(0, 160));
  await client.close();
}

// --- session 2: a planned link orients its shipped source; a live link does not ---
{
  const { client, raw } = await session();
  const plannedOne = await raw("link_nodes", { source_id: "if-dash", target_id: "i-new", edge_type: "exposes", change: "a" });
  const reply = plannedOne.error ? {} : JSON.parse(plannedOne.text);
  check(
    "a planned link on an unoriented shipped source succeeds and orients it",
    !plannedOne.error && reply.planned && reply.oriented === true && reply.rules?.oriented_on?.includes("if-dash"),
    plannedOne.text.slice(0, 240)
  );
  const liveLink = await raw("link_nodes", { source_id: "i-old", target_id: "i-new", edge_type: "leads_to" });
  check("a live link on an unoriented node is still Blocked: Orientation", liveLink.error && liveLink.text.startsWith("Blocked: Orientation"), liveLink.text.slice(0, 160));
  await client.close();
}

// --- session 3: replace lists ---
{
  const { client, raw, call } = await session();
  const file = path.join(root, "mindplan/interactions/i-new/i-new.mdx");
  await call("patch_node_territory", { node_id: "i-new", section: "## Purpose", text: "Alpha one.\n\nBeta two.\n\nGamma three." });
  const before = fs.readFileSync(file, "utf-8");
  const failed = await raw("patch_node_territory", {
    node_id: "i-new",
    replace: [
      { find: "Alpha one.", with: "Alpha 1." },
      { find: "Delta four.", with: "Delta 4." },
      { find: "Gamma three.", with: "Gamma 3." },
    ],
  });
  check(
    "a replace list whose entry 2 is not found is Blocked naming entry 2, and the file is unchanged",
    failed.error && failed.text.includes("replace entry 2 of 3") && !failed.text.includes("entry 1 of 3") && fs.readFileSync(file, "utf-8") === before,
    failed.text.slice(0, 200)
  );
  const done = await call("patch_node_territory", {
    node_id: "i-new",
    replace: [
      { find: "Alpha one.", with: "Alpha 1." },
      { find: "Alpha 1.", with: "Alpha first." },
      { find: "Gamma three.", with: "Gamma 3." },
    ],
  });
  const text = fs.readFileSync(file, "utf-8");
  check(
    "a replace list applies in order (a later entry sees the earlier one's text) in one call",
    done.patched_fields?.includes("replace") && text.includes("Alpha first.") && text.includes("Gamma 3.") && !text.includes("Alpha 1."),
    JSON.stringify(done).slice(0, 200)
  );
  const rules = await raw("patch_node_territory", { node_id: "i-new", replace: [{ find: "Beta two.", with: "## Rules\n- no" }] });
  check("an entry adding an owned heading is Blocked naming it", rules.error && rules.text.includes("replace entry 1 of 1"), rules.text.slice(0, 200));
  const textFix = await raw("patch_node_territory", {
    node_id: "i-old",
    reason: "text",
    replace: [
      { find: "Real purpose for i-old.", with: "Real purpose for reading a page." },
      { find: "Real acceptance criteria for i-old.", with: "Real acceptance criteria for reading a page." },
    ],
  });
  check("a replace list with reason text on a shipped node writes live in place", !textFix.error && JSON.parse(textFix.text).in_place === true, textFix.text.slice(0, 200));
  await client.close();
}

// --- the CLI answers --version ---
{
  const pkg = JSON.parse(fs.readFileSync(path.join(toolRoot, "package.json"), "utf-8"));
  for (const flag of ["--version", "-v", "version"]) {
    const res = spawnSync(process.execPath, [serverEntry, flag], { encoding: "utf-8" });
    check(`mindplan-mcp ${flag} prints the package version`, res.status === 0 && res.stdout.trim() === pkg.version, `${res.status} ${res.stdout} ${res.stderr}`);
  }
}

fs.rmSync(root, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} batch-edits check(s) failed.`);
  process.exit(1);
}
console.log("\nAll batch-edits checks passed.");
