/**
 * Lean node replies: a shipped node keeps no Atomic Ops (ship drops them, open_next starts a fresh
 * unticked list, force_unship gives the live file one again, init drops the ledgers an older
 * release left), and the node reads return one copy of the decisions, one slot, or one section.
 * Every write here is also diffed against the sandbox: each mindplan/ file it touched must be in
 * its changed_files. Run via npm test.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// Spawned servers rank by keyword only: no model download or load during tests.
process.env.MINDPLAN_SEARCH ??= "keyword";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");
const store = await import(pathToFileURL(path.join(toolRoot, "dist/foundations/f-territory-store/store.js")).href);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-lean-replies-"));
console.log("Lean-replies sandbox:", root);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, MINDPLAN_ROOT: root },
});
const client = new Client({ name: "lean-replies-test", version: "0.1.0" });
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

let diffMisses = 0;

/** Call a tool and check that its changed_files covers every file it touched on disk. */
async function call(tool, args) {
  const before = snapshot();
  const res = await client.callTool({ name: tool, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(`${tool}: ${text}`);
  const result = JSON.parse(text || "{}");
  if (Array.isArray(result.changed_files)) {
    const missing = touched(before, snapshot()).filter((rel) => !result.changed_files.includes(rel));
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

/** The Blocked text of a call expected to fail (null when it succeeded), with nothing written. */
async function blocked(tool, args) {
  const before = snapshot();
  const res = await client.callTool({ name: tool, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (!res.isError) return null;
  const wrote = touched(before, snapshot());
  if (wrote.length > 0) check(`Blocked ${tool} wrote nothing`, false, JSON.stringify(wrote));
  return text;
}

const liveOf = (id) => `mindplan/foundations/${id}/${id}.mdx`;
const nextOf = (id) => `mindplan/foundations/${id}/${id}.next.mdx`;
const readRel = (rel) => fs.readFileSync(path.join(root, ...rel.split("/")), "utf-8");
const count = (text, re) => (text.match(re) ?? []).length;
const UNTICKED = /^\s*[-*+]\s+\[ \]/gm;
const TICKED = /^\s*[-*+]\s+\[[xX]\]/gm;

/** True when the twin is the live file with only `state:` changed to mirror. */
function twinInSync(id) {
  const strip = (raw) => raw.replace(/^state:.*$/m, "state: <ignored>");
  const twin = readRel(nextOf(id));
  return /^state: mirror$/m.test(twin) && strip(readRel(liveOf(id))) === strip(twin);
}

function write(rel, content) {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** A Foundation that claims its own source file, its scaffold filled and every box ticked, at draft. */
async function foundation(id) {
  await call("create_node", { id, type: "Foundation", title: id, description: `Infra — ${id}`, role: "infra" });
  write(`src/${id}/index.ts`, `export const ${id.replace(/-/g, "_")} = 1;\n`);
  await call("set_implementation_files", { node_id: id, files: [`src/${id}/`] });
  const file = path.join(root, ...liveOf(id).split("/"));
  let text = fs.readFileSync(file, "utf-8");
  text = text.replace(/^_.*?_$/gm, (line) => (line.includes("attachments/") ? line : "Lean-replies filled territory."));
  fs.writeFileSync(file, text.replaceAll("- [ ]", "- [x]"));
}

async function walk(id, steps) {
  for (const new_status of steps) await call("update_node_status", { node_id: id, new_status });
}

const tickAll = (id) =>
  call("patch_node_territory", { node_id: id, toggle_checkboxes: [{ contains: "- [ ]", checked: true, all: true }] });

fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
fs.writeFileSync(
  path.join(root, "mindplan", "config.json"),
  JSON.stringify({ sources: ["src/**"], exclude: [] }, null, 2) + "\n"
);

// --- the body helpers ---
{
  const body = [
    "# F",
    "",
    "## Purpose",
    "",
    "Text.",
    "",
    "```md",
    "## Atomic Ops",
    "```",
    "",
    "## Atomic Ops",
    "",
    "- [x] Done",
    "",
    "## Checklist",
    "",
    "- [x] Also done",
    "",
    "## Rules",
    "",
    "- A rule.",
    "",
    "## Attachments",
    "",
    "_None._",
    "",
  ].join("\r\n");
  const stripped = store.withoutAtomicOps(body, "Foundation");
  check(
    "withoutAtomicOps drops the Atomic Ops and a Foundation's Checklist, keeps fenced lines, Rules, and CRLF",
    !/^## Atomic Ops\r$/m.test(stripped.replace(/```md\r\n## Atomic Ops\r\n```/, "")) &&
      stripped.includes("```md\r\n## Atomic Ops\r\n```") &&
      !stripped.includes("## Checklist") &&
      stripped.includes("## Rules\r\n\r\n- A rule.") &&
      !/[^\r]\n/.test(stripped),
    JSON.stringify(stripped)
  );
  const fresh = store.withFreshAtomicOps(stripped, "Foundation");
  check(
    "withFreshAtomicOps adds one unticked default list before Rules",
    count(fresh, UNTICKED) === 3 &&
      count(fresh, TICKED) === 0 &&
      fresh.indexOf("\r\n## Atomic Ops\r\n") < fresh.indexOf("## Rules") &&
      fresh.indexOf("\r\n## Atomic Ops\r\n") > fresh.indexOf("```md"),
    JSON.stringify(fresh)
  );
  const replaced = store.withFreshAtomicOps(body, "Foundation");
  check(
    "withFreshAtomicOps replaces a ticked ledger and leaves one section",
    count(replaced, UNTICKED) === 3 && count(replaced, TICKED) === 0 && !replaced.includes("## Checklist"),
    JSON.stringify(replaced)
  );
  const bug = "## Summary\n\nBroken.\n\n## Fix Checklist\n\n- [x] Fixed\n";
  check(
    "a Bug's Fix Checklist is never touched",
    store.withoutAtomicOps(bug, "Bug") === bug && store.withFreshAtomicOps(bug, "Bug") === bug
  );
  check("readSectionFromBody returns one section", store.readSectionFromBody(body, "## Rules") === "- A rule.");
  let missing = "";
  try {
    store.readSectionFromBody(body, "Nope");
  } catch (err) {
    missing = String(err.message);
  }
  check(
    "readSectionFromBody Blocks a missing heading and lists the sections",
    missing.startsWith("Blocked:") && missing.includes('"## Purpose"'),
    missing
  );
}

// --- first ship drops the ledger from live and twin ---
await foundation("f-core");
await call("patch_node_rules", { node_id: "f-core", rules: "- Keep it small." });
await walk("f-core", ["ready", "in-progress", "in-review", "ship"]);
{
  const live = readRel(liveOf("f-core"));
  check(
    "first ship leaves no Atomic Ops on live and keeps Rules and Attachments",
    !live.includes("## Atomic Ops") && count(live, TICKED) === 0 && live.includes("- Keep it small.") && live.includes("## Attachments"),
    live
  );
  check("the twin matches the stripped live file", twinInSync("f-core"));
}

// --- open_next starts a fresh ledger; the revision cannot ship on old ticks ---
await call("open_next", { node_id: "f-core", change: "lean" });
{
  const next = readRel(nextOf("f-core"));
  check(
    "open_next gives the revision one unticked default list before Rules",
    count(next, /^## Atomic Ops$/gm) === 1 &&
      count(next, UNTICKED) === 3 &&
      count(next, TICKED) === 0 &&
      next.indexOf("## Atomic Ops") < next.indexOf("## Rules"),
    next
  );
  await call("record_decision", {
    node_id: "f-core",
    decision: "Core stays one module.",
    alternatives: ["Split it (no second caller yet)"],
    why: "One caller.",
  });
  await walk("f-core", ["ready", "in-progress", "in-review"]);
  const gate = await blocked("update_node_status", { node_id: "f-core", new_status: "ship" });
  check("shipping the revision without ticking its own ops is Blocked", gate?.includes("Completion Check"), gate ?? "accepted");
}

// --- the reads: decisions once, one slot, one section ---
{
  const def = await call("orient_for_work", { node_id: "f-core", depth: "body" });
  check(
    "orient_for_work returns the open revision's body only, and its decisions once",
    !("body" in def.context) &&
      typeof def.context.next?.body === "string" &&
      def.context.next.body.includes("## Atomic Ops") &&
      !("decisions" in def.context) &&
      !("decisions" in def.context.next) &&
      def.decisions.entries.some((d) => d.decision === "Core stays one module."),
    JSON.stringify({ context: Object.keys(def.context), next: Object.keys(def.context.next ?? {}) })
  );
  const cur = await call("orient_for_work", { node_id: "f-core", depth: "body", slot: "current" });
  check(
    "slot current returns the live body and the next record only",
    typeof cur.context.body === "string" && !cur.context.body.includes("## Atomic Ops") && Object.keys(cur.context.next).join() === "record",
    JSON.stringify(cur.context.next)
  );
  const sec = await call("orient_for_work", { node_id: "f-core", depth: "body", section: "Atomic Ops" });
  check(
    "section returns one section of the returned body and names it",
    sec.context.section === "## Atomic Ops" && sec.context.next.body.startsWith("- [ ]") && !sec.context.next.body.includes("## Purpose"),
    JSON.stringify(sec.context)
  );
  const noSec = await blocked("orient_for_work", { node_id: "f-core", depth: "body", section: "## Nope" });
  check("a missing section is Blocked, names the slot, and lists the sections", noSec?.includes("Blocked: next slot:") && noSec.includes('"## Purpose"'), noSec ?? "accepted");
  const badSlot = await blocked("orient_for_work", { node_id: "f-core", slot: "both" });
  check("a slot outside current / next is rejected by the schema", badSlot !== null, "accepted");
  const rulesOnly = await call("orient_for_work", { node_id: "f-core", depth: "rules", section: "## Nope" });
  check("depth rules ignores section", !("body" in rulesOnly.context), JSON.stringify(rulesOnly.context));

  const both = await call("get_node_context", { node_id: "f-core" });
  check(
    "get_node_context returns both slots and their decisions by default",
    typeof both.body === "string" && typeof both.next?.body === "string" && Array.isArray(both.decisions) && Array.isArray(both.next.decisions)
  );
  const onlyNext = await call("get_node_context", { node_id: "f-core", slot: "next", section: "## Purpose" });
  check(
    "get_node_context with slot next and a section returns that section of the next body only",
    !("body" in onlyNext) && !("decisions" in onlyNext) && onlyNext.next.body === "Lean-replies filled territory.",
    JSON.stringify(onlyNext.next)
  );
}

// --- ship the revision: promote drops its ledger too ---
await tickAll("f-core");
await walk("f-core", ["ship"]);
{
  const live = readRel(liveOf("f-core"));
  check(
    "promote leaves no Atomic Ops on live and keeps Decisions and Rules",
    !live.includes("## Atomic Ops") && live.includes("Core stays one module.") && live.includes("- Keep it small."),
    live
  );
  check("the restored twin matches live", twinInSync("f-core"));
  const noNext = await blocked("get_node_context", { node_id: "f-core", slot: "next" });
  check("slot next without an open revision is Blocked", noNext?.includes("Blocked:") && noNext.includes("no open revision"), noNext ?? "accepted");
}

// --- a Foundation's Checklist heading is dropped at ship too ---
await foundation("f-chk");
{
  const file = path.join(root, ...liveOf("f-chk").split("/"));
  fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replace("## Atomic Ops", "## Checklist"));
  await walk("f-chk", ["ready", "in-progress", "in-review", "ship"]);
  const live = readRel(liveOf("f-chk"));
  check("first ship drops a Foundation's Checklist section", !live.includes("## Checklist") && count(live, TICKED) === 0, live);
}

// --- force_unship gives the live file a ledger again ---
{
  const wrong = await blocked("force_unship", { node_id: "f-chk", confirm: "unship:f-core", new_status: "ready" });
  check("a Blocked force_unship leaves the live file as it was", wrong?.includes("Blocked:"), wrong ?? "accepted");
  const res = await call("force_unship", { node_id: "f-chk", confirm: "unship:f-chk", new_status: "ready" });
  const live = readRel(liveOf("f-chk"));
  check(
    "force_unship to ready leaves unticked default ops on live",
    res.new_state === "ready" && count(live, /^## Atomic Ops$/gm) === 1 && count(live, UNTICKED) === 3,
    JSON.stringify(res)
  );
  // Ticking is a contract write, so the ready node goes back to draft first.
  await tickAll("f-chk");
  await walk("f-chk", ["ready", "in-progress", "in-review", "ship"]);
  check("the unshipped node ships again", !readRel(liveOf("f-chk")).includes("## Atomic Ops") && twinInSync("f-chk"));
}

const final = await call("run_check", {});
check("the sandbox passes the check before init", final.ok, JSON.stringify(final.failures));
check("every write listed every mindplan/ file it touched", diffMisses === 0, `${diffMisses} write(s) missed files`);
await client.close();

// --- init drops the ledgers an older release left on shipped nodes ---
{
  const runCli = (args) =>
    spawnSync(process.execPath, [serverEntry, ...args], {
      cwd: root,
      env: { ...process.env, MINDPLAN_ROOT: root },
      encoding: "utf-8",
    });
  /** Puts a ticked ledger back on a file by hand, as a release before 0.7.0 left it. */
  const addLedger = (rel, item) => {
    const abs = path.join(root, ...rel.split("/"));
    fs.writeFileSync(abs, fs.readFileSync(abs, "utf-8").replace("## Attachments", `## Atomic Ops

- [x] ${item}

## Attachments`));
  };
  addLedger(liveOf("f-core"), "Old work");
  addLedger(nextOf("f-core"), "Old work");
  const first = runCli(["init", "--host", "claude"]);
  check("init succeeds", first.status === 0, first.stderr);
  check("init reports the dropped ledger", first.stdout.includes("Dropped the shipped Atomic Ops of 1 node(s)"), first.stdout);
  check(
    "init strips the live ledger and the twin follows",
    !readRel(liveOf("f-core")).includes("## Atomic Ops") && twinInSync("f-core"),
    readRel(liveOf("f-core"))
  );

  // An open revision keeps its own list while init strips the live file.
  addLedger(liveOf("f-chk"), "Old chk work");
  fs.writeFileSync(
    path.join(root, ...nextOf("f-chk").split("/")),
    readRel(liveOf("f-chk")).replace(/^state:.*$/m, "state: draft").replace("- [x] Old chk work", "- [ ] Revision work")
  );
  const second = runCli(["init", "--host", "claude"]);
  check(
    "init strips a live ledger and leaves the open revision's list alone",
    second.status === 0 &&
      !readRel(liveOf("f-chk")).includes("## Atomic Ops") &&
      readRel(nextOf("f-chk")).includes("- [ ] Revision work"),
    second.stdout + second.stderr
  );
  const again = runCli(["init", "--host", "claude"]);
  check("a rerun drops nothing", again.status === 0 && !again.stdout.includes("Dropped the shipped"), again.stdout);
}

if (failures > 0) {
  console.log(`\nlean-replies.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nlean-replies.test.mjs: all ok");
