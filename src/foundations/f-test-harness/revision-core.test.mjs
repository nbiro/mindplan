/**
 * Revision model coverage (npm test), no server: edge/claim/test deltas round-trip against live;
 * withRevision fills the `next` view from live plus one revision; graphUnder shows one change's
 * revisions and hides every other change's; resolveRevisionChange picks the revision a call means;
 * section hashes ignore line endings and the owned sections; the rebase matrix (untouched, live
 * only, revision only, both, both identical, sections added or deleted, scalars, dropped deltas,
 * claim conflicts) and the base move; and decision files round-trip.
 */
import assert from "node:assert/strict";
import {
  applyDelta,
  diffDelta,
  emptyDelta,
  fencedLines,
  graphUnder,
  levelTwoHeadings,
  openChanges,
  rebase,
  resolveRevisionChange,
  revisionFor,
  scalarHashes,
  sectionHashes,
  splitSections,
  withRevision,
} from "../../../dist/foundations/f-revision-model/index.js";
import { formatDecisionFile, parseDecisionFile } from "../../../dist/foundations/f-territory-store/decisions-store.js";

const ok = (label) => console.log(`ok   ${label}`);

// --- deltas -------------------------------------------------------------------------------------

{
  const live = ["c", "a", "b"];
  const snapshot = ["b", "d", "a"];
  const delta = diffDelta(live, snapshot);
  assert.deepEqual(delta, { add: ["d"], remove: ["c"] });
  assert.deepEqual(applyDelta(live, delta), ["a", "b", "d"]);
  assert.deepEqual(applyDelta(undefined, { add: ["x", "x"], remove: [] }), ["x"]);
  assert.deepEqual(applyDelta(["b", "a", "a"], undefined), ["a", "b"]);
  assert.deepEqual(emptyDelta(), { add: [], remove: [] });
  assert.deepEqual(diffDelta(undefined, undefined), { add: [], remove: [] });
  ok("deltas: diffDelta then applyDelta gives the snapshot, sorted and deduped");
}

// --- fixtures -----------------------------------------------------------------------------------

function revision(change, over = {}) {
  return {
    change,
    state: "draft",
    opened_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T01:00:00.000Z",
    title: "Store v2",
    description: "Infra — the store, revised.",
    edges: {},
    implements: emptyDelta(),
    tests: emptyDelta(),
    base: { scalars: {}, sections: {} },
    conflicts: [],
    ...over,
  };
}

const store = {
  id: "f-store",
  type: "Foundation",
  title: "Store",
  description: "Infra — the store.",
  state: "stable",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  shipped_at: "2026-01-02T00:00:00.000Z",
  role: "infra",
  depends_on: ["f-base", "f-old"],
  mounts: ["if-web"],
  implements: ["src/store/"],
  tests: ["test/store.mjs"],
  decisions: [{ id: "d-live", decision: "Live.", alternatives: [], why: "Because." }],
  open_revisions: [
    revision("feat-a", {
      change_ref: "feat/a",
      role: "adapter",
      edges: { depends_on: { add: ["f-new"], remove: ["f-old"] } },
      implements: { add: ["src/store-v2/"], remove: [] },
      tests: { add: ["test/store-v2.mjs"], remove: ["test/store.mjs"] },
      attributed: ["src/migrations/001.sql"],
      split_into: ["f-part"],
      decisions: [{ id: "d-rev", decision: "Rev.", alternatives: ["Other"], why: "Why." }],
    }),
    revision("feat-b", { title: "Store B", edges: { depends_on: { add: ["f-b"], remove: [] } } }),
  ],
};

const page = {
  id: "i-page",
  type: "Interaction",
  title: "Page",
  description: "User opens a page.",
  state: "stable",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  shipped_at: "2026-01-02T00:00:00.000Z",
  belongs_to: ["c-site"],
  depends_on: ["f-store"],
  open_revisions: [revision("feat-b", { title: "Page B", edges: { leads_to: { add: ["i-next"], remove: [] } } })],
};

const plain = {
  id: "f-base",
  type: "Foundation",
  title: "Base",
  description: "Infra — base.",
  state: "stable",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  shipped_at: "2026-01-02T00:00:00.000Z",
};

// --- openChanges / revisionFor / resolveRevisionChange -------------------------------------------

{
  assert.deepEqual(openChanges(store), ["feat-a", "feat-b"]);
  assert.deepEqual(openChanges(plain), []);
  assert.equal(revisionFor(store, "feat-b").title, "Store B");
  assert.equal(revisionFor(store, "nope"), undefined);

  assert.equal(resolveRevisionChange(plain), null);
  assert.equal(resolveRevisionChange(page), "feat-b");
  assert.equal(resolveRevisionChange(page, "feat-b"), "feat-b");
  assert.equal(resolveRevisionChange(store, "feat-a"), "feat-a");
  assert.throws(
    () => resolveRevisionChange(store),
    (e) => e.message === 'Blocked: "f-store" has open revisions "feat-a", "feat-b"; pass change.'
  );
  assert.throws(
    () => resolveRevisionChange(store, "feat-c"),
    (e) => e.message.startsWith("Blocked:") && e.message.includes('"feat-c"') && e.message.includes('"feat-a", "feat-b"')
  );
  assert.throws(() => resolveRevisionChange(plain, "feat-a"), (e) => e.message.startsWith("Blocked:"));
  ok("resolveRevisionChange: none is live, one is it, several or an unknown change Block naming them");
}

// --- withRevision -------------------------------------------------------------------------------

{
  const before = JSON.stringify(store);
  const view = withRevision(store, "feat-a");
  assert.equal(JSON.stringify(store), before, "withRevision never mutates its input");
  assert.notEqual(view, store);
  assert.deepEqual(view.depends_on, ["f-base", "f-old"], "live fields stay live");
  assert.equal(view.title, "Store");
  const next = view.next;
  assert.equal(next.state, "draft");
  assert.equal(next.title, "Store v2");
  assert.equal(next.description, "Infra — the store, revised.");
  assert.equal(next.updated_at, "2026-11-01T01:00:00.000Z");
  assert.equal(next.opened_at, "2026-11-01T00:00:00.000Z");
  assert.equal(next.role, "adapter");
  assert.equal(next.change, "feat-a");
  assert.equal(next.change_ref, "feat/a");
  assert.deepEqual(next.depends_on, ["f-base", "f-new"]);
  assert.deepEqual(next.mounts, ["if-web"], "an edge type without a delta carries live");
  assert.deepEqual(next.belongs_to, []);
  assert.deepEqual(next.implements, ["src/store-v2/", "src/store/"]);
  assert.deepEqual(next.attributed, ["src/migrations/001.sql"]);
  assert.deepEqual(next.split_into, ["f-part"]);
  assert.deepEqual(next.decisions.map((d) => d.id), ["d-live", "d-rev"]);
  assert.deepEqual(view.tests, ["test/store-v2.mjs"]);
  assert.equal(view.open_revisions, store.open_revisions);
  assert.equal(withRevision(store, "feat-z"), store, "no revision of the change: the node itself");
  const noRole = withRevision(page, "feat-b");
  assert.equal(noRole.next.role, undefined);
  assert.deepEqual(noRole.next.leads_to, ["i-next"]);
  ok("withRevision: next is live plus that revision; tests apply its delta; input untouched");
}

// --- graphUnder ---------------------------------------------------------------------------------

{
  const graph = {
    version: 1,
    nodes: [plain, page, store],
    edges: [
      { source: "f-store", target: "f-base", type: "depends_on" },
      { source: "f-store", target: "f-old", type: "depends_on" },
      { source: "f-store", target: "if-web", type: "mounts" },
      { source: "i-page", target: "c-site", type: "belongs_to" },
      { source: "i-page", target: "f-store", type: "depends_on" },
    ],
  };
  const under = graphUnder(graph, "feat-a");
  const s = under.nodes.find((n) => n.id === "f-store");
  const p = under.nodes.find((n) => n.id === "i-page");
  assert.equal(s.next.change, "feat-a");
  assert.equal(p, page, "a node with no revision of the change stays live");
  assert.equal(p.next, undefined, "change B's revision on another node is invisible");
  assert.equal(under.nodes.find((n) => n.id === "f-base"), plain);
  const keys = under.edges.map((e) => `${e.source}:${e.type}:${e.target}`);
  assert.ok(keys.includes("f-store:depends_on:f-new"));
  assert.ok(!keys.includes("f-store:depends_on:f-old"));
  assert.ok(keys.includes("f-store:mounts:if-web"));
  assert.ok(!keys.includes("i-page:leads_to:i-next"), "change B's edges are invisible");
  assert.ok(keys.includes("i-page:depends_on:f-store"));
  assert.deepEqual(keys, [...keys].sort((a, b) => a.localeCompare(b)), "edges sorted like the loader");
  assert.equal(graph.edges.length, 5, "graphUnder never mutates its input");
  const underB = graphUnder(graph, "feat-b");
  const keysB = underB.edges.map((e) => `${e.source}:${e.type}:${e.target}`);
  assert.ok(keysB.includes("i-page:leads_to:i-next"));
  assert.ok(keysB.includes("f-store:depends_on:f-b") && keysB.includes("f-store:depends_on:f-old"));
  ok("graphUnder: one change's revisions are visible with their edges, every other change's are not");
}

// --- sections and hashes ------------------------------------------------------------------------

const BODY = [
  "# Store",
  "",
  "Intro.",
  "",
  "## Purpose",
  "",
  "Keep things.",
  "",
  "```md",
  "## Not a heading",
  "```",
  "",
  "## Spec",
  "",
  "- one",
  "",
  "## Decisions",
  "",
  "### d-x",
  "",
  "## Rules",
  "",
  "- Be nice.",
  "",
].join("\n");

{
  const sections = splitSections(BODY);
  assert.deepEqual(
    sections.map((s) => s.heading),
    ["_preamble", "## Purpose", "## Spec", "## Decisions", "## Rules"]
  );
  assert.ok(sections[1].text.includes("## Not a heading"), "a heading inside a fence is code");
  assert.equal(sections.map((s) => s.text).join(""), BODY, "sections concatenate back to the body");
  const lf = sectionHashes(BODY);
  const crlf = sectionHashes(BODY.replace(/\n/g, "\r\n"));
  assert.deepEqual(lf, crlf);
  assert.deepEqual(Object.keys(lf), ["_preamble", "## Purpose", "## Spec"]);
  assert.ok(Object.values(lf).every((h) => /^[0-9a-f]{8}$/.test(h)));
  const sh = scalarHashes({ title: "T", description: "D" });
  assert.deepEqual(Object.keys(sh).sort(), ["description", "role", "title"]);
  assert.notEqual(scalarHashes({ title: "T", description: "D", role: "infra" }).role, sh.role);
  ok("sections: level-2 split with a preamble; hashes ignore line endings and skip Rules/Decisions");
}

// --- rebase -------------------------------------------------------------------------------------

function body(sections) {
  return sections.map(([h, t]) => (h === "_preamble" ? `${t}\n\n` : `${h}\n\n${t}\n\n`)).join("");
}

{
  const scalars = { title: "Store", description: "Infra — the store.", role: "infra" };
  const liveOldBody = body([
    ["_preamble", "# Store"],
    ["## Untouched", "u0"],
    ["## LiveOnly", "l0"],
    ["## RevOnly", "r0"],
    ["## Both", "b0"],
    ["## Same", "s0"],
    ["## Gone", "g0"],
    ["## GoneButEdited", "ge0"],
  ]);
  const liveNewBody = body([
    ["_preamble", "# Store"],
    ["## Untouched", "u0"],
    ["## LiveOnly", "l1"],
    ["## RevOnly", "r0"],
    ["## Both", "b-live"],
    ["## Same", "s-same"],
    ["## Added", "a1"],
  ]);
  const revisionBody = body([
    ["_preamble", "# Store"],
    ["## Untouched", "u0"],
    ["## LiveOnly", "l0"],
    ["## RevOnly", "r-rev"],
    ["## Both", "b-rev"],
    ["## Same", "s-same"],
    ["## Gone", "g0"],
    ["## GoneButEdited", "ge-rev"],
    ["## Rules", "- keep me"],
  ]);
  const rev = revision("feat-a", {
    title: "Store v2",
    description: "Infra — the store.",
    role: "adapter",
    edges: {
      depends_on: { add: ["f-new", "f-already"], remove: ["f-old", "f-vanished"] },
    },
    implements: { add: ["src/mine/", "src/taken/"], remove: [] },
    tests: { add: ["t/new.mjs"], remove: ["t/gone.mjs"] },
    base: { scalars: scalarHashes(scalars), sections: sectionHashes(liveOldBody) },
  });
  const liveNewScalars = { title: "Store renamed", description: "Infra — the store, now faster.", role: "infra" };
  const before = JSON.stringify(rev);
  const out = rebase({
    liveOld: { scalars, body: liveOldBody },
    liveNew: {
      scalars: liveNewScalars,
      body: liveNewBody,
      edges: { depends_on: ["f-already", "f-base", "f-old"] },
      implements: ["src/store/"],
      tests: ["t/old.mjs"],
      implementsOwners: new Map([["src/taken/", "f-other"]]),
    },
    revision: rev,
    revisionBody,
    nodeId: "f-store",
  });
  assert.equal(JSON.stringify(rev), before, "rebase never mutates its input");
  const got = Object.fromEntries(splitSections(out.body).map((s) => [s.heading, s.text.trim()]));
  assert.equal(got["## Untouched"], "## Untouched\n\nu0", "untouched: takes live");
  assert.equal(got["## LiveOnly"], "## LiveOnly\n\nl1", "live only: takes live");
  assert.equal(got["## RevOnly"], "## RevOnly\n\nr-rev", "revision only: keeps the revision");
  assert.equal(got["## Both"], "## Both\n\nb-rev", "both: keeps the revision's text");
  assert.equal(got["## Same"], "## Same\n\ns-same", "both identical: kept");
  assert.equal(got["## Added"], "## Added\n\na1", "added in live: appended");
  assert.equal(got["## Gone"], undefined, "deleted in live and untouched: dropped");
  assert.equal(got["## GoneButEdited"], "## GoneButEdited\n\nge-rev", "deleted in live but edited: kept");
  assert.equal(got["## Rules"], "## Rules\n\n- keep me", "Rules passes through");
  const order = splitSections(out.body).map((s) => s.heading);
  assert.deepEqual(order, [
    "_preamble",
    "## Untouched",
    "## LiveOnly",
    "## RevOnly",
    "## Both",
    "## Same",
    "## GoneButEdited",
    "## Added",
    "## Rules",
  ]);

  const r = out.revision;
  // Scalars: title both edited → conflict, keeps the revision; description live only → live;
  // role revision only → kept.
  assert.equal(r.title, "Store v2");
  assert.equal(r.description, "Infra — the store, now faster.");
  assert.equal(r.role, "adapter");
  const conflicts = r.conflicts.map((c) => JSON.stringify(c)).sort();
  assert.deepEqual(conflicts, [
    JSON.stringify({ kind: "claim", path: "src/taken/", owner: "f-other" }),
    JSON.stringify({ kind: "scalar", field: "title" }),
    JSON.stringify({ kind: "section", section: "## Both" }),
    JSON.stringify({ kind: "section", section: "## GoneButEdited" }),
  ].sort());
  assert.deepEqual(r.edges.depends_on, { add: ["f-new"], remove: ["f-old"] }, "dropped: add already live, remove no longer live");
  assert.deepEqual(r.implements, { add: ["src/mine/", "src/taken/"], remove: [] });
  assert.deepEqual(r.tests, { add: ["t/new.mjs"], remove: [] });
  assert.deepEqual(r.base.sections, sectionHashes(liveNewBody), "base sections move to new live");
  assert.deepEqual(r.base.scalars, scalarHashes(liveNewScalars), "base scalars move to new live");
  ok("rebase: the section/scalar matrix, dropped deltas, claim conflicts, and the base move");

  // A second rebase onto the same live is a no-op: nothing new is touched by live.
  const again = rebase({
    liveOld: { scalars: liveNewScalars, body: liveNewBody },
    liveNew: { scalars: liveNewScalars, body: liveNewBody, edges: { depends_on: ["f-already", "f-base", "f-old"] } },
    revision: { ...r, conflicts: [] },
    revisionBody: out.body,
    nodeId: "f-store",
  });
  assert.equal(again.body, out.body);
  assert.deepEqual(again.revision.conflicts, []);
  ok("rebase: rebasing onto an unchanged live changes nothing");

  // A kept conflict is settled once new live reads the revision's text.
  const caughtUpBody = body([
    ["_preamble", "# Store"],
    ["## Untouched", "u0"],
    ["## LiveOnly", "l1"],
    ["## RevOnly", "r0"],
    ["## Both", "b-rev"],
    ["## Same", "s-same"],
    ["## GoneButEdited", "ge-other"],
    ["## Added", "a1"],
  ]);
  const caughtUpScalars = { ...liveNewScalars, title: "Store v2" };
  const settled = rebase({
    liveOld: { scalars: liveNewScalars, body: liveNewBody },
    liveNew: { scalars: caughtUpScalars, body: caughtUpBody, edges: { depends_on: ["f-already", "f-base", "f-old"] } },
    revision: r,
    revisionBody: out.body,
    nodeId: "f-store",
  });
  assert.deepEqual(
    settled.revision.conflicts.map((c) => JSON.stringify(c)).sort(),
    [
      JSON.stringify({ kind: "claim", path: "src/taken/", owner: "f-other" }),
      JSON.stringify({ kind: "section", section: "## GoneButEdited" }),
    ].sort(),
    "the title and ## Both conflicts settle; ## GoneButEdited still differs"
  );
  ok("rebase: a kept section or scalar conflict drops when new live now reads the revision's text");
}

{
  // Only new live has a preamble: it goes first, never with the sections live added at the end.
  const scalars = { title: "Store", description: "Infra — the store.", role: "infra" };
  const liveOldBody = body([["## Spec", "s0"]]);
  const liveNewBody = body([["_preamble", "Intro from live."], ["## Spec", "s0"]]);
  const revisionBody = body([["## Spec", "s-rev"], ["## Rules", "- keep me"]]);
  const out = rebase({
    liveOld: { scalars, body: liveOldBody },
    liveNew: { scalars, body: liveNewBody },
    revision: revision("feat-p", {
      description: "Infra — the store.",
      base: { scalars: scalarHashes(scalars), sections: sectionHashes(liveOldBody) },
    }),
    revisionBody,
    nodeId: "f-store",
  });
  assert.deepEqual(splitSections(out.body).map((s) => s.heading), ["_preamble", "## Spec", "## Rules"]);
  assert.ok(out.body.startsWith("Intro from live."), out.body);
  ok("rebase: a preamble only new live has goes at the top of the body");
}

// --- fenced code --------------------------------------------------------------------------------

{
  // A ```` fence holds a ``` line as code; only a fence of the same char, at least as long and
  // with no info string, closes it.
  const lines = ["````md", "```", "## Not a heading", "```js", "````", "## Real", "~~~~", "~~~ x", "## Hidden", "~~~~~", "## After"];
  assert.deepEqual(fencedLines(lines), [true, true, true, true, true, false, true, true, true, true, false]);
  assert.deepEqual(levelTwoHeadings(lines).map((h) => h.name), ["Real", "After"]);
  assert.deepEqual(
    splitSections("Intro\n````\n```\n## Inside\n```\n````\n## Out\nx\n").map((s) => s.heading),
    ["_preamble", "## Out"],
  );
  ok("fenced code: a fence closes only on the same char, at least as long, with no info string");
}

// --- decision files -----------------------------------------------------------------------------

{
  const record = {
    id: "d-files",
    decision: "One file per decision.",
    alternatives: ["Keep the section", "A JSON list"],
    why: "Merges cleanly.",
    consequences: "More files.",
    supersedes: "d-old",
    change: "multi-revisions",
    date: "2026-11-02",
    keep_whole: true,
    nodes: ["f-store", "i-page"],
  };
  const text = formatDecisionFile(record);
  assert.deepEqual(parseDecisionFile(text), record);
  assert.deepEqual(parseDecisionFile(text.replace(/\n/g, "\r\n")), record);
  const minimal = { id: "d-min", decision: "Min.", alternatives: [], why: "Short." };
  assert.deepEqual(parseDecisionFile(formatDecisionFile(minimal)), minimal);
  assert.equal(parseDecisionFile("no entry here"), null);
  ok("decision files: format and parse round-trip");
}

console.log("revision-core.test.mjs: all ok");
