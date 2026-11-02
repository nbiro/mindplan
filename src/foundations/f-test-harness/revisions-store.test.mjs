/**
 * Revision storage coverage (npm test), no server: the revision file format round-trips; two
 * revisions open on one shipped node; the loader fills `open_revisions` and the `next` view (only
 * with one open); shipping one revision rewrites live and rebases its sibling (clean carry, and a
 * section conflict that resolve_conflict clears); discard deletes the folder; decision files
 * append, refuse a duplicate id, and move into live on ship; and the graph cache re-parses a node
 * after a revision file changes.
 */
// Fixtures build graphs without a version stamp; the gate has its own suite (version.test.mjs).
process.env.MINDPLAN_VERSION_GATE ??= "off";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-revisions-store-"));
process.env.MINDPLAN_ROOT = root;
delete process.env.MINDPLAN_GRAPH_CACHE;

const { loadGraph } = await import("../../../dist/foundations/f-territory-store/store.js");
const {
  discardRevision,
  formatRevisionFile,
  openRevision,
  parseRevisionFile,
  readRevisions,
  resolveConflict,
  revisionDecisionsDir,
  revisionDir,
  revisionFilePath,
  shipRevision,
  writeRevisionBody,
  writeRevisionDelta,
  writeRevisionScalars,
  writeRevisionState,
} = await import("../../../dist/foundations/f-territory-store/revisions.js");
const { appendDecisionFile, decisionsDir, readDecisionFiles } = await import(
  "../../../dist/foundations/f-territory-store/decisions-store.js"
);

const ok = (label) => console.log(`ok   ${label}`);
const HOUR_AGO = new Date(Date.now() - 3600_000);

function foundation(id, { body = "## Spec\n\nSpec text.\n\n## Notes\n\nNotes text.\n", extra = [] } = {}) {
  const dir = path.join(root, "mindplan", "foundations", id);
  fs.mkdirSync(dir, { recursive: true });
  const text = [
    "---",
    `id: ${id}`,
    "type: Foundation",
    `title: ${JSON.stringify(`Title ${id}`)}`,
    `description: ${JSON.stringify(`Description ${id}.`)}`,
    "state: stable",
    "shipped_at: 2026-01-02T00:00:00.000Z",
    "revisions: 1",
    "churn: 1",
    "created_at: 2026-01-01T00:00:00.000Z",
    "updated_at: 2026-01-02T00:00:00.000Z",
    ...extra,
    "---",
    "",
    body,
  ].join("\n");
  const file = path.join(dir, `${id}.mdx`);
  fs.writeFileSync(file, text, "utf-8");
  fs.utimesSync(file, HOUR_AGO, HOUR_AGO);
  return dir;
}

const graph = () => loadGraph();
const node = (id) => graph().nodes.find((n) => n.id === id);
const bodyOf = (file) => parseRevisionFile(fs.readFileSync(file, "utf-8"), path.basename(file, ".mdx")).body;
const blocked = (fn, re) => assert.throws(fn, (e) => /^Blocked:/.test(e.message) && (!re || re.test(e.message)));

const record = (id, date) => ({
  id,
  decision: `Chose ${id}.`,
  alternatives: ["Something else"],
  why: "Because.",
  date,
});

// --- format / parse ---------------------------------------------------------------------------

{
  const revision = {
    change: "multi",
    change_ref: "feat/multi",
    state: "in-progress",
    opened_at: "2026-02-01T00:00:00.000Z",
    updated_at: "2026-02-02T00:00:00.000Z",
    title: 'A "quoted" title',
    description: "Desc: with colon.",
    role: "infra",
    edges: { depends_on: { add: ["f-a", "f-b"], remove: ["f-c"] }, mounts: { add: [], remove: ["i-x"] } },
    implements: { add: ["src/a.ts", "src/dir/"], remove: ["src/old.ts"] },
    tests: { add: ["tests/a.test.mjs"], remove: [] },
    attributed: ["src/migrations/001.sql"],
    split_into: ["f-part"],
    base: {
      scalars: { title: "11111111", description: "22222222", role: "33333333" },
      sections: { _preamble: "44444444", "## Spec": "55555555", "## A = B": "66666666" },
    },
    conflicts: [
      { kind: "section", section: "## Spec" },
      { kind: "scalar", field: "title" },
      { kind: "claim", path: "src/x@y.ts", owner: "f-owner" },
    ],
  };
  const body = "## Spec\n\nThe spec.\n";
  const text = formatRevisionFile("f-core", "Foundation", revision, body);
  assert.match(text, /^---\nid: f-core\ntype: Foundation\nchange: multi\n/);
  assert.match(text, /\ndepends_on_add:\n  - f-a\n  - f-b\ndepends_on_remove:\n  - f-c\n/);
  assert.match(text, /\nimplements_add:\n  - src\/a\.ts\n/);
  const parsed = parseRevisionFile(text, "f-core");
  assert.deepEqual(parsed.revision, revision);
  assert.equal(parsed.body, body);
  blocked(() => parseRevisionFile(text, "f-other"), /f-other/);
  blocked(() => parseRevisionFile(text.replace("state: in-progress", "state: stable"), "f-core"), /state/);
  ok("format/parse: a revision round-trips with deltas, base hashes, and every conflict kind");
}

// --- open two revisions on one shipped node -----------------------------------------------------

foundation("f-dep");
foundation("f-claimer", { extra: ["implements:", "  - src/claimed.ts"] });
foundation("f-core");

{
  const n = node("f-core");
  assert.equal(n.open_revisions, undefined);
  const a = openRevision(n, "a", {});
  assert.deepEqual(a.changed_files, ["mindplan/foundations/f-core/revisions/a/f-core.mdx"]);
  assert.equal(a.revision.state, "draft");
  assert.equal(a.revision.title, "Title f-core");
  assert.deepEqual(a.revision.conflicts, []);
  assert.ok(a.revision.base.sections["## Spec"]);
  const b = openRevision(n, "b", { title: "B title", plannedAdds: [{ change: "b", type: "depends_on", target: "f-dep" }, { change: "z", type: "mounts", target: "i-x" }] });
  assert.deepEqual(b.revision.edges, { depends_on: { add: ["f-dep"], remove: [] } });
  assert.deepEqual(n.open_revisions.map((r) => r.change), ["a", "b"]);
  blocked(() => openRevision(n, "a", {}), /"a"/);
  const body = bodyOf(revisionFilePath(n, "a"));
  assert.match(body, /## Atomic Ops\n\n- \[ \] Spec written/);
  assert.match(body, /## Spec\n\nSpec text\./);
  blocked(() => openRevision(node("f-core"), "Bad Id", {}));
  ok("openRevision: two changes open on one node; a duplicate change is Blocked; fresh Atomic Ops");
}

{
  const n = node("f-core");
  assert.deepEqual(n.open_revisions.map((r) => r.change), ["a", "b"]);
  assert.equal(n.next, undefined);
  assert.equal(n.open_revisions[1].title, "B title");
  assert.deepEqual(readRevisions(path.join(root, "mindplan", "foundations", "f-core"), "f-core").map((r) => r.revision.change), ["a", "b"]);
  ok("loader: open_revisions sorted by change, next unset with two open");
}

// --- edit and ship a; b rebases cleanly -----------------------------------------------------------

{
  let n = node("f-core");
  const aFile = revisionFilePath(n, "a");
  const aBody = bodyOf(aFile).replace("Spec text.", "Spec text from a.");
  writeRevisionBody(n, "a", `${aBody}\n## Decisions\n\n### d-ignored\n\n- Decision: x\n- Alternatives:\n- Why: y\n`);
  assert.doesNotMatch(bodyOf(aFile), /## Decisions/);
  writeRevisionDelta(n, "a", "depends_on", { add: ["f-dep", "f-dep"], remove: ["f-missing"] });
  writeRevisionState(n, "a", "in-review");
  blocked(() => writeRevisionState(n, "a", "stable"));
  writeRevisionScalars(n, "a", { description: "Description from a." });
  const bFile = revisionFilePath(n, "b");
  writeRevisionBody(n, "b", bodyOf(bFile).replace("Notes text.", "Notes text from b."));
  appendDecisionFile(revisionDecisionsDir(n, "a"), record("d-from-a", "2026-03-01"));

  n = node("f-core");
  const rev = n.open_revisions.find((r) => r.change === "a");
  assert.deepEqual(rev.edges.depends_on, { add: ["f-dep"], remove: [] });
  assert.equal(rev.state, "in-review");
  assert.deepEqual(rev.decisions.map((d) => d.id), ["d-from-a"]);

  const g = graph();
  n = g.nodes.find((x) => x.id === "f-core");
  const shipped = shipRevision(g, n, "a", { now: "2026-03-02T00:00:00.000Z", newState: "stable" });
  assert.deepEqual(shipped.rebased, [{ change: "b", conflicts: [] }]);
  assert.ok(shipped.changed_files.includes("mindplan/foundations/f-core/f-core.mdx"));
  assert.ok(shipped.changed_files.includes("mindplan/foundations/f-core/decisions/d-from-a.md"));
  assert.ok(shipped.changed_files.includes("mindplan/foundations/f-core/revisions/b/f-core.mdx"));
  assert.equal(n.revisions, 2);
  assert.deepEqual(n.open_revisions.map((r) => r.change), ["b"]);
  assert.ok(!fs.existsSync(revisionDir(path.join(root, "mindplan", "foundations", "f-core"), "a")));

  n = node("f-core");
  assert.equal(n.revisions, 2);
  assert.equal(n.shipped_at, "2026-03-02T00:00:00.000Z");
  assert.equal(n.description, "Description from a.");
  assert.deepEqual(n.depends_on, ["f-dep"]);
  assert.deepEqual(n.decisions.map((d) => d.id), ["d-from-a"]);
  const live = fs.readFileSync(path.join(root, "mindplan", "foundations", "f-core", "f-core.mdx"), "utf-8");
  assert.match(live, /Spec text from a\./);
  assert.doesNotMatch(live, /Atomic Ops/);
  assert.deepEqual(n.open_revisions.map((r) => r.change), ["b"]);
  // One open revision: the next view is live plus b.
  assert.equal(n.next.change, "b");
  assert.equal(n.next.title, "B title");
  const bText = bodyOf(revisionFilePath(n, "b"));
  assert.match(bText, /Spec text from a\./);
  assert.match(bText, /Notes text from b\./);
  // b planned f-dep, now live: the add dropped.
  assert.deepEqual(n.open_revisions[0].edges, {});
  assert.equal(n.open_revisions[0].description, "Description from a.");
  ok("shipRevision: live takes a's text, edge, and decision; b carries the new Spec without conflict");
}

// --- both edit one section: conflict, resolve ---------------------------------------------------

{
  let n = node("f-core");
  discardRevision(n, "b");
  assert.ok(!fs.existsSync(path.join(root, "mindplan", "foundations", "f-core", "revisions")));
  n = node("f-core");
  assert.equal(n.open_revisions, undefined);
  assert.equal(n.next, undefined);
  ok("discardRevision: deletes the folder and the empty revisions/");

  openRevision(n, "c", {});
  openRevision(n, "d", {});
  writeRevisionBody(n, "c", bodyOf(revisionFilePath(n, "c")).replace("Spec text from a.", "Spec by c."));
  writeRevisionBody(n, "d", bodyOf(revisionFilePath(n, "d")).replace("Spec text from a.", "Spec by d."));
  writeRevisionDelta(n, "d", "implements", { add: ["src/claimed.ts"], remove: [] });
  const dDecisions = revisionDecisionsDir(n, "d");
  appendDecisionFile(dDecisions, record("d-from-d", "2026-04-01"));
  blocked(() => appendDecisionFile(dDecisions, record("d-from-d", "2026-04-02")), /d-from-d/);

  const g = graph();
  n = g.nodes.find((x) => x.id === "f-core");
  const shipped = shipRevision(g, n, "c", { now: "2026-04-02T00:00:00.000Z", newState: "stable" });
  assert.deepEqual(shipped.rebased, [
    {
      change: "d",
      conflicts: [
        { kind: "section", section: "## Spec" },
        { kind: "claim", path: "src/claimed.ts", owner: "f-claimer" },
      ],
    },
  ]);
  n = node("f-core");
  assert.equal(n.open_revisions[0].conflicts.length, 2);
  assert.match(bodyOf(revisionFilePath(n, "d")), /Spec by d\./);
  blocked(() => shipRevision(graph(), node("f-core"), "d", { now: "2026-04-03T00:00:00.000Z", newState: "stable" }), /conflict/);
  blocked(() => resolveConflict(n, "d", "## Notes", "live"));
  blocked(() => resolveConflict(n, "d", "## Spec", "text"));

  const r1 = resolveConflict(n, "d", "## Spec", "revision");
  assert.deepEqual(r1.conflicts, [{ kind: "claim", path: "src/claimed.ts", owner: "f-claimer" }]);
  const r2 = resolveConflict(n, "d", "src/claimed.ts", "live");
  assert.deepEqual(r2.conflicts, []);
  n = node("f-core");
  const d = n.open_revisions[0];
  assert.deepEqual(d.conflicts, []);
  assert.deepEqual(d.implements, { add: [], remove: [] });
  assert.match(bodyOf(revisionFilePath(n, "d")), /Spec by d\./);
  ok("rebase conflict: both edited Spec and a claim now owned elsewhere; resolveConflict clears each");

  // Ship d: its decision files move into the node's decisions/.
  const g2 = graph();
  n = g2.nodes.find((x) => x.id === "f-core");
  shipRevision(g2, n, "d", { now: "2026-04-03T00:00:00.000Z", newState: "stable" });
  const liveDecisions = decisionsDir(path.join(root, "mindplan", "foundations", "f-core"));
  assert.deepEqual(fs.readdirSync(liveDecisions).sort(), ["d-from-a.md", "d-from-d.md"]);
  assert.deepEqual(readDecisionFiles(liveDecisions).map((x) => x.id), ["d-from-a", "d-from-d"]);
  n = node("f-core");
  assert.deepEqual(n.decisions.map((x) => x.id), ["d-from-a", "d-from-d"]);
  assert.match(fs.readFileSync(path.join(root, "mindplan", "foundations", "f-core", "f-core.mdx"), "utf-8"), /Spec by d\./);
  ok("decision files: append, duplicate id Blocked, ship moves them into live decisions/");
}

// --- graph cache sees revision edits --------------------------------------------------------------

{
  let n = node("f-core");
  openRevision(n, "e", {});
  n = node("f-core");
  assert.equal(n.open_revisions[0].title, "Title f-core");
  const file = revisionFilePath(n, "e");
  const text = fs.readFileSync(file, "utf-8");
  fs.writeFileSync(file, text.replace('title: "Title f-core"', 'title: "Edited on disk, longer"'), "utf-8");
  n = node("f-core");
  assert.equal(n.open_revisions[0].title, "Edited on disk, longer");
  assert.equal(n.next.title, "Edited on disk, longer");
  const decisionsFolder = decisionsDir(path.join(root, "mindplan", "foundations", "f-core"));
  fs.writeFileSync(path.join(decisionsFolder, "d-by-hand.md"), "### d-by-hand\n\n- Decision: By hand.\n- Alternatives:\n- Why: Test.\n- Date: 2026-05-01\n", "utf-8");
  assert.deepEqual(node("f-core").decisions.map((x) => x.id), ["d-from-a", "d-from-d", "d-by-hand"]);
  ok("graph cache: a revision file edit and a new decision file re-parse the node");
}

const { closeGraphCaches } = await import("../../../dist/foundations/f-graph-cache/cache.js");
closeGraphCaches();
fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
console.log("revisions-store.test.mjs: all ok");
