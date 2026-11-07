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
// A session reads the project rules first (writes are Blocked: Rules until then), as an agent does.
await client.callTool({ name: "get_project", arguments: {} });

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`ok   ${label}`);
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

async function raw(tool, args) {
  const res = await client.callTool({ name: tool, arguments: tool === "run_check" ? { compact: false, ...args } : args });
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
await call("set_implementation_files", { replace: true, node_id: "f-base", files: ["src/f-base/index.ts"] });
await call("set_implementation_files", { replace: true, node_id: "f-sub", files: ["src/f-sub/index.ts"] });
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
    "the walk line of a node that keeps another open revision shows live's shipped state",
    (shipped.lines ?? []).some((l) => /^f-sub: .* -> stable$/.test(l)),
    JSON.stringify(shipped.lines)
  );
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
  check(
    "a ready sibling whose text the rebase changed goes back to draft, reported in rebased",
    JSON.stringify(rebasedB?.readiness_reset) === JSON.stringify({ from: "ready", to: "draft" }) && /^state: draft$/m.test(b),
    JSON.stringify(rebasedB)
  );
}

// --- C edits the same section as B; shipping B leaves C with a section conflict ---
{
  await call("open_next", { node_id: "f-sub", change: "c" });
  setSection(revFile("c"), "Purpose", "Purpose from C.");
  readyRevision("c");

  for (const new_status of ["ready", "in-progress", "in-review"]) {
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

// --- live patched in place while a revision is open: the ship carries the revision onto it ---
{
  const walkToShip = async (change) => {
    readyRevision(change);
    for (const new_status of ["ready", "in-progress", "in-review"]) {
      await call("update_node_status", { node_id: "f-sub", change, new_status });
    }
    return raw("update_node_status", { node_id: "f-sub", change, new_status: "ship" });
  };
  await call("open_next", { node_id: "f-sub", change: "x" });
  setSection(revFile("x"), "Purpose", "Purpose from X.");
  await call("patch_node_territory", { node_id: "f-sub", slot: "current", section: "## Shared Substrate Spec", text: "Spec patched in place." });
  const shipX = await walkToShip("x");
  const liveX = read(LIVE);
  check(
    "a ship keeps an in-place live edit to a section the revision did not touch",
    !shipX.error && liveX.includes("Spec patched in place.") && liveX.includes("Purpose from X."),
    shipX.text + "\n" + liveX
  );

  await call("open_next", { node_id: "f-sub", change: "w" });
  setSection(revFile("w"), "Purpose", "Purpose from W.");
  await call("patch_node_territory", { node_id: "f-sub", slot: "current", section: "## Purpose", text: "Purpose patched in place." });
  const shipW = await walkToShip("w");
  check(
    "a ship over an in-place edit of the same section is Blocked with a section conflict naming resolve_conflict",
    shipW.error && shipW.text.includes("section:## Purpose") && shipW.text.includes("resolve_conflict") &&
      /conflicts:\r?\n\s+- "?section:## Purpose/.test(read(revFile("w"))) &&
      read(LIVE).includes("Purpose patched in place."),
    shipW.text
  );
  check(
    "the single-node Blocked names the revision file it wrote the conflicts to",
    shipW.text.trimEnd().endsWith(`Wrote: ${revFile("w")}.`),
    shipW.text
  );
  await call("discard_next", { node_id: "f-sub", change: "w" });

  // The same conflict inside a batch: the ship Blocks, the other item moves, and changed_files
  // still lists the revision file the ship wrote its conflicts to.
  await call("create_node", { id: "f-batchmate", type: "Foundation", title: "Batchmate", description: "Infra — batchmate", role: "infra" });
  write("src/f-batchmate/index.ts", "export const v = 1;\n");
  await call("set_implementation_files", { node_id: "f-batchmate", add: ["src/f-batchmate/index.ts"] });
  fillAndTick(abs("mindplan/foundations/f-batchmate/f-batchmate.mdx"));
  await call("open_next", { node_id: "f-sub", change: "v" });
  setSection(revFile("v"), "Purpose", "Purpose from V.");
  await call("patch_node_territory", { node_id: "f-sub", slot: "current", section: "## Purpose", text: "Purpose patched in place again." });
  readyRevision("v");
  for (const new_status of ["ready", "in-progress", "in-review"]) {
    await call("update_node_status", { node_id: "f-sub", change: "v", new_status });
  }
  const batch = await call("update_node_status", {
    revisions: [
      { node_id: "f-sub", change: "v", new_status: "ship" },
      { node_id: "f-batchmate", new_status: "ready" },
    ],
  });
  const shipRow = batch.results?.find((r) => r.node_id === "f-sub");
  check(
    "a batch item that Blocks after persisting conflicts still lists the file in changed_files",
    shipRow?.ok === false &&
      batch.results?.find((r) => r.node_id === "f-batchmate")?.ok === true &&
      batch.changed_files?.includes(revFile("v")) &&
      /conflicts:\r?\n\s+- "?section:## Purpose/.test(read(revFile("v"))),
    JSON.stringify(batch)
  );
  await call("discard_next", { node_id: "f-sub", change: "v" });
}

// --- a preamble conflict (text above the first heading) resolves by "_preamble" and stays on top ---
{
  await call("open_next", { node_id: "f-sub", change: "pre" });
  // The revision drops the preamble; live edits it in place: a conflict on _preamble.
  const stripPreamble = (text) => text.replace(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)[\s\S]*?(?=^## )/m, "$1\n");
  const setPreamble = (text, intro) => text.replace(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)[\s\S]*?(?=^## )/m, `$1\n${intro}\n\n`);
  write(revFile("pre"), stripPreamble(read(revFile("pre"))));
  write(LIVE, setPreamble(read(LIVE), "# Sub\n\nIntro edited in place."));
  readyRevision("pre");
  for (const new_status of ["ready", "in-progress", "in-review"]) {
    await call("update_node_status", { node_id: "f-sub", change: "pre", new_status });
  }
  const shipPre = await raw("update_node_status", { node_id: "f-sub", change: "pre", new_status: "ship" });
  check(
    "a ship over a dropped preamble that live edited is Blocked with a section:_preamble conflict",
    shipPre.error && shipPre.text.includes("section:_preamble"),
    shipPre.text
  );
  const resolvedPre = await raw("resolve_conflict", { node_id: "f-sub", section: "_preamble", take: "live" });
  const revPre = read(revFile("pre"));
  check(
    "resolve_conflict section _preamble take live clears the conflict and puts live's preamble at the top",
    !resolvedPre.error && JSON.parse(resolvedPre.text).conflicts.length === 0 &&
      /^---\r?\n[\s\S]*?\r?\n---\r?\n\s*# Sub\r?\n\r?\nIntro edited in place\./.test(revPre),
    resolvedPre.text + "\n" + revPre
  );
  await call("discard_next", { node_id: "f-sub", change: "pre" });
}

// --- a batch naming one revision twice (change omitted once, given once) is a duplicate ---
{
  await call("open_next", { node_id: "f-sub", change: "dup" });
  readyRevision("dup");
  const before = read(revFile("dup"));
  const dup = await blocked("update_node_status", {
    revisions: [
      { node_id: "f-sub", new_status: "ready" },
      { node_id: "f-sub", change: "dup", new_status: "ready" },
    ],
  });
  check(
    "a batch listing the only revision with change omitted and with it named is Blocked as a duplicate",
    !!dup && dup.includes("duplicate") && read(revFile("dup")) === before,
    String(dup)
  );
  // With two revisions open, an item omitting change cannot resolve: each such item Blocks on its
  // own with the real reason, not as a duplicate of the other.
  await call("open_next", { node_id: "f-sub", change: "dup2" });
  const unresolved = await blocked("update_node_status", {
    revisions: [
      { node_id: "f-sub", new_status: "ready" },
      { node_id: "f-sub", new_status: "ready" },
    ],
  });
  const itemLines = (unresolved ?? "").split("\n").filter((l) => l.startsWith('- "f-sub"'));
  check(
    "two items omitting change on a node with several revisions each Block for the missing change, not as duplicates",
    !!unresolved && !unresolved.includes("duplicate") && itemLines.length === 2 &&
      itemLines.every((l) => /"dup", "dup2"|pass change/.test(l)) &&
      read(revFile("dup")) === before,
    String(unresolved)
  );
  await call("discard_next", { node_id: "f-sub", change: "dup2" });
  await call("discard_next", { node_id: "f-sub", change: "dup" });
}

// --- a hub Foundation with three dependents takes three changes at once; all ship in sequence ---
{
  const HUB = "mindplan/foundations/f-static-build/f-static-build.mdx";
  const hubRev = (change) => `mindplan/foundations/f-static-build/revisions/${change}/f-static-build.mdx`;
  const ids = ["f-static-build", "f-dep-1", "f-dep-2", "f-dep-3", "f-x", "f-y", "f-z"];
  for (const id of ids) {
    await call("create_node", { id, type: "Foundation", title: id, description: `Infra — ${id}`, role: "infra" });
    write(`src/${id}/index.ts`, `export const v = 1;\n`);
    await call("set_implementation_files", { node_id: id, add: [`src/${id}/index.ts`] });
    fillAndTick(abs(`mindplan/foundations/${id}/${id}.mdx`));
  }
  for (const dep of ["f-dep-1", "f-dep-2", "f-dep-3"]) {
    await call("link_nodes", { source_id: dep, target_id: "f-static-build", edge_type: "depends_on" });
  }
  for (const id of ids) for (const new_status of SHIP) await call("update_node_status", { node_id: id, new_status });

  // Three changes, each adding its own depends_on and editing its own section.
  const plan = [
    { change: "add-x", target: "f-x", section: "## Purpose", text: "Builds pages from X." },
    { change: "add-y", target: "f-y", section: "## Shared Substrate Spec", text: "The build reads Y." },
    { change: "add-z", target: "f-z", section: "## Acceptance Criteria", text: "A build with Z passes." },
  ];
  for (const p of plan) await call("open_next", { node_id: "f-static-build", change: p.change });
  for (const p of plan) {
    await call("link_nodes", { source_id: "f-static-build", target_id: p.target, edge_type: "depends_on", change: p.change });
    await call("patch_node_territory", { node_id: "f-static-build", change: p.change, section: p.section, text: p.text });
    await call("patch_node_territory", {
      node_id: "f-static-build",
      change: p.change,
      toggle_checkboxes: [{ id: "spec", checked: true }, { id: "impl", checked: true }, { id: "verify", checked: true }],
    });
    await call("record_decision", {
      node_id: "f-static-build",
      change: p.change,
      decision: `The static build depends on ${p.target}.`,
      alternatives: [`A new node that depends_on f-static-build: the build itself needs ${p.target}.`],
      why: "The build step reads it directly.",
    });
  }
  const oriented = await call("orient_for_work", { node_id: "f-static-build", change: "add-y" });
  check(
    "orient on one revision reports its shape from the revision file (no section missing)",
    !!oriented.shape && oriented.shape.sections.every((s) => s.status === "present"),
    JSON.stringify(oriented.shape)
  );
  const graphRevs = (await call("get_node_context", { node_id: "f-static-build" })).revisions ?? [];
  check(
    "the hub lists three open revisions with conflict counts",
    graphRevs.map((r) => `${r.change}:${r.conflicts}`).join() === "add-x:0,add-y:0,add-z:0",
    JSON.stringify(graphRevs)
  );

  // Batch items carry change: two revisions of one node move in one call.
  const batch = await call("update_node_status", {
    revisions: [
      { node_id: "f-static-build", change: "add-x", new_status: "ready" },
      { node_id: "f-static-build", change: "add-y", new_status: "ready" },
    ],
  });
  check(
    "a revisions batch moves two revisions of one node by change",
    batch.lines?.length === 2 && batch.lines.every((l) => l.endsWith("-> ready")),
    JSON.stringify(batch)
  );

  for (const p of plan) {
    const shipped = await call("update_node_status", { scope: "change", change: p.change, new_status: "ship", skip_review: true });
    check(
      `change ${p.change} ships with no conflicts on the other revisions`,
      (shipped.rebased ?? []).every((r) => r.conflicts.length === 0) && noMap(shipped),
      JSON.stringify(shipped)
    );
  }
  const hub = await call("get_node_context", { node_id: "f-static-build" });
  const live = read(HUB);
  check(
    "the live hub has all three depends_on edges and all three texts, and no revision is left",
    ["f-x", "f-y", "f-z"].every((t) => (hub.record.depends_on ?? []).includes(t)) &&
      plan.every((p) => live.includes(p.text)) &&
      !exists("mindplan/foundations/f-static-build/revisions") &&
      !hub.revisions,
    JSON.stringify({ depends_on: hub.record.depends_on, live })
  );
  const decisions = fs.readdirSync(abs("mindplan/foundations/f-static-build/decisions")).sort();
  check(
    "each change's decision shipped into the hub's decisions folder",
    decisions.length === 3,
    JSON.stringify(decisions)
  );
  const final = await call("run_check", {});
  check("the check passes after the three ships", final.ok, final.output);

  // Stale text is read from the revision's own body.
  await call("open_next", { node_id: "f-y", change: "stale-y" });
  await call("patch_node_territory", {
    node_id: "f-y",
    change: "stale-y",
    section: "## Purpose",
    text: "Reads `src/f-y/missing.ts` on every build.",
  });
  const staleCheck = await call("run_check", { change: "stale-y" });
  check(
    "run_check({ change }) reads the revision body for stale paths",
    [...staleCheck.warnings, ...staleCheck.info].some((w) => w.includes("src/f-y/missing.ts")),
    JSON.stringify({ warnings: staleCheck.warnings, info: staleCheck.info })
  );
  await call("discard_next", { node_id: "f-y", change: "stale-y" });

  // Description warnings judge each open revision on its own, naming it.
  await call("open_next", { node_id: "f-z", change: "d1", description: "f-z" });
  await call("open_next", { node_id: "f-z", change: "d2", description: "Infra — z with a cache" });
  const described = await call("run_check", {});
  const about = described.warnings.filter((w) => w.startsWith('description: "f-z"'));
  check(
    "a repeated-title description warns for that revision only, naming it",
    about.length === 1 && about[0].startsWith('description: "f-z" (revision "d1") repeats its title'),
    JSON.stringify(about)
  );
  await call("discard_next", { node_id: "f-z", change: "d1" });
  await call("discard_next", { node_id: "f-z", change: "d2" });
}

// --- a change walk whose last member's live moved in place: the walk foresees the ship's conflict ---
{
  const members = ["f-m1", "f-m2", "f-m3"];
  const memberLive = (id) => `mindplan/foundations/${id}/${id}.mdx`;
  const memberRev = (id) => `mindplan/foundations/${id}/revisions/trio/${id}.mdx`;
  for (const id of members) {
    await call("create_node", { id, type: "Foundation", title: id, description: `Infra — ${id}`, role: "infra" });
    write(`src/${id}/index.ts`, "export const v = 1;\n");
    await call("set_implementation_files", { node_id: id, add: [`src/${id}/index.ts`] });
    fillAndTick(abs(memberLive(id)));
    for (const new_status of SHIP) await call("update_node_status", { node_id: id, new_status });
    await call("open_next", { node_id: id, change: "trio" });
    await call("patch_node_territory", { node_id: id, change: "trio", section: "## Purpose", text: `Purpose of ${id} from trio.` });
    await call("patch_node_territory", {
      node_id: id,
      change: "trio",
      toggle_checkboxes: [{ id: "spec", checked: true }, { id: "impl", checked: true }, { id: "verify", checked: true }],
    });
    await call("record_decision", {
      node_id: id,
      change: "trio",
      decision: `Revise ${id} under trio.`,
      alternatives: [`A new node that depends_on ${id}: the contract itself changes.`],
      why: "The purpose must change in place.",
    });
  }
  await call("patch_node_territory", { node_id: "f-m3", slot: "current", section: "## Purpose", text: "Purpose of f-m3 patched in place." });
  const revBefore = read(memberRev("f-m3"));

  const walk = await blocked("update_node_status", { scope: "change", change: "trio", new_status: "ship", skip_review: true });
  check(
    "a change walk Blocks before any write when a member's ship would hit a rebase conflict",
    !!walk && walk.includes("f-m3") && walk.includes("section:## Purpose") && walk.includes("Nothing was written") &&
      ["f-m1", "f-m2"].every((id) => exists(memberRev(id)) && !read(memberLive(id)).includes("from trio.")) &&
      read(memberRev("f-m3")) === revBefore,
    String(walk)
  );

  const skipping = await call("update_node_status", {
    scope: "change",
    change: "trio",
    new_status: "ship",
    skip_review: true,
    skip_blocked: true,
  });
  const left = (skipping.blocked ?? []).find((b) => b.node_id === "f-m3");
  check(
    "skip_blocked ships the other members and lists the conflicted one blocked with the conflict",
    ["f-m1", "f-m2"].every((id) => !exists(memberRev(id)) && read(memberLive(id)).includes(`Purpose of ${id} from trio.`)) &&
      !!left && left.step === "ship" && left.reason.includes("section:## Purpose") &&
      exists(memberRev("f-m3")) && read(memberLive("f-m3")).includes("patched in place."),
    JSON.stringify(skipping)
  );
  await call("discard_next", { node_id: "f-m3", change: "trio" });
}

// --- resolve_conflict with other text resets only a ready revision; in-review stays in-review ---
{
  const id = "f-ir";
  const irRev = (change) => `mindplan/foundations/${id}/revisions/${change}/${id}.mdx`;
  await call("create_node", { id, type: "Foundation", title: id, description: `Infra — ${id}`, role: "infra" });
  write(`src/${id}/index.ts`, "export const v = 1;\n");
  await call("set_implementation_files", { node_id: id, add: [`src/${id}/index.ts`] });
  fillAndTick(abs(`mindplan/foundations/${id}/${id}.mdx`));
  for (const new_status of SHIP) await call("update_node_status", { node_id: id, new_status });
  const walks = { ir1: ["ready", "in-progress", "in-review"], ir2: ["ready", "in-progress", "in-review"], ir3: ["ready"] };
  for (const [change, steps] of Object.entries(walks)) {
    await call("open_next", { node_id: id, change });
    await call("patch_node_territory", { node_id: id, change, section: "## Purpose", text: `Purpose from ${change}.` });
    await call("patch_node_territory", {
      node_id: id,
      change,
      toggle_checkboxes: [{ id: "spec", checked: true }, { id: "impl", checked: true }, { id: "verify", checked: true }],
    });
    await call("record_decision", {
      node_id: id,
      change,
      decision: `Revise ${id} under ${change}.`,
      alternatives: [`A new node that depends_on ${id}: the contract itself changes.`],
      why: "The purpose must change in place.",
    });
    for (const new_status of steps) await call("update_node_status", { node_id: id, change, new_status });
  }
  const shipped = await call("update_node_status", { node_id: id, change: "ir1", new_status: "ship" });
  const rebased = (shipped.rebased ?? []).find((r) => r.change === "ir2");
  check(
    "an in-review sibling whose text the rebase kept stays in-review with the section conflict",
    !!rebased && rebased.conflicts.includes("section:## Purpose") && !rebased.readiness_reset &&
      /^state: in-review$/m.test(read(irRev("ir2"))),
    JSON.stringify(shipped)
  );
  const inReview = await call("resolve_conflict", { node_id: id, change: "ir2", section: "## Purpose", take: "live" });
  check(
    "resolve_conflict taking live's text keeps an in-review revision in-review, like any contract write",
    !inReview.readiness_reset && /^state: in-review$/m.test(read(irRev("ir2"))) && read(irRev("ir2")).includes("Purpose from ir1."),
    JSON.stringify(inReview)
  );
  const ready = await call("resolve_conflict", { node_id: id, change: "ir3", section: "## Purpose", take: "live" });
  check(
    "resolve_conflict taking live's text sends a ready revision back to draft",
    ready.readiness_reset?.from === "ready" && ready.readiness_reset?.to === "draft" &&
      /^state: draft$/m.test(read(irRev("ir3"))) && read(irRev("ir3")).includes("Purpose from ir1."),
    JSON.stringify(ready)
  );
  for (const change of ["ir2", "ir3"]) await call("discard_next", { node_id: id, change });
}

/** Ticks a revision's default ops and records its decision, so it can walk to ship. */
async function readyByTools(id, change) {
  await call("patch_node_territory", {
    node_id: id,
    change,
    toggle_checkboxes: [{ id: "spec", checked: true }, { id: "impl", checked: true }, { id: "verify", checked: true }],
  });
  await call("record_decision", {
    node_id: id,
    change,
    decision: `Revise ${id} under ${change}.`,
    alternatives: [`A new node that depends_on ${id}: the contract itself changes.`],
    why: "The contract must change in place.",
  });
}

/** A shipped Foundation with one claimed file. */
async function shippedFoundation(id) {
  await call("create_node", { id, type: "Foundation", title: id, description: `Infra — ${id}`, role: "infra" });
  write(`src/${id}/index.ts`, "export const v = 1;\n");
  await call("set_implementation_files", { node_id: id, add: [`src/${id}/index.ts`] });
  fillAndTick(abs(`mindplan/foundations/${id}/${id}.mdx`));
  for (const new_status of SHIP) await call("update_node_status", { node_id: id, new_status });
}

// --- a change walk orders by the change's edges: a shipped member's revision depending on a new member ---
{
  await shippedFoundation("f-wo-a");
  await call("create_node", { id: "f-wo-b", type: "Foundation", title: "f-wo-b", description: "Infra — f-wo-b", role: "infra", change: "walk-order" });
  write("src/f-wo-b/index.ts", "export const v = 1;\n");
  await call("set_implementation_files", { node_id: "f-wo-b", add: ["src/f-wo-b/index.ts"] });
  fillAndTick(abs("mindplan/foundations/f-wo-b/f-wo-b.mdx"));
  await call("open_next", { node_id: "f-wo-a", change: "walk-order" });
  await call("link_nodes", { source_id: "f-wo-a", target_id: "f-wo-b", edge_type: "depends_on", change: "walk-order" });
  await readyByTools("f-wo-a", "walk-order");
  const walked = await raw("update_node_status", { scope: "change", change: "walk-order", new_status: "ship", skip_review: true });
  const order = walked.error ? [] : (JSON.parse(walked.text).lines ?? []).map((l) => l.split(":")[0]);
  check(
    "a change walk moves the new Foundation a member's revision depends_on before that member",
    !walked.error && order.indexOf("f-wo-b") >= 0 && order.indexOf("f-wo-b") < order.indexOf("f-wo-a"),
    walked.text
  );
}

// --- a sibling rebase keeps a file another node's revision of the same change releases ---
{
  await shippedFoundation("f-mv-src");
  await shippedFoundation("f-mv-dst");
  const moved = "src/f-mv-src/index.ts";
  await call("open_next", { node_id: "f-mv-src", change: "move" });
  await call("set_implementation_files", { node_id: "f-mv-src", change: "move", remove: [moved] });
  await call("open_next", { node_id: "f-mv-dst", change: "move" });
  await call("set_implementation_files", { node_id: "f-mv-dst", change: "move", add: [moved] });
  await call("open_next", { node_id: "f-mv-dst", change: "other" });
  await call("patch_node_territory", { node_id: "f-mv-dst", change: "other", section: "## Purpose", text: "Purpose from other." });
  await readyByTools("f-mv-dst", "other");
  for (const new_status of ["ready", "in-progress", "in-review"]) {
    await call("update_node_status", { node_id: "f-mv-dst", change: "other", new_status });
  }
  const shipped = await raw("update_node_status", { node_id: "f-mv-dst", change: "other", new_status: "ship" });
  const after = await call("get_node_context", { node_id: "f-mv-dst", change: "move" });
  const moveRev = (after.revisions ?? []).find((r) => r.change === "move");
  check(
    "shipping a sibling rebases a revision claiming a file its source's revision of that change releases with no claim conflict",
    !!moveRev && moveRev.conflicts === 0,
    JSON.stringify({ shipped: shipped.text, revisions: after.revisions })
  );

  await call("patch_node_territory", { node_id: "f-mv-dst", slot: "current", section: "## Purpose", text: "Purpose patched in place." });
  const rebased = await call("rebase_revision", { node_id: "f-mv-dst", change: "move" });
  check(
    "rebase_revision keeps a file the source's revision of the same change releases, with no claim conflict",
    rebased.rebased === true && Array.isArray(rebased.conflicts) && rebased.conflicts.length === 0,
    JSON.stringify(rebased)
  );
}

// --- a revision's claim is judged per change: a file the owner's revision of that change releases ---
{
  await shippedFoundation("f-ex-src");
  await shippedFoundation("f-ex-dst");
  await shippedFoundation("f-ex-third");
  const file = "src/f-ex-src/index.ts";
  await call("open_next", { node_id: "f-ex-src", change: "ex-mv" });
  await call("set_implementation_files", { node_id: "f-ex-src", change: "ex-mv", remove: [file] });
  // A second revision that keeps the file: the union of the source's revisions still claims it.
  await call("open_next", { node_id: "f-ex-src", change: "ex-keep" });
  await call("open_next", { node_id: "f-ex-dst", change: "ex-mv" });
  const took = await raw("set_implementation_files", { node_id: "f-ex-dst", change: "ex-mv", add: [file] });
  check(
    "a revision may claim a file the owner's revision of the same change releases, though another of its revisions keeps it",
    !took.error && JSON.parse(took.text).implements?.includes(file),
    took.text
  );
  await call("open_next", { node_id: "f-ex-third", change: "ex-mv" });
  const twice = await blocked("set_implementation_files", { node_id: "f-ex-third", change: "ex-mv", add: [file] });
  check(
    "two revisions of the same change claiming one file stay Blocked",
    !!twice && twice.includes("f-ex-dst") && twice.includes('"ex-mv"'),
    String(twice)
  );
  await call("open_next", { node_id: "f-ex-dst", change: "ex-other" });
  const live = await blocked("set_implementation_files", { node_id: "f-ex-dst", change: "ex-other", add: [file] });
  check(
    "under a change whose revisions keep the owner's live claim, the claim is Blocked naming the owner",
    !!live && live.includes("f-ex-src"),
    String(live)
  );
}

// --- a takeover: shipped alone before the revision that drops the file Blocked, in one change walk it ships ---
{
  // "f-ho-a" (the new member taking the file over) walks before "f-ho-n" (whose revision drops it).
  await shippedFoundation("f-ho-n");
  const file = "src/f-ho-n/index.ts";
  write("src/f-ho-n/keep.ts", "export const k = 1;\n");
  await call("set_implementation_files", { node_id: "f-ho-n", add: ["src/f-ho-n/keep.ts"] });
  await call("open_next", { node_id: "f-ho-n", change: "handover" });
  await call("set_implementation_files", { node_id: "f-ho-n", change: "handover", remove: [file] });
  await readyByTools("f-ho-n", "handover");
  await call("create_node", { id: "f-ho-a", type: "Foundation", title: "f-ho-a", description: "Infra — f-ho-a", role: "infra", change: "handover" });
  await call("set_implementation_files", { node_id: "f-ho-a", add: [file] });
  fillAndTick(abs("mindplan/foundations/f-ho-a/f-ho-a.mdx"));
  for (const new_status of ["ready", "in-progress", "in-review"]) await call("update_node_status", { node_id: "f-ho-a", new_status });
  const alone = await blocked("update_node_status", { node_id: "f-ho-a", new_status: "ship" });
  check(
    "a new member taking over a file ships alone only after the revision that drops it: Blocked naming that revision",
    !!alone && alone.includes('"f-ho-n", which claims it live') && alone.includes('"f-ho-n" revision "handover" drops it'),
    String(alone)
  );
  // The walk takes its own order (f-ho-a first by id): the ship gate judges f-ho-n by its claims after the walk.
  const walked = await raw("update_node_status", { scope: "change", change: "handover", new_status: "ship", skip_review: true });
  const owner = walked.error ? null : (await call("get_node_implementation", { path: file })).owner?.node_id;
  check(
    "a change walk ships a new member taking over a file with the revision that drops it",
    !walked.error && owner === "f-ho-a",
    walked.text
  );
}

// --- a file moving between two shipped nodes in one change: one change walk ships both ---
{
  // "f-hm-dst" (taking the file) walks before "f-hm-src" (dropping it).
  await shippedFoundation("f-hm-src");
  await shippedFoundation("f-hm-dst");
  const file = "src/f-hm-src/index.ts";
  write("src/f-hm-src/keep.ts", "export const k = 1;\n");
  await call("set_implementation_files", { node_id: "f-hm-src", add: ["src/f-hm-src/keep.ts"] });
  await call("open_next", { node_id: "f-hm-src", change: "hm" });
  await call("set_implementation_files", { node_id: "f-hm-src", change: "hm", remove: [file] });
  await call("open_next", { node_id: "f-hm-dst", change: "hm" });
  await call("set_implementation_files", { node_id: "f-hm-dst", change: "hm", add: [file] });
  for (const id of ["f-hm-src", "f-hm-dst"]) await readyByTools(id, "hm");
  // "f-hm-dst" walks first by id; its ship gate judges f-hm-src by its claims after the walk.
  const walked = await raw("update_node_status", { scope: "change", change: "hm", new_status: "ship", skip_review: true });
  const owner = walked.error ? null : (await call("get_node_implementation", { path: file })).owner?.node_id;
  check(
    "a change walk moving a file between two shipped nodes ships both, the destination owning it after",
    !walked.error && owner === "f-hm-dst",
    walked.text
  );
}

// --- a file moving onto the Foundation its source depends_on: one change walk ships it ---
{
  // f-mv-b depends_on f-mv-a, so f-mv-a (taking the file over) walks first.
  await shippedFoundation("f-mv-a");
  await shippedFoundation("f-mv-b");
  await call("link_nodes", { source_id: "f-mv-b", target_id: "f-mv-a", edge_type: "depends_on" });
  const file = "src/f-mv-b/index.ts";
  write("src/f-mv-b/keep.ts", "export const k = 1;\n");
  await call("set_implementation_files", { node_id: "f-mv-b", add: ["src/f-mv-b/keep.ts"] });
  await call("open_next", { node_id: "f-mv-b", change: "mv" });
  await call("set_implementation_files", { node_id: "f-mv-b", change: "mv", remove: [file] });
  await call("open_next", { node_id: "f-mv-a", change: "mv" });
  await call("set_implementation_files", { node_id: "f-mv-a", change: "mv", add: [file] });
  for (const id of ["f-mv-a", "f-mv-b"]) await readyByTools(id, "mv");
  await call("update_node_status", { scope: "change", change: "mv", new_status: "in-review" });
  const alone = await blocked("update_node_status", { node_id: "f-mv-a", change: "mv", new_status: "ship" });
  check(
    "the taker shipped alone before its source is Blocked on the source's live claim, pointing at the change walk",
    !!alone && alone.includes('"f-mv-b", which claims it live') && alone.includes('drops it: ship change "mv" in one walk'),
    String(alone)
  );
  const walked = await raw("update_node_status", { scope: "change", change: "mv", new_status: "ship" });
  const owner = walked.error ? null : (await call("get_node_implementation", { path: file })).owner?.node_id;
  check(
    "a change walk moves a file onto the Foundation its source depends_on, and only the taker claims it after",
    !walked.error && owner === "f-mv-a" && !read("mindplan/foundations/f-mv-b/f-mv-b.mdx").includes(file),
    walked.text
  );
}

// --- two revisions of one change swapping files: one change walk ships both ---
{
  await shippedFoundation("f-sw-a");
  await shippedFoundation("f-sw-b");
  const fa = "src/f-sw-a/index.ts";
  const fb = "src/f-sw-b/index.ts";
  await call("open_next", { node_id: "f-sw-a", change: "sw" });
  await call("open_next", { node_id: "f-sw-b", change: "sw" });
  await call("set_implementation_files", { node_id: "f-sw-a", change: "sw", remove: [fa] });
  await call("set_implementation_files", { node_id: "f-sw-b", change: "sw", remove: [fb] });
  await call("set_implementation_files", { node_id: "f-sw-a", change: "sw", add: [fb] });
  await call("set_implementation_files", { node_id: "f-sw-b", change: "sw", add: [fa] });
  for (const id of ["f-sw-a", "f-sw-b"]) await readyByTools(id, "sw");
  // skip_blocked counts only the nodes that walk: f-sw-b, left behind for review, keeps its live claim.
  for (const new_status of ["ready", "in-progress", "in-review"]) await call("update_node_status", { node_id: "f-sw-a", change: "sw", new_status });
  const partial = await raw("update_node_status", { scope: "change", change: "sw", new_status: "ship", skip_blocked: true, dry_run: true });
  const partialRes = partial.error ? {} : JSON.parse(partial.text);
  check(
    "a skip_blocked walk judges a member left behind by its live claims: the swap partner is blocked too",
    !partial.error && (partialRes.plan ?? []).length === 0 &&
      (partialRes.blocked ?? []).some((b) => b.node_id === "f-sw-a" && b.reason.includes('"f-sw-b", which claims it live')),
    partial.text
  );
  const both = await raw("update_node_status", { scope: "change", change: "sw", new_status: "ship", skip_blocked: true, skip_review: true, dry_run: true });
  const bothRes = both.error ? {} : JSON.parse(both.text);
  check(
    "a skip_blocked walk ships both revisions of a swap",
    !both.error && (bothRes.blocked ?? []).length === 0 && (bothRes.plan ?? []).some((l) => l.startsWith("f-sw-b:")),
    both.text
  );
  const walked = await raw("update_node_status", { scope: "change", change: "sw", new_status: "ship", skip_review: true });
  const owners = walked.error
    ? []
    : [(await call("get_node_implementation", { path: fa })).owner?.node_id, (await call("get_node_implementation", { path: fb })).owner?.node_id];
  check(
    "a change walk ships two revisions that swap files",
    !walked.error && owners[0] === "f-sw-b" && owners[1] === "f-sw-a",
    walked.text
  );
}

// --- node_and_dependents orders by each row's revision: a revision-added depends_on counts ---
{
  // "f-nd-a" sorts first by id; its revision's new depends_on f-nd-b must put f-nd-b first.
  await shippedFoundation("f-nd-a");
  await shippedFoundation("f-nd-b");
  await call("open_next", { node_id: "f-nd-b", change: "nd-b" });
  await call("open_next", { node_id: "f-nd-a", change: "nd-a" });
  await call("link_nodes", { source_id: "f-nd-a", target_id: "f-nd-b", edge_type: "depends_on", change: "nd-a" });
  await readyByTools("f-nd-a", "nd-a");
  await readyByTools("f-nd-b", "nd-b");
  const walked = await raw("update_node_status", { scope: "node_and_dependents", node_id: "f-nd-b", new_status: "ship", skip_review: true, dry_run: true });
  const order = walked.error ? [] : (JSON.parse(walked.text).plan ?? []).map((l) => l.split(":")[0]);
  check(
    "node_and_dependents moves the seed before a node whose open revision adds depends_on it",
    !walked.error && order.indexOf("f-nd-b") >= 0 && order.indexOf("f-nd-a") > order.indexOf("f-nd-b"),
    walked.text
  );
}

// --- needs_change_walk lists only revisions with a step left, and a walk that moves nothing says so ---
{
  await shippedFoundation("f-nm-two");
  for (const change of ["nm-a", "nm-b"]) {
    await call("open_next", { node_id: "f-nm-two", change });
    await readyByTools("f-nm-two", change);
    await call("update_node_status", { node_id: "f-nm-two", change, new_status: "ready" });
  }
  const atTarget = await raw("update_node_status", { scope: "node_and_dependents", node_id: "f-nm-two", new_status: "ready" });
  const atRes = atTarget.error ? {} : JSON.parse(atTarget.text);
  check(
    "a node whose revisions are all at the target is not listed in needs_change_walk",
    !atTarget.error && !atRes.needs_change_walk && !atRes.note,
    atTarget.text
  );
  const ahead = await raw("update_node_status", { scope: "node_and_dependents", node_id: "f-nm-two", new_status: "in-progress" });
  const aheadRes = ahead.error ? {} : JSON.parse(ahead.text);
  check(
    "a walk that moves nothing but leaves a node for change walks has empty lines and a note naming the changes",
    !ahead.error && (aheadRes.lines ?? []).length === 0 &&
      JSON.stringify(aheadRes.needs_change_walk?.[0]?.changes) === JSON.stringify(["nm-a", "nm-b"]) &&
      typeof aheadRes.note === "string" && aheadRes.note.includes('"nm-a"') && aheadRes.note.includes('"nm-b"') &&
      aheadRes.note.includes('scope: "change"'),
    ahead.text
  );
}

// --- scopes other than change leave a node with several open revisions in place and list it ---
{
  await shippedFoundation("f-nw-two");
  await shippedFoundation("f-nw-one");
  await call("link_nodes", { source_id: "f-nw-one", target_id: "f-nw-two", edge_type: "depends_on" });
  await call("open_next", { node_id: "f-nw-two", change: "nw-a" });
  await call("open_next", { node_id: "f-nw-two", change: "nw-b" });
  await call("open_next", { node_id: "f-nw-one", change: "nw-c" });
  const listed = (res) => (res.needs_change_walk ?? []).find((n) => n.node_id === "f-nw-two");
  const all = await raw("update_node_status", { scope: "all_open_updates", new_status: "ready", dry_run: true });
  const allRes = all.error ? {} : JSON.parse(all.text);
  check(
    "all_open_updates walks the others and lists a node with several open revisions in needs_change_walk",
    !all.error && JSON.stringify(listed(allRes)?.changes) === JSON.stringify(["nw-a", "nw-b"]) &&
      (allRes.plan ?? []).includes("f-nw-one: draft -> ready") && !(allRes.plan ?? []).some((l) => l.startsWith("f-nw-two:")),
    all.text
  );
  const deps = await raw("update_node_status", { scope: "node_and_dependents", node_id: "f-nw-two", new_status: "ready" });
  const depsRes = deps.error ? {} : JSON.parse(deps.text);
  check(
    "node_and_dependents moves the dependent and leaves the seed with two revisions in place, listed",
    !deps.error && !!listed(depsRes) && (depsRes.lines ?? []).some((l) => l.startsWith("f-nw-one:")) &&
      read("mindplan/foundations/f-nw-two/revisions/nw-a/f-nw-two.mdx").match(/^state: draft$/m) !== null,
    deps.text
  );
}

await client.close();
fs.rmSync(root, { recursive: true, force: true });
if (failures > 0) {
  console.log(`rebase-flow.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("rebase-flow.test.mjs: all ok");
