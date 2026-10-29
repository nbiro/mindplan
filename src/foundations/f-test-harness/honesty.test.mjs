/**
 * Graph-honesty coverage: readiness reset on contract writes, Blocked: Coverage with its fix,
 * next-slot imports, skip_review for scoped ship walks, unambiguous checkbox toggles with notes
 * and not-applicable reasons, change groups, glob claims, territory writes that put one blank
 * line below the frontmatter (collapsing older runs) and keep CRLF, and split route families.
 * Run via npm test.
 */
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
await call("create_node", { id: "j-app", type: "Journey", title: "App", description: "App area" });
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
await call("set_implementation_files", { node_id: "f-core", files: ["src/f-core/index.ts"] });
await call("set_implementation_files", { node_id: "i-a", files: ["src/i-a/"] });
await call("set_implementation_files", { node_id: "i-b", files: ["src/i-b/b.ts"] });
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
  const same = await call("set_implementation_files", { node_id: "i-a", files: ["src/i-a/"] });
  check("re-claiming the same files keeps a ready node ready", same.state === "ready" && !same.readiness_reset, JSON.stringify(same));
  write("src/i-a/more.ts", "export const more = 1;\n");
  const claimed = await call("set_implementation_files", { node_id: "i-a", files: ["src/i-a/a.ts", "src/i-a/more.ts"] });
  check("a claim on a ready node moves it to draft", claimed.state === "draft" && !!claimed.readiness_reset, JSON.stringify(claimed));
  await call("set_implementation_files", { node_id: "i-a", files: ["src/i-a/"] });

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
  await call("open_next", { node_id: "f-core" });
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
  await call("set_implementation_files", { node_id: "f-tog", files: ["src/f-tog/"] });
  fillAndTick("foundations", "f-tog");
  const togFile = territory("foundations", "f-tog");
  const ops = "- [ ] Write docs\n- [ ] Write tests\n- [ ] Load test\n- [ ] Manual check\n";
  const filled = fs.readFileSync(togFile, "utf-8").replace(/^- \[x\] .*\r?\n?/gm, "");
  fs.writeFileSync(togFile, filled.replace(/(## Atomic Ops\r?\n\r?\n)/, `$1${ops}`));
  await walk("f-tog", ["ready", "in-progress"]);

  const ambiguous = await blocked("patch_node_territory", {
    node_id: "f-tog",
    toggle_checkboxes: [{ contains: "Write", checked: true }],
  });
  check(
    "an ambiguous toggle is Blocked and lists the matching lines",
    !!ambiguous && ambiguous.includes("matches 2 checkbox lines") && ambiguous.includes("- [ ] Write docs") && ambiguous.includes("- [ ] Write tests"),
    String(ambiguous)
  );
  const both = await call("patch_node_territory", {
    node_id: "f-tog",
    toggle_checkboxes: [{ contains: "Write", checked: true, all: true }],
  });
  check(
    "all: true toggles every match and returns the lines",
    both.toggled?.length === 2 && both.toggled.every((l) => l.startsWith("- [x] Write")) && both.state === "in-progress",
    JSON.stringify(both)
  );
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
    toggle_checkboxes: [{ contains: "- [x] Manual check", checked: false }],
  });
  check("a contains with the checkbox marker still matches, and unticking strips the note", untick.toggled?.[0] === "- [ ] Manual check", JSON.stringify(untick.toggled));
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
      shippedCov.includes('Fix: set_implementation_files({"node_id":"f-core","files":["src/f-core/extra.ts","src/f-core/index.ts"]})'),
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
      deepCov.includes('open_next({"node_id":"f-core"}) then set_implementation_files'),
    String(deepCov)
  );
  remove("src/f-core/sub");
}

// A released file (claimed live, dropped by the open next) that imports an Interaction is scanned.
{
  await call("create_node", { id: "f-rel", type: "Foundation", title: "Released", description: "Infra — released", role: "infra" });
  write("src/f-rel/keep.ts", "export const keep = 1;\n");
  write("src/f-rel/old.ts", "export const old = 1;\n");
  await call("set_implementation_files", { node_id: "f-rel", files: ["src/f-rel/keep.ts", "src/f-rel/old.ts"] });
  fillAndTick("foundations", "f-rel");
  await walk("f-rel", ["ready", "in-progress", "in-review", "ship"]);
  await call("open_next", { node_id: "f-rel" });
  await call("set_implementation_files", { node_id: "f-rel", files: ["src/f-rel/keep.ts"] });
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
  await call("set_implementation_files", { node_id: "f-quick", files: ["src/f-quick/"] });
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
  await call("set_implementation_files", { node_id: "f-cx", files: ["src/f-cx/"] });
  await call("set_implementation_files", { node_id: "i-cx", files: ["src/i-cx/"] });
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
  await call("set_implementation_files", { node_id: "i-read", files: ["src/templates/*/actions/i-read-post/"] });
  const impl = await call("get_node_implementation", { node_id: "i-read" });
  check(
    "a glob claim expands to the matching files in every template",
    impl.files?.length === 2 && impl.files.every((f) => f.path.endsWith("/actions/i-read-post/view.tsx") && f.exists),
    JSON.stringify(impl)
  );
  const owner = await call("get_node_implementation", { path: "src/templates/news/actions/i-read-post/view.tsx" });
  check("path lookup resolves through a glob claim", owner.owner?.node_id === "i-read", JSON.stringify(owner));

  await call("create_node", { id: "if-blog", type: "Interface", title: "Blog template", description: "Blog entry point" });
  const conflict = await blocked("set_implementation_files", { node_id: "if-blog", files: ["src/templates/blog/"] });
  check("an overlapping claim on a glob-claimed file is Blocked", !!conflict && conflict.includes("i-read"), String(conflict));
  await call("set_implementation_files", { node_id: "if-blog", files: ["src/templates/blog/layout.tsx"] });

  write("src/routes/[slug]/x.ts", "export const x = 1;\n");
  await call("set_implementation_files", { node_id: "i-b", files: ["src/i-b/", "src/routes/[slug]/x.ts"] });
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
  await call("set_implementation_files", { node_id: "f-lay", files: ["src/f-lay/"] });
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
  await call("open_next", { node_id: "f-lay" });
  await call("patch_node_territory", { node_id: "f-lay", section: "## Purpose", text: "Next purpose." });
  // open_next starts a fresh ledger, so the revision ticks its own ops before it ships.
  await call("patch_node_territory", { node_id: "f-lay", toggle_checkboxes: [{ contains: "- [ ]", checked: true, all: true }] });
  // A shipped Foundation's revision needs a decision before in-review; recording it is a write too.
  await call("record_decision", {
    node_id: "f-lay",
    decision: "The purpose stays one line.",
    alternatives: ["A longer purpose (this fixture only exercises the file layout)"],
    why: "The test checks bytes, not prose.",
  });
  check(
    "patches and a decision on an open next file keep its layout and CRLF",
    fromFence(layNext).startsWith("---\r\n\r\n# Layout") && !hasLf(fromFence(layNext)),
    JSON.stringify(fromFence(layNext).slice(0, 40))
  );
  await walk("f-lay", ["ready", "in-progress", "in-review", "ship"]);
  check(
    "shipping an evolution keeps one blank line after the frontmatter and the file CRLF",
    fromFence(layFile).startsWith("---\r\n\r\n# Layout") &&
      read(layFile).includes("Next purpose.") &&
      !hasLf(read(layFile)) &&
      !hasLf(read(layNext)),
    JSON.stringify(head(layFile))
  );
}

// --- runs of blank lines below the frontmatter (left by releases before 0.2.0) collapse ---
{
  await call("create_node", { id: "f-gap", type: "Foundation", title: "Gap", description: "Infra — gap", role: "infra" });
  write("src/f-gap/index.ts", "export const gap = 1;\n");
  await call("set_implementation_files", { node_id: "f-gap", files: ["src/f-gap/"] });
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

  // A discarded revision rewrites the twin from a live file that still has its run.
  await walk("f-gap", ["in-progress", "in-review", "ship"]);
  await call("open_next", { node_id: "f-gap" });
  seed("\n");
  await call("discard_next", { node_id: "f-gap" });
  const gapCheck = await call("run_check", {});
  check(
    "a twin restored from a live file with a run is not drift",
    blankRun(territory("foundations", "f-gap", "next")) === 1 &&
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
  await call("set_implementation_files", { node_id: "i-b", files: ["src/features/app/", "src/i-b/", "src/routes/[slug]/x.ts"] });
  write("app/sites/[site]/[lang]/blog/page.tsx", "export default function Page() { return null; }\n");
  write("app/sites/[site]/[lang]/blog/[slug]/page.tsx", "export default function Post() { return null; }\n");
  write("app/sites/[site]/[lang]/shop/page.tsx", "export default function Shop() { return null; }\n");
  await call("set_implementation_files", {
    node_id: "f-asm",
    files: ["app/layout.tsx", "app/sites/[site]/[lang]/blog/page.tsx", "app/sites/[site]/[lang]/shop/"],
  });
  await call("set_implementation_files", {
    node_id: "if-blog",
    files: ["app/sites/[site]/[lang]/blog/[slug]/page.tsx", "src/templates/blog/layout.tsx"],
  });
  let r = await call("run_check", {});
  const split = r.warnings.filter((w) => w.startsWith("routes:"));
  check(
    "a route family owned by the Assembler and an entry point warns once",
    split.length === 1 &&
      split[0].includes('"app/sites/[site]/[lang]/blog/"') &&
      split[0].includes('"f-asm" (Assembler)') &&
      split[0].includes('"if-blog" (entry point)'),
    JSON.stringify(r.warnings)
  );
  await call("set_implementation_files", { node_id: "if-blog", files: ["src/templates/blog/layout.tsx"] });
  await call("set_implementation_files", {
    node_id: "f-asm",
    files: ["app/layout.tsx", "app/sites/[site]/[lang]/blog/", "app/sites/[site]/[lang]/shop/"],
  });
  r = await call("run_check", {});
  check("one owner per route family does not warn", !r.warnings.some((w) => w.startsWith("routes:")), JSON.stringify(r.warnings));
  check("the sandbox graph passes the check", r.ok, r.output);
}

await client.close();
if (failures > 0) {
  console.log(`\nhonesty.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nhonesty.test.mjs: all ok");
