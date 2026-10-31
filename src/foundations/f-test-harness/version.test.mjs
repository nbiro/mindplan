/**
 * Setup, upgrade, and the version gate: without mindplan/ every gated tool is Blocked naming
 * setup_project, which creates the graph and returns the pointer and guide; a graph whose stamp is
 * missing or below the migration level is Blocked naming upgrade_project, which migrates it, lists
 * what it changed and the retired host copies, and lets the tools through; a stamp above the level
 * is Blocked naming the package; the check fails in the same states; get_skill serves the skills;
 * mindplan-mcp init is gone.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SHIP, fillAndTick } from "./ship-fixture.mjs";
// Spawned servers rank by keyword only: no model download or load during tests.
process.env.MINDPLAN_SEARCH ??= "keyword";
// This suite is about the gate, so it is on.
delete process.env.MINDPLAN_VERSION_GATE;

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");
const pkgVersion = JSON.parse(fs.readFileSync(path.join(toolRoot, "package.json"), "utf-8")).version;
const { compareVersions } = await import(
  pathToFileURL(path.join(toolRoot, "dist/foundations/f-territory-store/version.js")).href
);
const { MIGRATION_LEVEL } = await import(
  pathToFileURL(path.join(toolRoot, "dist/foundations/f-graph-migrations/migrations.js")).href
);

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`ok   ${label}`);
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const UNGATED = ["get_project", "get_rules", "get_spec", "get_skill", "run_check", "setup_project", "upgrade_project"];

/** One server session rooted at `root`; call returns { error, text, json }. */
async function session(root) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env, MINDPLAN_ROOT: root },
    stderr: "ignore",
  });
  const client = new Client({ name: "version-test", version: "0.1.0" });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? "";
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { error: !!res.isError, text, json };
  };
  return { client, call };
}

function runCheck(root) {
  return spawnSync(process.execPath, [serverEntry, "check"], {
    cwd: root,
    env: { ...process.env, MINDPLAN_ROOT: root },
    encoding: "utf-8",
  });
}

// --- no graph: setup ---
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-setup-"));
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Mine\n");
  const { client, call } = await session(root);
  check("the server creates no mindplan/ at boot", !fs.existsSync(path.join(root, "mindplan")));
  const project = await call("get_project");
  check("get_project answers without a graph and names setup_project", !project.error && /setup_project/.test(project.json?.version ?? ""), project.text);
  const blocked = await call("list_areas");
  check("a gated tool is Blocked: Version naming setup_project", blocked.error && blocked.text.startsWith("Blocked: Version") && blocked.text.includes("setup_project"), blocked.text);
  const rules = await call("get_rules");
  check("get_rules answers without a graph", !rules.error, rules.text);
  const skills = await call("get_skill");
  check(
    "get_skill lists the served skills",
    !skills.error && skills.json.skills.map((s) => s.name).join(",") === "define-entities,plan-project" && skills.json.skills.every((s) => s.description.length > 20),
    skills.text
  );
  const plan = await call("get_skill", { name: "plan-project" });
  check("get_skill returns a skill without its frontmatter", !plan.error && plan.json.text.startsWith("# ") && !plan.json.text.includes("description:"), plan.text.slice(0, 200));
  const example = await call("get_skill", { name: "define-entities", file: "examples.md" });
  check("get_skill returns a supporting file", !example.error && example.json.text.length > 100, example.text.slice(0, 200));
  const badSkill = await call("get_skill", { name: "nope" });
  const badFile = await call("get_skill", { name: "plan-project", file: "../define-entities/SKILL.md" });
  check("an unknown skill or a path out of the folder is Blocked", badSkill.error && badSkill.text.includes("plan-project") && badFile.error, badSkill.text + badFile.text);
  const noCheck = runCheck(root);
  check("the check fails without a graph, naming setup_project", noCheck.status === 1 && noCheck.stderr.includes("Blocked: Version") && noCheck.stderr.includes("setup_project"), noCheck.stderr);
  const upgradeFirst = await call("upgrade_project");
  check("upgrade_project without a graph is Blocked naming setup_project", upgradeFirst.error && upgradeFirst.text.includes("setup_project"), upgradeFirst.text);

  const setup = await call("setup_project");
  check("setup_project creates the graph", !setup.error && setup.json.created === true, setup.text);
  const stamp = JSON.parse(fs.readFileSync(path.join(root, "mindplan", "version.json"), "utf-8"));
  check("setup stamps the package and the migration level", stamp.package === pkgVersion && stamp.migrations === MIGRATION_LEVEL && stamp.graph === 1, JSON.stringify(stamp));
  check(
    "setup lists the files it wrote",
    ["mindplan/config.json", "mindplan/project.md", "mindplan/version.json"].every((p) => setup.json.changed_files.includes(p)),
    JSON.stringify(setup.json.changed_files)
  );
  check(
    "setup returns the MINDPLAN.md pointer and the guide",
    setup.json.pointer.includes("get_project") && setup.json.pointer.includes("get_skill") && setup.json.guide.includes("MINDPLAN.md"),
    setup.text.slice(0, 300)
  );
  check(
    "setup writes no file the user owns",
    fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8") === "# Mine\n" &&
      !["AGENTS.md", "MINDPLAN.md", ".gitignore", ".cursorignore"].some((f) => fs.existsSync(path.join(root, f))),
    fs.readdirSync(root).join(",")
  );
  const areas = await call("list_areas");
  check("after setup the gated tools answer", !areas.error, areas.text);
  const again = await call("setup_project");
  check("a second setup writes nothing and returns the guide", !again.error && again.json.created === false && again.json.changed_files.length === 0 && again.json.guide.length > 0, again.text.slice(0, 300));
  const project2 = await call("get_project");
  check("get_project carries no version field once current", !project2.error && project2.json.version === undefined, project2.text.slice(0, 200));
  const okCheck = runCheck(root);
  check("the check passes after setup", okCheck.status === 0, okCheck.stderr + okCheck.stdout);
  await client.close();
  fs.rmSync(root, { recursive: true, force: true });
}

// --- empty folders a 0.12 server left at boot (no stamp, no node): still setup ---
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-setup-leftover-"));
  for (const dir of ["journeys", "foundations", "interactions", "interfaces", "bugs", "components"]) {
    fs.mkdirSync(path.join(root, "mindplan", dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "mindplan", "components", ".gitkeep"), "");
  const { client, call } = await session(root);
  const blocked = await call("list_areas");
  check("empty folders without a stamp are Blocked naming setup_project", blocked.error && blocked.text.includes("setup_project"), blocked.text);
  const setup = await call("setup_project");
  check("setup_project finishes a graph that has folders but no stamp or node", !setup.error && setup.json.created === true && fs.existsSync(path.join(root, "mindplan", "version.json")), setup.text.slice(0, 300));
  await client.close();
  fs.rmSync(root, { recursive: true, force: true });
}

// --- graph behind the server: upgrade ---
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-upgrade-"));
  fs.mkdirSync(path.join(root, "mindplan", "agent", "skills", "plan-project"), { recursive: true });
  fs.writeFileSync(path.join(root, "mindplan", "agent", "playbook.md"), "old playbook\n");
  fs.writeFileSync(path.join(root, "mindplan", "agent", "skills", "plan-project", "SKILL.md"), "old skill\n");
  fs.writeFileSync(path.join(root, "mindplan", "config.json"), JSON.stringify({ sources: ["src/**"], exclude: [] }) + "\n");
  // A stamp written by init: no migration level.
  fs.writeFileSync(path.join(root, "mindplan", "version.json"), JSON.stringify({ package: "0.12.0", graph: 1 }) + "\n");
  fs.mkdirSync(path.join(root, ".claude", "skills", "mindplan-plan-project"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "skills", "mindplan-plan-project", "SKILL.md"), "old copy\n");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# MindPlan\n\n- If tools are unavailable, use the init-installed host copies.\n");
  const { client, call } = await session(root);
  const project = await call("get_project");
  check("get_project names upgrade_project for a stamp from init", /upgrade_project/.test(project.json?.version ?? ""), project.text.slice(0, 300));
  for (const tool of ["orient_for_work", "create_node", "list_areas"]) {
    const res = await call(tool, tool === "orient_for_work" ? { query: "x" } : tool === "create_node" ? { id: "j-x", type: "Journey", title: "X", description: "Someone does x." } : {});
    check(`${tool} is Blocked: Version naming upgrade_project`, res.error && res.text.startsWith("Blocked: Version") && res.text.includes("upgrade_project"), res.text);
  }
  check("a Blocked write created nothing", !fs.existsSync(path.join(root, "mindplan", "journeys", "j-x")));
  const behindCheck = runCheck(root);
  check("the check fails on a graph behind the server, naming upgrade_project", behindCheck.status === 1 && behindCheck.stderr.includes("upgrade_project"), behindCheck.stderr);
  const setupBlocked = await call("setup_project");
  check("setup_project on a graph behind the server is Blocked naming upgrade_project", setupBlocked.error && setupBlocked.text.includes("upgrade_project"), setupBlocked.text);

  const up = await call("upgrade_project");
  check("upgrade_project succeeds", !up.error, up.text);
  check("upgrade reports the levels", up.json?.from_level === 0 && up.json?.to_level === MIGRATION_LEVEL, up.text.slice(0, 200));
  check(
    "upgrade removes mindplan/agent/ and lists its files and the stamp",
    !fs.existsSync(path.join(root, "mindplan", "agent")) &&
      up.json.changed_files.includes("mindplan/agent/playbook.md") &&
      up.json.changed_files.includes("mindplan/version.json") &&
      up.json.migrations.agentFilesRemoved.length === 2,
    JSON.stringify(up.json?.changed_files)
  );
  check(
    "upgrade names the retired host copy and leaves it",
    JSON.stringify(up.json.leftovers) === JSON.stringify([".claude/skills/mindplan-plan-project/"]) &&
      fs.existsSync(path.join(root, ".claude", "skills", "mindplan-plan-project", "SKILL.md")),
    JSON.stringify(up.json.leftovers)
  );
  check("upgrade flags the retired stub and returns the guide", up.json.pointer_outdated === true && up.json.guide.includes("leftovers"), up.text.slice(-300));
  check("upgrade leaves AGENTS.md alone", fs.readFileSync(path.join(root, "AGENTS.md"), "utf-8").includes("init-installed"));
  const stamp = JSON.parse(fs.readFileSync(path.join(root, "mindplan", "version.json"), "utf-8"));
  check("upgrade stamps the migration level", stamp.migrations === MIGRATION_LEVEL && stamp.package === pkgVersion, JSON.stringify(stamp));
  const areas = await call("list_areas");
  check("after the upgrade the gated tools answer", !areas.error, areas.text);
  const again = await call("upgrade_project");
  check("a second upgrade changes nothing", !again.error && again.json.changed_files.length === 0, JSON.stringify(again.json?.changed_files));
  fs.writeFileSync(path.join(root, "MINDPLAN.md"), up.json.pointer);
  fs.writeFileSync(path.join(root, "AGENTS.md"), "Read and follow MINDPLAN.md before answering or writing code.\n");
  const wired = await call("upgrade_project");
  check("once MINDPLAN.md matches and the stub is gone, the pointer is current", wired.json?.pointer_outdated === false, wired.text.slice(0, 200));
  await client.close();
  fs.rmSync(root, { recursive: true, force: true });
}

// --- level 2: change labels on shipped nodes are stripped on upgrade ---
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-stale-labels-"));
  const env = { MINDPLAN_ORIENT_GATE: "off" };
  const prior = process.env.MINDPLAN_ORIENT_GATE;
  Object.assign(process.env, env);
  let client;
  let call;
  try {
  ({ client, call } = await session(root));
  const must = async (name, args) => {
    const res = await call(name, args);
    if (res.error) throw new Error(`${name}: ${res.text}`);
    return res.json;
  };
  /** Write a live `change:` scalar the way releases before 0.15.0 labeled a neighbor. */
  const label = (id, change) => {
    const file = path.join(root, "mindplan", "foundations", id, `${id}.mdx`);
    const text = fs.readFileSync(file, "utf-8");
    fs.writeFileSync(file, text.replace(/^(id: .*)$/m, (line) => `${line}\nchange: "${change}"`));
  };
  await must("setup_project");
  fs.writeFileSync(path.join(root, "mindplan", "config.json"), JSON.stringify({ sources: ["src/**"], exclude: [] }) + "\n");
  // Three shipped Foundations: f-stale (label of a change with no revision), f-live (label of a
  // change with a pre-ship member), f-plain (no label); f-new is that pre-ship member.
  for (const id of ["f-stale", "f-live", "f-plain"]) {
    await must("create_node", { id, type: "Foundation", title: id, description: `Infra — ${id}`, role: "infra" });
    fs.mkdirSync(path.join(root, "src", id), { recursive: true });
    fs.writeFileSync(path.join(root, "src", id, "index.ts"), "export const x = 1;\n");
    await must("set_implementation_files", { node_id: id, files: [`src/${id}/index.ts`] });
    fillAndTick(path.join(root, "mindplan", "foundations", id, `${id}.mdx`));
    for (const new_status of SHIP) await must("update_node_status", { node_id: id, new_status });
  }
  await must("create_node", { id: "f-new", type: "Foundation", title: "New", description: "Infra — new", role: "infra", change: "live" });
  // f-live also has an open revision: older releases left the label on live beside it.
  await must("open_next", { node_id: "f-live", change: "rev" });
  await client.close();
  client = undefined;
  label("f-live", "live");
  label("f-stale", "hotspot-triage");
  // Back to level 1, as a graph a 0.14 server left.
  const stampFile = path.join(root, "mindplan", "version.json");
  fs.writeFileSync(stampFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(stampFile, "utf-8")), migrations: 1 }) + "\n");
  ({ client, call } = await session(root));
  const blocked = await call("list_areas");
  check("a level-1 graph is Blocked naming upgrade_project", blocked.error && blocked.text.includes("upgrade_project"), blocked.text);
  const up = await call("upgrade_project");
  const changeOf = async (id) => (await call("get_node_context", { node_id: id })).json?.record?.change;
  check(
    "upgrade strips every shipped node's change label, whatever its change, and reports each",
    !up.error &&
      JSON.stringify(up.json.migrations.staleChangeLabelsCleared) ===
        JSON.stringify([
          { node_id: "f-live", change: "live" },
          { node_id: "f-stale", change: "hotspot-triage" },
        ]) &&
      up.json.changed_files.includes("mindplan/foundations/f-stale/f-stale.mdx") &&
      up.json.changed_files.includes("mindplan/foundations/f-live/f-live.mdx") &&
      (await changeOf("f-stale")) === undefined &&
      (await changeOf("f-live")) === undefined,
    up.text.slice(0, 600)
  );
  check(
    "the label on a node with an open revision is stripped from live and the revision keeps its own change",
    (await call("get_node_context", { node_id: "f-live" })).json?.next?.record?.change === "rev",
    ""
  );
  check(
    "upgrade keeps a pre-ship node's change and leaves an unlabeled node alone",
    (await changeOf("f-new")) === "live" &&
      !up.json.changed_files.includes("mindplan/foundations/f-new/f-new.mdx") &&
      !up.json.changed_files.includes("mindplan/foundations/f-plain/f-plain.mdx"),
    JSON.stringify(up.json.changed_files)
  );
  const quiet = await call("upgrade_project");
  check(
    "a second upgrade clears nothing",
    !quiet.error && quiet.json.migrations.staleChangeLabelsCleared.length === 0 && quiet.json.changed_files.length === 0,
    quiet.text.slice(0, 300)
  );
  // A branch from an older release merged later brings a label back; the next upgrade strips it.
  await client.close();
  client = undefined;
  label("f-plain", "old-branch");
  ({ client, call } = await session(root));
  const again = await call("upgrade_project");
  check(
    "an upgrade of a graph already at level 2 strips a label merged in later",
    !again.error &&
      JSON.stringify(again.json.migrations.staleChangeLabelsCleared) === JSON.stringify([{ node_id: "f-plain", change: "old-branch" }]) &&
      (await changeOf("f-plain")) === undefined,
    again.text.slice(0, 300)
  );
  } finally {
    await client?.close();
    if (prior === undefined) delete process.env.MINDPLAN_ORIENT_GATE;
    else process.env.MINDPLAN_ORIENT_GATE = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- graph ahead of the server ---
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-ahead-"));
  fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
  fs.writeFileSync(path.join(root, "mindplan", "config.json"), JSON.stringify({ sources: [], exclude: [] }) + "\n");
  fs.writeFileSync(
    path.join(root, "mindplan", "version.json"),
    JSON.stringify({ package: "99.0.0", graph: 1, migrations: MIGRATION_LEVEL + 1 }) + "\n"
  );
  const { client, call } = await session(root);
  const project = await call("get_project");
  check("get_project names the package for a graph ahead of the server", (project.json?.version ?? "").includes("mindplan-mcp@99.0.0"), project.text.slice(0, 300));
  const blocked = await call("list_areas");
  const up = await call("upgrade_project");
  const setup = await call("setup_project");
  check(
    "gated tools, upgrade, and setup are Blocked on a graph ahead of the server",
    blocked.error && blocked.text.includes("99.0.0") && up.error && setup.error,
    [blocked.text, up.text, setup.text].join(" | ")
  );
  const stamp = JSON.parse(fs.readFileSync(path.join(root, "mindplan", "version.json"), "utf-8"));
  check("a refused upgrade leaves the newer stamp", stamp.package === "99.0.0");
  await client.close();
  fs.rmSync(root, { recursive: true, force: true });
}

// --- gated and ungated tools ---
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-gate-list-"));
  const { client } = await session(root);
  const { tools } = await client.listTools();
  check("the server lists thirty-three tools", tools.length === 33, String(tools.length));
  const names = tools.map((t) => t.name);
  check("setup_project and upgrade_project come last", names.slice(-2).join(",") === "setup_project,upgrade_project", names.slice(-3).join(","));
  check("get_skill follows get_spec", names[names.indexOf("get_spec") + 1] === "get_skill", names.join(","));
  for (const name of UNGATED) {
    if (name === "setup_project" || name === "upgrade_project" || name === "run_check") continue;
    const res = await client.callTool({ name, arguments: {} });
    check(`${name} answers without a graph`, !res.isError, res.content?.[0]?.text);
  }
  await client.close();
  check("listing and reading tools created no mindplan/", !fs.existsSync(path.join(root, "mindplan")));
  fs.rmSync(root, { recursive: true, force: true });
}

// --- the init command is gone ---
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-no-init-"));
  const res = spawnSync(process.execPath, [serverEntry, "init"], { cwd: root, env: { ...process.env, MINDPLAN_ROOT: root }, encoding: "utf-8" });
  check("mindplan-mcp init exits 1 and names both tools", res.status === 1 && res.stderr.includes("setup_project") && res.stderr.includes("upgrade_project"), res.stderr);
  check("mindplan-mcp init writes nothing", fs.readdirSync(root).length === 0, fs.readdirSync(root).join(","));
  const help = spawnSync(process.execPath, [serverEntry, "help"], { encoding: "utf-8" });
  check("help names setup_project and has no init command", help.stdout.includes("setup_project") && !/mindplan-mcp init/.test(help.stdout), help.stdout);
  fs.rmSync(root, { recursive: true, force: true });
}

// --- SemVer comparison ---
check("1.2.3 < 1.10.0", compareVersions("1.2.3", "1.10.0") < 0);
check("0.2.0 > 0.1.9", compareVersions("0.2.0", "0.1.9") > 0);
check("a pre-release sorts before its release", compareVersions("1.0.0-rc.1", "1.0.0") < 0);
check("rc.2 > rc.1", compareVersions("1.0.0-rc.2", "1.0.0-rc.1") > 0);
check("build metadata is ignored", compareVersions("1.0.0+abc", "1.0.0") === 0);

if (failures > 0) {
  console.log(`\nversion.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nversion.test.mjs: all ok");
