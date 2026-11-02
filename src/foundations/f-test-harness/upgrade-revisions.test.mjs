/**
 * Migration level 4: upgrade_project moves each legacy `<id>.next.mdx` into
 * `revisions/<change>/<id>.mdx` (deltas against live, base hashes of live, no conflicts, next-only
 * decisions as files, next-attachments moved), splits every live `## Decisions` section into
 * `decisions/<id>.md`, adds `map.md` to mindplan/.gitignore and untracks it, reports all three,
 * and a second run changes nothing. Run via npm test.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { runUpgrade } from "./upgrade-run.mjs";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const dist = (rel) => pathToFileURL(path.join(toolRoot, "dist", rel)).href;
const { MIGRATION_LEVEL } = await import(dist("foundations/f-graph-migrations/migrations.js"));
const { parseRevisionFile } = await import(dist("foundations/f-territory-store/revisions.js"));
const { parseDecisionFile } = await import(dist("foundations/f-territory-store/decisions-store.js"));
const { scalarHashes, sectionHashes } = await import(dist("foundations/f-revision-model/index.js"));

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`ok   ${label}`);
  else {
    failures++;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const git = (root, ...args) => spawnSync("git", args, { cwd: root, encoding: "utf-8" });

const decision = (id, text, date = "2026-01-01") =>
  `### ${id}\n\n- Decision: ${text}\n- Alternatives:\n  - something else\n- Why: because ${text}\n- Date: ${date}`;

function liveFile(id, type, { title, edges = {}, implementsList = [], tests = [], body, role }) {
  const lines = [
    "---",
    `id: ${id}`,
    `type: ${type}`,
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(`${title} description`)}`,
    "state: stable",
    "shipped_at: 2026-01-02T00:00:00.000Z",
    "revisions: 1",
    "churn: 0",
    "created_at: 2026-01-01T00:00:00.000Z",
    "updated_at: 2026-01-02T00:00:00.000Z",
  ];
  if (role) lines.push(`role: ${role}`);
  for (const [k, v] of Object.entries(edges)) if (v.length) lines.push(`${k}:`, ...v.map((x) => `  - ${x}`));
  if (implementsList.length) lines.push("implements:", ...implementsList.map((x) => `  - ${x}`));
  if (tests.length) lines.push("tests:", ...tests.map((x) => `  - ${x}`));
  lines.push("---", "", body);
  return lines.join("\n");
}

function nextFile(id, type, { change, title, edges = {}, implementsList = [], tests = [], body, role }) {
  const lines = ["---", `id: ${id}`, `type: ${type}`, `title: ${JSON.stringify(title)}`, `description: ${JSON.stringify(`${title} description`)}`, "state: in-progress"];
  if (change) lines.push(`change: ${change}`);
  lines.push("opened_at: 2026-02-01T00:00:00.000Z", "updated_at: 2026-02-02T00:00:00.000Z");
  if (role) lines.push(`role: ${role}`);
  for (const [k, v] of Object.entries(edges)) if (v.length) lines.push(`${k}:`, ...v.map((x) => `  - ${x}`));
  if (implementsList.length) lines.push("implements:", ...implementsList.map((x) => `  - ${x}`));
  if (tests.length) lines.push("tests:", ...tests.map((x) => `  - ${x}`));
  lines.push("---", "", body);
  return lines.join("\n");
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-upgrade-revisions-"));
const mp = (...p) => path.join(root, "mindplan", ...p);
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(rel), { recursive: true });
  fs.writeFileSync(rel, text);
};

try {
  write(mp("config.json"), JSON.stringify({ sources: ["src/**"], exclude: [] }) + "\n");
  write(mp("version.json"), JSON.stringify({ package: "0.17.0", graph: 1, migrations: 3 }) + "\n");

  for (const id of ["f-b", "f-c", "f-d"]) {
    write(mp("foundations", id, `${id}.mdx`), liveFile(id, "Foundation", { title: id, role: "infra", body: "## Spec\n\nPlain.\n" }));
  }

  // f-a: shipped, with an open next file of change c1.
  const liveBodyA =
    "## Spec\n\nThe old spec.\n\n## Notes\n\nKept.\n\n## Decisions\n\n" +
    decision("d-live", "keep live") +
    "\n\n## Rules\n\n- Never break.\n";
  write(
    mp("foundations", "f-a", "f-a.mdx"),
    liveFile("f-a", "Foundation", {
      title: "A",
      role: "infra",
      edges: { depends_on: ["f-b", "f-c"] },
      implementsList: ["src/a/"],
      tests: ["test/a.test.mjs"],
      body: liveBodyA,
    })
  );
  const nextBodyA =
    "## Spec\n\nThe new spec.\n\n## Notes\n\nKept.\n\n## Atomic Ops\n\n- [ ] do it\n\n## Decisions\n\n" +
    decision("d-live", "keep live") +
    "\n\n" +
    decision("d-next", "only in next", "2026-02-03") +
    "\n\n## Rules\n\n- Never break.\n";
  write(
    mp("foundations", "f-a", "f-a.next.mdx"),
    nextFile("f-a", "Foundation", {
      change: "c1",
      title: "A2",
      role: "infra",
      edges: { depends_on: ["f-b", "f-d"] },
      implementsList: ["src/a/", "src/a2/"],
      tests: ["test/a.test.mjs"],
      body: nextBodyA,
    })
  );
  write(mp("foundations", "f-a", "next-attachments", ".gitkeep"), "");
  write(mp("foundations", "f-a", "next-attachments", "sketch.txt"), "a sketch\n");

  // f-e: a next file without a change id.
  write(mp("foundations", "f-e", "f-e.mdx"), liveFile("f-e", "Foundation", { title: "E", role: "infra", body: "## Spec\n\nE.\n" }));
  write(mp("foundations", "f-e", "f-e.next.mdx"), nextFile("f-e", "Foundation", { title: "E", role: "infra", body: "## Spec\n\nE changed.\n" }));

  // A Capability whose live Decisions section is last, in a CRLF file.
  const capBody = "## Purpose\n\nPay.\n\n## Decisions\n\n" + decision("d-cap-one", "one") + "\n\n" + decision("d-cap-two", "two") + "\n";
  write(
    mp("capabilities", "j-pay", "j-pay.mdx"),
    [
      "---",
      "id: j-pay",
      "type: Capability",
      'title: "Pay"',
      'description: "Someone pays."',
      "state: draft",
      "created_at: 2026-01-01T00:00:00.000Z",
      "updated_at: 2026-01-01T00:00:00.000Z",
      "---",
      "",
      capBody,
    ]
      .join("\n")
      .replace(/\n/g, "\r\n")
  );
  write(mp("map.md"), "# map\n");

  git(root, "init", "-q");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "level 3 graph");

  const liveABefore = fs.readFileSync(mp("foundations", "f-a", "f-a.mdx"), "utf-8");
  const up = runUpgrade(root, { env: { MINDPLAN_ORIENT_GATE: "off" } });
  check("upgrade_project succeeds", up.status === 0 && up.result, up.stderr);
  const r = up.result ?? { migrations: {}, changed_files: [] };
  check("upgrade reports levels 3 → 4", r.from_level === 3 && r.to_level === 4 && MIGRATION_LEVEL === 4, `${r.from_level} → ${r.to_level}`);
  check(
    "report lists the moved revisions",
    JSON.stringify(r.migrations.revisionsMoved) ===
      JSON.stringify([
        { node_id: "f-a", change: "c1" },
        { node_id: "f-e", change: "rev-f-e" },
      ]),
    JSON.stringify(r.migrations.revisionsMoved)
  );

  const revA = mp("foundations", "f-a", "revisions", "c1", "f-a.mdx");
  check("the next file and next-attachments/ are gone", !fs.existsSync(mp("foundations", "f-a", "f-a.next.mdx")) && !fs.existsSync(mp("foundations", "f-a", "next-attachments")));
  check("the revision file exists", fs.existsSync(revA));
  const parsed = fs.existsSync(revA) ? parseRevisionFile(fs.readFileSync(revA, "utf-8"), "f-a") : null;
  const rev = parsed?.revision ?? {};
  check(
    "depends_on delta: f-d added, f-c removed",
    JSON.stringify(rev.edges?.depends_on) === JSON.stringify({ add: ["f-d"], remove: ["f-c"] }),
    JSON.stringify(rev.edges)
  );
  check("only depends_on carries a delta", Object.keys(rev.edges ?? {}).join(",") === "depends_on");
  check("implements delta adds src/a2/", JSON.stringify(rev.implements) === JSON.stringify({ add: ["src/a2/"], remove: [] }), JSON.stringify(rev.implements));
  check("tests delta is empty", JSON.stringify(rev.tests) === JSON.stringify({ add: [], remove: [] }), JSON.stringify(rev.tests));
  check(
    "scalars, state, and dates come from the next file",
    rev.title === "A2" && rev.state === "in-progress" && rev.opened_at === "2026-02-01T00:00:00.000Z" && rev.updated_at === "2026-02-02T00:00:00.000Z" && rev.change === "c1",
    JSON.stringify(rev)
  );
  check("no conflicts", Array.isArray(rev.conflicts) && rev.conflicts.length === 0);
  const liveABody = liveABefore.slice(liveABefore.indexOf("---", 3) + 4).replace(/^\n+/, "");
  check(
    "base hashes the live file",
    JSON.stringify(rev.base?.scalars) === JSON.stringify(scalarHashes({ title: "A", description: "A description", role: "infra" })) &&
      JSON.stringify(rev.base?.sections) === JSON.stringify(sectionHashes(liveABody)),
    JSON.stringify(rev.base)
  );
  check(
    "the revision body keeps the edit and drops Rules and Decisions",
    parsed?.body.includes("The new spec.") && parsed.body.includes("## Atomic Ops") && !parsed.body.includes("## Rules") && !parsed.body.includes("## Decisions"),
    parsed?.body
  );
  const revDecisions = mp("foundations", "f-a", "revisions", "c1", "decisions");
  check(
    "only the next-only decision becomes a revision decision file",
    fs.existsSync(path.join(revDecisions, "d-next.md")) &&
      fs.readdirSync(revDecisions).join(",") === "d-next.md" &&
      parseDecisionFile(fs.readFileSync(path.join(revDecisions, "d-next.md"), "utf-8"))?.decision === "only in next"
  );
  const revAtt = mp("foundations", "f-a", "revisions", "c1", "attachments");
  check(
    "next-attachments moved, without .gitkeep",
    fs.existsSync(path.join(revAtt, "sketch.txt")) && !fs.existsSync(path.join(revAtt, ".gitkeep")),
    fs.existsSync(revAtt) ? fs.readdirSync(revAtt).join(",") : "missing"
  );
  const revE = mp("foundations", "f-e", "revisions", "rev-f-e", "f-e.mdx");
  check(
    "a next file without change moves under rev-<id>",
    fs.existsSync(revE) && parseRevisionFile(fs.readFileSync(revE, "utf-8"), "f-e").revision.change === "rev-f-e" && !fs.existsSync(mp("foundations", "f-e", "f-e.next.mdx"))
  );

  // Decisions split.
  check(
    "report lists the split sections",
    JSON.stringify(r.migrations.decisionsSplit) ===
      JSON.stringify([
        { node_id: "j-pay", count: 2 },
        { node_id: "f-a", count: 1 },
      ]),
    JSON.stringify(r.migrations.decisionsSplit)
  );
  const liveA = fs.readFileSync(mp("foundations", "f-a", "f-a.mdx"), "utf-8");
  check(
    "f-a live loses its Decisions section and keeps the rest",
    !liveA.includes("## Decisions") && liveA.includes("## Notes\n\nKept.\n\n## Rules\n\n- Never break.\n") && liveA.includes("depends_on:\n  - f-b\n  - f-c"),
    liveA
  );
  check(
    "f-a's live decision is a file",
    parseDecisionFile(fs.readFileSync(mp("foundations", "f-a", "decisions", "d-live.md"), "utf-8"))?.id === "d-live"
  );
  const cap = fs.readFileSync(mp("capabilities", "j-pay", "j-pay.mdx"), "utf-8");
  check(
    "a CRLF live file loses its last section and keeps CRLF, ending on one line break",
    cap.endsWith("## Purpose\r\n\r\nPay.\r\n") && !cap.includes("## Decisions") && !/[^\r]\n/.test(cap),
    JSON.stringify(cap.slice(-60))
  );
  check(
    "the Capability's decisions are files",
    ["d-cap-one", "d-cap-two"].every((id) => fs.existsSync(mp("capabilities", "j-pay", "decisions", `${id}.md`)))
  );

  // map.md
  check("report says map.md is ignored", r.migrations.mapIgnored === true);
  check("mindplan/.gitignore lists map.md", fs.readFileSync(mp(".gitignore"), "utf-8").split("\n").includes("map.md"));
  check("map.md is untracked but kept", git(root, "ls-files", "mindplan/map.md").stdout.trim() === "" && fs.existsSync(mp("map.md")));
  check(
    "changed_files lists the moves",
    ["mindplan/foundations/f-a/f-a.next.mdx", "mindplan/foundations/f-a/revisions/c1/f-a.mdx", "mindplan/.gitignore", "mindplan/version.json"].every((p) =>
      r.changed_files.includes(p)
    ),
    JSON.stringify(r.changed_files)
  );
  const stamp = JSON.parse(fs.readFileSync(mp("version.json"), "utf-8"));
  check("the stamp is at level 4", stamp.migrations === 4);

  const again = runUpgrade(root, { env: { MINDPLAN_ORIENT_GATE: "off" } });
  check(
    "a second run changes nothing",
    again.status === 0 &&
      again.result.changed_files.length === 0 &&
      again.result.migrations.revisionsMoved.length === 0 &&
      again.result.migrations.decisionsSplit.length === 0 &&
      again.result.migrations.mapIgnored === false,
    again.stderr + JSON.stringify(again.result?.changed_files)
  );

  // A revision folder that already exists blocks the move, naming both paths.
  write(mp("foundations", "f-b", "f-b.next.mdx"), nextFile("f-b", "Foundation", { change: "c2", title: "B", role: "infra", body: "## Spec\n\nB.\n" }));
  write(mp("foundations", "f-b", "revisions", "c2", "f-b.mdx"), "placeholder\n");
  write(mp("version.json"), JSON.stringify({ package: "0.17.0", graph: 1, migrations: 3 }) + "\n");
  const clash = runUpgrade(root, { env: { MINDPLAN_ORIENT_GATE: "off" } });
  check(
    "an existing revision folder is Blocked naming both paths",
    clash.status !== 0 &&
      clash.stderr.includes("Blocked") &&
      clash.stderr.includes("mindplan/foundations/f-b/f-b.next.mdx") &&
      clash.stderr.includes("mindplan/foundations/f-b/revisions/c2"),
    clash.stderr
  );
  fs.rmSync(mp("foundations", "f-b", "revisions"), { recursive: true, force: true });
  fs.rmSync(mp("foundations", "f-b", "f-b.next.mdx"));

  // A decision file of the same id with other content blocks the split.
  write(
    mp("foundations", "f-c", "f-c.mdx"),
    liveFile("f-c", "Foundation", { title: "f-c", role: "infra", body: "## Spec\n\nPlain.\n\n## Decisions\n\n" + decision("d-dup", "section text") + "\n" })
  );
  write(mp("foundations", "f-c", "decisions", "d-dup.md"), decision("d-dup", "file text") + "\n");
  const dup = runUpgrade(root, { env: { MINDPLAN_ORIENT_GATE: "off" } });
  check("a different decision file of the same id is Blocked", dup.status !== 0 && dup.stderr.includes("d-dup"), dup.stderr);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\nupgrade-revisions.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("upgrade-revisions.test.mjs: all ok");
