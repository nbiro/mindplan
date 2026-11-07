/**
 * Planned wiring and attribution (npm test). A shipped node gains planned edges under a change
 * without opening a revision: link_nodes with change checks and records them, run_check and the
 * change blast radius list them, open_next applies them, ship makes them live, and a change that
 * closes drops the rest. A revision attributes the migration it adds in another node's folder, so
 * the decision gate and the blast radius count it.
 */
// Fixtures build graphs without a version stamp; the gate has its own suite (version.test.mjs).
process.env.MINDPLAN_VERSION_GATE ??= "off";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
process.env.MINDPLAN_SEARCH ??= "keyword";
// This suite is about planned wiring, not orientation.
process.env.MINDPLAN_ORIENT_GATE = "off";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-planned-"));
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
write("mindplan/config.json", JSON.stringify({ sources: ["src/**"], exclude: [] }) + "\n");
write("src/db/db.ts", "export const db = 1;\n");
write("src/root/index.ts", "export const root = 1;\n");
write("src/root/migrations/0001.ts", "export const m1 = 1;\n");
write("src/dash/page.ts", "export const page = 1;\n");
write("src/old/old.ts", "export const old = 1;\n");
write("src/new/new.ts", "export const fresh = 1;\n");

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`ok   ${label}`);
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, MINDPLAN_ROOT: root },
  stderr: "pipe",
});
const client = new Client({ name: "planned-wiring-test", version: "0.1.0" });
await client.connect(transport);
// A session reads the project rules first (writes are Blocked: Rules until then), as an agent does.
await client.callTool({ name: "get_project", arguments: {} });
const raw = async (tool, args) => {
  const res = await client.callTool({ name: tool, arguments: tool === "run_check" ? { compact: false, ...args } : args });
  return { error: !!res.isError, text: res.content?.[0]?.text ?? "" };
};
const call = async (tool, args) => {
  const r = await raw(tool, args);
  if (r.error) throw new Error(`${tool}: ${r.text}`);
  return JSON.parse(r.text);
};
const live = (rel) => fs.readFileSync(path.join(root, rel), "utf-8");
/**
 * The open evolution file of `<dir>/<id>` for `change`: the revision file
 * (`revisions/<change>/<id>.mdx`) when one exists, else a legacy `<id>.next.mdx`.
 */
const openSlot = (dir, id, change) => {
  const revision = `${dir}/${id}/revisions/${change}/${id}.mdx`;
  return fs.existsSync(path.join(root, revision)) ? live(revision) : live(`${dir}/${id}/${id}.next.mdx`);
};
/** True when a slot's text lists `target` under `type` (a full list, or a revision's `<type>_add` delta). */
const listsEdge = (text, type, target) =>
  new RegExp(`(?:^|\\n)${type}(?:_add)?:\\r?\\n(\\s+- .*\\r?\\n)*\\s+- ${target}(?:\\r?\\n|$)`).test(text);

const SECTIONS = {
  Foundation: ["## Purpose", "## Shared Substrate Spec", "## Acceptance Criteria"],
  Interaction: ["## Purpose", "## Actor & Trigger", "## PRD / Execution Logic", "## Acceptance Criteria"],
  Interface: ["## Purpose", "## Kind", "## Spec", "## Acceptance Criteria"],
};
/** Write real text into every required section and tick every Atomic Op. */
async function complete(id, type) {
  for (const heading of SECTIONS[type]) {
    await call("patch_node_territory", { node_id: id, section: heading, text: `Real ${heading.slice(3).toLowerCase()} for ${id}.` });
  }
  await call("patch_node_territory", { node_id: id, toggle_checkboxes: [{ id: "spec", checked: true }, { id: "impl", checked: true }, { id: "verify", checked: true }] });
}

// --- a shipped base: a Capability, two Foundations, an Interaction, and the Interface exposing it ---
await call("create_node", { id: "j-site", type: "Capability", title: "Site", description: "Visitors use the site." });
await call("create_node", { id: "f-db", type: "Foundation", title: "Database", description: "Adapter — database access", role: "adapter", change: "base" });
await call("create_node", { id: "f-root", type: "Foundation", title: "Root", description: "Assembler — composition root with the migrations folder", role: "assembler", change: "base" });
await call("create_node", { id: "i-old", type: "Interaction", title: "Read a page", description: "Visitor reads a page.", change: "base" });
await call("create_node", { id: "if-dash", type: "Interface", title: "Dashboard", description: "Dashboard entry point for staff.", change: "base" });
await call("set_implementation_files", { replace: true, node_id: "f-db", files: ["src/db/"] });
await call("set_implementation_files", { replace: true, node_id: "f-root", files: ["src/root/"] });
await call("set_implementation_files", { replace: true, node_id: "i-old", files: ["src/old/"] });
await call("set_implementation_files", { replace: true, node_id: "if-dash", files: ["src/dash/"] });
await call("link_nodes", { source_id: "f-root", target_id: "f-db", edge_type: "depends_on" });
await call("link_nodes", { source_id: "i-old", target_id: "j-site", edge_type: "belongs_to" });
await call("link_nodes", { source_id: "i-old", target_id: "f-db", edge_type: "depends_on" });
await call("link_nodes", { source_id: "if-dash", target_id: "i-old", edge_type: "exposes" });
for (const [id, type] of [["f-db", "Foundation"], ["f-root", "Foundation"], ["i-old", "Interaction"], ["if-dash", "Interface"]]) {
  await complete(id, type);
}
await call("record_decision", {
  node_id: "f-root",
  decision: "Migrations live in the root's single folder.",
  alternatives: ["One folder per schema node (the framework has one migrationDir)"],
  why: "The framework reads one migrations folder.",
  change: "base",
});
const base = await raw("update_node_status", { scope: "change", change: "base", new_status: "ship", skip_review: true });
check("the base ships", !base.error, base.text);

// --- planned edges ---
await call("create_node", { id: "i-new", type: "Interaction", title: "Edit a page", description: "Staff edits a page.", change: "feat" });
await call("set_implementation_files", { replace: true, node_id: "i-new", files: ["src/new/"] });
await call("link_nodes", { source_id: "i-new", target_id: "j-site", edge_type: "belongs_to" });
await call("link_nodes", { source_id: "i-new", target_id: "f-db", edge_type: "depends_on" });

const planned = await call("link_nodes", { source_id: "if-dash", target_id: "i-new", edge_type: "exposes", change: "feat" });
check(
  "link_nodes with change on a shipped Interface plans the edge",
  planned.planned?.type === "exposes" && planned.planned?.change === "feat" && planned.changed_files?.includes("mindplan/interfaces/if-dash/if-dash.mdx"),
  JSON.stringify(planned)
);
const dashLive = live("mindplan/interfaces/if-dash/if-dash.mdx");
check(
  "the live exposes list is unchanged and the entry sits under planned:",
  /planned:\r?\n\s+- feat exposes i-new/.test(dashLive) && !/exposes:\r?\n(\s+- .*\r?\n)*\s+- i-new/.test(dashLive),
  dashLive.split("---")[1]
);
const graph = await call("get_mindplan_graph", {});
check("a planned edge is not a graph edge", !graph.edges.some((e) => e.source === "if-dash" && e.target === "i-new"));
check(
  "the node record carries planned",
  graph.nodes.find((n) => n.id === "if-dash")?.planned?.some((e) => e.target === "i-new"),
  JSON.stringify(graph.nodes.find((n) => n.id === "if-dash"))
);

const dup = await raw("link_nodes", { source_id: "if-dash", target_id: "i-new", edge_type: "exposes", change: "feat" });
check("planning the same edge twice is Blocked", dup.error && dup.text.includes("already planned"), dup.text);
const shape = await raw("link_nodes", { source_id: "f-db", target_id: "i-new", edge_type: "exposes", change: "feat" });
check("a planned edge with an illegal shape is Blocked", shape.error && shape.text.includes("exposes edges must go Interface -> Interaction"), shape.text);
const cycle = await raw("link_nodes", { source_id: "f-db", target_id: "f-root", edge_type: "depends_on", change: "feat" });
check("a planned depends_on that closes a cycle is Blocked", cycle.error && cycle.text.includes("cycle"), cycle.text);

await call("create_node", { id: "i-gone", type: "Interaction", title: "Old flow", description: "Visitor uses an old flow.", change: "gone" });
await call("link_nodes", { source_id: "if-dash", target_id: "i-gone", edge_type: "exposes", change: "feat" });
await call("link_nodes", { source_id: "i-old", target_id: "i-new", edge_type: "leads_to", change: "feat" });
await call("update_node_status", { node_id: "i-gone", new_status: "cancelled" });

const featCheck = await call("run_check", { change: "feat" });
check(
  "run_check({ change }) lists a planned source as a planned member",
  featCheck.change.members.some((m) => m.id === "if-dash" && m.kind === "planned"),
  JSON.stringify(featCheck.change.members)
);
check(
  "run_check({ change }) notes the planned edges as info",
  featCheck.info.some((l) => l.startsWith('planned edges: "if-dash" plans exposes i-gone, exposes i-new')),
  JSON.stringify(featCheck.info)
);
check(
  "a planned edge whose target was cancelled fails the change check",
  !featCheck.ok && featCheck.failures.some((f) => f.includes("planned edge if-dash -exposes-> i-gone") && f.includes("cancelled")),
  JSON.stringify(featCheck.failures)
);
const radius = await call("get_blast_radius", { change: "feat" });
check(
  "the change blast radius lists planned_edges and the planned member",
  radius.planned_edges.some((e) => e.source === "if-dash" && e.target === "i-new") &&
    radius.members.some((m) => m.id === "if-dash" && m.kind === "planned"),
  JSON.stringify({ planned_edges: radius.planned_edges, members: radius.members })
);

const unplanned = await call("unlink_nodes", { source_id: "if-dash", target_id: "i-gone", change: "feat" });
check("unlink_nodes with change removes the planned edge", unplanned.unplanned?.length === 1, JSON.stringify(unplanned));
const noneLeft = await raw("unlink_nodes", { source_id: "if-dash", target_id: "i-gone", change: "feat" });
check("unlinking a planned edge that is not there is Blocked", noneLeft.error, noneLeft.text);
check("the change check passes once the bad planned edge is gone", (await call("run_check", { change: "feat" })).ok);

await call("create_node", { id: "i-gone2", type: "Interaction", title: "Older flow", description: "Visitor uses an older flow.", change: "gone2" });
await call("link_nodes", { source_id: "if-dash", target_id: "i-gone2", edge_type: "exposes", change: "feat" });
await call("update_node_status", { node_id: "i-gone2", new_status: "cancelled" });
const stale = await raw("open_next", { node_id: "if-dash", change: "feat" });
check(
  "open_next is Blocked while a planned edge it would apply is no longer legal",
  stale.error && stale.text.includes("i-gone2") && stale.text.includes("unlink_nodes"),
  stale.text
);
await call("unlink_nodes", { source_id: "if-dash", target_id: "i-gone2", change: "feat" });

const opened = await call("open_next", { node_id: "if-dash", change: "feat" });
check(
  "open_next with the change applies its planned edges to the next slot",
  opened.applied_planned?.includes("if-dash -exposes-> i-new"),
  JSON.stringify(opened)
);
check(
  "the next file has the edge and no planned: list",
  listsEdge(openSlot("mindplan/interfaces", "if-dash", "feat"), "exposes", "i-new") &&
    !openSlot("mindplan/interfaces", "if-dash", "feat").includes("planned:")
);
const whileOpen = await call("run_check", { change: "feat" });
check(
  "an applied planned edge is no longer listed while its revision is open",
  !whileOpen.info.some((l) => l.includes('"if-dash" plans')) && whileOpen.change.members.some((m) => m.id === "if-dash" && m.kind === "revision"),
  JSON.stringify({ info: whileOpen.info, members: whileOpen.change.members })
);
await call("discard_next", { node_id: "if-dash" });
check("a discard leaves the edge planned", /- feat exposes i-new/.test(live("mindplan/interfaces/if-dash/if-dash.mdx")));
await call("open_next", { node_id: "if-dash", change: "feat" });
await call("patch_node_territory", { node_id: "if-dash", toggle_checkboxes: [{ id: "spec", checked: true }, { id: "impl", checked: true }, { id: "verify", checked: true }] });
await complete("i-new", "Interaction");
const shipped = await call("update_node_status", { scope: "change", change: "feat", new_status: "ship", skip_review: true });
const dashAfter = live("mindplan/interfaces/if-dash/if-dash.mdx");
check(
  "shipping the revision makes the planned edge live and drops its entry",
  /exposes:\r?\n(\s+- .*\r?\n)*\s+- i-new/.test(dashAfter) && !dashAfter.includes("feat exposes i-new"),
  dashAfter.split("---")[1]
);
check(
  "closing the change drops another node's unopened planned edges and reports them",
  (shipped.cleared_planned ?? []).some((e) => e.startsWith("i-old -leads_to-> i-new")) &&
    !live("mindplan/interactions/i-old/i-old.mdx").includes("planned:"),
  JSON.stringify(shipped)
);

// --- edge cases: a deleted target, a change id set after open_next, CRLF files, unreadable items ---
await call("create_node", { id: "i-temp", type: "Interaction", title: "Temp flow", description: "Visitor tries a temp flow.", change: "temp" });
await call("link_nodes", { source_id: "i-old", target_id: "i-temp", edge_type: "leads_to", change: "later" });
fs.rmSync(path.join(root, "mindplan/interactions/i-temp"), { recursive: true, force: true });
const orphanEdge = await raw("unlink_nodes", { source_id: "i-old", target_id: "i-temp", change: "later" });
check("a planned edge to a deleted node can still be removed", !orphanEdge.error, orphanEdge.text);

await call("create_node", { id: "i-third", type: "Interaction", title: "Archive a page", description: "Staff archives a page.", change: "c3" });
await call("link_nodes", { source_id: "if-dash", target_id: "i-third", edge_type: "exposes", change: "c3" });
const dashRel = "mindplan/interfaces/if-dash/if-dash.mdx";
const withBogus = live(dashRel).replace(/(planned:\r?\n(\s+- .*\r?\n)*)/, "$1  - c9 bogus_type i-third\n");
fs.writeFileSync(path.join(root, dashRel), withBogus.replace(/\r?\n/g, "\r\n"));
await call("unlink_nodes", { source_id: "if-dash", target_id: "i-third", change: "c3" });
check("an unreadable planned item survives a planned write", live(dashRel).includes("c9 bogus_type i-third"), live(dashRel).split("---")[1]);
await call("link_nodes", { source_id: "if-dash", target_id: "i-third", edge_type: "exposes", change: "c3" });
await call("open_next", { change: "rev-if-dash", node_id: "if-dash" });
// The revision file's frontmatter is server-written (LF); its body is the live body, CRLF kept.
const crlfNext = live("mindplan/interfaces/if-dash/revisions/rev-if-dash/if-dash.mdx").split(/\r?\n---\r?\n/).slice(1).join("---");
check("open_next keeps a CRLF live file's line endings in the revision body", !/[^\r]\n/.test(crlfNext), JSON.stringify(crlfNext.slice(0, 120)));
const lateChange = await call("run_check", { change: "c3" });
check(
  "a planned edge of another change stays listed while a revision of a different change is open",
  lateChange.info.some((l) => l.startsWith('planned edges: "if-dash" plans exposes i-third')),
  JSON.stringify(lateChange.info)
);
await call("discard_next", { node_id: "if-dash" });

// --- attribution: a schema node's revision adds a migration in the root's folder ---
write("src/root/migrations/0002.ts", "export const m2 = 1;\n");
await call("open_next", { node_id: "f-db", change: "schema" });
const before = await call("run_check", {});
check(
  "without attribution the migration does not count for the schema node",
  !before.warnings.some((w) => w.startsWith('decision: "f-db"') && w.includes("0002.ts")),
  JSON.stringify(before.warnings.filter((w) => w.includes("f-db")))
);
const glob = await raw("set_implementation_files", { node_id: "f-db", attributed: ["src/root/migrations/*.ts"] });
check("an attributed glob is Blocked", glob.error && glob.text.includes("exact file"), glob.text);
const orphan = await raw("set_implementation_files", { node_id: "f-db", attributed: ["src/nowhere/x.ts"] });
check("an attributed file no other node claims is Blocked", orphan.error && orphan.text.includes("no other node claims"), orphan.text);
const noRevision = await raw("set_implementation_files", { node_id: "i-old", attributed: ["src/root/migrations/0002.ts"] });
check("a shipped node with no open revision cannot attribute", noRevision.error && noRevision.text.includes("open_next"), noRevision.text);
const attributed = await call("set_implementation_files", { node_id: "f-db", attributed: ["src/root/migrations/0002.ts"] });
check(
  "set_implementation_files with attributed alone keeps the claims and writes the list",
  attributed.attributed?.[0] === "src/root/migrations/0002.ts" && attributed.implements?.[0] === "src/db/",
  JSON.stringify(attributed)
);
const after = await call("run_check", {});
check(
  "the attributed migration makes the schema node's revision decision-worthy",
  after.warnings.some((w) => w.startsWith('decision: "f-db"') && w.includes('"src/root/migrations/0002.ts"')),
  JSON.stringify(after.warnings.filter((w) => w.includes("f-db")))
);
const dbRadius = await call("get_blast_radius", { node_id: "f-db" });
check(
  "the blast radius lists the attributed migration under the revision",
  dbRadius.affected_files.find((g) => g.owner_id === "f-db")?.files.includes("src/root/migrations/0002.ts"),
  JSON.stringify(dbRadius.affected_files)
);
await call("patch_node_territory", { node_id: "f-db", toggle_checkboxes: [{ id: "spec", checked: true }, { id: "impl", checked: true }, { id: "verify", checked: true }] });
await call("update_node_status", { node_id: "f-db", new_status: "ready" });
await call("update_node_status", { node_id: "f-db", new_status: "in-progress" });
const gated = await raw("update_node_status", { node_id: "f-db", new_status: "in-review" });
check("in-review is Blocked: Decision naming the migration", gated.error && gated.text.includes("Blocked: Decision") && gated.text.includes("0002.ts"), gated.text);
await call("record_decision", {
  node_id: "f-db",
  decision: "Add the pages table in migration 0002.",
  alternatives: ["Reuse the content table (mixes two lifecycles)"],
  why: "Pages are versioned separately.",
});
const reviewed = await raw("update_node_status", { node_id: "f-db", new_status: "in-review" });
check("with a decision under its change the move passes", !reviewed.error, reviewed.text);
await call("update_node_status", { node_id: "f-db", new_status: "ship" });
check("ship drops the attributed list", !live("mindplan/foundations/f-db/f-db.mdx").includes("attributed:"));

// --- cycles across changes: each change alone is acyclic, together they could never ship ---
write("src/sa/sa.ts", "export const sa = 1;\n");
write("src/sb/sb.ts", "export const sb = 1;\n");
write("src/sc/sc.ts", "export const sc = 1;\n");
for (const id of ["f-sa", "f-sb", "f-sc"]) {
  await call("create_node", { id, type: "Foundation", title: `Sky ${id}`, description: `Adapter — sky part ${id}`, role: "adapter", change: "sky-base" });
  await call("set_implementation_files", { replace: true, node_id: id, files: [`src/${id.slice(2)}/`] });
  await complete(id, "Foundation");
}
const skyBase = await raw("update_node_status", { scope: "change", change: "sky-base", new_status: "ship", skip_review: true });
check("the sky base ships", !skyBase.error, skyBase.text);
await call("open_next", { node_id: "f-sa", change: "ai-builder" });
await call("link_nodes", { source_id: "f-sa", target_id: "f-sb", edge_type: "depends_on", change: "ai-builder" });
await call("open_next", { node_id: "f-sb", change: "ai-builder" });
const sameChange = await raw("link_nodes", { source_id: "f-sb", target_id: "f-sa", edge_type: "depends_on", change: "ai-builder" });
check(
  "a cycle within one change is still caught by the acyclic check",
  sameChange.error && sameChange.text.includes("dependency cycle") && !sameChange.text.includes("across changes"),
  sameChange.text
);
await call("discard_next", { node_id: "f-sb", change: "ai-builder" });
const plannedBack = await raw("link_nodes", { source_id: "f-sb", target_id: "f-sa", edge_type: "depends_on", change: "platform-settings" });
check(
  "a planned depends_on back into another change's edge is Blocked as a cross-change cycle",
  plannedBack.error &&
    plannedBack.text.includes('Blocked: depends_on "f-sb" -> "f-sa" (change "platform-settings") would close a dependency cycle across changes "ai-builder", "platform-settings": f-sb -> f-sa -> f-sb.') &&
    plannedBack.text.includes("Foundation both depend on"),
  plannedBack.text
);
await call("open_next", { node_id: "f-sb", change: "platform-settings" });
await call("open_next", { node_id: "f-sb", change: "other-sky" });
const revisionBack = await raw("link_nodes", { source_id: "f-sb", target_id: "f-sa", edge_type: "depends_on", change: "platform-settings" });
check(
  "a revision depends_on back into another change's edge is Blocked as a cross-change cycle",
  revisionBack.error && revisionBack.text.includes("across changes \"ai-builder\", \"platform-settings\""),
  revisionBack.text
);
await call("discard_next", { node_id: "f-sb", change: "platform-settings" });
await call("discard_next", { node_id: "f-sb", change: "other-sky" });
// A cycle written before the rule existed: plan a harmless edge, then point it back by hand.
await call("link_nodes", { source_id: "f-sb", target_id: "f-sc", edge_type: "depends_on", change: "platform-settings" });
const sbRel = "mindplan/foundations/f-sb/f-sb.mdx";
fs.writeFileSync(path.join(root, sbRel), live(sbRel).replace("- platform-settings depends_on f-sc", "- platform-settings depends_on f-sa"));
const cycleCheck = await call("run_check", {});
check(
  "run_check reports an existing cross-change cycle",
  !cycleCheck.ok && cycleCheck.failures.some((f) => f.startsWith('Blocked: change cycle: changes "ai-builder", "platform-settings"')),
  JSON.stringify(cycleCheck.failures)
);
const memberCheck = await call("run_check", { change: "platform-settings" });
check(
  "run_check({ change }) reports it for a member change",
  !memberCheck.ok && memberCheck.failures.some((f) => f.includes("change cycle:") && f.includes("platform-settings")),
  JSON.stringify(memberCheck.failures)
);
const openBack = await raw("open_next", { node_id: "f-sb", change: "platform-settings" });
check("open_next is Blocked on a planned edge that closes a cross-change cycle", openBack.error && openBack.text.includes("across changes"), openBack.text);

// --- cycle search on in-memory graphs: label choice, and size ---
{
  const cycles = await import(pathToFileURL(path.join(toolRoot, "dist/foundations/f-compiler-rules/change-cycles.js")).href);
  const shipped = (id, extra = {}) => ({ id, type: "Foundation", state: "stable", shipped_at: "2026-01-01T00:00:00.000Z", title: id, description: id, ...extra });
  // a -> b is planned in c1 and c2, b -> c in c3, c -> a is live but c1's revision removes it.
  // Taking c1 for a -> b breaks the cycle; c2 keeps it, so it is a cycle across c2 and c3.
  const picky = {
    version: 1,
    nodes: [
      shipped("a", { planned: [{ change: "c1", type: "depends_on", target: "b" }, { change: "c2", type: "depends_on", target: "b" }] }),
      shipped("b", { planned: [{ change: "c3", type: "depends_on", target: "c" }] }),
      shipped("c", {
        depends_on: ["a"],
        open_revisions: [{ change: "c1", state: "draft", title: "c", description: "c", edges: { depends_on: { add: [], remove: ["a"] } } }],
      }),
    ],
    edges: [{ source: "c", target: "a", type: "depends_on" }],
  };
  const found = cycles.changeCycles(picky);
  check(
    "a cycle is found when one of an edge's changes keeps a live edge another removes",
    found.length === 1 && JSON.stringify(found[0].changes) === JSON.stringify(["c2", "c3"]),
    JSON.stringify(found)
  );

  // a -> e -> b in x, b -> c in y (and z), c -> a live; the decoy a -> d -> b in z is walked first
  // (d sorts before e) and reaches b under z, where b -> c stays inside z. Reaching b under z must
  // not prune the walk that reaches it under x: x and y close the cycle.
  const decoy = {
    version: 1,
    nodes: [
      shipped("a", {
        planned: [{ change: "z", type: "depends_on", target: "d" }, { change: "x", type: "depends_on", target: "e" }],
      }),
      shipped("b", { planned: [{ change: "y", type: "depends_on", target: "c" }, { change: "z", type: "depends_on", target: "c" }] }),
      shipped("c", { depends_on: ["a"] }),
      shipped("d", { planned: [{ change: "z", type: "depends_on", target: "b" }] }),
      shipped("e", { planned: [{ change: "x", type: "depends_on", target: "b" }] }),
    ],
    edges: [{ source: "c", target: "a", type: "depends_on" }],
  };
  const decoyFound = cycles.changeCycles(decoy);
  check(
    "changeCycles finds the x/y cycle past a decoy walk under z",
    decoyFound.length === 1 && JSON.stringify(decoyFound[0].changes) === JSON.stringify(["x", "y"]),
    JSON.stringify(decoyFound)
  );
  let decoyGate = null;
  try {
    cycles.changeCycleGate(decoy)({ source: "c", target: "a" });
  } catch (err) {
    decoyGate = err.message;
  }
  check(
    "the link gate finds the x/y cycle past a decoy walk under z",
    !!decoyGate && decoyGate.includes('across changes "x", "y"') && decoyGate.includes("c -> a -> e -> b -> c"),
    String(decoyGate)
  );

  // 2,000 nodes, dense planned depends_on edges across 20 changes.
  let seed = 7;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const nodes = [];
  for (let i = 0; i < 2000; i++) {
    const planned = [];
    for (let j = 0; j < 8; j++) planned.push({ change: `c${rand(20)}`, type: "depends_on", target: `n${rand(2000)}` });
    nodes.push(shipped(`n${i}`, { planned }));
  }
  const dense = { version: 1, nodes, edges: [] };
  const started = performance.now();
  const lines = cycles.changeCycleFailures(dense);
  const ms = performance.now() - started;
  check(`run_check's cycle search on 2,000 dense nodes across 20 changes finishes fast (${Math.round(ms)} ms)`, ms < 3000 && lines.length >= 1, String(lines.length));
  const gateStarted = performance.now();
  const gate = cycles.changeCycleGate(dense);
  let blockedCount = 0;
  for (let i = 0; i < 200; i++) {
    try {
      gate({ source: `n${rand(2000)}`, target: `n${rand(2000)}`, change: `c${rand(20)}` });
    } catch {
      blockedCount++;
    }
  }
  const gateMs = performance.now() - gateStarted;
  check(`200 edge checks through one gate stay fast (${Math.round(gateMs)} ms, ${blockedCount} Blocked)`, gateMs < 3000);
}

await client.close();
fs.rmSync(root, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} planned-wiring check(s) failed.`);
  process.exit(1);
}
console.log("\nAll planned-wiring checks passed.");
