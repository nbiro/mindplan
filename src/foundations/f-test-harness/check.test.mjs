/**
 * Integrity check CLI coverage for declared file ownership. Run via npm test.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-check-"));
console.log("Check sandbox:", root);

function runCheck(args, env = {}) {
  return spawnSync(process.execPath, [serverEntry, "check", ...args], {
    cwd: root,
    env: { ...process.env, MINDPLAN_ROOT: root, ...env },
    encoding: "utf-8",
  });
}

function git(...args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf-8" });
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, MINDPLAN_ROOT: root },
});
const client = new Client({ name: "check-test", version: "0.1.0" });
await client.connect(transport);

async function call(tool, args) {
  const res = await client.callTool({ name: tool, arguments: args });
  if (res.isError) throw new Error(res.content?.[0]?.text ?? "tool error");
  return JSON.parse(res.content?.[0]?.text ?? "{}");
}

function fillMinimumTerritoryShape(filePath) {
  let raw = fs.readFileSync(filePath, "utf-8");
  raw = raw.replace(/^_.*?_$/gm, (line) => {
    if (line.includes("attachments/") || line.includes("`attachments/`")) return line;
    return "Check-test filled territory for Minimum Territory Shape.";
  });
  raw = raw.replace(/^## Checklist\s*$/m, "## Atomic Ops");
  fs.writeFileSync(filePath, raw);
}

// Write ownership config (sources covers src/**)
fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
fs.writeFileSync(
  path.join(root, "mindplan", "config.json"),
  JSON.stringify({ sources: ["src/**"], exclude: [] }, null, 2) + "\n"
);

await call("create_node", {
  id: "j-app",
  type: "Journey",
  title: "App",
  description: "App journey",
});
await call("create_node", {
  id: "f-core",
  type: "Foundation",
  title: "Core",
  description: "Infra — core",
  role: "infra",
});
await call("create_node", {
  id: "i-feature",
  type: "Interaction",
  title: "Feature",
  description: "A feature",
});
await call("link_nodes", {
  source_id: "i-feature",
  target_id: "j-app",
  edge_type: "belongs_to",
});
await call("link_nodes", {
  source_id: "i-feature",
  target_id: "f-core",
  edge_type: "depends_on",
});
fillMinimumTerritoryShape(path.join(root, "mindplan", "foundations", "f-core", "current.mdx"));
fillMinimumTerritoryShape(path.join(root, "mindplan", "interactions", "i-feature", "current.mdx"));

// Create owned files and claim them
fs.mkdirSync(path.join(root, "src", "foundations", "f-core"), { recursive: true });
fs.mkdirSync(path.join(root, "src", "interactions", "i-feature"), { recursive: true });
fs.writeFileSync(path.join(root, "src", "foundations", "f-core", "index.ts"), "export const core = 1;\n");
fs.writeFileSync(
  path.join(root, "src", "interactions", "i-feature", "feature.ts"),
  'import { core } from "../../foundations/f-core/index.js";\nexport const x = core;\n'
);
await call("set_implementation_files", {
  node_id: "f-core",
  files: ["src/foundations/f-core/"],
});
await call("set_implementation_files", {
  node_id: "i-feature",
  files: ["src/interactions/i-feature/"],
});

await call("update_node_status", { node_id: "f-core", new_status: "ready" });
await call("update_node_status", { node_id: "f-core", new_status: "in-progress" });
await call("update_node_status", { node_id: "i-feature", new_status: "ready" });

let failures = 0;

let r = runCheck(["--for-main"]);
if (r.status === 0 || !(r.stderr || r.stdout).includes("unknown check option")) {
  failures++;
  console.log(`FAIL --for-main should be an unknown option: ${r.stderr || r.stdout}`);
} else console.log("ok   --for-main is an unknown option");

// Unowned universe file
fs.mkdirSync(path.join(root, "src", "orphan"), { recursive: true });
fs.writeFileSync(path.join(root, "src", "orphan", "x.ts"), "export {};\n");
r = runCheck([]);
if (r.status === 0 || !(r.stderr || r.stdout).includes("coverage")) {
  failures++;
  console.log(`FAIL expected coverage failure: status=${r.status} out=${r.stderr || r.stdout}`);
} else console.log("ok   unowned universe file fails coverage");
fs.rmSync(path.join(root, "src", "orphan"), { recursive: true, force: true });

// Exclusivity conflict
await call("create_node", {
  id: "i-other",
  type: "Interaction",
  title: "Other",
  description: "other",
});
await call("link_nodes", { source_id: "i-other", target_id: "j-app", edge_type: "belongs_to" });
await call("link_nodes", { source_id: "i-other", target_id: "f-core", edge_type: "depends_on" });
try {
  await call("set_implementation_files", {
    node_id: "i-other",
    files: ["src/interactions/i-feature/feature.ts"],
  });
  failures++;
  console.log("FAIL set_implementation_files should reject exclusivity conflict");
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg.includes("conflict") && !msg.includes("claimed")) {
    failures++;
    console.log(`FAIL expected conflict Blocked, got: ${msg}`);
  } else console.log("ok   set_implementation_files rejects exclusivity conflict");
}

// Illegal import: Interaction → Interaction
fs.mkdirSync(path.join(root, "src", "interactions", "i-other"), { recursive: true });
fs.writeFileSync(
  path.join(root, "src", "interactions", "i-other", "other.ts"),
  'import { x } from "../i-feature/feature.js";\nexport const y = x;\n'
);
await call("set_implementation_files", {
  node_id: "i-other",
  files: ["src/interactions/i-other/"],
});
r = runCheck([]);
if (r.status === 0 || !(r.stderr || r.stdout).includes("imports")) {
  failures++;
  console.log(`FAIL expected illegal import: ${r.stderr || r.stdout}`);
} else console.log("ok   illegal Interaction→Interaction import fails");
fs.rmSync(path.join(root, "src", "interactions", "i-other"), { recursive: true, force: true });
// Clear implements by shrinking to empty via rewriting frontmatter after cancel path —
// just leave i-other without files by setting empty and deleting claims
await call("set_implementation_files", { node_id: "i-other", files: [] });

git("init");
git("config", "user.email", "test@example.com");
git("config", "user.name", "Test");
git("commit", "--allow-empty", "-m", "init");
const baseSha = git("rev-parse", "HEAD").stdout.trim();

git("add", "src");
git("commit", "-m", "seed owned sources");

// Default check ignores dirty working tree
fs.writeFileSync(
  path.join(root, "src", "interactions", "i-feature", "wip.ts"),
  "export const wip = 1;\n"
);
r = runCheck([]);
if (r.status !== 0) {
  failures++;
  console.log(`FAIL default check should ignore dirty src: ${r.stderr || r.stdout}`);
} else console.log("ok   default check ignores dirty working tree");

r = runCheck(["--base", baseSha]);
if (r.status === 0 || !(r.stderr || r.stdout).includes("i-feature")) {
  failures++;
  console.log(`FAIL dirty while ready: status=${r.status} out=${r.stderr || r.stdout}`);
} else console.log("ok   dirty src while ready fails with --base");
fs.rmSync(path.join(root, "src", "interactions", "i-feature", "wip.ts"), { force: true });

await call("update_node_status", { node_id: "i-feature", new_status: "in-progress" });
fs.writeFileSync(
  path.join(root, "src", "interactions", "i-feature", "code2.ts"),
  "export const z = 2;\n"
);
git("add", "src/interactions/i-feature/code2.ts");
git("commit", "-m", "feature code in-progress");
r = runCheck(["--base", baseSha]);
if (r.status !== 0) {
  failures++;
  console.log(`FAIL dirty while in-progress should pass: ${r.stderr || r.stdout}`);
} else console.log("ok   dirty src while in-progress passes");

// Complete checklist for in-review — needs implements present (already set)
const ixPath = path.join(root, "mindplan", "interactions", "i-feature", "current.mdx");
let ixBody = fs.readFileSync(ixPath, "utf-8");
ixBody = ixBody.replace(/- \[ \]/g, "- [x]");
fs.writeFileSync(ixPath, ixBody);
await call("update_node_status", { node_id: "i-feature", new_status: "in-review" });

r = runCheck(["--base", baseSha]);
if (r.status !== 0) {
  failures++;
  console.log(`FAIL committed dirty while in-review should pass: ${r.stderr || r.stdout}`);
} else console.log("ok   committed dirty while in-review passes");

fs.writeFileSync(
  path.join(root, "src", "interactions", "i-feature", "wip-extra.ts"),
  "export const wip = true;\n"
);
r = runCheck(["--base", baseSha]);
if (r.status === 0 || !(r.stderr || r.stdout).includes("Uncommitted")) {
  failures++;
  console.log(`FAIL uncommitted while in-review should fail: ${r.stderr || r.stdout}`);
} else console.log("ok   uncommitted dirty while in-review fails");
fs.rmSync(path.join(root, "src", "interactions", "i-feature", "wip-extra.ts"), { force: true });

const fPath = path.join(root, "mindplan", "foundations", "f-core", "current.mdx");
let fBody = fs.readFileSync(fPath, "utf-8");
fBody = fBody.replace(/- \[ \]/g, "- [x]");
fs.writeFileSync(fPath, fBody);
await call("update_node_status", { node_id: "f-core", new_status: "in-review" });
await call("update_node_status", { node_id: "f-core", new_status: "ship" });
await call("update_node_status", { node_id: "i-feature", new_status: "ship" });

r = runCheck(["--base", baseSha]);
if (r.status !== 0) {
  failures++;
  console.log(`FAIL committed dirty while stable should pass: ${r.stderr || r.stdout}`);
} else console.log("ok   committed dirty while stable passes");

r = runCheck(["--base", "not-a-real-ref-zzzz"]);
if (r.status === 0 || !(r.stderr || r.stdout).includes("git")) {
  failures++;
  console.log(`FAIL bad --base should fail: ${r.stderr || r.stdout}`);
} else console.log("ok   bad --base fails closed");

// Cancelled leftovers
await call("create_node", {
  id: "i-dead",
  type: "Interaction",
  title: "Dead",
  description: "cancel me",
});
await call("link_nodes", { source_id: "i-dead", target_id: "j-app", edge_type: "belongs_to" });
await call("link_nodes", { source_id: "i-dead", target_id: "f-core", edge_type: "depends_on" });
fillMinimumTerritoryShape(path.join(root, "mindplan", "interactions", "i-dead", "current.mdx"));
fs.mkdirSync(path.join(root, "src", "interactions", "i-dead"), { recursive: true });
fs.writeFileSync(path.join(root, "src", "interactions", "i-dead", "dead.ts"), "export {};\n");
await call("set_implementation_files", {
  node_id: "i-dead",
  files: ["src/interactions/i-dead/"],
});
await call("update_node_status", { node_id: "i-dead", new_status: "ready" });
await call("update_node_status", { node_id: "i-dead", new_status: "in-progress" });
await call("update_node_status", { node_id: "i-dead", new_status: "cancelled" });

r = runCheck([]);
if (r.status === 0 || !(r.stderr || r.stdout).includes("leftovers")) {
  failures++;
  console.log(`FAIL retired leftovers should fail: ${r.stderr || r.stdout}`);
} else console.log("ok   retired leftovers fail until deleted");
fs.rmSync(path.join(root, "src", "interactions", "i-dead"), { recursive: true, force: true });
await call("set_implementation_files", { node_id: "i-dead", files: [] });
r = runCheck([]);
if (r.status !== 0) {
  failures++;
  console.log(`FAIL after clearing leftovers should pass: ${r.stderr || r.stdout}`);
} else console.log("ok   clearing retired implements passes");

// get_node_implementation returns files
const impl = await call("get_node_implementation", { node_id: "i-feature" });
if (!Array.isArray(impl.files) || !impl.files.some((f) => String(f.path).includes("feature"))) {
  failures++;
  console.log(`FAIL get_node_implementation files: ${JSON.stringify(impl)}`);
} else console.log("ok   get_node_implementation returns files");

const byPath = await call("get_node_implementation", {
  path: "src/foundations/f-core/index.ts",
});
if (byPath.owner?.node_id !== "f-core") {
  failures++;
  console.log(`FAIL path lookup: ${JSON.stringify(byPath)}`);
} else console.log("ok   get_node_implementation path lookup");

// Legacy config Blocked
fs.writeFileSync(
  path.join(root, "mindplan", "config.json"),
  JSON.stringify({ implementation_packages: "required" }, null, 2) + "\n"
);
const legacy = runCheck([]);
const legacyOut = `${legacy.stderr || ""}\n${legacy.stdout || ""}`;
if (legacy.status === 0 || !legacyOut.includes("implementation_packages")) {
  failures++;
  console.log(`FAIL legacy config should Blocked: ${legacyOut}`);
} else console.log("ok   legacy implementation_packages Blocks check");

const migrate = spawnSync(process.execPath, [serverEntry, "init"], {
  cwd: root,
  env: { ...process.env, MINDPLAN_ROOT: root },
  encoding: "utf-8",
});
if (migrate.status !== 0) {
  failures++;
  console.log(`FAIL init migration: ${migrate.stderr || migrate.stdout}`);
} else {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "mindplan", "config.json"), "utf-8"));
  if (!Array.isArray(cfg.sources) || !("exclude" in cfg)) {
    failures++;
    console.log(`FAIL init should write sources/exclude: ${JSON.stringify(cfg)}`);
  } else console.log("ok   init migrates to sources/exclude");
}

const layoutRejected = spawnSync(process.execPath, [serverEntry, "init", "--layout", "free"], {
  cwd: root,
  env: { ...process.env, MINDPLAN_ROOT: root },
  encoding: "utf-8",
});
if (layoutRejected.status === 0 || !(layoutRejected.stderr || "").includes("--layout")) {
  failures++;
  console.log(`FAIL --layout should be rejected: ${layoutRejected.stderr || layoutRejected.stdout}`);
} else console.log("ok   --layout is rejected");

// Foundation create requires role
try {
  await call("create_node", {
    id: "f-norole",
    type: "Foundation",
    title: "No role",
    description: "missing role",
  });
  failures++;
  console.log("FAIL create_node Foundation without role should Blocked");
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg.includes("role")) {
    failures++;
    console.log(`FAIL expected role Blocked, got: ${msg}`);
  } else console.log("ok   create_node Foundation requires role");
}

// No package scaffold
const created = await call("create_node", {
  id: "i-noscaffold",
  type: "Interaction",
  title: "No scaffold",
  description: "x",
});
if (
  created.implementation ||
  fs.existsSync(path.join(root, "src", "interactions", "i-noscaffold"))
) {
  failures++;
  console.log(`FAIL create_node should not scaffold package: ${JSON.stringify(created)}`);
} else console.log("ok   create_node skips package scaffold");

const scaffoldBody = fs.readFileSync(
  path.join(root, "mindplan", "interactions", "i-noscaffold", "current.mdx"),
  "utf-8"
);
if (!scaffoldBody.includes("set_implementation_files")) {
  failures++;
  console.log("FAIL scaffold should mention set_implementation_files");
} else console.log("ok   scaffold mentions set_implementation_files");

// --- Released live presence (open next relocates files) ---

// Stable + open next relocates implements: deleted released live entry must not fail presence
await call("open_next", { node_id: "f-core" });
fs.mkdirSync(path.join(root, "src", "platform", "db"), { recursive: true });
fs.writeFileSync(path.join(root, "src", "platform", "db", "index.ts"), "export const db = 1;\n");
await call("set_implementation_files", {
  node_id: "f-core",
  files: ["src/platform/db/"],
});
fs.rmSync(path.join(root, "src", "foundations", "f-core"), { recursive: true, force: true });
git("add", "-u", "src/foundations/f-core");
r = runCheck([]);
if (r.status !== 0) {
  failures++;
  console.log(`FAIL relocated released live should pass presence: ${r.stderr || r.stdout}`);
} else console.log("ok   released live entry skipped for presence while next open");

// Discard next: released entry becomes live again → missing path fails presence
await call("discard_next", { node_id: "f-core" });
r = runCheck([]);
if (r.status === 0 || !(r.stderr || r.stdout).includes("presence")) {
  failures++;
  console.log(`FAIL after discard missing live should fail presence: ${r.stderr || r.stdout}`);
} else console.log("ok   discard_next restores live presence requirement");
fs.mkdirSync(path.join(root, "src", "foundations", "f-core"), { recursive: true });
fs.writeFileSync(path.join(root, "src", "foundations", "f-core", "index.ts"), "export const core = 1;\n");
fs.rmSync(path.join(root, "src", "platform"), { recursive: true, force: true });
git("add", "-A", "src");
r = runCheck([]);
if (r.status !== 0) {
  failures++;
  console.log(`FAIL after restoring live files should pass: ${r.stderr || r.stdout}`);
} else console.log("ok   restored live implements passes presence");

// Kept live entry (still listed by next) missing on disk → presence fails
await call("open_next", { node_id: "i-feature" });
fs.rmSync(path.join(root, "src", "interactions", "i-feature"), { recursive: true, force: true });
git("add", "-u", "src/interactions/i-feature");
r = runCheck([]);
if (r.status === 0 || !(r.stderr || r.stdout).includes("presence")) {
  failures++;
  console.log(`FAIL kept live entry missing should fail presence: ${r.stderr || r.stdout}`);
} else console.log("ok   kept live entry still requires presence");
fs.mkdirSync(path.join(root, "src", "interactions", "i-feature"), { recursive: true });
fs.writeFileSync(
  path.join(root, "src", "interactions", "i-feature", "feature.ts"),
  'import { core } from "../../foundations/f-core/index.js";\nexport const x = core;\n'
);
fs.writeFileSync(
  path.join(root, "src", "interactions", "i-feature", "code2.ts"),
  "export const z = 2;\n"
);
git("add", "-A", "src/interactions/i-feature");

// Next in-review with missing next entry → next presence fails
fillMinimumTerritoryShape(path.join(root, "mindplan", "interactions", "i-feature", "next.mdx"));
let nextBody = fs.readFileSync(
  path.join(root, "mindplan", "interactions", "i-feature", "next.mdx"),
  "utf-8"
);
nextBody = nextBody.replace(/- \[ \]/g, "- [x]");
fs.writeFileSync(path.join(root, "mindplan", "interactions", "i-feature", "next.mdx"), nextBody);
await call("update_node_status", { node_id: "i-feature", new_status: "ready" });
await call("update_node_status", { node_id: "i-feature", new_status: "in-progress" });
await call("update_node_status", { node_id: "i-feature", new_status: "in-review" });
fs.rmSync(path.join(root, "src", "interactions", "i-feature"), { recursive: true, force: true });
git("add", "-u", "src/interactions/i-feature");
r = runCheck([]);
if (
  r.status === 0 ||
  !(r.stderr || r.stdout).includes("presence") ||
  !(r.stderr || r.stdout).includes("next")
) {
  failures++;
  console.log(`FAIL next in-review missing entry should fail next presence: ${r.stderr || r.stdout}`);
} else console.log("ok   next in-review presence still required");
fs.mkdirSync(path.join(root, "src", "interactions", "i-feature"), { recursive: true });
fs.writeFileSync(
  path.join(root, "src", "interactions", "i-feature", "feature.ts"),
  'import { core } from "../../foundations/f-core/index.js";\nexport const x = core;\n'
);
git("add", "-A", "src/interactions/i-feature");
await call("discard_next", { node_id: "i-feature" });

await client.close();

if (failures > 0) {
  console.error(`check.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("check.test.mjs: all ok");
