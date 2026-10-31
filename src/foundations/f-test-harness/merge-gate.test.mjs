/**
 * Merge gate: `check --merge` Blocks in-review active slots and in-review Bugs, groups the lines
 * by change, and `--merge=strict` also Blocks in-progress nodes whose claimed files changed
 * against the base. The CLI, runCheckHandler, and run_check over MCP agree. Changed paths are
 * project-relative when the project sits below the repository top, the default base is the newer
 * of the local and remote default branch, and setup_project({ ci: "github" }) writes the workflow
 * at the repository top. Run via npm test.
 */
// Fixtures build graphs without a version stamp; the gate has its own suite (version.test.mjs).
process.env.MINDPLAN_VERSION_GATE ??= "off";
import { runSetup, runUpgrade } from "./upgrade-run.mjs";
import assert from "assert/strict";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { collectDirtySrcPaths, runCheckHandler } from "../../../dist/interactions/i-check-integrity/check.js";
// Spawned servers rank by keyword only: no model download or load during tests.
process.env.MINDPLAN_SEARCH ??= "keyword";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");
const ok = (label) => console.log(`ok   ${label}`);

const FOLDERS = { Foundation: "foundations", Interaction: "interactions", Interface: "interfaces", Bug: "bugs" };
const STAMP = "2026-01-01T00:00:00.000Z";

function frontmatter(fields) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const v of value) lines.push(`  - ${v}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

/**
 * Write one node. `state` is the live state; `next` is an open next's state, or "mirror" for a
 * standing twin (shipped nodes always get one). Pipeline nodes claim `src/<id>/`.
 */
function writeNode(root, { id, type, state, next, change }) {
  const dir = path.join(root, "mindplan", FOLDERS[type], id);
  fs.mkdirSync(dir, { recursive: true });
  const shipped = state === "stable" || state === "unstable";
  const pipeline = type !== "Bug";
  const base = {
    id,
    type,
    title: `"Node ${id}"`,
    description: `"Builder runs ${id} for the merge-gate fixture."`,
    state,
    role: type === "Foundation" ? "infra" : undefined,
    shipped_at: shipped ? STAMP : undefined,
    created_at: STAMP,
    updated_at: STAMP,
    implements: pipeline ? [`src/${id}/`] : undefined,
    // A shipped node's live change is a neighbor label; the revision's change lives on next.
    change: !shipped && change ? `"${change}"` : undefined,
  };
  const body = `# Node ${id}\n\n## Purpose\n\nFixture body for ${id}.\n`;
  fs.writeFileSync(path.join(dir, `${id}.mdx`), frontmatter(base) + "\n" + body, "utf-8");
  if (shipped) {
    const twin = next === undefined || next === "mirror";
    const nextFields = twin
      ? { ...base, state: "mirror" }
      : { ...base, state: next, opened_at: STAMP, change: change ? `"${change}"` : undefined };
    fs.writeFileSync(path.join(dir, `${id}.next.mdx`), frontmatter(nextFields) + "\n" + body, "utf-8");
  }
  // A retired node's files would be leftovers.
  if (pipeline && state !== "cancelled" && state !== "deprecated") {
    fs.mkdirSync(path.join(root, "src", id), { recursive: true });
    fs.writeFileSync(path.join(root, "src", id, "index.ts"), `export const v = "${id}";\n`, "utf-8");
  }
}

function sandbox(label, nodes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mindplan-merge-${label}-`));
  fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "mindplan", "config.json"),
    JSON.stringify({ sources: ["src/**"], exclude: [] }, null, 2) + "\n"
  );
  for (const node of nodes) writeNode(root, node);
  return root;
}

function cli(root, args) {
  const r = spawnSync(process.execPath, [serverEntry, "check", ...args], {
    cwd: root,
    env: { ...process.env, MINDPLAN_ROOT: root },
    encoding: "utf-8",
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function handler(root, args) {
  const prev = process.env.MINDPLAN_ROOT;
  process.env.MINDPLAN_ROOT = root;
  try {
    return runCheckHandler(args);
  } finally {
    if (prev === undefined) delete process.env.MINDPLAN_ROOT;
    else process.env.MINDPLAN_ROOT = prev;
  }
}

const mergeLines = (failures) => failures.filter((f) => f.startsWith("Blocked: Merge"));

// --- One in-review next twin -------------------------------------------------------------------
{
  const root = sandbox("next", [
    { id: "f-shared", type: "Foundation", state: "stable", next: "in-review", change: "add-thing" },
  ]);
  const plain = cli(root, []);
  assert.equal(plain.status, 0, plain.out);
  ok("an in-review next twin passes plain check");

  const gated = cli(root, ["--merge"]);
  assert.equal(gated.status, 1, gated.out);
  const line = gated.out.split("\n").find((l) => l.startsWith("Blocked: Merge:"));
  assert.ok(line, gated.out);
  assert.match(line, /"f-shared" \(Foundation, next in-review, change "add-thing"\)/);
  assert.ok(
    line.includes('update_node_status({ scope: "change", change: "add-thing", new_status: "ship" })'),
    line
  );
  assert.ok(line.includes('update_node_status({ node_id: "f-shared", new_status: "in-progress" })'), line);
  ok("check --merge Blocks the in-review next twin with its change and the ship call");

  const result = handler(root, { merge: true });
  assert.equal(result.ok, false);
  assert.equal(result.output, gated.out.trim(), "run_check output equals the CLI output");
  assert.deepEqual(result.merge, {
    level: "default",
    changes: [
      { change: "add-thing", nodes: [{ id: "f-shared", type: "Foundation", state: "in-review", slot: "next" }] },
    ],
  });
  ok("runCheckHandler({ merge: true }) returns the CLI's failures and the grouped merge report");

  const bad = cli(root, ["--merge=loose"]);
  assert.equal(bad.status, 1);
  assert.match(bad.out, /unknown merge level "loose"/);
  ok("an unknown merge level is Blocked");
}

// --- Every passing state ------------------------------------------------------------------------
{
  const root = sandbox("pass", [
    { id: "i-draft", type: "Interaction", state: "draft" },
    { id: "i-ready", type: "Interaction", state: "ready" },
    { id: "i-building", type: "Interaction", state: "in-progress", change: "wip" },
    { id: "f-stable", type: "Foundation", state: "stable" },
    { id: "if-unstable", type: "Interface", state: "unstable", next: "mirror" },
    { id: "f-evolving", type: "Foundation", state: "stable", next: "in-progress", change: "wip" },
    { id: "i-cancelled", type: "Interaction", state: "cancelled" },
    { id: "bug-fixed", type: "Bug", state: "resolved" },
    { id: "bug-open", type: "Bug", state: "fixing" },
  ]);
  const r = cli(root, ["--merge"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /mindplan-mcp check: ok/);
  const result = handler(root, { merge: true });
  assert.equal(result.ok, true, result.output);
  assert.deepEqual(result.merge.changes, []);
  ok("draft, ready, in-progress, stable, unstable, mirror, cancelled, and resolved Bugs pass check --merge");
}

// --- Pre-ship in-review nodes, a Bug, and a change spanning several nodes ----------------------
{
  const root = sandbox("group", [
    { id: "f-base", type: "Foundation", state: "in-review", change: "big-change" },
    { id: "i-act", type: "Interaction", state: "stable", next: "in-review", change: "big-change" },
    { id: "if-app", type: "Interface", state: "in-review", change: "big-change" },
    { id: "i-solo", type: "Interaction", state: "in-review" },
    { id: "bug-crash", type: "Bug", state: "in-review" },
    { id: "i-other", type: "Interaction", state: "in-review", change: "another" },
  ]);
  const result = handler(root, { merge: true });
  assert.equal(result.ok, false);
  const lines = mergeLines(result.failures);
  assert.equal(lines.length, 6, lines.join("\n"));
  assert.deepEqual(
    result.merge.changes.map((g) => [g.change, g.nodes.map((n) => n.id)]),
    [
      ["another", ["i-other"]],
      ["big-change", ["f-base", "i-act", "if-app"]],
      [null, ["bug-crash", "i-solo"]],
    ]
  );
  ok("a change spanning several nodes is one group, and nodes with no change group last");

  const big = lines.map((l, i) => (l.includes('change "big-change"') ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(big, [big[0], big[0] + 1, big[0] + 2], "a change's lines are adjacent");
  ok("a change's Blocked: Merge lines sit together");

  const bug = lines.find((l) => l.includes('"bug-crash"'));
  assert.ok(bug.includes('update_node_status({ node_id: "bug-crash", new_status: "resolved" })'), bug);
  assert.ok(bug.includes('new_status: "fixing"'), bug);
  ok("an in-review Bug fails with the resolve call");

  const solo = lines.find((l) => l.includes('"i-solo"'));
  assert.ok(solo.includes("no change"), solo);
  assert.ok(solo.includes('update_node_status({ node_id: "i-solo", new_status: "ship" })'), solo);
  ok("a node with no change gets the single-node ship call");

  const plain = handler(root, {});
  assert.equal(mergeLines(plain.failures).length, 0, "plain check ignores lifecycle state");
  assert.equal(plain.merge, undefined);
  ok("plain check reports no merge lines and no merge result");
}

// --- Strict level ------------------------------------------------------------------------------
{
  const root = sandbox("strict", [
    { id: "i-touched", type: "Interaction", state: "in-progress", change: "feature" },
    { id: "i-untouched", type: "Interaction", state: "in-progress", change: "feature" },
    { id: "f-evolving", type: "Foundation", state: "stable", next: "in-progress", change: "feature" },
  ]);
  const git = (...args) => {
    const r = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
      cwd: root,
      encoding: "utf-8",
    });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("switch", "-q", "-c", "feature");
  fs.writeFileSync(path.join(root, "src", "i-touched", "index.ts"), 'export const v = "changed";\n');
  fs.writeFileSync(path.join(root, "src", "i-touched", "extra.ts"), "export const e = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "work");

  assert.equal(cli(root, ["--merge"]).status, 0, "default merge gate passes in-progress work");
  ok("--merge passes in-progress nodes whose files changed");

  const strict = cli(root, ["--merge=strict", "--base", "main"]);
  assert.equal(strict.status, 1, strict.out);
  const lines = strict.out.split("\n").filter((l) => l.startsWith("Blocked: Merge (strict):"));
  assert.equal(lines.length, 1, strict.out);
  assert.match(lines[0], /"i-touched" \(Interaction, in-progress, change "feature"\)/);
  assert.match(lines[0], /against main: "src\/i-touched\/extra.ts", "src\/i-touched\/index.ts"/);
  assert.ok(lines[0].includes('update_node_status({ node_id: "i-touched", new_status: "in-review" })'), lines[0]);
  ok("--merge=strict --base fails only the in-progress node whose claimed files changed");

  const result = handler(root, { merge: "strict", base: "main" });
  assert.deepEqual(mergeLines(result.failures), lines);
  assert.deepEqual(result.merge.changes, [
    {
      change: "feature",
      nodes: [
        {
          id: "i-touched",
          type: "Interaction",
          state: "in-progress",
          slot: "live",
          files: ["src/i-touched/extra.ts", "src/i-touched/index.ts"],
        },
      ],
    },
  ]);
  ok("runCheckHandler strict matches the CLI");

  // An uncommitted edit to an evolving shipped node counts too; the default base is main's merge base.
  fs.writeFileSync(path.join(root, "src", "f-evolving", "index.ts"), 'export const v = "edited";\n');
  const dirty = handler(root, { merge: "strict" });
  assert.deepEqual(
    dirty.merge.changes[0].nodes.map((n) => [n.id, n.slot]),
    [["f-evolving", "next"], ["i-touched", "live"]]
  );
  ok("strict counts working-tree edits and an open next, with the default base");

  const noGit = sandbox("strict-nogit", [{ id: "i-x", type: "Interaction", state: "in-progress" }]);
  const r = cli(noGit, ["--merge=strict"]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Blocked: Merge \(strict\): no git base/);
  ok("strict with no git base is Blocked with the --base fix");
}

// --- run_check over MCP --------------------------------------------------------------------------
{
  const root = sandbox("mcp", [
    { id: "f-shared", type: "Foundation", state: "stable", next: "in-review", change: "add-thing" },
  ]);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env, MINDPLAN_ROOT: root },
  });
  const client = new Client({ name: "merge-gate-test", version: "0.1.0" });
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: "run_check", arguments: { merge: true } });
    assert.ok(!res.isError, res.content?.[0]?.text);
    const result = JSON.parse(res.content[0].text);
    assert.equal(result.ok, false);
    assert.equal(result.output, cli(root, ["--merge"]).out.trim());
    assert.equal(result.merge.changes[0].change, "add-thing");
    ok("run_check({ merge: true }) over MCP returns the CLI's output");

    const bad = await client.callTool({ name: "run_check", arguments: { merge: "loose" } });
    assert.ok(bad.isError, "run_check rejects an unknown merge level");
    ok("run_check rejects an unknown merge level");
  } finally {
    await client.close();
  }
}

// --- Git helpers for repositories built below ---------------------------------------------------
function gitIn(cwd) {
  return (...args) => {
    const r = spawnSync(
      "git",
      ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
      { cwd, encoding: "utf-8" }
    );
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
}

/** A project in `<repo>/sub`: the repository top holds only a README. */
function subfolderProject(label, nodes) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `mindplan-merge-${label}-`));
  const root = path.join(repo, "sub");
  fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "mindplan", "config.json"),
    JSON.stringify({ sources: ["src/**"], exclude: [] }, null, 2) + "\n"
  );
  for (const node of nodes) writeNode(root, node);
  fs.writeFileSync(path.join(repo, "README.md"), "top\n");
  return { repo, root };
}

// --- Strict level with the project below the repository top ------------------------------------
{
  const { repo, root } = subfolderProject("subdir", [
    { id: "i-touched", type: "Interaction", state: "in-progress", change: "feature" },
    { id: "i-untouched", type: "Interaction", state: "in-progress", change: "feature" },
  ]);
  const git = gitIn(repo);
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("switch", "-q", "-c", "feature");
  fs.writeFileSync(path.join(root, "src", "i-touched", "index.ts"), 'export const v = "changed";\n');
  fs.writeFileSync(path.join(repo, "README.md"), "top, changed\n");
  git("add", "-A");
  git("commit", "-q", "-m", "work");
  fs.writeFileSync(path.join(root, "src", "i-touched", "extra.ts"), "export const e = 1;\n");
  fs.writeFileSync(path.join(repo, "NOTES.md"), "outside the project\n");

  const dirty = collectDirtySrcPaths(root, "main");
  assert.deepEqual(dirty.commits, ["src/i-touched/index.ts"]);
  assert.deepEqual(dirty.workingTree, ["src/i-touched/extra.ts"]);
  ok("changed paths are relative to a project below the repository top, and paths outside it are left out");

  const strict = cli(root, ["--merge=strict", "--base", "main"]);
  assert.equal(strict.status, 1, strict.out);
  const lines = strict.out.split("\n").filter((l) => l.startsWith("Blocked: Merge (strict):"));
  assert.equal(lines.length, 1, strict.out);
  assert.match(lines[0], /"i-touched"/);
  assert.match(lines[0], /"src\/i-touched\/extra.ts", "src\/i-touched\/index.ts"/);
  ok("--merge=strict Blocks a changed in-progress node in a project below the repository top");

  const bogus = cli(root, ["--merge=strict", "--base", "no-such-ref"]);
  assert.equal(bogus.status, 1, bogus.out);
  const probeLines = bogus.out.split("\n").filter((l) => l.includes("git probe failed"));
  assert.equal(probeLines.length, 1, bogus.out);
  ok("--merge=strict --base runs one git probe for dirty-src and the merge gate, and reports its failure once");

  const both = cli(root, ["--merge=strict", "--merge"]);
  assert.equal(both.status, 1, both.out);
  assert.match(both.out, /--merge and --merge=strict were both passed/);
  ok("conflicting merge levels are Blocked");
}

// --- The default base ignores a stale local main ------------------------------------------------
{
  const root = sandbox("stale-main", [
    { id: "i-merged", type: "Interaction", state: "in-progress" },
    { id: "i-touched", type: "Interaction", state: "in-progress" },
  ]);
  const git = gitIn(root);
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const old = git("rev-parse", "HEAD");
  // Someone else's work lands on the remote main; this clone fetched it but never pulled.
  fs.writeFileSync(path.join(root, "src", "i-merged", "index.ts"), 'export const v = "merged";\n');
  git("add", "-A");
  git("commit", "-q", "-m", "merged elsewhere");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("switch", "-q", "-c", "feature");
  git("branch", "-f", "main", old);
  fs.writeFileSync(path.join(root, "src", "i-touched", "index.ts"), 'export const v = "mine";\n');
  git("add", "-A");
  git("commit", "-q", "-m", "mine");

  const result = handler(root, { merge: "strict" });
  assert.deepEqual(
    result.merge.changes.flatMap((g) => g.nodes.map((n) => n.id)),
    ["i-touched"],
    result.output
  );
  ok("the default base is the newer of main and origin/main, so already-merged commits do not count");
}

// --- setup_project({ ci: "github" }) -------------------------------------------------------------
{
  const workflow = (root) => path.join(root, ".github", "workflows", "mindplan-merge-gate.yml");
  const pkg = JSON.parse(fs.readFileSync(path.join(toolRoot, "package.json"), "utf-8"));
  const minor = pkg.version.split(".").slice(0, 2).join(".");

  const plainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-merge-setup-plain-"));
  const plain = runSetup(plainRoot);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(fs.existsSync(workflow(plainRoot)), false);
  assert.equal(plain.result.ci, undefined);
  ok("a plain setup writes no workflow");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-merge-setup-"));
  const first = runSetup(root, { args: { ci: "github" } });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(first.result.ci, { installed: true, path: ".github/workflows/mindplan-merge-gate.yml" });
  assert.ok(first.result.changed_files.includes(".github/workflows/mindplan-merge-gate.yml"));
  const text = fs.readFileSync(workflow(root), "utf-8");
  assert.ok(text.includes(`npx -y mindplan-mcp@${minor} check --merge`), text);
  assert.ok(!text.includes("{{MINDPLAN_VERSION}}"), "the version placeholder is replaced");
  assert.match(text, /pull_request:/);
  assert.match(text, /if: github\.base_ref == github\.event\.repository\.default_branch/);
  assert.match(text, /working-directory: \.\r?\n/);
  ok(`setup_project with ci github writes the workflow running check --merge at mindplan-mcp@${minor}`);

  fs.writeFileSync(workflow(root), "# edited\n");
  const again = runSetup(root, { args: { ci: "github" } });
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(again.result.ci, { installed: false, path: ".github/workflows/mindplan-merge-gate.yml" });
  assert.equal(fs.readFileSync(workflow(root), "utf-8"), "# edited\n");
  ok("a second setup keeps an edited workflow");

  const { repo, root: subRoot } = subfolderProject("setup-subdir", []);
  gitIn(repo)("init", "-q", "-b", "main");
  // The fixture is a config with no node and no stamp: setup finishes it.
  const nested = runSetup(subRoot, { args: { ci: "github" } });
  assert.equal(nested.status, 0, nested.stderr);
  assert.deepEqual(nested.result.ci, { installed: true, path: "../.github/workflows/mindplan-merge-gate.yml" });
  assert.equal(fs.existsSync(workflow(subRoot)), false, "no workflow below the repository top");
  assert.match(fs.readFileSync(workflow(repo), "utf-8"), /working-directory: sub\r?\n/);
  ok("setup_project with ci github below the repository top writes the workflow at the top, running in the project");
}

console.log("merge-gate tests passed");
