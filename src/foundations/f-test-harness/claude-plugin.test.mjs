/**
 * The Claude Code plugin (if-claude-plugin): `mindplan-mcp hook session-start` (i-read-brief),
 * `mindplan-mcp hook stop` (i-check-integrity), unknown hook names (if-cli), the plugin launcher
 * (plugin/scripts/mindplan.mjs), and the plugin and marketplace config. Run via npm test.
 */
process.env.MINDPLAN_SEARCH ??= "keyword";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");
const launcher = path.join(toolRoot, "plugin/scripts/mindplan.mjs");

let failures = 0;
function ok(name, cond, detail = "") {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const noCi = { ...process.env };
delete noCi.CI;
delete noCi.MINDPLAN_VERSION_GATE;

function git(cwd, ...args) {
  return spawnSync("git", args, { cwd, encoding: "utf-8" });
}

/** Runs `mindplan-mcp hook <name>` in root with the payload on stdin. */
function hook(root, name, payload) {
  const res = spawnSync(process.execPath, [serverEntry, "hook", name], {
    cwd: root,
    input: payload === undefined ? "" : JSON.stringify(payload),
    env: { ...noCi, MINDPLAN_ROOT: root },
    encoding: "utf-8",
  });
  return { status: res.status, stdout: res.stdout.trim(), stderr: res.stderr };
}

async function connect(root) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...noCi, MINDPLAN_ROOT: root },
  });
  const client = new Client({ name: "claude-plugin-test", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

async function call(client, tool, args) {
  const res = await client.callTool({ name: tool, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  return { isError: Boolean(res.isError), text };
}

// --- A project with a graph and one rule, committed --------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-claude-plugin-"));
console.log("Claude-plugin sandbox:", root);
git(root, "init", "-q");
git(root, "config", "user.email", "test@example.com");
git(root, "config", "user.name", "Test");
{
  const client = await connect(root);
  await call(client, "setup_project", {});
  await call(client, "get_project", {});
  const patched = await call(client, "patch_project_rules", { add: ["Plugin-test rule: keep hooks quiet."] });
  ok("fixture: project rule written", !patched.isError, patched.text);
  await client.close();
}
fs.writeFileSync(path.join(root, ".gitignore"), "mindplan/.cache/\n");
git(root, "add", "-A");
git(root, "commit", "-q", "-m", "fixture");

// --- SessionStart -------------------------------------------------------------------------------
{
  const res = hook(root, "session-start", { source: "startup" });
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    parsed = null;
  }
  const ctx = parsed?.hookSpecificOutput?.additionalContext ?? "";
  ok("session-start: exits 0", res.status === 0, res.stderr);
  ok("session-start: SessionStart event name", parsed?.hookSpecificOutput?.hookEventName === "SessionStart");
  ok("session-start: carries the project rule", ctx.includes("Plugin-test rule: keep hooks quiet."));
  ok("session-start: carries the rules_version", /rules_version [0-9a-f]{6,}/.test(ctx), ctx.slice(0, 300));
  ok("session-start: carries the playbook", ctx.includes("think in systems"));
  ok("session-start: names the write gate", ctx.includes("get_project"));
  ok("session-start: compact also injects", hook(root, "session-start", { source: "compact" }).stdout.length > 0);
  ok("session-start: resume prints nothing", hook(root, "session-start", { source: "resume" }).stdout === "");
  ok("session-start: malformed input prints nothing", hook(root, "session-start").stdout === "");
  ok("session-start: the gate line comes first", ctx.indexOf("get_rules({ known_version") < ctx.indexOf("## Project rules"));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-claude-plugin-bare-"));
  ok("session-start: no graph prints nothing", hook(bare, "session-start", { source: "startup" }).stdout === "");
}

// The hook does not clear the server's rules gate (d-hook-brief-not-gate).
{
  hook(root, "session-start", { source: "startup" });
  const client = await connect(root);
  const res = await call(client, "create_node", {
    id: "i-gate-probe",
    type: "Interaction",
    title: "Gate probe",
    description: "Agent probes the rules gate.",
  });
  ok("session-start: a write before get_project is still Blocked: Rules", res.isError && res.text.includes("Blocked: Rules"), res.text);
  await client.close();
}

// A brief over the hook's size limit leaves the playbook out and keeps the rules.
{
  const big = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-claude-plugin-big-"));
  const client = await connect(big);
  await call(client, "setup_project", {});
  await call(client, "get_project", {});
  const long = Array.from({ length: 40 }, (_, i) => `Long rule ${i}: ${"keep every rule in the brief ".repeat(4)}`);
  await call(client, "patch_project_rules", { add: long });
  await client.close();
  const ctx = JSON.parse(hook(big, "session-start", { source: "startup" }).stdout || "{}")?.hookSpecificOutput?.additionalContext ?? "";
  ok("session-start: a long brief stays under 10,000 characters", ctx.length > 0 && ctx.length <= 10000, String(ctx.length));
  ok("session-start: a long brief keeps every rule", ctx.includes("Long rule 39:"));
  ok("session-start: a long brief names the left-out playbook", ctx.includes("get_project returns it") && !ctx.includes("think in systems"));
}

// --- Stop ---------------------------------------------------------------------------------------
{
  ok("stop: clean tree prints nothing", hook(root, "stop", { stop_hook_active: false }).stdout === "");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "orphan.ts"), "export const orphan = 1;\n");
  const res = hook(root, "stop", { stop_hook_active: false });
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    parsed = null;
  }
  ok("stop: exits 0", res.status === 0, res.stderr);
  ok("stop: blocks an unclaimed source file", parsed?.decision === "block", res.stdout);
  ok("stop: reason names Coverage", (parsed?.reason ?? "").includes("Blocked: Coverage"), parsed?.reason);
  ok("stop: reason leaves warnings out", !(parsed?.reason ?? "").includes("Warning:"));
  ok("stop: second stop passes", hook(root, "stop", { stop_hook_active: true }).stdout === "");
  fs.rmSync(path.join(root, "src"), { recursive: true, force: true });
  ok("stop: passing check prints nothing", hook(root, "stop", {}).stdout === "");
}

// --- Unknown hook -------------------------------------------------------------------------------
{
  const res = hook(root, "no-such-hook", {});
  ok("unknown hook: exits 0", res.status === 0);
  ok("unknown hook: notes it on stderr", res.stderr.includes('has no hook "no-such-hook"'), res.stderr);
  ok("unknown hook: prints nothing on stdout", res.stdout === "");
}

// --- Plugin config ------------------------------------------------------------------------------
{
  const marketplace = JSON.parse(fs.readFileSync(path.join(toolRoot, ".claude-plugin/marketplace.json"), "utf-8"));
  const entry = marketplace.plugins?.find((p) => p.name === "mindplan");
  ok("marketplace: lists the mindplan plugin", Boolean(entry));
  const pluginDir = path.join(toolRoot, entry?.source ?? "missing");
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, ".claude-plugin/plugin.json"), "utf-8"));
  ok("plugin: manifest name matches the entry", manifest.name === "mindplan");
  ok("plugin: no version pinned", manifest.version === undefined);
  ok("plugin: registers no MCP server", !fs.existsSync(path.join(pluginDir, ".mcp.json")) && manifest.mcpServers === undefined);
  const hooks = JSON.parse(fs.readFileSync(path.join(pluginDir, "hooks/hooks.json"), "utf-8")).hooks;
  const commands = Object.values(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
  const names = commands.map((c) => /scripts\/mindplan\.mjs" hook (\S+)$/.exec(c)?.[1]);
  ok("plugin: every hook runs the launcher", names.every(Boolean) && names.length === 3, commands.join(" | "));
  for (const name of names.filter(Boolean)) {
    ok(`plugin: CLI answers hook ${name}`, !hook(root, name, {}).stderr.includes("has no hook"));
  }
}

// --- Launcher -----------------------------------------------------------------------------------
function runLauncher(projectDir, args, input = "{}") {
  const env = { ...noCi, CLAUDE_PROJECT_DIR: projectDir };
  const res = spawnSync(process.execPath, [launcher, ...args], { cwd: os.tmpdir(), input, env, encoding: "utf-8" });
  return { status: res.status, stdout: res.stdout.trim(), stderr: res.stderr };
}

function fakeInstall(version, exitCode = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-claude-plugin-launcher-"));
  const pkg = path.join(dir, "node_modules", "mindplan-mcp");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "mindplan-mcp", version, bin: { "mindplan-mcp": "cli.js" } }));
  fs.writeFileSync(
    path.join(pkg, "cli.js"),
    `const input = require("fs").readFileSync(0, "utf-8");\n` +
      `process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input, cwd: process.cwd(), root: process.env.MINDPLAN_ROOT }));\n` +
      `process.exit(${exitCode});\n`
  );
  return dir;
}

{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-claude-plugin-none-"));
  const none = runLauncher(empty, ["hook", "stop"]);
  ok("launcher: no install exits 0 silently", none.status === 0 && none.stdout === "" && none.stderr === "", JSON.stringify(none));

  const old = fakeInstall("0.26.0");
  ok("launcher: older pin skips session-start", runLauncher(old, ["hook", "session-start"]).stdout === "");
  ok("launcher: older pin skips stop", runLauncher(old, ["hook", "stop"]).stdout === "");
  const guard = runLauncher(old, ["hook", "pre-tool-use"], '{"tool_name":"Edit"}');
  ok("launcher: older pin still runs pre-tool-use", guard.stdout.includes('"pre-tool-use"'), guard.stdout);

  const current = fakeInstall("0.27.0", 3);
  const res = runLauncher(current, ["hook", "stop"], '{"stop_hook_active":false}');
  let echoed = null;
  try {
    echoed = JSON.parse(res.stdout);
  } catch {
    echoed = null;
  }
  ok("launcher: passes the arguments", JSON.stringify(echoed?.args) === JSON.stringify(["hook", "stop"]), res.stdout);
  ok("launcher: passes stdin", echoed?.input === '{"stop_hook_active":false}');
  ok("launcher: runs in the project directory", path.resolve(echoed?.cwd ?? "") === fs.realpathSync(current) || path.resolve(echoed?.cwd ?? "") === path.resolve(current));
  ok("launcher: sets MINDPLAN_ROOT to the project", echoed?.root === current);
  ok("launcher: returns the CLI's exit code", res.status === 3, String(res.status));

  const ancient = fakeInstall("0.22.0");
  ok("launcher: a pin before 0.23.0 skips pre-tool-use", runLauncher(ancient, ["hook", "pre-tool-use"], '{"tool_name":"Edit"}').stdout === "");
  ok("launcher: an unknown hook name is skipped", runLauncher(current, ["hook", "no-such-hook"]).stdout === "");

  // The payload's cwd picks the graph root above it (a worktree) over CLAUDE_PROJECT_DIR.
  const worktree = fakeInstall("0.27.0");
  fs.mkdirSync(path.join(worktree, "mindplan"));
  const nested = path.join(worktree, "src", "deep");
  fs.mkdirSync(nested, { recursive: true });
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-claude-plugin-elsewhere-"));
  const viaCwd = runLauncher(elsewhere, ["hook", "stop"], JSON.stringify({ cwd: nested }));
  let fromCwd = null;
  try {
    fromCwd = JSON.parse(viaCwd.stdout);
  } catch {
    fromCwd = null;
  }
  ok("launcher: the payload cwd's graph root wins over CLAUDE_PROJECT_DIR", fromCwd?.root === worktree, viaCwd.stdout);

  // A worktree with no node_modules of its own runs the session project's install, in the worktree.
  const bareWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-claude-plugin-wt-"));
  fs.mkdirSync(path.join(bareWorktree, "mindplan"));
  const viaFallback = runLauncher(current, ["hook", "stop"], JSON.stringify({ cwd: bareWorktree }));
  let fallback = null;
  try {
    fallback = JSON.parse(viaFallback.stdout);
  } catch {
    fallback = null;
  }
  ok("launcher: a worktree without an install uses the project's, rooted in the worktree", fallback?.root === bareWorktree, viaFallback.stdout);

  // A plugin path reached through a link still runs (the launcher has no main-module guard).
  const linkDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-claude-plugin-link-")), "scripts");
  try {
    fs.symlinkSync(path.dirname(launcher), linkDir, "junction");
    const linked = spawnSync(process.execPath, [path.join(linkDir, "mindplan.mjs"), "hook", "stop"], {
      input: "{}",
      env: { ...noCi, CLAUDE_PROJECT_DIR: current },
      encoding: "utf-8",
    });
    ok("launcher: runs through a linked plugin path", linked.stdout.includes('"stop"'), linked.stdout + linked.stderr);
  } catch (err) {
    console.log(`skip launcher link check (${err.code ?? err.message})`);
  }
}

if (failures > 0) {
  console.log(`\n${failures} claude-plugin check(s) failed.`);
  process.exit(1);
}
console.log("\nAll claude-plugin checks passed.");
