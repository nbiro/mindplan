/**
 * Check the server's health — owned by i-doctor: doctor reports the server version, the graph root,
 * the graph's migration state, how long a graph load takes, and which derived caches exist, so a
 * slow or failed attach can be diagnosed from a tool call instead of raw stdio.
 */

import * as fs from "fs";
import * as path from "path";
import { graphStatus, type GraphState } from "../../foundations/f-graph-migrations/status.js";
import { loadGraph, projectRoot } from "../../foundations/f-territory-store/store.js";
import { packageVersion } from "../../foundations/f-territory-store/version.js";
import { serverStartedAt } from "../../foundations/f-mcp-runtime/started.js";

export type DoctorReport = {
  version: string;
  node: string;
  root: string;
  graph: { status: GraphState; level: number; server_level: number };
  load_ms: number;
  load_error?: string;
  cache: { graph: boolean; search: boolean };
  started_at: string;
  uptime_s: number;
};

/** Derived caches live beside the graph, in the project root. */
const CACHE_DIRNAME = ".mindplan-cache";

/**
 * The health report. Never throws. The graph loads only when it is current: a graph that needs
 * setup or an upgrade is not read by code that expects the current format, so its load_ms is 0
 * and load_error names the fix.
 */
export function doctor(): DoctorReport {
  const root = projectRoot();
  const status = graphStatus();
  const cacheDir = path.join(root, CACHE_DIRNAME);
  const cache = {
    graph: fs.existsSync(path.join(cacheDir, "graph.db")),
    search: fs.existsSync(path.join(cacheDir, "index.db")),
  };
  let loadMs = 0;
  let loadError: string | undefined;
  if (status.state === "current" || process.env.MINDPLAN_VERSION_GATE === "off") {
    const start = performance.now();
    try {
      loadGraph();
      loadMs = Math.round((performance.now() - start) * 10) / 10;
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    }
  } else {
    loadError = `not loaded: ${status.warning ?? status.state}`;
  }
  const started = serverStartedAt();
  return {
    version: packageVersion(),
    node: process.version,
    root,
    graph: { status: status.state, level: status.level, server_level: status.required },
    load_ms: loadMs,
    ...(loadError !== undefined ? { load_error: loadError } : {}),
    cache,
    started_at: started.toISOString(),
    uptime_s: Math.round((Date.now() - started.getTime()) / 100) / 10,
  };
}
