/**
 * Agent guidance (npm test): the required territory shape up front (create_node, orient_for_work,
 * the check's shape: warning, one Blocked listing every gap, the table the skill and SPEC embed), SPEC
 * sections by topic (get_spec), change-wide orientation that clears the write gate in one call,
 * and planned paths reported as info on plan-only nodes instead of stale warnings.
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
// Change-wide orientation is about the gate, so it is on.
delete process.env.MINDPLAN_ORIENT_GATE;

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");
const shape = await import(new URL("../../../dist/foundations/f-compiler-rules/shape.js", import.meta.url).href);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-agent-guidance-"));
fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
fs.writeFileSync(path.join(root, "mindplan", "config.json"), JSON.stringify({ sources: ["src/**"], exclude: [] }) + "\n");
fs.mkdirSync(path.join(root, "src", "pay"), { recursive: true });
fs.writeFileSync(path.join(root, "src", "pay", "pay.ts"), "export const pay = 1;\n");

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
  const client = new Client({ name: "agent-guidance-test", version: "0.1.0" });
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

const statusOf = (report, heading) => report?.sections?.find((s) => s.heading === heading)?.status;
const FOUNDATION_SECTIONS = {
  "## Purpose": "Money ledger every payment writes to.",
  "## Shared Substrate Spec": "- `ledger.append(entry)` stores integer cents.",
  "## Acceptance Criteria": "- An entry round-trips.",
};

// --- the docs embed the table the gate reads ---
{
  const expected = shape.shapeTableMarkdown();
  for (const rel of ["templates/agent/skills/define-entities/SKILL.md", "SPEC.md"]) {
    const text = fs.readFileSync(path.join(toolRoot, rel), "utf-8").replace(/\r\n?/g, "\n");
    const start = text.indexOf(shape.SHAPE_TABLE_START);
    const end = text.indexOf(shape.SHAPE_TABLE_END);
    const embedded = start >= 0 && end > start ? text.slice(start + shape.SHAPE_TABLE_START.length, end).trim() : null;
    check(
      `${rel} embeds the shape table generated from TERRITORY_SHAPE`,
      embedded === expected,
      embedded === null ? "markers missing" : `replace the text between the markers with:\n${expected}`
    );
  }
}

// --- session 1: shape up front, one Blocked with every gap, get_spec ---
{
  const { client, raw, call } = await session();
  const capability = await call("create_node", { id: "j-pay", type: "Capability", title: "Payments", description: "Customers pay." });
  check("a Capability's create_node result has no shape", capability.shape === undefined);
  const ledger = await call("create_node", { id: "f-ledger", type: "Foundation", title: "Ledger", description: "Infra — money ledger", role: "infra" });
  check(
    "create_node returns shape: scaffold sections are stub, the default ops are present",
    statusOf(ledger.shape, "## Purpose") === "stub" &&
      statusOf(ledger.shape, "## Shared Substrate Spec") === "stub" &&
      statusOf(ledger.shape, "## Acceptance Criteria") === "stub" &&
      statusOf(ledger.shape, "## Atomic Ops") === "present" &&
      ledger.shape.gates.join() === "ready,in-review,ship" &&
      ledger.shape.role === undefined,
    JSON.stringify(ledger.shape)
  );

  const before = await call("run_check", {});
  const shapeLine = before.warnings.find((w) => w.startsWith('shape: "f-ledger"'));
  check(
    "run_check warns once for a draft with gaps, naming each stub and the gate",
    shapeLine?.includes('"## Purpose"') && shapeLine.includes('"## Acceptance Criteria"') && shapeLine.includes("(required before ready)") && !before.failures.some((f) => f.includes("Shape")),
    shapeLine
  );

  const three = await raw("update_node_status", { node_id: "f-ledger", new_status: "ready" });
  check(
    "a draft with three gaps is Blocked once, naming all three",
    three.error &&
      three.text.includes("has 3 problems") &&
      ["## Purpose", "## Shared Substrate Spec", "## Acceptance Criteria"].every((h) => three.text.includes(`"${h}"`)),
    three.text
  );

  await call("patch_node_territory", { node_id: "f-ledger", section: "## Purpose", text: FOUNDATION_SECTIONS["## Purpose"] });
  await call("patch_node_territory", { node_id: "f-ledger", section: "## Shared Substrate Spec", text: FOUNDATION_SECTIONS["## Shared Substrate Spec"] });
  const one = await raw("update_node_status", { node_id: "f-ledger", new_status: "ready" });
  check(
    "one gap keeps the single-section message",
    one.error && one.text.includes('section "## Acceptance Criteria" is empty or still contains create_node scaffold placeholder text') && !one.text.includes("problems"),
    one.text
  );

  const oriented = await call("orient_for_work", { node_id: "f-ledger", depth: "rules" });
  check(
    "orient_for_work returns shape with the remaining stub",
    statusOf(oriented.shape, "## Purpose") === "present" && statusOf(oriented.shape, "## Acceptance Criteria") === "stub",
    JSON.stringify(oriented.shape)
  );
  const context = await call("get_node_context", { node_id: "f-ledger", section: "## Purpose" });
  check("get_node_context returns shape too", statusOf(context.shape, "## Acceptance Criteria") === "stub", JSON.stringify(context.shape));
  await call("patch_node_territory", { node_id: "f-ledger", section: "## Acceptance Criteria", text: FOUNDATION_SECTIONS["## Acceptance Criteria"] });
  const after = await call("run_check", {});
  check("a complete draft has no shape: warning", !after.warnings.some((w) => w.startsWith('shape: "f-ledger"')), JSON.stringify(after.warnings));
  const ready = await raw("update_node_status", { node_id: "f-ledger", new_status: "ready" });
  check("following shape reaches ready with no further shape Blocked", !ready.error, ready.text);
  const readyOrient = await call("orient_for_work", { node_id: "f-ledger", depth: "rules" });
  check("a ready node still reports shape (its next gates read it)", readyOrient.shape?.sections?.every((s) => s.status === "present"), JSON.stringify(readyOrient.shape));

  // get_spec: the running package's own SPEC.md by topic.
  const listing = await call("get_spec", {});
  check(
    "get_spec without a topic lists the topic ids and tool names",
    listing.topics?.some((t) => t.id === "territory-shape") && listing.tools?.includes("run_check") && typeof listing.version === "string",
    JSON.stringify(listing).slice(0, 200)
  );
  const territory = await call("get_spec", { topic: "territory-shape" });
  const size = Buffer.byteLength(JSON.stringify(territory), "utf-8");
  check(
    "get_spec territory-shape is under 3 KB and carries the compiler's table",
    size < 3072 && territory.text.replace(/\r\n?/g, "\n").includes(shape.shapeTableMarkdown()),
    `${size} bytes`
  );
  const unknown = await raw("get_spec", { topic: "no-such-topic" });
  check("an unknown topic is Blocked and lists the valid ones", unknown.error && unknown.text.includes("territory-shape") && unknown.text.includes("change-ids"), unknown.text);
  const unresolved = [];
  for (const t of listing.topics) {
    const r = await raw("get_spec", { topic: t.id });
    if (r.error || !JSON.parse(r.text).text?.startsWith("#")) unresolved.push(`${t.id}: ${r.text.slice(0, 120)}`);
  }
  check("every topic resolves against the bundled SPEC.md", unresolved.length === 0, unresolved.join("; "));
  const tool = await call("get_spec", { topic: "run_check" });
  check("a tool name returns that tool's SPEC entry", tool.text.startsWith("#### `run_check`"), tool.text.slice(0, 80));

  // A plan-only change: a draft whose claims are not on disk names paths it has not built yet.
  await call("create_node", { id: "f-cards", type: "Foundation", title: "Cards", description: "Adapter — card processor", role: "adapter", change: "cards" });
  await call("patch_node_territory", {
    node_id: "f-cards",
    section: "## Shared Substrate Spec",
    text: "- `src/pay/cards.ts` charges a card\n- `src/pay/cards-retry.ts` retries a decline",
  });
  await call("set_implementation_files", { node_id: "f-cards", files: ["src/pay/cards.ts"] });
  const plan = await call("run_check", { change: "cards" });
  check(
    "a plan-only change reports one planned: info line per node and no stale: line for its paths",
    plan.info?.some((l) => l.startsWith('planned: "f-cards" names 2 path(s)')) &&
      !plan.warnings.some((w) => w.startsWith('stale: "f-cards" body names')) &&
      plan.output.includes('Info: planned: "f-cards"'),
    JSON.stringify({ info: plan.info, warnings: plan.warnings.filter((w) => w.includes("f-cards")) })
  );
  fs.writeFileSync(path.join(root, "src", "pay", "cards.ts"), "export const charge = 1;\n");
  const built = await call("run_check", { change: "cards" });
  check(
    "once a claimed file exists, the missing paths are stale again",
    built.warnings.some((w) => w.includes('stale: "f-cards" body names `src/pay/cards-retry.ts`')) && !built.info.some((l) => l.includes("f-cards")),
    JSON.stringify(built.warnings.filter((w) => w.includes("f-cards")))
  );
  await call("patch_node_territory", {
    node_id: "f-cards",
    section: "## Shared Substrate Spec",
    text: "- `src/pay/cards.ts` charges a card\n- `src/pay/cards-retry.ts` is generated at build time",
  });
  const buildTime = await call("run_check", { change: "cards" });
  check(
    'a path on an "at build time" line is planned even when claims exist',
    buildTime.info.some((l) => l.includes("cards-retry.ts")) && !buildTime.warnings.some((w) => w.includes("cards-retry.ts")),
    JSON.stringify({ info: buildTime.info })
  );
  await client.close();
}

// --- session 2: a reconnect; change-wide orientation clears the gate for a scoped walk ---
{
  const { client, raw, call } = await session();
  // Give f-cards a full contract, and a third member, so the walk has several nodes to gate.
  await call("orient_for_work", { node_id: "f-cards", depth: "rules" });
  for (const [heading, text] of Object.entries(FOUNDATION_SECTIONS)) {
    await call("patch_node_territory", { node_id: "f-cards", section: heading, text });
  }
  await call("create_node", { id: "f-fees", type: "Foundation", title: "Fees", description: "Infra — card fees", role: "infra", change: "cards" });
  for (const [heading, text] of Object.entries(FOUNDATION_SECTIONS)) {
    await call("patch_node_territory", { node_id: "f-fees", section: heading, text });
  }
  await call("patch_node_rules", { node_id: "f-cards", rules: "- Never log a card number." });
  await client.close();
}
{
  const { client, raw, call } = await session();
  const walk = await raw("update_node_status", { scope: "change", change: "cards", new_status: "ready" });
  check(
    "a scoped walk over unoriented members is Blocked once, naming each and the change-wide orient",
    walk.error && walk.text.includes('"f-cards"') && walk.text.includes('"f-fees"') && walk.text.includes('orient_for_work({ change: "cards" })'),
    walk.text
  );
  const both = await raw("orient_for_work", { change: "cards", node_id: "f-cards" });
  check("change with node_id is Blocked", both.error, both.text);
  const missing = await raw("orient_for_work", { change: "no-such-change" });
  check("a change with no members is Blocked", missing.error && missing.text.includes("has no members"), missing.text);
  const oriented = await call("orient_for_work", { change: "cards" });
  const cards = oriented.members?.find((m) => m.id === "f-cards");
  const source = oriented.rules?.find((r) => r.node_id === "f-cards");
  check(
    "orient_for_work({ change }) lists the members with their rule sources and each source's rules once",
    oriented.members?.length === 2 && cards?.kind === "revision" && cards.rules_from.includes("f-cards") && source?.rules.includes("card number") && oriented.rules.length === 1,
    JSON.stringify(oriented)
  );
  const again = await call("orient_for_work", { change: "cards", known_rules_versions: { "f-cards": source.version } });
  check("a known version leaves the rules text out", again.rules[0].unchanged === true && again.rules[0].rules === undefined, JSON.stringify(again.rules));
  const walked = await raw("update_node_status", { scope: "change", change: "cards", new_status: "ready" });
  check("after one change-wide orient the scoped walk passes the gate", !walked.error, walked.text);
  // A decision under another change tags only the decision: f-fees stays a member of cards alone.
  await call("record_decision", {
    node_id: "f-fees",
    decision: "Fees stay in one module.",
    alternatives: ["Split fees per card brand (no second reason to change)"],
    why: "They change together.",
    change: "fees-triage",
  });
  await client.close();
}
{
  const { client, raw, call } = await session();
  const gated = await raw("patch_node_territory", { node_id: "f-fees", description: "Infra — card fees and refunds" });
  check("a decision holder is not oriented in a new session", gated.error && gated.text.includes("Orientation"), gated.text);
  const oriented = await call("orient_for_work", { change: "fees-triage" });
  check(
    "orient_for_work({ change }) on a decision-only change lists the holder with kind decision",
    oriented.members?.length === 1 && oriented.members[0].id === "f-fees" && oriented.members[0].kind === "decision",
    JSON.stringify(oriented)
  );
  const written = await raw("patch_node_territory", { node_id: "f-fees", description: "Infra — card fees and refunds" });
  check("the change-wide orient records the decision holder as oriented", !written.error, written.text);
  await client.close();
}

fs.rmSync(root, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} agent-guidance check(s) failed.`);
  process.exit(1);
}
console.log("\nAll agent-guidance checks passed.");
