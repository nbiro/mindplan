/**
 * Setup, upgrade, and the version gate: without mindplan/ every gated tool is Blocked naming
 * setup_project, which creates the graph and returns the pointer and guide; a graph whose stamp is
 * missing or below the migration level is Blocked naming upgrade_project, which migrates it, lists
 * what it changed and the retired host copies, and lets the tools through; a stamp above the level
 * is Blocked naming the package; the check fails in the same states; get_project says restart,
 * gating nothing, once the package is replaced under a running server; get_skill serves the skills;
 * mindplan-mcp init is gone.
 */
import { spawn, spawnSync } from "child_process";
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

const UNGATED = ["get_project", "doctor", "get_rules", "get_spec", "get_skill", "run_check", "setup_project", "upgrade_project"];

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
    ["mindplan/config.json", "mindplan/project.md", "mindplan/version.json", "mindplan/.gitignore"].every((p) => setup.json.changed_files.includes(p)),
    JSON.stringify(setup.json.changed_files)
  );
  check(
    "setup starts the graph with git ignoring the derived map.md",
    fs.readFileSync(path.join(root, "mindplan", ".gitignore"), "utf-8").split(/\r?\n/).includes("map.md")
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
  for (const dir of ["capabilities", "foundations", "interactions", "interfaces", "bugs", "components"]) {
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
    const res = await call(tool, tool === "orient_for_work" ? { query: "x" } : tool === "create_node" ? { id: "j-x", type: "Capability", title: "X", description: "Someone does x." } : {});
    check(`${tool} is Blocked: Version naming upgrade_project`, res.error && res.text.startsWith("Blocked: Version") && res.text.includes("upgrade_project"), res.text);
  }
  check("a Blocked write created nothing", !fs.existsSync(path.join(root, "mindplan", "capabilities", "j-x")));
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
    await must("set_implementation_files", { replace: true, node_id: id, files: [`src/${id}/index.ts`] });
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

// --- level 3: Journey folders move to capabilities/ on upgrade ---
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-capabilities-"));
  const prior = process.env.MINDPLAN_ORIENT_GATE;
  process.env.MINDPLAN_ORIENT_GATE = "off";
  const mp = (...parts) => path.join(root, "mindplan", ...parts);
  const stampFile = mp("version.json");
  const setLevel = (migrations) =>
    fs.writeFileSync(stampFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(stampFile, "utf-8")), migrations }) + "\n");
  const OLD_STUB =
    "_Name the domain capability this Journey owns and which use cases belong inside it. Journey titles alone should scream the product purpose — not the tech stack._";
  /** Turn a Capability folder into the Journey folder a level-2 server wrote. */
  const toLegacy = (id) => {
    fs.mkdirSync(mp("journeys"), { recursive: true });
    fs.renameSync(mp("capabilities", id), mp("journeys", id));
    const file = mp("journeys", id, `${id}.mdx`);
    const text = fs.readFileSync(file, "utf-8");
    fs.writeFileSync(
      file,
      text
        .replace(/^type: Capability$/m, "type: Journey")
        .replace(/_Say what the product does in this Capability[^\n]*_/, OLD_STUB)
        .replace("The Capability state is computed automatically", "The Journey state is computed automatically")
        .replace(/\n/g, "\r\n")
    );
  };
  let client;
  let call;
  try {
    ({ client, call } = await session(root));
    const must = async (name, args) => {
      const res = await call(name, args);
      if (res.error) throw new Error(`${name}: ${res.text}`);
      return res.json;
    };
    await must("setup_project");
    await must("create_node", { id: "j-pay", type: "Capability", title: "Payments", description: "Customers pay for orders." });
    await must("create_node", { id: "j-late", type: "Capability", title: "Refunds", description: "Staff refund an order." });
    await must("create_node", { id: "i-pay", type: "Interaction", title: "Pay", description: "Customer pays the bill." });
    await must("link_nodes", { source_id: "i-pay", target_id: "j-pay", edge_type: "belongs_to" });
    check(
      "create_node scaffolds a Capability under capabilities/ with the new stub",
      fs.readFileSync(mp("capabilities", "j-pay", "j-pay.mdx"), "utf-8").includes("_Say what the product does in this Capability"),
      ""
    );
    await client.close();
    client = undefined;
    toLegacy("j-pay");
    fs.mkdirSync(mp("journeys", "j-pay", "attachments"), { recursive: true });
    fs.writeFileSync(mp("journeys", "j-pay", "attachments", "flow.md"), "flow\n");
    fs.writeFileSync(mp("journeys", ".gitkeep"), "");
    // j-late arrives later, from a branch cut before the upgrade.
    fs.renameSync(mp("capabilities", "j-late"), path.join(root, "j-late"));
    setLevel(2);

    ({ client, call } = await session(root));
    const blocked = await call("list_areas");
    check("a level-2 graph is Blocked naming upgrade_project", blocked.error && blocked.text.includes("upgrade_project"), blocked.text);
    const up = await call("upgrade_project");
    const moved = fs.existsSync(mp("capabilities", "j-pay", "j-pay.mdx")) ? fs.readFileSync(mp("capabilities", "j-pay", "j-pay.mdx"), "utf-8") : "";
    check(
      "upgrade moves the Journey folder to capabilities/ with its attachments and reports the id",
      !up.error &&
        JSON.stringify(up.json.migrations.capabilitiesMoved) === JSON.stringify(["j-pay"]) &&
        fs.existsSync(mp("capabilities", "j-pay", "attachments", "flow.md")) &&
        !fs.existsSync(mp("journeys")) &&
        up.json.changed_files.includes("mindplan/capabilities/j-pay/j-pay.mdx") &&
        up.json.changed_files.includes("mindplan/journeys/j-pay/j-pay.mdx"),
      up.text.slice(0, 600)
    );
    check(
      "upgrade rewrites the type and the old scaffold stub, keeps the id and line endings",
      /^type: Capability\r$/m.test(moved) && !moved.includes("Journey") && moved.includes("_Say what the product does in this Capability") && /^id: j-pay\r$/m.test(moved),
      moved.slice(0, 400)
    );
    const ctx = await call("get_node_context", { node_id: "i-pay" });
    const area = await call("orient_for_work", { query: "pay", area: "j-pay" });
    check(
      "after the upgrade the moved Capability keeps its members",
      !ctx.error && (ctx.json?.record?.belongs_to ?? []).includes("j-pay") && !area.error,
      ctx.text.slice(0, 300) + area.text.slice(0, 300)
    );
    const quiet = await call("upgrade_project");
    check(
      "a second upgrade moves nothing",
      !quiet.error && quiet.json.migrations.capabilitiesMoved.length === 0 && quiet.json.changed_files.length === 0,
      quiet.text.slice(0, 300)
    );
    await client.close();
    client = undefined;

    // A branch from before level 3 merges a Journey folder into a level-3 graph.
    fs.mkdirSync(mp("journeys"), { recursive: true });
    fs.renameSync(path.join(root, "j-late"), mp("journeys", "j-late"));
    ({ client, call } = await session(root));
    const late = await call("list_areas");
    const lateCheck = runCheck(root);
    check(
      "a level-3 stamp with a node under journeys/ is Blocked naming upgrade_project, in tools and the check",
      late.error && late.text.includes("mindplan/journeys/") && late.text.includes("upgrade_project") && lateCheck.status === 1,
      late.text + lateCheck.stderr
    );
    const lateUp = await call("upgrade_project");
    check(
      "upgrade moves the merged-in folder",
      !lateUp.error && JSON.stringify(lateUp.json.migrations.capabilitiesMoved) === JSON.stringify(["j-late"]) && !(await call("list_areas")).error,
      lateUp.text.slice(0, 300)
    );
    await client.close();
    client = undefined;

    // A folder moved by hand keeps type: Journey until the next upgrade repairs it; a leftover
    // folder with no live file under journeys/ is not a node and does not block.
    const handFile = mp("capabilities", "j-late", "j-late.mdx");
    fs.writeFileSync(handFile, fs.readFileSync(handFile, "utf-8").replace(/^type: Capability$/m, "type: Journey"));
    fs.mkdirSync(mp("journeys", "j-ghost", "attachments"), { recursive: true });
    fs.writeFileSync(mp("journeys", "j-ghost", "attachments", ".DS_Store"), "x");
    ({ client, call } = await session(root));
    const stuck = await call("list_areas");
    check(
      "a hand-moved Capability that still says Journey is Blocked naming upgrade_project",
      stuck.error && stuck.text.includes('type "Journey"') && stuck.text.includes("upgrade_project"),
      stuck.text
    );
    const repair = await call("upgrade_project");
    check(
      "a leftover folder with no live file does not block, and upgrade repairs a hand-moved Capability's type",
      !repair.error &&
        repair.json.migrations.capabilitiesMoved.length === 0 &&
        /^type: Capability$/m.test(fs.readFileSync(handFile, "utf-8")) &&
        fs.existsSync(mp("journeys", "j-ghost")) &&
        !fs.existsSync(mp("capabilities", "j-ghost")),
      repair.text.slice(0, 300)
    );
    check("after the repair the gated tools answer", !(await call("list_areas")).error);
    await client.close();
    client = undefined;
    fs.rmSync(mp("journeys"), { recursive: true, force: true });

    // A branch from before level 4 merges a legacy <id>.next.mdx into a current graph: the store
    // never reads it, so the gate sends every tool to upgrade_project, which moves it to revisions/.
    const payLive = mp("interactions", "i-pay", "i-pay.mdx");
    const payNext = mp("interactions", "i-pay", "i-pay.next.mdx");
    const liveText = fs.readFileSync(payLive, "utf-8");
    fs.writeFileSync(payNext, liveText.replace(/^state:.*$/m, "state: draft").replace(/^(type:.*)$/m, "$1\nchange: late-next"));
    ({ client, call } = await session(root));
    const nextGate = await call("list_areas");
    const nextCheck = runCheck(root);
    check(
      "a current stamp beside a legacy next file is Blocked naming the file and upgrade_project, in tools and the check",
      nextGate.error &&
        nextGate.text.includes("Blocked: Version") &&
        nextGate.text.includes("mindplan/interactions/i-pay/i-pay.next.mdx") &&
        nextGate.text.includes("upgrade_project") &&
        nextCheck.status === 1,
      nextGate.text + nextCheck.stderr
    );
    const nextUp = await call("upgrade_project");
    check(
      "upgrade moves the legacy next file into revisions/ and clears the status",
      !nextUp.error &&
        JSON.stringify(nextUp.json.migrations.revisionsMoved) === JSON.stringify([{ node_id: "i-pay", change: "late-next" }]) &&
        !fs.existsSync(payNext) &&
        fs.existsSync(mp("interactions", "i-pay", "revisions", "late-next", "i-pay.mdx")) &&
        !(await call("list_areas")).error,
      nextUp.text.slice(0, 300)
    );
    await client.close();
    client = undefined;
    fs.rmSync(mp("interactions", "i-pay", "revisions"), { recursive: true, force: true });
    // A leftover state: mirror twin is no evolution: it never needs an upgrade.
    fs.writeFileSync(payNext, liveText.replace(/^state:.*$/m, "state: mirror"));
    ({ client, call } = await session(root));
    const mirror = await call("list_areas");
    check("a leftover mirror twin beside a current stamp does not Block", !mirror.error, mirror.text.slice(0, 300));
    await client.close();
    client = undefined;
    fs.rmSync(payNext);

    // The same id in both folders cannot be moved.
    fs.mkdirSync(mp("journeys", "j-pay"), { recursive: true });
    fs.writeFileSync(mp("journeys", "j-pay", "j-pay.mdx"), "---\nid: j-pay\ntype: Journey\ntitle: Old\n---\n");
    ({ client, call } = await session(root));
    const clash = await call("upgrade_project");
    check(
      "an id in both folders is Blocked naming both paths",
      clash.error && clash.text.includes("mindplan/journeys/j-pay") && clash.text.includes("mindplan/capabilities/j-pay"),
      clash.text
    );
  } finally {
    await client?.close();
    if (prior === undefined) delete process.env.MINDPLAN_ORIENT_GATE;
    else process.env.MINDPLAN_ORIENT_GATE = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- level 4: a level-3 graph is Blocked until upgrade_project (upgrade-revisions.test.mjs covers the moves) ---
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-level4-"));
  let client;
  try {
    let call;
    ({ client, call } = await session(root));
    const setup = await call("setup_project");
    check("setup_project on an empty folder succeeds", !setup.error, setup.text);
    await client.close();
    client = undefined;
    const stampFile = path.join(root, "mindplan", "version.json");
    fs.writeFileSync(stampFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(stampFile, "utf-8")), migrations: 3 }) + "\n");
    ({ client, call } = await session(root));
    const blocked = await call("list_areas");
    check("a level-3 graph is Blocked naming upgrade_project", blocked.error && blocked.text.includes("upgrade_project"), blocked.text);
    const up = await call("upgrade_project");
    check(
      "upgrade takes a level-3 graph to level 4 and reports the level-4 passes",
      !up.error &&
        up.json.from_level === 3 &&
        up.json.to_level === 4 &&
        Array.isArray(up.json.migrations.revisionsMoved) &&
        Array.isArray(up.json.migrations.decisionsSplit) &&
        typeof up.json.migrations.mapIgnored === "boolean",
      up.text.slice(0, 400)
    );
    check("after the level-4 upgrade the gated tools answer", !(await call("list_areas")).error);
  } finally {
    await client?.close();
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

// --- a package replaced under the running server: get_project says restart ---
{
  // A copy of the package (its own package.json, dist, templates) whose version the test can change
  // while a server runs from it; node_modules is linked so its imports resolve.
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-pkg-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-restart-"));
  let client;
  try {
    fs.copyFileSync(path.join(toolRoot, "package.json"), path.join(pkg, "package.json"));
    fs.cpSync(path.join(toolRoot, "dist"), path.join(pkg, "dist"), { recursive: true });
    fs.cpSync(path.join(toolRoot, "templates"), path.join(pkg, "templates"), { recursive: true });
    fs.symlinkSync(path.join(toolRoot, "node_modules"), path.join(pkg, "node_modules"), "junction");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(pkg, "dist/index.js")],
      env: { ...process.env, MINDPLAN_ROOT: root },
      stderr: "ignore",
    });
    client = new Client({ name: "version-test", version: "0.1.0" });
    await client.connect(transport);
    const project = async () => JSON.parse((await client.callTool({ name: "get_project", arguments: {} })).content[0].text);
    const before = await project();
    check("get_project has no restart while the booted package is installed", before.restart === undefined, JSON.stringify(before.restart));
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf-8"));
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ ...manifest, version: "99.0.0" }, null, 2) + "\n");
    const noGraph = await project();
    check(
      "get_project names the installed and running versions after the package is replaced",
      typeof noGraph.restart === "string" &&
        noGraph.restart.includes("99.0.0") &&
        noGraph.restart.includes(pkgVersion) &&
        noGraph.restart.includes("get_project"),
      JSON.stringify(noGraph.restart)
    );
    check("restart leaves version as the running server's own warning", (noGraph.version ?? "").includes("setup_project"), noGraph.version);
    const setup = await client.callTool({ name: "setup_project", arguments: {} });
    check("setup_project runs on a replaced package", !setup.isError, setup.content?.[0]?.text);
    const current = await project();
    check("a current graph still gets restart, and no version", typeof current.restart === "string" && current.version === undefined, JSON.stringify(current));
    const gated = await client.callTool({ name: "list_areas", arguments: {} });
    check("restart gates no tool", !gated.isError, gated.content?.[0]?.text);
  } finally {
    await client?.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.unlinkSync(path.join(pkg, "node_modules"));
    fs.rmSync(pkg, { recursive: true, force: true });
  }
}

// --- gated and ungated tools ---
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-gate-list-"));
  const { client } = await session(root);
  const { tools } = await client.listTools();
  check("the server lists thirty-seven tools", tools.length === 37, String(tools.length));
  const names = tools.map((t) => t.name);
  check("setup_project and upgrade_project come last", names.slice(-2).join(",") === "setup_project,upgrade_project", names.slice(-3).join(","));
  check("get_skill follows get_spec", names[names.indexOf("get_spec") + 1] === "get_skill", names.join(","));
  check("doctor follows get_project", names[names.indexOf("get_project") + 1] === "doctor", names.join(","));
  for (const name of UNGATED) {
    if (name === "setup_project" || name === "upgrade_project" || name === "run_check") continue;
    const res = await client.callTool({ name, arguments: {} });
    check(`${name} answers without a graph`, !res.isError, res.content?.[0]?.text);
  }
  await client.close();
  check("listing and reading tools created no mindplan/", !fs.existsSync(path.join(root, "mindplan")));
  fs.rmSync(root, { recursive: true, force: true });
}

// --- doctor: answers in every gate state ---
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-doctor-"));
  let client;
  try {
    let call;
    ({ client, call } = await session(root));
    const none = await call("doctor");
    check(
      "doctor answers without a graph with status setup",
      !none.error && none.json?.graph?.status === "setup" && none.json.graph.server_level === MIGRATION_LEVEL,
      none.text
    );
    check(
      "doctor reports version, node, root, caches, start time and uptime",
      none.json?.version === pkgVersion &&
        none.json.node === process.version &&
        path.resolve(none.json.root) === path.resolve(root) &&
        typeof none.json.cache?.graph === "boolean" &&
        typeof none.json.cache?.search === "boolean" &&
        !Number.isNaN(Date.parse(none.json.started_at)) &&
        typeof none.json.uptime_s === "number",
      none.text
    );
    check("doctor on a missing graph creates no mindplan/", !fs.existsSync(path.join(root, "mindplan")));
    await call("setup_project");
    const current = await call("doctor");
    check(
      "doctor on a current graph reports a numeric load_ms_cached, cache_hit, and no load_error",
      !current.error &&
        current.json?.graph?.status === "current" &&
        current.json.graph.level === MIGRATION_LEVEL &&
        typeof current.json.load_ms_cached === "number" &&
        typeof current.json.cache_hit === "boolean" &&
        !("load_ms" in current.json) &&
        current.json.load_error === undefined,
      current.text
    );
    const again = await call("doctor");
    check("doctor sees the graph cache once the graph loaded", again.json?.cache?.graph === true, again.text);
    check("doctor on a freshly set-up graph with no nodes reports no cache hit", again.json?.cache_hit === false, again.text);
    // A legacy current.mdx beside its id-named twin: a load would delete it, so doctor does not load.
    await call("create_node", { id: "f-doc", type: "Foundation", title: "Doc", description: "Infra — doc", role: "infra" });
    await call("doctor");
    const hit = await call("doctor");
    check("a second doctor load of a graph with a node is a cache hit", hit.json?.cache_hit === true, hit.text);
    const folder = path.join(root, "mindplan", "foundations", "f-doc");
    fs.copyFileSync(path.join(folder, "f-doc.mdx"), path.join(folder, "current.mdx"));
    const legacy = await call("doctor");
    check(
      "doctor never loads when a load would remove legacy files, and names them",
      legacy.json?.load_ms_cached === 0 &&
        String(legacy.json?.load_error).includes("mindplan/foundations/f-doc/current.mdx") &&
        fs.existsSync(path.join(folder, "current.mdx")),
      legacy.text
    );
    fs.rmSync(path.join(folder, "current.mdx"));
    await client.close();
    client = undefined;
    const stampFile = path.join(root, "mindplan", "version.json");
    fs.writeFileSync(stampFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(stampFile, "utf-8")), migrations: 3 }) + "\n");
    ({ client, call } = await session(root));
    const behind = await call("doctor");
    check(
      "doctor answers on a level-3 graph with status upgrade and level 3",
      !behind.error && behind.json?.graph?.status === "upgrade" && behind.json.graph.level === 3 && behind.json.load_ms_cached === 0,
      behind.text
    );
  } finally {
    await client?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- startup: initialize is answered before any graph work; crashes and early exits are logged ---
/** Spawns the server on `root` with raw stdio; collects stderr lines with arrival order. */
function rawServer(root, env = {}) {
  const child = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, MINDPLAN_ROOT: root, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d;
    events.push("stdout");
  });
  child.stderr.on("data", (d) => {
    stderr += d;
    events.push(`stderr:${d}`);
  });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
  const until = (pred, ms) =>
    new Promise((resolve) => {
      const start = Date.now();
      const tick = () => (pred() ? resolve(true) : Date.now() - start > ms ? resolve(false) : setTimeout(tick, 20));
      tick();
    });
  return { child, events, exited, send, until, out: () => stdout, err: () => stderr };
}
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "startup-test", version: "1" } },
};
function bigGraph(n) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-big-"));
  for (let i = 0; i < n; i++) {
    const id = `j-${String(i).padStart(5, "0")}`;
    const dir = path.join(root, "mindplan", "capabilities", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${id}.mdx`),
      ["---", `id: ${id}`, "type: Capability", `title: Capability ${i}`, "description: A capability.", "state: draft",
        "created_at: 2026-01-01T00:00:00.000Z", "updated_at: 2026-01-01T00:00:00.000Z", "---", "", "## Purpose", "", `Body of ${id}.`, ""].join("\n")
    );
  }
  fs.writeFileSync(path.join(root, "mindplan", "config.json"), JSON.stringify({ sources: [], exclude: [] }) + "\n");
  return root;
}
{
  const root = bigGraph(1500);
  const server = rawServer(root);
  try {
    server.send(INITIALIZE);
    const answered = await server.until(() => server.out().includes("\n"), 15000);
    const first = server.out().split("\n")[0];
    let reply = null;
    try {
      reply = JSON.parse(first);
    } catch {
      reply = null;
    }
    check("a 1500-node graph: initialize is answered", answered && reply?.id === 1 && !!reply.result?.serverInfo, first.slice(0, 200));
    // The graph warm-up waits for the client's initialized notification, so nothing loads before it.
    await new Promise((r) => setTimeout(r, 500));
    check("no graph load starts before the client is initialized", !server.err().includes("warm-up started"), server.err());
    server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    check("the graph warm-up starts after initialized", await server.until(() => server.err().includes("warm-up started"), 10000), server.err());
    check("stdout carries only JSON-RPC", server.out().split("\n").filter(Boolean).every((l) => { try { JSON.parse(l); return true; } catch { return false; } }), server.out().slice(0, 300));
  } finally {
    server.child.kill();
    await server.exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-early-exit-"));
  const server = rawServer(root);
  server.child.stdin.end();
  const code = await Promise.race([server.exited, new Promise((r) => setTimeout(() => r("timeout"), 10000))]);
  if (code === "timeout") {
    server.child.kill();
    await server.exited;
  }
  check(
    "stdin closed before initialize: the server logs why it exits and exits",
    code === 0 && server.err().includes("mindplan-mcp: exiting (stdin closed before initialize)"),
    `${code} ${server.err()}`
  );
  check("an early exit writes nothing to stdout", server.out() === "", server.out());
  fs.rmSync(root, { recursive: true, force: true });
}
for (const [mode, label] of [["boot", "an uncaught exception"], ["rejection", "an unhandled rejection"]]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-crash-"));
  const server = rawServer(root, { MINDPLAN_TEST_CRASH: mode });
  server.send(INITIALIZE);
  await server.until(() => server.out().includes("\n"), 10000);
  server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const code = await Promise.race([server.exited, new Promise((r) => setTimeout(() => r("timeout"), 10000))]);
  if (code === "timeout") {
    server.child.kill();
    await server.exited;
  }
  check(
    `${label} logs mindplan-mcp: fatal: with its stack and exits 1`,
    code === 1 && /mindplan-mcp: fatal: .*MINDPLAN_TEST_CRASH/.test(server.err()) && /\n\s+at /.test(server.err()),
    `${code} ${server.err()}`
  );
  check(`${label} writes no non-JSON-RPC to stdout`, server.out().split("\n").filter(Boolean).every((l) => l.startsWith("{")), server.out());
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
