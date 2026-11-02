/**
 * Several open revisions per node, end to end over MCP (npm test): open_next needs a change and
 * opens one revision folder per change; a node with several revisions needs change on
 * update_node_status; shipping one revision rebases its siblings (untouched text carries over, a
 * section both edited becomes a conflict); a conflict blocks in-review until resolve_conflict
 * clears it; discard_next works per change; map.md is never listed in changed_files.
 */
// Fixtures build graphs without a version stamp; the gate has its own suite (version.test.mjs).
process.env.MINDPLAN_VERSION_GATE ??= "off";
// This suite is about revisions, not orientation.
process.env.MINDPLAN_ORIENT_GATE = "off";
// Spawned servers rank by keyword only: no model download or load during tests.
process.env.MINDPLAN_SEARCH ??= "keyword";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SHIP, fillAndTick } from "./ship-fixture.mjs";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-rebase-"));
console.log("Rebase-flow sandbox:", root);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, MINDPLAN_ROOT: root },
});
const client = new Client({ name: "rebase-flow-test", version: "0.1.0" });
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

const abs = (rel) => path.join(root, ...rel.split("/"));
const read = (rel) => fs.readFileSync(abs(rel), "utf-8");
const exists = (rel) => fs.existsSync(abs(rel));
function write(rel, content) {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), content);
}

const LIVE = "mindplan/foundations/f-sub/f-sub.mdx";
const revDir = (change) => `mindplan/foundations/f-sub/revisions/${change}`;
const revFile = (change) => `${revDir(change)}/f-sub.mdx`;

/** Replaces the body of `## heading` (up to the next level-2 heading) in a file. */
function setSection(rel, heading, text) {
  const body = read(rel);
  const re = new RegExp(`(^## ${heading}\\r?\\n)([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m");
  if (!re.test(body)) throw new Error(`no ## ${heading} in ${rel}`);
  write(rel, body.replace(re, (_m, h) => `${h}\n${text}\n\n`));
}

/** Ticks every box of a revision and records its decision in the revision's decisions folder. */
function readyRevision(change) {
  write(revFile(change), read(revFile(change)).replaceAll("- [ ]", "- [x]"));
  const day = new Date().toISOString().slice(0, 10);
  write(
    `${revDir(change)}/decisions/d-${change}.md`,
    [
      `### d-${change}`,
      "",
      `- Decision: Revise f-sub under ${change}.`,
      "- Alternatives:",
      "  - A new node that depends_on f-sub: the contract itself changes.",
      "- Why: The shared spec must change in place.",
      `- Change: ${change}`,
      `- Date: ${day}`,
      "",
    ].join("\n")
  );
}

const noMap = (result) => !(result.changed_files ?? []).includes("mindplan/map.md");

fs.mkdirSync(abs("mindplan"), { recursive: true });
write("mindplan/config.json", JSON.stringify({ sources: ["src/**"], exclude: [] }, null, 2) + "\n");

// --- base: two shipped Foundations ---
await call("create_node", { id: "f-base", type: "Foundation", title: "Base", description: "Infra — base", role: "infra" });
await call("create_node", { id: "f-sub", type: "Foundation", title: "Sub", description: "Infra — substrate", role: "infra" });
write("src/f-base/index.ts", "export const base = 1;\n");
write("src/f-sub/index.ts", "export const sub = 1;\n");
await call("set_implementation_files", { node_id: "f-base", files: ["src/f-base/index.ts"] });
await call("set_implementation_files", { node_id: "f-sub", files: ["src/f-sub/index.ts"] });
fillAndTick(abs("mindplan/foundations/f-base/f-base.mdx"));
fillAndTick(abs(LIVE));
for (const new_status of SHIP) {
  await call("update_node_status", { node_id: "f-base", new_status });
  await call("update_node_status", { node_id: "f-sub", new_status });
}

// --- open_next: change required, one revision folder per change ---
{
  const noChange = await blocked("open_next", { node_id: "f-sub" });
  check("open_next without change is Blocked and names change", !!noChange && noChange.includes("change"), String(noChange));

  const planned = await call("link_nodes", { source_id: "f-sub", target_id: "f-base", edge_type: "depends_on", change: "a" });
  check("link_nodes with change plans the edge on the shipped node", planned.planned?.change === "a", JSON.stringify(planned));

  const openedA = await call("open_next", { node_id: "f-sub", change: "a" });
  check(
    "open_next writes revisions/a/f-sub.mdx, applies the planned edge, and lists the revision",
    exists(revFile("a")) &&
      openedA.changed_files?.includes(revFile("a")) &&
      openedA.applied_planned?.includes("f-sub -depends_on-> f-base") &&
      openedA.revisions?.length === 1 &&
      openedA.revisions[0].change === "a" &&
      openedA.revisions[0].state === "draft" &&
      noMap(openedA),
    JSON.stringify(openedA)
  );
  check("open_next writes no <id>.next.mdx", !exists("mindplan/foundations/f-sub/f-sub.next.mdx"));

  const openedB = await call("open_next", { node_id: "f-sub", change: "b" });
  check(
    "a second change opens a second revision beside the first",
    exists(revFile("b")) && openedB.revisions?.map((r) => r.change).join(",") === "a,b",
    JSON.stringify(openedB)
  );
  const again = await blocked("open_next", { node_id: "f-sub", change: "a" });
  check("opening the same change twice is Blocked", !!again && again.includes('"a"'), String(again));

  const ambiguous = await blocked("update_node_status", { node_id: "f-sub", new_status: "ready" });
  check(
    "update_node_status on a node with two revisions and no change is Blocked naming both",
    !!ambiguous && ambiguous.includes('"a"') && ambiguous.includes('"b"'),
    String(ambiguous)
  );
  const discardAmbiguous = await blocked("discard_next", { node_id: "f-sub" });
  check("discard_next with two revisions and no change is Blocked", !!discardAmbiguous, String(discardAmbiguous));

  const moved = await call("update_node_status", { node_id: "f-sub", change: "b", new_status: "ready" });
  check(
    "change picks the revision a single transition moves",
    moved.change === "b" && moved.previous_state === "draft" && moved.revision_state === "ready" && moved.new_state === "stable" && noMap(moved),
    JSON.stringify(moved)
  );
}

// --- A edits the spec, B edits the purpose; shipping A carries A's spec into B ---
{
  setSection(revFile("a"), "Shared Substrate Spec", "Spec from A.");
  setSection(revFile("b"), "Purpose", "Purpose from B.");
  readyRevision("a");
  readyRevision("b");

  const shipped = await call("update_node_status", { scope: "change", change: "a", new_status: "ship", skip_review: true });
  const rebasedB = (shipped.rebased ?? []).find((r) => r.change === "b");
  check(
    "a scope change walk ships revision a and reports b rebased with no conflicts",
    !!rebasedB && rebasedB.node_id === "f-sub" && rebasedB.conflicts.length === 0 && noMap(shipped),
    JSON.stringify(shipped)
  );
  const live = read(LIVE);
  check(
    "live has A's spec and the depends_on edge; the a folder is gone",
    live.includes("Spec from A.") && /depends_on:\r?\n\s+- f-base/.test(live) && !exists(revDir("a")),
    live
  );
  const b = read(revFile("b"));
  check("b's body carries A's spec and keeps its own purpose", b.includes("Spec from A.") && b.includes("Purpose from B."), b);
}

// --- C edits the same section as B; shipping B leaves C with a section conflict ---
{
  await call("open_next", { node_id: "f-sub", change: "c" });
  setSection(revFile("c"), "Purpose", "Purpose from C.");
  readyRevision("c");

  for (const new_status of ["in-progress", "in-review"]) {
    await call("update_node_status", { node_id: "f-sub", change: "b", new_status });
  }
  const shipB = await call("update_node_status", { node_id: "f-sub", change: "b", new_status: "ship" });
  const rebasedC = (shipB.rebased ?? []).find((r) => r.change === "c");
  check(
    "shipping b reports c rebased with a section conflict on ## Purpose",
    shipB.promoted_next === true && !!rebasedC && rebasedC.conflicts.includes("section:## Purpose") && noMap(shipB),
    JSON.stringify(shipB)
  );
  check("live now has B's purpose", read(LIVE).includes("Purpose from B."));

  await call("update_node_status", { node_id: "f-sub", new_status: "ready" });
  await call("update_node_status", { node_id: "f-sub", new_status: "in-progress" });
  const review = await blocked("update_node_status", { node_id: "f-sub", new_status: "in-review" });
  check("in-review of a conflicted revision is Blocked naming resolve_conflict", !!review && review.includes("resolve_conflict"), String(review));

  const resolved = await call("resolve_conflict", { node_id: "f-sub", section: "## Purpose", take: "revision" });
  check(
    "resolve_conflict take revision clears the conflict and lists none left",
    resolved.change === "c" && Array.isArray(resolved.conflicts) && resolved.conflicts.length === 0 && noMap(resolved),
    JSON.stringify(resolved)
  );

  await call("update_node_status", { node_id: "f-sub", new_status: "in-review" });
  const shipC = await call("update_node_status", { node_id: "f-sub", new_status: "ship" });
  check(
    "c ships once its conflict is resolved, with its own purpose",
    shipC.promoted_next === true && read(LIVE).includes("Purpose from C.") && !exists("mindplan/foundations/f-sub/revisions"),
    JSON.stringify(shipC)
  );
}

// --- discard works per change ---
{
  await call("open_next", { node_id: "f-sub", change: "d" });
  await call("open_next", { node_id: "f-sub", change: "e" });
  const discarded = await call("discard_next", { node_id: "f-sub", change: "d" });
  check(
    "discard_next with change deletes only that revision folder",
    discarded.change === "d" && !exists(revDir("d")) && exists(revFile("e")) &&
      discarded.revisions?.map((r) => r.change).join(",") === "e" && noMap(discarded),
    JSON.stringify(discarded)
  );
  const last = await call("discard_next", { node_id: "f-sub" });
  check(
    "discard_next without change discards the only open revision",
    last.change === "e" && !exists("mindplan/foundations/f-sub/revisions") && last.next_state === null && !last.revisions,
    JSON.stringify(last)
  );
}

await client.close();
fs.rmSync(root, { recursive: true, force: true });
if (failures > 0) {
  console.log(`rebase-flow.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("rebase-flow.test.mjs: all ok");
