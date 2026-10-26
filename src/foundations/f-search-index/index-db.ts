/**
 * The derived search cache: `.mindplan-cache/index.db` (node:sqlite). Node rows, an FTS5 keyword
 * index, one normalized embedding vector per node, and edges. The `<id>.mdx` files stay the only
 * source of truth: every search re-syncs this cache from the loaded graph, and the whole file can
 * be deleted at any time.
 */

import { createHash } from "crypto";
import * as fs from "fs";
import { createRequire } from "module";
import * as path from "path";

/** Bump when the tables or the indexed text change; a mismatch drops and rebuilds the cache. */
export const INDEX_SCHEMA_VERSION = "3";

export const CACHE_DIRNAME = ".mindplan-cache";
export const INDEX_FILENAME = "index.db";

/** One node as search sees it: the fields that are indexed and embedded. */
export interface SearchDoc {
  id: string;
  type: string;
  state: string;
  title: string;
  description: string;
  /** Titles of the Journeys the node belongs to (directly or through what it exposes or affects). */
  area: string[];
  /** Titles of the Interfaces that expose the node (an Interaction's entry points). */
  entry: string[];
  aliases: string[];
  /** `##` headings of the active body, scaffold headings left out. */
  headings: string[];
  /** Claimed paths (`implements`). */
  paths: string[];
  /** Retired nodes are indexed but never ranked. */
  retired: boolean;
  edges: { target: string; type: string }[];
}

/** Text embedded for one node: what it is, in the words a query would use. */
export function embedText(doc: SearchDoc): string {
  const parts = [`${doc.type}: ${doc.title}.`];
  if (doc.description) parts.push(`${doc.description.replace(/\.$/, "")}.`);
  if (doc.area.length) parts.push(`Area: ${doc.area.join(", ")}.`);
  if (doc.entry.length) parts.push(`Entry points: ${doc.entry.join(", ")}.`);
  if (doc.aliases.length) parts.push(`Aliases: ${doc.aliases.join(", ")}.`);
  if (doc.headings.length) parts.push(`Sections: ${doc.headings.join(", ")}.`);
  return parts.join(" ");
}

/** `i-send-enquiry` → `i send enquiry`; `src/a/b-c.ts` → `src a b c ts`. */
export function splitWords(text: string): string {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join(" ");
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/** Hash of everything the keyword row and edge rows hold. */
function rowHash(doc: SearchDoc): string {
  return sha1(
    JSON.stringify([
      doc.type,
      doc.state,
      doc.title,
      doc.description,
      doc.area,
      doc.entry,
      doc.aliases,
      doc.headings,
      doc.paths,
      doc.retired,
      doc.edges,
    ])
  );
}

const STOPWORDS = new Set(
  "a an and are as at be by for from has have how i in into is it its of on or that the this to was what when where which who why will with".split(
    " "
  )
);

/** FTS5 MATCH expression: the query's words OR'd, each quoted so no word is read as syntax. */
export function ftsQuery(query: string): string | null {
  // Letters of any script count (an alias like "ofertă"); FTS5's unicode61 folds the diacritics.
  const words = query
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((w) => w && !STOPWORDS.has(w));
  if (words.length === 0) return null;
  return [...new Set(words)].map((w) => `"${w}"`).join(" OR ");
}

type Row = Record<string, unknown>;

interface Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
}

interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

type DatabaseCtor = new (file: string) => Database;

let sqliteCtor: DatabaseCtor | null | undefined;
let sqliteNote: string | null = null;

/** node:sqlite's DatabaseSync, or null (with a reason) on a runtime without it. */
function loadSqlite(): DatabaseCtor | null {
  if (sqliteCtor !== undefined) return sqliteCtor;
  try {
    const require = createRequire(import.meta.url);
    sqliteCtor = (require("node:sqlite") as { DatabaseSync: DatabaseCtor }).DatabaseSync;
  } catch (err) {
    sqliteCtor = null;
    sqliteNote = `node:sqlite is unavailable (${err instanceof Error ? err.message : String(err)}); search uses token scoring`;
  }
  return sqliteCtor;
}

/** Why the cache could not open, once; null while it works. */
export function sqliteUnavailableReason(): string | null {
  loadSqlite();
  return sqliteNote;
}

/** The cache directory of a project, with a `.gitignore` inside so git never lists it. */
export function cacheDir(root: string): string {
  return path.join(root, CACHE_DIRNAME);
}

function ensureCacheDir(root: string): string {
  const dir = cacheDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) {
    fs.writeFileSync(ignore, "# Derived MindPlan search cache; safe to delete.\n*\n", "utf-8");
  }
  return dir;
}

export interface IndexIdentity {
  /** Embedding model id; vectors from another model are dropped. */
  model: string;
}

/** SQLite's "not a database" / "malformed" errors: the only ones that justify deleting the file. */
function isCorruptFileError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /not a database|malformed|file is encrypted|SQLITE_NOTADB|SQLITE_CORRUPT/i.test(message);
}

/**
 * One open cache. Keyword rows are synced synchronously from the graph on every search; vectors
 * live in memory and are written back as they are computed. When another connection (a second
 * server on the same repo) has written the file, the in-memory view is reloaded before the next
 * sync, so neither process works from a stale picture of the rows.
 */
export class SearchIndex {
  readonly fts: boolean;
  private readonly db: Database;
  private readonly hashes = new Map<string, string>();
  /** id → { hash of embedText, unit vector } for the current model. */
  private readonly vectors = new Map<string, { hash: string; vector: Float32Array }>();
  private docs = new Map<string, SearchDoc>();
  private dataVersion = -1;
  private stale = true;

  private constructor(db: Database, fts: boolean, readonly identity: IndexIdentity) {
    this.db = db;
    this.fts = fts;
  }

  /**
   * Open (or create) the cache of `root`; `file: ":memory:"` keeps it in memory. Returns null when
   * node:sqlite is missing. A file SQLite reports as corrupt is deleted and created again; any
   * other failure (a lock held past the busy timeout, a read-only folder) leaves the file alone and
   * the cache lives in memory for this process.
   */
  static open(root: string, identity: IndexIdentity, opts: { file?: string } = {}): SearchIndex | null {
    const Ctor = loadSqlite();
    if (!Ctor) return null;
    let file = opts.file ?? ":memory:";
    try {
      if (!opts.file) file = path.join(ensureCacheDir(root), INDEX_FILENAME);
      return SearchIndex.openFile(Ctor, file, identity);
    } catch (err) {
      if (file !== ":memory:" && isCorruptFileError(err)) {
        try {
          for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
          return SearchIndex.openFile(Ctor, file, identity);
        } catch {
          // fall through to memory
        }
      }
      return SearchIndex.openFile(Ctor, ":memory:", identity);
    }
  }

  private static openFile(Ctor: DatabaseCtor, file: string, identity: IndexIdentity): SearchIndex {
    const db = new Ctor(file);
    try {
      db.exec("PRAGMA busy_timeout = 3000");
      if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
      // The meta check, a rebuild, and the table creation run in one write transaction, so two
      // servers opening a new or outdated file at once cannot interleave their rebuilds.
      db.exec("BEGIN IMMEDIATE");
      let fts = true;
      try {
        db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        const want: Record<string, string> = { schema: INDEX_SCHEMA_VERSION, model: identity.model };
        const have = new Map(
          db.prepare("SELECT key, value FROM meta").all().map((r) => [String(r.key), String(r.value)])
        );
        if (Object.entries(want).some(([k, v]) => have.get(k) !== v)) {
          db.exec(
            "DROP TABLE IF EXISTS nodes; DROP TABLE IF EXISTS nodes_fts; DROP TABLE IF EXISTS node_vec; " +
              "DROP TABLE IF EXISTS edges; DELETE FROM meta;"
          );
          const put = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
          for (const [k, v] of Object.entries(want)) put.run(k, v);
        }
        db.exec(`
        CREATE TABLE IF NOT EXISTS nodes (
          rowid INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, state TEXT NOT NULL, title TEXT NOT NULL,
          description TEXT NOT NULL, area TEXT NOT NULL, content_hash TEXT NOT NULL, retired INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS node_vec (id TEXT PRIMARY KEY, text_hash TEXT NOT NULL, vector BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS edges (source TEXT NOT NULL, target TEXT NOT NULL, type TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS edges_source ON edges (source);
        CREATE INDEX IF NOT EXISTS edges_target ON edges (target);
      `);
        try {
          db.exec(
            "CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(" +
              "id_words, title, description, aliases, headings, area, entry, paths, tokenize = 'porter unicode61')"
          );
        } catch {
          fts = false;
        }
        db.exec("COMMIT");
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // already rolled back
        }
        throw err;
      }
      return new SearchIndex(db, fts, identity);
    } catch (err) {
      db.close();
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  /** Reload hashes and vectors when the file changed under this connection (or after an error). */
  private refreshView(): void {
    const version = Number(this.db.prepare("PRAGMA data_version").get()?.data_version ?? 0);
    if (!this.stale && version === this.dataVersion) return;
    this.hashes.clear();
    for (const row of this.db.prepare("SELECT id, content_hash FROM nodes").all()) {
      this.hashes.set(String(row.id), String(row.content_hash));
    }
    this.vectors.clear();
    for (const row of this.db.prepare("SELECT id, text_hash, vector FROM node_vec").all()) {
      const vector = blobToVector(row.vector);
      // A damaged blob is left out: the node reads as stale and is embedded again.
      if (vector) this.vectors.set(String(row.id), { hash: String(row.text_hash), vector });
    }
    this.dataVersion = version;
    this.stale = false;
  }

  /**
   * Bring the rows in line with `docs`: write the changed ones, delete the ones that are gone.
   * Cheap when nothing changed (one hash per node). Returns the ids written and removed.
   */
  sync(docs: SearchDoc[]): { changed: string[]; removed: string[] } {
    this.refreshView();
    const next = new Map(docs.map((d) => [d.id, d]));
    const changed: string[] = [];
    const removed: string[] = [];
    const pending: { doc: SearchDoc; hash: string }[] = [];
    for (const doc of docs) {
      const hash = rowHash(doc);
      if (this.hashes.get(doc.id) !== hash) pending.push({ doc, hash });
    }
    const gone = [...this.hashes.keys()].filter((id) => !next.has(id));
    this.docs = next;
    if (pending.length === 0 && gone.length === 0) return { changed, removed };

    const upsert = this.db.prepare(
      "INSERT INTO nodes (id, type, state, title, description, area, content_hash, retired) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET type = excluded.type, state = excluded.state, title = excluded.title, " +
        "description = excluded.description, area = excluded.area, content_hash = excluded.content_hash, retired = excluded.retired"
    );
    const rowidOf = this.db.prepare("SELECT rowid FROM nodes WHERE id = ?");
    // Rowids are looked up at write time, never remembered: another connection may have reused one.
    const delFts = this.fts
      ? this.db.prepare("DELETE FROM nodes_fts WHERE rowid = (SELECT rowid FROM nodes WHERE id = ?)")
      : null;
    const addFts = this.fts
      ? this.db.prepare(
          "INSERT INTO nodes_fts (rowid, id_words, title, description, aliases, headings, area, entry, paths) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
      : null;
    const delEdges = this.db.prepare("DELETE FROM edges WHERE source = ?");
    const addEdge = this.db.prepare("INSERT INTO edges (source, target, type) VALUES (?, ?, ?)");
    const delNode = this.db.prepare("DELETE FROM nodes WHERE id = ?");
    const delVec = this.db.prepare("DELETE FROM node_vec WHERE id = ?");

    this.db.exec("BEGIN");
    try {
      for (const { doc, hash } of pending) {
        delFts?.run(doc.id);
        upsert.run(
          doc.id,
          doc.type,
          doc.state,
          doc.title,
          doc.description,
          doc.area.join(", "),
          hash,
          doc.retired ? 1 : 0
        );
        if (addFts) {
          addFts.run(
            Number(rowidOf.get(doc.id)!.rowid),
            splitWords(doc.id),
            doc.title,
            doc.description,
            doc.aliases.join(" | "),
            doc.headings.join(" | "),
            doc.area.join(" | "),
            doc.entry.join(" | "),
            doc.paths.map(splitWords).join(" | ")
          );
        }
        delEdges.run(doc.id);
        for (const e of doc.edges) addEdge.run(doc.id, e.target, e.type);
        changed.push(doc.id);
      }
      for (const id of gone) {
        delFts?.run(id);
        delEdges.run(id);
        delNode.run(id);
        delVec.run(id);
        removed.push(id);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // SQLite may already have rolled back (disk full, I/O error).
      }
      // Forget what this process believes; the next sync reloads it from the file.
      this.stale = true;
      throw err;
    }
    for (const { doc, hash } of pending) this.hashes.set(doc.id, hash);
    for (const id of gone) {
      this.hashes.delete(id);
      this.vectors.delete(id);
    }
    return { changed, removed };
  }

  /**
   * Keyword ranking by FTS5 bm25 over live (non-retired) rows of `type` and within `ids` when
   * given: ids in rank order, kept to `candidates`. Null when FTS5 is missing, so the caller falls back to token scoring.
   */
  keyword(
    query: string,
    candidates: Set<string>,
    limit: number,
    opts: { type?: string; ids?: string[] } = {}
  ): string[] | null {
    if (!this.fts) return null;
    const match = ftsQuery(query);
    if (!match) return [];
    // An area's members are filtered in SQL too, so the row limit applies after the filter.
    const ids = opts.ids ? JSON.stringify(opts.ids) : null;
    // Column weights: id words, title, description, aliases, headings, area, entry points, paths.
    const rows = this.db
      .prepare(
        "SELECT n.id AS id FROM nodes_fts JOIN nodes n ON n.rowid = nodes_fts.rowid " +
          "WHERE nodes_fts MATCH ? AND n.retired = 0 AND (? IS NULL OR n.type = ?) " +
          "AND (? IS NULL OR n.id IN (SELECT value FROM json_each(?))) " +
          "ORDER BY bm25(nodes_fts, 6.0, 8.0, 3.0, 8.0, 1.5, 1.0, 0.5, 1.5) LIMIT ?"
      )
      .all(match, opts.type ?? null, opts.type ?? null, ids, ids, limit * 4);
    const out: string[] = [];
    for (const row of rows) {
      const id = String(row.id);
      if (!candidates.has(id)) continue;
      out.push(id);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Docs of the last sync whose stored vector is missing or was made from other text. */
  staleVectors(): { id: string; text: string; hash: string }[] {
    const out: { id: string; text: string; hash: string }[] = [];
    for (const doc of this.docs.values()) {
      if (doc.retired) continue;
      const text = embedText(doc);
      // The model is part of the hash: a vector another process wrote with an older model is stale.
      const hash = sha1(`${this.identity.model}\u0000${text}`);
      if (this.vectors.get(doc.id)?.hash !== hash) out.push({ id: doc.id, text, hash });
    }
    return out;
  }

  /**
   * Store computed vectors (normalized here) in memory and in the file. A row for a node the last
   * sync no longer has (removed while it was being embedded) is dropped.
   */
  putVectors(rows: { id: string; hash: string; vector: Float32Array }[]): void {
    const live = rows.filter((row) => this.docs.has(row.id) && row.vector.length > 0);
    if (live.length === 0) return;
    const put = this.db.prepare(
      "INSERT INTO node_vec (id, text_hash, vector) VALUES (?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET text_hash = excluded.text_hash, vector = excluded.vector"
    );
    this.db.exec("BEGIN");
    try {
      for (const row of live) put.run(row.id, row.hash, vectorToBlob(normalize(row.vector)));
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      this.stale = true;
      throw err;
    }
    for (const row of live) this.vectors.set(row.id, { hash: row.hash, vector: normalize(row.vector) });
  }

  /** Cosine similarity (a dot product of unit vectors) over `candidates`, best first. */
  semantic(
    query: Float32Array,
    candidates: Set<string>,
    limit: number
  ): { id: string; score: number }[] {
    const q = normalize(query);
    const out: { id: string; score: number }[] = [];
    for (const id of candidates) {
      const v = this.vectors.get(id)?.vector;
      // A vector of another size (a model change written by another process) is skipped.
      if (!v || v.length !== q.length) continue;
      let dot = 0;
      for (let i = 0; i < v.length; i++) dot += v[i] * q[i];
      out.push({ id, score: dot });
    }
    out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return out.slice(0, limit);
  }
}

function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  if (norm === 0 || Math.abs(norm - 1) < 1e-6) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

function vectorToBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

/** The stored Float32 vector, or null for a blob that is not one (empty, or not a multiple of 4 bytes). */
function blobToVector(blob: unknown): Float32Array | null {
  const bytes = blob as Uint8Array;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) return null;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}
