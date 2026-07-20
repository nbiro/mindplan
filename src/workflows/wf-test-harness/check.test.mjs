/**
 * Integrity check CLI coverage. Run via npm test.
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
});
await call("create_node", {
  id: "wf-feature",
  type: "Workflow",
  title: "Feature",
  description: "A feature",
});
await call("link_nodes", {
  source_id: "wf-feature",
  target_id: "j-app",
  edge_type: "belongs_to",
});
await call("link_nodes", {
  source_id: "wf-feature",
  target_id: "f-core",
  edge_type: "depends_on",
});
await call("update_node_status", { node_id: "f-core", new_status: "ready" });
await call("update_node_status", { node_id: "f-core", new_status: "in-progress" });
await call("update_node_status", { node_id: "wf-feature", new_status: "ready" });

let failures = 0;

// Orphan package
fs.mkdirSync(path.join(root, "src", "workflows", "wf-orphan"), { recursive: true });
fs.writeFileSync(path.join(root, "src", "workflows", "wf-orphan", "x.ts"), "export {};\n");
let r = runCheck([]);
if (r.status === 0 || !(r.stderr || r.stdout).includes("orphan package")) {
  failures++;
  console.log(`FAIL expected orphan package: status=${r.status} out=${r.stderr || r.stdout}`);
} else console.log("ok   orphan package fails check");
fs.rmSync(path.join(root, "src", "workflows", "wf-orphan"), { recursive: true, force: true });

// Dirty working tree while ready
git("init");
git("config", "user.email", "test@example.com");
git("config", "user.name", "Test");
git("commit", "--allow-empty", "-m", "init");
const baseSha = git("rev-parse", "HEAD").stdout.trim();
fs.writeFileSync(path.join(root, "src", "workflows", "wf-feature", "code.ts"), "export const x = 1;\n");

r = runCheck([]);
if (r.status === 0 || !(r.stderr || r.stdout).includes("wf-feature")) {
  failures++;
  console.log(`FAIL dirty while ready: status=${r.status} out=${r.stderr || r.stdout}`);
} else console.log("ok   dirty src while ready fails");

await call("update_node_status", { node_id: "wf-feature", new_status: "in-progress" });
r = runCheck([]);
if (r.status !== 0) {
  failures++;
  console.log(`FAIL dirty while in-progress should pass: ${r.stderr || r.stdout}`);
} else console.log("ok   dirty src while in-progress passes");

// Commit the change, clean working tree, advance to in-review — PR dirty-src must still pass
git("add", "-A");
git("commit", "-m", "feature code");

// Complete checklist for in-review
const wfPath = path.join(root, "mindplan", "workflows", "wf-feature", "current.mdx");
let wfBody = fs.readFileSync(wfPath, "utf-8");
wfBody = wfBody.replace(/- \[ \]/g, "- [x]");
fs.writeFileSync(wfPath, wfBody);
await call("update_node_status", { node_id: "wf-feature", new_status: "in-review" });

r = runCheck(["--base", baseSha]);
if (r.status !== 0) {
  failures++;
  console.log(`FAIL committed dirty while in-review should pass: ${r.stderr || r.stdout}`);
} else console.log("ok   committed dirty while in-review passes");

// Uncommitted edit while in-review must still fail (freeze)
fs.writeFileSync(
  path.join(root, "src", "workflows", "wf-feature", "wip-extra.ts"),
  "export const wip = true;\n"
);
r = runCheck(["--base", baseSha]);
if (r.status === 0 || !(r.stderr || r.stdout).includes("Uncommitted")) {
  failures++;
  console.log(`FAIL uncommitted while in-review should fail: ${r.stderr || r.stdout}`);
} else console.log("ok   uncommitted dirty while in-review fails");
fs.rmSync(path.join(root, "src", "workflows", "wf-feature", "wip-extra.ts"), { force: true });

// Ship foundation + workflow, then committed dirty vs base must pass
const fPath = path.join(root, "mindplan", "foundations", "f-core", "current.mdx");
let fBody = fs.readFileSync(fPath, "utf-8");
fBody = fBody.replace(/- \[ \]/g, "- [x]");
fs.writeFileSync(fPath, fBody);
await call("update_node_status", { node_id: "f-core", new_status: "in-review" });
await call("update_node_status", { node_id: "f-core", new_status: "ship" });
await call("update_node_status", { node_id: "wf-feature", new_status: "ship" });

r = runCheck(["--base", baseSha]);
if (r.status !== 0) {
  failures++;
  console.log(`FAIL committed dirty while stable should pass: ${r.stderr || r.stdout}`);
} else console.log("ok   committed dirty while stable passes");

r = runCheck(["--for-main"]);
if (r.status !== 0) {
  failures++;
  console.log(`FAIL --for-main should pass after ship: ${r.stderr || r.stdout}`);
} else console.log("ok   --for-main passes after ship");

// Explicit bad --base must fail closed
r = runCheck(["--base", "not-a-real-ref-zzzz"]);
if (r.status === 0 || !(r.stderr || r.stdout).includes("git")) {
  failures++;
  console.log(`FAIL bad --base should fail: ${r.stderr || r.stdout}`);
} else console.log("ok   bad --base fails closed");

// Cancel path still works for --for-main on a fresh pre-ship node
await call("create_node", {
  id: "wf-dead",
  type: "Workflow",
  title: "Dead",
  description: "cancel me",
});
await call("link_nodes", { source_id: "wf-dead", target_id: "j-app", edge_type: "belongs_to" });
await call("link_nodes", { source_id: "wf-dead", target_id: "f-core", edge_type: "depends_on" });
await call("update_node_status", { node_id: "wf-dead", new_status: "ready" });
await call("update_node_status", { node_id: "wf-dead", new_status: "in-progress" });
// Commit scaffold while claimed so cancelled package is not untracked dirty later
git("add", "src/workflows/wf-dead");
git("commit", "-m", "wf-dead scaffold");
r = runCheck(["--for-main"]);
if (r.status === 0) {
  failures++;
  console.log("FAIL --for-main should fail with in-progress wf-dead");
} else console.log("ok   --for-main fails on in-progress");
await call("update_node_status", { node_id: "wf-dead", new_status: "cancelled" });
r = runCheck(["--for-main"]);
if (r.status !== 0) {
  failures++;
  console.log(`FAIL --for-main should pass after cancel: ${r.stderr || r.stdout}`);
} else console.log("ok   --for-main passes after cancel");

// Committed history under cancelled is allowed; uncommitted edits are not
const cancelBase = git("rev-parse", "HEAD~1").stdout.trim(); // before wf-dead scaffold commit
r = runCheck(["--base", cancelBase]);
if (r.status !== 0) {
  failures++;
  console.log(`FAIL committed dirty under cancelled should pass: ${r.stderr || r.stdout}`);
} else console.log("ok   committed dirty under cancelled passes");

fs.writeFileSync(
  path.join(root, "src", "workflows", "wf-dead", "wip.ts"),
  "export const nope = 1;\n"
);
r = runCheck(["--base", cancelBase]);
if (r.status === 0 || !(r.stderr || r.stdout).includes("Uncommitted")) {
  failures++;
  console.log(`FAIL uncommitted under cancelled should fail: ${r.stderr || r.stdout}`);
} else console.log("ok   uncommitted dirty under cancelled fails");
fs.rmSync(path.join(root, "src", "workflows", "wf-dead", "wip.ts"), { force: true });

// --- next-slot ownership ---
await call("create_node", {
  id: "wf-evolve",
  type: "Workflow",
  title: "Evolve",
  description: "ship then evolve",
});
await call("link_nodes", { source_id: "wf-evolve", target_id: "j-app", edge_type: "belongs_to" });
await call("link_nodes", { source_id: "wf-evolve", target_id: "f-core", edge_type: "depends_on" });
await call("update_node_status", { node_id: "wf-evolve", new_status: "ready" });
await call("update_node_status", { node_id: "wf-evolve", new_status: "in-progress" });
const evolvePath = path.join(root, "mindplan", "workflows", "wf-evolve", "current.mdx");
let evolveBody = fs.readFileSync(evolvePath, "utf-8");
evolveBody = evolveBody.replace(/- \[ \]/g, "- [x]");
fs.writeFileSync(evolvePath, evolveBody);
await call("update_node_status", { node_id: "wf-evolve", new_status: "in-review" });
await call("update_node_status", { node_id: "wf-evolve", new_status: "ship" });

const evolveBase = git("rev-parse", "HEAD").stdout.trim();
fs.writeFileSync(
  path.join(root, "src", "workflows", "wf-evolve", "v2.ts"),
  "export const v2 = true;\n"
);
git("add", "src/workflows/wf-evolve");
git("commit", "-m", "evolve code before claiming next");

await call("open_next", { node_id: "wf-evolve" });
// next is draft — committed dirty must fail
r = runCheck(["--base", evolveBase]);
if (r.status === 0 || !(r.stderr || r.stdout).includes("wf-evolve")) {
  failures++;
  console.log(`FAIL next draft + committed dirty should fail: ${r.stderr || r.stdout}`);
} else console.log("ok   next draft + committed dirty fails");

r = runCheck(["--for-main"]);
if (r.status !== 0) {
  failures++;
  console.log(`FAIL --for-main should pass with next draft: ${r.stderr || r.stdout}`);
} else console.log("ok   --for-main passes with next draft");

await call("update_node_status", { node_id: "wf-evolve", new_status: "ready" });
r = runCheck(["--base", evolveBase]);
if (r.status === 0 || !(r.stderr || r.stdout).includes("wf-evolve")) {
  failures++;
  console.log(`FAIL next ready + committed dirty should fail: ${r.stderr || r.stdout}`);
} else console.log("ok   next ready + committed dirty fails");

await call("update_node_status", { node_id: "wf-evolve", new_status: "in-progress" });
r = runCheck(["--base", evolveBase]);
if (r.status !== 0) {
  failures++;
  console.log(`FAIL next in-progress + committed dirty should pass: ${r.stderr || r.stdout}`);
} else console.log("ok   next in-progress + committed dirty passes");

r = runCheck(["--for-main"]);
if (r.status === 0 || !(r.stderr || r.stdout).includes("wf-evolve")) {
  failures++;
  console.log(`FAIL --for-main should fail with next in-progress: ${r.stderr || r.stdout}`);
} else console.log("ok   --for-main fails on next in-progress");

// --- layout-free (implementation_packages: off) ---
fs.writeFileSync(
  path.join(root, "mindplan", "config.json"),
  JSON.stringify({ implementation_packages: "off" }, null, 2) + "\n"
);
fs.mkdirSync(path.join(root, "src", "app"), { recursive: true });
fs.writeFileSync(path.join(root, "src", "app", "page.ts"), "export {};\n");
fs.rmSync(path.join(root, "src", "workflows", "wf-feature"), { recursive: true, force: true });
fs.rmSync(path.join(root, "src", "foundations", "f-core"), { recursive: true, force: true });

r = runCheck([]);
if (r.status !== 0) {
  failures++;
  console.log(`FAIL layout-free check should pass without packages: ${r.stderr || r.stdout}`);
} else console.log("ok   layout-free check skips packages and dirty-src");

r = runCheck(["--for-main"]);
if (r.status === 0 || !(r.stderr || r.stdout).includes("wf-evolve")) {
  failures++;
  console.log(`FAIL layout-free --for-main should still fail mid-pipeline: ${r.stderr || r.stdout}`);
} else console.log("ok   layout-free --for-main still bans mid-pipeline");

const freeCreate = await call("create_node", {
  id: "wf-free-extra",
  type: "Workflow",
  title: "Free extra",
  description: "No package",
});
if (freeCreate.implementation || fs.existsSync(path.join(root, "src", "workflows", "wf-free-extra"))) {
  failures++;
  console.log(`FAIL layout-free create_node should not scaffold package: ${JSON.stringify(freeCreate)}`);
} else if (freeCreate.implementation_packages !== "off") {
  failures++;
  console.log(`FAIL create_node should report implementation_packages off: ${JSON.stringify(freeCreate)}`);
} else if (freeCreate.changed_files?.some((f) => String(f).includes("src/workflows/"))) {
  failures++;
  console.log(`FAIL layout-free changed_files must omit src package: ${JSON.stringify(freeCreate.changed_files)}`);
} else console.log("ok   layout-free create_node skips package scaffold");

const freeBody = fs.readFileSync(
  path.join(root, "mindplan", "workflows", "wf-free-extra", "current.mdx"),
  "utf-8"
);
if (!freeBody.includes("layout-free") || freeBody.includes("Implement code only under `src/workflows/<id>/`")) {
  failures++;
  console.log("FAIL layout-free scaffold body should not prescribe src/workflows path");
} else console.log("ok   layout-free scaffold body mentions layout-free");

const freeImpl = await call("get_node_implementation", { node_id: "wf-feature" });
if (freeImpl.root !== null || freeImpl.implementation_packages !== "off") {
  failures++;
  console.log(`FAIL get_node_implementation packages off: ${JSON.stringify(freeImpl)}`);
} else console.log("ok   get_node_implementation reports packages off");

fs.writeFileSync(
  path.join(root, "mindplan", "config.json"),
  JSON.stringify({ implementation_packages: "Off" }, null, 2) + "\n"
);
const badCfg = runCheck([]);
const badOut = `${badCfg.stderr || ""}\n${badCfg.stdout || ""}`;
if (badCfg.status === 0 || !badOut.includes("Blocked: invalid mindplan/config.json")) {
  failures++;
  console.log(`FAIL invalid config should hard-break: status=${badCfg.status} out=${badOut}`);
} else console.log("ok   invalid config hard-breaks check");

try {
  await call("get_node_implementation", { node_id: "wf-feature" });
  failures++;
  console.log("FAIL get_node_implementation should Blocked on invalid config");
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg.includes("Blocked: invalid mindplan/config.json")) {
    failures++;
    console.log(`FAIL expected invalid config Blocked, got: ${msg}`);
  } else console.log("ok   get_node_implementation hard-breaks on invalid config");
}

fs.writeFileSync(path.join(root, "mindplan", "config.json"), "{ not json\n");
const badJson = runCheck([]);
const badJsonOut = `${badJson.stderr || ""}\n${badJson.stdout || ""}`;
if (badJson.status === 0 || !badJsonOut.includes("Blocked: invalid mindplan/config.json")) {
  failures++;
  console.log(`FAIL bad JSON config should hard-break: ${badJsonOut}`);
} else console.log("ok   bad JSON config hard-breaks check");

try {
  await call("create_node", {
    id: "j-should-not-exist",
    type: "Journey",
    title: "Should not exist",
    description: "Partial write regression",
  });
  failures++;
  console.log("FAIL create_node Journey should Blocked on invalid config");
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg.includes("Blocked: invalid mindplan/config.json")) {
    failures++;
    console.log(`FAIL expected invalid config Blocked on create_node, got: ${msg}`);
  } else if (fs.existsSync(path.join(root, "mindplan", "journeys", "j-should-not-exist"))) {
    failures++;
    console.log("FAIL create_node must not leave Journey folder after invalid config");
  } else console.log("ok   create_node hard-breaks before writing on invalid config");
}

const bareInitBad = spawnSync(process.execPath, [serverEntry, "init"], {
  cwd: root,
  env: { ...process.env, MINDPLAN_ROOT: root },
  encoding: "utf-8",
});
const bareInitOut = `${bareInitBad.stderr || ""}\n${bareInitBad.stdout || ""}`;
if (bareInitBad.status === 0 || !bareInitOut.includes("Blocked: invalid mindplan/config.json")) {
  failures++;
  console.log(`FAIL bare init on corrupt config should Blocked: ${bareInitOut}`);
} else console.log("ok   bare init hard-breaks on corrupt config");

const layoutFix = spawnSync(process.execPath, [serverEntry, "init", "--layout", "free"], {
  cwd: root,
  env: { ...process.env, MINDPLAN_ROOT: root },
  encoding: "utf-8",
});
if (layoutFix.status !== 0) {
  failures++;
  console.log(`FAIL --layout free should overwrite corrupt config: ${layoutFix.stderr || layoutFix.stdout}`);
} else {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "mindplan", "config.json"), "utf-8"));
  if (cfg.implementation_packages !== "off") {
    failures++;
    console.log(`FAIL --layout free overwrite: ${JSON.stringify(cfg)}`);
  } else console.log("ok   --layout free overwrites corrupt config");
}

await client.close();

if (failures > 0) {
  console.error(`check.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("check.test.mjs: all ok");
