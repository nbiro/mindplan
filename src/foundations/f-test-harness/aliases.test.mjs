/**
 * Aliases and the description check (npm test): aliases round-trip through create_node and
 * patch_node_territory (JSON-quoted in frontmatter, kept by other writes, cleared with []), reach
 * keyword search (a word the node's text lacks, a word in another language), and run_check warns,
 * never fails, on each kind of bad description.
 */
// Fixtures build graphs without a version stamp; the gate has its own suite (version.test.mjs).
process.env.MINDPLAN_VERSION_GATE ??= "off";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// Keyword-only: the alias must work in the fallback mode, with no model.
process.env.MINDPLAN_SEARCH = "keyword";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-aliases-"));
fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });
fs.writeFileSync(path.join(root, "mindplan", "config.json"), JSON.stringify({ sources: ["src/**"], exclude: [] }) + "\n");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(toolRoot, "dist/index.js")],
  env: { ...process.env, MINDPLAN_ROOT: root },
  stderr: "pipe",
});
const client = new Client({ name: "aliases-test", version: "0.1.0" });
await client.connect(transport);

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
  return { error: !!res.isError, text: res.content?.[0]?.text ?? "" };
}
async function call(tool, args) {
  const r = await raw(tool, args);
  if (r.error) throw new Error(`${tool}: ${r.text}`);
  return JSON.parse(r.text);
}
const file = (kind, id) => fs.readFileSync(path.join(root, "mindplan", kind, id, `${id}.mdx`), "utf-8");

await call("create_node", { id: "j-book", type: "Journey", title: "Enquiries", description: "A visitor sends a form enquiry." });
await call("create_node", {
  id: "i-send-enquiry",
  type: "Interaction",
  title: "Send an enquiry",
  description: "Visitor sends the business a message from the contact form.",
  aliases: ["quote", "request a quote", "ofertă", "QUOTE"],
});
await call("create_node", { id: "i-contact-platform", type: "Interaction", title: "Contact the platform", description: "Visitor sends the platform a message through a form." });
await call("create_node", { id: "f-skyloom", type: "Foundation", title: "SkyLoom template", description: "Design system — the skyloom template's look.", role: "design-system" });

const text = file("interactions", "i-send-enquiry");
check(
  "create_node writes aliases JSON-quoted and deduplicated ignoring case",
  text.includes('aliases:\n  - "quote"\n  - "request a quote"\n  - "ofertă"') && !text.includes('"QUOTE"'),
  text.split("---")[1]
);
const ctx = await call("get_node_context", { node_id: "i-send-enquiry" });
check("the record carries aliases", JSON.stringify(ctx.record.aliases) === JSON.stringify(["quote", "request a quote", "ofertă"]));

const quote = await call("find_related_nodes", { query: "request a quote skyloom" });
check("keyword-only search ranks the alias's node first for a word its text lacks", quote.matches[0]?.id === "i-send-enquiry", JSON.stringify(quote.matches.map((m) => m.id)));
const ro = await call("find_related_nodes", { query: "ofertă" });
check("an alias in another language matches (diacritics folded)", ro.matches[0]?.id === "i-send-enquiry", JSON.stringify(ro.matches.map((m) => m.id)));
const plain = await call("find_related_nodes", { query: "oferta" });
check("and without its diacritics", plain.matches[0]?.id === "i-send-enquiry", JSON.stringify(plain.matches.map((m) => m.id)));

await call("patch_node_territory", { node_id: "i-send-enquiry", description: "Visitor sends the business a message from the contact form kind." });
check("another write keeps the aliases", file("interactions", "i-send-enquiry").includes('- "request a quote"'));
const patched = await call("patch_node_territory", { node_id: "i-send-enquiry", aliases: ["árajánlat", "price request"] });
check(
  "patch_node_territory aliases replaces the list and reports it",
  JSON.stringify(patched.aliases) === JSON.stringify(["árajánlat", "price request"]) && patched.changed_files.some((f) => f.endsWith("i-send-enquiry.mdx")),
  JSON.stringify(patched)
);
const hu = await call("find_related_nodes", { query: "árajánlat" });
check("the new alias is searchable on the next call", hu.matches[0]?.id === "i-send-enquiry");
const tooLong = await raw("patch_node_territory", { node_id: "i-send-enquiry", aliases: ["x".repeat(61)] });
check("an alias over 60 characters is rejected", tooLong.error);
await call("patch_node_territory", { node_id: "i-send-enquiry", aliases: [] });
check("[] clears the aliases", !file("interactions", "i-send-enquiry").includes("aliases:"));

// A `$` in free text is written as is, never read as a replacement pattern.
await call("patch_node_territory", { node_id: "i-send-enquiry", aliases: ["$$$ tier", "a $& b", "x $' y"] });
const dollars = await call("get_node_context", { node_id: "i-send-enquiry" });
check(
  "aliases with $ patterns round-trip and the file stays intact",
  JSON.stringify(dollars.record.aliases) === JSON.stringify(["$$$ tier", "a $& b", "x $' y"]) &&
    file("interactions", "i-send-enquiry").split("\n---").length === 2,
  JSON.stringify(dollars.record.aliases)
);
await call("patch_node_territory", { node_id: "i-send-enquiry", description: "Visitor pays $$ for a $& quote." });
check("a description with $ patterns is written as is", (await call("get_node_context", { node_id: "i-send-enquiry" })).record.description === "Visitor pays $$ for a $& quote.");
await call("patch_node_territory", { node_id: "i-send-enquiry", aliases: [], toggle_checkboxes: [] });
check("an empty toggle list does not block an alias write", !file("interactions", "i-send-enquiry").includes("aliases:"));

// Aliases on a closed Bug are Blocked before anything is written.
await call("create_node", { id: "bug-old", type: "Bug", title: "Old bug", description: "Checkout no longer shows the total." });
await call("update_node_status", { node_id: "bug-old", new_status: "wontfix" });
const before = file("bugs", "bug-old");
const closed = await raw("patch_node_territory", { node_id: "bug-old", description: "Changed.", aliases: ["x"] });
check("aliases plus a field on a closed Bug are Blocked and write nothing", closed.error && file("bugs", "bug-old") === before, closed.text);

// --- description check: warnings, never failures ---
await call("create_node", { id: "j-same", type: "Journey", title: "Billing", description: "Billing" });
await call("create_node", { id: "j-long", type: "Journey", title: "Reports", description: `Reports area. ${"Detail ".repeat(50)}` });
await call("create_node", { id: "i-actorless", type: "Interaction", title: "Export a report", description: "Exports the monthly report as a PDF file." });
await call("create_node", { id: "j-history", type: "Journey", title: "Settings", description: "Settings now live on one page and no longer on three." });
await call("create_node", { id: "f-signer", type: "Foundation", title: "Signer", description: "Infra — the key used to sign requests.", role: "infra" });
await call("create_node", { id: "bug-total", type: "Bug", title: "Total missing", description: "Checkout no longer shows the order total." });
const result = await call("run_check", {});
const warns = (id) => result.warnings.filter((w) => w.startsWith(`description: "${id}"`));
check("run_check stays ok with bad descriptions", result.ok === true);
check("a description that repeats the title warns", warns("j-same").some((w) => w.includes("repeats its title")), JSON.stringify(warns("j-same")));
check("a description over 300 characters warns", warns("j-long").some((w) => w.includes("over 300")));
check("an Interaction description with no actor warns", warns("i-actorless").some((w) => w.includes("names no actor")));
check("revision wording warns", warns("j-history").some((w) => w.includes('"now"')), JSON.stringify(warns("j-history")));
check("\"used to\" in a purpose phrase does not warn", warns("f-signer").length === 0, JSON.stringify(warns("f-signer")));
check("a Bug describing a regression does not warn", warns("bug-total").length === 0, JSON.stringify(warns("bug-total")));
check("a good description does not warn", warns("i-contact-platform").length === 0 && warns("j-book").length === 0, JSON.stringify(warns("i-contact-platform")));

await client.close();
fs.rmSync(root, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} aliases check(s) failed.`);
  process.exit(1);
}
console.log("\nAll aliases checks passed.");
