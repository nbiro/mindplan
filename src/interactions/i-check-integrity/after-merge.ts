/**
 * After-merge check (`run_check({ after_merge: true })`, `mindplan-mcp check --after-merge`): what
 * a git merge of two branches that both changed the graph can leave behind. Each finding is a
 * `Blocked: after-merge: …` line naming its fix, except a revision whose base live moved past: that
 * is a `Warning: after-merge:` (ship rebases it anyway, and an in-place live edit on the same branch
 * does the same). The file-level findings read `mindplan/` directly
 * and never throw, so a file the loader cannot parse (conflict markers) is reported, not crashed on.
 */

import * as fs from "fs";
import * as path from "path";
import { type MindPlanGraph } from "../../foundations/f-domain-model/types.js";
import { MINDPLAN_DIR, listNodeFolders, type NodeFolder } from "../../foundations/f-territory-store/store.js";
import {
  parseRevisionFile,
  revisionBaseStale,
  revisionDir,
  revisionFolderNames,
} from "../../foundations/f-territory-store/revisions.js";
import { decisionFileNames, decisionsDir, parseDecisionFile } from "../../foundations/f-territory-store/decisions-store.js";
import { VERSION_RELATIVE_PATH } from "../../foundations/f-territory-store/version.js";
import { graphStatus } from "../../foundations/f-graph-migrations/status.js";
import { CACHE_DIRNAME, repoRelative, withRoot } from "../../foundations/f-source-index/root-scope.js";
import { MAP_REL, git } from "../../foundations/f-source-index/git.js";

const PREFIX = "Blocked: after-merge:";
/** A warning text: run_check prints it as `Warning: after-merge: …`. */
const WARNING_PREFIX = "after-merge:";
/** Derived and machine-local folders under mindplan/: never scanned. */
const SKIPPED_DIRS = new Set([CACHE_DIRNAME, ".git", "node_modules"]);

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

/** A territory or decision file (`.md` / `.mdx`): the files the per-node findings parse. */
function isMarkdown(abs: string): boolean {
  return /\.mdx?$/i.test(abs);
}

/**
 * One walk of mindplan/ for the file-level findings: git conflict markers in any file, then per node
 * folder its revision files that no longer parse (the loader would throw on them) and any decision
 * id recorded in two files (live and revision decision folders). Each file is read once.
 */
function fileFailures(root: string, folders: NodeFolder[]): { markers: string[]; unreadable: string[]; duplicates: string[] } {
  const texts = new Map<string, string>();
  const markers: string[] = [];
  for (const abs of walkFiles(path.join(root, MINDPLAN_DIR))) {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(abs);
    } catch {
      continue;
    }
    const text = bytes.toString("utf-8");
    if (isMarkdown(abs)) texts.set(abs, text);
    if (bytes.includes(0)) continue; // binary attachment
    const line = conflictMarkerLine(text);
    if (line > 0) {
      markers.push(
        `${PREFIX} ${repoRelative(abs, root)}:${line} holds git conflict markers. Resolve the conflict in that file (keep one side or merge both), then commit.`
      );
    }
  }
  const read = (file: string): string | undefined => {
    const text = texts.get(file);
    if (text !== undefined) return text;
    try {
      return fs.readFileSync(file, "utf-8");
    } catch {
      return undefined;
    }
  };

  const unreadable: string[] = [];
  const duplicates: string[] = [];
  for (const folder of folders) {
    const revisionDirs = revisionFolderNames(folder.abs).map((change) => revisionDir(folder.abs, change));
    for (const dir of revisionDirs) {
      const file = path.join(dir, `${folder.id}.mdx`);
      const text = read(file);
      if (text === undefined) continue;
      try {
        parseRevisionFile(text, folder.id);
      } catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).replace(/^Blocked:\s*/, "");
        unreadable.push(
          `${PREFIX} ${repoRelative(file, root)} does not parse (${message}). Fix the file (resolve any conflict in it), then run the check again.`
        );
      }
    }
    const byId = new Map<string, string[]>();
    for (const dir of [folder.abs, ...revisionDirs].map(decisionsDir)) {
      for (const name of decisionFileNames(dir)) {
        const file = path.join(dir, name);
        const text = read(file);
        let id: string | undefined;
        try {
          id = text === undefined ? undefined : parseDecisionFile(text)?.id;
        } catch {
          id = undefined;
        }
        if (id) byId.set(id, [...(byId.get(id) ?? []), repoRelative(file, root)]);
      }
    }
    for (const [id, files] of byId) {
      if (files.length < 2) continue;
      duplicates.push(
        `${PREFIX} decision "${id}" of "${folder.id}" is recorded in ${files.length} files (${files.sort().join(", ")}). ` +
          `Keep one id per decision: delete one file and record it again under a new id with record_decision({ node_id: "${folder.id}", supersedes: "${id}", … }).`
      );
    }
  }
  return { markers, unreadable, duplicates };
}

function duplicateIdFailures(folders: NodeFolder[]): string[] {
  const byId = new Map<string, string[]>();
  for (const f of folders) byId.set(f.id, [...(byId.get(f.id) ?? []), f.rel]);
  const out: string[] = [];
  for (const [id, rels] of [...byId].sort(([a], [b]) => a.localeCompare(b))) {
    if (rels.length < 2) continue;
    out.push(
      `${PREFIX} node id "${id}" is in ${rels.length} folders (${rels.join(", ")}). Keep one: merge what the others hold into it and delete them.`
    );
  }
  return out;
}

function mapTrackedFailures(root: string): string[] {
  const tracked = git(["ls-files", "--", MAP_REL], root);
  if (!tracked?.trim()) return []; // not tracked, or not a git checkout
  return [
    `${PREFIX} ${MAP_REL} is tracked by git, so every branch rewrites it and merges conflict on it. ` +
      `Untrack it: git rm --cached ${MAP_REL} (and list map.md in ${MINDPLAN_DIR}/.gitignore).`,
  ];
}

function versionFailures(root: string): string[] {
  if (process.env.MINDPLAN_VERSION_GATE === "off") return [];
  if (!fs.existsSync(path.join(root, ...VERSION_RELATIVE_PATH.split("/")))) {
    return [`${PREFIX} ${VERSION_RELATIVE_PATH} is missing (a merge dropped it). Call upgrade_project, then commit the upgrade on its own.`];
  }
  // graphStatus reads the scoped root: judge the checkout at `root`, not the process's own.
  const status = withRoot(root, graphStatus);
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
 * Every after-merge finding for the checkout at `root` (MINDPLAN_ROOT must point at it): the
 * Blocked `failures`, and the `warnings` (`after-merge: …` texts: revisions whose base live
 * moved past). `graph` is the loaded graph, or null when it failed to load: the file-level findings
 * still run, so whatever broke the load is named, and there are no warnings. `skipVersion` leaves
 * out the version.json findings (the caller already reports `Blocked: Version`). Never throws.
 */
export function afterMergeFindings(
  graph: MindPlanGraph | null,
  root: string,
  options: { skipVersion?: boolean } = {}
): { failures: string[]; warnings: string[] } {
  const out: string[] = [];
  const guarded = (fn: () => string[]): void => {
    try {
      out.push(...fn());
    } catch (err) {
      out.push(`${PREFIX} ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  let folders: NodeFolder[] = [];
  let files = { markers: [] as string[], unreadable: [] as string[], duplicates: [] as string[] };
  guarded(() => {
    folders = listNodeFolders(root);
    files = fileFailures(root, folders);
    return files.markers;
  });
  guarded(() => duplicateIdFailures(folders));
  out.push(...files.unreadable, ...files.duplicates);
  guarded(() => mapTrackedFailures(root));
  if (!options.skipVersion) guarded(() => versionFailures(root));
  let warnings: string[] = [];
  if (graph) {
    guarded(() => {
      const stale = staleBaseFindings(graph);
      warnings = stale.warnings;
      return stale.failures;
    });
  }
  return { failures: out, warnings };
}
