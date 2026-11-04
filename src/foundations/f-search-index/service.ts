/**
 * Search settings and the per-project cache registry: which model a project uses, whether
 * semantic ranking is on, and one open `SearchIndex` per project root.
 */

import * as path from "path";
import { loadProjectConfig } from "../f-source-index/config.js";
import { rootKey } from "../f-source-index/root-scope.js";
import { SearchIndex, sqliteUnavailableReason, type SearchDoc } from "./index-db.js";
import {
  DEFAULT_SEARCH_MODEL,
  readyEmbedder,
  warmModel,
  type Embedder,
} from "./embedder.js";

export interface SearchSettings {
  /** Semantic ranking on (keyword ranking always runs). */
  semantic: boolean;
  model: string;
}

/**
 * Settings from `mindplan/config.json` `search` (`enabled`, `model`). The environment variable
 * `MINDPLAN_SEARCH=keyword` turns semantic ranking off for one process (tests, CI). An unreadable
 * config never fails a search: it reads as the defaults.
 */
export function searchSettings(root: string): SearchSettings {
  let stored: { enabled?: boolean; model?: string } = {};
  try {
    stored = loadProjectConfig(root).search ?? {};
  } catch {
    // The check reports a broken config; search keeps working on the defaults.
  }
  return {
    semantic: stored.enabled !== false && process.env.MINDPLAN_SEARCH !== "keyword",
    model: stored.model ?? DEFAULT_SEARCH_MODEL,
  };
}

/** Open caches by root, least recently used first; at most `MAX_OPEN_INDEXES` stay open. */
const indexes = new Map<string, { model: string; index: SearchIndex | null }>();
const MAX_OPEN_INDEXES = 4;
const loggedSqlite = { done: false };

/** Async users of each handle (a search between prepare and query, a background embed). */
const holds = new Map<SearchIndex, number>();
/** Handles dropped from `indexes` while held: closed on their last release, or reused by their root first. */
const retired = new Map<SearchIndex, { key: string; model: string }>();

/** Marks `index` in use until the returned release is called (once). */
function hold(index: SearchIndex): () => void {
  holds.set(index, (holds.get(index) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (holds.get(index) ?? 1) - 1;
    if (left > 0) {
      holds.set(index, left);
      return;
    }
    holds.delete(index);
    if (retired.delete(index)) index.close();
  };
}

/** Closes a handle dropped from `indexes` now, or on its last release while an async user holds it. */
function closeWhenIdle(key: string, entry: { model: string; index: SearchIndex | null }): void {
  if (!entry.index) return;
  if (holds.has(entry.index)) retired.set(entry.index, { key, model: entry.model });
  else entry.index.close();
}

/**
 * The open cache of `root` for `model`, or null without node:sqlite. One handle per root: a
 * different model closes the old handle first, so two handles never rebuild one file under each other.
 * Beyond the last four roots used, the least recently used handle is closed, once no async user
 * holds it; a root asked for again while its dropped handle is still open gets that handle back.
 */
export function searchIndexFor(rootPath: string, model: string): SearchIndex | null {
  const root = path.resolve(rootPath);
  const key = rootKey(root);
  const open = indexes.get(key);
  if (open) indexes.delete(key);
  if (open && open.model === model) {
    indexes.set(key, open);
    return open.index;
  }
  if (open) closeWhenIdle(key, open);
  let index: SearchIndex | null = null;
  for (const [kept, r] of retired) {
    if (r.key === key && r.model === model) {
      retired.delete(kept);
      index = kept;
      break;
    }
  }
  if (!index) {
    try {
      index = SearchIndex.open(root, { model });
    } catch (err) {
      console.error(`MindPlan search: the cache could not open (${err instanceof Error ? err.message : String(err)}); token scoring only.`);
    }
  }
  if (!index && !loggedSqlite.done) {
    const reason = sqliteUnavailableReason();
    if (reason) console.error(`MindPlan search: ${reason}.`);
    loggedSqlite.done = true;
  }
  indexes.set(key, { model, index });
  for (const [oldest, evicted] of indexes) {
    if (indexes.size <= MAX_OPEN_INDEXES) break;
    indexes.delete(oldest);
    closeWhenIdle(oldest, evicted);
  }
  return index;
}

/** Close every open cache (tests, and a server that switches roots). */
export function closeSearchIndexes(): void {
  for (const { index } of indexes.values()) index?.close();
  for (const index of retired.keys()) index.close();
  indexes.clear();
  retired.clear();
  holds.clear();
}

/**
 * What one search runs on: the synced cache (or null) and the ready model (or null). The cache is
 * held for the caller until `release` (eviction leaves it open meanwhile); call it once done.
 */
export interface SearchBackend {
  index: SearchIndex | null;
  embedder: Embedder | null;
  release: () => void;
}

const noRelease = () => {};

/**
 * At most this many changed nodes are embedded inside a search call; more (a cold cache, a branch
 * switch) are embedded in the background and that search is keyword-only, so a call never waits
 * on a full re-index.
 */
export const INLINE_EMBED_LIMIT = 24;

const background = new Map<SearchIndex, Promise<void>>();

/** Embed every stale vector of `index` with `embedder`, once at a time per index. */
export function embedStale(index: SearchIndex, embedder: Embedder): Promise<void> {
  const running = background.get(index);
  if (running) return running;
  const release = hold(index);
  const run = (async () => {
    for (;;) {
      const stale = index.staleVectors();
      if (stale.length === 0) return;
      const batch = stale.slice(0, 64);
      const vectors = await embedder.embed(
        batch.map((s) => s.text),
        "passage"
      );
      index.putVectors(batch.map((s, i) => ({ id: s.id, hash: s.hash, vector: vectors[i] })));
    }
  })()
    .catch((err: unknown) => {
      console.error(`MindPlan search: embedding failed (${err instanceof Error ? err.message : String(err)}).`);
    })
    .finally(() => {
      background.delete(index);
      release();
    });
  background.set(index, run);
  return run;
}

/**
 * Sync the cache of `root` with `docs` and return what a search can use now. With semantic
 * ranking on, starts the model in the background; once it is ready, embeds a few changed nodes
 * inline and defers a larger batch (that search then gets `embedder: null`).
 * `embedder` overrides the model (tests pass fixture vectors); `waitForVectors` embeds every stale
 * node before returning.
 */
export async function prepareSearch(
  root: string,
  docs: SearchDoc[],
  opts: { embedder?: Embedder | null; settings?: SearchSettings; waitForVectors?: boolean } = {}
): Promise<SearchBackend> {
  const settings = opts.settings ?? searchSettings(root);
  let embedder: Embedder | null = null;
  if (opts.embedder !== undefined) {
    embedder = opts.embedder;
  } else if (settings.semantic) {
    embedder = readyEmbedder(settings.model);
    if (!embedder) void warmModel(settings.model);
  }
  const index = searchIndexFor(root, embedder?.model ?? settings.model);
  if (!index) return { index: null, embedder, release: noRelease };
  const release = hold(index);
  try {
    index.sync(docs);
  } catch (err) {
    console.error(`MindPlan search: the cache could not sync (${err instanceof Error ? err.message : String(err)}); token scoring only.`);
    release();
    return { index: null, embedder, release: noRelease };
  }
  if (!embedder) return { index, embedder: null, release };
  const stale = index.staleVectors();
  if (stale.length === 0) return { index, embedder, release };
  if (stale.length > INLINE_EMBED_LIMIT && !opts.waitForVectors) {
    void embedStale(index, embedder);
    return { index, embedder: null, release };
  }
  await embedStale(index, embedder);
  return { index, embedder: index.staleVectors().length === 0 ? embedder : null, release };
}

/**
 * Background warm-up for a server start: load the model, then sync and embed the whole graph.
 * Never rejects; `docs` is called once the model is ready so it reads the graph as it is then.
 */
export async function warmSearch(root: string, docs: () => SearchDoc[]): Promise<void> {
  try {
    const settings = searchSettings(root);
    if (!settings.semantic) {
      searchIndexFor(root, settings.model)?.sync(docs());
      return;
    }
    await warmModel(settings.model);
    const embedder = readyEmbedder(settings.model);
    const index = searchIndexFor(root, settings.model);
    if (!index) return;
    index.sync(docs());
    if (embedder) await embedStale(index, embedder);
  } catch (err) {
    console.error(`MindPlan search: warm-up failed (${err instanceof Error ? err.message : String(err)}).`);
  }
}

/** After a graph write: sync rows now and embed the changes in the background. Never throws. */
export function refreshSearch(root: string, docs: SearchDoc[]): void {
  try {
    const settings = searchSettings(root);
    const embedder = settings.semantic ? readyEmbedder(settings.model) : null;
    const index = searchIndexFor(root, settings.model);
    if (!index) return;
    index.sync(docs);
    if (embedder) void embedStale(index, embedder);
  } catch (err) {
    console.error(`MindPlan search: the cache could not refresh (${err instanceof Error ? err.message : String(err)}).`);
  }
}
