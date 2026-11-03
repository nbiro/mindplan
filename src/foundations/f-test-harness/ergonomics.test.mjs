/**
 * Agent-ergonomics coverage: run_check, import fixes at claim time, the ship gate, the
 * `mounts` composition root, small write responses, section patching, scoped status walks,
 * drift classes, stale-text warnings, and orient depth. Run via npm test.
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
// Spawned servers rank by keyword only: no model download or load during tests.
process.env.MINDPLAN_SEARCH ??= "keyword";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-ergo-"));
console.log("Ergonomics sandbox:", root);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, MINDPLAN_ROOT: root },
});
const client = new Client({ name: "ergo-test", version: "0.1.0" });
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
  // run_check is compact by default; the checks here read its full shape unless they pass compact.
  if (tool === "run_check") args = { compact: false, ...args };
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

function runCli(args) {
  return spawnSync(process.execPath, [serverEntry, ...args], {
    cwd: root,
    env: { ...process.env, MINDPLAN_ROOT: root },
    encoding: "utf-8",
  });
}

const territory = (kind, id) => path.join(root, "mindplan", kind, id, `${id}.mdx`);

/** Fill create_node scaffold stubs with real text and tick every checkbox. */
function fillAndTick(kind, id) {
  const file = territory(kind, id);
  let text = fs.readFileSync(file, "utf-8");
  text = text.replace(/^_.*?_$/gm, (line) =>
    line.includes("attachments/") ? line : "Ergonomics-test filled territory."
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

fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
fs.writeFileSync(
  path.join(root, "mindplan", "config.json"),
  JSON.stringify({ sources: ["src/**"], exclude: [] }, null, 2) + "\n"
);

// --- graph: a core Foundation, one Interaction, two template Interfaces, a registry Foundation ---
await call("create_node", { id: "j-app", type: "Capability", title: "App", description: "App area" });
await call("create_node", { id: "f-core", type: "Foundation", title: "Core", description: "Infra — core", role: "infra" });
await call("create_node", { id: "f-reg", type: "Foundation", title: "Registry", description: "Infra — template registry", role: "infra" });
await call("create_node", { id: "i-feature", type: "Interaction", title: "Feature", description: "A feature" });
await call("create_node", { id: "if-a", type: "Interface", title: "Template A", description: "Template A entry point" });
await call("create_node", { id: "if-b", type: "Interface", title: "Template B", description: "Template B entry point" });
await call("link_nodes", { source_id: "i-feature", target_id: "j-app", edge_type: "belongs_to" });
await call("link_nodes", { source_id: "i-feature", target_id: "f-core", edge_type: "depends_on" });
for (const id of ["if-a", "if-b"]) {
  await call("link_nodes", { source_id: id, target_id: "i-feature", edge_type: "exposes" });
  await call("link_nodes", { source_id: id, target_id: "f-core", edge_type: "depends_on" });
}
await call("link_nodes", { source_id: "f-reg", target_id: "f-core", edge_type: "depends_on" });

write("src/foundations/f-core/index.ts", "export const core = 1;\n");
write(
  "src/interactions/i-feature/feature.ts",
  'import { core } from "../../foundations/f-core/index.js";\nexport const feature = core;\n'
);
for (const id of ["if-a", "if-b"]) {
  write(
    `src/interfaces/${id}/index.ts`,
    'import { feature } from "../../interactions/i-feature/feature.js";\n' +
      `export const entry_${id.replace("-", "_")} = feature;\n`
  );
}
write(
  "src/foundations/f-reg/registry.ts",
  'import { entry_if_a } from "../../interfaces/if-a/index.js";\n' +
    'import { entry_if_b } from "../../interfaces/if-b/index.js";\n' +
    "export const registry = [entry_if_a, entry_if_b];\n"
);

await call("set_implementation_files", { node_id: "f-core", add: ["src/foundations/f-core/"] });
await call("set_implementation_files", { node_id: "i-feature", add: ["src/interactions/i-feature/"] });
await call("set_implementation_files", { node_id: "if-a", add: ["src/interfaces/if-a/"] });
await call("set_implementation_files", { node_id: "if-b", add: ["src/interfaces/if-b/"] });

// --- item 2 + 4: claiming a registry that imports Interfaces returns the mounts fix ---
{
  const claim = await call("set_implementation_files", {
    node_id: "f-reg",
    add: ["src/foundations/f-reg/"],
  });
  const violations = claim.import_violations ?? [];
  const mounted = violations.map((v) => v.fix?.args?.target_id).sort();
  check(
    "claiming a registry that imports Interfaces returns a mounts link_nodes fix per Interface",
    violations.length === 2 &&
      violations.every((v) => v.fix?.tool === "link_nodes" && v.fix.args.edge_type === "mounts") &&
      mounted.join(",") === "if-a,if-b",
    JSON.stringify(violations)
  );
}

// --- item 1: run_check matches the CLI ---
{
  const tool = await call("run_check", {});
  const cli = runCli(["check"]);
  const cliText = (cli.stderr || cli.stdout).trim();
  check("run_check reports the import violation", tool.ok === false && tool.failures.length === 2, JSON.stringify(tool.failures));
  check(
    "run_check output is the CLI check output",
    tool.output.trim() === cliText,
    `${tool.output} !== ${cliText}`
  );
  check(
    "illegal Foundation->Interface import names the mounts fix",
    tool.output.includes('"edge_type":"mounts"'),
    tool.output
  );
}

// --- item 4: a mounts edge makes exactly those imports legal ---
{
  const bad = await blocked("link_nodes", { source_id: "i-feature", target_id: "if-a", edge_type: "mounts" });
  check("mounts must go Foundation -> Interface", !!bad && bad.includes("Foundation -> Interface"), String(bad));
  await call("link_nodes", { source_id: "f-reg", target_id: "if-a", edge_type: "mounts" });
  const half = await call("run_check", {});
  check(
    "mounting one Interface leaves the other import blocked",
    half.ok === false && half.failures.length === 1 && half.failures[0].includes("if-b"),
    JSON.stringify(half.failures)
  );
  await call("link_nodes", { source_id: "f-reg", target_id: "if-b", edge_type: "mounts" });
  const full = await call("run_check", {});
  const cli = runCli(["check"]);
  check("a registry that mounts two Interfaces passes the check", full.ok === true && cli.status === 0, full.output);
  const view = await call("export_mindplan_view", { format: "mermaid" });
  check("mermaid view draws the mounts edge", JSON.stringify(view).includes("mounts"));
}

// --- item 3: small responses ---
{
  const slim = await call("link_nodes", { source_id: "f-core", target_id: "f-reg", edge_type: "depends_on" }).catch(
    (e) => e
  );
  // f-core -> f-reg would cycle (f-reg depends on f-core): Blocked, not a response.
  check("cyclic depends_on stays Blocked", slim instanceof Error && slim.message.includes("cycle"));
  const small = await raw("patch_node_territory", {
    node_id: "i-feature",
    description: "A feature (small response)",
  });
  const parsed = JSON.parse(small.text);
  check(
    "default write response is { node_id, state, next_state, changed_files }",
    parsed.node_id === "i-feature" &&
      parsed.state === "draft" &&
      parsed.next_state === null &&
      Array.isArray(parsed.changed_files) &&
      parsed.anchor === undefined &&
      parsed.drift === undefined,
    small.text.slice(0, 300)
  );
  check("a single write is under ~1k tokens", small.text.length < 3500, `${small.text.length} chars`);
  const verbose = await call("patch_node_territory", {
    node_id: "i-feature",
    description: "A feature",
    verbose: true,
  });
  check("verbose returns the record and neighborhood", !!verbose.anchor?.neighborhood && !!verbose.anchor?.record);
}

// --- item 6: section patching ---
{
  const file = territory("interactions", "i-feature");
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf-8").replace(/\r\n/g, "\n")
  );
  await call("patch_node_territory", {
    node_id: "i-feature",
    section: "## Purpose",
    text: "Rewritten purpose line.",
  });
  let body = fs.readFileSync(file, "utf-8");
  check(
    "section patch rewrites one section and keeps the others",
    body.includes("## Purpose\n\nRewritten purpose line.") &&
      body.includes("## Acceptance Criteria") &&
      body.includes("## Atomic Ops"),
    body.slice(0, 400)
  );
  await call("patch_node_territory", {
    node_id: "i-feature",
    replace: { find: "Rewritten purpose line.", with: "Replaced purpose line." },
  });
  body = fs.readFileSync(file, "utf-8");
  check("replace swaps one exact occurrence", body.includes("Replaced purpose line.") && !body.includes("Rewritten purpose"));
  const missing = await blocked("patch_node_territory", {
    node_id: "i-feature",
    section: "## Nope",
    text: "x",
  });
  check("unknown section is Blocked and lists the sections", !!missing && missing.includes('"## Purpose"'), String(missing));
  const ambiguous = await blocked("patch_node_territory", {
    node_id: "i-feature",
    replace: { find: "Check", with: "x" },
  });
  const notFound = await blocked("patch_node_territory", {
    node_id: "i-feature",
    replace: { find: "does-not-exist-anywhere", with: "x" },
  });
  check("replace is Blocked when the text is not found", !!notFound && notFound.includes("not found"), String(notFound));
  check("replace is Blocked when the text matches more than once or not at all", !!ambiguous || !!notFound);
  const rules = await blocked("patch_node_territory", { node_id: "i-feature", section: "## Rules", text: "x" });
  check("the Rules section cannot be patched as a section", !!rules && rules.includes("patch_node_rules"), String(rules));
  const both = await blocked("patch_node_territory", { node_id: "i-feature", section: "## Purpose" });
  check("section without text is Blocked", !!both);
}

// --- item 9: orient depth ---
{
  const rules = await call("orient_for_work", { node_id: "i-feature", depth: "rules" });
  check(
    "orient depth=rules returns rules and record only",
    rules.rules && rules.context?.record && rules.context.body === undefined && rules.blast_radius === undefined && rules.nodes === undefined,
    Object.keys(rules).join(",")
  );
  const withBody = await call("orient_for_work", { node_id: "i-feature", depth: "body" });
  check(
    "orient depth=body adds the body but not the blast radius",
    typeof withBody.context?.body === "string" && withBody.blast_radius === undefined
  );
  const full = await call("orient_for_work", { node_id: "i-feature" });
  check("orient defaults to full depth", !!full.blast_radius && Array.isArray(full.nodes));
}

// --- item 7 + 1: walk everything to ship in one call, with dry_run ---
for (const [kind, id] of [
  ["foundations", "f-core"],
  ["foundations", "f-reg"],
  ["interactions", "i-feature"],
  ["interfaces", "if-a"],
  ["interfaces", "if-b"],
]) {
  fillAndTick(kind, id);
}
// A parked plan: a draft node that already claims files is still a plan, not an update.
await call("create_node", { id: "f-parked", type: "Foundation", title: "Parked", description: "Infra — later work", role: "infra" });
write("src/foundations/f-parked/index.ts", "export const parked = 1;\n");
await call("set_implementation_files", { node_id: "f-parked", add: ["src/foundations/f-parked/"] });
for (const status of ["ready", "in-progress"]) {
  await call("update_node_status", {
    revisions: ["f-core", "f-reg", "i-feature", "if-a", "if-b"].map((node_id) => ({ node_id, new_status: status })),
  });
}
{
  const dry = await call("update_node_status", {
    scope: "all_open_updates",
    new_status: "ship",
    skip_review: true,
    dry_run: true,
  });
  check(
    "dry_run lists every transition in Foundation, Interaction, Interface order and writes nothing",
    dry.dry_run === true &&
      dry.blocked === null &&
      dry.plan.length === 10 &&
      dry.plan[0] === "f-core: in-progress -> in-review" &&
      dry.plan[1] === "f-core: in-review -> ship" &&
      dry.plan[2].startsWith("f-reg") &&
      dry.plan[4].startsWith("i-feature") &&
      dry.plan[6].startsWith("if-a") &&
      dry.plan[8].startsWith("if-b") &&
      dry.skipped_review?.length === 5,
    JSON.stringify(dry)
  );
  const stillBuilding = (await call("get_node_context", { node_id: "f-core" })).record.state;
  check("dry_run leaves the node untouched", stillBuilding === "in-progress", stillBuilding);
  check("a draft plan that claims files is not walked", !dry.plan.some((l) => l.startsWith("f-parked")), JSON.stringify(dry.plan));
}

// --- item 1: shipping a node whose file has an import violation is Blocked ---
{
  await call("create_node", { id: "f-extra", type: "Foundation", title: "Extra", description: "Infra — extra", role: "infra" });
  await call("create_node", { id: "i-bad", type: "Interaction", title: "Bad", description: "Imports an unlinked Foundation" });
  await call("link_nodes", { source_id: "i-bad", target_id: "j-app", edge_type: "belongs_to" });
  await call("link_nodes", { source_id: "i-bad", target_id: "f-core", edge_type: "depends_on" });
  write("src/foundations/f-extra/index.ts", "export const extra = 1;\n");
  write(
    "src/interactions/i-bad/bad.ts",
    'import { extra } from "../../foundations/f-extra/index.js";\nexport const bad = extra;\n'
  );
  await call("set_implementation_files", { node_id: "f-extra", add: ["src/foundations/f-extra/"] });
  const claim = await call("set_implementation_files", { node_id: "i-bad", add: ["src/interactions/i-bad/"] });
  const fix = claim.import_violations?.[0]?.fix;
  check(
    "claiming a file that imports an unlinked node returns the link_nodes call",
    fix?.tool === "link_nodes" &&
      fix.args.source_id === "i-bad" &&
      fix.args.target_id === "f-extra" &&
      fix.args.edge_type === "depends_on",
    JSON.stringify(claim.import_violations)
  );
  fillAndTick("interactions", "i-bad");
  await call("update_node_status", { node_id: "i-bad", new_status: "ready" });
  await call("update_node_status", { node_id: "i-bad", new_status: "in-progress" });
  const gate = await blocked("update_node_status", { node_id: "i-bad", new_status: "in-review" });
  check(
    "moving to in-review is Blocked on an import violation and names the fix",
    !!gate && gate.includes("Check failed") && gate.includes('"edge_type":"depends_on"'),
    String(gate)
  );
  const walk = await call("update_node_status", {
    scope: "node_and_dependents",
    node_id: "i-bad",
    new_status: "in-review",
    dry_run: true,
  });
  check("a scoped dry_run reports the same Blocked reason", typeof walk.blocked === "string" && walk.blocked.includes("Check failed"), JSON.stringify(walk));
  const real = await blocked("update_node_status", {
    scope: "all_open_updates",
    new_status: "ship",
    skip_review: true,
  });
  const afterCore = (await call("get_node_context", { node_id: "f-core" })).record.state;
  check(
    "a scoped walk validates everything before the first write",
    !!real && afterCore === "in-progress",
    `${real} / ${afterCore}`
  );
  // Fix the edge, then the whole open set ships in one call.
  await call("link_nodes", { source_id: "i-bad", target_id: "f-extra", edge_type: "depends_on" });
  fillAndTick("foundations", "f-extra");
  for (const status of ["ready", "in-progress"]) {
    await call("update_node_status", { node_id: "f-extra", new_status: status });
  }
}
{
  // Review stop first, then ship: a walk from in-progress straight to ship needs skip_review.
  await call("update_node_status", { scope: "all_open_updates", new_status: "in-review" });
  const shipped = await call("update_node_status", { scope: "all_open_updates", new_status: "ship" });
  const states = {};
  for (const id of ["f-core", "f-reg", "f-extra", "i-feature", "i-bad", "if-a", "if-b"]) {
    states[id] = (await call("get_node_context", { node_id: id })).record.state;
  }
  check(
    "one scoped call walks every open update to ship",
    Object.values(states).every((s) => s === "stable") && Array.isArray(shipped.lines) && shipped.lines.length === 7,
    JSON.stringify(states)
  );
  check(
    "a batch returns one line per node and stays small",
    shipped.lines.every((l) => /^[\w-]+: .+ -> .+$/.test(l)) && JSON.stringify(shipped).length < 3500,
    `${JSON.stringify(shipped).length} chars`
  );
  const cli = runCli(["check"]);
  check("check is green after the walk", cli.status === 0, cli.stderr || cli.stdout);
}

// --- item 5: drift classes ---
{
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf-8" });
  git("init");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("add", ".");
  git("commit", "-m", "baseline");
  write("src/foundations/f-core/index.ts", "export const core = 2;\n");
  write("src/orphan/x.ts", "export {};\n");
  const idle = await call("orient_for_work", { node_id: "f-core" });
  const hit = idle.drift?.paths?.find((p) => p.path.endsWith("f-core/index.ts"));
  check(
    "a shipped owner with no open update shows as owner_idle",
    hit?.class === "owner_idle" && hit.owner_id === "f-core",
    JSON.stringify(idle.drift)
  );
  check(
    "unowned files are listed",
    (idle.drift?.unowned ?? []).some((p) => p.endsWith("orphan/x.ts")),
    JSON.stringify(idle.drift)
  );
  await call("open_next", { change: "rev-f-core", node_id: "f-core" });
  await call("set_implementation_files", { node_id: "f-core", add: ["src/foundations/f-core/"] });
  await call("update_node_status", { node_id: "f-core", new_status: "ready" });
  await call("update_node_status", { node_id: "f-core", new_status: "in-progress" });
  const expected = await call("orient_for_work", { node_id: "f-core" });
  check(
    "a file claimed by an open update is expected: a count, not a listing",
    !(expected.drift?.paths ?? []).some((p) => p.path.endsWith("f-core/index.ts")),
    JSON.stringify(expected.drift)
  );
  // A second open revision: f-core has no single `next` view now, and each revision is read on
  // its own (live with its delta applied).
  write("src/f-core-extra/y.ts", "export const y = 1;\n");
  await call("open_next", { change: "rev-two", node_id: "f-core" });
  await call("set_implementation_files", { node_id: "f-core", change: "rev-two", add: ["src/f-core-extra/y.ts"] });
  const two = await call("orient_for_work", { node_id: "f-core" });
  const twoPaths = two.drift?.paths ?? [];
  check(
    "with two open revisions, a file the in-progress revision claims is still expected",
    !twoPaths.some((p) => p.path.endsWith("f-core/index.ts")) && (two.drift?.expected ?? 0) >= 1,
    JSON.stringify(two.drift)
  );
  const extra = twoPaths.find((p) => p.path === "src/f-core-extra/y.ts");
  check(
    "a file only a draft revision claims is owner_idle and names every open revision",
    extra?.class === "owner_idle" &&
      extra.owner_id === "f-core" &&
      JSON.stringify(extra.revisions) ===
        JSON.stringify([
          { change: "rev-f-core", state: "in-progress" },
          { change: "rev-two", state: "draft" },
        ]),
    JSON.stringify(two.drift)
  );
  const dirtyCheck = runCli(["check", "--base", "HEAD"]);
  const dirtyOut = dirtyCheck.stdout + dirtyCheck.stderr;
  check(
    "dirty-src allows the in-progress revision's file and describes the owner by its revisions",
    !dirtyOut.includes('dirty file "src/foundations/f-core/index.ts"') &&
      dirtyOut.includes(
        'dirty file "src/f-core-extra/y.ts" while "f-core" is "stable" (revisions: "rev-f-core" in-progress, "rev-two" draft)'
      ),
    dirtyOut
  );
  await call("discard_next", { node_id: "f-core", change: "rev-two" });
  fs.rmSync(path.join(root, "src", "f-core-extra"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "src", "foundations", "f-core", "index.ts"));
  const missing = await call("orient_for_work", { node_id: "f-core" });
  check(
    "a claimed file missing from disk shows as claimed_missing",
    (missing.drift?.paths ?? []).some((p) => p.class === "claimed_missing" && p.path.endsWith("f-core/index.ts")),
    JSON.stringify(missing.drift)
  );
  const scoped = await call("orient_for_work", { node_id: "if-a" });
  check(
    "drift is scoped to the focus node and counts the rest",
    !(scoped.drift?.paths ?? []).some((p) => p.owner_id === "f-core") && (scoped.drift?.other_count ?? 0) >= 1,
    JSON.stringify(scoped.drift)
  );
  write("src/foundations/f-core/index.ts", "export const core = 1;\n");
  git("checkout", "--", "src");
  fs.rmSync(path.join(root, "src", "orphan"), { recursive: true, force: true });
}

// --- item 8: stale-text warnings ---
{
  await call("patch_node_territory", {
    node_id: "f-core",
    section: "## Purpose",
    text:
      "Core substrate. Lives in `src/foundations/f-core/gone-file.ts` Also see `../elsewhere/notes.md`.\n\n" +
      "- [x] Wrote `src/foundations/f-core/moved-plain.ts`\n" +
      "- [x] Wrote `src/foundations/f-core/moved-noted.ts` — note: split later\n" +
      "- [X] Skipped `src/foundations/f-core/moved-na.ts` — n/a: never needed\n" +
      "- [x] Moved the parser into\n  `src/foundations/f-core/moved-indented.ts`\n" +
      "- [x] Moved the lexer into\n`src/foundations/f-core/moved-lazy.ts`\n" +
      "  - kept a shim at `src/foundations/f-core/moved-nested.ts`\n" +
      "- [ ] Write `src/foundations/f-core/open-item.ts`\n" +
      "- [x] Port `src/foundations/f-core/empty-na.ts` — n/a:\n\n" +
      "After the list, `src/foundations/f-core/after-list.ts` is prose.\n",
  });
  // A shipped Foundation's revision is decision-worthy: record one before review.
  await call("record_decision", {
    node_id: "f-core",
    decision: "Core keeps one exported constant.",
    alternatives: ["Export a config object (more surface than any caller needs)"],
    why: "Every dependent reads a single value.",
  });
  await call("update_node_status", { node_id: "f-core", new_status: "in-review" });
  const result = await call("run_check", {});
  check(
    "a body naming a path that no longer exists warns without failing the check",
    result.ok === true &&
      result.warnings.some((w) => w.includes("gone-file.ts")) &&
      !result.warnings.some((w) => w.includes("elsewhere")),
    JSON.stringify(result.warnings)
  );
  const closed = ["moved-plain", "moved-noted", "moved-na", "moved-indented", "moved-lazy", "moved-nested"];
  check(
    "a ticked checklist item naming a missing path does not warn, continuation lines included",
    !result.warnings.some((w) => closed.some((name) => w.includes(`${name}.ts`))),
    JSON.stringify(result.warnings)
  );
  const stillOpen = ["open-item", "empty-na", "after-list"];
  check(
    "an open item, an n/a tick with no reason, and prose after the list still warn",
    stillOpen.every((name) => result.warnings.some((w) => w.includes(`${name}.ts\``))),
    JSON.stringify(result.warnings)
  );
  const cli = runCli(["check"]);
  check("the CLI prints warnings and still exits 0", cli.status === 0 && (cli.stdout + cli.stderr).includes("Warning:"));
}

// --- get_mindplan_graph pages by offset / limit ---
{
  const whole = await call("get_mindplan_graph", {});
  check(
    "a graph that fits one page returns totals and no next_offset",
    whole.next_offset === undefined &&
      whole.total_nodes === whole.nodes.length &&
      whole.total_edges === whole.edges.length &&
      whole.offset === 0 &&
      whole.limit === 200,
    JSON.stringify({ n: whole.nodes.length, total: whole.total_nodes, next: whole.next_offset })
  );
  const seenNodes = [];
  const seenEdges = [];
  let offset = 0;
  let pages = 0;
  for (;;) {
    const page = await call("get_mindplan_graph", { offset, limit: 2 });
    pages++;
    seenNodes.push(...page.nodes.map((n) => n.id));
    seenEdges.push(...page.edges.map((e) => `${e.source}>${e.type}>${e.target}`));
    if (page.next_offset === undefined) break;
    check(`page ${pages} names the next offset`, page.next_offset === offset + page.nodes.length);
    offset = page.next_offset;
  }
  const allEdges = whole.edges.map((e) => `${e.source}>${e.type}>${e.target}`);
  check(
    "walking every page yields every node and every edge exactly once",
    pages === Math.ceil(whole.total_nodes / 2) &&
      new Set(seenNodes).size === seenNodes.length &&
      seenNodes.length === whole.total_nodes &&
      [...seenEdges].sort().join("|") === [...allEdges].sort().join("|"),
    JSON.stringify({ pages, seenNodes, seenEdges: seenEdges.length, allEdges: allEdges.length })
  );
  const past = await call("get_mindplan_graph", { offset: whole.total_nodes + 10, limit: 5 });
  check(
    "an offset past the end returns an empty page with the totals",
    past.nodes.length === 0 && past.edges.length === 0 && past.total_nodes === whole.total_nodes && past.next_offset === undefined
  );
  const tooBig = await raw("get_mindplan_graph", { limit: 501 });
  check("limit above 500 is rejected at the schema layer", tooBig.error, tooBig.text.slice(0, 120));
}

// --- export_mindplan_view: output file and the result budget ---
{
  const written = await call("export_mindplan_view", { output: "docs/map.mmd" });
  const onDisk = fs.readFileSync(path.join(root, "docs", "map.mmd"), "utf-8");
  const inline = await call("export_mindplan_view", {});
  check(
    "output writes the diagram and returns written_to without diagram",
    written.written_to === "docs/map.mmd" &&
      written.diagram === undefined &&
      written.node_count === inline.node_count &&
      onDisk === inline.diagram,
    JSON.stringify(written).slice(0, 200)
  );
  const outside = await blocked("export_mindplan_view", { output: "../escape.mmd" });
  const underMindplan = await blocked("export_mindplan_view", { output: "mindplan/view.mmd" });
  check("output outside the root is Blocked", outside !== null && outside.includes("inside the project root"), outside);
  check("output under mindplan/ is Blocked", underMindplan !== null && underMindplan.includes("mindplan/"), underMindplan);

  // Grow the graph past the budget: many Capabilities with long titles (labels carry the title).
  const filler = "x".repeat(900);
  for (let i = 0; i < 120; i++) {
    await call("create_node", { id: `j-big-${i}`, type: "Capability", title: `Big ${i} ${filler}`, description: `Big ${i}` });
  }
  const refused = await blocked("export_mindplan_view", {});
  check(
    "a diagram over the budget is Blocked with the size and both fixes",
    refused !== null &&
      /is \d+ characters, over the 80000 MCP result budget/.test(refused) &&
      refused.includes("focus") &&
      refused.includes("output"),
    refused
  );
  const focused = await call("export_mindplan_view", { focus: "i-feature" });
  check("focus still returns a diagram inline", typeof focused.diagram === "string" && focused.diagram.length > 0);
  const big = await call("export_mindplan_view", { output: "docs/big.mmd" });
  const bigOnDisk = fs.readFileSync(path.join(root, "docs", "big.mmd"), "utf-8");
  check("output writes the over-budget diagram in full", big.written_to === "docs/big.mmd" && bigOnDisk.length > 80000);
  const cliView = runCli(["view"]);
  check("the CLI prints the over-budget diagram without the budget", cliView.status === 0 && cliView.stdout.length > 80000);
}


// --- run_check output size: compact by default, seen warnings counted, acknowledged ones hidden ---
{
  const compactCall = async (args = {}) => {
    const res = await client.callTool({ name: "run_check", arguments: args });
    const text = res.content?.[0]?.text ?? "";
    if (res.isError) throw new Error(`run_check: ${text}`);
    return { text, json: JSON.parse(text) };
  };
  const long = (i, extra = "") =>
    `Visitor reads long capability ${i}${extra}: ` + "a description padded well past the search row limit ".repeat(8);
  for (let i = 0; i < 30; i++) {
    await call("create_node", { id: `j-long-${i}`, type: "Capability", title: `Long ${i}`, description: long(i) });
  }
  const fullText = (await raw("run_check", {})).text;
  const full = JSON.parse(fullText);
  // A full check records nothing: the first compact run of the session lists every warning.
  const listed = (await compactCall()).json;
  check(
    "a full check records nothing, so the first compact run lists every warning",
    listed.warnings.length === full.warnings.length && listed.unchanged === 0,
    JSON.stringify({ warnings: listed.warnings.length, unchanged: listed.unchanged, full: full.warnings.length })
  );
  check("compact run_check carries the info lines", JSON.stringify(listed.info) === JSON.stringify(full.info), JSON.stringify(listed.info));
  const first = await compactCall();
  const c = first.json;
  check(
    "compact run_check is the default: { ok, counts, failures, warnings, info, acknowledged, unchanged }, no output copy",
    typeof c.ok === "boolean" &&
      !("output" in c) &&
      Array.isArray(c.info) &&
      Array.isArray(c.failures) &&
      Array.isArray(c.warnings) &&
      typeof c.acknowledged === "number" &&
      typeof c.unchanged === "number" &&
      c.counts?.description >= 30,
    first.text.slice(0, 300)
  );
  check(
    `a second run lists seen warnings as unchanged (${Buffer.byteLength(first.text)} vs ${Buffer.byteLength(fullText)} bytes full)`,
    c.warnings.length === 0 &&
      c.unchanged === full.warnings.length &&
      Buffer.byteLength(first.text) * 10 < Buffer.byteLength(fullText),
    JSON.stringify({ warnings: c.warnings.length, unchanged: c.unchanged, full: full.warnings.length })
  );
  // New warnings come back as { id, text } objects, once.
  await call("create_node", { id: "j-long-new", type: "Capability", title: "Long new", description: long("new") });
  const fresh = (await compactCall()).json;
  const newOnes = fresh.warnings.filter((w) => w.text.includes('"j-long-new"'));
  check(
    "a new warning shows with a w- id and its text; the rest stay unchanged",
    newOnes.length >= 1 &&
      fresh.warnings.length === newOnes.length &&
      fresh.warnings.every((w) => /^w-[0-9a-f]{10}$/.test(w.id) && typeof w.text === "string") &&
      fresh.unchanged === full.warnings.length,
    JSON.stringify(fresh.warnings)
  );
  const again = (await compactCall()).json;
  check("and is unchanged on the next run", again.warnings.length === 0, JSON.stringify(again.warnings));

  // Acknowledged: hidden and counted until its text changes.
  const target = newOnes.find((w) => w.text.includes("characters"));
  const ack = await call("acknowledge_warning", { id: target.id });
  check("acknowledge_warning returns the acknowledged ids", JSON.stringify(ack.acknowledged) === JSON.stringify([target.id]), JSON.stringify(ack));
  const bad = await blocked("acknowledge_warning", { id: "nope" });
  check("acknowledge_warning Blocks an id that is not a warning id", bad !== null && bad.includes("w-"), String(bad));
  const acked = (await compactCall()).json;
  check(
    "an acknowledged warning is excluded and counted",
    acked.acknowledged === 1 && acked.unchanged === full.warnings.length + newOnes.length - 1,
    JSON.stringify(acked)
  );
  await call("patch_node_territory", { node_id: "j-long-new", description: long("new", " and more") });
  const changed = (await compactCall()).json;
  const reshown = changed.warnings.filter((w) => w.text.includes('"j-long-new"') && w.text.includes("characters"));
  check(
    "a changed text gets a new id and shows again",
    reshown.length === 1 && reshown[0].id !== target.id && changed.acknowledged === 0,
    JSON.stringify(changed)
  );

  // nodes scope: warnings for those nodes only; the rest counted as out_of_scope.
  await call("patch_node_territory", { node_id: "j-long-3", description: long(3, " rescoped") });
  await call("patch_node_territory", { node_id: "j-long-4", description: long(4, " rescoped") });
  const scoped = (await compactCall({ nodes: ["j-long-3"] })).json;
  check(
    "nodes limits warnings to those nodes and counts the rest as out_of_scope",
    scoped.warnings.length === 1 &&
      scoped.warnings[0].text.includes('"j-long-3"') &&
      scoped.counts.description === 1 &&
      scoped.counts.out_of_scope > 30,
    JSON.stringify(scoped)
  );
  const rescoped = (await compactCall({ nodes: ["j-long-3"] })).json;
  check(
    "a repeat scoped run still lists every warning of its nodes, counting them unchanged",
    rescoped.warnings.length === 1 && rescoped.warnings[0].text.includes('"j-long-3"') && rescoped.unchanged === 1,
    JSON.stringify(rescoped)
  );
  const later = (await compactCall()).json;
  check(
    "a scoped run marks only its own warnings seen: the out-of-scope new one shows on the next full run",
    later.warnings.length === 1 && later.warnings[0].text.includes('"j-long-4"'),
    JSON.stringify(later.warnings)
  );
  const scopedFull = await call("run_check", { nodes: ["j-long-3"] });
  check(
    "compact: false keeps the full shape (output, string warnings), scoped by nodes",
    typeof scopedFull.output === "string" &&
      scopedFull.warnings.every((w) => typeof w === "string" && w.includes('"j-long-3"')) &&
      scopedFull.warnings.length === 1,
    JSON.stringify(scopedFull.warnings)
  );
  await call("patch_node_territory", { node_id: "j-long-5", description: long(5, " unseen") });
  await call("run_check", {});
  const afterFull = (await compactCall()).json;
  check(
    "a compact: false check records nothing: the new warning still shows on the next compact run",
    afterFull.warnings.some((w) => w.text.includes('"j-long-5"')),
    JSON.stringify(afterFull.warnings)
  );
  check("no seen file is written", !fs.existsSync(path.join(root, ".mindplan-cache", "check-seen.json")));
  const cli = runCli(["check"]);
  check("the CLI keeps printing the full output", cli.status === 0 && (cli.stdout + cli.stderr).includes('Warning: description: "j-long-0"'));
}

await client.close();
fs.rmSync(root, { recursive: true, force: true });

if (failures > 0) {
  console.log(`ergonomics.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("ergonomics.test.mjs: all ok");
