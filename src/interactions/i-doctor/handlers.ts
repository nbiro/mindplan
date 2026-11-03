/**
 * Check the server's health — owned by i-doctor: doctor reports the server version, the graph root,
 * the graph's migration state, how long a graph load takes, and which derived caches exist, so a
 * slow or failed attach can be diagnosed from a tool call instead of raw stdio.
 */

import * as fs from "fs";
import * as path from "path";
import { graphStatus, type GraphState } from "../../foundations/f-graph-migrations/status.js";
import {
  lastGraphLoadFromCache,
  loadGraph,
  pendingLegacyRemovals,
  projectRoot,
} from "../../foundations/f-territory-store/store.js";
import { packageVersion } from "../../foundations/f-territory-store/version.js";
import { serverStartedAt } from "../../foundations/f-mcp-runtime/started.js";
import { DB_FILENAME } from "../../foundations/f-graph-cache/cache.js";
import { INDEX_FILENAME } from "../../foundations/f-search-index/index-db.js";
import { cacheDir } from "../../foundations/f-source-index/root-scope.js";

export type DoctorReport = {
  version: string;
  node: string;
  root: string;
  graph: { status: GraphState; level: number; server_level: number };
  /** How long a graph load took, through the graph cache (it has no bypass); 0 when not loaded. */
  load_ms_cached: number;
  /** Every node of that load came from the graph cache (no folder re-parsed). */
  cache_hit: boolean;
  load_error?: string;
  cache: { graph: boolean; search: boolean };
  started_at: string;
  uptime_s: number;
};

/**
 * The health report. Never throws. The graph loads only when graphStatus says it is current (the
 * version gate setting does not matter: a graph that needs setup or an upgrade is never read by
 * code that expects the current format), and never when a load would delete legacy files (a
 * diagnosis writes nothing): then load_ms_cached is 0 and load_error names why.
 */
export function doctor(): DoctorReport {
  const root = projectRoot();
  const status = graphStatus();
  const cache = {
    graph: fs.existsSync(path.join(cacheDir(root), DB_FILENAME)),
    search: fs.existsSync(path.join(cacheDir(root), INDEX_FILENAME)),
  };
  let loadMs = 0;
  let cacheHit = false;
  let loadError: string | undefined;
  if (status.state !== "current") {
    loadError = `not loaded: ${status.warning ?? status.state}`;
  } else {
    let legacy: string[] = [];
    try {
      legacy = pendingLegacyRemovals();
    } catch {
      legacy = [];
    }
    if (legacy.length > 0) {
      loadError = `not loaded: a load would remove legacy files beside their id-named twins (${legacy.join(", ")}); any graph tool call removes them`;
    } else {
      const start = performance.now();
      try {
        loadGraph();
        loadMs = Math.round((performance.now() - start) * 10) / 10;
        cacheHit = lastGraphLoadFromCache() === true;
      } catch (err) {
        loadError = err instanceof Error ? err.message : String(err);
      }
    }
  }
  const started = serverStartedAt();
  return {
    version: packageVersion(),
    node: process.version,
    root,
    graph: { status: status.state, level: status.level, server_level: status.required },
    load_ms_cached: loadMs,
    cache_hit: cacheHit,
    ...(loadError !== undefined ? { load_error: loadError } : {}),
    cache,
    started_at: started.toISOString(),
    uptime_s: Math.round((Date.now() - started.getTime()) / 100) / 10,
  };
}
