/**
 * In-place claims on shipped nodes: set_implementation_files on a shipped node with no open next
 * accepts an additive list whose new entries sit in a folder the node dominates, writes the live
 * slot (and its mirror twin), and marks each new entry in `added_claims` until the body names it.
 * Every write here is also diffed against the sandbox: each mindplan/ file it touched must be in
 * its changed_files. Run via npm test.
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-shipped-claims-"));
console.log("Shipped-claims sandbox:", root);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, MINDPLAN_ROOT: root },
});
const client = new Client({ name: "shipped-claims-test", version: "0.1.0" });
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

/** Call a write tool and check that its changed_files covers every file it touched on disk. */
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

const liveOf = (kind, id) => `mindplan/${kind}/${id}/${id}.mdx`;
const twinOf = (kind, id) => `mindplan/${kind}/${id}/${id}.next.mdx`;
const readRel = (rel) => fs.readFileSync(path.join(root, ...rel.split("/")), "utf-8");

/** True when the twin is the live file with only `state:` changed to mirror. */
function twinInSync(kind, id) {
  const strip = (raw) => raw.replace(/^state:.*$/m, "state: <ignored>");
  const twin = readRel(twinOf(kind, id));
  return /^state: mirror$/m.test(twin) && strip(readRel(liveOf(kind, id))) === strip(twin);
}

/** The `added_claims` list in a live file's frontmatter. */
function addedClaims(kind, id) {
  const fm = readRel(liveOf(kind, id)).match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  const block = fm.match(/^added_claims:\r?\n((?:\s+-\s+.*(?:\r?\n|$))*)/m)?.[1] ?? "";
  return block
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s+-\s+/, "").trim())
    .filter(Boolean);
}

/** Fill create_node scaffold stubs with real text and tick every checkbox (before any twin exists). */
function fillAndTick(kind, id) {
  const file = path.join(root, "mindplan", kind, id, `${id}.mdx`);
  let text = fs.readFileSync(file, "utf-8");
  text = text.replace(/^_.*?_$/gm, (line) => (line.includes("attachments/") ? line : "Shipped-claims filled territory."));
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

async function walk(id, steps) {
  for (const new_status of steps) await call("update_node_status", { node_id: id, new_status });
}

const claimWarning = (warnings, id, entry) =>
  (warnings ?? []).some((w) => w.includes(`"${id}" claims \`${entry}\` added in place`));

fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
fs.writeFileSync(
  path.join(root, "mindplan", "config.json"),
  JSON.stringify({ sources: ["src/**"], exclude: [] }, null, 2) + "\n"
);

// --- base graph: two shipped Foundations; src/mixed/ holds a file of each ---
await call("create_node", { id: "f-core", type: "Foundation", title: "Core", description: "Infra — core", role: "infra" });
await call("create_node", { id: "f-other", type: "Foundation", title: "Other", description: "Infra — other", role: "infra" });
write("src/core/a.ts", "export const a = 1;\n");
write("src/mixed/c.ts", "export const c = 1;\n");
write("src/mixed/d.ts", "export const d = 1;\n");
write("src/shared/x.ts", "export const x = 1;\n");
await call("set_implementation_files", { node_id: "f-core", files: ["src/core/a.ts", "src/mixed/c.ts"] });
await call("set_implementation_files", { node_id: "f-other", files: ["src/mixed/d.ts", "src/shared/x.ts"] });
fillAndTick("foundations", "f-core");
fillAndTick("foundations", "f-other");
await walk("f-core", ["ready", "in-progress", "in-review", "ship"]);
await walk("f-other", ["ready", "in-progress", "in-review", "ship"]);
check("both Foundations start shipped with in-sync twins", twinInSync("foundations", "f-core") && twinInSync("foundations", "f-other"));

// Files written after ship: siblings no node claims yet.
write("src/core/new.ts", "export const n = 1;\n");
write("src/mixed/e.ts", "export const e = 1;\n");
write("src/elsewhere/z.ts", "export const z = 1;\n");

// --- additive sibling file on a shipped node with no open next ---
{
  const added = await call("set_implementation_files", {
    node_id: "f-core",
    files: ["src/core/a.ts", "src/core/new.ts", "src/mixed/c.ts"],
  });
  check(
    "a sibling file in a dominated folder is claimed in place on the live slot",
    added.slot === "current" &&
      JSON.stringify(added.added_in_place) === JSON.stringify(["src/core/new.ts"]) &&
      typeof added.hint === "string" &&
      added.hint.includes("patch_node_territory"),
    JSON.stringify(added)
  );
  check(
    "the in-place write lists the live file and its re-synced twin",
    added.changed_files.includes(liveOf("foundations", "f-core")) &&
      added.changed_files.includes(twinOf("foundations", "f-core")),
    JSON.stringify(added.changed_files)
  );
  check("the twin carries the in-place claim", twinInSync("foundations", "f-core"));
  check(
    "the live frontmatter marks the new entry in added_claims",
    JSON.stringify(addedClaims("foundations", "f-core")) === JSON.stringify(["src/core/new.ts"]),
    JSON.stringify(addedClaims("foundations", "f-core"))
  );
  check(
    "folder_claims suggests src/core/ for the two per-file entries",
    Array.isArray(added.folder_claims) &&
      added.folder_claims.length === 1 &&
      added.folder_claims[0].folder === "src/core/" &&
      JSON.stringify(added.folder_claims[0].files) === JSON.stringify(["src/core/a.ts", "src/core/new.ts"]) &&
      added.folder_claims[0].note === "src/core/ would cover these 2 files",
    JSON.stringify(added.folder_claims)
  );
  const warned = await call("run_check", {});
  check(
    "run_check warns that the in-place claim is not named in the body",
    claimWarning(warned.warnings, "f-core", "src/core/new.ts"),
    JSON.stringify(warned.warnings)
  );
}

// --- what still needs a revision ---
{
  const base = ["src/core/a.ts", "src/core/new.ts", "src/mixed/c.ts"];
  const mixed = await blocked("set_implementation_files", { node_id: "f-core", files: [...base, "src/mixed/e.ts"] });
  check(
    "a folder holding another node's file is not dominated: Blocked → open_next",
    mixed?.startsWith("Blocked:") && mixed.includes("src/mixed/e.ts") && mixed.includes("open_next"),
    mixed ?? "accepted"
  );
  const dropped = await blocked("set_implementation_files", { node_id: "f-core", files: ["src/core/new.ts", "src/mixed/c.ts"] });
  check(
    "removing an entry in place is Blocked and names it",
    dropped?.startsWith("Blocked:") && dropped.includes("src/core/a.ts") && dropped.includes("open_next"),
    dropped ?? "accepted"
  );
  const glob = await blocked("set_implementation_files", { node_id: "f-core", files: [...base, "src/core/*.ts"] });
  check(
    "adding a glob in place is Blocked",
    glob?.startsWith("Blocked:") && glob.includes("src/core/*.ts") && glob.includes("open_next"),
    glob ?? "accepted"
  );
  const outside = await blocked("set_implementation_files", { node_id: "f-core", files: [...base, "src/elsewhere/z.ts"] });
  check(
    "adding a file outside any dominated folder is Blocked",
    outside?.startsWith("Blocked:") && outside.includes("src/elsewhere/z.ts") && outside.includes("open_next"),
    outside ?? "accepted"
  );
}

// --- explicit slot: "current" takes the same additive path ---
{
  write("src/core/third.ts", "export const t = 1;\n");
  const third = await call("set_implementation_files", {
    node_id: "f-core",
    slot: "current",
    files: ["src/core/a.ts", "src/core/new.ts", "src/core/third.ts", "src/mixed/c.ts"],
  });
  check(
    'slot: "current" on a shipped node with no next is additive in place',
    third.slot === "current" && JSON.stringify(third.added_in_place) === JSON.stringify(["src/core/third.ts"]),
    JSON.stringify(third)
  );
  check(
    "added_claims accumulates sorted entries",
    JSON.stringify(addedClaims("foundations", "f-core")) === JSON.stringify(["src/core/new.ts", "src/core/third.ts"]),
    JSON.stringify(addedClaims("foundations", "f-core"))
  );
}

// --- a directory entry replaces the per-file entries of a dominated folder ---
{
  const dir = await call("set_implementation_files", { node_id: "f-core", files: ["src/core/", "src/mixed/c.ts"] });
  check(
    "F/ for a dominated folder replaces its per-file entries in place",
    dir.slot === "current" &&
      JSON.stringify(dir.added_in_place) === JSON.stringify(["src/core/"]) &&
      JSON.stringify(dir.implements) === JSON.stringify(["src/core/", "src/mixed/c.ts"]) &&
      dir.changed_files.includes(twinOf("foundations", "f-core")) &&
      !("folder_claims" in dir),
    JSON.stringify(dir)
  );
  check(
    "markers still covered by the directory entry are kept",
    JSON.stringify(addedClaims("foundations", "f-core")) ===
      JSON.stringify(["src/core/", "src/core/new.ts", "src/core/third.ts"]),
    JSON.stringify(addedClaims("foundations", "f-core"))
  );
}

// --- naming the paths in the body clears the markers and the warning ---
{
  const partial = await call("patch_node_territory", {
    node_id: "f-core",
    replace: { find: "# Core", with: "# Core\n\nCore lives in `src/core/new.ts`." },
  });
  check("the live patch lists the re-synced twin", partial.changed_files.includes(twinOf("foundations", "f-core")), JSON.stringify(partial));
  const midCheck = await call("run_check", {});
  check(
    "a named marker clears; an unnamed one still warns",
    !claimWarning(midCheck.warnings, "f-core", "src/core/new.ts") &&
      claimWarning(midCheck.warnings, "f-core", "src/core/third.ts") &&
      JSON.stringify(addedClaims("foundations", "f-core")) === JSON.stringify(["src/core/", "src/core/third.ts"]),
    `${JSON.stringify(midCheck.warnings)} | ${JSON.stringify(addedClaims("foundations", "f-core"))}`
  );
  check(
    "a file under a folder entry does not name the folder entry",
    claimWarning(midCheck.warnings, "f-core", "src/core/"),
    JSON.stringify(midCheck.warnings)
  );
  await call("patch_node_territory", {
    node_id: "f-core",
    replace: { find: "# Core", with: "# Core\n\nEverything under `src/core/`; helpers in `src/core/third.ts`." },
  });
  const cleared = await call("run_check", {});
  check(
    "once the body names every path the warning is gone and added_claims is removed",
    !(cleared.warnings ?? []).some((w) => w.includes("added in place")) &&
      addedClaims("foundations", "f-core").length === 0 &&
      !/^added_claims:/m.test(readRel(liveOf("foundations", "f-core"))),
    JSON.stringify(cleared.warnings)
  );
  check("the twin matches the cleared live file", twinInSync("foundations", "f-core"));
}

// --- a shipped node with an open next still writes next ---
{
  write("src/shared/y.ts", "export const y = 1;\n");
  await call("open_next", { node_id: "f-other" });
  const next = await call("set_implementation_files", {
    node_id: "f-other",
    files: ["src/mixed/d.ts", "src/shared/x.ts", "src/shared/y.ts"],
  });
  check(
    "with an open next the write goes to next, not in place",
    next.slot === "next" && !("added_in_place" in next) && !/^added_claims:/m.test(readRel(liveOf("foundations", "f-other"))),
    JSON.stringify(next)
  );
  const explicit = await blocked("set_implementation_files", {
    node_id: "f-other",
    slot: "current",
    files: ["src/mixed/d.ts", "src/shared/x.ts", "src/shared/y.ts"],
  });
  check('slot: "current" with an open next stays Blocked', explicit?.startsWith("Blocked:"), explicit ?? "accepted");
}

// --- a glob at or above a folder keeps it undominated ---
{
  await call("create_node", { id: "f-gen", type: "Foundation", title: "Gen", description: "Infra — generated", role: "infra" });
  await call("create_node", { id: "f-lib", type: "Foundation", title: "Lib", description: "Infra — lib", role: "infra" });
  write("src/lib/other/x.gen.ts", "export const g = 1;\n");
  write("src/lib/own/a.ts", "export const a = 1;\n");
  await call("set_implementation_files", { node_id: "f-gen", files: ["src/lib/**/*.gen.ts"] });
  await call("set_implementation_files", { node_id: "f-lib", files: ["src/lib/own/a.ts"] });
  fillAndTick("foundations", "f-lib");
  await walk("f-lib", ["ready", "in-progress", "in-review", "ship"]);
  write("src/lib/own/b.ts", "export const b = 1;\n");
  const globbed = await blocked("set_implementation_files", {
    node_id: "f-lib",
    files: ["src/lib/own/a.ts", "src/lib/own/b.ts"],
  });
  check(
    "another node's glob whose static prefix is an ancestor of the folder makes it undominated",
    globbed?.startsWith("Blocked:") && globbed.includes("src/lib/own/b.ts") && globbed.includes("open_next"),
    globbed ?? "accepted"
  );
  const dirClaim = await blocked("set_implementation_files", { node_id: "f-lib", files: ["src/lib/own/a.ts", "src/lib/own/"] });
  check("so is a directory claim of that folder", dirClaim?.startsWith("Blocked:"), dirClaim ?? "accepted");
}

// --- a glob above a folder that cannot reach beneath it leaves it dominated ---
{
  await call("create_node", { id: "f-cfg", type: "Foundation", title: "Cfg", description: "Infra — config", role: "infra" });
  await call("create_node", { id: "f-app", type: "Foundation", title: "App", description: "Infra — app", role: "infra" });
  write("src/conf/base.json", "{}\n");
  write("src/conf/app/main.ts", "export const m = 1;\n");
  await call("set_implementation_files", { node_id: "f-cfg", files: ["src/conf/*.json"] });
  await call("set_implementation_files", { node_id: "f-app", files: ["src/conf/app/main.ts"] });
  fillAndTick("foundations", "f-app");
  await walk("f-app", ["ready", "in-progress", "in-review", "ship"]);
  write("src/conf/app/extra.ts", "export const e = 1;\n");
  const added = await call("set_implementation_files", {
    node_id: "f-app",
    files: ["src/conf/app/extra.ts", "src/conf/app/main.ts"],
  });
  check(
    "a glob one level above (no **) does not block an in-place claim below it",
    added.added_in_place?.join() === "src/conf/app/extra.ts",
    JSON.stringify(added)
  );
}

// --- force_unship drops the neighbor label and the in-place claim marker ---
{
  await call("create_node", { id: "f-solo", type: "Foundation", title: "Solo", description: "Infra — solo", role: "infra" });
  write("src/solo/a.ts", "export const a = 1;\n");
  await call("set_implementation_files", { node_id: "f-solo", files: ["src/solo/a.ts"] });
  fillAndTick("foundations", "f-solo");
  await walk("f-solo", ["ready", "in-progress", "in-review", "ship"]);
  write("src/solo/b.ts", "export const b = 1;\n");
  await call("set_implementation_files", { node_id: "f-solo", files: ["src/solo/a.ts", "src/solo/b.ts"], change: "solo-fix" });
  check(
    "the shipped node carries a label and an in-place marker",
    /^change: "solo-fix"$/m.test(readRel(liveOf("foundations", "f-solo"))) &&
      JSON.stringify(addedClaims("foundations", "f-solo")) === JSON.stringify(["src/solo/b.ts"])
  );
  const unshipped = await call("force_unship", { node_id: "f-solo", confirm: "unship:f-solo" });
  const live = readRel(liveOf("foundations", "f-solo"));
  check(
    "force_unship clears the live label and added_claims and lists the live file",
    unshipped.cleared_change === "solo-fix" &&
      unshipped.changed_files.includes(liveOf("foundations", "f-solo")) &&
      !/^change:/m.test(live) &&
      !/^added_claims:/m.test(live),
    JSON.stringify(unshipped)
  );
  const record = (await call("get_node_context", { node_id: "f-solo" })).record;
  check(
    "the unshipped node is not a revision of the old change",
    record.change === undefined && record.added_claims === undefined,
    JSON.stringify(record)
  );
}

// --- migration and schema files are never claimed in place ---
{
  await call("create_node", { id: "f-db", type: "Foundation", title: "Db", description: "Infra — database", role: "infra" });
  write("src/db/client.ts", "export const db = 1;\n");
  write("src/db/migrations/001.sql", "create table t (id int);\n");
  await call("set_implementation_files", { node_id: "f-db", files: ["src/db/client.ts", "src/db/migrations/001.sql"] });
  fillAndTick("foundations", "f-db");
  // Outside git a first build's schema file is decision-worthy: record one before in-review.
  await call("record_decision", {
    node_id: "f-db",
    decision: "Migrations are plain SQL files.",
    alternatives: ["An ORM migration DSL (another dependency)"],
    why: "The schema stays readable without tooling.",
  });
  await walk("f-db", ["ready", "in-progress", "in-review", "ship"]);
  const base = ["src/db/client.ts", "src/db/migrations/001.sql"];

  write("src/db/migrations/002.sql", "alter table t add column n int;\n");
  const exact = await blocked("set_implementation_files", { node_id: "f-db", files: [...base, "src/db/migrations/002.sql"] });
  check(
    "a new migration file in a dominated folder is not claimed in place: Blocked → open_next",
    exact?.startsWith("Blocked:") &&
      exact.includes("src/db/migrations/002.sql") &&
      exact.includes("open_next") &&
      /schema|decision/i.test(exact),
    exact ?? "accepted"
  );
  const folder = await blocked("set_implementation_files", { node_id: "f-db", files: [...base, "src/db/migrations/"] });
  check(
    "a migrations folder entry is not claimed in place",
    folder?.startsWith("Blocked:") && folder.includes("src/db/migrations/") && folder.includes("open_next"),
    folder ?? "accepted"
  );
  const parent = await blocked("set_implementation_files", { node_id: "f-db", files: ["src/db/", ...base] });
  check(
    "a folder entry that holds a migration file is not claimed in place",
    parent?.startsWith("Blocked:") && parent.includes("src/db/") && parent.includes("open_next"),
    parent ?? "accepted"
  );

  write("src/db/extra.ts", "export const extra = 1;\n");
  const coverage = await call("run_check", {});
  const schemaCov = coverage.failures.find((f) => f.includes('"src/db/migrations/002.sql"'));
  const plainCov = coverage.failures.find((f) => f.includes('"src/db/extra.ts"'));
  check(
    "the Coverage fix for an unclaimed migration in a dominated folder opens the evolution first",
    !!schemaCov &&
      schemaCov.includes('Probable owner by path: "f-db"') &&
      schemaCov.includes('open_next({"node_id":"f-db"}) then set_implementation_files'),
    String(schemaCov)
  );
  check(
    "the Coverage fix for a plain sibling in the same node's folder stays in place",
    !!plainCov && plainCov.includes('Probable owner by path: "f-db"') && !plainCov.includes("open_next"),
    String(plainCov)
  );
  fs.rmSync(path.join(root, "src", "db", "migrations", "002.sql"));
  fs.rmSync(path.join(root, "src", "db", "extra.ts"));

  write("src/db/pool.ts", "export const pool = 1;\n");
  const sibling = await call("set_implementation_files", { node_id: "f-db", files: [...base, "src/db/pool.ts"] });
  check(
    "a non-schema sibling in a dominated folder is still claimed in place",
    sibling.slot === "current" && JSON.stringify(sibling.added_in_place) === JSON.stringify(["src/db/pool.ts"]),
    JSON.stringify(sibling)
  );
}

// --- added_claims markers clear only when the body names the whole path ---
{
  check(
    "f-app still carries its in-place marker",
    JSON.stringify(addedClaims("foundations", "f-app")) === JSON.stringify(["src/conf/app/extra.ts"]),
    JSON.stringify(addedClaims("foundations", "f-app"))
  );
  await call("patch_node_territory", {
    node_id: "f-app",
    replace: { find: "# App", with: "# App\n\nNot `src/conf/app/extra.tsx`, nor src/conf/app/extra.ts.bak either." },
  });
  const longer = await call("run_check", {});
  check(
    "a body naming only longer paths keeps the marker and the warning",
    JSON.stringify(addedClaims("foundations", "f-app")) === JSON.stringify(["src/conf/app/extra.ts"]) &&
      claimWarning(longer.warnings, "f-app", "src/conf/app/extra.ts"),
    `${JSON.stringify(addedClaims("foundations", "f-app"))} | ${JSON.stringify(longer.warnings)}`
  );
  await call("patch_node_territory", {
    node_id: "f-app",
    replace: { find: "# App", with: "# App\n\nExtra settings live in src/conf/app/extra.ts." },
  });
  const named = await call("run_check", {});
  check(
    "naming the exact path (sentence-ending period included) clears the marker and the warning",
    addedClaims("foundations", "f-app").length === 0 && !claimWarning(named.warnings, "f-app", "src/conf/app/extra.ts"),
    `${JSON.stringify(addedClaims("foundations", "f-app"))} | ${JSON.stringify(named.warnings)}`
  );
  check("the f-app twin matches its live file", twinInSync("foundations", "f-app"));
}

// --- other live writes on a shipped node keep its added_claims ---
{
  await call("create_node", { id: "f-keep", type: "Foundation", title: "Keep", description: "Infra — keep", role: "infra" });
  write("src/keep/a.ts", "export const a = 1;\n");
  await call("set_implementation_files", { node_id: "f-keep", files: ["src/keep/a.ts"] });
  fillAndTick("foundations", "f-keep");
  await walk("f-keep", ["ready", "in-progress", "in-review", "ship"]);
  write("src/keep/b.ts", "export const b = 1;\n");
  await call("set_implementation_files", { node_id: "f-keep", files: ["src/keep/a.ts", "src/keep/b.ts"] });
  const kept = () =>
    JSON.stringify(addedClaims("foundations", "f-keep")) === JSON.stringify(["src/keep/b.ts"]) &&
    twinInSync("foundations", "f-keep");
  check("f-keep starts with an in-place marker", kept(), JSON.stringify(addedClaims("foundations", "f-keep")));

  await call("patch_node_rules", { node_id: "f-keep", rules: "- Keep helpers small." });
  check("patch_node_rules keeps added_claims", kept(), JSON.stringify(addedClaims("foundations", "f-keep")));

  await call("record_decision", {
    node_id: "f-keep",
    decision: "Keep exports one constant per file.",
    alternatives: ["A barrel module (hides ownership)"],
    why: "Each file stays claimable on its own.",
  });
  check("record_decision keeps added_claims", kept(), JSON.stringify(addedClaims("foundations", "f-keep")));

  // A live edge write with f-keep as the source, when the server allows one on a shipped node with
  // no open next; otherwise f-keep is the target of another node's depends_on (which recomputes
  // f-keep's stability and rewrites its state line).
  const asSource = await blocked("link_nodes", { source_id: "f-keep", target_id: "f-core", edge_type: "depends_on" });
  if (asSource === null) {
    check("link_nodes with f-keep as the source keeps added_claims", kept(), JSON.stringify(addedClaims("foundations", "f-keep")));
  } else {
    await call("create_node", { id: "f-user", type: "Foundation", title: "User", description: "Infra — user", role: "infra" });
    await call("link_nodes", { source_id: "f-user", target_id: "f-keep", edge_type: "depends_on" });
    check("link_nodes with f-keep as the target keeps added_claims", kept(), JSON.stringify(addedClaims("foundations", "f-keep")));
  }
}

check("every write listed every mindplan/ file it touched", diffMisses === 0, `${diffMisses} write(s) missed files`);

await client.close();
if (failures > 0) {
  console.log(`\nshipped-claims.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nshipped-claims.test.mjs: all ok");
