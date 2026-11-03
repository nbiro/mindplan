/**
 * After-merge check (`run_check({ after_merge: true })`, `mindplan-mcp check --after-merge`): what
 * a git merge of two branches that both changed the graph can leave behind. Each finding is a
 * `Blocked: after-merge: …` line naming its fix, except a revision whose base live moved past: that
 * is a `Warning: after-merge:` (ship rebases it anyway, and an in-place live edit on the same branch
 * does the same). The file-level findings read `mindplan/` directly
 * and never throw, so a file the loader cannot parse (conflict markers) is reported, not crashed on.
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { NODE_TYPES, type MindPlanGraph } from "../../foundations/f-domain-model/types.js";
import { MINDPLAN_DIR, typeDir } from "../../foundations/f-territory-store/store.js";
import { REVISIONS_DIR, parseRevisionFile, revisionBaseStale } from "../../foundations/f-territory-store/revisions.js";
import { DECISIONS_DIR, parseDecisionFile } from "../../foundations/f-territory-store/decisions-store.js";
import { VERSION_RELATIVE_PATH } from "../../foundations/f-territory-store/version.js";
import { graphStatus } from "../../foundations/f-graph-migrations/status.js";
import { CACHE_DIRNAME } from "../../foundations/f-source-index/root-scope.js";

const PREFIX = "Blocked: after-merge:";
/** A warning text: run_check prints it as `Warning: after-merge: …`. */
const WARNING_PREFIX = "after-merge:";
/** Derived and machine-local folders under mindplan/: never scanned. */
const SKIPPED_DIRS = new Set([CACHE_DIRNAME, ".git", "node_modules"]);

function posix(rel: string): string {
  return rel.split(path.sep).join("/");
}

/** Every file under `dir`, absolute, skipping derived folders. */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) out.push(...walkFiles(abs));
    } else if (entry.isFile()) out.push(abs);
  }
  return out;
}

/** 1-based line of the first git conflict block in `text` (`<<<<<<< `, `=======`, `>>>>>>> `), or 0. */
export function conflictMarkerLine(text: string): number {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("<<<<<<< ")) continue;
    let separator = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] === "=======") separator = true;
      else if (separator && lines[j].startsWith(">>>>>>> ")) return i + 1;
      else if (lines[j].startsWith("<<<<<<< ")) break;
    }
  }
  return 0;
}

function conflictMarkerFailures(root: string): string[] {
  const out: string[] = [];
  for (const abs of walkFiles(path.join(root, MINDPLAN_DIR))) {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(abs);
    } catch {
      continue;
    }
    if (bytes.includes(0)) continue; // binary attachment
    const line = conflictMarkerLine(bytes.toString("utf-8"));
    if (line > 0) {
      const rel = posix(path.relative(root, abs));
      out.push(`${PREFIX} ${rel}:${line} holds git conflict markers. Resolve the conflict in that file (keep one side or merge both), then commit.`);
    }
  }
  return out;
}

/** Node folders on disk: `{ id, rel, abs }` per type folder entry. */
function nodeFolders(root: string): { id: string; rel: string; abs: string }[] {
  const out: { id: string; rel: string; abs: string }[] = [];
  for (const type of NODE_TYPES) {
    const dir = typeDir(type);
    const abs = path.join(root, MINDPLAN_DIR, dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) out.push({ id: e.name, rel: `${MINDPLAN_DIR}/${dir}/${e.name}`, abs: path.join(abs, e.name) });
    }
  }
  return out;
}

function duplicateIdFailures(root: string): string[] {
  const byId = new Map<string, string[]>();
  for (const f of nodeFolders(root)) byId.set(f.id, [...(byId.get(f.id) ?? []), f.rel]);
  const out: string[] = [];
  for (const [id, rels] of [...byId].sort(([a], [b]) => a.localeCompare(b))) {
    if (rels.length < 2) continue;
    out.push(
      `${PREFIX} node id "${id}" is in ${rels.length} folders (${rels.join(", ")}). Keep one: merge what the others hold into it and delete them.`
    );
  }
  return out;
}

function mdFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function revisionFolders(nodeAbs: string): { change: string; abs: string }[] {
  try {
    return fs
      .readdirSync(path.join(nodeAbs, REVISIONS_DIR), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ change: e.name, abs: path.join(nodeAbs, REVISIONS_DIR, e.name) }));
  } catch {
    return [];
  }
}

/** Per node folder: one decision id recorded in two files (live and revision decision folders). */
function duplicateDecisionFailures(root: string): string[] {
  const out: string[] = [];
  for (const folder of nodeFolders(root)) {
    const dirs = [path.join(folder.abs, DECISIONS_DIR), ...revisionFolders(folder.abs).map((r) => path.join(r.abs, DECISIONS_DIR))];
    const byId = new Map<string, string[]>();
    for (const file of dirs.flatMap(mdFiles)) {
      let id: string | undefined;
      try {
        id = parseDecisionFile(fs.readFileSync(file, "utf-8"))?.id;
      } catch {
        id = undefined;
      }
      if (id) byId.set(id, [...(byId.get(id) ?? []), posix(path.relative(root, file))]);
    }
    for (const [id, files] of byId) {
      if (files.length < 2) continue;
      out.push(
        `${PREFIX} decision "${id}" of "${folder.id}" is recorded in ${files.length} files (${files.sort().join(", ")}). ` +
          `Keep one id per decision: delete one file and record it again under a new id with record_decision({ node_id: "${folder.id}", supersedes: "${id}", … }).`
      );
    }
  }
  return out;
}

/** Revision files that no longer parse (the loader would throw on them). */
function unreadableRevisionFailures(root: string): string[] {
  const out: string[] = [];
  for (const folder of nodeFolders(root)) {
    for (const rev of revisionFolders(folder.abs)) {
      const file = path.join(rev.abs, `${folder.id}.mdx`);
      if (!fs.existsSync(file)) continue;
      try {
        parseRevisionFile(fs.readFileSync(file, "utf-8"), folder.id);
      } catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).replace(/^Blocked:\s*/, "");
        out.push(
          `${PREFIX} ${posix(path.relative(root, file))} does not parse (${message}). Fix the file (resolve any conflict in it), then run the check again.`
        );
      }
    }
  }
  return out;
}

function mapTrackedFailures(root: string): string[] {
  const rel = `${MINDPLAN_DIR}/map.md`;
  let tracked = "";
  try {
    tracked = execFileSync("git", ["ls-files", "--", rel], { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return []; // not a git checkout
  }
  if (!tracked.trim()) return [];
  return [
    `${PREFIX} ${rel} is tracked by git, so every branch rewrites it and merges conflict on it. ` +
      `Untrack it: git rm --cached ${rel} (and list map.md in ${MINDPLAN_DIR}/.gitignore).`,
  ];
}

function versionFailures(root: string): string[] {
  if (process.env.MINDPLAN_VERSION_GATE === "off") return [];
  if (!fs.existsSync(path.join(root, ...VERSION_RELATIVE_PATH.split("/")))) {
    return [`${PREFIX} ${VERSION_RELATIVE_PATH} is missing (a merge dropped it). Call upgrade_project, then commit the upgrade on its own.`];
  }
  const status = graphStatus();
  if (status.state !== "upgrade") return [];
  return [`${PREFIX} ${VERSION_RELATIVE_PATH} is behind this graph: ${status.warning}`];
}

/**
 * Open revisions that cannot be read (failures), and those whose recorded base no longer matches
 * live (warnings: live changed on the other branch, or in place on this one).
 */
function staleBaseFindings(graph: MindPlanGraph): { failures: string[]; warnings: string[] } {
  const out: string[] = [];
  const warnings: string[] = [];
  for (const node of graph.nodes) {
    for (const rev of node.open_revisions ?? []) {
      let stale: boolean;
      try {
        stale = revisionBaseStale(node, rev.change);
      } catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).replace(/^Blocked:\s*/, "");
        out.push(`${PREFIX} revision "${rev.change}" of "${node.id}" could not be read (${message}). Fix the file, then run the check again.`);
        continue;
      }
      if (!stale) continue;
      warnings.push(
        `${WARNING_PREFIX} revision "${rev.change}" of "${node.id}" is based on a live "${node.id}" that changed since (live moved on the other branch). ` +
          `Carry it onto live: rebase_revision({ node_id: "${node.id}", change: "${rev.change}" }), then resolve any conflict it reports with resolve_conflict (ship rebases it too).`
      );
    }
  }
  return { failures: out, warnings };
}

/**
 * Every after-merge Blocked finding for the checkout at `root` (MINDPLAN_ROOT must point at it).
 * `graph` is the loaded graph, or null when it failed to load: the file-level findings still run,
 * so whatever broke the load is named. `skipVersion` leaves out the version.json findings (the
 * caller already reports `Blocked: Version`). Never throws.
 */
export function afterMergeFailures(
  graph: MindPlanGraph | null,
  root: string,
  options: { skipVersion?: boolean } = {}
): string[] {
  const out: string[] = [];
  const guarded = (fn: () => string[]): void => {
    try {
      out.push(...fn());
    } catch (err) {
      out.push(`${PREFIX} ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  guarded(() => conflictMarkerFailures(root));
  guarded(() => duplicateIdFailures(root));
  guarded(() => unreadableRevisionFailures(root));
  guarded(() => duplicateDecisionFailures(root));
  guarded(() => mapTrackedFailures(root));
  if (!options.skipVersion) guarded(() => versionFailures(root));
  if (graph) guarded(() => staleBaseFindings(graph).failures);
  return out;
}

/** The after-merge warnings (`after-merge: …` texts): revisions whose base live moved past. Never throws. */
export function afterMergeWarnings(graph: MindPlanGraph): string[] {
  try {
    return staleBaseFindings(graph).warnings;
  } catch {
    return [];
  }
}
