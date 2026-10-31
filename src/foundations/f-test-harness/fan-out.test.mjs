/**
 * Fan-out signal: a pre-ship node whose depends_on targets sit in several other unshipped changes
 * (counting rules, keep_whole, the fan_out.warn_at threshold), its run_check warning, its
 * stability.fan_out in a full orient_for_work reply, and patch_config({ fan_out }). Run via npm test.
 */
// Fixtures build graphs without a version stamp; the gate has its own suite (version.test.mjs).
process.env.MINDPLAN_VERSION_GATE ??= "off";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// Spawned servers rank by keyword only: no model download or load during tests.
process.env.MINDPLAN_SEARCH ??= "keyword";
process.env.MINDPLAN_ORIENT_GATE ??= "off";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");
const fo = await import(pathToFileURL(path.join(toolRoot, "dist/foundations/f-fan-out/index.js")).href);
const config = await import(pathToFileURL(path.join(toolRoot, "dist/foundations/f-source-index/config.js")).href);
const integrity = await import(pathToFileURL(path.join(toolRoot, "dist/interactions/i-check-integrity/check.js")).href);

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`ok   ${label}`);
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

// --- pure signal on an in-memory graph ---
{
  const node = (id, extra = {}) => ({ id, type: "Foundation", state: "draft", ...extra });
  const shipped = { state: "stable", shipped_at: "2026-10-01T00:00:00.000Z" };
  const targets = [
    node("f-billing", { change: "billing" }),
    node("f-analytics", { change: "site-analytics" }),
    node("f-builder", { change: "ai-builder" }),
    node("f-team", { change: "site-team" }),
    node("f-team-2", { change: "site-team" }),
    node("f-own", { change: "delete-site" }),
    node("f-shipped", { ...shipped, change: "old" }),
    node("f-cancelled", { state: "cancelled", change: "dead" }),
    node("f-unlabeled"),
  ];
  const site = (id, depends_on, extra = {}) => ({ id, type: "Interaction", state: "draft", change: "delete-site", depends_on, ...extra });
  const four = site("i-delete-site", ["f-billing", "f-analytics", "f-builder", "f-team", "f-team-2", "f-own", "f-shipped", "f-cancelled", "f-unlabeled", "f-missing"]);
  const two = site("i-two", ["f-billing", "f-analytics", "f-own"]);
  const three = site("i-three", ["f-billing", "f-analytics", "f-builder"]);
  const kept = site("i-kept", ["f-billing", "f-analytics", "f-builder"], {
    decisions: [{ id: "d-keep", decision: "Keep the edges.", alternatives: ["Invert"], why: "Small app.", keep_whole: true }],
  });
  const done = site("i-done", ["f-billing", "f-analytics", "f-builder"], shipped);
  const graph = { version: 1, nodes: [...targets, four, two, three, kept, done], edges: [] };
  const defaults = config.fanOutSettings({ sources: [], exclude: [] });

  check("warn_at defaults to 3", defaults.warn_at === 3, JSON.stringify(defaults));
  const f4 = fo.fanOut(graph, four);
  check(
    "own-change, shipped, retired, unlabeled, and missing targets do not count; one change counts once",
    f4.count === 4 && f4.changes.join(",") === "billing,site-analytics,ai-builder,site-team",
    JSON.stringify(f4)
  );
  check("3 other changes warn", fo.fanOutFor(graph, three, defaults) !== null);
  check("2 other changes do not warn", fo.fanOutFor(graph, two, defaults) === null && fo.fanOut(graph, two).count === 2);
  check("a shipped node has no fan-out", fo.fanOut(graph, done) === null);
  check("a Journey has no fan-out", fo.fanOut(graph, { id: "j-x", type: "Journey", state: "draft" }) === null);
  check("keep_whole: true silences the warning", fo.fanOutFor(graph, kept, defaults) === null);
  const superseding = {
    ...node("f-other"),
    decisions: [{ id: "d-unkeep", decision: "Invert it.", alternatives: ["Keep"], why: "Grew.", supersedes: "d-keep" }],
  };
  const reopened = { ...graph, nodes: [...graph.nodes, superseding] };
  check("superseding the keep_whole decision brings it back", fo.fanOutFor(reopened, kept, defaults) !== null);
  check("warn_at: 2 makes 2 changes warn", fo.fanOutFor(graph, two, { warn_at: 2 }) !== null);
  const all = fo.fanOuts(graph, defaults).map((f) => f.node_id);
  check("fanOuts lists the highest count first, then by id", all.join(",") === "i-delete-site,i-three", all.join(","));
  check(
    "the warning text names the node, the count, and the changes",
    fo.fanOutWarning(fo.fanOutFor(graph, four, defaults)) ===
      "fan-out: i-delete-site depends on 4 other changes (billing, site-analytics, ai-builder, site-team). " +
        "It may need to know every feature of a kind. Consider inverting: put a contract on a Foundation those " +
        "changes meet (a schema convention, or a record they react to), enforce it with a node rule and a test, " +
        "and drop these depends_on edges."
  );
}

// --- config validation ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-fan-out-config-"));
  fs.mkdirSync(path.join(dir, "mindplan"), { recursive: true });
  const cfg = (body) => fs.writeFileSync(path.join(dir, "mindplan", "config.json"), JSON.stringify({ sources: ["src/**"], exclude: [], ...body }));
  const blocked = (body) => {
    cfg(body);
    try {
      config.loadProjectConfig(dir);
      return false;
    } catch (err) {
      return String(err.message).startsWith("Blocked:");
    }
  };
  cfg({ fan_out: { warn_at: 5 } });
  check("a stored warn_at is kept", config.fanOutSettings(config.loadProjectConfig(dir)).warn_at === 5);
  check("warn_at 0 is Blocked", blocked({ fan_out: { warn_at: 0 } }));
  check("a non-integer warn_at is Blocked", blocked({ fan_out: { warn_at: 2.5 } }));
  check("an unknown fan_out key is Blocked", blocked({ fan_out: { warn: 2 } }));
  cfg({});
  const written = config.writeProjectConfig(config.loadProjectConfig(dir), { force: true, root: dir });
  check("a config without fan_out writes back without it", !("fan_out" in written.config));
}

// --- through the MCP server ---
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-fan-out-"));
console.log("Fan-out sandbox:", root);
fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
fs.writeFileSync(path.join(root, "mindplan", "config.json"), JSON.stringify({ sources: ["src/**"], exclude: [] }, null, 2) + "\n");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, MINDPLAN_ROOT: root },
});
const client = new Client({ name: "fan-out-test", version: "0.1.0" });
await client.connect(transport);

async function call(tool, args) {
  const res = await client.callTool({ name: tool, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(`${tool}: ${text}`);
  return JSON.parse(text || "{}");
}
const fanOutLines = (result) => result.warnings.filter((w) => w.startsWith("fan-out:"));

try {
  for (const [id, change] of [["f-billing", "billing"], ["f-analytics", "site-analytics"], ["f-builder", "ai-builder"]]) {
    await call("create_node", { id, type: "Foundation", title: id, description: `Infra — ${id}`, role: "infra", change });
  }
  await call("create_node", { id: "f-site", type: "Foundation", title: "Site", description: "Infra — sites", role: "infra", change: "delete-site" });
  await call("create_node", { id: "j-sites", type: "Journey", title: "Sites", description: "Owners manage sites." });
  await call("create_node", { id: "i-delete-site", type: "Interaction", title: "Delete a site", description: "Owner deletes a site.", change: "delete-site" });
  for (const target of ["f-site", "f-billing", "f-analytics"]) {
    await call("link_nodes", { source_id: "i-delete-site", target_id: target, edge_type: "depends_on" });
  }

  let result = await call("run_check", {});
  check("2 other changes print no fan-out warning", fanOutLines(result).length === 0, JSON.stringify(fanOutLines(result)));

  await call("link_nodes", { source_id: "i-delete-site", target_id: "f-builder", edge_type: "depends_on" });
  result = await call("run_check", {});
  check(
    "3 other changes print one fan-out warning naming them, and ok stays true",
    result.ok && fanOutLines(result).length === 1 && fanOutLines(result)[0].includes("(billing, site-analytics, ai-builder)"),
    JSON.stringify(result.warnings)
  );
  check("the CLI output prints it as a Warning: line", result.output.includes("\nWarning: fan-out: i-delete-site depends on 3 other changes"));
  // run_check folds the change's warnings into its own; the in-process result keeps them apart.
  const changeCheck = integrity.runIntegrityCheck({ cwd: root, change: "delete-site" });
  check(
    "the change check carries the member's fan-out line",
    changeCheck.change?.warnings.some((w) => w.startsWith("fan-out: i-delete-site")),
    JSON.stringify(changeCheck.change?.warnings)
  );

  const orient = await call("orient_for_work", { node_id: "i-delete-site" });
  check(
    "a full orient reply carries stability.fan_out",
    orient.stability?.fan_out?.count === 3 && orient.stability.fan_out.changes.join(",") === "billing,site-analytics,ai-builder",
    JSON.stringify(orient.stability)
  );
  const siteOrient = await call("orient_for_work", { node_id: "f-site" });
  check("a pre-ship node with no fan-out carries count 0", siteOrient.stability?.fan_out?.count === 0, JSON.stringify(siteOrient.stability));

  await call("patch_config", { fan_out: { warn_at: 4 } });
  result = await call("run_check", {});
  check("fan_out.warn_at: 4 silences 3 changes", fanOutLines(result).length === 0, JSON.stringify(fanOutLines(result)));
  await call("patch_config", { sources: ["src/**"] });
  const stored = JSON.parse(fs.readFileSync(path.join(root, "mindplan", "config.json"), "utf-8"));
  check("a later sources write keeps fan_out", stored.fan_out?.warn_at === 4, JSON.stringify(stored));
  await call("patch_config", { fan_out: { warn_at: 3 } });

  await call("record_decision", {
    node_id: "i-delete-site",
    decision: "Delete-site keeps its edges.",
    alternatives: ["Invert onto f-site"],
    why: "Three features only.",
    keep_whole: true,
  });
  result = await call("run_check", {});
  check("keep_whole: true on the node silences the warning", fanOutLines(result).length === 0, JSON.stringify(fanOutLines(result)));
} finally {
  await client.close();
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll fan-out checks passed.");
