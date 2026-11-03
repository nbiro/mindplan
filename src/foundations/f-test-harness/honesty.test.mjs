/**
 * Graph-honesty coverage: readiness reset on contract writes, Blocked: Coverage with its fix,
 * next-slot imports, skip_review for scoped ship walks, unambiguous checkbox toggles with notes
 * and not-applicable reasons, change groups, glob claims, territory writes that put one blank
 * line below the frontmatter (collapsing older runs) and keep CRLF, and split route families.
 * Run via npm test.
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

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-honesty-"));
console.log("Honesty sandbox:", root);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, MINDPLAN_ROOT: root },
});
const client = new Client({ name: "honesty-test", version: "0.1.0" });
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

/** The node's open revision file (`revisions/<change>/<id>.mdx`, its only revision), or its live file. */
const territory = (kind, id, slot = "current") => {
  const dir = path.join(root, "mindplan", kind, id);
  if (slot !== "next") return path.join(dir, `${id}.mdx`);
  const revisions = path.join(dir, "revisions");
  // Before open_next, the path the suite's `rev-<id>` revision will take.
  const [change] = fs.existsSync(revisions) ? fs.readdirSync(revisions) : [];
  return path.join(revisions, change ?? `rev-${id}`, `${id}.mdx`);
};

/** Fill create_node scaffold stubs with real text and tick every checkbox. */
function fillAndTick(kind, id) {
  const file = territory(kind, id);
  let text = fs.readFileSync(file, "utf-8");
  text = text.replace(/^_.*?_$/gm, (line) =>
    line.includes("attachments/") ? line : "Honesty-test filled territory."
  );
  text = text.replace(/^## Checklist\s*$/m, "## Atomic Ops");
  if (!/^\s*[-*+]\s+\[[ xX]\]/m.test(text)) text += "\n- [ ] Done\n";
  text = text.replaceAll("- [ ]", "- [x]");
  fs.writeFileSync(file, text);
}

function write(rel, content) {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
function remove(rel) {
  fs.rmSync(path.join(root, ...rel.split("/")), { force: true, recursive: true });
}
const state = async (id) => (await call("get_node_context", { node_id: id })).record;

async function walk(id, steps) {
  for (const new_status of steps) await call("update_node_status", { node_id: id, new_status });
}

fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
fs.writeFileSync(
  path.join(root, "mindplan", "config.json"),
  JSON.stringify({ sources: ["src/**", "app/**"], exclude: [] }, null, 2) + "\n"
);

// --- base graph ---
await call("create_node", { id: "j-app", type: "Capability", title: "App", description: "App area" });
await call("create_node", { id: "f-core", type: "Foundation", title: "Core", description: "Infra — core", role: "infra" });
await call("create_node", { id: "i-a", type: "Interaction", title: "A", description: "Action A" });
await call("create_node", { id: "i-b", type: "Interaction", title: "B", description: "Action B" });
await call("link_nodes", { source_id: "i-a", target_id: "j-app", edge_type: "belongs_to" });
await call("link_nodes", { source_id: "i-a", target_id: "f-core", edge_type: "depends_on" });
await call("link_nodes", { source_id: "i-b", target_id: "j-app", edge_type: "belongs_to" });
await call("link_nodes", { source_id: "i-b", target_id: "f-core", edge_type: "depends_on" });
write("src/f-core/index.ts", "export const core = 1;\n");
write("src/i-a/a.ts", 'import { core } from "../f-core/index.js";\nexport const a = core;\n');
write("src/i-b/b.ts", 'import { core } from "../f-core/index.js";\nexport const b = core;\n');
await call("set_implementation_files", { replace: true, node_id: "f-core", files: ["src/f-core/index.ts"] });
await call("set_implementation_files", { replace: true, node_id: "i-a", files: ["src/i-a/"] });
await call("set_implementation_files", { replace: true, node_id: "i-b", files: ["src/i-b/b.ts"] });
fillAndTick("foundations", "f-core");
fillAndTick("interactions", "i-a");
fillAndTick("interactions", "i-b");

// --- item 1: contract writes to a ready revision send it back to draft ---
{
  await call("update_node_status", { node_id: "i-a", new_status: "ready" });
  const patched = await call("patch_node_territory", {
    node_id: "i-a",
    replace: { find: "Honesty-test filled territory.", with: "Changed after ready.", all: true },
  });
  check(
    "a territory patch on a ready node moves it to draft and says so",
    patched.state === "draft" && patched.readiness_reset?.from === "ready" && patched.readiness_reset?.to === "draft",
    JSON.stringify(patched)
  );

  await call("update_node_status", { node_id: "i-a", new_status: "ready" });
  const same = await call("set_implementation_files", { replace: true, node_id: "i-a", files: ["src/i-a/"] });
  check("re-claiming the same files keeps a ready node ready", same.state === "ready" && !same.readiness_reset, JSON.stringify(same));
  write("src/i-a/more.ts", "export const more = 1;\n");
  const claimed = await call("set_implementation_files", { replace: true, node_id: "i-a", files: ["src/i-a/a.ts", "src/i-a/more.ts"] });
  check("a claim on a ready node moves it to draft", claimed.state === "draft" && !!claimed.readiness_reset, JSON.stringify(claimed));
  await call("set_implementation_files", { replace: true, node_id: "i-a", files: ["src/i-a/"] });

  await call("update_node_status", { node_id: "i-a", new_status: "ready" });
  const linked = await call("link_nodes", { source_id: "i-a", target_id: "i-b", edge_type: "leads_to" });
  check("a link from a ready node moves it to draft", linked.state === "draft" && !!linked.readiness_reset, JSON.stringify(linked));

  await call("update_node_status", { node_id: "i-a", new_status: "ready" });
  const unlinked = await call("unlink_nodes", { source_id: "i-a", target_id: "i-b" });
  check("an unlink from a ready node moves it to draft", unlinked.state === "draft" && !!unlinked.readiness_reset, JSON.stringify(unlinked));

  await call("update_node_status", { node_id: "i-a", new_status: "ready" });
  await call("patch_node_rules", { node_id: "i-a", rules: "- Keep it small." });
  const changeOnly = await call("patch_node_territory", { node_id: "i-a", change: "feat-a" });
  const afterRules = await state("i-a");
  check(
    "rules and change-id writes keep a ready node ready",
    afterRules.state === "ready" && !changeOnly.readiness_reset && afterRules.change === "feat-a",
    JSON.stringify({ changeOnly, afterRules })
  );
  await call("patch_node_territory", { node_id: "i-a", change: "" });
  check("an empty change clears it", (await state("i-a")).change === undefined);

  await call("update_node_status", { node_id: "i-a", new_status: "in-progress" });
  const midBuild = await call("patch_node_territory", {
    node_id: "i-a",
    replace: { find: "Changed after ready.", with: "Built.", all: true },
  });
  check(
    "a write to an in-progress node changes no state",
    midBuild.state === "in-progress" && !midBuild.readiness_reset,
    JSON.stringify(midBuild)
  );

  // Ship f-core, then open and ready an evolution: writes to the ready next slot reset it.
  await walk("f-core", ["ready", "in-progress", "in-review", "ship"]);
  await call("open_next", { change: "rev-f-core", node_id: "f-core" });
  await call("update_node_status", { node_id: "f-core", new_status: "ready" });
  const nextPatch = await call("patch_node_territory", {
    node_id: "f-core",
    replace: { find: "Honesty-test filled territory.", with: "Next contract.", all: true },
  });
  check(
    "a patch on a ready next slot moves next_state back to draft",
    nextPatch.state === "stable" && nextPatch.next_state === "draft" && nextPatch.readiness_reset?.slot === "next",
    JSON.stringify(nextPatch)
  );
  await call("discard_next", { node_id: "f-core" });
}

// --- items 4 and 5: unambiguous toggles, notes, and not-applicable reasons ---
{
  await call("create_node", { id: "f-tog", type: "Foundation", title: "Toggles", description: "Infra — toggles", role: "infra" });
  write("src/f-tog/index.ts", "export const tog = 1;\n");
  await call("set_implementation_files", { replace: true, node_id: "f-tog", files: ["src/f-tog/"] });
  fillAndTick("foundations", "f-tog");
  const togFile = territory("foundations", "f-tog");
  const ops = "- [ ] Write docs {#docs}\n- [ ] Write tests\n- [ ] Write tests\n- [ ] Load test\n- [ ] Manual check\n";
  const filled = fs.readFileSync(togFile, "utf-8").replace(/^- \[x\] .*\r?\n?/gm, "");
  fs.writeFileSync(togFile, filled.replace(/(## Atomic Ops\r?\n\r?\n)/, `$1${ops}`));
  await walk("f-tog", ["ready", "in-progress"]);

  const substring = await blocked("patch_node_territory", {
    node_id: "f-tog",
    toggle_checkboxes: [{ contains: "Write", checked: true }],
  });
  check(
    "a substring toggle is Blocked and names the items with their ids",
    !!substring &&
      substring.includes("no item with that exact text") &&
      substring.includes('items: "Write docs" {#docs}, "Write tests", "Write tests", "Load test", "Manual check"'),
    String(substring)
  );
  const marker = await blocked("patch_node_territory", {
    node_id: "f-tog",
    toggle_checkboxes: [{ contains: "- [ ] Load test", checked: true }],
  });
  check("a contains with the checkbox marker is not the item's text: Blocked", !!marker && marker.includes("no item with that exact text"), String(marker));
  const ambiguous = await blocked("patch_node_territory", {
    node_id: "f-tog",
    toggle_checkboxes: [{ contains: "Write tests", checked: true }],
  });
  check(
    "an exact text on several items is Blocked and lists them",
    !!ambiguous && ambiguous.includes("matches 2 items") && ambiguous.includes("- [ ] Write tests"),
    String(ambiguous)
  );
  const both = await call("patch_node_territory", {
    node_id: "f-tog",
    toggle_checkboxes: [{ contains: "Write tests", checked: true, all: true }],
  });
  check(
    "all: true toggles every item with that exact text and returns the lines",
    both.toggled?.length === 2 && both.toggled.every((l) => l === "- [x] Write tests") && both.state === "in-progress",
    JSON.stringify(both)
  );
  const byId = await call("patch_node_territory", { node_id: "f-tog", toggle_checkboxes: [{ id: "docs", note: "in the README" }] });
  check(
    "a toggle by id ticks the item and writes the note after its tag",
    byId.toggled?.[0] === "- [x] Write docs {#docs} — note: in the README",
    JSON.stringify(byId.toggled)
  );
  const exactTagged = await call("patch_node_territory", { node_id: "f-tog", toggle_checkboxes: [{ contains: " Write docs ", checked: false }] });
  check(
    "the exact text excludes the tag and the annotation, trimmed; unticking strips the note and keeps the tag",
    exactTagged.toggled?.[0] === "- [ ] Write docs {#docs}",
    JSON.stringify(exactTagged.toggled)
  );
  await call("patch_node_territory", { node_id: "f-tog", toggle_checkboxes: [{ id: "docs", checked: true }] });
  const noId = await blocked("patch_node_territory", { node_id: "f-tog", toggle_checkboxes: [{ id: "nope", checked: true }] });
  check("an unknown id is Blocked naming the items", !!noId && noId.includes('no item with id "nope"') && noId.includes("{#docs}"), String(noId));
  const neither = await blocked("patch_node_territory", { node_id: "f-tog", toggle_checkboxes: [{ checked: true }] });
  check("a toggle with neither id nor contains is Blocked", !!neither, String(neither));
  const noted = await call("patch_node_territory", {
    node_id: "f-tog",
    toggle_checkboxes: [
      { contains: "Manual check", checked: true, note: "verified manually" },
      { contains: "Load test", not_applicable: "no traffic in this release" },
    ],
  });
  check(
    "a note and a not-applicable reason are appended without rewording",
    noted.toggled?.[0] === "- [x] Manual check — note: verified manually" &&
      noted.toggled?.[1] === "- [x] Load test — n/a: no traffic in this release",
    JSON.stringify(noted.toggled)
  );
  const untick = await call("patch_node_territory", {
    node_id: "f-tog",
    toggle_checkboxes: [{ contains: "Manual check", checked: false }],
  });
  check("an annotated item still matches its text, and unticking strips the note", untick.toggled?.[0] === "- [ ] Manual check", JSON.stringify(untick.toggled));
  const noteOnly = await call("patch_node_territory", {
    node_id: "f-tog",
    toggle_checkboxes: [{ contains: "Manual check", note: "verified manually" }],
  });
  check("a note without checked ticks the item", noteOnly.toggled?.[0] === "- [x] Manual check — note: verified manually", JSON.stringify(noteOnly.toggled));
  await call("update_node_status", { node_id: "f-tog", new_status: "in-review" });
  // An n/a with no reason is not done: write one by hand and the completion check refuses ship.
  const file = territory("foundations", "f-tog");
  const annotated = fs.readFileSync(file, "utf-8");
  fs.writeFileSync(file, annotated.replace("— n/a: no traffic in this release", "— n/a:"));
  const emptyReason = await blocked("update_node_status", { node_id: "f-tog", new_status: "ship" });
  check("a not-applicable tick with no reason fails the completion check", !!emptyReason, String(emptyReason));
  fs.writeFileSync(file, annotated);
  const shipped = await call("update_node_status", { node_id: "f-tog", new_status: "ship" });
  check("annotated ticks pass the completion check", shipped.new_state === "stable", JSON.stringify(shipped));
}

// --- item 2: unclaimed files are Blocked: Coverage with the fix; next-slot imports are scanned ---
{
  write("src/i-b/extra.ts", "export const extra = 1;\n");
  let r = await call("run_check", {});
  const cov = r.failures.find((f) => f.includes('"src/i-b/extra.ts"'));
  check(
    "an unclaimed source file fails with Blocked: Coverage, its probable owner, and the claim call",
    !r.ok && !!cov && cov.startsWith("Blocked: Coverage:") && cov.includes('Probable owner by path: "i-b"') &&
      cov.includes('set_implementation_files({"node_id":"i-b"'),
    String(cov)
  );
  remove("src/i-b/extra.ts");

  write("src/orphan/deep/x.ts", "export const orphan = 1;\n");
  r = await call("run_check", {});
  const far = r.failures.find((f) => f.includes('"src/orphan/deep/x.ts"'));
  check(
    "a file that only shares src/ with every claim gets no probable owner",
    !!far && !far.includes("Probable owner") && far.includes("No node claims a nearby path"),
    String(far)
  );
  remove("src/orphan");

  write("src/f-core/extra.ts", "export const more = 1;\n");
  r = await call("run_check", {});
  const shippedCov = r.failures.find((f) => f.includes('"src/f-core/extra.ts"'));
  check(
    "the fix for a shipped owner in a folder it dominates is the in-place claim alone",
    !!shippedCov &&
      !shippedCov.includes("open_next") &&
      shippedCov.includes('Fix: set_implementation_files({"node_id":"f-core","add":["src/f-core/extra.ts"]})'),
    String(shippedCov)
  );
  remove("src/f-core/extra.ts");

  write("src/f-core/sub/deep.ts", "export const deep = 1;\n");
  r = await call("run_check", {});
  const deepCov = r.failures.find((f) => f.includes('"src/f-core/sub/deep.ts"'));
  check(
    "the fix for a shipped owner outside a folder it dominates opens its evolution first",
    !!deepCov &&
      deepCov.includes('Probable owner by path: "f-core"') &&
      deepCov.includes('open_next({"node_id":"f-core","change":"<change-id>"}) then set_implementation_files({"node_id":"f-core","change":"<change-id>","add":'),
    String(deepCov)
  );
  remove("src/f-core/sub");
}

// A released file (claimed live, dropped by the open next) that imports an Interaction is scanned.
{
  await call("create_node", { id: "f-rel", type: "Foundation", title: "Released", description: "Infra — released", role: "infra" });
  write("src/f-rel/keep.ts", "export const keep = 1;\n");
  write("src/f-rel/old.ts", "export const old = 1;\n");
  await call("set_implementation_files", { replace: true, node_id: "f-rel", files: ["src/f-rel/keep.ts", "src/f-rel/old.ts"] });
  fillAndTick("foundations", "f-rel");
  await walk("f-rel", ["ready", "in-progress", "in-review", "ship"]);
  await call("open_next", { change: "rev-f-rel", node_id: "f-rel" });
  await call("set_implementation_files", { replace: true, node_id: "f-rel", files: ["src/f-rel/keep.ts"] });
  write("src/f-rel/old.ts", 'import { a } from "../i-a/a.js";\nexport const old = a;\n');
  const r = await call("run_check", {});
  const w = r.warnings.find((x) => x.startsWith("imports (next slot):") && x.includes("src/f-rel/old.ts"));
  check(
    "an illegal import in a released file warns as imports (next slot) and does not fail",
    !!w && !r.failures.some((f) => f.includes("src/f-rel/old.ts")),
    JSON.stringify({ warnings: r.warnings, failures: r.failures })
  );
  write("src/f-rel/old.ts", "export const old = 1;\n");
  await call("discard_next", { node_id: "f-rel" });
}

// --- item 3: a scoped walk to ship does not skip review silently ---
{
  await call("create_node", { id: "f-quick", type: "Foundation", title: "Quick", description: "Infra — quick", role: "infra" });
  write("src/f-quick/index.ts", "export const quick = 1;\n");
  await call("set_implementation_files", { replace: true, node_id: "f-quick", files: ["src/f-quick/"] });
  fillAndTick("foundations", "f-quick");
  await call("update_node_status", { node_id: "f-quick", new_status: "ready" });
  const dry = await call("update_node_status", {
    scope: "node_and_dependents",
    node_id: "f-quick",
    new_status: "ship",
    dry_run: true,
  });
  check(
    "the dry run lists every transition and names the review skip",
    JSON.stringify(dry.plan) ===
      JSON.stringify([
        "f-quick: ready -> in-progress",
        "f-quick: in-progress -> in-review",
        "f-quick: in-review -> ship",
      ]) && String(dry.blocked).includes("skip_review"),
    JSON.stringify(dry)
  );
  const refused = await blocked("update_node_status", { scope: "node_and_dependents", node_id: "f-quick", new_status: "ship" });
  check(
    "ready to ship without skip_review is Blocked and writes nothing",
    !!refused && refused.includes("skip_review") && (await state("f-quick")).state === "ready",
    String(refused)
  );
  const forced = await call("update_node_status", {
    scope: "node_and_dependents",
    node_id: "f-quick",
    new_status: "ship",
    skip_review: true,
  });
  check(
    "skip_review walks through in-review and is reported",
    forced.skipped_review?.includes("f-quick") && (await state("f-quick")).state === "stable",
    JSON.stringify(forced)
  );
  const stray = await blocked("update_node_status", { node_id: "i-b", new_status: "ready", skip_review: true });
  check("skip_review outside a scoped walk is Blocked", !!stray, String(stray));
}

// --- item 6: change groups ---
{
  await call("create_node", {
    id: "f-cx",
    type: "Foundation",
    title: "Change X base",
    description: "Infra — change x",
    role: "infra",
    change: "feat-x",
    change_ref: "feat/x",
  });
  await call("create_node", { id: "i-cx", type: "Interaction", title: "Change X", description: "Change X action", change: "feat-x" });
  await call("link_nodes", { source_id: "i-cx", target_id: "j-app", edge_type: "belongs_to" });
  await call("link_nodes", { source_id: "i-cx", target_id: "f-cx", edge_type: "depends_on" });
  write("src/f-cx/index.ts", "export const cx = 1;\n");
  write("src/i-cx/cx.ts", 'import { cx } from "../f-cx/index.js";\nexport const icx = cx;\n');
  await call("set_implementation_files", { replace: true, node_id: "f-cx", files: ["src/f-cx/"] });
  await call("set_implementation_files", { replace: true, node_id: "i-cx", files: ["src/i-cx/"] });
  fillAndTick("foundations", "f-cx");
  fillAndTick("interactions", "i-cx");
  const rec = await state("f-cx");
  check("create_node stores the change id and ref", rec.change === "feat-x" && rec.change_ref === "feat/x", JSON.stringify(rec));

  await call("open_next", { node_id: "f-tog", change: "feat-x" });
  const tog = await state("f-tog");
  check("open_next stores the change on the next slot", tog.next?.change === "feat-x", JSON.stringify(tog.next));

  const radius = await call("get_blast_radius", { change: "feat-x" });
  check(
    "change blast radius lists the members and leaves them out of affected",
    radius.members?.length === 3 && !radius.affected.some((a) => ["f-cx", "i-cx", "f-tog"].includes(a.id)),
    JSON.stringify(radius)
  );
  const noArgs = await blocked("get_blast_radius", {});
  check("blast radius without node_id or change is Blocked", !!noArgs, String(noArgs));

  const dry = await call("update_node_status", { scope: "change", change: "feat-x", new_status: "ready", dry_run: true });
  check(
    "scope change walks exactly the change's revisions",
    dry.blocked === null && dry.plan.length === 3 && dry.plan.some((l) => l.startsWith("f-tog: draft -> ready")),
    JSON.stringify(dry)
  );
  await call("update_node_status", { scope: "change", change: "feat-x", new_status: "in-progress" });
  check("scope change moved every member", (await state("i-cx")).state === "in-progress" && (await state("f-tog")).next?.state === "in-progress");

  let r = await call("run_check", { change: "feat-x" });
  check("run_check with change lists the members", r.ok && r.change?.members?.length === 3, JSON.stringify(r));
  write("src/i-cx/cx.ts", 'import { core } from "../f-core/index.js";\nexport const icx = core;\n');
  r = await call("run_check", { change: "feat-x" });
  check(
    "run_check with change fails on a member's import violation, reported once",
    !r.ok && r.failures.filter((f) => f.includes("src/i-cx/cx.ts")).length === 1,
    JSON.stringify(r.failures)
  );
  write("src/i-cx/cx.ts", 'import { cx } from "../f-cx/index.js";\nexport const icx = cx;\n');

  await call("discard_next", { node_id: "f-tog" });
  await call("update_node_status", { scope: "change", change: "feat-x", new_status: "in-review" });
  await call("update_node_status", { scope: "change", change: "feat-x", new_status: "ship" });
  const shipped = await state("f-cx");
  check("ship ends change membership", shipped.state === "stable" && shipped.change === undefined, JSON.stringify(shipped));
  const empty = await blocked("update_node_status", { scope: "change", change: "feat-x", new_status: "ready" });
  check("a change with no open revisions is Blocked", !!empty, String(empty));
}

// --- item 7: glob claims ---
{
  await call("create_node", { id: "i-read", type: "Interaction", title: "Read post", description: "Read a post" });
  await call("link_nodes", { source_id: "i-read", target_id: "j-app", edge_type: "belongs_to" });
  await call("link_nodes", { source_id: "i-read", target_id: "f-core", edge_type: "depends_on" });
  write("src/templates/blog/actions/i-read-post/view.tsx", "export const v = 1;\n");
  write("src/templates/news/actions/i-read-post/view.tsx", "export const v = 2;\n");
  write("src/templates/blog/layout.tsx", "export const l = 1;\n");
  await call("set_implementation_files", { replace: true, node_id: "i-read", files: ["src/templates/*/actions/i-read-post/"] });
  const impl = await call("get_node_implementation", { node_id: "i-read" });
  check(
    "a glob claim expands to the matching files in every template",
    impl.files?.length === 2 && impl.files.every((f) => f.path.endsWith("/actions/i-read-post/view.tsx") && f.exists),
    JSON.stringify(impl)
  );
  const owner = await call("get_node_implementation", { path: "src/templates/news/actions/i-read-post/view.tsx" });
  check("path lookup resolves through a glob claim", owner.owner?.node_id === "i-read", JSON.stringify(owner));

  await call("create_node", { id: "if-blog", type: "Interface", title: "Blog template", description: "Blog entry point" });
  const conflict = await blocked("set_implementation_files", { node_id: "if-blog", add: ["src/templates/blog/"] });
  check("an overlapping claim on a glob-claimed file is Blocked", !!conflict && conflict.includes("i-read"), String(conflict));
  await call("set_implementation_files", { replace: true, node_id: "if-blog", files: ["src/templates/blog/layout.tsx"] });

  write("src/routes/[slug]/x.ts", "export const x = 1;\n");
  await call("set_implementation_files", { replace: true, node_id: "i-b", files: ["src/i-b/", "src/routes/[slug]/x.ts"] });
  const lit = await call("get_node_implementation", { node_id: "i-b" });
  check(
    "[slug] in a claim is a literal folder name",
    lit.files.some((f) => f.path === "src/routes/[slug]/x.ts" && f.exists),
    JSON.stringify(lit)
  );
}

// --- territory writes keep the bytes between the frontmatter and the body, and CRLF stays CRLF ---
{
  await call("create_node", { id: "f-lay", type: "Foundation", title: "Layout", description: "Infra — layout", role: "infra" });
  write("src/f-lay/index.ts", "export const lay = 1;\n");
  await call("set_implementation_files", { replace: true, node_id: "f-lay", files: ["src/f-lay/"] });
  fillAndTick("foundations", "f-lay");
  const layFile = territory("foundations", "f-lay");
  const layNext = territory("foundations", "f-lay", "next");
  // A Windows checkout: the whole file is CRLF.
  fs.writeFileSync(layFile, fs.readFileSync(layFile, "utf-8").replace(/\r?\n/g, "\r\n"));
  const read = (file) => fs.readFileSync(file, "utf-8");
  // Everything above the title, with the fields these writes are meant to change masked out.
  const head = (file) => {
    const text = read(file);
    return text.slice(0, text.indexOf("# Layout")).replace(/^(updated_at|shipped_at|description):.*$/gm, "$1:");
  };
  const hasLf = (text) => /(^|[^\r])\n/.test(text);
  // The closing `---` line and everything after it.
  const fromFence = (file) => {
    const text = read(file);
    return text.slice(text.indexOf("\n---", 3) + 1);
  };
  const original = head(layFile);
  check("the layout fixture has one blank line after the frontmatter", original.endsWith("\r\n---\r\n\r\n"), JSON.stringify(original));

  for (const [label, patch] of [
    ["replace", { replace: { find: "Honesty-test filled territory.", with: "Layout text.", all: true } }],
    ["section", { section: "## Purpose", text: "Keeps the layout." }],
    ["toggle", { toggle_checkboxes: [{ contains: "Spec written", checked: false }] }],
    ["second toggle", { toggle_checkboxes: [{ contains: "Spec written", checked: true }] }],
    ["description", { description: "Infra — layout kept" }],
  ]) {
    await call("patch_node_territory", { node_id: "f-lay", ...patch });
    check(
      `a ${label} patch changes nothing else before the body and keeps the file CRLF`,
      head(layFile) === original && !hasLf(read(layFile)),
      JSON.stringify(head(layFile))
    );
  }

  const { body: fullBody } = await call("get_node_context", { node_id: "f-lay" });
  await call("patch_node_territory", { node_id: "f-lay", body: "# Layout\n\nWhole body.\n" });
  check(
    "a whole-body write starting with text gets one blank line below the frontmatter",
    head(layFile) === original && !hasLf(read(layFile)),
    JSON.stringify(head(layFile))
  );
  await call("patch_node_territory", { node_id: "f-lay", body: "\n\n# Layout\n\nWhole body.\n" });
  check(
    "a whole-body write that starts with blank lines gets one blank line below the frontmatter",
    head(layFile) === original && !hasLf(read(layFile)),
    JSON.stringify(head(layFile))
  );
  await call("patch_node_territory", { node_id: "f-lay", body: fullBody });
  check(
    "writing back the body get_node_context returned restores the layout",
    head(layFile) === original && read(layFile).endsWith(fullBody),
    JSON.stringify(head(layFile))
  );

  // Ship, open an evolution, patch it, and ship it: promote keeps the next file's layout and CRLF.
  await walk("f-lay", ["ready", "in-progress", "in-review", "ship"]);
  await call("open_next", { change: "rev-f-lay", node_id: "f-lay" });
  await call("patch_node_territory", { node_id: "f-lay", section: "## Purpose", text: "Next purpose." });
  // open_next starts a fresh ledger, so the revision ticks its own ops before it ships.
  await call("patch_node_territory", { node_id: "f-lay", toggle_checkboxes: [{ id: "spec", checked: true }, { id: "impl", checked: true }, { id: "verify", checked: true }] });
  // A shipped Foundation's revision needs a decision before in-review; recording it is a write too.
  await call("record_decision", {
    node_id: "f-lay",
    decision: "The purpose stays one line.",
    alternatives: ["A longer purpose (this fixture only exercises the file layout)"],
    why: "The test checks bytes, not prose.",
  });
  // The revision file's frontmatter is the server's own; its body keeps the live body's bytes.
  const layBody = () => fromFence(layNext).replace(/^---\r?\n/, "");
  check(
    "patches and a decision on an open revision keep one blank line above its body and the body CRLF",
    /^\r?\n# Layout/.test(layBody()) && !hasLf(layBody().replace(/^\r?\n/, "")),
    JSON.stringify(fromFence(layNext).slice(0, 40))
  );
  await walk("f-lay", ["ready", "in-progress", "in-review", "ship"]);
  check(
    "shipping an evolution keeps one blank line after the frontmatter and the file CRLF",
    fromFence(layFile).startsWith("---\r\n\r\n# Layout") &&
      read(layFile).includes("Next purpose.") &&
      !hasLf(read(layFile)),
    JSON.stringify(head(layFile))
  );
  check("shipping an evolution deletes the revision folder", !fs.existsSync(path.dirname(layNext)));
}

// --- runs of blank lines below the frontmatter (left by releases before 0.2.0) collapse ---
{
  await call("create_node", { id: "f-gap", type: "Foundation", title: "Gap", description: "Infra — gap", role: "infra" });
  write("src/f-gap/index.ts", "export const gap = 1;\n");
  await call("set_implementation_files", { replace: true, node_id: "f-gap", files: ["src/f-gap/"] });
  fillAndTick("foundations", "f-gap");
  const gapFile = territory("foundations", "f-gap");
  const read = (file) => fs.readFileSync(file, "utf-8");
  const blankRun = (file) => read(file).match(/\r?\n---\r?\n((?:\r?\n)*)/)[1].replace(/\r/g, "").length;
  const seed = (eol) =>
    fs.writeFileSync(
      gapFile,
      read(gapFile)
        .replace(/\r?\n/g, eol)
        .replace(/(\r?\n---\r?\n)(?:\r?\n)*/, (_m, fence) => `${fence}${eol.repeat(6)}`)
    );

  seed("\n");
  check("the gap fixture starts with six blank lines", blankRun(gapFile) === 6, String(blankRun(gapFile)));
  const { body } = await call("get_node_context", { node_id: "f-gap" });
  check("get_node_context returns the body from its first text", body.startsWith("# Gap"), JSON.stringify(body.slice(0, 20)));
  await call("update_node_status", { node_id: "f-gap", new_status: "ready" });
  check("a status move leaves one blank line below the frontmatter", blankRun(gapFile) === 1, String(blankRun(gapFile)));

  seed("\r\n");
  await call("patch_node_territory", { node_id: "f-gap", aliases: ["gap"] });
  check(
    "an alias write on a CRLF file leaves one blank line and keeps it CRLF",
    blankRun(gapFile) === 1 && !/(^|[^\r])\n/.test(read(gapFile)),
    String(blankRun(gapFile))
  );

  // A discarded revision deletes the next file, even while the live file still has its run.
  await walk("f-gap", ["in-progress", "in-review", "ship"]);
  await call("open_next", { change: "rev-f-gap", node_id: "f-gap" });
  check(
    "open_next writes the next file with one blank line below the frontmatter",
    blankRun(territory("foundations", "f-gap", "next")) === 1,
    String(blankRun(territory("foundations", "f-gap", "next")))
  );
  seed("\n");
  await call("discard_next", { node_id: "f-gap" });
  const gapCheck = await call("run_check", {});
  check(
    "discarding beside a live file with a run deletes the next file and the check passes for it",
    !fs.existsSync(territory("foundations", "f-gap", "next")) &&
      blankRun(gapFile) === 6 &&
      !gapCheck.failures.some((f) => f.includes("f-gap")),
    JSON.stringify(gapCheck.failures.filter((f) => f.includes("f-gap")))
  );
}

// --- item 8: split ownership of one route family warns ---
{
  await call("create_node", { id: "f-asm", type: "Foundation", title: "Assembler", description: "Assembler — app shell", role: "assembler" });
  await call("link_nodes", { source_id: "if-blog", target_id: "i-read", edge_type: "exposes" });
  write("app/layout.tsx", "export default function Root({ children }) { return children; }\n");
  write("src/features/app/page.ts", "export const notARoute = 1;\n");
  write("src/features/app/error.ts", "export const notARouteEither = 1;\n");
  await call("set_implementation_files", { replace: true, node_id: "i-b", files: ["src/features/app/", "src/i-b/", "src/routes/[slug]/x.ts"] });
  write("app/sites/[site]/[lang]/blog/page.tsx", "export default function Page() { return null; }\n");
  write("app/sites/[site]/[lang]/blog/[slug]/page.tsx", "export default function Post() { return null; }\n");
  write("app/sites/[site]/[lang]/shop/page.tsx", "export default function Shop() { return null; }\n");
  await call("set_implementation_files", {
    replace: true,
    node_id: "f-asm",
    files: ["app/layout.tsx", "app/sites/[site]/[lang]/blog/page.tsx", "app/sites/[site]/[lang]/shop/"],
  });
  await call("set_implementation_files", {
    replace: true,
    node_id: "if-blog",
    files: ["app/sites/[site]/[lang]/blog/[slug]/page.tsx", "src/templates/blog/layout.tsx"],
  });
  let r = await call("run_check", {});
  const split = r.warnings.filter((w) => w.startsWith("routes:"));
  check(
    "a route family owned by the Assembler and an Interface warns once",
    split.length === 1 &&
      split[0].includes('"app/sites/[site]/[lang]/blog/"') &&
      split[0].includes('"f-asm" (Assembler)') &&
      split[0].includes('"if-blog" (Interface)'),
    JSON.stringify(r.warnings)
  );
  await call("set_implementation_files", { replace: true, node_id: "if-blog", files: ["src/templates/blog/layout.tsx"] });
  await call("set_implementation_files", {
    replace: true,
    node_id: "f-asm",
    files: ["app/layout.tsx", "app/sites/[site]/[lang]/blog/", "app/sites/[site]/[lang]/shop/"],
  });
  r = await call("run_check", {});
  check("one owner per route family does not warn", !r.warnings.some((w) => w.startsWith("routes:")), JSON.stringify(r.warnings));
  check("the sandbox graph passes the check", r.ok, r.output);
}

// --- item 9: the full check scans imports of claimed files outside the configured sources ---
{
  await call("create_node", { id: "if-ext", type: "Interface", title: "Ext", description: "Partner uses the ext surface" });
  write("web/ext.ts", 'import { b } from "../src/i-b/b.js";\nexport const ext = b;\n');
  await call("set_implementation_files", { replace: true, node_id: "if-ext", files: ["web/ext.ts"] });
  let r = await call("run_check", {});
  check(
    "an Interface file outside sources importing an Interaction it does not expose fails the check",
    !r.ok && r.failures.some((f) => f.includes('"web/ext.ts"') && f.includes('"edge_type":"exposes"')),
    r.output
  );
  await call("link_nodes", { source_id: "if-ext", target_id: "i-b", edge_type: "exposes" });
  r = await call("run_check", {});
  check("exposing the Interaction clears it", r.ok, r.output);
}

// --- item 10: a scoped walk with skip_blocked ships what passes and leaves the blocked ---
{
  for (const id of ["f-ok", "f-bad"]) {
    await call("create_node", { id, type: "Foundation", title: id, description: `Infra — ${id}`, role: "infra", change: "mixed" });
    fillAndTick("foundations", id);
  }
  await call("create_node", { id: "i-mixed", type: "Interaction", title: "Mixed", description: "User does mixed", change: "mixed" });
  await call("link_nodes", { source_id: "i-mixed", target_id: "j-app", edge_type: "belongs_to" });
  await call("link_nodes", { source_id: "i-mixed", target_id: "f-bad", edge_type: "depends_on" });
  fillAndTick("interactions", "i-mixed");
  write("src/f-ok/ok.ts", "export const ok = 1;\n");
  write("src/f-bad/bad.ts", 'import { b } from "../i-b/b.js";\nexport const bad = b;\n');
  write("src/i-mixed/m.ts", "export const m = 1;\n");
  await call("set_implementation_files", { replace: true, node_id: "f-ok", files: ["src/f-ok/"] });
  await call("set_implementation_files", { replace: true, node_id: "f-bad", files: ["src/f-bad/"] });
  await call("set_implementation_files", { replace: true, node_id: "i-mixed", files: ["src/i-mixed/"] });

  const noReview = await call("update_node_status", {
    scope: "change", change: "mixed", new_status: "ship", skip_blocked: true, dry_run: true,
  });
  check(
    "without skip_review, skip_blocked lists a member that would skip review as blocked instead of shipping it",
    noReview.plan.length === 0 &&
      noReview.blocked.some((b) => b.node_id === "f-ok" && b.reason.includes("not in-review yet")),
    JSON.stringify(noReview)
  );

  const walk = { scope: "change", change: "mixed", new_status: "ship", skip_review: true };
  const whole = await blocked("update_node_status", walk);
  check(
    "without skip_blocked a walk with a blocked member writes nothing",
    !!whole && (await state("f-ok")).state === "draft",
    String(whole)
  );

  const dry = await call("update_node_status", { ...walk, skip_blocked: true, dry_run: true });
  check(
    "a skip_blocked dry run plans only the passing member and lists the blocked ones",
    dry.plan.every((l) => l.startsWith("f-ok:")) &&
      dry.blocked.some((b) => b.node_id === "f-bad" && b.step === "in-review" && b.reason.includes("imports:")) &&
      dry.blocked.some((b) => b.node_id === "i-mixed"),
    JSON.stringify(dry)
  );

  const r = await call("update_node_status", { ...walk, skip_blocked: true });
  check(
    "skip_blocked ships the passing member and leaves the blocked ones where they were",
    r.lines.length === 1 &&
      r.lines[0] === "f-ok: draft -> stable" &&
      (await state("f-ok")).state === "stable" &&
      (await state("f-bad")).state === "draft" &&
      (await state("i-mixed")).state === "draft" &&
      r.blocked.map((b) => b.node_id).join(",") === "f-bad,i-mixed",
    JSON.stringify(r)
  );

  const none = await blocked("update_node_status", { ...walk, skip_blocked: true });
  check(
    "a skip_blocked walk where every node is blocked writes nothing",
    !!none && none.includes("nothing was written") && (await state("f-bad")).state === "draft",
    String(none)
  );
  const stray = await blocked("update_node_status", { node_id: "f-bad", new_status: "ready", skip_blocked: true });
  check("skip_blocked outside a scoped walk is Blocked", !!stray, String(stray));
}

// --- item 11: ship part of a change (scope change + nodes); batches that keep going; the change hint ---
{
  for (const id of ["f-p1", "f-p2", "f-p3"]) {
    await call("create_node", { id, type: "Foundation", title: id, description: `Infra — ${id}`, role: "infra", change: "part" });
    fillAndTick("foundations", id);
    write(`src/${id}/x.ts`, id === "f-p3" ? 'import { b } from "../i-b/b.js";\nexport const x = b;\n' : "export const x = 1;\n");
    await call("set_implementation_files", { replace: true, node_id: id, files: [`src/${id}/`] });
  }
  await call("create_node", { id: "i-p", type: "Interaction", title: "Part", description: "User does part", change: "part" });
  await call("link_nodes", { source_id: "i-p", target_id: "j-app", edge_type: "belongs_to" });
  await call("link_nodes", { source_id: "i-p", target_id: "f-p3", edge_type: "depends_on" });
  fillAndTick("interactions", "i-p");
  write("src/i-p/p.ts", "export const p = 1;\n");
  await call("set_implementation_files", { replace: true, node_id: "i-p", files: ["src/i-p/"] });
  const walk = { scope: "change", change: "part", new_status: "ship", skip_review: true };

  const stranger = await blocked("update_node_status", { ...walk, nodes: ["f-p1", "f-ok"] });
  check(
    "scope change with a nodes entry that is not a member is Blocked naming the members",
    !!stranger && stranger.includes('"f-ok"') && ["f-p1", "f-p2", "f-p3", "i-p"].every((id) => stranger.includes(`"${id}"`)),
    String(stranger)
  );
  const stray = await blocked("update_node_status", { scope: "all_open_updates", new_status: "ready", nodes: ["f-p1"] });
  check("nodes outside scope change is Blocked", !!stray, String(stray));

  const unlisted = await blocked("update_node_status", { ...walk, nodes: ["f-p1", "i-p"] });
  check(
    "a listed node whose dependency in the same change is unlisted is refused by the gate",
    !!unlisted && unlisted.includes("Infrastructure First") && unlisted.includes('"f-p3"') &&
      (await state("f-p1")).state === "draft",
    String(unlisted)
  );
  const partial = await call("update_node_status", { ...walk, nodes: ["f-p1", "i-p"], skip_blocked: true, dry_run: true });
  check(
    "nodes works with skip_blocked and dry_run",
    partial.plan.every((l) => l.startsWith("f-p1:")) && partial.blocked.map((b) => b.node_id).join() === "i-p",
    JSON.stringify(partial)
  );

  const dry = await call("update_node_status", { ...walk, nodes: ["f-p1", "f-p2"], dry_run: true });
  check(
    "a dry run with nodes plans only the listed members",
    dry.blocked === null && dry.plan.length > 0 && dry.plan.every((l) => l.startsWith("f-p1:") || l.startsWith("f-p2:")),
    JSON.stringify(dry)
  );
  const r = await call("update_node_status", { ...walk, nodes: ["f-p1", "f-p2"] });
  check(
    "scope change with nodes ships the listed members and leaves the others",
    r.lines.join() === "f-p1: draft -> stable,f-p2: draft -> stable" &&
      (await state("f-p3")).state === "draft" &&
      (await state("i-p")).state === "draft" &&
      r.skipped_review?.join() === "f-p1,f-p2",
    JSON.stringify(r)
  );

  // A batch keeps going past a Blocked item and reports per node.
  for (const id of ["f-t1", "f-t2", "f-t3"]) {
    await call("create_node", { id, type: "Foundation", title: id, description: `Infra — ${id}`, role: "infra", change: "trio" });
    fillAndTick("foundations", id);
    write(`src/${id}/x.ts`, id === "f-t2" ? 'import { b } from "../i-b/b.js";\nexport const x = b;\n' : "export const x = 1;\n");
    await call("set_implementation_files", { replace: true, node_id: id, files: [`src/${id}/`] });
  }
  const trio = (new_status) => ({ revisions: ["f-t1", "f-t2", "f-t3"].map((node_id) => ({ node_id, new_status })) });
  const allMoved = await call("update_node_status", trio("ready"));
  check(
    "a batch where every item moved carries no partial or blocked_count",
    allMoved.partial === undefined && allMoved.blocked_count === undefined,
    JSON.stringify(allMoved)
  );
  await call("update_node_status", trio("in-progress"));
  const batch = await call("update_node_status", trio("in-review"));
  check(
    "a batch whose middle item is Blocked moves the other two and reports per node",
    batch.lines?.join() === "f-t1: in-progress -> in-review,f-t3: in-progress -> in-review" &&
      batch.results?.length === 3 &&
      batch.results[0].ok === true && batch.results[0].line === "f-t1: in-progress -> in-review" &&
      batch.results[1].node_id === "f-t2" && batch.results[1].ok === false && batch.results[1].blocked?.includes("imports:") &&
      batch.results[2].ok === true &&
      (await state("f-t2")).state === "in-progress" &&
      (await state("f-t3")).state === "in-review" &&
      batch.changed_files?.length > 0,
    JSON.stringify(batch)
  );
  check(
    "a batch where some items moved and some were Blocked says partial: true and blocked_count at the top",
    batch.partial === true && batch.blocked_count === 1,
    JSON.stringify({ partial: batch.partial, blocked_count: batch.blocked_count })
  );
  const batchDry = await call("update_node_status", { ...trio("in-review"), dry_run: true });
  check(
    "a batch dry run tries every item too",
    batchDry.results?.length === 3 && batchDry.results.filter((x) => !x.ok).length === 3,
    JSON.stringify(batchDry)
  );
  const none = await blocked("update_node_status", {
    revisions: [{ node_id: "f-t2", new_status: "in-review" }, { node_id: "f-t1", new_status: "draft" }],
  });
  check(
    "a batch where no item moves is Blocked listing every reason",
    !!none && none.includes('"f-t2"') && none.includes('"f-t1"') && none.includes("imports:"),
    String(none)
  );

  const hint = 'To move the whole change: update_node_status({ scope: "change", change: "trio", new_status: "in-review" })';
  const single = await blocked("update_node_status", { node_id: "f-t2", new_status: "in-review" });
  check("a single-node Blocked for a change member ends with the change hint", !!single && single.trimEnd().endsWith(hint), String(single));
  check("a batch Blocked for a change member ends with the change hint", !!none && none.trimEnd().endsWith(hint), String(none));
  check("a batch result's blocked reason carries the change hint", batch.results?.[1]?.blocked?.trimEnd().endsWith(hint), JSON.stringify(batch.results));
  const shipHint = await blocked("update_node_status", { node_id: "f-t2", new_status: "ship" });
  check(
    "the ship hint adds skip_review when the node is not in-review",
    !!shipHint &&
      shipHint.trimEnd().endsWith(
        'To move the whole change: update_node_status({ scope: "change", change: "trio", new_status: "ship", skip_review: true })'
      ),
    String(shipHint)
  );
  await call("create_node", { id: "f-lone", type: "Foundation", title: "Lone", description: "Infra — lone", role: "infra" });
  const noChange = await blocked("update_node_status", { node_id: "f-lone", new_status: "ship" });
  check("a node outside any change gets no hint", !!noChange && !noChange.includes("To move the whole change"), String(noChange));
}

// --- checklist kinds: review and deploy items wait on people ---
{
  const read = (file) => fs.readFileSync(file, "utf-8");
  await call("create_node", { id: "f-hum", type: "Foundation", title: "Human", description: "Infra — human", role: "infra", change: "human" });
  await call("create_node", { id: "i-hum", type: "Interaction", title: "Hum", description: "Action hum" });
  await call("link_nodes", { source_id: "i-hum", target_id: "j-app", edge_type: "belongs_to" });
  await call("link_nodes", { source_id: "i-hum", target_id: "f-hum", edge_type: "depends_on" });
  write("src/f-hum/index.ts", "export const hum = 1;\n");
  write("src/i-hum/h.ts", 'import { hum } from "../f-hum/index.js";\nexport const h = hum;\n');
  await call("set_implementation_files", { replace: true, node_id: "f-hum", files: ["src/f-hum/"] });
  await call("set_implementation_files", { replace: true, node_id: "i-hum", files: ["src/i-hum/"] });
  fillAndTick("foundations", "f-hum");
  fillAndTick("interactions", "i-hum");
  const humFile = territory("foundations", "f-hum");
  check(
    "default Atomic Ops carry the ids spec, impl, verify",
    /- \[x\] Spec written \{#spec\}/.test(read(humFile)) &&
      /- \[x\] Implementation complete \{#impl\}/.test(read(humFile)) &&
      /- \[x\] Verified in target environment \{#verify\}/.test(read(humFile)),
    read(humFile)
  );

  const added = await call("patch_node_territory", {
    node_id: "f-hum",
    add_checklist_items: [
      { text: "Security review", id: "sec", kind: "review" },
      { text: "Deploy to staging", kind: "deploy" },
    ],
  });
  check(
    "add_checklist_items appends tagged items to the Atomic Ops",
    added.patched_fields?.includes("add_checklist_items") &&
      /\{#verify\}\r?\n- \[ \] Security review \{#sec review\}\r?\n- \[ \] Deploy to staging \{#deploy-to-staging deploy\}/.test(read(humFile)),
    read(humFile)
  );
  const dup = await blocked("patch_node_territory", { node_id: "f-hum", add_checklist_items: [{ text: "Again", id: "sec" }] });
  check("a duplicate checklist id is Blocked", !!dup && dup.includes('"sec"'), String(dup));

  await walk("f-hum", ["ready", "in-progress", "in-review"]);
  const early = await blocked("update_node_status", { node_id: "f-hum", new_status: "ship" });
  check("a node with an open review item cannot ship (Completion Check)", !!early && early.includes("Completion Check"), String(early));

  const r = await call("run_check", {});
  const line = r.info?.find((l) => l.startsWith("waiting on people:"));
  check(
    "run_check lists the open review and deploy items in one info line",
    line === "waiting on people: f-hum: sec (review), deploy-to-staging (deploy)" &&
      r.output.includes("Info: waiting on people: f-hum: sec (review), deploy-to-staging (deploy)"),
    JSON.stringify(r.info)
  );
  const oriented = await call("orient_for_work", { node_id: "f-hum" });
  check(
    "orient_for_work on the node returns its open items",
    JSON.stringify(oriented.open_items) ===
      JSON.stringify([
        { node_id: "f-hum", id: "sec", kind: "review", text: "Security review" },
        { node_id: "f-hum", id: "deploy-to-staging", kind: "deploy", text: "Deploy to staging" },
      ]),
    JSON.stringify(oriented.open_items)
  );
  const byChange = await call("orient_for_work", { change: "human" });
  check("orient_for_work on the change returns one list", byChange.open_items?.length === 2, JSON.stringify(byChange.open_items));
  const plain = await call("orient_for_work", { node_id: "i-hum" });
  check("a node with no open human items has no open_items", plain.open_items === undefined, JSON.stringify(plain.open_items));

  // A build item unticked: the dependency still holds up its dependent.
  await walk("i-hum", ["ready", "in-progress", "in-review"]);
  await call("patch_node_territory", { node_id: "f-hum", toggle_checkboxes: [{ id: "impl", checked: false }] });
  const held = await blocked("update_node_status", { node_id: "i-hum", new_status: "ship" });
  check("a dependency in-review with an unticked build item holds up its dependent", !!held && held.includes("Infrastructure First") && held.includes("f-hum"), String(held));
  await call("patch_node_territory", { node_id: "f-hum", toggle_checkboxes: [{ id: "impl", checked: true }] });
  const dependent = await call("update_node_status", { node_id: "i-hum", new_status: "ship" });
  check(
    "a dependency in-review with every build item ticked lets its dependent ship",
    dependent.new_state === "stable" && (await state("f-hum")).state === "in-review",
    JSON.stringify(dependent)
  );
  const still = await blocked("update_node_status", { node_id: "f-hum", new_status: "ship" });
  check("the dependency itself still cannot ship until its review items are ticked", !!still && still.includes("Completion Check"), String(still));
  await call("patch_node_territory", {
    node_id: "f-hum",
    toggle_checkboxes: [{ id: "sec", note: "reviewed by security" }, { id: "deploy-to-staging", checked: true }],
  });
  const after = await call("run_check", {});
  check("ticked items leave the waiting line", !after.info?.some((l) => l.startsWith("waiting on people:")), JSON.stringify(after.info));
  const shippedHum = await call("update_node_status", { node_id: "f-hum", new_status: "ship" });
  check("with every item ticked the dependency ships", shippedHum.new_state === "stable", JSON.stringify(shippedHum));
}

/** A Foundation (or Interaction) with a claimed file, filled and ticked. */
async function builtNode(id, type = "Foundation", extra = {}) {
  const kind = type === "Foundation" ? "foundations" : "interactions";
  await call("create_node", {
    id,
    type,
    title: `Node ${id}`,
    description: type === "Foundation" ? `Infra — ${id}` : `Action ${id}`,
    ...(type === "Foundation" ? { role: "infra" } : {}),
    ...extra,
  });
  if (type === "Interaction") await call("link_nodes", { source_id: id, target_id: "j-app", edge_type: "belongs_to" });
  write(`src/${id}/index.ts`, `export const v = 1;\n`);
  await call("set_implementation_files", { replace: true, node_id: id, files: [`src/${id}/`] });
  fillAndTick(kind, id);
  return territory(kind, id);
}

// --- every counted checkbox toggles: an Acceptance Criteria box ticks by exact text ---
{
  const file = await builtNode("f-ac");
  const text = fs.readFileSync(file, "utf-8");
  fs.writeFileSync(file, text.replace("## Atomic Ops", "## Acceptance Criteria\n\n- [ ] Handles empty input\n\n## Atomic Ops"));
  await walk("f-ac", ["ready", "in-progress", "in-review"]);
  const held = await blocked("update_node_status", { node_id: "f-ac", new_status: "ship" });
  check("an unticked Acceptance Criteria box holds the ship (Completion Check)", !!held && held.includes("Completion Check"), String(held));
  const part = await blocked("patch_node_territory", { node_id: "f-ac", toggle_checkboxes: [{ contains: "empty input", checked: true }] });
  check("a substring of an Acceptance Criteria box is still Blocked", !!part && part.includes("exact text"), String(part));
  const ticked = await call("patch_node_territory", { node_id: "f-ac", toggle_checkboxes: [{ contains: "Handles empty input", checked: true }] });
  check("an Acceptance Criteria box ticks by its exact text", ticked.toggled?.[0] === "- [x] Handles empty input", JSON.stringify(ticked));
  const shipped = await call("update_node_status", { node_id: "f-ac", new_status: "ship" });
  check("then the node ships", shipped.new_state === "stable", JSON.stringify(shipped));
}

// --- the relaxed dependency rule is transitive, needs items, and cannot be undone under a shipped dependent ---
{
  // f-base (in-progress) <- f-mid (in-review, build ticked) <- i-top (in-review).
  await builtNode("f-base");
  await walk("f-base", ["ready", "in-progress"]);
  await builtNode("f-mid");
  await call("link_nodes", { source_id: "f-mid", target_id: "f-base", edge_type: "depends_on" });
  await walk("f-mid", ["ready", "in-progress", "in-review"]);
  await builtNode("i-top", "Interaction");
  await call("link_nodes", { source_id: "i-top", target_id: "f-mid", edge_type: "depends_on" });
  write("src/i-top/index.ts", 'import { v } from "../f-mid/index.js";\nexport const t = v;\n');
  await walk("i-top", ["ready", "in-progress", "in-review"]);
  const transitive = await blocked("update_node_status", { node_id: "i-top", new_status: "ship" });
  check(
    "an in-review dependency whose own dependency is in-progress does not count (transitive)",
    !!transitive && transitive.includes("Infrastructure First") && transitive.includes('"f-mid"'),
    String(transitive)
  );
  await walk("f-base", ["in-review"]);
  const shipped = await call("update_node_status", { node_id: "i-top", new_status: "ship" });
  check("once every dependency down the chain is in-review with build items ticked, the dependent ships", shipped.new_state === "stable", JSON.stringify(shipped));

  const cancel = await blocked("update_node_status", { node_id: "f-mid", new_status: "cancelled" });
  check(
    "cancelling a dependency a shipped node relies on is Blocked, naming the dependent and both fixes",
    !!cancel && cancel.includes('"i-top"') && cancel.includes("force_unship") && cancel.includes("Ship"),
    String(cancel)
  );
  const back = await blocked("update_node_status", { node_id: "f-mid", new_status: "in-progress" });
  check(
    "moving a relied-on dependency back from in-review is Blocked, naming the dependent and both fixes",
    !!back && back.includes('"i-top"') && back.includes("back from in-review") && back.includes("force_unship") &&
      (await state("f-mid")).state === "in-review",
    String(back)
  );
  const untick = await blocked("patch_node_territory", { node_id: "f-mid", toggle_checkboxes: [{ id: "impl", checked: false }] });
  check(
    "unticking a build item of a relied-on dependency in review is Blocked, naming the dependent",
    !!untick && untick.includes('"i-top"') && untick.includes('"impl"') && untick.includes("force_unship") &&
      /- \[x\] Implementation complete \{#impl\}/.test(fs.readFileSync(territory("foundations", "f-mid"), "utf-8")),
    String(untick)
  );
  const retick = await raw("patch_node_territory", { node_id: "f-mid", toggle_checkboxes: [{ id: "impl", note: "still done" }] });
  check("annotating a ticked build item of a relied-on dependency stays allowed", !retick.error, retick.text);
  // Every edit is judged on the body it leaves, not only toggle_checkboxes.
  const midBefore = fs.readFileSync(territory("foundations", "f-mid"), "utf-8");
  const addBuild = await blocked("patch_node_territory", { node_id: "f-mid", add_checklist_items: [{ text: "One more step", id: "more" }] });
  const replaceUntick = await blocked("patch_node_territory", {
    node_id: "f-mid",
    replace: { find: "- [x] Implementation complete", with: "- [ ] Implementation complete" },
  });
  const replaceDrop = await blocked("patch_node_territory", {
    node_id: "f-mid",
    replace: { find: midBefore.match(/^- \[x\] Implementation complete.*$/m)[0], with: "" },
  });
  // A toggle naming an item the same call's section edit adds still runs the guard on the result.
  const sectionUntick = await blocked("patch_node_territory", {
    node_id: "f-mid",
    section: "## Atomic Ops",
    text: "- [ ] Implementation complete {#impl}\n- [ ] Fresh {#fresh}",
    toggle_checkboxes: [{ id: "fresh", checked: true }],
  });
  check(
    "adding an unticked build item, or a replace or section edit that unticks or drops one, of a relied-on dependency in review is Blocked",
    [addBuild, replaceUntick, replaceDrop, sectionUntick].every((b) => !!b && b.includes('"i-top"') && b.includes("force_unship")) &&
      fs.readFileSync(territory("foundations", "f-mid"), "utf-8") === midBefore,
    JSON.stringify({ addBuild, replaceUntick, replaceDrop, sectionUntick })
  );
  const addReview = await raw("patch_node_territory", { node_id: "f-mid", add_checklist_items: [{ text: "QA sign-off", id: "qa", kind: "review" }] });
  check("adding a review item to a relied-on dependency in review stays allowed", !addReview.error, addReview.text);
  // The guard is exact: a slot whose build items were all done may not end the call with a build
  // item not done or fewer done. A ticked item reworded in place, or a ticked one added, passes.
  const implLine = fs.readFileSync(territory("foundations", "f-mid"), "utf-8").match(/^- \[x\] Implementation complete.*$/m)[0];
  const addTicked = await raw("patch_node_territory", {
    node_id: "f-mid",
    replace: { find: implLine, with: `${implLine}\n- [x] Wire it up` },
  });
  check("adding a ticked build item to a relied-on dependency in review stays allowed", !addTicked.error, addTicked.text);
  const reword = await raw("patch_node_territory", {
    node_id: "f-mid",
    replace: { find: "- [x] Wire it up", with: "- [x] Wire it all up" },
  });
  check(
    "rewording a ticked untagged build item that stays ticked, on a relied-on dependency in review, is allowed",
    !reword.error && /- \[x\] Wire it all up/.test(fs.readFileSync(territory("foundations", "f-mid"), "utf-8")),
    reword.text
  );
  const midFile = territory("foundations", "f-mid");
  const midReworded = fs.readFileSync(midFile, "utf-8");
  const addTwin = await blocked("patch_node_territory", { node_id: "f-mid", add_checklist_items: [{ text: "Wire it all up" }] });
  check(
    "adding an unticked build item whose text equals a ticked one, on a relied-on dependency in review, is Blocked, naming it",
    !!addTwin && addTwin.includes('"i-top"') && addTwin.includes('not done after this call: "Wire it all up";') &&
      fs.readFileSync(midFile, "utf-8") === midReworded,
    String(addTwin)
  );
  // A swap keeps the done count: unticking a done item while adding a ticked one is still Blocked,
  // naming the item not done.
  const swap = await blocked("patch_node_territory", {
    node_id: "f-mid",
    replace: { find: "- [x] Wire it all up", with: "- [ ] Wire it all up\n- [x] Polish {#polish}" },
  });
  check(
    "swapping a tick (untick a done build item, add a ticked one) on a relied-on dependency in review is Blocked, naming the unticked item",
    !!swap && swap.includes('"i-top"') && swap.includes('not done after this call: "Wire it all up" (was done)') && !swap.includes('"polish"') &&
      swap.includes("done build items 4 before, 4 after") && fs.readFileSync(midFile, "utf-8") === midReworded,
    String(swap)
  );
  // Untick, reword, and tick in one call: the reworded item is not done, so it is Blocked whatever
  // its label became.
  const untickRewordTick = await blocked("patch_node_territory", {
    node_id: "f-mid",
    replace: { find: "- [x] Wire it all up", with: "- [ ] Wire it up again\n- [ ] Polish {#polish}" },
    toggle_checkboxes: [{ id: "polish", checked: true }],
  });
  check(
    "unticking and rewording one build item while ticking another, on a relied-on dependency in review, is Blocked, naming the reworded item",
    !!untickRewordTick && untickRewordTick.includes('"i-top"') && untickRewordTick.includes('not done after this call: "Wire it up again";') &&
      !untickRewordTick.includes('"polish"') && fs.readFileSync(midFile, "utf-8") === midReworded,
    String(untickRewordTick)
  );
  // Rewording one done item while removing another: the done count falls, stated outright.
  const implNow = midReworded.match(/^- \[x\] Implementation complete.*$/m)[0];
  const rewordDrop = await blocked("patch_node_territory", {
    node_id: "f-mid",
    replace: { find: `${implNow}\n- [x] Wire it all up`, with: "- [x] Wire everything up" },
  });
  check(
    "rewording one done build item while removing another is Blocked, stating the done count change",
    !!rewordDrop && rewordDrop.includes('"i-top"') && rewordDrop.includes("done build items 4 before, 3 after") &&
      !rewordDrop.includes("not done after") && !rewordDrop.includes("possibly") && fs.readFileSync(midFile, "utf-8") === midReworded,
    String(rewordDrop)
  );
  // A slot that already had an open build item was not relied on: its build items are not guarded.
  // (The open item is written straight in: adding it through the tool is Blocked.)
  fs.writeFileSync(midFile, midReworded.replace(/^(- \[x\] Wire it all up.*)$/m, "$1\n- [ ] Polish {#polish}"));
  const openSwap = await raw("patch_node_territory", {
    node_id: "f-mid",
    toggle_checkboxes: [
      { id: "polish", checked: true },
      { contains: "Wire it all up", checked: false },
    ],
  });
  check(
    "build item edits on a relied-on dependency in review that already had an open build item are allowed",
    !openSwap.error && /- \[ \] Wire it all up/.test(fs.readFileSync(midFile, "utf-8")),
    openSwap.text
  );
  fs.writeFileSync(midFile, midReworded);

  // A dependency with no checklist item at all proves nothing.
  // (The shape gate needs a box to reach in-review, so the boxes go after the walk.)
  const bareFile = await builtNode("f-bare");
  await walk("f-bare", ["ready", "in-progress", "in-review"]);
  fs.writeFileSync(bareFile, fs.readFileSync(bareFile, "utf-8").replace(/^\s*[-*+]\s+\[[ xX]\].*$/gm, ""));
  await builtNode("i-bare", "Interaction");
  await call("link_nodes", { source_id: "i-bare", target_id: "f-bare", edge_type: "depends_on" });
  await walk("i-bare", ["ready", "in-progress", "in-review"]);
  const bare = await blocked("update_node_status", { node_id: "i-bare", new_status: "ship" });
  check("an in-review dependency with no checklist items does not count", !!bare && bare.includes('"f-bare"'), String(bare));

  // discard_next of an unstable node's revision while a shipped node depends on it.
  await builtNode("f-unst");
  await walk("f-unst", ["ready", "in-progress", "in-review", "ship"]);
  await builtNode("i-unst", "Interaction");
  await call("link_nodes", { source_id: "i-unst", target_id: "f-unst", edge_type: "depends_on" });
  await walk("i-unst", ["ready", "in-progress", "in-review", "ship"]);
  await call("create_node", { id: "bug-unst", type: "Bug", title: "Unst bug", description: "The unst value is wrong." });
  await call("link_nodes", { source_id: "bug-unst", target_id: "f-unst", edge_type: "affects" });
  check("the bug makes f-unst unstable", (await state("f-unst")).state === "unstable");
  // The revision claims a file live does not, and the shipped dependent imports it: it relied on
  // the revision's view, so the discard is Blocked.
  await call("open_next", { node_id: "f-unst", change: "unst-fix" });
  write("app/f-unst/extra.ts", "export const extra = 2;\n");
  await call("set_implementation_files", { node_id: "f-unst", change: "unst-fix", add: ["app/f-unst/extra.ts"] });
  write("src/i-unst/index.ts", 'import { extra } from "../../app/f-unst/extra.js";\nexport const v = extra;\n');
  const discard = await blocked("discard_next", { node_id: "f-unst", change: "unst-fix" });
  check(
    "discard_next of a revision whose claims a shipped dependent imports is Blocked, naming the dependent and the import",
    !!discard && discard.includes('"i-unst"') && discard.includes("app/f-unst/extra.ts") && discard.includes("force_unship"),
    String(discard)
  );
  // A dependent that rests on live alone does not hold the discard.
  write("src/i-unst/index.ts", "export const v = 1;\n");
  const discarded = await raw("discard_next", { node_id: "f-unst", change: "unst-fix" });
  check(
    "discard_next of a revision no shipped dependent relies on is allowed, even while the node is unstable",
    !discarded.error && JSON.parse(discarded.text).discarded === true,
    discarded.text
  );
  remove("app/f-unst");
}

await client.close();
if (failures > 0) {
  console.log(`\nhonesty.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nhonesty.test.mjs: all ok");
