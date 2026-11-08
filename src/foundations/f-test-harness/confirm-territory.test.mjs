/**
 * confirm_territory (i-confirm-territory) and the merge gate's reading of confirmed.json
 * (f-territory-store confirmations): a confirmation pinning every changed claimed file at its
 * current content clears the stale-territory Block with an info line; editing a confirmed file
 * again, or leaving a changed file unconfirmed, Blocks again; the tool Blocks an empty note, an
 * unclaimed file, an open revision, and nothing changed; the default check ignores confirmed.json;
 * CRLF and LF content hash alike; over MCP the tool is listed and gated like other node writes.
 * Run via npm test.
 */
// Fixtures build graphs without a version stamp; the gate has its own suite (version.test.mjs).
process.env.MINDPLAN_VERSION_GATE ??= "off";
process.env.MINDPLAN_SEARCH ??= "keyword";
import assert from "assert/strict";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runCheckHandler } from "../../../dist/interactions/i-check-integrity/check.js";
import { confirmTerritory } from "../../../dist/interactions/i-confirm-territory/handlers.js";
import { confirmationHash, readConfirmations } from "../../../dist/foundations/f-territory-store/confirmations.js";
import { formatRevisionFile } from "../../../dist/foundations/f-territory-store/revisions.js";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");
const ok = (label) => console.log(`ok   ${label}`);
const STAMP = "2026-01-01T00:00:00.000Z";
const FOLDERS = { Foundation: "foundations", Interaction: "interactions", Capability: "capabilities" };

function frontmatter(fields) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const v of value) lines.push(`  - ${v}`);
    } else lines.push(`${key}: ${value}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

/** One node claiming `src/<id>/` (two files); `next` opens a revision under change "later". */
function writeNode(root, { id, type = "Interaction", state = "stable", next }) {
  const dir = path.join(root, "mindplan", FOLDERS[type], id);
  fs.mkdirSync(dir, { recursive: true });
  const shipped = state === "stable";
  const pipeline = type !== "Capability";
  const base = {
    id,
    type,
    title: `"Node ${id}"`,
    description: `"Builder runs ${id} for the confirm fixture."`,
    state,
    role: type === "Foundation" ? "infra" : undefined,
    shipped_at: shipped && pipeline ? STAMP : undefined,
    created_at: STAMP,
    updated_at: STAMP,
    implements: pipeline ? [`src/${id}/`] : undefined,
  };
  const body = `# Node ${id}\n\n## Purpose\n\nFixture body for ${id}.\n`;
  fs.writeFileSync(path.join(dir, `${id}.mdx`), frontmatter(base) + "\n" + body, "utf-8");
  if (next) {
    const revision = {
      change: "later",
      state: next,
      opened_at: STAMP,
      updated_at: STAMP,
      title: `Node ${id}`,
      description: `Builder runs ${id} for the confirm fixture.`,
      edges: {},
      implements: { add: [], remove: [] },
      tests: { add: [], remove: [] },
      base: { scalars: {}, sections: {} },
      conflicts: [],
    };
    const revDir = path.join(dir, "revisions", "later");
    fs.mkdirSync(revDir, { recursive: true });
    fs.writeFileSync(path.join(revDir, `${id}.mdx`), formatRevisionFile(id, type, revision, body), "utf-8");
  }
  if (pipeline) {
    fs.mkdirSync(path.join(root, "src", id), { recursive: true });
    fs.writeFileSync(path.join(root, "src", id, "index.ts"), `export const v = "${id}";\n`, "utf-8");
    fs.writeFileSync(path.join(root, "src", id, "extra.ts"), `export const e = 1;\n`, "utf-8");
  }
}

/** A git repo on branch `feature` off `main`, holding the nodes. */
function repo(label, nodes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mindplan-confirm-${label}-`));
  fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
  fs.writeFileSync(path.join(root, "mindplan", "config.json"), JSON.stringify({ sources: ["src/**"], exclude: [] }, null, 2) + "\n");
  for (const node of nodes) writeNode(root, node);
  const git = (...args) => {
    const r = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf-8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Ada Confirmer");
  git("config", "core.autocrlf", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("switch", "-q", "-c", "feature");
  return { root, git };
}

function inRoot(root, fn) {
  const prev = process.env.MINDPLAN_ROOT;
  process.env.MINDPLAN_ROOT = root;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.MINDPLAN_ROOT;
    else process.env.MINDPLAN_ROOT = prev;
  }
}

const confirm = (root, args) => inRoot(root, () => confirmTerritory(args));
const blockedBy = (root, args) => {
  try {
    confirm(root, args);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  assert.fail(`confirm_territory ${JSON.stringify(args)} did not Block`);
};
const merge = (root) => inRoot(root, () => runCheckHandler({ merge: true, base: "main" }));
const mergeLines = (result) => result.failures.filter((f) => f.startsWith("Blocked: Merge:"));
const write = (root, rel, text) => fs.writeFileSync(path.join(root, ...rel.split("/")), text, "utf-8");

// --- Confirm, then the merge gate passes; editing the file again Blocks again ------------------
{
  const { root, git } = repo("pass", [{ id: "i-edited" }]);
  write(root, "src/i-edited/index.ts", 'export const v = "bumped";\n');
  git("add", "-A");
  git("commit", "-q", "-m", "bump");

  const before = merge(root);
  assert.equal(mergeLines(before).length, 1, before.failures.join("\n"));
  assert.ok(
    mergeLines(before)[0].includes('confirm_territory({ node_id: "i-edited", note })'),
    mergeLines(before)[0]
  );
  assert.ok(!/Unconfirmed|Changed since confirmation/.test(mergeLines(before)[0]), mergeLines(before)[0]);
  assert.deepEqual(before.merge.changes[0].nodes[0], {
    id: "i-edited", type: "Interaction", state: "stable", slot: "live", files: ["src/i-edited/index.ts"], stale: true,
  });
  ok("without confirmed.json the stale Block is unchanged and names confirm_territory as a fix");

  const reply = confirm(root, { node_id: "i-edited", note: "  only a constant moved;\n the text still holds " });
  assert.equal(reply.node_id, "i-edited");
  assert.equal(reply.confirmed.by, "Ada Confirmer");
  assert.equal(reply.confirmed.note, "only a constant moved; the text still holds");
  assert.deepEqual(reply.confirmed.files, ["src/i-edited/index.ts"]);
  assert.ok(!Number.isNaN(Date.parse(reply.confirmed.at)), reply.confirmed.at);
  assert.deepEqual(reply.changed_files, ["mindplan/interactions/i-edited/confirmed.json"]);
  const stored = JSON.parse(fs.readFileSync(path.join(root, "mindplan/interactions/i-edited/confirmed.json"), "utf-8"));
  assert.equal(stored.confirmations.length, 1);
  assert.deepEqual(Object.keys(stored.confirmations[0].files), ["src/i-edited/index.ts"]);
  assert.match(stored.confirmations[0].files["src/i-edited/index.ts"], /^[0-9a-f]{64}$/);
  ok("confirm_territory defaults to the changed claimed files and writes confirmed.json in the node folder");

  // Commit it as an agent would: confirmed.json is a changed path under mindplan/, not a territory change.
  git("add", "-A");
  git("commit", "-q", "-m", "confirm");
  const after = merge(root);
  assert.equal(after.ok, true, after.failures.join("\n"));
  assert.ok(
    after.info.some((l) => l.startsWith(`merge: "i-edited" confirmed by Ada Confirmer at ${reply.confirmed.at}: only a constant moved`)),
    after.info.join("\n")
  );
  ok("the merge gate passes a node whose changed files are confirmed at their current content, with an info line");

  const plain = inRoot(root, () => runCheckHandler({}));
  assert.equal(plain.ok, true, plain.failures.join("\n"));
  assert.ok(!JSON.stringify(plain).includes("confirmed.json"), JSON.stringify(plain));
  ok("the default check does not report confirmed.json (no leftover, coverage, or unknown-file finding)");

  write(root, "src/i-edited/index.ts", 'export const v = "bumped again";\n');
  const again = merge(root);
  const line = mergeLines(again)[0] ?? "";
  assert.equal(mergeLines(again).length, 1, again.failures.join("\n"));
  assert.ok(line.includes('Changed since confirmation: "src/i-edited/index.ts".'), line);
  assert.deepEqual(again.merge.changes[0].nodes[0].changed_since_confirmation, ["src/i-edited/index.ts"]);
  ok("editing a confirmed file again Blocks again, naming it changed since confirmation");

  // A second confirmation is appended (newest last) and covers the new content.
  confirm(root, { node_id: "i-edited", note: "second look" });
  assert.equal(inRoot(root, () => readConfirmations({ id: "i-edited", type: "Interaction" })).length, 2);
  assert.equal(merge(root).ok, true);
  ok("a newer confirmation is appended and clears it again");
}

// --- Partial confirmation still Blocks ---------------------------------------------------------
{
  const { root, git } = repo("partial", [{ id: "i-two" }]);
  write(root, "src/i-two/index.ts", 'export const v = "a";\n');
  write(root, "src/i-two/extra.ts", "export const e = 2;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "two");
  const reply = confirm(root, { node_id: "i-two", files: ["./src/i-two/index.ts"], note: "index only" });
  assert.deepEqual(reply.confirmed.files, ["src/i-two/index.ts"]);
  const result = merge(root);
  const line = mergeLines(result)[0] ?? "";
  assert.equal(mergeLines(result).length, 1, result.failures.join("\n"));
  assert.ok(line.includes('Unconfirmed: "src/i-two/extra.ts".'), line);
  assert.ok(!line.includes("Changed since confirmation"), line);
  assert.deepEqual(result.merge.changes[0].nodes[0].unconfirmed, ["src/i-two/extra.ts"]);
  ok("a confirmation naming one of two changed files still Blocks, naming the unconfirmed file");
}

// --- Blocked cases --------------------------------------------------------------------------------
{
  const { root, git } = repo("blocked", [
    { id: "i-mine" },
    { id: "i-other" },
    { id: "i-quiet" },
    { id: "i-revised", next: "draft" },
    { id: "i-new", state: "in-progress" },
    { id: "cap-x", type: "Capability", state: "draft" },
  ]);
  write(root, "src/i-mine/index.ts", 'export const v = "x";\n');
  write(root, "src/i-revised/index.ts", 'export const v = "x";\n');
  git("add", "-A");
  git("commit", "-q", "-m", "work");

  assert.match(blockedBy(root, { node_id: "i-mine", note: "  \n " }), /needs note/);
  ok("an empty or whitespace note is Blocked");

  const unclaimed = blockedBy(root, { node_id: "i-mine", files: ["src/i-other/index.ts"], note: "n" });
  assert.match(unclaimed, /does not claim "src\/i-other\/index.ts" \(owned by "i-other"\)/);
  assert.match(blockedBy(root, { node_id: "i-mine", files: ["docs/x.md"], note: "n" }), /"docs\/x.md" \(claimed by no node\)/);
  ok("a file the node does not claim is Blocked, naming its owner");

  assert.match(blockedBy(root, { node_id: "i-revised", note: "n" }), /has an open revision \("later"\)/);
  ok("a node with an open revision is Blocked");

  assert.match(blockedBy(root, { node_id: "i-quiet", note: "n" }), /nothing changed against the default branch; no confirmation needed/);
  ok("nothing changed against the base is Blocked");

  assert.match(blockedBy(root, { node_id: "i-new", note: "n" }), /never shipped/);
  assert.match(blockedBy(root, { node_id: "cap-x", note: "n" }), /is a Capability/);
  ok("a pre-ship node and a Capability are Blocked");

  assert.ok(!fs.existsSync(path.join(root, "mindplan/interactions/i-mine/confirmed.json")));
  ok("a Blocked call writes nothing");
}

// --- A deleted file, and CRLF vs LF hash alike -----------------------------------------------------
{
  const { root, git } = repo("hash", [{ id: "i-hash" }]);
  write(root, "src/i-hash/lf.ts", "a\nb\n");
  write(root, "src/i-hash/crlf.ts", "a\r\nb\r\n");
  assert.equal(confirmationHash("src/i-hash/lf.ts", root), confirmationHash("src/i-hash/crlf.ts", root));
  assert.notEqual(confirmationHash("src/i-hash/lf.ts", root), confirmationHash("src/i-hash/index.ts", root));
  assert.equal(confirmationHash("src/i-hash/gone.ts", root), "deleted");
  ok("CRLF and LF content hash alike; a missing file hashes to \"deleted\"");

  fs.rmSync(path.join(root, "src/i-hash/lf.ts"));
  fs.rmSync(path.join(root, "src/i-hash/crlf.ts"));
  fs.rmSync(path.join(root, "src/i-hash/extra.ts"));
  git("add", "-A");
  git("commit", "-q", "-m", "drop extra");
  const reply = confirm(root, { node_id: "i-hash", note: "extra.ts was unused" });
  assert.deepEqual(reply.confirmed.files, ["src/i-hash/extra.ts"]);
  assert.equal(inRoot(root, () => readConfirmations({ id: "i-hash", type: "Interaction" }))[0].files["src/i-hash/extra.ts"], "deleted");
  assert.equal(merge(root).ok, true);
  ok("a deleted claimed file is confirmed as \"deleted\" and the gate accepts it");

  // At most 10 kept, oldest dropped.
  for (let i = 0; i < 12; i++) confirm(root, { node_id: "i-hash", note: `n${i}` });
  const kept = inRoot(root, () => readConfirmations({ id: "i-hash", type: "Interaction" }));
  assert.equal(kept.length, 10);
  assert.equal(kept[9].note, "n11");
  ok("confirmed.json keeps the newest 10 confirmations");
}

// --- Over MCP: listed after patch_node_territory and gated like other node writes ---------------
{
  const { root, git } = repo("mcp", [{ id: "i-served" }]);
  write(root, "src/i-served/index.ts", 'export const v = "served";\n');
  git("add", "-A");
  git("commit", "-q", "-m", "served");
  const env = { ...process.env, MINDPLAN_ROOT: root };
  delete env.MINDPLAN_ORIENT_GATE;
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], env });
  const client = new Client({ name: "confirm-territory-test", version: "0.1.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.equal(names[names.indexOf("patch_node_territory") + 1], "confirm_territory", names.join(", "));
    ok("confirm_territory is listed right after patch_node_territory");

    await client.callTool({ name: "get_project", arguments: {} });
    const gated = await client.callTool({ name: "confirm_territory", arguments: { node_id: "i-served", note: "holds" } });
    assert.ok(gated.isError, gated.content?.[0]?.text);
    await client.callTool({ name: "orient_for_work", arguments: { node_id: "i-served", depth: "rules" } });
    const res = await client.callTool({ name: "confirm_territory", arguments: { node_id: "i-served", note: "holds" } });
    assert.ok(!res.isError, res.content?.[0]?.text);
    assert.deepEqual(res.structuredContent.changed_files, ["mindplan/interactions/i-served/confirmed.json"]);
    ok("over MCP the write gate applies until the node is oriented, then it confirms");
  } finally {
    await client.close();
  }
}

console.log("confirm-territory tests passed");
