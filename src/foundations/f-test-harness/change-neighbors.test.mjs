/**
 * Change ids on shipped nodes: only a revision carries one. A shipped node with no open next is
 * edited in place: change (or change_ref) on patch_node_territory, set_implementation_files, and
 * set_test_files is Blocked and writes nothing, while the same writes without change pass.
 * record_decision tags its decision only. A decision-only change has no members for the check,
 * the graph filter, or a scoped walk, and orient_for_work({ change }) lists its decision holders.
 * In a git sandbox the plain check gives a shipped node whose claimed file changed against main
 * the full stale-text pass. With several open revisions on one node, the read surfaces (orient,
 * get_node_context, run_check, the merge gate, the graph filter, search, blast radius) see each
 * revision under its change, and exclusivity is judged per change. Every write is diffed against the sandbox on disk: each mindplan/ file
 * it created, changed, or deleted must be in its changed_files.
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
import { SHIP, fillAndTick as fillScaffold } from "./ship-fixture.mjs";
// Spawned servers rank by keyword only: no model download or load during tests.
process.env.MINDPLAN_SEARCH ??= "keyword";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-neighbors-"));
console.log("Change-ids sandbox:", root);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, MINDPLAN_ROOT: root },
});
const client = new Client({ name: "change-neighbors-test", version: "0.1.0" });
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

/** The derived Mermaid snapshot: rewritten after every write, never listed in changed_files. */
const MAP = "mindplan/map.md";

/** Paths created, changed, or deleted between two snapshots (map.md excepted). */
function touched(before, after) {
  const out = [];
  for (const [rel, text] of after) if (rel !== MAP && before.get(rel) !== text) out.push(rel);
  for (const rel of before.keys()) if (rel !== MAP && !after.has(rel)) out.push(rel);
  return out;
}

let diffedWrites = 0;
let diffMisses = 0;

async function raw(tool, args) {
  const before = snapshot();
  const res = await client.callTool({ name: tool, arguments: tool === "run_check" ? { compact: false, ...args } : args });
  const text = res.content?.[0]?.text ?? "";
  if (!res.isError) {
    const result = JSON.parse(text || "{}");
    if (Array.isArray(result.changed_files)) {
      diffedWrites++;
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
  }
  return { error: !!res.isError, text };
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

const nextOf = (kind, id) => `mindplan/${kind}/${id}/${id}.next.mdx`;
const liveOf = (kind, id) => `mindplan/${kind}/${id}/${id}.mdx`;
const readRel = (rel) => fs.readFileSync(path.join(root, ...rel.split("/")), "utf-8");

/** True when a shipped node with no open revision has no `<id>.next.mdx` beside its live file. */
function noNextFile(kind, id) {
  return fs.existsSync(path.join(root, ...liveOf(kind, id).split("/"))) && !fs.existsSync(path.join(root, ...nextOf(kind, id).split("/")));
}

/** True when a live write's changed_files lists the live file and no next file. */
function liveOnly(changed, kind, id) {
  return Array.isArray(changed) && changed.includes(liveOf(kind, id)) && !changed.includes(nextOf(kind, id));
}

/** The live `change` of a node, read from its record. */
async function changeOf(id) {
  return (await call("get_node_context", { node_id: id })).record.change;
}

/** Fill create_node scaffold stubs with real text and tick every checkbox (before first ship). */
function fillAndTick(kind, id) {
  fillScaffold(path.join(root, "mindplan", kind, id, `${id}.mdx`), "Change-ids test filled territory.");
}

function write(rel, content) {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

async function walk(id, steps) {
  let last;
  for (const new_status of steps) last = await call("update_node_status", { node_id: id, new_status });
  return last;
}

/** A pre-ship Interaction in a change: claimed, filled, and linked so it can ship. */
async function newRevision(id, change) {
  await call("create_node", { id, type: "Interaction", title: id, description: `Action ${id}`, change });
  await call("link_nodes", { source_id: id, target_id: "j-app", edge_type: "belongs_to" });
  await call("link_nodes", { source_id: id, target_id: "f-core", edge_type: "depends_on" });
  write(`src/${id}/x.ts`, 'import { core } from "../f-core/index.js";\nexport const x = core;\n');
  await call("set_implementation_files", { replace: true, node_id: id, files: [`src/${id}/x.ts`] });
  fillAndTick("interactions", id);
}

/** git in the sandbox, with its own identity and no commit signing. */
function git(...args) {
  const r = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    cwd: root,
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** Push a file's mtime into the future, so it is newer than its owner's territory file. */
function touchAhead(rel) {
  const when = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(root, ...rel.split("/")), when, when);
}

const IN_PLACE = "is shipped with no open revision: edit its files in place; it needs no change id (open_next if its contract changes).";

fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
fs.writeFileSync(
  path.join(root, "mindplan", "config.json"),
  JSON.stringify({ sources: ["src/**"], exclude: [] }, null, 2) + "\n"
);

// --- base graph: shipped Foundations and Interactions, committed on main ---
await call("create_node", { id: "j-app", type: "Capability", title: "App", description: "App area" });
await call("create_node", { id: "f-core", type: "Foundation", title: "Core", description: "Infra — core", role: "infra" });
await call("create_node", { id: "f-util", type: "Foundation", title: "Util", description: "Infra — util", role: "infra" });
await call("create_node", { id: "i-a", type: "Interaction", title: "A", description: "Action A" });
await call("create_node", { id: "i-b", type: "Interaction", title: "B", description: "Action B" });
for (const id of ["i-a", "i-b"]) {
  await call("link_nodes", { source_id: id, target_id: "j-app", edge_type: "belongs_to" });
  await call("link_nodes", { source_id: id, target_id: "f-core", edge_type: "depends_on" });
}
write("src/f-core/index.ts", "export const core = 1;\n");
write("src/f-util/index.ts", "export const util = 1;\n");
write("src/i-a/a.ts", 'import { core } from "../f-core/index.js";\nexport const a = core;\n');
write("src/i-b/b.ts", 'import { core } from "../f-core/index.js";\nexport const b = core;\n');
await call("set_implementation_files", { replace: true, node_id: "f-core", files: ["src/f-core/index.ts"] });
await call("set_implementation_files", { replace: true, node_id: "f-util", files: ["src/f-util/index.ts"] });
await call("set_implementation_files", { replace: true, node_id: "i-a", files: ["src/i-a/a.ts"] });
await call("set_implementation_files", { replace: true, node_id: "i-b", files: ["src/i-b/b.ts"] });
for (const [kind, id] of [
  ["foundations", "f-core"],
  ["foundations", "f-util"],
  ["interactions", "i-a"],
  ["interactions", "i-b"],
]) {
  fillAndTick(kind, id);
}
for (const id of ["f-core", "f-util", "i-a", "i-b"]) await walk(id, SHIP);
check(
  "shipped nodes start with no next file and no change id",
  ["f-core", "f-util"].every((id) => noNextFile("foundations", id)) &&
    ["i-a", "i-b"].every((id) => noNextFile("interactions", id)) &&
    (await changeOf("f-util")) === undefined
);
git("init", "-q", "-b", "main");
git("add", "-A");
git("commit", "-q", "-m", "base");
git("switch", "-q", "-c", "feature");

// --- change on a shipped node with no open next is Blocked and writes nothing ---
{
  const liveBefore = readRel(liveOf("foundations", "f-util"));
  for (const [tool, args] of [
    ["patch_node_territory", { node_id: "f-util", change: "feat" }],
    ["patch_node_territory", { node_id: "f-util", change: "" }],
    ["patch_node_territory", { node_id: "f-util", change_ref: "feat/x" }],
    ["patch_node_territory", { node_id: "f-util", replace: { find: "Change-ids test", with: "Edited" }, change: "feat" }],
    ["set_implementation_files", { replace: true, node_id: "f-util", files: ["src/f-util/index.ts"], change: "feat" }],
    ["set_implementation_files", { replace: true, node_id: "f-util", files: ["src/f-util/index.ts"], change: "" }],
    ["set_test_files", { replace: true, node_id: "f-util", files: ["tests/util.test.mjs"], change: "feat" }],
  ]) {
    const text = await blocked(tool, args);
    check(
      `${tool} ${JSON.stringify(args)} on a shipped node with no open next is Blocked naming in-place edits`,
      text?.includes(`"f-util" ${IN_PLACE}`),
      String(text)
    );
  }
  check(
    "the Blocked writes left the live file untouched and opened no revision",
    readRel(liveOf("foundations", "f-util")) === liveBefore && noNextFile("foundations", "f-util")
  );

  const tested = await call("set_test_files", { replace: true, node_id: "f-util", files: ["tests/util.test.mjs"] });
  const claimed = await call("set_implementation_files", { replace: true, node_id: "f-util", files: ["src/f-util/index.ts"] });
  check(
    "the same writes without change pass in place, with no label fields",
    liveOnly(tested.changed_files, "foundations", "f-util") &&
      [tested, claimed].every((r) => !("neighbor_of" in r) && !("replaced_change" in r)) &&
      (await changeOf("f-util")) === undefined,
    `${JSON.stringify(tested)} | ${JSON.stringify(claimed)}`
  );
  await call("set_test_files", { replace: true, node_id: "f-util", files: [] });
}

// --- a revision carries the change id; the live file never does ---
{
  await newRevision("i-new", "feat");
  const opened = await call("open_next", { reason: "behavior", node_id: "i-b", change: "feat" });
  check(
    "open_next writes the change to the revision only, with no replaced_change",
    !("replaced_change" in opened) &&
      opened.revision.change === "feat" &&
      opened.changed_files.includes("mindplan/interactions/i-b/revisions/feat/i-b.mdx") &&
      !/^change:/m.test(readRel(liveOf("interactions", "i-b"))),
    JSON.stringify(opened)
  );
  const moved = await blocked("patch_node_territory", { node_id: "i-b", change: "feat2" });
  check(
    "a revision's change is its folder: moving it is Blocked and names discard and open_next",
    !!moved && moved.includes("open_next"),
    String(moved)
  );
  const report = await call("run_check", { change: "feat" });
  const kinds = Object.fromEntries((report.change?.members ?? []).map((m) => [m.id, m.kind]));
  check(
    "run_check with change lists only revisions",
    report.ok && kinds["i-new"] === "revision" && kinds["i-b"] === "revision" && Object.keys(kinds).length === 2,
    JSON.stringify(report.change)
  );
  const radius = await call("get_blast_radius", { change: "feat" });
  check(
    "the change radius lists revisions, and its additivity names no neighbors",
    radius.members.every((m) => m.kind === "revision") && !("neighbors" in radius.additivity) && !/neighbor/.test(radius.additivity.summary),
    JSON.stringify(radius.additivity)
  );
}

// --- record_decision tags the decision only ---
{
  const onRevision = await call("record_decision", {
    node_id: "i-b",
    decision: "B reads core in place.",
    alternatives: ["Copy core into B (drifts)"],
    why: "One source of truth.",
  });
  check(
    "record_decision without change on a revision records under the revision's change",
    onRevision.decision.change === "feat",
    JSON.stringify(onRevision)
  );
  const untagged = await call("record_decision", {
    node_id: "f-util",
    decision: "Util stays one module.",
    alternatives: ["Split util (no second reason to change)"],
    why: "It changes for one reason.",
  });
  check(
    "record_decision without change on a shipped node with no open next records no change",
    untagged.decision.change === undefined && (await changeOf("f-util")) === undefined,
    JSON.stringify(untagged)
  );
  const tagged = await call("record_decision", {
    node_id: "i-a",
    decision: "A keeps its own copy of the label text.",
    alternatives: ["Read it from core (one more import)"],
    why: "It is one string.",
    change: "feat",
  });
  check(
    "record_decision with change on a shipped node tags the decision and writes no change id on the node",
    tagged.decision.change === "feat" &&
      !("neighbor_of" in tagged) &&
      JSON.stringify(tagged.changed_files) === JSON.stringify([`mindplan/interactions/i-a/decisions/${tagged.decision.id}.md`]) &&
      (await changeOf("i-a")) === undefined &&
      !(await call("run_check", { change: "feat" })).change.members.some((m) => m.id === "i-a"),
    JSON.stringify(tagged)
  );
  const oriented = await call("orient_for_work", { change: "feat" });
  const kinds = Object.fromEntries(oriented.members.map((m) => [m.id, m.kind]));
  check(
    "orient_for_work({ change }) keeps a revision that holds the change's decision a revision and lists a shipped holder as a decision member",
    kinds["i-b"] === "revision" && kinds["i-a"] === "decision" && oriented.members.filter((m) => m.id === "i-b").length === 1,
    JSON.stringify(oriented.members)
  );
}

// --- the change ships: no label fields, the shipped nodes carry no change id ---
{
  await call("patch_node_territory", { node_id: "i-b", toggle_checkboxes: [{ id: "spec", checked: true }, { id: "impl", checked: true }, { id: "verify", checked: true }] });
  const walked = await call("update_node_status", { scope: "change", change: "feat", new_status: "ship", skip_review: true });
  check(
    "a change walked to ship reports no cleared_neighbors and leaves no change id on its nodes",
    !("cleared_neighbors" in walked) && (await changeOf("i-b")) === undefined && (await changeOf("i-new")) === undefined,
    JSON.stringify(walked)
  );
  const empty = await blocked("update_node_status", { scope: "change", change: "feat", new_status: "ship" });
  check("a scoped walk over a change with no open revision is Blocked", empty?.includes("has no members"), String(empty));
}

// --- a decision-only change has no members, but orients on its decision holders ---
{
  for (const id of ["i-a", "f-core"]) {
    await call("record_decision", {
      node_id: id,
      decision: `${id} stays whole.`,
      alternatives: ["Split it (no second reason to change)"],
      why: "It changes for one reason.",
      keep_whole: true,
      change: "hotspot-triage",
    });
  }
  const graph = await call("get_mindplan_graph", { change: "hotspot-triage", edges: false });
  const checked = await call("run_check", { change: "hotspot-triage" });
  check(
    "the decision-only change has no graph members and its change check is Blocked with no members",
    graph.total_nodes === 0 && checked.failures.some((f) => f.includes('change "hotspot-triage" has no members')),
    `${JSON.stringify(graph)} | ${JSON.stringify(checked.failures)}`
  );
  const oriented = await call("orient_for_work", { change: "hotspot-triage" });
  check(
    "orient_for_work on the decision-only change lists its decision holders with kind decision",
    oriented.members.map((m) => `${m.id}:${m.kind}`).sort().join() === "f-core:decision,i-a:decision" &&
      oriented.decisions.nodes.slice().sort().join() === "f-core,i-a",
    JSON.stringify(oriented)
  );
}

// --- the plain check gives a shipped node edited in place the full stale-text pass ---
{
  git("add", "-A");
  git("commit", "-q", "-m", "plan");
  // Both claimed files end up newer than their territory files; only f-util's changed against main.
  write("src/f-util/index.ts", "export const util = 2;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "edit util in place");
  touchAhead("src/f-util/index.ts");
  touchAhead("src/f-core/index.ts");
  const stale = (warnings, id) => warnings.some((w) => w.startsWith(`stale: 1 claimed file(s) of "${id}" changed after its body`));
  const ran = await call("run_check", {});
  check(
    "a shipped node whose claimed file changed against main gets the changed-file stale warning; an untouched one does not",
    ran.ok && stale(ran.warnings, "f-util") && !stale(ran.warnings, "f-core"),
    JSON.stringify(ran.warnings)
  );
  fs.rmSync(path.join(root, ".git"), { recursive: true, force: true });
  const noGit = await call("run_check", {});
  check(
    "without git the check falls back to the path signals and reports nothing about git",
    noGit.ok && !stale(noGit.warnings, "f-util") && !/git/i.test(noGit.output),
    JSON.stringify(noGit.warnings)
  );
}

// --- several open revisions per node: the read surfaces see each one ---
{
  // Revision folders are written in-process (open_next still writes the legacy next file).
  // No in-process graph cache: its open database would keep the sandbox from being removed.
  process.env.MINDPLAN_ROOT = root;
  process.env.MINDPLAN_GRAPH_CACHE = "off";
  const store = await import("../../../dist/foundations/f-territory-store/store.js");
  const revs = await import("../../../dist/foundations/f-territory-store/revisions.js");
  const nodeOf = (id) => store.loadGraph().nodes.find((n) => n.id === id);
  revs.openRevision(nodeOf("f-util"), "rev-a", {});
  revs.openRevision(nodeOf("f-util"), "rev-b", { title: "Util reshaped", description: "Infra — util with a backoff policy" });
  revs.writeRevisionBody(nodeOf("f-util"), "rev-b", "## Spec\n\nUtil retries.\n\n## Backoff schedule\n\nThree tries.\n");
  revs.openRevision(nodeOf("i-a"), "rev-a", {});
  revs.writeRevisionState(nodeOf("i-a"), "rev-a", "in-review");
  const file = revs.revisionFilePath({ id: "f-util", type: "Foundation" }, "rev-b");
  const parsed = revs.parseRevisionFile(fs.readFileSync(file, "utf-8"), "f-util");
  parsed.revision.conflicts = [{ kind: "section", section: "## Spec" }];
  fs.writeFileSync(file, revs.formatRevisionFile("f-util", "Foundation", parsed.revision, parsed.body));

  const lean = (list) => (list ?? []).map((r) => `${r.change}:${r.state}:${r.title ?? ""}:${r.conflicts}`).join();
  const oriented = await call("orient_for_work", { node_id: "f-util" });
  check(
    "orient_for_work on a node with two revisions lists both, reads live, and says to pass change",
    lean(oriented.revisions) === "rev-a:draft::0,rev-b:draft:Util reshaped:1" &&
      oriented.context.next === "pass change to read a revision" &&
      oriented.next === "pass change to read a revision" &&
      !oriented.context.body.includes("Three tries") &&
      !("unlocks" in oriented),
    JSON.stringify({ revisions: oriented.revisions, next: oriented.context.next })
  );
  const onRev = await call("orient_for_work", { node_id: "f-util", change: "rev-b" });
  check(
    "orient_for_work with change returns that revision as the active slot and unlocks it",
    onRev.unlocks === "rev-b" &&
      onRev.context.next?.record?.title === "Util reshaped" &&
      onRev.context.next?.body?.includes("Three tries") &&
      lean(onRev.revisions) === lean(oriented.revisions),
    JSON.stringify({ unlocks: onRev.unlocks, next: onRev.context.next })
  );
  const ctx = await call("get_node_context", { node_id: "f-util", change: "rev-b" });
  check(
    "get_node_context with change returns the revision body and unlocks the change",
    ctx.unlocks === "rev-b" && ctx.next?.body?.includes("Three tries") && ctx.body.includes("Change-ids test"),
    JSON.stringify({ unlocks: ctx.unlocks, next: ctx.next })
  );
  const noRev = await blocked("get_node_context", { node_id: "f-util", change: "rev-z" });
  check("get_node_context with a change the node has no revision of is Blocked", noRev?.includes('"rev-z"'), String(noRev));
  const both = await blocked("get_node_context", { node_id: "f-util", slot: "next" });
  check("slot next with two revisions and no change is Blocked naming them", both?.includes("pass change"), String(both));

  const forChange = await call("orient_for_work", { change: "rev-a" });
  check(
    "orient_for_work({ change }) lists each node's revision of that change",
    forChange.members.map((m) => `${m.id}:${m.kind}:${m.change}`).sort().join() === "f-util:revision:rev-a,i-a:revision:rev-a",
    JSON.stringify(forChange.members)
  );
  const checkA = await call("run_check", { change: "rev-a" });
  check(
    "run_check({ change }) lists only that change's revisions",
    (checkA.change?.members ?? []).map((m) => `${m.id}:${m.kind}`).sort().join() === "f-util:revision,i-a:revision",
    JSON.stringify(checkA.change)
  );
  check(
    "run_check warns once per revision with unresolved conflicts",
    checkA.warnings.includes(
      'conflicts: "f-util" revision "rev-b" has 1 unresolved rebase conflict(s); resolve_conflict before in-review.'
    ),
    JSON.stringify(checkA.warnings)
  );
  const merge = await call("run_check", { merge: true });
  const gated = merge.merge?.changes?.find((g) => g.change === "rev-a")?.nodes ?? [];
  check(
    "the merge gate Blocks a revision in review, naming its change",
    !merge.ok && gated.some((n) => n.id === "i-a" && n.slot === "revision" && n.state === "in-review") &&
      merge.failures.some((f) => f.startsWith("Blocked: Merge:") && f.includes('"i-a"') && f.includes('change "rev-a"')),
    JSON.stringify(merge.merge)
  );
  const page = await call("get_mindplan_graph", { change: "rev-b", fields: ["open_revisions"], edges: false });
  check(
    "get_mindplan_graph's change filter finds a node by any of its revisions; open_revisions is lean",
    page.nodes.map((n) => n.id).join() === "f-util" &&
      JSON.stringify(page.nodes[0].open_revisions) === JSON.stringify([{ change: "rev-a", state: "draft" }, { change: "rev-b", state: "draft" }]),
    JSON.stringify(page.nodes)
  );
  const titled = await call("get_mindplan_graph", { change: "rev-b", fields: ["title", "next"], edges: false });
  const titledNode = titled.nodes[0] ?? {};
  check(
    "a title/next projection of a node with several revisions gives live values plus its open_revisions",
    titledNode.title !== undefined &&
      !("next" in titledNode) &&
      JSON.stringify(titledNode.open_revisions) === JSON.stringify([{ change: "rev-a", state: "draft" }, { change: "rev-b", state: "draft" }]),
    JSON.stringify(titled.nodes)
  );
  const found = await call("orient_for_work", { query: "backoff schedule" });
  check(
    "search finds a node by a revision's new wording",
    found.matches.some((m) => m.id === "f-util"),
    JSON.stringify(found.matches)
  );
  const radius = await call("get_blast_radius", { node_id: "f-util", change: "rev-b" });
  const changeRadius = await call("get_blast_radius", { change: "rev-a" });
  check(
    "get_blast_radius lists the node's open revisions and takes change with node_id; a change radius lists its revisions",
    JSON.stringify(radius.open_revisions) === JSON.stringify([{ change: "rev-a", state: "draft" }, { change: "rev-b", state: "draft" }]) &&
      changeRadius.members.map((m) => `${m.id}:${m.kind}`).sort().join() === "f-util:revision,i-a:revision",
    JSON.stringify({ radius: radius.open_revisions, members: changeRadius.members })
  );
  write("src/shared/x.ts", "export const x = 1;\n");
  write("src/shared/y.ts", "export const y = 1;\n");
  revs.writeRevisionDelta(nodeOf("f-util"), "rev-b", "implements", { add: ["src/shared/x.ts"], remove: [] });
  revs.writeRevisionDelta(nodeOf("i-a"), "rev-a", "implements", { add: ["src/shared/x.ts", "src/shared/y.ts"], remove: [] });
  revs.writeRevisionDelta(nodeOf("f-util"), "rev-a", "implements", { add: ["src/shared/y.ts"], remove: [] });
  const claims = await call("run_check", {});
  check(
    "exclusivity is per change: two changes claiming one file warn, one change claiming it twice fails",
    claims.warnings.some((w) => w.startsWith('ownership: "src/shared/x.ts" is claimed by "f-util" (revision "rev-b") and "i-a" (revision "rev-a")')) &&
      claims.failures.includes(
        'Blocked: exclusivity: "src/shared/y.ts" claimed by multiple nodes under change "rev-a": "f-util", "i-a".'
      ) &&
      !claims.failures.some((f) => f.includes('exclusivity: "src/shared/x.ts"')),
    JSON.stringify({ failures: claims.failures, warnings: claims.warnings.filter((w) => w.startsWith("ownership")) })
  );
  fs.rmSync(path.join(root, "src", "shared"), { recursive: true, force: true });
  for (const [id, change] of [
    ["f-util", "rev-a"],
    ["f-util", "rev-b"],
    ["i-a", "rev-a"],
  ]) {
    revs.discardRevision(nodeOf(id), change);
  }
}

check(`each of ${diffedWrites} writes listed every mindplan/ file it touched`, diffMisses === 0, `${diffMisses} write(s) missed files`);

await client.close();
fs.rmSync(root, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\nchange-neighbors.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nchange-neighbors.test.mjs: all ok");
