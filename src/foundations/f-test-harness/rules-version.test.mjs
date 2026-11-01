/**
 * Rules version tags (npm test): get_project and get_rules tag the project rules; get_rules with
 * the current tag returns a short unchanged reply; patch_project_rules changes the tag; orient's
 * node-rule entries carry a version and leave out text the caller already holds.
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

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-rules-version-"));
fs.mkdirSync(path.join(root, "mindplan"), { recursive: true });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(toolRoot, "dist/index.js")],
  env: { ...process.env, MINDPLAN_ROOT: root },
  stderr: "pipe",
});
const client = new Client({ name: "rules-version-test", version: "0.1.0" });
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
  if (res.isError) throw new Error(`${tool}: ${res.content[0].text}`);
  return res.content[0].text;
}
const call = async (tool, args) => JSON.parse(await raw(tool, args));

await call("patch_project_rules", { rules: "- Verify changes with `npm test`.\n- Keep the brief short." });
const project = await call("get_project", {});
check("get_project returns rules_version", /^[0-9a-f]{12}$/.test(project.rules_version ?? ""), JSON.stringify(project.rules_version));

const first = await call("get_rules", {});
check(
  "get_rules without known_version returns the text and the same tag",
  first.rules.includes("npm test") && first.rules_version === project.rules_version
);
const sameText = await raw("get_rules", { known_version: project.rules_version });
const same = JSON.parse(sameText);
check(
  "an unchanged get_rules is short and carries no text",
  same.unchanged === true && !("rules" in same) && same.rules_version === project.rules_version,
  sameText
);
check(`the unchanged reply is under 150 bytes (${Buffer.byteLength(sameText)})`, Buffer.byteLength(sameText) < 150);

const stale = await call("get_rules", { known_version: "000000000000" });
check("a stale known_version gets the full text", stale.rules === first.rules && !stale.unchanged);

await call("patch_project_rules", { rules: "- Verify changes with `npm test`.\n- Ship at merge." });
const after = await call("get_rules", { known_version: project.rules_version });
check(
  "patch_project_rules changes the version, and the old tag gets the new text",
  after.rules_version !== project.rules_version && after.rules.includes("Ship at merge") && !after.unchanged
);
await call("patch_project_rules", { rules: "" });
const empty = await call("get_rules", {});
check("empty rules still carry a version", empty.rules === "" && /^[0-9a-f]{12}$/.test(empty.rules_version));

// Node rules in orient carry a version; known versions leave the text out.
await call("create_node", { id: "j-shop", type: "Capability", title: "Shop", description: "Buying things." });
await call("create_node", { id: "i-pay", type: "Interaction", title: "Pay", description: "Shopper pays." });
await call("link_nodes", { source_id: "i-pay", target_id: "j-shop", edge_type: "belongs_to" });
await call("patch_node_rules", { node_id: "j-shop", rules: "- Prices include VAT." });
// The Capability's new rules reach i-pay, so the orientation gate asks to orient on it again.
await call("orient_for_work", { node_id: "i-pay", depth: "rules" });
await call("patch_node_rules", { node_id: "i-pay", rules: "- Never store card numbers." });
const oriented = await call("orient_for_work", { node_id: "i-pay", depth: "rules" });
const versions = Object.fromEntries(oriented.rules.entries.map((e) => [e.node_id, e.version]));
check(
  "each orient rules entry carries a version",
  oriented.rules.entries.length === 2 && oriented.rules.entries.every((e) => /^[0-9a-f]{12}$/.test(e.version) && e.rules)
);
const known = await call("orient_for_work", { node_id: "i-pay", depth: "rules", known_rules_versions: { "j-shop": versions["j-shop"] } });
const capability = known.rules.entries.find((e) => e.node_id === "j-shop");
const own = known.rules.entries.find((e) => e.node_id === "i-pay");
check(
  "a known rules version leaves out that entry's text; the others keep theirs",
  capability.unchanged === true && !("rules" in capability) && capability.via === "belongs_to" && own.rules.includes("card numbers") && !own.unchanged,
  JSON.stringify(known.rules)
);
await call("orient_for_work", { node_id: "j-shop", depth: "rules" });
await call("patch_node_rules", { node_id: "j-shop", rules: "- Prices include VAT.\n- Show the currency." });
const changed = await call("orient_for_work", { node_id: "i-pay", depth: "rules", known_rules_versions: versions });
const capabilityAfter = changed.rules.entries.find((e) => e.node_id === "j-shop");
check(
  "changed node rules come back with text and a new version",
  capabilityAfter.rules.includes("currency") && capabilityAfter.version !== versions["j-shop"] && !capabilityAfter.unchanged
);

await client.close();
fs.rmSync(root, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} rules-version check(s) failed.`);
  process.exit(1);
}
console.log("\nAll rules-version checks passed.");
