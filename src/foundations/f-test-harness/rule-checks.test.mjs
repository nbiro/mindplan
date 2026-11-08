/**
 * Rule checks (`check:` lines on project and node rules) in run_check / CLI check, their validation
 * on patch_project_rules / patch_node_rules, the rule_checks.commands config, and the Claude Code
 * hook (setup_project / upgrade_project install_hook, `mindplan-mcp hook pre-tool-use`). Run via npm test.
 */
// Fixtures build graphs without a version stamp; the gate has its own suite (version.test.mjs).
process.env.MINDPLAN_VERSION_GATE ??= "off";
import { runHandler } from "./upgrade-run.mjs";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
process.env.MINDPLAN_SEARCH ??= "keyword";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-rule-checks-"));
console.log("Rule-checks sandbox:", root);

let failures = 0;
function ok(name, cond, detail = "") {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}

function runCheck(env = {}) {
  const res = spawnSync(process.execPath, [serverEntry, "check"], {
    cwd: root,
    env: { ...process.env, MINDPLAN_ROOT: root, ...env },
    encoding: "utf-8",
  });
  // Drop node runtime warnings (they carry the pid).
  const out = `${res.stdout}${res.stderr}`
    .split(/\r?\n/)
    .filter((l) => !/^\((node:\d+|Use `node)/.test(l))
    .join("\n");
  return { status: res.status, out };
}

const noCi = { ...process.env };
delete noCi.CI;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...noCi, MINDPLAN_ROOT: root },
});
const client = new Client({ name: "rule-checks-test", version: "0.1.0" });
await client.connect(transport);
await client.callTool({ name: "get_project", arguments: {} });

async function call(tool, args) {
  const res = await client.callTool({ name: tool, arguments: args });
  if (res.isError) throw new Error(res.content?.[0]?.text ?? "tool error");
  return JSON.parse(res.content?.[0]?.text ?? "{}");
}

async function blockedOf(tool, args) {
  try {
    await call(tool, args);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function write(rel, text) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

// --- Fixture: f-core (Foundation), i-feature depends_on f-core, i-other unrelated ---------------
fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
fs.writeFileSync(path.join(root, "mindplan", "config.json"), JSON.stringify({ sources: ["src/**"], exclude: [] }, null, 2) + "\n");
await call("create_node", { id: "f-core", type: "Foundation", title: "Core", description: "Infra — core", role: "infra" });
await call("create_node", { id: "i-feature", type: "Interaction", title: "Feature", description: "A feature" });
await call("create_node", { id: "i-other", type: "Interaction", title: "Other", description: "Unrelated" });
await call("link_nodes", { source_id: "i-feature", target_id: "f-core", edge_type: "depends_on" });
write("src/foundations/f-core/index.ts", "/** core */\nexport const core = 1;\n");
write("src/interactions/i-feature/feature.ts", '/** feature */\nimport { core } from "../../foundations/f-core/index.js";\nexport const x = core;\n');
write("src/interactions/i-other/other.ts", "/** other */\nexport const y = 2;\n");
await call("set_implementation_files", { replace: true, node_id: "f-core", files: ["src/foundations/f-core/"] });
await call("set_implementation_files", { replace: true, node_id: "i-feature", files: ["src/interactions/i-feature/"] });
await call("set_implementation_files", { replace: true, node_id: "i-other", files: ["src/interactions/i-other/"] });

const baseline = runCheck();
ok("fixture passes the check", baseline.status === 0, baseline.out);

// --- No check: lines → identical output -----------------------------------------------------------
await call("patch_project_rules", { add: ["Keep modules small.\ncheck the docs before shipping"] });
await call("orient_for_work", { node_id: "f-core", depth: "rules" });
await call("patch_node_rules", { node_id: "f-core", rules: "- Core stays pure.\n  check: prose, not a JSON check" });
const plain = runCheck();
ok("rules without check: lines leave the check output unchanged", plain.out === baseline.out && plain.status === 0, plain.out);

// --- Validation on write -----------------------------------------------------------------------
const invalid = [
  ['{"forbid_path": "src/**"', "not valid JSON"],
  ['{"nope": 1}', "unknown check form"],
  ['{"forbid_path": "a/**", "command": "x"}', "one form per check"],
  ['{"forbid_pattern": "(", "in": "src/**"}', "invalid regex"],
  ['{"require_pattern": "x"}', '"in"'],
];
for (const [check, want] of invalid) {
  const msg = await blockedOf("patch_project_rules", { add: [`Bad rule ${want}.\ncheck: ${check}`] });
  ok(`patch_project_rules Blocks ${want}`, msg?.includes("Blocked") && msg.includes(want) && msg.includes(`Bad rule ${want}.`), msg ?? "accepted");
}
const nodeMsg = await blockedOf("patch_node_rules", {
  node_id: "f-core",
  rules: '- Core rule.\n  check: {"forbid_pattern": "[", "in": "src/**"}',
});
ok("patch_node_rules Blocks an invalid check", nodeMsg?.includes("Blocked") && nodeMsg.includes("invalid regex") && nodeMsg.includes("Core rule."), nodeMsg ?? "accepted");

// --- Project rule checks: each form ---------------------------------------------------------------
const longRule = `No legacy files anywhere in the sources, ${"really ".repeat(30)}never.`;
await call("patch_project_rules", {
  add: [
    `${longRule}\ncheck: {"forbid_path": "src/**/legacy-*.ts"}`,
    'No console logging.\ncheck: {"forbid_pattern": "console\\\\.log\\\\(", "in": "src/**/*.ts"}',
    'Every module opens with a doc comment.\ncheck: {"require_pattern": "^/\\\\*\\\\*", "in": "src/**/*.ts"}',
  ],
});
let r = runCheck();
ok("passing forbid_path / forbid_pattern / require_pattern add nothing", r.status === 0 && r.out === baseline.out, r.out);

write("src/interactions/i-feature/legacy-a.ts", "/** legacy */\nexport const l = 1;\n");
write("src/interactions/i-other/log.ts", "/** log */\nexport function f() {\n  console.log(\"hi\");\n}\n");
write("src/interactions/i-other/bare.ts", "export const bare = 1;\n");
r = runCheck();
ok("failing project checks fail the check", r.status === 1, r.out);
ok(
  "forbid_path lists the path, with the full rule text",
  r.out.includes(`Blocked: Rule: project — "${longRule}" check {"forbid_path": "src/**/legacy-*.ts"}: 1 forbidden path(s)\n  src/interactions/i-feature/legacy-a.ts`),
  r.out
);
ok(
  "forbid_pattern lists path:line: text",
  r.out.includes('Blocked: Rule: project — "No console logging."') && r.out.includes('src/interactions/i-other/log.ts:3: console.log("hi");'),
  r.out
);
ok(
  "require_pattern lists the files lacking a match",
  r.out.includes('"Every module opens with a doc comment."') && r.out.includes("file(s) lack a match\n  src/interactions/i-other/bare.ts"),
  r.out
);
const compact = await call("run_check", { compact: true });
ok(
  "compact run_check carries the rule failures in full",
  compact.ok === false && compact.failures.some((f) => f.includes(longRule) && f.startsWith("Blocked: Rule: project")),
  JSON.stringify(compact.failures)
);
for (const f of ["src/interactions/i-feature/legacy-a.ts", "src/interactions/i-other/log.ts", "src/interactions/i-other/bare.ts"]) {
  fs.rmSync(path.join(root, f));
}
// Many matches: five shown, then +N more.
write("src/interactions/i-other/many.ts", "/** many */\n" + "console.log(1);\n".repeat(8));
r = runCheck();
ok("matches past five are counted as +N more", r.out.includes("8 matching line(s)") && r.out.includes("+3 more"), r.out);
fs.rmSync(path.join(root, "src/interactions/i-other/many.ts"));

// --- Node rule scoping ----------------------------------------------------------------------------
await call("patch_node_rules", {
  node_id: "f-core",
  rules: '- No TODO markers in code built on core.\n  check: {"forbid_pattern": "TODO", "in": "src/**"}',
});
write("src/interactions/i-feature/todo.ts", "/** t */\n// TODO feature\nexport const t = 1;\n");
write("src/interactions/i-other/todo.ts", "/** t */\n// TODO other\nexport const t = 1;\n");
r = runCheck();
ok(
  "a Foundation's rule check reaches a node that depends_on it",
  r.out.includes('Blocked: Rule: f-core — "No TODO markers in code built on core."') &&
    r.out.includes("src/interactions/i-feature/todo.ts:2: // TODO feature"),
  r.out
);
ok("a Foundation's rule check does not reach an unrelated node", !r.out.includes("i-other/todo.ts"), r.out);
ok("a reached node's failure is reported once", r.out.split("i-feature/todo.ts:2").length === 2, r.out);
fs.rmSync(path.join(root, "src/interactions/i-feature/todo.ts"));
fs.rmSync(path.join(root, "src/interactions/i-other/todo.ts"));
r = runCheck();
ok("check passes again once the files comply", r.status === 0 && r.out === baseline.out, r.out);
// A node rule whose check: line sits at column 0 (written before validation, or merged in) is flagged.
const coreFile = path.join(root, "mindplan/foundations/f-core/f-core.mdx");
const coreText = fs.readFileSync(coreFile, "utf-8");
fs.writeFileSync(coreFile, coreText.replace('  check: {"forbid_pattern": "TODO"', 'check: {"forbid_pattern": "TODO"'));
r = runCheck();
ok("run_check flags a node rule's unindented check: line", r.status !== 0 && r.out.includes("indent the check: line"), r.out);
fs.writeFileSync(coreFile, coreText);

// --- Command checks -------------------------------------------------------------------------------
await call("patch_project_rules", {
  add: ['The build passes.\ncheck: {"command": "node -e \\"console.log(\'built\');process.exit(3)\\""}'],
});
r = runCheck({ CI: "" });
ok(
  "a command check is skipped by default, with an info line",
  r.status === 0 && r.out.includes('Info: rule checks: 1 command check(s) skipped (rule_checks.commands is "off")'),
  r.out
);
await call("patch_config", { rule_checks: { commands: "local" } });
const cfg = JSON.parse(fs.readFileSync(path.join(root, "mindplan", "config.json"), "utf-8"));
ok("patch_config stores rule_checks.commands", cfg.rule_checks?.commands === "local", JSON.stringify(cfg));
const local = { ...noCi, MINDPLAN_ROOT: root };
const run = spawnSync(process.execPath, [serverEntry, "check"], { cwd: root, env: local, encoding: "utf-8" });
const runOut = `${run.stdout}${run.stderr}`;
ok(
  'a command check runs under "local" and shows exit code and output',
  run.status === 1 && runOut.includes('Blocked: Rule: project — "The build passes."') && runOut.includes("exit 3, expected 0") && runOut.includes("| built"),
  runOut
);
r = runCheck({ CI: "true" });
ok('"local" skips command checks in CI', r.status === 0 && r.out.includes('rule_checks.commands is "local" and CI is set'), r.out);
const badCfg = await blockedOf("patch_config", { rule_checks: { commands: "sometimes" } });
ok("patch_config rejects an unknown rule_checks.commands", badCfg !== null, "accepted");

await client.close();

// --- Hook: install via setup_project / upgrade_project --------------------------------------------
const hookRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-hook-"));
fs.writeFileSync(path.join(hookRoot, "CLAUDE.md"), "# Project\n");
let s = runHandler("setup", hookRoot);
ok("setup_project offers the hook in a Claude Code project", s.result?.hook?.installed === false && /install_hook: true/.test(s.result.hook.offer ?? ""), JSON.stringify(s));

const settingsPath = path.join(hookRoot, ".claude", "settings.json");
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
const existing = {
  permissions: { allow: ["Bash(npm test)"] },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo bash" }] }],
    PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "echo edited" }] }],
  },
};
fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
s = runHandler("setup", hookRoot, { args: { install_hook: true } });
let settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
ok("install_hook reports the hook and lists .claude/settings.json", s.result?.hook?.installed === true && s.result.changed_files.includes(".claude/settings.json"), JSON.stringify(s));
ok(
  "install_hook keeps every existing setting and hook",
  JSON.stringify(settings.permissions) === JSON.stringify(existing.permissions) &&
    JSON.stringify(settings.hooks.PostToolUse) === JSON.stringify(existing.hooks.PostToolUse) &&
    JSON.stringify(settings.hooks.PreToolUse[0]) === JSON.stringify(existing.hooks.PreToolUse[0]),
  JSON.stringify(settings)
);
const version = JSON.parse(fs.readFileSync(path.join(toolRoot, "package.json"), "utf-8")).version;
// No mindplan-mcp in the project's node_modules: the hook pins this version through npx -y.
const ours = settings.hooks.PreToolUse.filter((e) => e.hooks?.some((h) => h.command === `npx -y mindplan-mcp@${version} hook pre-tool-use`));
ok("install_hook adds the PreToolUse entry, pinned to this version without a local install", ours.length === 1 && ours[0].matcher === "Edit|MultiEdit|Write|NotebookEdit", JSON.stringify(settings));
const u = runHandler("upgrade", hookRoot, { args: { install_hook: true } });
settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
ok(
  "install_hook is idempotent (upgrade_project)",
  u.result?.hook?.installed === true && !u.result.changed_files.includes(".claude/settings.json") && settings.hooks.PreToolUse.length === 2,
  JSON.stringify(u)
);
const plainUpgrade = runHandler("upgrade", hookRoot);
ok("upgrade_project reports an installed hook", plainUpgrade.result?.hook?.installed === true && plainUpgrade.result.hook.path === ".claude/settings.json", JSON.stringify(plainUpgrade));
const bare = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-nohook-"));
const b = runHandler("setup", bare);
ok("no hook field outside a Claude Code project", b.result && !("hook" in b.result), JSON.stringify(b));

// --- Hook: the CLI decision -----------------------------------------------------------------------
function hook(input, raw = false) {
  const res = spawnSync(process.execPath, [serverEntry, "hook", "pre-tool-use"], {
    cwd: hookRoot,
    input: raw ? input : JSON.stringify(input),
    encoding: "utf-8",
  });
  let decision = null;
  try {
    decision = res.stdout.trim() ? JSON.parse(res.stdout) : null;
  } catch {
    decision = "unparsable";
  }
  return { status: res.status, decision, stdout: res.stdout };
}
let h = hook({ tool_name: "Read", tool_input: { file_path: "mindplan/x.mdx" }, cwd: hookRoot });
ok("hook allows Read on mindplan/x.mdx (reads are free)", h.status === 0 && h.stdout === "", h.stdout);
h = hook({ tool_name: "Edit", tool_input: { file_path: "mindplan/x.mdx" }, cwd: hookRoot });
ok(
  "hook denies Edit on mindplan/x.mdx and names the write tools",
  h.status === 0 &&
    h.decision?.hookSpecificOutput?.permissionDecision === "deny" &&
    h.decision.hookSpecificOutput.hookEventName === "PreToolUse" &&
    h.decision.hookSpecificOutput.permissionDecisionReason.includes("patch_node_territory"),
  h.stdout
);
h = hook({ tool_name: "Read", tool_input: { file_path: path.join(hookRoot, "src", "x.ts") }, cwd: hookRoot });
ok("hook allows Read on src/x.ts", h.status === 0 && h.stdout === "", h.stdout);
h = hook({ tool_name: "Write", tool_input: { file_path: path.join(hookRoot, "mindplan", "project.md").replace(/\//g, "\\") }, cwd: hookRoot });
ok("hook denies Write in mindplan/ and names the write tools", h.decision?.hookSpecificOutput?.permissionDecisionReason?.includes("patch_node_territory"), h.stdout);
if (process.platform === "win32") {
  const upper = path.join(hookRoot, "mindplan", "a.mdx").replace(/^([a-z]):/i, (_, d) => `${d === d.toUpperCase() ? d.toLowerCase() : d.toUpperCase()}:`);
  h = hook({ tool_name: "Edit", tool_input: { file_path: upper }, cwd: hookRoot });
  ok("hook matches a drive letter of either case", h.decision?.hookSpecificOutput?.permissionDecision === "deny", h.stdout);
}
h = hook({ tool_name: "Grep", tool_input: { pattern: "x", path: "mindplan" }, cwd: hookRoot });
ok("hook allows Grep with path mindplan", h.status === 0 && h.stdout === "", h.stdout);
h = hook({ tool_name: "Glob", tool_input: { pattern: "mindplan/**/*.mdx" }, cwd: hookRoot });
ok("hook allows Glob mindplan/** from the root", h.status === 0 && h.stdout === "", h.stdout);
h = hook({ tool_name: "Glob", tool_input: { pattern: "src/**/*.ts" }, cwd: hookRoot });
ok("hook allows Glob src/**", h.stdout === "", h.stdout);
h = hook({ tool_name: "Bash", tool_input: { command: "cat mindplan/x.mdx" }, cwd: hookRoot });
ok("hook ignores other tools", h.status === 0 && h.stdout === "", h.stdout);
h = hook("not json {", true);
ok("hook allows malformed input silently", h.status === 0 && h.stdout === "", h.stdout);

for (const dir of [root, hookRoot, bare]) fs.rmSync(dir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`rule-checks.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("rule-checks.test.mjs: all ok");
