/**
 * Merging graphs from parallel branches (npm test): branch A ships revision c1 of a node while
 * branch B holds revision c2 of the same node; after merging A into B, run_check({ after_merge })
 * reports c2's stale base with the rebase_revision fix; rebase_revision carries A's section into
 * c2 and the check passes. Conflict markers under mindplan/ and a tracked map.md are reported,
 * over MCP and by `mindplan-mcp check --after-merge --root <path>`.
 */
// Fixtures build graphs without a version stamp; the gate has its own suite (version.test.mjs).
process.env.MINDPLAN_VERSION_GATE ??= "off";
process.env.MINDPLAN_ORIENT_GATE = "off";
process.env.MINDPLAN_SEARCH ??= "keyword";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SHIP, fillAndTick } from "./ship-fixture.mjs";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-after-merge-"));
console.log("After-merge sandbox:", root);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, MINDPLAN_ROOT: root },
});
const client = new Client({ name: "after-merge-test", version: "0.1.0" });
await client.connect(transport);

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`ok   ${label}`);
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

async function call(tool, args) {
  const res = await client.callTool({ name: tool, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(`${tool}: ${text}`);
  return JSON.parse(text || "{}");
}

const abs = (rel) => path.join(root, ...rel.split("/"));
const read = (rel) => fs.readFileSync(abs(rel), "utf-8");
const exists = (rel) => fs.existsSync(abs(rel));
function write(rel, content) {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), content);
}
function git(...args) {
  const r = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], {
    cwd: root,
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
function cli(args) {
  const env = { ...process.env };
  delete env.MINDPLAN_ROOT;
  const r = spawnSync(process.execPath, [serverEntry, "check", ...args], { cwd: toolRoot, encoding: "utf-8", env });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const LIVE = "mindplan/foundations/f-sub/f-sub.mdx";
const revDir = (change) => `mindplan/foundations/f-sub/revisions/${change}`;
const revFile = (change) => `${revDir(change)}/f-sub.mdx`;

function setSection(rel, heading, text) {
  const body = read(rel);
  const re = new RegExp(`(^## ${heading}\\r?\\n)([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m");
  if (!re.test(body)) throw new Error(`no ## ${heading} in ${rel}`);
  write(rel, body.replace(re, (_m, h) => `${h}\n${text}\n\n`));
}

function readyRevision(change) {
  write(revFile(change), read(revFile(change)).replaceAll("- [ ]", "- [x]"));
  const day = new Date().toISOString().slice(0, 10);
  write(
    `${revDir(change)}/decisions/d-${change}.md`,
    [
      `### d-${change}`,
      "",
      `- Decision: Revise f-sub under ${change}.`,
      "- Alternatives:",
      "  - A new node that depends_on f-sub: the contract itself changes.",
      "- Why: The shared spec must change in place.",
      `- Change: ${change}`,
      `- Date: ${day}`,
      "",
    ].join("\n")
  );
}

// --- main: one shipped Foundation, committed with map.md ignored ---
write("mindplan/config.json", JSON.stringify({ sources: ["src/**"], exclude: [] }, null, 2) + "\n");
write(".gitignore", ".mindplan-cache/\n");
write("mindplan/.gitignore", "map.md\n");
await call("create_node", { id: "f-sub", type: "Foundation", title: "Sub", description: "Infra — substrate", role: "infra" });
write("src/f-sub/index.ts", "export const sub = 1;\n");
await call("set_implementation_files", { replace: true, node_id: "f-sub", files: ["src/f-sub/index.ts"] });
fillAndTick(abs(LIVE));
for (const new_status of SHIP) await call("update_node_status", { node_id: "f-sub", new_status });
git("init", "-q", "-b", "main");
git("add", "-A");
git("commit", "-q", "-m", "base");

{
  const clean = await call("run_check", { after_merge: true });
  check("after_merge passes on a clean checkout", clean.ok, clean.output);
}

// --- branch a ships c1 (spec); branch b holds c2 (purpose, ready) ---
git("switch", "-q", "-c", "a");
await call("open_next", { node_id: "f-sub", change: "c1" });
setSection(revFile("c1"), "Shared Substrate Spec", "Spec from A.");
readyRevision("c1");
await call("update_node_status", { scope: "change", change: "c1", new_status: "ship", skip_review: true });
check("branch a shipped c1 into live", read(LIVE).includes("Spec from A.") && !exists(revDir("c1")));
git("add", "-A");
git("commit", "-q", "-m", "ship c1");

git("switch", "-q", "main");
git("switch", "-q", "-c", "b");
await call("open_next", { node_id: "f-sub", change: "c2" });
setSection(revFile("c2"), "Purpose", "Purpose from B.");
readyRevision("c2");
await call("update_node_status", { node_id: "f-sub", change: "c2", new_status: "ready" });
git("add", "-A");
git("commit", "-q", "-m", "open c2");

git("merge", "-q", "--no-edit", "a");
check("the merge carried A's live into b", read(LIVE).includes("Spec from A.") && exists(revFile("c2")));

// --- the stale base, and rebase_revision ---
{
  const stale = await call("run_check", { after_merge: true });
  const line = stale.failures.find((f) => f.startsWith("Blocked: after-merge:") && f.includes('revision "c2" of "f-sub"'));
  check(
    "run_check({ after_merge }) reports c2's stale base with the rebase_revision fix",
    !stale.ok && !!line && line.includes('rebase_revision({ node_id: "f-sub", change: "c2" })'),
    stale.output
  );
  const plain = await call("run_check", {});
  check("the default check does not run the after-merge findings", !plain.failures.some((f) => f.includes("after-merge")), plain.output);

  const printed = cli(["--after-merge", "--root", root]);
  check(
    "CLI check --after-merge --root prints the same finding and exits 1",
    printed.status === 1 && printed.out.includes(line ?? "<none>"),
    printed.out
  );

  const rebased = await call("rebase_revision", { node_id: "f-sub", change: "c2" });
  const body = read(revFile("c2"));
  check(
    "rebase_revision carries A's section into c2 and keeps c2's own",
    rebased.rebased === true &&
      rebased.change === "c2" &&
      rebased.conflicts.length === 0 &&
      rebased.changed_files?.includes(revFile("c2")) &&
      body.includes("Spec from A.") &&
      body.includes("Purpose from B."),
    JSON.stringify(rebased) + "\n" + body
  );
  check(
    "a ready revision whose text the rebase changed goes back to draft",
    JSON.stringify(rebased.readiness_reset) === JSON.stringify({ from: "ready", to: "draft" }) && /^state: draft$/m.test(body),
    JSON.stringify(rebased)
  );
  const again = await call("rebase_revision", { node_id: "f-sub", change: "c2" });
  check("a revision already based on live is a no-op", again.rebased === false && (again.changed_files ?? []).length === 0, JSON.stringify(again));

  const passed = await call("run_check", { after_merge: true });
  check("after rebase_revision the after-merge check passes", passed.ok, passed.output);
  const cliPassed = cli(["--after-merge", "--root", root]);
  check("CLI check --after-merge passes too", cliPassed.status === 0 && cliPassed.out.includes("mindplan-mcp check: ok"), cliPassed.out);
}

// --- conflict markers: in a note, and in the revision file the loader parses ---
{
  write("mindplan/foundations/f-sub/attachments/notes.md", "intro\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> a\n");
  const marked = await call("run_check", { after_merge: true });
  check(
    "a conflict-marker file is reported with its line and the fix",
    marked.failures.some(
      (f) => f.startsWith("Blocked: after-merge: mindplan/foundations/f-sub/attachments/notes.md:2 holds git conflict markers") && f.includes("Resolve")
    ),
    marked.output
  );
  fs.rmSync(abs("mindplan/foundations/f-sub/attachments/notes.md"));

  const original = read(revFile("c2"));
  write(revFile("c2"), original.replace(/^title: .*$/m, (t) => `<<<<<<< HEAD\n${t}\n=======\ntitle: Other\n>>>>>>> a`));
  const broken = await call("run_check", { after_merge: true });
  check(
    "a conflicted revision file is reported, not crashed on",
    !broken.ok && broken.failures.some((f) => f.startsWith(`Blocked: after-merge: ${revFile("c2")}:`) && f.includes("conflict markers")),
    broken.output
  );
  const brokenCli = cli(["--after-merge", "--root", root]);
  check("CLI reports the conflicted revision file too", brokenCli.status === 1 && brokenCli.out.includes(`${revFile("c2")}:`), brokenCli.out);
  write(revFile("c2"), original);
}

// --- a tracked map.md ---
{
  if (!exists("mindplan/map.md")) write("mindplan/map.md", "# map\n");
  git("add", "-f", "mindplan/map.md");
  const tracked = await call("run_check", { after_merge: true });
  const line = tracked.failures.find((f) => f.includes("mindplan/map.md is tracked by git"));
  check("a tracked map.md is reported with git rm --cached", !!line && line.includes("git rm --cached mindplan/map.md"), tracked.output);
  const printed = cli(["--after-merge", "--root", root]);
  check("CLI prints the tracked map.md finding", printed.status === 1 && printed.out.includes(line ?? "<none>"), printed.out);
  git("rm", "-q", "--cached", "mindplan/map.md");
}

// --- one node id in two folders, one decision id in two files ---
{
  write("mindplan/interactions/f-sub/f-sub.mdx", read(LIVE));
  const dupDir = "mindplan/foundations/f-sub/decisions";
  write(`${dupDir}/d-c1-copy.md`, read(`${dupDir}/d-c1.md`));
  const dup = await call("run_check", { after_merge: true });
  check(
    "a node id in two folders is reported",
    dup.failures.some((f) => f.startsWith('Blocked: after-merge: node id "f-sub" is in 2 folders')),
    dup.output
  );
  check(
    "a decision id in two files is reported with the supersedes fix",
    dup.failures.some((f) => f.includes('decision "d-c1" of "f-sub" is recorded in 2 files') && f.includes("supersedes")),
    dup.output
  );
  fs.rmSync(abs("mindplan/interactions/f-sub"), { recursive: true, force: true });
  fs.rmSync(abs(`${dupDir}/d-c1-copy.md`));
}

await client.close();
fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
if (failures > 0) {
  console.log(`after-merge.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("after-merge.test.mjs: all ok");
