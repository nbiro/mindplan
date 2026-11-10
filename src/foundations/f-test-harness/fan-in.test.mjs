/**
 * Fan-in signal: a pre-ship Foundation with more direct dependents than decisions.blast_radius gets
 * a fan-in: warning grouped by Capability; only keep_whole on the node or a split clears it (an
 * unrelated decision does not); assembler and design-system roles are exempt by default
 * (fan_in.exempt_roles); a full orient reply carries the grouping; and the decision gate no longer
 * counts a pre-ship Foundation's blast radius. Run via npm test.
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
const config = await import(pathToFileURL(path.join(toolRoot, "dist/foundations/f-source-index/config.js")).href);

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`ok   ${label}`);
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

// --- config validation ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-fan-in-config-"));
  fs.mkdirSync(path.join(dir, "mindplan"), { recursive: true });
  const cfg = (body) =>
    fs.writeFileSync(path.join(dir, "mindplan", "config.json"), JSON.stringify({ sources: ["src/**"], exclude: [], ...body }));
  const blocked = (body) => {
    cfg(body);
    try {
      config.loadProjectConfig(dir);
      return false;
    } catch (err) {
      return String(err.message).startsWith("Blocked:");
    }
  };
  check(
    "exempt_roles defaults to assembler and design-system",
    config.fanInSettings({ sources: [], exclude: [] }).exempt_roles.join(",") === "assembler,design-system"
  );
  cfg({ fan_in: { exempt_roles: [] } });
  check("a stored empty exempt_roles is kept", config.fanInSettings(config.loadProjectConfig(dir)).exempt_roles.length === 0);
  check("an unknown role is Blocked", blocked({ fan_in: { exempt_roles: ["database"] } }));
  check("an unknown fan_in key is Blocked", blocked({ fan_in: { roles: [] } }));
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- through the MCP server ---
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-fan-in-"));
fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
fs.writeFileSync(path.join(root, "mindplan", "config.json"), JSON.stringify({ sources: ["src/**"], exclude: [], replies: { budget_bytes: 0 } }, null, 2) + "\n");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, MINDPLAN_ROOT: root },
});
const client = new Client({ name: "fan-in-test", version: "0.1.0" });
await client.connect(transport);
await client.callTool({ name: "get_project", arguments: {} });

async function call(tool, args) {
  const res = await client.callTool({ name: tool, arguments: tool === "run_check" ? { compact: false, ...args } : args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(`${tool}: ${text}`);
  return JSON.parse(text || "{}");
}
const warningsFor = async (prefix) => (await call("run_check", {})).warnings.filter((w) => w.startsWith(prefix));
const fanInLines = (id) => warningsFor(`fan-in: "${id}"`);

try {
  const foundation = (id, role) => call("create_node", { id, type: "Foundation", title: id, description: `${role} — ${id}`, role });
  await foundation("f-db", "infra");
  await foundation("f-next", "assembler");
  await foundation("f-ui", "design-system");
  await foundation("f-stack", "infra");
  // 18 Interactions across 6 Capabilities: Accounts 4, Link-in-bio 4, Handles 3, Verification 3, Badge 2, Payment 2.
  const areas = [["Accounts", 4], ["Link-in-bio", 4], ["Handles", 3], ["Verification", 3], ["Badge", 2], ["Payment", 2]];
  let n = 0;
  for (const [title, count] of areas) {
    const cap = `j-${title.toLowerCase()}`;
    await call("create_node", { id: cap, type: "Capability", title, description: `${title}.` });
    for (let i = 0; i < count; i++) {
      const id = `i-${title.toLowerCase()}-${i}`;
      n++;
      await call("create_node", { id, type: "Interaction", title: id, description: `Someone does ${id}.` });
      await call("link_nodes", { source_id: id, target_id: cap, edge_type: "belongs_to" });
      for (const f of ["f-db", "f-next", "f-ui"]) await call("link_nodes", { source_id: id, target_id: f, edge_type: "depends_on" });
    }
  }
  check("the fixture has 18 dependents", n === 18);

  const expected =
    'fan-in: "f-db" (infra) has 18 dependents across 6 Capabilities ' +
    "(Accounts 4, Link-in-bio 4, Handles 3, Verification 3, Badge 2, Payment 2), " +
    "more than the blast_radius setting of 5. Every new feature in these areas will depend on it. " +
    "Split it into one Foundation per area that depends on a smaller core, " +
    'or record_decision({ node_id: "f-db", keep_whole: true, why }) if it should stay whole.';
  const lines = await fanInLines("f-db");
  check(
    "a draft infra Foundation with 18 dependents gets one fan-in warning with per-Capability counts",
    lines.length === 1 && lines[0] === expected,
    JSON.stringify(lines)
  );
  const gate = await warningsFor('decision: "f-db"');
  check("the decision gate no longer warns on a pre-ship Foundation's blast radius", gate.length === 0, JSON.stringify(gate));
  check("a draft assembler with 18 dependents gets no fan-in warning", (await fanInLines("f-next")).length === 0);
  check("a draft design system with 18 dependents gets no fan-in warning", (await fanInLines("f-ui")).length === 0);

  const orient = await call("orient_for_work", { node_id: "f-db", depth: "full" });
  const s = orient.stability ?? {};
  check(
    "a full orient on a pre-ship Foundation carries fan_in, fan_in_groups, and fan_in_warning",
    s.fan_in === 18 &&
      s.fan_in_groups?.length === 6 &&
      s.fan_in_groups[0].label === "Accounts" &&
      s.fan_in_groups[0].capability === "j-accounts" &&
      s.fan_in_groups[0].count === 4 &&
      s.fan_in_warning === expected,
    JSON.stringify(s)
  );

  await call("record_decision", {
    node_id: "f-stack",
    nodes: ["f-db"],
    decision: "Next.js + Supabase + Vercel.",
    alternatives: ["Rails + Postgres on Fly"],
    why: "The team knows the stack.",
  });
  check("an unrelated decision that lists the node in nodes leaves the warning", (await fanInLines("f-db")).length === 1);
  await call("record_decision", { node_id: "f-db", decision: "Postgres through Supabase.", alternatives: ["SQLite"], why: "Hosted." });
  check("a decision on the node without keep_whole leaves the warning", (await fanInLines("f-db")).length === 1);

  await call("patch_config", { fan_in: { exempt_roles: [] } });
  check("exempt_roles: [] makes the assembler warn", (await fanInLines("f-next")).length === 1);
  await call("patch_config", { sources: ["src/**"] });
  const stored = JSON.parse(fs.readFileSync(path.join(root, "mindplan", "config.json"), "utf-8"));
  check(
    "a later sources write keeps fan_in",
    Array.isArray(stored.fan_in?.exempt_roles) && stored.fan_in.exempt_roles.length === 0,
    JSON.stringify(stored)
  );
  await call("patch_config", { fan_in: { exempt_roles: ["assembler", "design-system"] } });
  check("restoring the exemption silences the assembler again", (await fanInLines("f-next")).length === 0);

  await call("record_decision", {
    node_id: "f-db",
    decision: "One data layer for every area.",
    alternatives: ["One data Foundation per area"],
    why: "A one-week MVP with one table per area.",
    keep_whole: true,
  });
  check("a keep_whole decision on the node clears it", (await fanInLines("f-db")).length === 0);

  // A split: f-store's dependents move onto a per-area Foundation, no decision needed.
  await foundation("f-store", "infra");
  const moved = ["i-accounts-0", "i-accounts-1", "i-accounts-2", "i-accounts-3", "i-handles-0", "i-handles-1"];
  for (const id of moved) await call("link_nodes", { source_id: id, target_id: "f-store", edge_type: "depends_on" });
  check("6 dependents over the default 5 warn", (await fanInLines("f-store")).length === 1);
  await foundation("f-store-accounts", "infra");
  await call("link_nodes", { source_id: "f-store-accounts", target_id: "f-store", edge_type: "depends_on" });
  for (const id of moved.slice(0, 4)) {
    await call("unlink_nodes", { source_id: id, target_id: "f-store", edge_type: "depends_on" });
    await call("link_nodes", { source_id: id, target_id: "f-store-accounts", edge_type: "depends_on" });
  }
  check("moving dependents onto a per-area Foundation clears it with no decision", (await fanInLines("f-store")).length === 0);
  check("the per-area Foundation stays under the threshold", (await fanInLines("f-store-accounts")).length === 0);
} finally {
  await client.close();
  fs.rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll fan-in checks passed.");
