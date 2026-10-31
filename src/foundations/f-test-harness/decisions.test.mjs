/**
 * Decision records: record/list round trips on live and next slots, promote and discard,
 * body writes that keep the section, inheritance labeled by source, supersession, the decision
 * gate (Foundation revision, new migration in git, blast radius, depends_on change), one decision
 * clearing a whole change, blast-radius decisions, map counts, and the gate settings in config.
 * Run via npm test.
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
import { revisionHasDecision } from "../../../dist/foundations/f-compiler-rules/decisions.js";
// Spawned servers rank by keyword only: no model download or load during tests.
process.env.MINDPLAN_SEARCH ??= "keyword";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-decisions-"));
console.log("Decisions sandbox:", root);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, MINDPLAN_ROOT: root },
});
const client = new Client({ name: "decisions-test", version: "0.1.0" });
await client.connect(transport);

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`ok   ${label}`);
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

async function raw(tool, args) {
  const res = await client.callTool({ name: tool, arguments: args });
  return { error: !!res.isError, text: res.content?.[0]?.text ?? "" };
}
async function call(tool, args) {
  const { error, text } = await raw(tool, args);
  if (error) throw new Error(`${tool}: ${text}`);
  return JSON.parse(text || "{}");
}
async function blocked(tool, args) {
  const { error, text } = await raw(tool, args);
  return error && text.startsWith("Blocked:") ? text : null;
}

const territory = (kind, id, slot = "current") =>
  path.join(root, "mindplan", kind, id, slot === "next" ? `${id}.next.mdx` : `${id}.mdx`);
const read = (file) => fs.readFileSync(file, "utf-8");

/** Fill create_node scaffold stubs with real text and tick every checkbox. */
function fillAndTick(kind, id) {
  const file = territory(kind, id);
  let text = read(file);
  text = text.replace(/^_.*?_$/gm, (line) =>
    line.includes("attachments/") ? line : "Decisions-test filled territory."
  );
  text = text.replaceAll("- [ ]", "- [x]");
  fs.writeFileSync(file, text);
}

function write(rel, content) {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// The sandbox repository ignores the developer's git config (signing, hooks, default identity).
const gitConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-gitcfg-")), "config");
fs.writeFileSync(gitConfig, "");
function git(...args) {
  const res = spawnSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false", ...args],
    {
      cwd: root,
      encoding: "utf-8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" },
    }
  );
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout;
}

async function walk(id, steps) {
  for (const new_status of steps) {
    // open_next starts a fresh ledger: a revision ticks its own ops before it ships.
    if (new_status === "ship") await tickAll(id);
    await call("update_node_status", { node_id: id, new_status });
  }
}

/** Ticks every open Atomic Op on the node's active slot (a no-op when there is none). */
async function tickAll(id) {
  const ctx = await call("get_node_context", { node_id: id });
  const body = ctx.next?.body ?? ctx.body ?? "";
  if (!/^\s*[-*+]\s+\[ \]/m.test(body)) return;
  await call("patch_node_territory", { node_id: id, toggle_checkboxes: [{ contains: "- [ ]", checked: true, all: true }] });
}

const decisionWarnings = (result, id) =>
  result.warnings.filter((w) => w.startsWith(`decision: "${id}"`));

// --- the change-id date bound counts from the change's earliest open revision ---
{
  const stamp = (day) => `${day}T00:00:00.000Z`;
  const earlyMember = {
    id: "f-a", type: "Foundation", title: "A", description: "Infra — a", state: "stable",
    created_at: stamp("2025-01-01"), updated_at: stamp("2026-03-01"), shipped_at: stamp("2025-01-01"),
    next: {
      state: "in-progress", title: "A", description: "Infra — a", updated_at: stamp("2026-03-01"),
      opened_at: stamp("2026-03-01"), change: "multi",
      decisions: [{ id: "d-early", decision: "x", alternatives: ["y"], why: "z", change: "multi", date: "2026-03-01" }],
    },
  };
  const lateMember = {
    id: "i-late", type: "Interaction", title: "Late", description: "Late", state: "in-progress",
    created_at: stamp("2026-03-05"), updated_at: stamp("2026-03-05"), change: "multi",
  };
  const oldChange = {
    id: "j-old", type: "Journey", title: "Old", description: "Old", state: "stable",
    created_at: stamp("2025-01-01"), updated_at: stamp("2025-01-01"),
    decisions: [{ id: "d-old", decision: "x", alternatives: ["y"], why: "z", change: "multi", date: "2025-06-01" }],
  };
  check(
    "a member added to a change later gets credit for a decision recorded earlier in that change",
    revisionHasDecision({ version: 1, edges: [], nodes: [earlyMember, lateMember] }, lateMember)
  );
  check(
    "an earlier change's decision under the same id gives no credit",
    !revisionHasDecision({ version: 1, edges: [], nodes: [lateMember, oldChange] }, lateMember)
  );
}

fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
fs.writeFileSync(
  path.join(root, "mindplan", "config.json"),
  JSON.stringify({ sources: ["src/**"], exclude: [] }, null, 2) + "\n"
);

// --- base graph: a Journey, two Foundations, two Interactions, an Interface, a Bug ---
await call("create_node", { id: "j-book", type: "Journey", title: "Booking", description: "Book a table" });
await call("create_node", { id: "f-bookings", type: "Foundation", title: "Bookings", description: "Infra — bookings", role: "infra" });
await call("create_node", { id: "f-db", type: "Foundation", title: "Database", description: "Infra — database", role: "infra" });
await call("create_node", { id: "i-reschedule", type: "Interaction", title: "Reschedule", description: "Reschedule a booking" });
await call("create_node", { id: "i-cancel", type: "Interaction", title: "Cancel", description: "Cancel a booking" });
await call("create_node", { id: "if-web", type: "Interface", title: "Web", description: "Web app" });
for (const id of ["i-reschedule", "i-cancel"]) {
  await call("link_nodes", { source_id: id, target_id: "j-book", edge_type: "belongs_to" });
  await call("link_nodes", { source_id: id, target_id: "f-bookings", edge_type: "depends_on" });
  await call("link_nodes", { source_id: "if-web", target_id: id, edge_type: "exposes" });
}
write("src/f-bookings/index.ts", "export const capacity = 1;\n");
write("src/f-db/index.ts", "export const db = 1;\n");
write("src/i-reschedule/r.ts", 'import { capacity } from "../f-bookings/index.js";\nexport const r = capacity;\n');
write("src/i-cancel/c.ts", 'import { capacity } from "../f-bookings/index.js";\nexport const c = capacity;\n');
write(
  "src/if-web/page.ts",
  'import { r } from "../i-reschedule/r.js";\nimport { c } from "../i-cancel/c.js";\nexport const page = [r, c];\n'
);
for (const [id, dir] of [
  ["f-bookings", "src/f-bookings/"],
  ["f-db", "src/f-db/"],
  ["i-reschedule", "src/i-reschedule/"],
  ["i-cancel", "src/i-cancel/"],
  ["if-web", "src/if-web/"],
]) {
  await call("set_implementation_files", { node_id: id, files: [dir] });
}
fillAndTick("foundations", "f-bookings");
fillAndTick("foundations", "f-db");
fillAndTick("interactions", "i-reschedule");
fillAndTick("interactions", "i-cancel");
fillAndTick("interfaces", "if-web");
const SHIP = ["ready", "in-progress", "in-review", "ship"];
for (const id of ["f-bookings", "f-db", "i-reschedule", "i-cancel", "if-web"]) await walk(id, SHIP);
check(
  "a first build reaches in-review without a decision for its initial depends_on edges",
  (await call("get_node_context", { node_id: "i-reschedule" })).record.state === "stable"
);
// Filed after the ships: an open Bug makes its target unstable.
await call("create_node", { id: "bug-slot", type: "Bug", title: "Slot bug", description: "Wrong slot" });
await call("link_nodes", { source_id: "bug-slot", target_id: "i-reschedule", edge_type: "affects" });

// --- record and list on live files ---
{
  const journey = await call("record_decision", {
    node_id: "j-book",
    id: "d-evening-bookings",
    decision: "Bookings are made per evening, not per table.",
    alternatives: ["Per table (cannot express evening capacity)"],
    why: "Capacity changes per evening.",
  });
  check(
    "record_decision on a Journey writes its live file with a date",
    journey.slot === "current" &&
      journey.decision.status === "active" &&
      /^\d{4}-\d{2}-\d{2}$/.test(journey.decision.date ?? "") &&
      read(territory("journeys", "j-book")).includes("### d-evening-bookings"),
    JSON.stringify(journey)
  );

  const shipped = await call("record_decision", {
    node_id: "f-bookings",
    id: "d-capacity-on-booking",
    decision: "Table capacity is stored on the Booking, not the Table.",
    alternatives: ["Store capacity on Table (overbooks when capacity changes per evening)"],
    why: "Capacity changes per evening.",
    consequences: "Capacity reads join through Booking.",
  });
  check(
    "on a shipped node with no open revision the entry lands in the live file only and writes no next file",
    shipped.slot === "current" &&
      shipped.changed_files.includes("mindplan/foundations/f-bookings/f-bookings.mdx") &&
      !shipped.changed_files.includes("mindplan/foundations/f-bookings/f-bookings.next.mdx") &&
      read(territory("foundations", "f-bookings")).includes("### d-capacity-on-booking") &&
      !fs.existsSync(territory("foundations", "f-bookings", "next")) &&
      (await call("run_check", {})).ok === true,
    JSON.stringify(shipped)
  );

  const generated = await call("record_decision", {
    node_id: "i-cancel",
    decision: "Cancellations are soft deletes.",
    alternatives: ["Hard delete (loses the audit trail)"],
    why: "Refund disputes need the record.",
  });
  check(
    "an omitted id is generated from the decision",
    generated.decision.id === "d-cancellations-soft-deletes",
    generated.decision.id
  );

  const listed = await call("list_decisions", { node_id: "f-bookings" });
  const entry = listed.decisions[0];
  check(
    "list_decisions returns the structured record",
    listed.count === 1 &&
      entry.id === "d-capacity-on-booking" &&
      entry.alternatives[0].startsWith("Store capacity on Table") &&
      entry.why === "Capacity changes per evening." &&
      entry.consequences === "Capacity reads join through Booking." &&
      entry.node_id === "f-bookings",
    JSON.stringify(listed)
  );
  const graphWide = await call("list_decisions", {});
  check("list_decisions with no filter lists the whole graph", graphWide.count === 3, JSON.stringify(graphWide));
}

// --- decisions reach the agent through the rules inheritance ---
{
  const plain = await call("orient_for_work", { node_id: "i-reschedule", depth: "rules" });
  check(
    "by default orient_for_work returns only the node's own decisions and names the inherited ones",
    plain.decisions.entries.every((e) => e.via === "self") &&
      plain.decisions.inherited_decisions.count >= 2 &&
      plain.decisions.inherited_decisions.nodes.includes("j-book") &&
      plain.decisions.inherited_decisions.nodes.includes("f-bookings") &&
      plain.decisions.inherited_decisions.entries === undefined,
    JSON.stringify(plain.decisions)
  );
  const oriented = await call("orient_for_work", { node_id: "i-reschedule", depth: "rules", include_inherited_decisions: true });
  const labels = oriented.decisions.inherited_decisions.entries.map((e) => `${e.node_id}:${e.id}:${e.via}`);
  check(
    "include_inherited_decisions returns the Journey's and the Foundation's decisions, labeled by source, at depth rules",
    labels.includes("j-book:d-evening-bookings:belongs_to") &&
      labels.includes("f-bookings:d-capacity-on-booking:depends_on") &&
      !labels.some((l) => l.startsWith("i-cancel:")),
    JSON.stringify(labels)
  );
  const capRules = oriented.decisions.inherited_decisions.entries.find((e) => e.id === "d-capacity-on-booking");
  const bodyDepth = await call("orient_for_work", { node_id: "i-reschedule", depth: "body", include_inherited_decisions: true });
  const capBody = bodyDepth.decisions.inherited_decisions.entries.find((e) => e.id === "d-capacity-on-booking");
  check(
    "depth rules carries each decision and why; depth body carries the whole record",
    capRules?.why === "Capacity changes per evening." &&
      capRules.alternatives === undefined &&
      capBody?.alternatives?.length === 1 &&
      capBody.consequences === "Capacity reads join through Booking.",
    JSON.stringify(capRules)
  );
  const bug = await call("orient_for_work", { node_id: "bug-slot", include_inherited_decisions: true });
  const bugEntries = [...bug.decisions.entries, ...bug.decisions.inherited_decisions.entries];
  check(
    "a Bug gets the decisions of the node it affects (past distance 1 as one line)",
    bugEntries.some((e) => e.id === "d-capacity-on-booking" && e.node_id === "f-bookings" && e.decision && !e.alternatives),
    JSON.stringify(bug.decisions)
  );
  const ctx = await call("get_node_context", { node_id: "f-bookings" });
  check(
    "get_node_context returns the body without the section and the decisions separately",
    !ctx.body.includes("## Decisions") && ctx.decisions[0]?.id === "d-capacity-on-booking" && ctx.decisions[0]?.status === "active",
    JSON.stringify(ctx.decisions)
  );
}

// --- body writes keep the section; only record_decision writes it ---
{
  await call("patch_node_territory", { node_id: "j-book", section: "## Overview", text: "Evening bookings." });
  check(
    "a section patch keeps the decisions section",
    read(territory("journeys", "j-book")).includes("### d-evening-bookings") &&
      (await call("list_decisions", { node_id: "j-book" })).count === 1
  );
  const bodyBlock = await blocked("patch_node_territory", {
    node_id: "j-book",
    body: "# Booking\n\n## Decisions\n\n### d-x\n\n- Decision: x\n",
  });
  const sectionBlock = await blocked("patch_node_territory", { node_id: "j-book", section: "## Decisions", text: "x" });
  check(
    "a body containing ## Decisions and a section patch of it are Blocked naming record_decision",
    bodyBlock?.includes("record_decision") && sectionBlock?.includes("record_decision"),
    `${bodyBlock} | ${sectionBlock}`
  );
}

// --- the gate on a shipped Foundation's revision; supersession; discard ---
{
  await call("open_next", { node_id: "f-bookings", change: "cap" });
  const warned = await call("run_check", {});
  check(
    "a Foundation revision with no decision warns and the check stays ok",
    warned.ok && decisionWarnings(warned, "f-bookings").some((w) => w.includes("contract changes")),
    JSON.stringify(warned.warnings)
  );
  await walk("f-bookings", ["ready", "in-progress"]);
  const dry = await call("update_node_status", {
    scope: "change",
    change: "cap",
    new_status: "in-review",
    dry_run: true,
  });
  check("the dry run of a change walk reports Blocked: Decision", dry.blocked?.includes("Blocked: Decision"), JSON.stringify(dry));
  const gate = await blocked("update_node_status", { node_id: "f-bookings", new_status: "in-review" });
  check(
    "moving it to in-review is Blocked: Decision with the record_decision call",
    gate?.startsWith("Blocked: Decision.") && gate.includes("record_decision(") && gate.includes('"change":"cap"'),
    gate ?? ""
  );

  const liveBefore = read(territory("foundations", "f-bookings"));
  const replaced = await call("record_decision", {
    node_id: "f-bookings",
    id: "d-evening-capacity-table",
    decision: "Capacity moves to an EveningCapacity table.",
    alternatives: ["Keep it on Booking (duplicated on every booking)"],
    why: "Evening capacity is a fact of the evening, not of a booking.",
    supersedes: "d-capacity-on-booking",
  });
  check(
    "with an open revision the entry lands in the next file only and takes the revision's change",
    replaced.slot === "next" &&
      replaced.decision.change === "cap" &&
      replaced.supersedes?.node_id === "f-bookings" &&
      read(territory("foundations", "f-bookings")) === liveBefore &&
      read(territory("foundations", "f-bookings", "next")).includes("### d-evening-capacity-table"),
    JSON.stringify(replaced)
  );
  const active = await call("list_decisions", { node_id: "f-bookings" });
  const trail = await call("list_decisions", { node_id: "f-bookings", include_superseded: true });
  const old = trail.decisions.find((d) => d.id === "d-capacity-on-booking");
  check(
    "the superseded decision drops out of the default list and stays listable",
    active.decisions.map((d) => d.id).join() === "d-evening-capacity-table" &&
      old?.status === "superseded" &&
      old?.superseded_by === "d-evening-capacity-table",
    JSON.stringify(trail)
  );
  const orientNow = await call("orient_for_work", { node_id: "i-reschedule", depth: "rules", include_inherited_decisions: true });
  const orientAll = await call("orient_for_work", {
    node_id: "i-reschedule",
    depth: "rules",
    include_superseded: true,
    include_inherited_decisions: true,
  });
  check(
    "orient_for_work leaves the superseded decision out unless asked",
    !orientNow.decisions.inherited_decisions.entries.some((e) => e.id === "d-capacity-on-booking") &&
      orientAll.decisions.inherited_decisions.entries.some((e) => e.id === "d-capacity-on-booking" && e.status === "superseded")
  );
  const ctxNow = await call("get_node_context", { node_id: "f-bookings" });
  const ctxAll = await call("get_node_context", { node_id: "f-bookings", include_superseded: true });
  const ctxOld = ctxAll.decisions.find((d) => d.id === "d-capacity-on-booking");
  check(
    "get_node_context leaves the superseded decision out unless asked, like list_decisions",
    !ctxNow.decisions.some((d) => d.id === "d-capacity-on-booking") &&
      ctxNow.next.decisions.map((d) => d.id).join() === "d-evening-capacity-table" &&
      ctxOld?.status === "superseded" &&
      ctxOld?.superseded_by === "d-evening-capacity-table",
    JSON.stringify({ now: ctxNow.decisions, all: ctxAll.decisions })
  );
  const orientCtx = await call("orient_for_work", { node_id: "f-bookings", depth: "body" });
  const orientCtxAll = await call("orient_for_work", { node_id: "f-bookings", depth: "body", include_superseded: true });
  check(
    "orient_for_work carries decisions once, and include_superseded reaches its decisions block",
    !("decisions" in orientCtx.context) &&
      !("decisions" in (orientCtx.context.next ?? {})) &&
      !orientCtx.decisions.entries.some((d) => d.id === "d-capacity-on-booking") &&
      orientCtxAll.decisions.entries.some((d) => d.id === "d-capacity-on-booking" && d.status === "superseded"),
    JSON.stringify({ context: Object.keys(orientCtx.context), all: orientCtxAll.decisions.entries.map((d) => d.id) })
  );
  const twice = await blocked("record_decision", {
    node_id: "f-bookings",
    decision: "Again.",
    alternatives: ["No"],
    why: "Because.",
    supersedes: "d-capacity-on-booking",
  });
  check("superseding an already-superseded decision is Blocked", twice?.includes("already superseded"), twice ?? "");
  const cleared = await call("run_check", {});
  check("recording the decision clears the warning", decisionWarnings(cleared, "f-bookings").length === 0, JSON.stringify(cleared.warnings));

  await call("record_decision", {
    node_id: "f-bookings",
    id: "d-evening-capacity-view",
    decision: "Evening capacity is a view over bookings.",
    alternatives: ["A separate table (two writers for one fact)"],
    why: "One writer.",
    supersedes: "d-evening-capacity-table",
  });
  const nextNow = await call("get_node_context", { node_id: "f-bookings" });
  const nextAll = await call("get_node_context", { node_id: "f-bookings", include_superseded: true });
  const nextOld = nextAll.next.decisions.find((d) => d.id === "d-evening-capacity-table");
  check(
    "get_node_context filters next.decisions the same way",
    nextNow.next.decisions.map((d) => d.id).join() === "d-evening-capacity-view" &&
      nextOld?.status === "superseded" &&
      nextOld?.superseded_by === "d-evening-capacity-view",
    JSON.stringify({ now: nextNow.next.decisions, all: nextAll.next.decisions })
  );

  await call("discard_next", { node_id: "f-bookings" });
  const back = await call("list_decisions", { node_id: "f-bookings" });
  check(
    "discarding the revision drops its decision and the old one is active again",
    back.decisions.map((d) => `${d.id}:${d.status}`).join() === "d-capacity-on-booking:active",
    JSON.stringify(back)
  );
}

// --- a decision recorded on a ready revision ships with it ---
{
  await call("open_next", { node_id: "f-bookings", change: "cap" });
  await walk("f-bookings", ["ready"]);
  const onReady = await call("record_decision", {
    node_id: "f-bookings",
    id: "d-capacity-in-transaction",
    decision: "Capacity checks run inside the booking transaction.",
    alternatives: ["Check before the transaction (two diners can both take the last seat)"],
    why: "Overbooking is the failure this area exists to prevent.",
  });
  check("recording on a ready revision does not reset readiness", onReady.next_state === "ready", JSON.stringify(onReady));
  await walk("f-bookings", ["in-progress"]);
  // open_next starts a fresh ledger, so the revision ticks its own ops before it ships.
  await call("patch_node_territory", { node_id: "f-bookings", toggle_checkboxes: [{ contains: "- [ ]", checked: true, all: true }] });
  await walk("f-bookings", ["in-review", "ship"]);
  const live = read(territory("foundations", "f-bookings"));
  check(
    "promote ships the revision's decision into the live file and the check passes",
    live.includes("### d-capacity-in-transaction") &&
      live.includes("### d-capacity-on-booking") &&
      (await call("run_check", {})).ok === true
  );
  const byChange = await call("list_decisions", { change: "cap" });
  check(
    "list_decisions by change keeps the change id after ship",
    byChange.decisions.map((d) => d.id).join() === "d-capacity-in-transaction",
    JSON.stringify(byChange)
  );
}

// --- one decision under a change clears every member; the depends_on trigger ---
{
  await call("open_next", { node_id: "i-cancel", change: "db" });
  await call("link_nodes", { source_id: "i-cancel", target_id: "f-db", edge_type: "depends_on" });
  await call("open_next", { node_id: "f-db", change: "db" });
  const before = await call("run_check", { change: "db" });
  check(
    "a shipped node's next that adds depends_on warns, and so does the Foundation",
    decisionWarnings(before, "i-cancel").some((w) => w.includes('adds depends_on "f-db"')) &&
      decisionWarnings(before, "f-db").some((w) => w.includes("contract changes")),
    JSON.stringify(before.warnings)
  );
  await call("record_decision", {
    node_id: "f-db",
    decision: "Cancellations write through the database building block.",
    alternatives: ["Cancel through Bookings (couples cancelling to capacity)"],
    why: "A cancellation changes no capacity.",
  });
  const after = await call("run_check", { change: "db" });
  check(
    "one decision under the change clears every member",
    decisionWarnings(after, "i-cancel").length === 0 && decisionWarnings(after, "f-db").length === 0,
    JSON.stringify(after.warnings)
  );
  // open_next starts a fresh ledger, so each revision ticks its own ops before it ships.
  for (const node_id of ["i-cancel", "f-db"]) {
    await call("patch_node_territory", { node_id, toggle_checkboxes: [{ contains: "- [ ]", checked: true, all: true }] });
  }
  const shipped = await call("update_node_status", {
    scope: "change",
    change: "db",
    new_status: "ship",
    skip_review: true,
  });
  check("the change walks to ship through the gate", shipped.lines?.length === 2, JSON.stringify(shipped));
}

// --- a body-only Interaction revision is never gated ---
{
  await call("open_next", { node_id: "i-reschedule" });
  await call("patch_node_territory", { node_id: "i-reschedule", section: "## Purpose", text: "Move a booking to another evening." });
  const result = await call("run_check", {});
  check("a body-only revision prints no decision warning", decisionWarnings(result, "i-reschedule").length === 0);
  await walk("i-reschedule", ["ready", "in-progress", "in-review", "ship"]);
  check("and moves through in-review without a decision", (await call("get_node_context", { node_id: "i-reschedule" })).next === null);
}

// --- a reused change id is not satisfied by an earlier change's decisions ---
{
  await call("record_decision", {
    node_id: "j-book",
    id: "d-legacy-choice",
    change: "legacy",
    decision: "An earlier change chose this.",
    alternatives: ["Something else (worse at the time)"],
    why: "It fit the earlier change.",
  });
  // Back-date it, as if that change shipped years ago.
  const journeyFile = territory("journeys", "j-book");
  fs.writeFileSync(
    journeyFile,
    read(journeyFile).replace(/(### d-legacy-choice[\s\S]*?- Date: )\d{4}-\d{2}-\d{2}/, (_, head) => `${head}2020-01-01`)
  );
  await call("open_next", { node_id: "f-db", change: "legacy" });
  const opened = (await call("get_node_context", { node_id: "f-db" })).next.record.opened_at;
  const reused = await call("run_check", {});
  check(
    "a revision reusing a change id is not cleared by that change's old decision",
    typeof opened === "string" && decisionWarnings(reused, "f-db").length === 1,
    `${opened} ${JSON.stringify(reused.warnings)}`
  );
  await call("record_decision", {
    node_id: "f-db",
    decision: "The database keeps one connection pool.",
    alternatives: ["A pool per area (more connections than the database allows)"],
    why: "The database caps connections.",
  });
  check("a decision recorded in this revision clears it", decisionWarnings(await call("run_check", {}), "f-db").length === 0);
  await call("discard_next", { node_id: "f-db" });
}

// --- an id still named by a supersedes stays reserved ---
{
  await call("open_next", { node_id: "f-bookings", change: "tmp" });
  await call("record_decision", {
    node_id: "f-bookings",
    id: "d-temp",
    decision: "A temporary rule.",
    alternatives: ["No rule"],
    why: "Testing reservation.",
  });
  await call("record_decision", {
    node_id: "i-cancel",
    decision: "Cancelling replaces the temporary rule.",
    alternatives: ["Keep the temporary rule"],
    why: "Testing reservation.",
    supersedes: "d-temp",
  });
  await call("discard_next", { node_id: "f-bookings" });
  const reserved = await blocked("record_decision", {
    node_id: "j-book",
    id: "d-temp",
    decision: "x",
    alternatives: ["y"],
    why: "z",
  });
  check(
    "an id a supersedes still names cannot be reused once its decision is gone",
    reserved?.includes("still names it in supersedes"),
    reserved ?? ""
  );
}

// --- the blast-radius trigger and its setting ---
{
  await call("create_node", { id: "f-wide", type: "Foundation", title: "Wide", description: "Infra — wide", role: "infra" });
  for (let n = 1; n <= 6; n++) {
    await call("create_node", { id: `i-w${n}`, type: "Interaction", title: `W${n}`, description: `Uses wide ${n}` });
    await call("link_nodes", { source_id: `i-w${n}`, target_id: "f-wide", edge_type: "depends_on" });
  }
  const wide = await call("run_check", {});
  check(
    "a revision with more dependents than blast_radius warns",
    decisionWarnings(wide, "f-wide").some((w) => w.includes("has 6 dependents")),
    JSON.stringify(wide.warnings)
  );
  const patched = await call("patch_config", { decisions: { blast_radius: 10 } });
  const stored = JSON.parse(read(path.join(root, "mindplan", "config.json")));
  check(
    "patch_config writes decision settings and keeps sources",
    stored.decisions?.blast_radius === 10 && stored.sources?.[0] === "src/**" && patched.config.decisions.blast_radius === 10,
    JSON.stringify(stored)
  );
  check("a higher setting clears the warning", decisionWarnings(await call("run_check", {}), "f-wide").length === 0);
  const typo = await raw("patch_config", { decisions: { blast_raduis: 3 } });
  check(
    "a mistyped decision setting is rejected instead of ignored",
    typo.error && JSON.parse(read(path.join(root, "mindplan", "config.json"))).decisions?.blast_radius === 10,
    typo.text
  );
  await call("patch_config", { exclude: [] });
  check(
    "a later patch_config keeps the stored decision settings",
    JSON.parse(read(path.join(root, "mindplan", "config.json"))).decisions?.blast_radius === 10
  );
  const configPath = path.join(root, "mindplan", "config.json");
  const good = read(configPath);
  fs.writeFileSync(configPath, JSON.stringify({ sources: ["src/**"], exclude: [], decisions: { blast_radius: -1 } }));
  const bad = await call("run_check", {});
  check(
    "a negative blast_radius is an invalid config",
    !bad.ok && bad.failures.some((f) => f.includes("decisions.blast_radius")),
    JSON.stringify(bad.failures)
  );
  fs.writeFileSync(configPath, good);
}

// --- the schema trigger: first build, then a new migration on a branch ---
{
  await call("create_node", { id: "i-odometer", type: "Interaction", title: "Odometer", description: "Record odometer readings" });
  await call("link_nodes", { source_id: "i-odometer", target_id: "j-book", edge_type: "belongs_to" });
  await call("link_nodes", { source_id: "i-odometer", target_id: "f-bookings", edge_type: "depends_on" });
  write("src/i-odometer/log.ts", "export const log = 1;\n");
  write("src/i-odometer/migrations/001_init.sql", "create table readings (odometer integer);\n");
  await call("set_implementation_files", { node_id: "i-odometer", files: ["src/i-odometer/"] });
  fillAndTick("interactions", "i-odometer");
  await walk("i-odometer", ["ready", "in-progress"]);
  const first = await blocked("update_node_status", { node_id: "i-odometer", new_status: "in-review" });
  check(
    "a first build that claims a migration is decision-worthy",
    first?.includes('claims new migration or schema file(s) "src/i-odometer/migrations/001_init.sql"'),
    first ?? ""
  );
  await call("record_decision", {
    node_id: "i-odometer",
    decision: "Readings live in their own table.",
    alternatives: ["[ ] a column on vehicles (loses history)"],
    why: "Service intervals need every reading.",
  });
  await walk("i-odometer", ["in-review", "ship"]);
  check(
    "an alternative that reads like a checkbox is not counted by the completion check",
    (await call("get_node_context", { node_id: "i-odometer" })).record.state === "stable"
  );

  await call("create_node", { id: "i-forms", type: "Interaction", title: "Forms", description: "Edit settings" });
  write("src/i-forms/settings.schema.json", "{}\n");
  write("src/i-forms/schema.ts", "export const settings = {};\n");
  await call("set_implementation_files", { node_id: "i-forms", files: ["src/i-forms/"] });
  check(
    "JSON Schema and zod modules are not schema files by default",
    decisionWarnings(await call("run_check", {}), "i-forms").length === 0
  );

  // A brownfield node: a draft Foundation modeling a migration the repository already has.
  await call("create_node", { id: "f-store", type: "Foundation", title: "Store", description: "Infra — store", role: "infra" });
  write("src/f-store/migrations/001_store.sql", "create table store (id integer);\n");
  await call("set_implementation_files", { node_id: "f-store", files: ["src/f-store/"] });
  check(
    "outside git, a first build's claimed migration counts as new",
    decisionWarnings(await call("run_check", {}), "f-store").length === 1
  );

  git("-c", "init.defaultBranch=main", "init");
  git("add", "-A");
  git("commit", "-m", "base");
  git("checkout", "-b", "feat");
  check(
    "in git, a first build that adopts an existing migration is not decision-worthy",
    decisionWarnings(await call("run_check", {}), "f-store").length === 0
  );
  await call("open_next", { node_id: "i-odometer" });
  write("src/i-odometer/migrations/001_init.sql", "create table readings (odometer numeric(10,1));\n");
  git("commit", "-am", "edit an existing migration");
  check(
    "editing an existing migration on the branch is not decision-worthy",
    decisionWarnings(await call("run_check", {}), "i-odometer").length === 0
  );
  write("src/i-odometer/migrations/002_numérique.sql", "alter table readings alter column odometer type numeric(10,1);\n");
  const untracked = await call("run_check", {});
  check(
    "a new migration inside an already-claimed folder warns",
    decisionWarnings(untracked, "i-odometer").some((w) => w.includes("002_numérique.sql") && !w.includes("001_init.sql")),
    JSON.stringify(untracked.warnings)
  );
  git("add", "-A");
  git("commit", "-m", "add migration");
  await walk("i-odometer", ["ready", "in-progress"]);
  const gate = await blocked("update_node_status", { node_id: "i-odometer", new_status: "in-review" });
  check("a migration committed on the branch still Blocks in-review", gate?.includes("002_numérique.sql"), gate ?? "");
  await call("record_decision", {
    node_id: "i-odometer",
    decision: "Odometer is numeric(10,1).",
    alternatives: ["Keep integer (rounding broke service intervals)"],
    why: "Telematics devices report tenths.",
  });
  await walk("i-odometer", ["in-review"]);
  check("after recording, the move to in-review passes", (await call("get_node_context", { node_id: "i-odometer" })).next.record.state === "in-review");
}

// --- blast-radius decisions and map counts ---
{
  const own = await call("get_blast_radius", { node_id: "f-bookings" });
  check(
    "by default get_blast_radius lists the focus's own decisions and names the dependents that hold others",
    own.decisions.every((d) => d.via === "focus") &&
      own.decisions.some((d) => d.id === "d-capacity-in-transaction") &&
      own.dependent_decisions.count >= 1 &&
      own.dependent_decisions.nodes.length >= 1,
    JSON.stringify({ decisions: own.decisions, dependent_decisions: own.dependent_decisions })
  );
  const radius = await call("get_blast_radius", { node_id: "f-bookings", include_dependent_decisions: true });
  check(
    "include_dependent_decisions lists the focus's and its dependents' active decisions",
    radius.decisions.some((d) => d.id === "d-capacity-in-transaction" && d.via === "focus" && d.distance === 0) &&
      radius.decisions.some((d) => d.id === "d-cancellations-soft-deletes" && d.via === "dependent" && d.distance === 1),
    JSON.stringify(radius.decisions)
  );
  const mermaid = await call("export_mindplan_view", { decisions: true });
  const dot = await call("export_mindplan_view", { decisions: true, format: "dot" });
  const plain = await call("export_mindplan_view", {});
  check(
    "export_mindplan_view labels active decision counts on request only",
    mermaid.diagram.includes("f-bookings · Bookings · stable · 2 decisions") &&
      dot.diagram.includes("2 decisions") &&
      !plain.diagram.includes("decision") &&
      !read(path.join(root, "mindplan", "map.md")).includes("decision"),
    mermaid.diagram
  );
}

// --- Blocked cases ---
{
  const onBug = await blocked("record_decision", { node_id: "bug-slot", decision: "x", alternatives: ["y"], why: "z" });
  check("a Bug cannot hold a decision", onBug?.includes("is a Bug") && onBug.includes("i-reschedule"), onBug ?? "");
  const noAlternative = await raw("record_decision", { node_id: "j-book", decision: "x", alternatives: [], why: "z" });
  check("an empty alternatives list is rejected", noAlternative.error, noAlternative.text);
  const taken = await blocked("record_decision", {
    node_id: "j-book",
    id: "d-evening-bookings",
    decision: "x",
    alternatives: ["y"],
    why: "z",
  });
  check("a taken id is Blocked", taken?.includes("already used"), taken ?? "");
  const outOfReach = await blocked("record_decision", {
    node_id: "i-reschedule",
    decision: "Reschedules hard-delete the old slot.",
    alternatives: ["Keep it"],
    why: "z",
    supersedes: "d-cancellations-soft-deletes",
  });
  check("superseding a sibling's decision is Blocked", outOfReach?.includes("does not inherit"), outOfReach ?? "");
  const unknown = await blocked("record_decision", {
    node_id: "i-reschedule",
    decision: "x",
    alternatives: ["y"],
    why: "z",
    supersedes: "d-nope",
  });
  check("superseding an unknown decision is Blocked", unknown?.includes("not a recorded decision"), unknown ?? "");
}

// --- a decision naming a removed path is history, not stale text ---
{
  await call("record_decision", {
    node_id: "f-db",
    decision: "The old adapter is gone.",
    alternatives: ["Keep `src/legacy/adapter.ts` (nobody calls it)"],
    why: "Dead code.",
  });
  const result = await call("run_check", {});
  check("a decision's missing path does not warn as stale", !result.warnings.some((w) => w.includes("legacy/adapter.ts")), JSON.stringify(result.warnings));
}

// --- a retired node's replacement still stands; retired nodes' decisions leave the blast radius ---
{
  await call("record_decision", {
    node_id: "i-reschedule",
    id: "d-reschedule-any-evening",
    decision: "A booking may move to any evening with capacity.",
    alternatives: ["Only to the same weekday (too narrow for diners)"],
    why: "Capacity, not the weekday, is the constraint.",
    supersedes: "d-evening-bookings",
  });
  await call("update_node_status", { node_id: "i-reschedule", new_status: "deprecated" });
  const trail = await call("list_decisions", { node_id: "j-book", include_superseded: true });
  const evening = trail.decisions.find((d) => d.id === "d-evening-bookings");
  check(
    "deprecating the superseding node keeps the old decision superseded",
    evening?.status === "superseded" && evening.superseded_by === "d-reschedule-any-evening",
    JSON.stringify(evening)
  );
  const radius = await call("get_blast_radius", { node_id: "f-bookings", include_retired: true, include_dependent_decisions: true });
  check(
    "get_blast_radius leaves out a retired node's decisions, even with include_retired",
    radius.affected.some((a) => a.id === "i-reschedule") && !radius.decisions.some((d) => d.node_id === "i-reschedule"),
    JSON.stringify(radius.decisions)
  );
}

// --- a node shaped like skyloom's i-contact-platform: one own decision, twelve inherited ---
{
  const decide = (node_id, n) =>
    call("record_decision", { node_id, id: `d-${node_id}-${n}`, decision: `${node_id} choice ${n}.`, alternatives: ["Other"], why: "Because." });
  await call("create_node", { id: "j-host", type: "Journey", title: "Hosting", description: "Serve many sites" });
  await call("create_node", { id: "f-mail", type: "Foundation", title: "Mail", description: "Adapter — mail", role: "adapter" });
  await call("create_node", { id: "f-build", type: "Foundation", title: "Build", description: "Assembler — build", role: "assembler" });
  await call("create_node", { id: "f-blob", type: "Foundation", title: "Blob store", description: "Adapter — blob store", role: "adapter" });
  await call("create_node", { id: "i-contact", type: "Interaction", title: "Contact the platform", description: "Visitor sends the platform a message" });
  await call("link_nodes", { source_id: "i-contact", target_id: "j-host", edge_type: "belongs_to" });
  await call("link_nodes", { source_id: "i-contact", target_id: "f-mail", edge_type: "depends_on" });
  await call("link_nodes", { source_id: "i-contact", target_id: "f-build", edge_type: "depends_on" });
  await call("link_nodes", { source_id: "f-mail", target_id: "f-blob", edge_type: "depends_on" });
  await decide("i-contact", 1);
  for (let n = 1; n <= 3; n++) await decide("j-host", n);
  for (let n = 1; n <= 3; n++) await decide("f-mail", n);
  for (let n = 1; n <= 3; n++) await decide("f-build", n);
  for (let n = 1; n <= 3; n++) await decide("f-blob", n);

  const full = await call("orient_for_work", { node_id: "i-contact" });
  check(
    "default orient carries one decision, the node's own, plus inherited_decisions.count",
    full.decisions.entries.length === 1 &&
      full.decisions.entries[0].id === "d-i-contact-1" &&
      full.decisions.inherited_decisions.count === 12 &&
      full.decisions.inherited_decisions.nodes.join(",") === "j-host,f-build,f-mail,f-blob",
    JSON.stringify(full.decisions)
  );
  check(
    "the embedded blast radius carries the focus's own decisions only",
    full.blast_radius.decisions.length === 1 && full.blast_radius.dependent_decisions.count === 0,
    JSON.stringify(full.blast_radius.decisions)
  );
  const deep = await call("orient_for_work", { node_id: "i-contact", depth: "rules", include_inherited_decisions: true });
  const far = deep.decisions.inherited_decisions.entries.filter((e) => e.node_id === "f-blob");
  const near = deep.decisions.inherited_decisions.entries.filter((e) => e.node_id === "f-mail");
  check(
    "inherited decisions: whole (or compact at depth rules) at distance 1, one line beyond",
    deep.decisions.inherited_decisions.entries.length === 12 &&
      near.every((e) => e.why === "Because." && e.via === "depends_on") &&
      far.every((e) => Object.keys(e).sort().join(",") === "decision,distance,id,node_id" && e.distance === 2),
    JSON.stringify(far)
  );
  const ctx = await call("get_node_context", { node_id: "i-contact" });
  check(
    "get_node_context names the inherited decisions without their entries",
    ctx.decisions.length === 1 && ctx.inherited_decisions.count === 12 && ctx.inherited_decisions.entries === undefined
  );
  const ctxAll = await call("get_node_context", { node_id: "i-contact", include_inherited_decisions: true });
  check("get_node_context include_inherited_decisions lists them", ctxAll.inherited_decisions.entries.length === 12);
  // A Bug holds no decisions: get_node_context lists the affected node's under inherited_decisions.
  await call("create_node", { id: "bug-mail", type: "Bug", title: "Mail lost", description: "Mail is dropped" });
  await call("link_nodes", { source_id: "bug-mail", target_id: "f-mail", edge_type: "affects" });
  const bugCtx = await call("get_node_context", { node_id: "bug-mail", include_inherited_decisions: true });
  const bugNear = bugCtx.inherited_decisions.entries.filter((e) => e.node_id === "f-mail");
  check(
    "get_node_context on a Bug lists the affected node's decisions, whole at distance 1",
    bugCtx.decisions.length === 0 &&
      bugCtx.inherited_decisions.nodes[0] === "f-mail" &&
      bugNear.length === 3 &&
      bugNear.every((e) => e.alternatives?.length === 1),
    JSON.stringify(bugCtx.inherited_decisions)
  );
  const bugOrient = await call("orient_for_work", { node_id: "bug-mail", depth: "rules" });
  check(
    "orient_for_work on a Bug carries the affected node's decisions as its own",
    bugOrient.decisions.entries.length === 3 && bugOrient.decisions.entries.every((e) => e.node_id === "f-mail")
  );
  // A superseded decision past distance 1 says so in its one-line form.
  await call("record_decision", {
    node_id: "f-blob",
    id: "d-f-blob-new",
    decision: "Replaces choice 1.",
    alternatives: ["Keep it"],
    why: "Better.",
    supersedes: "d-f-blob-1",
  });
  const trail = await call("orient_for_work", {
    node_id: "i-contact",
    depth: "rules",
    include_superseded: true,
    include_inherited_decisions: true,
  });
  const old = trail.decisions.inherited_decisions.entries.find((e) => e.id === "d-f-blob-1");
  check(
    "a superseded one-line entry names its status and superseded_by",
    old?.distance === 2 && old.status === "superseded" && old.superseded_by === "d-f-blob-new",
    JSON.stringify(old)
  );
  const storeRadius = await call("get_blast_radius", { node_id: "f-blob" });
  check(
    "a Foundation's radius names the dependents that hold decisions",
    storeRadius.decisions.length === 3 &&
      storeRadius.dependent_decisions.count === 4 &&
      storeRadius.dependent_decisions.nodes.join(",") === "f-mail,i-contact",
    JSON.stringify(storeRadius.dependent_decisions)
  );
}

await client.close();
fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(path.dirname(gitConfig), { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} decisions check(s) failed.`);
  process.exit(1);
}
console.log("\nAll decisions checks passed.");
