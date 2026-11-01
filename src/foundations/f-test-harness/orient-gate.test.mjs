/**
 * Summary-first orientation and the write gate (npm test). A query-only orient_for_work returns
 * ranked rows (under 2 KB for 10) and the full node only for a clear winner (auto_focus);
 * orient_for_work({ node_id }) returns the full node. In a fresh server session every write tool
 * that acts on a node is Blocked: Orientation until that node was oriented on, and again after the
 * rules that reach it changed; create_node is never blocked and counts as oriented.
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
// Spawned servers rank by keyword only: no model download or load during tests.
process.env.MINDPLAN_SEARCH ??= "keyword";
// This suite is about the gate, so it is on whatever the caller's environment says.
delete process.env.MINDPLAN_ORIENT_GATE;

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-orient-gate-"));
fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
fs.writeFileSync(path.join(root, "mindplan", "config.json"), JSON.stringify({ sources: ["src/**"], exclude: [] }) + "\n");
fs.mkdirSync(path.join(root, "src", "pay"), { recursive: true });
fs.writeFileSync(path.join(root, "src", "pay", "pay.ts"), "export const pay = 1;\n");
fs.writeFileSync(path.join(root, "src", "pay", "pay.test.mjs"), "\n");

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`ok   ${label}`);
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

/** A fresh server is a fresh session: nothing oriented yet. */
async function session() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env, MINDPLAN_ROOT: root },
    stderr: "pipe",
  });
  const client = new Client({ name: "orient-gate-test", version: "0.1.0" });
  await client.connect(transport);
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

// --- session 1: build the plan; every write here acts on nodes this session created ---
{
  const { client, call } = await session();
  const created = await call("create_node", { id: "j-pay", type: "Capability", title: "Payments", description: "Customers pay." });
  check("create_node is never blocked and returns the rules that reach the new node", created.rules?.node_id === "j-pay");
  await call("create_node", { id: "f-ledger", type: "Foundation", title: "Ledger", description: "Infra — money ledger", role: "infra" });
  await call("create_node", { id: "f-cards", type: "Foundation", title: "Cards", description: "Adapter — card processor", role: "adapter" });
  await call("create_node", { id: "i-pay", type: "Interaction", title: "Pay an invoice", description: "Customer pays an invoice by card." });
  await call("patch_node_rules", { node_id: "j-pay", rules: "- Amounts are integer cents." });
  const linked = await call("link_nodes", { source_id: "i-pay", target_id: "j-pay", edge_type: "belongs_to" });
  check(
    "a link that brings new rules returns them",
    linked.rules?.entries?.some((e) => e.node_id === "j-pay" && e.rules.includes("cents")),
    JSON.stringify(linked.rules)
  );
  await call("link_nodes", { source_id: "i-pay", target_id: "f-ledger", edge_type: "depends_on" });
  for (let i = 0; i < 12; i++) {
    await call("create_node", {
      id: `i-refund-${i}`,
      type: "Interaction",
      title: `Refund kind ${i}`,
      description: `Customer asks for a refund of kind ${i}; the ledger reverses the payment and the card processor returns the money to the original card within five working days.`,
    });
  }
  await client.close();
}

// --- session 2: summary-first replies ---
{
  const { client, raw, call } = await session();
  const rowsText = (await raw("orient_for_work", { query: "refund", limit: 10 })).text;
  const rows = JSON.parse(rowsText);
  check(
    `a query-only orient returns rows only (${Buffer.byteLength(rowsText)} bytes for ${rows.matches.length} rows)`,
    rows.focus === null &&
      rows.matches.length === 10 &&
      !("context" in rows) &&
      !("rules" in rows) &&
      !("decisions" in rows) &&
      !("blast_radius" in rows) &&
      Buffer.byteLength(rowsText) < 2048 &&
      rows.matches.every((m) => ["id", "type", "state", "title", "description", "score"].every((k) => k in m)),
    rowsText.slice(0, 300)
  );
  const exact = await call("orient_for_work", { query: "i-pay" });
  check(
    "an exact id query auto-focuses and returns the full node",
    exact.auto_focus === true && exact.focus === "i-pay" && exact.context?.record?.id === "i-pay" && exact.rules && exact.blast_radius,
    JSON.stringify({ focus: exact.focus, auto: exact.auto_focus })
  );
  const full = await call("orient_for_work", { node_id: "f-ledger" });
  check(
    "orient_for_work({ node_id }) returns record, body, rules, own decisions, owned files, and blast radius",
    full.focus === "f-ledger" &&
      full.context?.body &&
      full.rules?.node_id === "f-ledger" &&
      full.decisions?.node_id === "f-ledger" &&
      Array.isArray(full.files?.files) &&
      full.blast_radius?.node_id === "f-ledger" &&
      !("auto_focus" in full)
  );
  await client.close();
}

// --- session 3: every gated write is Blocked until the node is oriented on ---
{
  const { client, raw, call } = await session();
  const writes = [
    ["set_implementation_files", { node_id: "f-cards", files: ["src/pay/"] }],
    ["set_test_files", { node_id: "f-cards", files: ["src/pay/pay.test.mjs"] }],
    ["patch_node_territory", { node_id: "f-cards", section: "## Purpose", text: "Card processor adapter." }],
    ["patch_node_territory", { node_id: "f-cards", toggle_checkboxes: [{ contains: "Spec written", checked: true }] }],
    ["patch_node_rules", { node_id: "f-cards", rules: "- Never log card numbers." }],
    ["record_decision", { node_id: "f-cards", decision: "Tokens only.", alternatives: ["Raw numbers"], why: "PCI scope." }],
    ["link_nodes", { source_id: "f-cards", target_id: "f-ledger", edge_type: "depends_on" }],
  ];
  // A status move gates on the node it moves (a legal one here: cancel a draft).
  const statusBlocked = await raw("update_node_status", { node_id: "i-refund-0", new_status: "cancelled" });
  check(
    "update_node_status on an unoriented node is Blocked: Orientation with the fixing call",
    statusBlocked.error && statusBlocked.text.includes('orient_for_work({ node_id: "i-refund-0" })'),
    statusBlocked.text.slice(0, 160)
  );
  const openBlocked = await raw("open_next", { node_id: "f-ledger" });
  check("open_next on an unoriented node is Blocked: Orientation", openBlocked.error && openBlocked.text.startsWith("Blocked: Orientation:"), openBlocked.text.slice(0, 120));
  for (const [tool, args] of writes) {
    const r = await raw(tool, args);
    check(
      `${tool} on an unoriented node is Blocked: Orientation with the fixing call`,
      r.error && r.text.startsWith("Blocked: Orientation:") && r.text.includes('orient_for_work({ node_id: "f-cards" })'),
      r.text.slice(0, 160)
    );
  }
  const unlink = await raw("unlink_nodes", { source_id: "i-pay", target_id: "f-ledger" });
  check("unlink_nodes gates on its source", unlink.error && unlink.text.includes('node_id: "i-pay"'), unlink.text.slice(0, 120));
  const unknown = await raw("patch_node_rules", { node_id: "f-nope", rules: "- x" });
  check("an unknown node still reports that it does not exist", unknown.error && unknown.text.includes("does not exist"), unknown.text);
  const dry = await raw("update_node_status", { node_id: "f-cards", new_status: "ready", dry_run: true });
  check("a dry run writes nothing and is not gated", !dry.error, dry.text.slice(0, 120));

  await call("orient_for_work", { node_id: "f-cards", depth: "rules" });
  for (const [tool, args] of writes) {
    const r = await raw(tool, args);
    check(`${tool} succeeds after orient_for_work({ node_id })`, !r.error, r.text.slice(0, 160));
  }
  await call("orient_for_work", { node_id: "i-refund-0", depth: "rules" });
  check("update_node_status succeeds after orienting", !(await raw("update_node_status", { node_id: "i-refund-0", new_status: "cancelled" })).error);
  await call("orient_for_work", { node_id: "f-ledger", depth: "rules" });
  const openAfter = await raw("open_next", { node_id: "f-ledger" });
  check(
    "after orienting, open_next reaches its own lifecycle check",
    openAfter.error && !openAfter.text.startsWith("Blocked: Orientation"),
    openAfter.text.slice(0, 120)
  );
  await call("get_node_context", { node_id: "i-pay" });
  check("get_node_context counts as orienting", !(await raw("unlink_nodes", { source_id: "i-pay", target_id: "f-ledger" })).error);

  await client.close();
}

// --- session 4: a rules change invalidates the orientation of every node it reaches ---
{
  const { client, raw, call } = await session();
  await call("orient_for_work", { node_id: "i-pay", depth: "rules" });
  check("an oriented node can be written", !(await raw("patch_node_territory", { node_id: "i-pay", description: "Customer pays an invoice." })).error);
  await call("orient_for_work", { node_id: "j-pay", depth: "rules" });
  await call("patch_node_rules", { node_id: "j-pay", rules: "- Amounts are integer cents.\n- Payments are append-only." });
  const after = await raw("patch_node_territory", { node_id: "i-pay", description: "Customer pays an invoice by card." });
  check(
    "after an inherited rule changes, the dependent must orient again",
    after.error && after.text.includes("changed since you oriented"),
    after.text.slice(0, 160)
  );
  const reoriented = await call("orient_for_work", { node_id: "i-pay", depth: "rules" });
  check("the new orientation carries the changed rule", reoriented.rules.entries.some((e) => e.rules?.includes("append-only")));
  check("then the write goes through", !(await raw("patch_node_territory", { node_id: "i-pay", description: "Customer pays an invoice by card." })).error);
  check("the author of a rules change stays oriented", !(await raw("patch_node_territory", { node_id: "j-pay", description: "Customers pay invoices." })).error);
  await client.close();
}

// --- session 5: review regressions over MCP ---
{
  const { client, raw, call } = await session();
  const ctx = await call("get_node_context", { node_id: "i-pay" });
  check(
    "get_node_context, which counts as orienting, carries the rules that reach the node",
    ctx.resolved_rules?.entries?.some((e) => e.node_id === "j-pay" && e.rules.includes("append-only")),
    JSON.stringify(ctx.resolved_rules)
  );
  const one = await call("orient_for_work", { query: "refund", limit: 1 });
  check("limit 1 alone never makes a clear winner", one.focus === null && one.matches.length === 1, JSON.stringify({ focus: one.focus }));
  const attach = await raw("put_attachment", { node_id: "i-refund-1", filename: "a.txt", content_base64: "aGk=" });
  check("put_attachment is gated", attach.error && attach.text.startsWith("Blocked: Orientation:"), attach.text.slice(0, 100));
  await client.close();
}

// --- proposed next-slot edges bring their rules (ledger, pure) ---
{
  const ledger = await import(new URL("../../../dist/foundations/f-orientation-ledger/ledger.js", import.meta.url).href);
  const t = "2026-01-01T00:00:00.000Z";
  const mk = (id, type, extra = {}) => ({ id, type, title: id, description: id, state: "stable", created_at: t, updated_at: t, ...extra });
  const graph = {
    version: 1,
    edges: [],
    nodes: [
      mk("f-old", "Foundation", { rules: "- Old rule." }),
      mk("f-new", "Foundation", { rules: "- New rule." }),
      mk("i-x", "Interaction", {
        shipped_at: t,
        depends_on: ["f-old"],
        next: { state: "draft", title: "i-x", description: "i-x", updated_at: t, depends_on: ["f-old", "f-new"] },
      }),
    ],
  };
  const reaching = ledger.reachingRules(graph, "i-x").map((e) => e.node_id);
  check("a revision's proposed depends_on brings its target's rules", reaching.includes("f-new") && reaching.includes("f-old"), JSON.stringify(reaching));
  const live = { ...graph, nodes: graph.nodes.map((n) => (n.id === "i-x" ? { ...n, next: undefined } : n)) };
  check(
    "so a link into the next slot changes the node's rules fingerprint",
    ledger.rulesFingerprint(graph, "i-x") !== ledger.rulesFingerprint(live, "i-x")
  );
}

// --- the CLI has no session and is never gated ---
{
  const res = spawnSync(process.execPath, [serverEntry, "check"], {
    cwd: root,
    env: { ...process.env, MINDPLAN_ROOT: root },
    encoding: "utf-8",
  });
  check("the CLI check runs without any orientation", !res.stdout.includes("Orientation") && !res.stderr.includes("Orientation"), res.stdout.slice(0, 200));
}

fs.rmSync(root, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} orient-gate check(s) failed.`);
  process.exit(1);
}
console.log("\nAll orient-gate checks passed.");
