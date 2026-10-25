/**
 * Search settings and the per-project cache registry: which model a project uses, whether
 * semantic ranking is on, and one open `SearchIndex` per project root.
 */

import { loadProjectConfig } from "../f-source-index/config.js";
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

const indexes = new Map<string, { model: string; index: SearchIndex | null }>();
const loggedSqlite = { done: false };

/**
 * The open cache of `root` for `model`, or null without node:sqlite. One handle per root: a
 * different model closes the old handle first, so two handles never rebuild one file under each other.
 */
export function searchIndexFor(root: string, model: string): SearchIndex | null {
  const open = indexes.get(root);
  if (open && open.model === model) return open.index;
  open?.index?.close();
  let index: SearchIndex | null = null;
  try {
    index = SearchIndex.open(root, { model });
  } catch (err) {
    console.error(`MindPlan search: the cache could not open (${err instanceof Error ? err.message : String(err)}); token scoring only.`);
  }
  if (!index && !loggedSqlite.done) {
    const reason = sqliteUnavailableReason();
    if (reason) console.error(`MindPlan search: ${reason}.`);
    loggedSqlite.done = true;
  }
  indexes.set(root, { model, index });
  return index;
}

/** Close every open cache (tests, and a server that switches roots). */
export function closeSearchIndexes(): void {
  for (const { index } of indexes.values()) index?.close();
  indexes.clear();
}

/** What one search runs on: the synced cache (or null) and the ready model (or null). */
export interface SearchBackend {
  index: SearchIndex | null;
  embedder: Embedder | null;
}

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
    .finally(() => background.delete(index));
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
  if (!index) return { index: null, embedder };
  try {
    index.sync(docs);
  } catch (err) {
    console.error(`MindPlan search: the cache could not sync (${err instanceof Error ? err.message : String(err)}); token scoring only.`);
    return { index: null, embedder };
  }
  if (!embedder) return { index, embedder: null };
  const stale = index.staleVectors();
  if (stale.length === 0) return { index, embedder };
  if (stale.length > INLINE_EMBED_LIMIT && !opts.waitForVectors) {
    void embedStale(index, embedder);
    return { index, embedder: null };
  }
  await embedStale(index, embedder);
  return { index, embedder: index.staleVectors().length === 0 ? embedder : null };
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
