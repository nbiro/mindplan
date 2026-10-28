/**
 * Graph cache: parsed node records kept in memory and in `.mindplan-cache/graph.db`, so a graph
 * load re-parses only node folders that may have changed. The `.mdx` files stay the only source
 * of truth; this is a derived read model, dropped when its schema or the package version changes
 * and safe to delete.
 *
 * Freshness rule, per node folder (`d-graph-cache-freshness-rule`):
 * - Inside git (and above `GIT_MODE_MIN_FOLDERS`), a record is reused untouched when it was parsed
 *   while its folder was clean at tree T, git status lists nothing under the folder now, and the
 *   folder did not change between T and the current tree.
 * - Otherwise the folder's `.mdx` files are compared by stamp (name, size, mtime). A stamp taken
 *   within `RACY_MS` of a file's mtime is not trusted: such a folder is hashed when parsed, and
 *   re-read and compared by hash until its stamps settle. Anything else re-parses the folder.
 *
 * Like git's own stat check, a stamp cannot see an edit that keeps a file's size and restores its
 * old mtime; `MINDPLAN_GRAPH_CACHE=off` (or deleting the cache) is the way out of that.
 */

import { createHash } from "crypto";
import * as fs from "fs";
import { createRequire } from "module";
import * as path from "path";
import type { MindPlanNode } from "../f-domain-model/types.js";
import { dirGitState, treeChanges } from "../f-source-index/git.js";
import { readBytesRetry } from "../f-source-index/io.js";

/** Bump when the table or the stored entry shape changes; a mismatch drops every row. */
export const GRAPH_CACHE_SCHEMA = "2";
/** Below this many node folders, stamps are cheaper than spawning git (about 100 ms on Windows). */
export const GIT_MODE_MIN_FOLDERS = 1000;
/** A stamp taken this close to a file's mtime may miss an edit in the same clock tick. */
export const RACY_MS = 2000;

const CACHE_DIRNAME = ".mindplan-cache";
const DB_FILENAME = "graph.db";

/** One file of a node folder as last seen. */
export type FileStamp = { name: string; size: number; mtimeMs: number };

/** A cached folder: its record (null when the folder holds no node), how it was seen, and when. */
export type CacheEntry = {
  record: MindPlanNode | null;
  files: FileStamp[];
  /**
   * SHA-1 over the folder's `.mdx` names and bytes, taken only when a stamp was too recent to
   * trust (hashing every folder would double the reads of a cold load); null otherwise.
   */
  hash: string | null;
  stampedAt: number;
  /** Tree id of the plan at the moment the folder was seen clean in git; null when not clean. */
  cleanAt: string | null;
};

/** A node folder to load: its path relative to the project root and how to parse it. */
export type FolderRef = { rel: string; abs: string };

type Row = Record<string, unknown>;
type Database = {
  exec(sql: string): void;
  prepare(sql: string): { run(...p: unknown[]): unknown; all(...p: unknown[]): Row[]; get(...p: unknown[]): Row | undefined };
  close(): void;
};

function openDatabase(file: string): Database | null {
  try {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (f: string) => Database };
    return new DatabaseSync(file);
  } catch {
    return null;
  }
}

/** Stamps of a folder's `.mdx` files (any case: Windows and macOS open `a.MDX` as `a.mdx`), sorted by name. */
export function folderStamps(abs: string): FileStamp[] {
  const out: FileStamp[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(abs);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".mdx")) continue;
    try {
      const st = fs.statSync(path.join(abs, name));
      if (st.isFile()) out.push({ name, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // Gone between the listing and the stat: treated as absent.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** SHA-1 over the names and bytes of the given files. */
export function folderHash(abs: string, files: FileStamp[]): string {
  const h = createHash("sha1");
  for (const f of files) {
    h.update(f.name);
    h.update("\0");
    try {
      h.update(readBytesRetry(path.join(abs, f.name)));
    } catch {
      h.update("<missing>");
    }
    h.update("\0");
  }
  return h.digest("hex");
}

/** True when every stamp was taken more than `RACY_MS` after its file's mtime. */
function settled(files: FileStamp[], stampedAt: number): boolean {
  return files.every((f) => stampedAt - f.mtimeMs > RACY_MS);
}

/** A content key from stamps alone, for entries whose stamps settled. */
function stampKey(files: FileStamp[]): string {
  return "s:" + files.map((f) => `${f.name}:${f.size}:${f.mtimeMs}`).join("|");
}

/** A folder path folded for comparing git's spelling with the file system's. */
function foldKey(rel: string): string {
  return rel.normalize("NFC").toLowerCase();
}

function sameStamps(a: FileStamp[], b: FileStamp[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name || a[i].size !== b[i].size || a[i].mtimeMs !== b[i].mtimeMs) return false;
  }
  return true;
}

/** Counters for tests and diagnostics: how the last load treated its folders. */
export type LoadStats = { folders: number; parsed: number; verified: number; trusted: number; mode: "git" | "stamps" };

/** One project's cache: entries in memory, persisted to SQLite when available. */
export class GraphCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly db: Database | null;
  private dirty = new Set<string>();
  private removed = new Set<string>();
  private keys = new WeakMap<MindPlanNode, string>();
  private readonly version: string;
  lastStats: LoadStats = { folders: 0, parsed: 0, verified: 0, trusted: 0, mode: "stamps" };
  /** Folder count from which a load asks git first (tests lower it). */
  gitModeMinFolders = GIT_MODE_MIN_FOLDERS;

  constructor(readonly root: string, packageVersion: string, opts: { persist?: boolean } = {}) {
    this.version = packageVersion;
    this.db = opts.persist === false ? null : GraphCache.openStore(root, packageVersion);
    if (this.db) {
      try {
        // Rows carry the version that parsed them, so a server of another version sharing the
        // file (another editor window, mid-upgrade) never hands this one its records.
        for (const row of this.db.prepare("SELECT folder, entry FROM entries WHERE version = ?").all(packageVersion)) {
          this.entries.set(String(row.folder), JSON.parse(String(row.entry)) as CacheEntry);
        }
      } catch {
        this.entries.clear();
      }
    }
  }

  private static openStore(root: string, version: string): Database | null {
    const dir = path.join(root, CACHE_DIRNAME);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const ignore = path.join(dir, ".gitignore");
      if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "# Derived MindPlan caches; safe to delete.\n*\n", "utf-8");
    } catch {
      return null;
    }
    const file = path.join(dir, DB_FILENAME);
    for (let attempt = 0; attempt < 2; attempt++) {
      const db = openDatabase(file);
      if (!db) return null;
      try {
        db.exec("PRAGMA busy_timeout = 3000");
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("PRAGMA synchronous = NORMAL");
        db.exec("BEGIN IMMEDIATE");
        db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        const have = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get();
        if (String(have?.value ?? "") !== GRAPH_CACHE_SCHEMA) {
          db.exec("DROP TABLE IF EXISTS entries; DELETE FROM meta;");
          db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?)").run(GRAPH_CACHE_SCHEMA);
        }
        db.exec(
          "CREATE TABLE IF NOT EXISTS entries (folder TEXT NOT NULL, version TEXT NOT NULL, entry TEXT NOT NULL, PRIMARY KEY (folder, version))"
        );
        // Rows of other versions are dropped; a server of that version still running re-adds its own.
        db.prepare("DELETE FROM entries WHERE version <> ?").run(version);
        db.exec("COMMIT");
        return db;
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // already rolled back
        }
        db.close();
        // Only a file SQLite reports as corrupt is deleted; a lock or a read-only folder is not.
        const message = err instanceof Error ? err.message : String(err);
        if (attempt === 0 && /not a database|malformed|SQLITE_NOTADB|SQLITE_CORRUPT/i.test(message)) {
          try {
            for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
          } catch {
            // Held open elsewhere (Windows): this process runs from memory.
            return null;
          }
          continue;
        }
        return null;
      }
    }
    return null;
  }

  /**
   * A key that changes whenever the folder a loaded node came from changes (its hash, or its
   * settled stamps), as of that load; null for a node this cache did not return. Lets readers key
   * memos without a stat per node.
   */
  contentKey(node: MindPlanNode): string | null {
    return this.keys.get(node) ?? null;
  }

  /**
   * Load every folder: reuse each record the freshness rule allows, re-parse the rest with
   * `parse` (whose throw propagates; nothing is cached for that folder), and drop entries for
   * folders that are gone. Returns copies, so callers may mutate them.
   */
  load<F extends FolderRef>(folders: F[], parse: (folder: F) => MindPlanNode | null, planDir: string): MindPlanNode[] {
    const stats: LoadStats = { folders: folders.length, parsed: 0, verified: 0, trusted: 0, mode: "stamps" };
    // Files modified at or after this moment may postdate git's answer, so they are never marked clean.
    const statusAt = Date.now();
    const git = folders.length >= this.gitModeMinFolders ? dirGitState(planDir, ".mdx", this.root) : null;
    const tree = git?.tree ?? null;
    if (tree) stats.mode = "git";
    // Git and the file system may spell a folder differently (case on Windows and macOS, Unicode
    // normalization on macOS), so folders match in a folded form: folding can only add matches,
    // which re-check a folder, never skip one.
    const dirtyFolders = new Set<string>();
    for (const p of git?.dirty ?? []) dirtyFolders.add(foldKey(p.split("/").slice(0, 3).join("/")));
    const changesSince = new Map<string, Set<string> | null>();
    const changedBetween = (fromTree: string, folderRel: string): boolean => {
      if (!changesSince.has(fromTree)) {
        const changes = treeChanges(fromTree, tree!, this.root);
        changesSince.set(
          fromTree,
          changes === null ? null : new Set([...changes].map((p) => foldKey(`${planDir}/${p.split("/").slice(0, 2).join("/")}`)))
        );
      }
      const changes = changesSince.get(fromTree);
      return changes == null || changes.has(foldKey(folderRel));
    };
    const cleanAtFor = (folderRel: string, files: FileStamp[]): string | null =>
      tree && !dirtyFolders.has(foldKey(folderRel)) && files.every((f) => statusAt - f.mtimeMs > RACY_MS) ? tree : null;

    const out: MindPlanNode[] = [];
    const emit = (record: MindPlanNode, e: Pick<CacheEntry, "hash" | "files">): void => {
      const node = structuredClone(record);
      this.keys.set(node, e.hash ?? stampKey(e.files));
      out.push(node);
    };
    const seen = new Set<string>();
    try {
      for (const folder of folders) {
        seen.add(folder.rel);
        const cached = this.entries.get(folder.rel);
        let entry: CacheEntry | null = null;

        if (cached && tree && cached.cleanAt !== null && !dirtyFolders.has(foldKey(folder.rel)) && !changedBetween(cached.cleanAt, folder.rel)) {
          entry = cached;
          stats.trusted++;
          if (cached.cleanAt !== tree) this.update(folder.rel, { ...cached, cleanAt: tree });
        } else {
          const stampedAt = Date.now();
          const files = folderStamps(folder.abs);
          if (cached && sameStamps(files, cached.files) && settled(files, cached.stampedAt)) {
            entry = cached;
          } else if (cached && cached.hash !== null && folderHash(folder.abs, files) === cached.hash) {
            // Settled now: the stamps alone vouch for the content from here on.
            entry = { ...cached, files, stampedAt, hash: settled(files, stampedAt) ? null : cached.hash };
          }
          if (entry) {
            stats.verified++;
            const cleanAt = cleanAtFor(folder.rel, files);
            if (entry !== cached || entry.cleanAt !== cleanAt) {
              entry = { ...entry, cleanAt };
              this.update(folder.rel, entry);
            }
          } else {
            // Hashed before the parse: a racy edit during it leaves a hash that no longer matches.
            const hash = settled(files, stampedAt) ? null : folderHash(folder.abs, files);
            let record: MindPlanNode | null;
            try {
              record = parse(folder);
            } catch (err) {
              this.forget(folder.rel);
              throw err;
            }
            stats.parsed++;
            // Cache only when the folder's stamps held still across the parse. A parse that deletes
            // a legacy duplicate also lands here once; the next load caches the settled folder.
            // A racy folder must also hash the same afterwards, so the hash describes what was parsed.
            entry = { record, files, hash, stampedAt, cleanAt: cleanAtFor(folder.rel, files) };
            const after = folderStamps(folder.abs);
            const held = sameStamps(files, after) && (hash === null || folderHash(folder.abs, after) === hash);
            if (held) this.update(folder.rel, entry);
            else this.forget(folder.rel);
            if (record) emit(record, entry);
            continue;
          }
        }
        if (entry.record) emit(entry.record, entry);
      }
      for (const rel of [...this.entries.keys()]) {
        if (!seen.has(rel)) this.forget(rel);
      }
    } finally {
      this.flush();
    }
    this.lastStats = stats;
    return out;
  }

  private forget(rel: string): void {
    if (this.entries.delete(rel)) this.removed.add(rel);
    this.dirty.delete(rel);
  }

  private update(rel: string, entry: CacheEntry): void {
    this.entries.set(rel, entry);
    this.dirty.add(rel);
    this.removed.delete(rel);
  }

  /** Write changed entries back in one transaction. A failure only costs the persistence. */
  private flush(): void {
    if (!this.db || (this.dirty.size === 0 && this.removed.size === 0)) {
      this.dirty.clear();
      this.removed.clear();
      return;
    }
    try {
      this.db.exec("BEGIN");
      const put = this.db.prepare("INSERT OR REPLACE INTO entries (folder, version, entry) VALUES (?, ?, ?)");
      const del = this.db.prepare("DELETE FROM entries WHERE folder = ? AND version = ?");
      for (const rel of this.dirty) put.run(rel, this.version, JSON.stringify(this.entries.get(rel)));
      for (const rel of this.removed) del.run(rel, this.version);
      this.db.exec("COMMIT");
    } catch {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
    }
    this.dirty.clear();
    this.removed.clear();
  }

  close(): void {
    this.db?.close();
  }
}

const caches = new Map<string, GraphCache>();

/**
 * The cache of a project root (one per process). `MINDPLAN_GRAPH_CACHE`: `off` disables it (null),
 * `git` or `stamps` forces that mode whatever the plan's size; unset chooses by size.
 */
export function graphCacheFor(root: string, packageVersion: string): GraphCache | null {
  const setting = process.env.MINDPLAN_GRAPH_CACHE;
  if (setting === "off") return null;
  const abs = path.resolve(root);
  const key = `${abs}\u0000${packageVersion}`;
  let cache = caches.get(key);
  if (!cache) {
    cache = new GraphCache(abs, packageVersion);
    caches.set(key, cache);
  }
  cache.gitModeMinFolders = setting === "git" ? 0 : setting === "stamps" ? Infinity : GIT_MODE_MIN_FOLDERS;
  return cache;
}

/** Close and forget every cache (tests). */
export function closeGraphCaches(): void {
  for (const cache of caches.values()) cache.close();
  caches.clear();
}
