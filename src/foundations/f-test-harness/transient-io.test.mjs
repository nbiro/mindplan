/**
 * Transient file-lock coverage (npm test): the territory store's node-file I/O waits out a lock
 * another process holds for a moment (EBUSY / EPERM / EACCES / UNKNOWN on Windows) and throws any
 * other error at once; and open_next followed by patch_node_territory and record_decision sent
 * together, over and over, always succeeds with the decision on the new next file.
 */
// Fixtures build graphs without a version stamp; the gate has its own suite (version.test.mjs).
process.env.MINDPLAN_VERSION_GATE ??= "off";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { isTransientFsError, withTransientRetry } from "../../../dist/foundations/f-source-index/io.js";

// Spawned servers rank by keyword only: no model download or load during tests.
process.env.MINDPLAN_SEARCH ??= "keyword";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`ok   ${label}`);
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const fsError = (code) => Object.assign(new Error(`${code}: open 'x.next.mdx'`), { code });

// --- the retry wrapper ---
for (const code of ["EBUSY", "EPERM", "EACCES", "UNKNOWN"]) {
  let calls = 0;
  const value = withTransientRetry(() => {
    if (++calls < 3) throw fsError(code);
    return "read";
  }, [1, 1, 1], "win32");
  check(`${code} is retried on Windows until the file opens`, value === "read" && calls === 3, `calls=${calls}`);
}
{
  let calls = 0;
  let thrown;
  try {
    withTransientRetry(() => {
      calls++;
      throw fsError("ENOENT");
    }, [1, 1, 1]);
  } catch (err) {
    thrown = err;
  }
  check("any other error is thrown at once", thrown?.code === "ENOENT" && calls === 1, `calls=${calls}`);
}
{
  let calls = 0;
  let thrown;
  try {
    withTransientRetry(() => {
      calls++;
      throw fsError("EBUSY");
    }, [1, 1]);
  } catch (err) {
    thrown = err;
  }
  check("a lock that outlasts the back-off throws its last error", thrown?.code === "EBUSY" && calls === 3, `calls=${calls}`);
}
for (const code of ["EPERM", "EACCES"]) {
  let calls = 0;
  try {
    withTransientRetry(() => {
      calls++;
      throw fsError(code);
    }, [1, 1, 1], "linux");
  } catch {}
  check(`${code} is a real permission error outside Windows and is not retried`, calls === 1, `calls=${calls}`);
}
for (const code of ["EBUSY", "UNKNOWN"]) {
  check(`${code} is transient outside Windows too`, isTransientFsError(fsError(code), "linux"));
}
check("an error without a code is not transient", !isTransientFsError(new Error("x")) && !isTransientFsError(null));

// --- open_next, then patch_node_territory and record_decision in one batch ---
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-transient-io-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, MINDPLAN_ROOT: root },
});
const client = new Client({ name: "transient-io-test", version: "0.1.0" });
await client.connect(transport);

async function raw(tool, args) {
  const res = await client.callTool({ name: tool, arguments: args });
  return { error: !!res.isError, text: res.content?.[0]?.text ?? "" };
}
async function call(tool, args) {
  const { error, text } = await raw(tool, args);
  if (error) throw new Error(`${tool}: ${text}`);
  return JSON.parse(text || "{}");
}

fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
fs.writeFileSync(
  path.join(root, "mindplan", "config.json"),
  JSON.stringify({ sources: ["src/**"], exclude: [] }, null, 2) + "\n"
);
fs.mkdirSync(path.join(root, "src", "f-store"), { recursive: true });
fs.writeFileSync(path.join(root, "src", "f-store", "index.ts"), "export const store = 1;\n");

await call("create_node", { id: "f-store", type: "Foundation", title: "Store", description: "Infra — store", role: "infra" });
await call("set_implementation_files", { node_id: "f-store", files: ["src/f-store/"] });
const live = path.join(root, "mindplan", "foundations", "f-store", "f-store.mdx");
const next = path.join(root, "mindplan", "foundations", "f-store", "f-store.next.mdx");
fs.writeFileSync(
  live,
  fs.readFileSync(live, "utf-8").replace(/^_.*?_$/gm, "Transient-io test territory.").replaceAll("- [ ]", "- [x]")
);
for (const new_status of ["ready", "in-progress", "in-review", "ship"]) {
  await call("update_node_status", { node_id: "f-store", new_status });
}

const ROUNDS = 25;
const failed = [];
for (let round = 0; round < ROUNDS; round++) {
  await call("open_next", { node_id: "f-store" });
  const results = await Promise.all([
    raw("patch_node_territory", { node_id: "f-store", replace: { find: "Transient-io test territory.", with: `Round ${round}.`, all: true } }),
    raw("record_decision", {
      node_id: "f-store",
      decision: `Round ${round} keeps one store.`,
      alternatives: ["Two stores"],
      why: "One writer per file.",
    }),
  ]);
  const errors = results.filter((r) => r.error).map((r) => r.text);
  const onNext = fs.readFileSync(next, "utf-8").includes(`Round ${round} keeps one store.`);
  if (errors.length || !onNext) failed.push({ round, errors, onNext });
  await call("discard_next", { node_id: "f-store" });
}
check(
  `open_next, then patch_node_territory and record_decision together, succeeds ${ROUNDS} times out of ${ROUNDS}`,
  failed.length === 0,
  JSON.stringify(failed.slice(0, 3))
);

await client.close();
fs.rmSync(root, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} transient-io check(s) failed.`);
  process.exit(1);
}
console.log("\nAll transient-io checks passed.");
