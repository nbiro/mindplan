/**
 * Lean node replies: a shipped node keeps no Atomic Ops (ship drops them, open_next starts a fresh
 * unticked list, force_unship gives the live file one again, upgrade_project drops the ledgers an older
 * release left), and the node reads return one copy of the decisions, one slot, or one section.
 * Every write here is also diffed against the sandbox: each mindplan/ file it touched must be in
 * its changed_files. Run via npm test.
 */
// Fixtures build graphs without a version stamp; the gate has its own suite (version.test.mjs).
process.env.MINDPLAN_VERSION_GATE ??= "off";
import { runUpgrade } from "./upgrade-run.mjs";
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
const checklist = await import(pathToFileURL(path.join(toolRoot, "dist/foundations/f-territory-store/checklist.js")).href);
const gates = await import(pathToFileURL(path.join(toolRoot, "dist/foundations/f-compiler-rules/checklist-gates.js")).href);

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

/** Derived after every write and never listed in changed_files. */
const MAP = "mindplan/map.md";

/** Paths created, changed, or deleted between two snapshots (the derived map excluded). */
function touched(before, after) {
  const out = [];
  for (const [rel, text] of after) if (rel !== MAP && before.get(rel) !== text) out.push(rel);
  for (const rel of before.keys()) if (rel !== MAP && !after.has(rel)) out.push(rel);
  return out;
}

let diffMisses = 0;

/** Call a tool and check that its changed_files covers every file it touched on disk. */
async function call(tool, args) {
  const before = snapshot();
  const res = await client.callTool({ name: tool, arguments: tool === "run_check" ? { compact: false, ...args } : args });
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
  const res = await client.callTool({ name: tool, arguments: tool === "run_check" ? { compact: false, ...args } : args });
  const text = res.content?.[0]?.text ?? "";
  if (!res.isError) return null;
  const wrote = touched(before, snapshot());
  if (wrote.length > 0) check(`Blocked ${tool} wrote nothing`, false, JSON.stringify(wrote));
  return text;
}

const liveOf = (id) => `mindplan/foundations/${id}/${id}.mdx`;
const nextOf = (id) => `mindplan/foundations/${id}/${id}.next.mdx`;
const revDirOf = (id, change) => `mindplan/foundations/${id}/revisions/${change}`;
const revOf = (id, change) => `${revDirOf(id, change)}/${id}.mdx`;
const readRel = (rel) => fs.readFileSync(path.join(root, ...rel.split("/")), "utf-8");
const count = (text, re) => (text.match(re) ?? []).length;
const UNTICKED = /^\s*[-*+]\s+\[ \]/gm;
const TICKED = /^\s*[-*+]\s+\[[xX]\]/gm;

/** True when a shipped node with no open revision has no `<id>.next.mdx` and no `revisions/` beside its live file. */
function noNextFile(id) {
  return (
    fs.existsSync(path.join(root, ...liveOf(id).split("/"))) &&
    !fs.existsSync(path.join(root, ...nextOf(id).split("/"))) &&
    !fs.existsSync(path.join(root, "mindplan", "foundations", id, "revisions"))
  );
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
  await call("set_implementation_files", { replace: true, node_id: id, files: [`src/${id}/`] });
  const file = path.join(root, ...liveOf(id).split("/"));
  let text = fs.readFileSync(file, "utf-8");
  text = text.replace(/^_.*?_$/gm, (line) => (line.includes("attachments/") ? line : "Lean-replies filled territory."));
  fs.writeFileSync(file, text.replaceAll("- [ ]", "- [x]"));
}

async function walk(id, steps) {
  for (const new_status of steps) await call("update_node_status", { node_id: id, new_status });
}

const tickAll = (id) =>
  call("patch_node_territory", { node_id: id, toggle_checkboxes: [{ id: "spec", checked: true }, { id: "impl", checked: true }, { id: "verify", checked: true }] });

/** Ticks every box of an open revision in its file (the edit tools have their own suites). */
function tickRevision(id, change) {
  write(revOf(id, change), readRel(revOf(id, change)).replaceAll("- [ ]", "- [x]"));
}

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

// --- checklist items: ids, kinds, and the sections they live in ---
{
  const body = [
    "## Purpose",
    "",
    "- [ ] Purpose box {#purpose}",
    "",
    "## Atomic Ops",
    "",
    "- [x] Spec written {#spec}",
    "- [ ] Security review {#sec review} — note: booked",
    "- [x] Ship it {#ship deploy} — n/a:",
    "- [ ] Plain item",
    "- [x] Odd tag {#Bad}",
    "",
    "## Rules",
    "",
    "- [ ] Not an item either",
  ].join("\r\n");
  const items = checklist.parseChecklistItems(body);
  check(
    "parseChecklistItems reads ids, kinds, text, state, and section of every counted box (Rules left out)",
    JSON.stringify(items.map(({ id, kind, text, checked, done, section }) => ({ id, kind, text, checked, done, section }))) ===
      JSON.stringify([
        { id: "purpose", kind: "build", text: "Purpose box", checked: false, done: false, section: "Purpose" },
        { id: "spec", kind: "build", text: "Spec written", checked: true, done: true, section: "Atomic Ops" },
        { id: "sec", kind: "review", text: "Security review", checked: false, done: false, section: "Atomic Ops" },
        { id: "ship", kind: "deploy", text: "Ship it", checked: true, done: false, section: "Atomic Ops" },
        { kind: "build", text: "Plain item", checked: false, done: false, section: "Atomic Ops" },
        { kind: "build", text: "Odd tag {#Bad}", checked: true, done: true, section: "Atomic Ops" },
      ]) && items[1].line === 6 && store.countCheckboxesInText(body).unchecked + store.countCheckboxesInText(body).checked === items.length,
    JSON.stringify(items)
  );
  check(
    "buildItemsTicked needs at least one item, and an untagged Acceptance Criteria box is a build item",
    !gates.buildItemsTicked("## Purpose\n\nNo boxes here.\n") &&
      !gates.buildItemsTicked("## Acceptance Criteria\n\n- [ ] Handles empty input\n\n## Atomic Ops\n\n- [x] Done\n") &&
      gates.buildItemsTicked("## Acceptance Criteria\n\n- [x] Handles empty input\n- [ ] Sign-off {#sign review}\n")
  );
  check(
    "formatChecklistTag writes {#id} for build and {#id kind} otherwise",
    checklist.formatChecklistTag("spec") === "{#spec}" &&
      checklist.formatChecklistTag("sec", "review") === "{#sec review}" &&
      checklist.formatChecklistTag(undefined) === ""
  );
  check(
    "defaultAtomicOps gives every pipeline type the ids spec, impl, verify",
    ["Foundation", "Interaction", "Interface"].every((type) =>
      JSON.stringify(checklist.parseChecklistItems(["## Atomic Ops", "", ...store.defaultAtomicOps(type)].join("\n")).map((i) => i.id)) ===
        JSON.stringify(["spec", "impl", "verify"])
    )
  );
  const appended = checklist.appendChecklistItems("## Atomic Ops\n\n- [ ] A {#a}\n\n## Rules\n", [{ text: "B", kind: "deploy" }]).body;
  check(
    "appendChecklistItems adds after the last item and slugs an id for a non-build kind",
    appended === "## Atomic Ops\n\n- [ ] A {#a}\n- [ ] B {#b deploy}\n\n## Rules\n",
    JSON.stringify(appended)
  );
  const empty = checklist.appendChecklistItems("## Atomic Ops\n\n## Rules\n", [{ text: "C", id: "c" }]).body;
  check("appendChecklistItems fills an empty section", empty === "## Atomic Ops\n\n- [ ] C {#c}\n\n## Rules\n", JSON.stringify(empty));
  // A lone CR before the Atomic Ops: parse and edit split lines the same way, and each break stays as written.
  const loneCr = "Intro\rmore\r\n## Atomic Ops\r\n\r\n- [ ] A {#a}\r\n- [ ] B {#b}\r\n";
  const ticked = checklist.toggleChecklistItems(loneCr, [{ id: "b", checked: true }]).body;
  check(
    "toggleChecklistItems after a lone CR ticks the item named and keeps every line break",
    ticked === "Intro\rmore\r\n## Atomic Ops\r\n\r\n- [ ] A {#a}\r\n- [x] B {#b}\r\n",
    JSON.stringify(ticked)
  );
  const crAppended = checklist.appendChecklistItems(loneCr, [{ text: "C", id: "c" }]).body;
  check(
    "appendChecklistItems after a lone CR keeps the CR and adds a CRLF line",
    crAppended === "Intro\rmore\r\n## Atomic Ops\r\n\r\n- [ ] A {#a}\r\n- [ ] B {#b}\r\n- [ ] C {#c}\r\n",
    JSON.stringify(crAppended)
  );
  // A task line inside a fenced code block is example text: no item, no count, no toggle.
  const fencedBody = "## Purpose\n\n```md\n- [ ] step\n```\n\n## Atomic Ops\n\n- [x] Real {#real}\n";
  const fencedItems = checklist.parseChecklistItems(fencedBody);
  const fencedCount = store.countCheckboxesInText(fencedBody);
  let fencedToggle = "";
  try {
    checklist.toggleChecklistItems(fencedBody, [{ text: "step", checked: true }]);
  } catch (err) {
    fencedToggle = err.message;
  }
  check(
    "a fenced `- [ ] step` is not an item, is not counted, and a toggle by its text is Blocked",
    JSON.stringify(fencedItems.map((i) => i.text)) === JSON.stringify(["Real"]) &&
      fencedCount.unchecked === 0 && fencedCount.checked === 1 &&
      fencedToggle.startsWith("Blocked:"),
    JSON.stringify({ fencedItems, fencedCount, fencedToggle })
  );
  // A task line inside a fence after the last item is code: new items go after the last real item.
  const fencedAfter = "## Atomic Ops\n\n- [ ] A {#a}\n\n```md\n- [ ] example\n```\n";
  const fencedAppended = checklist.appendChecklistItems(fencedAfter, [{ text: "B", id: "b" }]).body;
  check(
    "appendChecklistItems never inserts inside fenced code",
    fencedAppended === "## Atomic Ops\n\n- [ ] A {#a}\n- [ ] B {#b}\n\n```md\n- [ ] example\n```\n" &&
      checklist.parseChecklistItems(fencedAppended).some((i) => i.id === "b"),
    JSON.stringify(fencedAppended)
  );
}

// --- first ship drops the ledger from live and writes no next file ---
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
  check("first ship writes no next file", noNextFile("f-core"));
}

// --- open_next starts a fresh ledger; the revision cannot ship on old ticks ---
await call("open_next", { node_id: "f-core", change: "lean" });
{
  const next = readRel(revOf("f-core", "lean"));
  check(
    "open_next gives the revision one unticked default list and no Rules (rules stay on live)",
    count(next, /^## Atomic Ops$/gm) === 1 &&
      count(next, UNTICKED) === 3 &&
      count(next, TICKED) === 0 &&
      !next.includes("## Rules"),
    next
  );
  // The revision's decision is a file in its decisions/ folder (record_decision has its own suite).
  write(
    `${revDirOf("f-core", "lean")}/decisions/d-core-one-module.md`,
    [
      "### d-core-one-module",
      "",
      "- Decision: Core stays one module.",
      "- Alternatives:",
      "  - Split it (no second caller yet)",
      "- Why: One caller.",
      "- Change: lean",
      `- Date: ${new Date().toISOString().slice(0, 10)}`,
      "",
    ].join("\n")
  );
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
tickRevision("f-core", "lean");
await walk("f-core", ["ship"]);
{
  const live = readRel(liveOf("f-core"));
  check(
    "promote leaves no Atomic Ops on live, keeps Rules, and moves the revision's decision beside live",
    !live.includes("## Atomic Ops") &&
      live.includes("- Keep it small.") &&
      readRel("mindplan/foundations/f-core/decisions/d-core-one-module.md").includes("Core stays one module."),
    live
  );
  check("promote deletes the revision folder", noNextFile("f-core"));
  const noNext = await blocked("get_node_context", { node_id: "f-core", slot: "next" });
  check("slot next without an open revision is Blocked", noNext?.includes("Blocked:") && noNext.includes("no open revision"), noNext ?? "accepted");
  const noNextPatch = await blocked("patch_node_territory", { node_id: "f-core", slot: "next", description: "Infra — patched." });
  check(
    "patch_node_territory slot next without an open revision is Blocked naming open_next, not a next file",
    noNextPatch?.includes("Blocked:") &&
      noNextPatch.includes("no open revision") &&
      noNextPatch.includes('open_next({ node_id: "f-core", change })') &&
      !noNextPatch.includes(".next.mdx"),
    noNextPatch ?? "accepted"
  );
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
  check("the unshipped node ships again", !readRel(liveOf("f-chk")).includes("## Atomic Ops") && noNextFile("f-chk"));
}

// An open revision for the upgrade below: it keeps its own list while the upgrade strips live.
await call("open_next", { node_id: "f-chk", change: "chk" });
write(revOf("f-chk", "chk"), readRel(revOf("f-chk", "chk")).replace(/^- \[ \] .*$/m, "- [ ] Revision work"));

const final = await call("run_check", {});
check("the sandbox passes the check before the upgrade", final.ok, JSON.stringify(final.failures));
check("every write listed every mindplan/ file it touched", diffMisses === 0, `${diffMisses} write(s) missed files`);
// --- an open revision's ledger: default ids, added items, and the items that wait on people ---
{
  await foundation("f-items");
  await walk("f-items", ["ready", "in-progress", "in-review", "ship"]);
  await call("open_next", { node_id: "f-items", change: "items" });
  check(
    "a revision's fresh ledger carries the default ids",
    /- \[ \] Spec written \{#spec\}\r?\n- \[ \] Implementation complete \{#impl\}\r?\n- \[ \] Verified in target environment \{#verify\}/.test(
      readRel(revOf("f-items", "items"))
    ),
    readRel(revOf("f-items", "items"))
  );
  const added = await call("patch_node_territory", { node_id: "f-items", add_checklist_items: [{ text: "QA sign-off", id: "qa", kind: "review" }] });
  check(
    "add_checklist_items writes to the open revision",
    added.patched_fields?.includes("add_checklist_items") && readRel(revOf("f-items", "items")).includes("- [ ] QA sign-off {#qa review}"),
    JSON.stringify(added)
  );
  const dup = await blocked("patch_node_territory", { node_id: "f-items", add_checklist_items: [{ text: "Again", id: "impl" }] });
  check("a revision's ids are unique: a duplicate is Blocked", !!dup && dup.includes('"impl"'), String(dup));
  const r = await call("run_check", {});
  check(
    "run_check names the revision whose item waits on people",
    r.info?.includes("waiting on people: f-items (revision items): qa (review)"),
    JSON.stringify(r.info)
  );
  const o = await call("orient_for_work", { change: "items" });
  check(
    "orient_for_work on the change lists its revisions' open items",
    JSON.stringify(o.open_items) === JSON.stringify([{ node_id: "f-items", change: "items", id: "qa", kind: "review", text: "QA sign-off" }]),
    JSON.stringify(o.open_items)
  );
  const ticked = await call("patch_node_territory", { node_id: "f-items", toggle_checkboxes: [{ id: "qa", checked: true }] });
  check("a revision item ticks by id", ticked.toggled?.[0] === "- [x] QA sign-off {#qa review}", JSON.stringify(ticked));
}

await client.close();

// --- upgrade_project drops the ledgers an older release left on shipped nodes ---
{
  /** Puts a ticked ledger back on a file by hand, as a release before 0.7.0 left it. */
  const addLedger = (rel, item) => {
    const abs = path.join(root, ...rel.split("/"));
    fs.writeFileSync(abs, fs.readFileSync(abs, "utf-8").replace("## Attachments", `## Atomic Ops

- [x] ${item}

## Attachments`));
  };
  addLedger(liveOf("f-core"), "Old work");
  const first = runUpgrade(root);
  check("upgrade_project succeeds", first.status === 0, first.stderr);
  check(
    "upgrade_project reports the dropped ledger and lists the file",
    JSON.stringify(first.result?.migrations?.atomicOpsDropped) === JSON.stringify(["f-core"]) &&
      first.result.changed_files.includes(liveOf("f-core")),
    JSON.stringify(first.result)
  );
  check(
    "upgrade_project strips the live ledger and writes no next file",
    !readRel(liveOf("f-core")).includes("## Atomic Ops") && noNextFile("f-core"),
    readRel(liveOf("f-core"))
  );

  // An open revision keeps its own list while the upgrade strips the live file.
  addLedger(liveOf("f-chk"), "Old chk work");
  const second = runUpgrade(root);
  check(
    "upgrade_project strips a live ledger and leaves the open revision's list alone",
    second.status === 0 &&
      !readRel(liveOf("f-chk")).includes("## Atomic Ops") &&
      readRel(revOf("f-chk", "chk")).includes("- [ ] Revision work"),
    second.stderr
  );
  const again = runUpgrade(root);
  check(
    "a rerun drops nothing",
    again.status === 0 && again.result.migrations.atomicOpsDropped.length === 0 && again.result.changed_files.length === 0,
    JSON.stringify(again.result)
  );
}

if (failures > 0) {
  console.log(`\nlean-replies.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nlean-replies.test.mjs: all ok");
