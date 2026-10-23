/**
 * Project version stamp: init writes mindplan/version.json, a missing or older stamp warns in
 * get_project and check and makes init refresh the package-owned agent files, and a newer stamp
 * makes init refuse without --force.
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
const pkgVersion = JSON.parse(fs.readFileSync(path.join(toolRoot, "package.json"), "utf-8")).version;
const { compareVersions } = await import(
  path.join(toolRoot, "dist/foundations/f-territory-store/version.js")
);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-version-"));
console.log("Version sandbox:", root);

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`ok   ${label}`);
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

function runCli(args) {
  return spawnSync(process.execPath, [serverEntry, ...args], {
    cwd: root,
    env: { ...process.env, MINDPLAN_ROOT: root },
    encoding: "utf-8",
  });
}

const stampFile = path.join(root, "mindplan", "version.json");
const playbookCopy = path.join(root, "mindplan", "agent", "playbook.md");
const skillCopy = path.join(root, ".claude", "skills", "mindplan-plan-project", "SKILL.md");
const agentsMd = path.join(root, "AGENTS.md");
const writeStamp = (pkg, graph = 1) =>
  fs.writeFileSync(stampFile, JSON.stringify({ package: pkg, graph }) + "\n");
const readStamp = () => JSON.parse(fs.readFileSync(stampFile, "utf-8"));

async function getProject() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env, MINDPLAN_ROOT: root },
    stderr: "ignore",
  });
  const client = new Client({ name: "version-test", version: "0.1.0" });
  await client.connect(transport);
  const res = await client.callTool({ name: "get_project", arguments: {} });
  await client.close();
  return JSON.parse(res.content?.[0]?.text ?? "{}");
}

// --- SemVer precedence ---
check("1.2.3 < 1.10.0", compareVersions("1.2.3", "1.10.0") < 0);
check("0.2.0 > 0.1.9", compareVersions("0.2.0", "0.1.9") > 0);
check("a pre-release sorts before its release", compareVersions("1.0.0-rc.1", "1.0.0") < 0);
check("rc.2 > rc.1", compareVersions("1.0.0-rc.2", "1.0.0-rc.1") > 0);
check("build metadata is ignored", compareVersions("1.0.0+abc", "1.0.0") === 0);

// --- before init: no stamp ---
fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
{
  const gp = await getProject();
  check("get_project warns when the stamp is missing", /version\.json is missing/.test(gp.version ?? ""), gp.version);
}

// --- init stamps the running version ---
{
  const res = runCli(["init", "--host", "claude"]);
  check("init succeeds", res.status === 0, res.stderr);
  const stamp = readStamp();
  check("init writes the package version and graph format", stamp.package === pkgVersion && stamp.graph === 1, JSON.stringify(stamp));
  check("init reports the stamp", res.stdout.includes(`Stamped mindplan/version.json (none) → ${pkgVersion}`), res.stdout);
  const gp = await getProject();
  check("get_project omits version when the stamp is current", !("version" in gp), gp.version);
  const chk = runCli(["check"]);
  check("check prints no version warning when current", chk.status === 0 && !chk.stdout.includes("version:"), chk.stdout);
}

// --- an older stamp: warnings, then init refreshes package-owned files only ---
{
  writeStamp("0.0.1");
  fs.writeFileSync(playbookCopy, "stale playbook\n");
  fs.writeFileSync(skillCopy, "stale skill\n");
  fs.writeFileSync(agentsMd, "my own AGENTS.md\n");

  const gp = await getProject();
  check("get_project warns when the stamp is behind", /last initialized with mindplan-mcp 0\.0\.1/.test(gp.version ?? "") && gp.version.includes("init"), gp.version);
  const chk = runCli(["check"]);
  check("check warns when the stamp is behind and still passes", chk.status === 0 && /Warning: version: .*0\.0\.1/.test(chk.stdout), chk.stdout);

  const res = runCli(["init", "--host", "claude"]);
  check("init after an upgrade succeeds", res.status === 0, res.stderr);
  check("init reports the refresh", res.stdout.includes(`0.0.1 → ${pkgVersion} and refreshed`), res.stdout);
  const bundled = fs.readFileSync(path.join(toolRoot, "templates", "agent", "playbook.md"), "utf-8");
  check("init refreshes the playbook copy", fs.readFileSync(playbookCopy, "utf-8") === bundled);
  check("init refreshes the host skill copy", fs.readFileSync(skillCopy, "utf-8") !== "stale skill\n");
  check("init keeps the repo-owned AGENTS.md", fs.readFileSync(agentsMd, "utf-8") === "my own AGENTS.md\n");
  check("init restamps the running version", readStamp().package === pkgVersion);
}

// --- a current stamp: init leaves package-owned files alone ---
{
  fs.writeFileSync(playbookCopy, "edited playbook\n");
  const res = runCli(["init", "--host", "claude"]);
  check("init with a current stamp succeeds", res.status === 0, res.stderr);
  check("init with a current stamp keeps package-owned files", fs.readFileSync(playbookCopy, "utf-8") === "edited playbook\n");
}

// --- an older graph format counts as behind whatever the package says ---
{
  writeStamp(pkgVersion, 0);
  const gp = await getProject();
  check("an older graph format warns", /graph format 0/.test(gp.version ?? ""), gp.version);
}

// --- a newer stamp: warn, and init refuses without --force ---
{
  writeStamp("999.0.0");
  fs.writeFileSync(playbookCopy, "newer playbook\n");
  const gp = await getProject();
  check("get_project warns when the stamp is ahead", /newer than this server/.test(gp.version ?? "") && gp.version.includes("Upgrade mindplan-mcp"), gp.version);
  const res = runCli(["init", "--host", "claude"]);
  check("init refuses a newer stamp", res.status !== 0 && /Blocked: .*999\.0\.0/.test(res.stderr), res.stderr);
  check("the refused init writes nothing", readStamp().package === "999.0.0" && fs.readFileSync(playbookCopy, "utf-8") === "newer playbook\n");
  const forced = runCli(["init", "--host", "claude", "--force"]);
  check("init --force downgrades the stamp", forced.status === 0 && readStamp().package === pkgVersion, forced.stderr);
}

// --- an unreadable stamp ---
{
  fs.writeFileSync(stampFile, "{ not json");
  const chk = runCli(["check"]);
  check("check warns on an unreadable stamp", chk.status === 0 && /Warning: version: .*unreadable/.test(chk.stdout), chk.stdout);
}

fs.rmSync(root, { recursive: true, force: true });

if (failures > 0) {
  console.log(`version.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("version.test.mjs: all ok");
