/**
 * find_in_node and search_graph (owned by i-find-text): matches with line and section, snippets
 * unique in their slot that patch_node_territory's replace accepts (CRLF files too), the open
 * revision's slot, the Blocked cases, regex, and search_graph across nodes with limit/more.
 * Run via npm test.
 */
// Fixtures build graphs without a version stamp; the gate has its own suite (version.test.mjs).
process.env.MINDPLAN_VERSION_GATE ??= "off";
// The orientation gate has its own suite (orient-gate.test.mjs).
process.env.MINDPLAN_ORIENT_GATE ??= "off";
// Spawned servers rank by keyword only: no model download or load during tests.
process.env.MINDPLAN_SEARCH ??= "keyword";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SHIP } from "./ship-fixture.mjs";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serverEntry = path.join(toolRoot, "dist/index.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-find-text-"));
console.log("Find-text sandbox:", root);

fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
fs.writeFileSync(path.join(root, "mindplan", "config.json"), JSON.stringify({ sources: ["src/**"], exclude: [] }, null, 2) + "\n");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, MINDPLAN_ROOT: root },
});
const client = new Client({ name: "find-text-test", version: "0.1.0" });
await client.connect(transport);
await client.callTool({ name: "get_project", arguments: {} });

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`ok   ${label}`);
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

async function raw(tool, args) {
  const res = await client.callTool({ name: tool, arguments: args });
  return { error: Boolean(res.isError), text: res.content?.[0]?.text ?? "" };
}

async function call(tool, args) {
  const r = await raw(tool, args);
  if (r.error) throw new Error(`${tool}: ${r.text}`);
  return JSON.parse(r.text || "{}");
}

const liveOf = (id) => `mindplan/foundations/${id}/${id}.mdx`;
const revOf = (id, change) => `mindplan/foundations/${id}/revisions/${change}/${id}.mdx`;
const abs = (rel) => path.join(root, ...rel.split("/"));
const readRel = (rel) => fs.readFileSync(abs(rel), "utf-8");
const writeRel = (rel, text) => {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), text);
};
const lf = (text) => text.replace(/\r\n/g, "\n");
const occurrences = (text, needle) => text.split(needle).length - 1;

/** A Foundation claiming its own source file, its scaffold filled and every box ticked, at draft. */
async function foundation(id) {
  await call("create_node", { id, type: "Foundation", title: id, description: `Infra — ${id}`, role: "infra" });
  writeRel(`src/${id}/index.ts`, `export const ${id.replace(/-/g, "_")} = 1;\n`);
  await call("set_implementation_files", { replace: true, node_id: id, files: [`src/${id}/`] });
  let text = readRel(liveOf(id));
  text = text.replace(/^_.*?_$/gm, (line) => (line.includes("attachments/") ? line : "Find-text filled territory."));
  writeRel(liveOf(id), text.replaceAll("- [ ]", "- [x]"));
}

/** Appends `lines` to the end of a node file's body (before `## Rules` / `## Attachments` does not matter here). */
function appendToFile(rel, lines) {
  writeRel(rel, `${readRel(rel).replace(/\s+$/, "")}\n\n${lines.join("\n")}\n`);
}

// --- a draft node: matches, sections, snippets, replace ---
await foundation("f-alpha");
await call("patch_node_rules", { node_id: "f-alpha", rules: "- Shared line." });
appendToFile(liveOf("f-alpha"), [
  "## Items",
  "",
  "The widget renders a list.",
  "Shared line.",
  "",
  "## Notes",
  "",
  "Shared line.",
  "Another Widget mention.",
]);

const bodyOf = async (id, slot) => {
  const ctx = await call("get_node_context", { node_id: id, ...(slot ? { slot } : {}) });
  return lf(slot === "next" ? ctx.next.body : ctx.body);
};

{
  const body = await bodyOf("f-alpha");
  const found = await call("find_in_node", { node_id: "f-alpha", text: "widget" });
  check(
    "find_in_node matches case-insensitively, line by line",
    found.total === 2 && found.matches.length === 2 && found.more === undefined && found.node_id === "f-alpha",
    JSON.stringify(found)
  );
  const [first, second] = found.matches;
  check(
    "each match names its slot, line, section, and full line",
    first?.slot === "current" &&
      first.section === "## Items" &&
      first.match === "The widget renders a list." &&
      body.split("\n")[first.line - 1] === first.match &&
      second?.section === "## Notes" &&
      second.match === "Another Widget mention." &&
      body.split("\n")[second.line - 1] === second.match,
    JSON.stringify(found.matches)
  );
  check("a unique line is its own snippet", first.snippet === first.match && first.occurrences === 1, JSON.stringify(first));
  check("no record or rules in the reply", found.record === undefined && found.rules === undefined, Object.keys(found).join(","));

  const exact = await call("find_in_node", { node_id: "f-alpha", text: "widget", case_sensitive: true });
  check("case_sensitive matches exact case only", exact.total === 1 && exact.matches[0].match === "The widget renders a list.", JSON.stringify(exact));

  const regex = await call("find_in_node", { node_id: "f-alpha", text: "^Another \\w+ mention", regex: true });
  check("regex matches a JS regular expression", regex.total === 1 && regex.matches[0].section === "## Notes", JSON.stringify(regex));

  const limited = await call("find_in_node", { node_id: "f-alpha", text: "widget", limit: 1 });
  check("limit caps matches and more counts the rest", limited.matches.length === 1 && limited.total === 2 && limited.more === 1, JSON.stringify(limited));

  // The line twice in the body (and once in Rules, which replace never sees).
  const shared = await call("find_in_node", { node_id: "f-alpha", text: "Shared line." });
  check("the Rules section is not searched", shared.total === 2, JSON.stringify(shared));
  const snip = shared.matches[0];
  check(
    "a repeated line grows its snippet until it occurs once",
    snip.snippet !== "Shared line." && snip.snippet.includes("Shared line.") && snip.occurrences === 1 && occurrences(body, snip.snippet) === 1,
    JSON.stringify(snip)
  );
  check(
    "the snippet grows after, then before, the line",
    snip.snippet === "The widget renders a list.\nShared line.\n",
    JSON.stringify(snip.snippet)
  );
  const second2 = shared.matches[1];
  check(
    "the second occurrence gets its own unique snippet",
    second2.occurrences === 1 && occurrences(body, second2.snippet) === 1 && second2.snippet !== snip.snippet,
    JSON.stringify(second2)
  );
  const replaced = await raw("patch_node_territory", {
    node_id: "f-alpha",
    replace: { find: second2.snippet, with: second2.snippet.replace("Shared line.", "Unique line.") },
  });
  check("the snippet goes straight into replace.find", !replaced.error, replaced.text);
  const after = await bodyOf("f-alpha");
  check(
    "replace changed the matched occurrence only, and Rules kept their text",
    after.includes("## Notes\n\nUnique line.\nAnother Widget mention.") &&
      occurrences(after, "Shared line.") === 1 &&
      readRel(liveOf("f-alpha")).includes("- Shared line."),
    after
  );
}

// --- Blocked cases ---
{
  const unknown = await raw("find_in_node", { node_id: "f-nope", text: "x" });
  check("an unknown node is Blocked", unknown.error && unknown.text.includes("Blocked:") && unknown.text.includes("f-nope"), unknown.text);
  const empty = await raw("find_in_node", { node_id: "f-alpha", text: "" });
  check("empty text is Blocked", empty.error && empty.text.includes("Blocked:"), empty.text);
  const noNext = await raw("find_in_node", { node_id: "f-alpha", text: "widget", slot: "next" });
  check("slot next with no open revision is Blocked", noNext.error && noNext.text.includes("Blocked:") && noNext.text.includes("no open revision"), noNext.text);
  const badRegex = await raw("find_in_node", { node_id: "f-alpha", text: "(", regex: true });
  check("an invalid regex is Blocked", badRegex.error && badRegex.text.includes("Blocked:") && badRegex.text.includes("regex"), badRegex.text);
  const badGraphRegex = await raw("search_graph", { text: "[", regex: true });
  check("search_graph Blocks an invalid regex", badGraphRegex.error && badGraphRegex.text.includes("Blocked:"), badGraphRegex.text);
}

// --- CRLF node file: the snippet still matches exactly once ---
{
  writeRel(liveOf("f-alpha"), lf(readRel(liveOf("f-alpha"))).replace(/\n/g, "\r\n"));
  const found = await call("find_in_node", { node_id: "f-alpha", text: "another widget" });
  const m = found.matches[0];
  check("a CRLF body is searched with \\n lines", found.total === 1 && m.match === "Another Widget mention." && !m.snippet.includes("\r"), JSON.stringify(found));
  const shared = await call("find_in_node", { node_id: "f-alpha", text: "Unique line." });
  const res = await raw("patch_node_territory", { node_id: "f-alpha", replace: { find: shared.matches[0].snippet, with: "Rewritten line." } });
  const file = readRel(liveOf("f-alpha"));
  check(
    "a snippet from a CRLF file goes into replace.find and the file stays CRLF",
    !res.error && file.includes("Rewritten line.\r\nAnother Widget mention.") && !/[^\r]\n/.test(file),
    res.text
  );
  // The CRLF body counts occurrences the way replace does.
  const found2 = await call("find_in_node", { node_id: "f-alpha", text: "Shared line." });
  check("a single match is still found in CRLF", found2.total === 1 && found2.matches[0].occurrences === 1, JSON.stringify(found2));
}

// --- an open revision: the next slot ---
await foundation("f-beta");
for (const new_status of SHIP) await call("update_node_status", { node_id: "f-beta", new_status });
await call("open_next", { reason: "behavior", node_id: "f-beta", change: "beta-rev" });
appendToFile(revOf("f-beta", "beta-rev"), ["## Revision Notes", "", "Revision only text."]);
{
  const both = await call("find_in_node", { node_id: "f-beta", text: "revision only" });
  check(
    "by default the open revision is searched too, each match naming its slot and change",
    both.total === 1 && both.matches[0].slot === "next" && both.matches[0].change === "beta-rev" && both.matches[0].section === "## Revision Notes",
    JSON.stringify(both)
  );
  const nextBody = await bodyOf("f-beta", "next");
  check("the next line number is in the revision body", nextBody.split("\n")[both.matches[0].line - 1] === "Revision only text.", JSON.stringify(both.matches[0]));
  const live = await call("find_in_node", { node_id: "f-beta", text: "revision only", slot: "current" });
  check("slot current searches live only", live.total === 0, JSON.stringify(live));
  const next = await call("find_in_node", { node_id: "f-beta", text: "revision only", slot: "next" });
  check("slot next searches the open revision", next.total === 1 && next.matches[0].change === "beta-rev", JSON.stringify(next));
  const wrongChange = await raw("find_in_node", { node_id: "f-beta", text: "x", change: "nope" });
  check("an unknown change is Blocked", wrongChange.error && wrongChange.text.includes("Blocked:"), wrongChange.text);
  const filled = await call("find_in_node", { node_id: "f-beta", text: "Find-text filled territory." });
  check(
    "a line in both slots comes back once per slot",
    filled.matches.some((m) => m.slot === "current") && filled.matches.some((m) => m.slot === "next"),
    JSON.stringify(filled)
  );
  const res = await raw("patch_node_territory", {
    node_id: "f-beta",
    change: "beta-rev",
    replace: { find: next.matches[0].snippet, with: "Revision text, edited." },
  });
  check("a next-slot snippet goes into replace on that revision", !res.error && readRel(revOf("f-beta", "beta-rev")).includes("Revision text, edited."), res.text);
}

// --- search_graph ---
{
  const all = await call("search_graph", { text: "find-text filled" });
  const ids = new Set(all.matches.map((m) => m.node_id));
  check(
    "search_graph finds lines across nodes and slots",
    ids.has("f-alpha") && ids.has("f-beta") && all.matches.some((m) => m.slot === "next" && m.change === "beta-rev") && all.matches.every((m) => m.type === "Foundation" && typeof m.line === "number"),
    JSON.stringify(all)
  );
  check("search_graph returns no snippet", all.matches.every((m) => m.snippet === undefined), JSON.stringify(all.matches[0]));
  const one = await call("search_graph", { text: "find-text filled", limit: 1 });
  check("search_graph limit and more", one.matches.length === 1 && one.total === all.total && one.more === all.total - 1, JSON.stringify(one));
  const typed = await call("search_graph", { text: "find-text filled", type: "Interaction" });
  check("search_graph type filters nodes", typed.total === 0 && typed.matches.length === 0, JSON.stringify(typed));
  const rx = await call("search_graph", { text: "^Revision (only|text)", regex: true });
  check("search_graph regex", rx.total === 1 && rx.matches[0].node_id === "f-beta" && rx.matches[0].section === "## Revision Notes", JSON.stringify(rx));
  appendToFile(liveOf("f-alpha"), ["## Long", "", `${"x".repeat(300)} needle ${"y".repeat(300)}`]);
  const long = await call("search_graph", { text: "needle" });
  check("a long match line is cut around the match", long.matches[0].match.length <= 202 && long.matches[0].match.includes("needle"), JSON.stringify(long));
}

await client.close();
if (failures > 0) {
  console.log(`\nfind-text.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nfind-text.test.mjs: all ok");
