/**
 * Gates over several open revisions per node (npm test), no server. Graphs are built in memory
 * over a temp project root holding the source files the import rule reads. Covers: two changes on
 * one shipped Foundation each adding a different depends_on (under one change the other's edge is
 * invisible to reachability, imports, and Infrastructure First at ship); an Interface revision
 * importing an Interaction it exposes passes only under its own change; a same-change double claim
 * is a conflict while different changes are allowed with a warning; a revision with rebase
 * conflicts is Blocked at in-review naming resolve_conflict; open_next allows a second change;
 * change membership and planned edges read revisions.
 */
process.env.MINDPLAN_VERSION_GATE ??= "off";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-multi-revision-gates-"));
process.env.MINDPLAN_ROOT = root;
delete process.env.MINDPLAN_GRAPH_CACHE;

const rules = await import("../../../dist/foundations/f-compiler-rules/rules.js");
const integrity = await import("../../../dist/foundations/f-compiler-rules/integrity.js");
const planned = await import("../../../dist/foundations/f-compiler-rules/planned.js");
const shape = await import("../../../dist/foundations/f-compiler-rules/shape.js");
const ownership = await import("../../../dist/foundations/f-source-index/ownership.js");
const { formatRevisionFile, revisionFilePath } = await import("../../../dist/foundations/f-territory-store/revisions.js");

const ok = (label) => console.log(`ok   ${label}`);
const blocked = (fn, re) =>
  assert.throws(fn, (e) => /^Blocked:/.test(e.message) && (!re || re.test(e.message)) ? true : assert.fail(e.message));

function write(rel, text) {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf-8");
}

const SHIPPED = "2026-01-02T00:00:00.000Z";
const empty = () => ({ add: [], remove: [] });

function revision(change, { state = "draft", edges = {}, implements: impl = empty(), tests = empty(), conflicts = [] } = {}) {
  return {
    change,
    state,
    opened_at: SHIPPED,
    updated_at: SHIPPED,
    title: `Revision ${change}`,
    description: `Revision ${change}.`,
    edges,
    implements: impl,
    tests,
    base: { scalars: {}, sections: {} },
    conflicts,
  };
}

function node(id, type, extra = {}) {
  return {
    id,
    type,
    title: `Title ${id}`,
    description: type === "Foundation" ? `Infra — ${id}.` : `Visitor uses ${id}.`,
    state: "stable",
    shipped_at: SHIPPED,
    created_at: SHIPPED,
    updated_at: SHIPPED,
    ...(type === "Foundation" ? { role: "infra" } : {}),
    ...extra,
  };
}

/** Edges as the loader builds them: from live fields only. */
function graphOf(nodes) {
  const edges = [];
  for (const n of nodes) {
    for (const type of ["belongs_to", "depends_on", "exposes", "leads_to", "mounts", "affects"]) {
      for (const target of n[type] ?? []) edges.push({ source: n.id, target, type });
    }
  }
  return { version: 1, nodes, edges };
}

// Source files the import rule reads.
write("src/core/a.ts", `import { x } from "../dep-a/x";\nimport { y } from "../dep-b/y";\nexport const a = x + y;\n`);
write("src/dep-a/x.ts", "export const x = 1;\n");
write("src/dep-b/y.ts", "export const y = 2;\n");
write("src/page/p.ts", `import { z } from "../flow/z";\nexport const p = z;\n`);
write("src/flow/z.ts", "export const z = 3;\n");
write("src/own1/o.ts", "export const o1 = 1;\n");
write("src/own2/o.ts", "export const o2 = 2;\n");
write("src/shared/s.ts", "export const s = 1;\n");

// --- Two changes on one shipped Foundation, each adding a different depends_on ---
{
  const core = node("f-core", "Foundation", {
    implements: ["src/core/"],
    open_revisions: [
      revision("alpha", { edges: { depends_on: { add: ["f-dep-a"], remove: [] } } }),
      revision("beta", { edges: { depends_on: { add: ["f-dep-b"], remove: [] } } }),
    ],
  });
  const g = graphOf([
    core,
    node("f-dep-a", "Foundation", { implements: ["src/dep-a/"] }),
    node("f-dep-b", "Foundation", { implements: ["src/dep-b/"] }),
  ]);
  const ids = (list) => list.map((n) => n.id);

  const underA = rules.revisionGraph(g, "alpha");
  const coreA = underA.nodes.find((n) => n.id === "f-core");
  assert.deepEqual(ids(rules.reachableFoundations(coreA, underA)), ["f-dep-a"]);
  const underB = rules.revisionGraph(g, "beta");
  assert.deepEqual(ids(rules.reachableFoundations(underB.nodes.find((n) => n.id === "f-core"), underB)), ["f-dep-b"]);
  assert.equal(underA.edges.some((e) => e.source === "f-core" && e.target === "f-dep-b"), false);
  ok("under one change the other change's depends_on is invisible to reachability");

  const imports = (change) => integrity.findImportViolationsForNode(g, root, core, change).map((v) => v.imports).sort();
  assert.deepEqual(imports("alpha"), ["src/dep-b/y.ts"]);
  assert.deepEqual(imports("beta"), ["src/dep-a/x.ts"]);
  assert.deepEqual(imports(undefined), ["src/dep-a/x.ts", "src/dep-b/y.ts"], "live sees neither edge");
  const v = integrity.findImportViolationsForNode(g, root, core, "alpha")[0];
  assert.equal(v.change, "alpha");
  assert.deepEqual(v.fix?.args, { source_id: "f-core", target_id: "f-dep-b", edge_type: "depends_on" });
  ok("the per-node import gate judges each revision under its own change only");

  blocked(() => integrity.assertCheckCleanForRevision(g, root, core, "alpha", "in-review"), /revision "alpha".*src\/dep-b\/y\.ts/s);
  ok("assertCheckCleanForRevision Blocks naming the revision and the import its change does not allow");

  // The full check reports an import only when every view the owner claims the file in finds it illegal.
  const all = integrity.findAllImportViolations(g, ownership.buildOwnershipIndex(g, root), root, [
    "src/core/a.ts",
    "src/dep-a/x.ts",
    "src/dep-b/y.ts",
  ]);
  assert.deepEqual(all, [], "each import is legal under the change that adds its edge");
  ok("the full check scans each revision's files under its change");

  assert.deepEqual(rules.nodeChanges(core), ["alpha", "beta"]);
  assert.deepEqual([...rules.changesWithRevisions(g)].sort(), ["alpha", "beta"]);
  const members = rules.changeMembers(g, "alpha");
  assert.deepEqual(ids(members), ["f-core"]);
  assert.equal(members[0].next.change, "alpha");
  assert.deepEqual(members[0].next.depends_on, ["f-dep-a"]);
  ok("changeMembers lists a shipped node under each change it has a revision of, as that change's view");

  rules.validateOpenNext(core, "gamma");
  blocked(() => rules.validateOpenNext(core, "alpha"), /already has an open revision of change "alpha"/);
  blocked(() => rules.validateOpenNext(core), /open revisions "alpha", "beta"/);
  blocked(() => rules.validateOpenNext(node("f-new", "Foundation", { state: "draft", shipped_at: undefined }), "gamma"));
  ok("validateOpenNext allows a second change and Blocks only the same change or an unshipped node");

  blocked(() => rules.resolveStatusChange(g, core, "in-progress"), /pass change/);
  ok("resolveStatusChange on a node with several revisions asks for the change");
}

// --- Infrastructure First at ship reads the revision's own view ---
{
  const body = [
    "## Purpose",
    "",
    "Lets a visitor act.",
    "",
    "## Actor & Trigger",
    "",
    "A visitor clicks.",
    "",
    "## PRD / Execution Logic",
    "",
    "Does the thing.",
    "",
    "## Acceptance Criteria",
    "",
    "It works.",
    "",
    "## Atomic Ops",
    "",
    "- [x] Done",
    "",
  ].join("\n");
  const act = node("x-act", "Interaction", {
    implements: ["src/flow/"],
    belongs_to: ["c-cap"],
    depends_on: ["f-dep-a"],
    open_revisions: [
      revision("alpha", { state: "in-review", edges: { depends_on: { add: ["f-stable"], remove: [] } } }),
      revision("beta", { state: "in-review", edges: { depends_on: { add: ["f-wip"], remove: [] } } }),
    ],
  });
  const g = graphOf([
    act,
    node("c-cap", "Capability", { state: "stable", shipped_at: undefined }),
    node("f-dep-a", "Foundation", { implements: ["src/dep-a/"] }),
    node("f-stable", "Foundation", { implements: ["src/dep-b/"] }),
    node("f-wip", "Foundation", { state: "in-progress", shipped_at: undefined, implements: ["src/own1/"] }),
  ]);
  for (const rev of act.open_revisions) {
    const file = revisionFilePath(act, rev.change);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, formatRevisionFile(act.id, act.type, rev, body), "utf-8");
  }
  const res = rules.resolveRevisionStatusChange(g, act, "alpha", "ship");
  assert.equal(res.ship, true);
  blocked(() => rules.resolveRevisionStatusChange(g, act, "beta", "ship"), /Infrastructure First.*"f-wip"/);
  assert.equal(shape.shapeReport(act, "alpha").sections.every((s) => s.status === "present"), true);
  assert.equal(shape.slotSource(rules.nodeUnder(act, "beta"), "next").file, "revisions/beta/x-act.mdx");
  ok("ship of one revision ignores a non-stable Foundation only another change depends on");

  blocked(() => rules.resolveRevisionStatusChange(g, act, "zeta", "ship"), /no open revision of change "zeta"/);
  ok("resolveRevisionStatusChange Blocks a change the node has no revision of");
}

// --- An Interface revision importing an Interaction it exposes passes only under its own change ---
{
  const page = node("i-page", "Interface", {
    implements: ["src/page/"],
    open_revisions: [revision("gamma", { edges: { exposes: { add: ["x-flow"], remove: [] } } }), revision("delta")],
  });
  const flow = node("x-flow", "Interaction", { implements: ["src/flow/"] });
  const g = graphOf([page, flow]);
  assert.deepEqual(integrity.findImportViolationsForNode(g, root, page, "gamma"), []);
  const delta = integrity.findImportViolationsForNode(g, root, page, "delta");
  assert.equal(delta.length, 1);
  assert.deepEqual(delta[0].fix?.args, { source_id: "i-page", target_id: "x-flow", edge_type: "exposes" });
  const gGamma = rules.revisionGraph(g, "gamma");
  assert.equal(rules.importAllowed(gGamma.nodes.find((n) => n.id === "i-page"), flow, gGamma), true);
  const gDelta = rules.revisionGraph(g, "delta");
  assert.equal(rules.importAllowed(gDelta.nodes.find((n) => n.id === "i-page"), flow, gDelta), false);
  ok("an Interface revision may import an Interaction only under the change that exposes it");
}

// --- Same-change double claim conflicts; different changes are allowed with a warning ---
{
  const claim = (change) => revision(change, { implements: { add: ["src/shared/s.ts"], remove: [] } });
  const sameChange = graphOf([
    node("f-own1", "Foundation", { implements: ["src/own1/"], open_revisions: [claim("alpha")] }),
    node("f-own2", "Foundation", { implements: ["src/own2/"], open_revisions: [claim("alpha")] }),
  ]);
  const own1 = sameChange.nodes[0];
  assert.deepEqual(integrity.findOwnershipConflicts(sameChange, root, own1, "alpha"), [
    'ownership: "src/shared/s.ts" claimed by "f-own1" and "f-own2".',
  ]);
  assert.deepEqual(integrity.findOwnershipConflicts(sameChange, root, own1), [], "live sees no claim on it");
  assert.deepEqual(
    integrity.findAllOwnershipConflicts(sameChange, root).map((c) => [c.file, c.change]),
    [["src/shared/s.ts", "alpha"]]
  );
  assert.deepEqual(integrity.crossChangeClaimWarnings(sameChange, root), []);
  ok("two revisions of the same change claiming one file conflict");

  const crossChange = graphOf([
    node("f-own1", "Foundation", { implements: ["src/own1/"], open_revisions: [claim("alpha")] }),
    node("f-own2", "Foundation", { implements: ["src/own2/"], open_revisions: [claim("beta")] }),
  ]);
  assert.deepEqual(integrity.findOwnershipConflicts(crossChange, root, crossChange.nodes[0], "alpha"), []);
  assert.deepEqual(integrity.findOwnershipConflicts(crossChange, root, crossChange.nodes[1], "beta"), []);
  assert.deepEqual(integrity.findAllOwnershipConflicts(crossChange, root), []);
  const warnings = integrity.crossChangeClaimWarnings(crossChange, root);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"src\/shared\/s\.ts".*"f-own1" \(revision "alpha"\).*"f-own2" \(revision "beta"\)/);
  ok("revisions of different changes may claim one file, with a warning");

  const b = ownership.buildOwnershipIndex(crossChange, root);
  assert.deepEqual(b.revisions.get("src/shared/s.ts"), [
    { id: "f-own1", change: "alpha" },
    { id: "f-own2", change: "beta" },
  ]);
  assert.equal(ownership.ownerUnder(b, "src/shared/s.ts", "alpha"), "f-own1");
  assert.equal(ownership.ownerUnder(b, "src/shared/s.ts", "beta"), "f-own2");
  assert.equal(ownership.ownerUnder(b, "src/shared/s.ts", "other"), null);
  assert.equal(ownership.ownerUnder(b, "src/own1/o.ts", "beta"), "f-own1");
  assert.deepEqual(
    ownership.claimantsOf(b, "src/shared/s.ts"),
    [
      { id: "f-own1", via: "revision", change: "alpha" },
      { id: "f-own2", via: "revision", change: "beta" },
    ],
    "a file only revisions claim is covered"
  );
  ok("ownership buckets index every revision's claims by change");

  const dropping = graphOf([
    node("f-own1", "Foundation", {
      implements: ["src/own1/", "src/shared/s.ts"],
      open_revisions: [revision("alpha", { implements: { add: [], remove: ["src/shared/s.ts"] } })],
    }),
  ]);
  const bd = ownership.buildOwnershipIndex(dropping, root);
  assert.equal(ownership.ownerUnder(bd, "src/shared/s.ts", "alpha"), null);
  assert.equal(ownership.ownerUnder(bd, "src/shared/s.ts", "beta"), "f-own1");
  assert.deepEqual([...ownership.releasedUnder(bd, "alpha").keys()], ["src/shared/s.ts"]);
  ok("a revision that drops a live claim releases it under its change only");

  // Two revisions on one node: one drops a live claim another still needs, one adds a file.
  const twoRevs = node("f-two", "Foundation", {
    implements: ["src/own1/o.ts", "src/own2/o.ts"],
    open_revisions: [
      revision("alpha", { implements: { add: [], remove: ["src/own1/o.ts"] } }),
      revision("beta", { implements: { add: ["src/shared/s.ts"], remove: ["src/own2/o.ts"] } }),
    ],
  });
  const bt = ownership.buildOwnershipIndex(graphOf([twoRevs]), root);
  assert.equal(bt.next.get("src/shared/s.ts"), "f-two", "a file one revision adds is in the next bucket");
  assert.equal(bt.next.get("src/own1/o.ts"), "f-two", "beta still claims what alpha drops");
  assert.equal(bt.live.get("src/own1/o.ts"), "f-two");
  assert.equal(bt.released.has("src/own1/o.ts"), false, "kept by a sibling, so not released");
  assert.equal(ownership.exclusiveOwner(bt, "src/shared/s.ts"), "f-two");
  assert.deepEqual(
    [...ownership.releasedClaimEntries(twoRevs, root)].sort(),
    ["src/own1/o.ts", "src/own2/o.ts"],
    "presence skips a live entry any one revision releases"
  );
  ok("with several revisions, next and released presence read every revision");

  const views = await import("../../../dist/foundations/f-plan-views/views.js");
  const radius = views.buildBlastRadiusPayload(graphOf([twoRevs]), twoRevs);
  const focus = radius.affected_files.find((g) => g.owner_id === "f-two");
  assert.deepEqual(focus?.files, ["src/own1/o.ts", "src/own2/o.ts", "src/shared/s.ts"]);
  ok("the blast radius counts a file one of several revisions adds as the focus's own");
}

// --- A pre-ship member takes over a file its change's revision drops from a shipped node ---
{
  const split = (claimsKept) =>
    graphOf([
      node("f-a", "Foundation", {
        implements: ["src/own1/", "src/shared/s.ts"],
        open_revisions: [revision("y", { implements: { add: [], remove: claimsKept ? [] : ["src/shared/s.ts"] } })],
      }),
      { ...node("f-b", "Foundation", { implements: ["src/shared/s.ts"], change: "y" }), state: "in-progress", shipped_at: undefined },
    ]);
  const g = split(false);
  assert.deepEqual(integrity.findAllOwnershipConflicts(g, root), [], "the check judges the member under its change");
  assert.deepEqual(integrity.findOwnershipConflicts(g, root, g.nodes[1]), [], "the member's gate too");
  assert.deepEqual(integrity.changeMemberViolations(g, root, [g.nodes[1]], "y").get("f-b").ownership, []);
  const kept = split(true);
  assert.deepEqual(
    integrity.findAllOwnershipConflicts(kept, root).map((c) => [c.file, c.a, c.b, c.change]),
    [["src/shared/s.ts", "f-a", "f-b", "y"]],
    "a file the shipped node still keeps is a double claim"
  );
  assert.deepEqual(integrity.findOwnershipConflicts(kept, root, kept.nodes[1]), [
    'ownership: "src/shared/s.ts" claimed by "f-b" and "f-a".',
  ]);
  ok("a new member of a change may claim a file that change's revision drops from a shipped node");
}

// --- A pre-ship node of no change and a pre-ship member of A on one file conflict under A ---
{
  const preShip = (id, extra) => ({ ...node(id, "Foundation", extra), state: "in-progress", shipped_at: undefined });
  const g = graphOf([
    preShip("f-p", { implements: ["src/shared/s.ts"] }),
    preShip("f-x", { implements: ["src/shared/s.ts"], change: "a" }),
  ]);
  assert.deepEqual(
    integrity.findAllOwnershipConflicts(g, root).map((c) => [c.file, c.a, c.b, c.change]),
    [["src/shared/s.ts", "f-p", "f-x", "a"]],
    "the check reports the pair under the member's change"
  );
  // f-p's own view is live, where f-x's claim is pending under "a": f-p's gates pass, and the
  // pair is f-x's to clear under its change.
  assert.deepEqual(integrity.findOwnershipConflicts(g, root, g.nodes[0]), []);
  assert.deepEqual(integrity.findOwnershipConflicts(g, root, g.nodes[1]), ['ownership: "src/shared/s.ts" claimed by "f-x" and "f-p".']);
  integrity.assertCheckCleanForNode(g, root, g.nodes[0], "in-review");
  integrity.assertCheckCleanForNode(g, root, g.nodes[0], "ship");
  blocked(() => integrity.assertCheckCleanForNode(g, root, g.nodes[1], "in-review"), /claimed by "f-x" and "f-p"/);
  assert.deepEqual(integrity.changeMemberViolations(g, root, [g.nodes[1]], "a").get("f-x").ownership, [
    'ownership: "src/shared/s.ts" claimed by "f-x" and "f-p".',
  ]);
  // f-p shipped first: f-x's ship meets f-p's live claim, reported once (its own view has the pair).
  const pFirst = graphOf([node("f-p", "Foundation", { implements: ["src/shared/s.ts"] }), g.nodes[1]]);
  blocked(
    () => integrity.assertCheckCleanForNode(pFirst, root, pFirst.nodes[1], "ship"),
    /\(1 violation\(s\)\):\n- ownership: "src\/shared\/s\.ts" claimed by "f-x" and "f-p"\.$/
  );
  // f-x shipped first (its change left with the ship): f-p's in-review gate meets f-x's live claim.
  const xFirst = graphOf([g.nodes[0], node("f-x", "Foundation", { implements: ["src/shared/s.ts"] })]);
  blocked(() => integrity.assertCheckCleanForNode(xFirst, root, xFirst.nodes[0], "in-review"), /claimed by "f-p" and "f-x"/);
  ok("a pre-ship node of no change and a member of a change on one file: the member's gate Blocks; the second to ship meets the first's live claim");
}

// --- A no-change node is judged live: another change's draft claim on its file does not Block it ---
{
  const g = graphOf([
    { ...node("f-n", "Foundation", { implements: ["src/shared/s.ts"] }), state: "in-progress", shipped_at: undefined },
    node("f-m", "Foundation", {
      implements: ["src/own1/"],
      open_revisions: [revision("x", { implements: { add: ["src/shared/s.ts"], remove: [] } })],
    }),
  ]);
  assert.deepEqual(
    integrity.findAllOwnershipConflicts(g, root).map((c) => [c.file, c.a, c.b, c.change]),
    [["src/shared/s.ts", "f-n", "f-m", "x"]],
    "the check still reports the pending pair under x"
  );
  assert.deepEqual(integrity.findOwnershipConflicts(g, root, g.nodes[0]), []);
  integrity.assertCheckCleanForNode(g, root, g.nodes[0], "in-review");
  integrity.assertCheckCleanForNode(g, root, g.nodes[0], "ship");
  blocked(() => integrity.assertCheckCleanForRevision(g, root, g.nodes[1], "x", "in-review"), /claimed by "f-m" and "f-n"/);
  ok("a no-change node's gate reads live only; the revision adding its file is Blocked in its own view");
}

// --- A takeover ships only after the revision that drops the file: the ship gate reads live claims ---
{
  const dropping = node("f-n", "Foundation", {
    implements: ["src/own1/", "src/shared/s.ts"],
    open_revisions: [revision("x", { implements: { add: [], remove: ["src/shared/s.ts"] } })],
  });
  const member = { ...node("f-p", "Foundation", { implements: ["src/shared/s.ts"], change: "x" }), state: "in-review", shipped_at: undefined };
  const g = graphOf([dropping, member]);
  integrity.assertCheckCleanForNode(g, root, g.nodes[1], "in-review");
  blocked(
    () => integrity.assertCheckCleanForNode(g, root, g.nodes[1], "ship"),
    /"src\/shared\/s\.ts" claimed by "f-p" and "f-n", which claims it live; "f-n" revision "x" drops it: ship change "x" in one walk .*, or ship that revision first\.$/
  );
  // N's revision shipped: live no longer claims the file, so P ships.
  const after = graphOf([node("f-n", "Foundation", { implements: ["src/own1/"] }), member]);
  integrity.assertCheckCleanForNode(after, root, after.nodes[1], "ship");
  // A revision taking the file over meets the same gate.
  const taker = node("f-t", "Foundation", {
    implements: ["src/own2/"],
    open_revisions: [revision("x", { implements: { add: ["src/shared/s.ts"], remove: [] } })],
  });
  const revs = graphOf([dropping, taker]);
  integrity.assertCheckCleanForRevision(revs, root, revs.nodes[1], "x", "in-review");
  blocked(() => integrity.assertCheckCleanForRevision(revs, root, revs.nodes[1], "x", "ship"), /"f-n" revision "x" drops it/);
  // Another node's live claim with no such revision: the plain message.
  const other = graphOf([node("f-n", "Foundation", { implements: ["src/shared/s.ts"] }), member]);
  blocked(() => integrity.assertCheckCleanForNode(other, root, other.nodes[1], "ship"), /claimed by "f-p" and "f-n"/);
  ok("a node may not ship onto a file another node claims live; the message names the revision that drops it");
}

// --- Inside a walk, the ship gate judges the nodes the walk ships by their claims after the walk ---
{
  write("src/shared/t.ts", "export const t = 1;\n");
  const F = "src/shared/s.ts";
  const G = "src/shared/t.ts";
  // A file moving from f-i to f-t in change x (f-i depends_on f-t, so f-t walks first).
  const from = node("f-i", "Foundation", {
    implements: ["src/own1/", F],
    depends_on: ["f-t"],
    open_revisions: [revision("x", { state: "in-review", implements: { add: [], remove: [F] } })],
  });
  const to = node("f-t", "Foundation", {
    implements: ["src/own2/"],
    open_revisions: [revision("x", { state: "in-review", implements: { add: [F], remove: [] } })],
  });
  const g = graphOf([from, to]);
  // Shipped alone, f-t meets f-i's live claim, and the Block points at the change walk first.
  blocked(
    () => integrity.assertCheckCleanForRevision(g, root, g.nodes[1], "x", "ship"),
    /claimed by "f-t" and "f-i", which claims it live; "f-i" revision "x" drops it: ship change "x" in one walk/
  );
  // In a walk that also ships f-i's revision, f-i is judged by its claims after the walk.
  const walk = new Map([["f-i", ["src/own1/"]], ["f-t", ["src/own2/", F]]]);
  integrity.assertCheckCleanForRevision(g, root, g.nodes[1], "x", "ship", walk);
  // A walk that leaves f-i claiming the file is a real double claim at its end: Blocked naming f-i.
  const keeps = new Map([["f-i", ["src/own1/", F]], ["f-t", ["src/own2/", F]]]);
  blocked(() => integrity.assertCheckCleanForRevision(g, root, g.nodes[1], "x", "ship", keeps), /claimed by "f-t" and "f-i"/);
  // A node the walk does not ship keeps its live claim.
  blocked(
    () => integrity.assertCheckCleanForRevision(g, root, g.nodes[1], "x", "ship", new Map([["f-t", ["src/own2/", F]]])),
    /claimed by "f-t" and "f-i", which claims it live/
  );
  // Two revisions of one change swapping files: each ships in the walk, in either order.
  const a = node("f-a", "Foundation", {
    implements: [F],
    open_revisions: [revision("sw", { state: "in-review", implements: { add: [G], remove: [F] } })],
  });
  const b = node("f-b", "Foundation", {
    implements: [G],
    open_revisions: [revision("sw", { state: "in-review", implements: { add: [F], remove: [G] } })],
  });
  const sw = graphOf([a, b]);
  blocked(() => integrity.assertCheckCleanForRevision(sw, root, sw.nodes[0], "sw", "ship"), /claimed by "f-a" and "f-b"/);
  blocked(() => integrity.assertCheckCleanForRevision(sw, root, sw.nodes[1], "sw", "ship"), /claimed by "f-b" and "f-a"/);
  const swap = new Map([["f-a", [G]], ["f-b", [F]]]);
  integrity.assertCheckCleanForRevision(sw, root, sw.nodes[0], "sw", "ship", swap);
  integrity.assertCheckCleanForRevision(sw, root, sw.nodes[1], "sw", "ship", swap);
  ok("in a walk the ship gate reads the claims every shipping node holds after the walk; a real double claim still Blocks");
}

// --- A revision of B and a pre-ship member of A on one file: a cross-change warning, not a Block ---
{
  const g = graphOf([
    node("f-s", "Foundation", {
      implements: ["src/own1/"],
      open_revisions: [revision("b", { implements: { add: ["src/shared/s.ts"], remove: [] } })],
    }),
    { ...node("f-x", "Foundation", { implements: ["src/shared/s.ts"], change: "a" }), state: "in-progress", shipped_at: undefined },
  ]);
  assert.deepEqual(integrity.findAllOwnershipConflicts(g, root), []);
  assert.deepEqual(integrity.findOwnershipConflicts(g, root, g.nodes[0], "b"), []);
  assert.deepEqual(integrity.findOwnershipConflicts(g, root, g.nodes[1]), []);
  assert.deepEqual(integrity.changeMemberViolations(g, root, [g.nodes[0]], "b").get("f-s").ownership, []);
  assert.deepEqual(integrity.crossChangeClaimWarnings(g, root), [
    'ownership: "src/shared/s.ts" is claimed by "f-s" (revision "b") and "f-x" (change "a"). ' +
      "Allowed while the changes are separate; whichever ships second must drop the claim or take it over.",
  ]);
  ok("a revision of one change and a pre-ship member of another on one file only warn");
}

// --- One pair conflicting on one file under two changes is reported under each ---
{
  const claim = (change) => revision(change, { implements: { add: ["src/shared/s.ts"], remove: [] } });
  const g = graphOf([
    node("f-own1", "Foundation", { implements: ["src/own1/"], open_revisions: [claim("alpha"), claim("beta")] }),
    node("f-own2", "Foundation", { implements: ["src/own2/"], open_revisions: [claim("alpha"), claim("beta")] }),
  ]);
  assert.deepEqual(
    integrity.findAllOwnershipConflicts(g, root).map((c) => [c.file, c.change]),
    [["src/shared/s.ts", "alpha"], ["src/shared/s.ts", "beta"]]
  );
  ok("the same pair on one file under two changes is reported once per change");
}

// --- A pre-ship member of C is judged seeing C's revisions on shipped co-members ---
{
  write("src/newi/n.ts", `import { x } from "../dep-a/x";\nexport const n = x;\n`);
  const core = node("f-core", "Foundation", {
    implements: ["src/core/"],
    open_revisions: [revision("gamma", { edges: { depends_on: { add: ["f-dep-a"], remove: [] } } })],
  });
  const fresh = (change) => ({
    ...node("i-new", "Interaction", { implements: ["src/newi/"], depends_on: ["f-core"], change }),
    state: "draft",
    shipped_at: undefined,
  });
  const graphFor = (iNew) =>
    graphOf([core, node("f-dep-a", "Foundation", { implements: ["src/dep-a/"] }), node("f-dep-b", "Foundation", { implements: ["src/dep-b/"] }), iNew]);
  const member = fresh("gamma");
  assert.deepEqual(integrity.findImportViolationsForNode(graphFor(member), root, member), []);
  const all = integrity
    .findAllImportViolations(graphFor(member), ownership.buildOwnershipIndex(graphFor(member), root), root, ["src/newi/n.ts"])
    .filter((v) => !v.advisory);
  assert.deepEqual(all, [], "the check judges the member under its change too");
  const outsider = fresh("other");
  assert.deepEqual(
    integrity.findImportViolationsForNode(graphFor(outsider), root, outsider).map((v) => v.imports),
    ["src/dep-a/x.ts"],
    "a node of another change does not see gamma's edge"
  );
  fs.rmSync(path.join(root, "src", "newi"), { recursive: true, force: true });
  ok("a pre-ship member of a change sees that change's revisions of shipped co-members");
}

// --- Rebase conflicts Block in-review ---
{
  const n = node("f-conf", "Foundation", {
    implements: ["src/own1/"],
    open_revisions: [revision("alpha", { state: "in-progress", conflicts: [{ kind: "section", section: "## Spec" }] })],
  });
  const g = graphOf([n]);
  blocked(
    () => rules.resolveRevisionStatusChange(g, n, "alpha", "in-review"),
    /"f-conf" revision "alpha" has 1 unresolved rebase conflict\(s\): section "## Spec"\. Resolve each with resolve_conflict\(\{ node_id, change, \.\.\. \}\)\./
  );
  blocked(() => integrity.assertCheckCleanForRevision(g, root, n, "alpha", "in-review"), /resolve_conflict/);
  ok("a revision with rebase conflicts is Blocked at in-review naming resolve_conflict");
}

// --- Planned edges: a node with a revision of C applies none of C's planned entries ---
{
  const src = node("f-plan", "Foundation", {
    implements: ["src/own1/"],
    planned: [
      { change: "alpha", type: "depends_on", target: "f-t" },
      { change: "omega", type: "depends_on", target: "f-t" },
    ],
    open_revisions: [revision("alpha")],
  });
  const g = graphOf([src, node("f-t", "Foundation", { implements: ["src/own2/"] })]);
  assert.deepEqual(planned.plannedEdges(g, "alpha"), []);
  assert.deepEqual(planned.plannedEdges(g, "omega").map((r) => r.source), ["f-plan"]);
  const m = planned.changeMembership(g, "omega");
  assert.deepEqual([m.revisions.map((x) => x.id), m.planned.map((x) => x.id)], [[], ["f-plan"]]);
  const ma = planned.changeMembership(g, "alpha");
  assert.deepEqual([ma.revisions.map((x) => x.id), ma.planned.map((x) => x.id)], [["f-plan"], []]);
  ok("planned sources are shipped nodes with entries for C and no revision of C");
}

// --- The untested hint names the revision's change: set_test_files without change writes live ---
{
  const n = node("f-untested", "Foundation", {
    implements: ["src/own1/"],
    open_revisions: [revision("alpha", { state: "in-review" }), revision("beta")],
  });
  const hint = 'set_test_files({ node_id: "f-untested", change: "alpha", add: [...] })';
  assert.ok(integrity.untestedWarning(n)?.includes(hint), integrity.untestedWarning(n));
  assert.ok(integrity.untestedWarning(rules.nodeUnder(n, "alpha"))?.includes(hint));
  const preShip = node("f-untested-new", "Foundation", { state: "in-review", shipped_at: undefined, change: "alpha" });
  assert.equal(
    integrity.untestedWarning(preShip),
    'tests: "f-untested-new" is in review with no linked tests; link the files that verify it with set_test_files.'
  );
  ok("an untested revision in review gets a set_test_files hint naming its change");
}

fs.rmSync(root, { recursive: true, force: true });
console.log("multi-revision-gates.test.mjs: all ok");

// --- deprecated retires a shipped node with every open revision, one or several ---
{
  for (const changes of [["solo"], ["first", "second"]]) {
    const n = node("f-retire", "Foundation", { open_revisions: changes.map((c) => revision(c)) });
    const g = graphOf([n]);
    const out = rules.resolveStatusChange(g, rules.liveGraph(g).nodes.find((x) => x.id === "f-retire") ?? n, "deprecated");
    assert.equal(out.state, "deprecated", `${changes.length} revision(s)`);
  }
  const two = node("f-retire", "Foundation", { open_revisions: [revision("first"), revision("second")] });
  blocked(() => rules.resolveStatusChange(graphOf([two]), two, "cancelled"), /cancelled/);
  ok("deprecated passes the gate with one or several open revisions; cancelled on a shipped node still Blocks");
}
