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
// A session reads the project rules first (writes are Blocked: Rules until then), as an agent does.
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

// add / remove change single rules without resending the text.
await call("patch_project_rules", { rules: "- Verify changes with `npm test`.\n- Keep the brief short." });
const added = await call("patch_project_rules", { add: ["Ship at merge.", "Keep the brief short."] });
const afterAdd = await call("get_rules", {});
check(
  "add appends a bullet and skips a rule already present",
  afterAdd.rules === "- Verify changes with `npm test`.\n- Keep the brief short.\n- Ship at merge.",
  afterAdd.rules
);
check(
  "an add result confirms the change instead of echoing the brief",
  !("rules" in added) &&
    !("description" in added) &&
    JSON.stringify(added.added) === JSON.stringify(["Ship at merge."]) &&
    JSON.stringify(added.skipped) === JSON.stringify(["Keep the brief short."]) &&
    added.removed.length === 0 &&
    added.count === 3 &&
    added.rules_version === afterAdd.rules_version,
  JSON.stringify(added)
);
const removed = await call("patch_project_rules", { remove: ["Keep the brief"], add: ["Branch per change."] });
const afterRemove = await call("get_rules", {});
check(
  "remove matches a unique fragment and runs before add",
  afterRemove.rules === "- Verify changes with `npm test`.\n- Ship at merge.\n- Branch per change." &&
    JSON.stringify(removed.removed) === JSON.stringify(["Keep the brief short."]) &&
    JSON.stringify(removed.added) === JSON.stringify(["Branch per change."]),
  afterRemove.rules
);
for (const [label, args] of [
  ["a remove that matches nothing", { remove: ["No such rule"] }],
  ["a remove that matches several rules", { remove: ["e"] }],
  ["rules combined with add", { rules: "x", add: ["y"] }],
]) {
  let blocked = false;
  try {
    await raw("patch_project_rules", args);
  } catch {
    blocked = true;
  }
  check(`${label} is Blocked`, blocked);
}
const stillThere = await call("get_rules", {});
check("a Blocked call leaves the rules unchanged", stillThere.rules === afterRemove.rules, stillThere.rules);
await call("patch_project_rules", { rules: "" });

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

// Light rules: sources past distance 1 are one line unless asked; a link returns only what it changed.
{
  await call("create_node", { id: "f-api", type: "Foundation", role: "infra", title: "API", description: "Infra — the API." });
  await call("create_node", { id: "f-store", type: "Foundation", role: "infra", title: "Store", description: "Infra — storage." });
  await call("patch_node_rules", { node_id: "f-store", rules: "- Erase rows within 30 days of a request.\n- Log every erase." });
  await call("link_nodes", { source_id: "f-api", target_id: "f-store", edge_type: "depends_on" });
  const linked = await call("link_nodes", { source_id: "i-pay", target_id: "f-api", edge_type: "depends_on" });
  const delta = linked.rules?.entries ?? [];
  check(
    "a link result returns only the rule entries the link added, light past distance 1",
    delta.length === 1 &&
      delta[0].node_id === "f-store" &&
      delta[0].distance === 2 &&
      !("rules" in delta[0]) &&
      delta[0].first === "Erase rows within 30 days of a request." &&
      delta[0].count === 2,
    JSON.stringify(linked.rules)
  );
  const light = await call("orient_for_work", { node_id: "i-pay" });
  const byId = Object.fromEntries(light.rules.entries.map((e) => [e.node_id, e]));
  check(
    "orient returns own and distance-1 rules in full and further sources as one line",
    byId["i-pay"].rules.includes("card numbers") &&
      byId["j-shop"].rules.includes("VAT") &&
      !("rules" in byId["f-store"]) &&
      byId["f-store"].first.startsWith("Erase rows") &&
      /^[0-9a-f]{12}$/.test(byId["f-store"].version) &&
      /include_inherited_rules/.test(light.rules.more ?? ""),
    JSON.stringify(light.rules)
  );
  check("orient defaults to body depth: no neighborhood or blast radius", !("blast_radius" in light) && !("nodes" in light));
  const all = await call("orient_for_work", { node_id: "i-pay", depth: "rules", include_inherited_rules: true });
  const store = all.rules.entries.find((e) => e.node_id === "f-store");
  check(
    "include_inherited_rules returns every source's text",
    store.rules.includes("Log every erase") && !("first" in store) && !("more" in all.rules),
    JSON.stringify(all.rules)
  );
  const context = await call("get_node_context", { node_id: "i-pay" });
  const ctxStore = context.resolved_rules.entries.find((e) => e.node_id === "f-store");
  check("get_node_context resolved_rules is light too", ctxStore && !("rules" in ctxStore) && ctxStore.count === 2);
  const unlinked = await call("unlink_nodes", { source_id: "i-pay", target_id: "f-api", edge_type: "depends_on" });
  check(
    "an unlink result names the sources that stopped reaching the node and repeats none",
    unlinked.rules?.entries.length === 0 && JSON.stringify(unlinked.rules.removed) === JSON.stringify(["f-store"]),
    JSON.stringify(unlinked.rules)
  );
  await call("link_nodes", { source_id: "i-pay", target_id: "f-api", edge_type: "depends_on" });
  const closer = await call("link_nodes", { source_id: "i-pay", target_id: "f-store", edge_type: "depends_on" });
  const promoted = closer.rules?.entries ?? [];
  check(
    "a link that brings a source within distance 1 returns its full text though the text did not change",
    promoted.length === 1 && promoted[0].node_id === "f-store" && promoted[0].distance === 1 && promoted[0].rules.includes("Log every erase"),
    JSON.stringify(closer.rules)
  );
  await call("create_node", { id: "f-cache", type: "Foundation", role: "infra", title: "Cache", description: "Infra — caching." });
  await call("create_node", { id: "f-log", type: "Foundation", role: "infra", title: "Log", description: "Infra — logging." });
  const plain = await call("link_nodes", { source_id: "f-cache", target_id: "f-log", edge_type: "depends_on" });
  check("a link that changes no rule returns no rules block", !("rules" in plain), JSON.stringify(plain.rules));
}

// --- Project rules gate and push: writes wait until the rules reached the session ---
{
  await call("patch_project_rules", { rules: "- Branch per change." });
  const fresh = async () => {
    const t = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(toolRoot, "dist/index.js")],
      env: { ...process.env, MINDPLAN_ROOT: root },
      stderr: "pipe",
    });
    const c = new Client({ name: "rules-gate-test", version: "0.1.0" });
    await c.connect(t);
    const r = async (tool, args) => {
      const res = await c.callTool({ name: tool, arguments: args });
      return { error: Boolean(res.isError), text: res.content[0].text };
    };
    return { c, r };
  };

  const a = await fresh();
  const before = await a.r("create_node", { id: "j-gate", type: "Capability", title: "Gate", description: "Gate checks." });
  check(
    "a write before the rules reached a fresh session is Blocked: Rules naming get_project",
    before.error && before.text.startsWith("Blocked: Rules") && before.text.includes("get_project"),
    before.text
  );
  const pushed = JSON.parse((await a.r("orient_for_work", { node_id: "i-pay", depth: "rules" })).text);
  check(
    "the first orient of a session carries project_rules",
    pushed.project_rules?.rules === "- Branch per change." && /^[0-9a-f]{12}$/.test(pushed.project_rules.rules_version),
    JSON.stringify(pushed.project_rules)
  );
  const again = JSON.parse((await a.r("orient_for_work", { node_id: "i-pay", depth: "rules" })).text);
  check("an orient while the rules are current carries no project_rules", !("project_rules" in again));
  const created = await a.r("create_node", { id: "j-gate", type: "Capability", title: "Gate", description: "Gate checks." });
  check("after the push the write passes the rules gate", !created.error, created.text);

  // Another session changes the rules: this one is Blocked until they reach it again.
  await call("patch_project_rules", { add: ["Ship at merge."] });
  const stale = await a.r("patch_node_territory", { node_id: "j-gate", description: "Gate checks, again." });
  check(
    "after another session changed the rules, a write is Blocked: Rules naming get_rules",
    stale.error && stale.text.startsWith("Blocked: Rules") && stale.text.includes("get_rules"),
    stale.text
  );
  const reread = await a.r("get_rules", {});
  check("get_rules re-reads them", reread.text.includes("Ship at merge."));
  const passes = await a.r("patch_node_territory", { node_id: "j-gate", description: "Gate checks, again." });
  check("after get_rules the write passes", !passes.error, passes.text);

  // The next orient after a rules change carries the new text.
  await call("patch_project_rules", { add: ["Keep it short."] });
  const viaOrient = JSON.parse((await a.r("orient_for_work", { node_id: "j-gate", depth: "rules" })).text);
  check("an orient after a rules change pushes the new text", viaOrient.project_rules?.rules.includes("Keep it short."));
  // The author of a rules change holds the new text: its own next write is not Blocked.
  await a.r("patch_project_rules", { add: ["One more."] });
  const own = await a.r("patch_node_territory", { node_id: "j-gate", description: "Gate checks, thrice." });
  check("the session that patched the rules is not Blocked by its own change", !own.error, own.text);
  await a.c.close();

  // get_project alone unlocks writes in a fresh session.
  const b = await fresh();
  await b.r("get_project", {});
  const ok = await b.r("create_node", { id: "j-gate-b", type: "Capability", title: "Gate B", description: "Gate checks by b." });
  check("get_project alone unlocks the rules gate", !ok.error, ok.text);
  await b.c.close();
  // Session a changed the rules after this session read them: re-read, then clear them.
  await call("get_rules", {});
  await call("patch_project_rules", { rules: "" });
}

await client.close();
fs.rmSync(root, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} rules-version check(s) failed.`);
  process.exit(1);
}
console.log("\nAll rules-version checks passed.");
