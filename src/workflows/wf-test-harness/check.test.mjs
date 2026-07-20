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

await client.close();

if (failures > 0) {
  console.error(`check.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("check.test.mjs: all ok");
