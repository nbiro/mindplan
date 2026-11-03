/**
 * Graph root per tool call (npm test). One MCP server, started on sandbox A, serves a second
 * checkout B (a git worktree in real use) when a call passes `root: B`: files land in B only,
 * changed_files are relative to B, the result names its root, orientation in A never unlocks a
 * write of the same id in B, a root without mindplan/ is Blocked, and interleaved async calls on
 * A and B never cross roots.
 */
// Fixtures build graphs without a version stamp; the gate has its own suite (version.test.mjs).
process.env.MINDPLAN_VERSION_GATE ??= "off";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// Spawned servers rank by keyword only: no model download or load during tests.
process.env.MINDPLAN_SEARCH ??= "keyword";
// Orientation is part of what a root scopes, so the gate is on.
delete process.env.MINDPLAN_ORIENT_GATE;

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");

function sandbox(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, "mindplan"), { recursive: true });
  fs.writeFileSync(path.join(dir, "mindplan", "config.json"), JSON.stringify({ sources: ["src/**"], exclude: [] }) + "\n");
  return dir;
}
const A = sandbox("mindplan-root-a-");
const B = sandbox("mindplan-root-b-");
const bare = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-root-bare-"));
console.log("Worktree-root sandboxes:", A, B);

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`ok   ${label}`);
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

async function session(root) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env, MINDPLAN_ROOT: root },
    stderr: "pipe",
  });
  const client = new Client({ name: "worktree-root-test", version: "0.1.0" });
  await client.connect(transport);
  const raw = async (tool, args) => {
    const res = await client.callTool({ name: tool, arguments: args });
    return { error: !!res.isError, text: res.content?.[0]?.text ?? "" };
  };
  const call = async (tool, args) => {
    const r = await raw(tool, args);
    if (r.error) throw new Error(`${tool}: ${r.text}`);
    return JSON.parse(r.text);
  };
  return { client, raw, call };
}

const nodeFile = (root, kind, id) => path.join(root, "mindplan", kind, id, `${id}.mdx`);

// B's graph is built by a server of its own, so the main session has oriented on nothing in B.
{
  const b = await session(B);
  await b.call("create_node", { id: "f-shared", type: "Foundation", title: "Shared B", description: "Infra — B", role: "infra" });
  await b.client.close();
}

const s = await session(A);
try {
  // --- every tool advertises `root` ---
  {
    const { tools } = await s.client.listTools();
    const missing = tools.filter((t) => !t.inputSchema?.properties?.root).map((t) => t.name);
    check("every tool schema has an optional root", missing.length === 0, missing.join(", "));
  }

  // --- writes land in the named root only ---
  await s.call("create_node", { id: "f-shared", type: "Foundation", title: "Shared A", description: "Infra — A", role: "infra" });
  const created = await s.call("create_node", {
    id: "i-only-b",
    type: "Interaction",
    title: "Only B",
    description: "Lives in B",
    root: B,
  });
  check("create_node with root writes B", fs.existsSync(nodeFile(B, "interactions", "i-only-b")));
  check("create_node with root leaves A alone", !fs.existsSync(path.join(A, "mindplan", "interactions", "i-only-b")));
  check("a foreign-root result names its root", created.root === path.resolve(B), JSON.stringify(created.root));
  const changed = created.changed_files ?? [];
  check(
    "changed_files are relative to B",
    changed.length > 0 && changed.every((f) => !path.isAbsolute(f) && f.startsWith("mindplan/")),
    JSON.stringify(changed)
  );
  const own = await s.call("get_node_context", { node_id: "f-shared" });
  check("a call without root reads A", own.record?.title === "Shared A", JSON.stringify(own.record?.title));
  check("a call on the server's root carries no root field", own.root === undefined);

  // --- orientation is per root ---
  await s.call("orient_for_work", { node_id: "f-shared" });
  const gated = await s.raw("patch_node_territory", { node_id: "f-shared", description: "Infra — B edited", root: B });
  check(
    "orienting f-shared in A does not unlock f-shared in B",
    gated.error && gated.text.startsWith("Blocked: Orientation"),
    gated.text.slice(0, 200)
  );
  // get_node_context orients too: reading B's node is what unlocks B's write.
  const theirs = await s.call("get_node_context", { node_id: "f-shared", root: B });
  check("a call with root reads B", theirs.record?.title === "Shared B", JSON.stringify(theirs.record?.title));
  await s.call("orient_for_work", { node_id: "i-only-b", root: B });
  const patched = await s.raw("patch_node_territory", { node_id: "f-shared", description: "Infra — B edited", root: B });
  check("orienting in B unlocks the write in B", !patched.error, patched.text.slice(0, 200));
  check(
    "the B write changed B's file, not A's",
    fs.readFileSync(nodeFile(B, "foundations", "f-shared"), "utf-8").includes("Infra — B edited") &&
      !fs.readFileSync(nodeFile(A, "foundations", "f-shared"), "utf-8").includes("Infra — B edited")
  );
  const linked = await s.raw("link_nodes", { source_id: "i-only-b", target_id: "f-shared", edge_type: "depends_on", root: B });
  check("link_nodes with root succeeds", !linked.error, linked.text.slice(0, 200));
  check(
    "link_nodes with root writes B's edge",
    /f-shared/.test(fs.readFileSync(nodeFile(B, "interactions", "i-only-b"), "utf-8"))
  );
  check(
    "a Blocked text from another root names that root",
    gated.text.endsWith(` (root: ${path.resolve(B)})`),
    gated.text.slice(-200)
  );

  // --- Windows paths are case-insensitive: orienting under one casing unlocks the other ---
  if (process.platform === "win32") {
    await s.call("create_node", { id: "f-case", type: "Foundation", title: "Case", description: "Infra — case", role: "infra", root: B });
    const upper = B.toUpperCase();
    await s.call("orient_for_work", { node_id: "f-case", root: upper });
    const cased = await s.raw("patch_node_territory", { node_id: "f-case", description: "Infra — case edited", root: B.toLowerCase() });
    check("orienting with one root casing unlocks a write with another (win32)", !cased.error, cased.text.slice(0, 200));
  }

  // --- run_check reads the named root ---
  const checkB = await s.call("run_check", { root: B });
  const checkA = await s.call("run_check", {});
  const textB = JSON.stringify(checkB);
  const textA = JSON.stringify(checkA);
  check("run_check with root names B", checkB.root === path.resolve(B), JSON.stringify(checkB.root));
  check("run_check on A never mentions B's node", !textA.includes("i-only-b"));
  check("run_check on B reads B's graph", !textB.includes("graph load failed"), textB.slice(0, 200));

  // --- a root without mindplan/ ---
  const noGraph = await s.raw("get_node_context", { node_id: "f-shared", root: bare });
  check(
    "a root without mindplan/ is Blocked",
    noGraph.error && noGraph.text === `Blocked: root "${bare}" has no mindplan/ folder`,
    noGraph.text
  );
  check("nothing was created under the bare root", fs.readdirSync(bare).length === 0);

  // --- root must be an absolute path to an existing directory, for every tool ---
  const missingDir = path.join(bare, "no-such-dir");
  const aFile = path.join(A, "mindplan", "config.json");
  for (const tool of ["get_node_context", "setup_project", "doctor"]) {
    const args = tool === "get_node_context" ? { node_id: "f-shared" } : {};
    const relative = await s.raw(tool, { ...args, root: "relative/checkout" });
    check(
      `${tool}: a relative root is Blocked`,
      relative.error && relative.text === 'Blocked: root "relative/checkout" must be an absolute path to a checkout or git worktree',
      relative.text
    );
    const absent = await s.raw(tool, { ...args, root: missingDir });
    check(
      `${tool}: a root that does not exist is Blocked`,
      absent.error && absent.text === `Blocked: root "${missingDir}" is not an existing directory`,
      absent.text
    );
    const file = await s.raw(tool, { ...args, root: aFile });
    check(`${tool}: a root that is a file is Blocked`, file.error && file.text.includes("is not an existing directory"), file.text);
  }
  check("setup_project with a missing root created nothing", !fs.existsSync(missingDir));
  const doctorBare = await s.raw("doctor", { root: bare });
  check("doctor still diagnoses an existing root without mindplan/", !doctorBare.error, doctorBare.text.slice(0, 200));

  // --- the root mark never appends text to a JSON payload ---
  {
    const { withCallRoot } = await import(new URL("../../../dist/interfaces/if-mcp-tools/call-root.js", import.meta.url).href);
    const foreign = { root: path.resolve(B), foreign: true };
    const list = [{ id: "a" }, { id: "b" }];
    const arrayResult = withCallRoot(foreign, { content: [{ type: "text", text: JSON.stringify(list) }] });
    check(
      "an array payload from another root is left untouched",
      arrayResult.content[0].text === JSON.stringify(list) && arrayResult.structuredContent === undefined,
      arrayResult.content[0].text
    );
    const own = { root: "C:/elsewhere", n: 1 };
    const ownRoot = withCallRoot(foreign, { content: [{ type: "text", text: JSON.stringify(own) }], structuredContent: own });
    check(
      "a payload that already has root keeps its own",
      ownRoot.structuredContent.root === "C:/elsewhere" && JSON.parse(ownRoot.content[0].text).root === "C:/elsewhere",
      ownRoot.content[0].text
    );
    const obj = { n: 1 };
    const objResult = withCallRoot(foreign, { content: [{ type: "text", text: JSON.stringify(obj) }], structuredContent: obj });
    check(
      "an object payload gains root in content and structuredContent",
      objResult.structuredContent.root === path.resolve(B) && JSON.parse(objResult.content[0].text).root === path.resolve(B),
      objResult.content[0].text
    );
    const plain = withCallRoot(foreign, { content: [{ type: "text", text: "Done." }] });
    check("a plain string payload is suffixed with its root", plain.content[0].text === `Done. (root: ${path.resolve(B)})`, plain.content[0].text);
    const doctorB = await s.call("doctor", { root: B });
    check("doctor's own root field stays valid JSON for another root", typeof doctorB.root === "string", JSON.stringify(doctorB.root));
  }

  // --- interleaved async calls never cross roots ---
  const ids = Array.from({ length: 6 }, (_, i) => `f-burst-${i}`);
  const results = await Promise.all([
    ...ids.map((id) =>
      s.call("create_node", { id, type: "Foundation", title: `Burst ${id}`, description: "Infra — burst", role: "infra", root: B })
    ),
    ...ids.map(() => s.call("find_related_nodes", { query: "shared infra" })),
  ]);
  const finds = results.slice(ids.length);
  const leaked = finds.flatMap((r) => JSON.stringify(r).match(/f-burst-\d|i-only-b/g) ?? []);
  check("find_related_nodes on A never sees B's nodes", leaked.length === 0, leaked.join(", "));
  check("every find on A ran on A", finds.every((r) => r.root === undefined));
  check(
    "every interleaved write landed in B only",
    ids.every((id) => fs.existsSync(nodeFile(B, "foundations", id)) && !fs.existsSync(path.join(A, "mindplan", "foundations", id)))
  );
  const findB = await s.call("find_related_nodes", { query: "burst", root: B });
  check("find_related_nodes with root searches B", JSON.stringify(findB).includes("f-burst-"));
} finally {
  await s.client.close();
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nWorktree-root checks passed.");
