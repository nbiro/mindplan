/**
 * Export map MCP handler + CLI-callable view export — owned by i-export-map.
 */

import * as fs from "fs";
import * as path from "path";
import {
  MINDPLAN_DIR,
  drainRemovedLegacyFiles,
  loadGraph,
  projectRoot,
  type RemovedLegacyFile,
} from "../../foundations/f-territory-store/store.js";
import { blocked, findNode } from "../../foundations/f-compiler-rules/rules.js";
import {
  exportMindPlanView,
  type ExportMindPlanViewResult,
  type ViewFormat,
} from "../../foundations/f-view-projection/view.js";

/**
 * Largest diagram the MCP handler returns inline, in characters. Under Claude Code's 25,000-token
 * result limit and claude.ai's ~150,000 characters: a host truncates a longer result silently,
 * and a cut diagram renders nothing. The CLI path never applies it.
 */
export const EXPORT_RESULT_BUDGET = 80_000;

function buildView(args: {
  format?: ViewFormat;
  focus?: string;
  include_retired?: boolean;
  decisions?: boolean;
}): ExportMindPlanViewResult {
  const graph = loadGraph();
  if (args.focus) {
    findNode(graph, args.focus);
  }
  return exportMindPlanView(graph, {
    format: args.format ?? "mermaid",
    focus: args.focus,
    include_retired: args.include_retired ?? false,
    decisions: args.decisions ?? false,
  });
}

export type ExportMindPlanViewFileResult = Omit<ExportMindPlanViewResult, "diagram"> & {
  /** Repo-relative POSIX path the diagram was written to. */
  written_to: string;
};

/** Resolves an `output` path under the project root, outside `mindplan/`; Blocked otherwise. */
function resolveOutputPath(output: string): { absolute: string; relative: string } {
  const root = path.resolve(projectRoot());
  const absolute = path.resolve(root, output);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw blocked(`output "${output}" must be a path inside the project root.`);
  }
  const [head] = relative.split(path.sep);
  if (head === MINDPLAN_DIR) {
    throw blocked(
      `output "${output}" must not be under ${MINDPLAN_DIR}/; the MCP server is the only writer of that tree.`
    );
  }
  return { absolute, relative: relative.split(path.sep).join("/") };
}

/**
 * MCP handler. Without `output`, returns the diagram inline when it fits EXPORT_RESULT_BUDGET and
 * is Blocked with the two fixes (focus, output) when it does not. With `output`, writes the whole
 * diagram to that file and returns the counts and `written_to` instead of the diagram.
 */
export function exportMindPlanViewHandler(args: {
  format?: ViewFormat;
  focus?: string;
  include_retired?: boolean;
  decisions?: boolean;
  output?: string;
}): ExportMindPlanViewResult | ExportMindPlanViewFileResult {
  const target = args.output ? resolveOutputPath(args.output) : null;
  const result = buildView(args);
  if (target) {
    fs.mkdirSync(path.dirname(target.absolute), { recursive: true });
    fs.writeFileSync(target.absolute, result.diagram, "utf-8");
    const { diagram: _diagram, ...rest } = result;
    return { ...rest, written_to: target.relative };
  }
  if (result.diagram.length > EXPORT_RESULT_BUDGET) {
    throw blocked(
      `the diagram is ${result.diagram.length} characters, over the ${EXPORT_RESULT_BUDGET} MCP result budget. ` +
        "Pass focus for one node's neighborhood, or output to write it to a file."
    );
  }
  return result;
}

export type RunViewExportOptions = {
  format?: ViewFormat;
  focus?: string;
  include_retired?: boolean;
  /** Label each node with its active decision count. */
  decisions?: boolean;
  /** When set, write the diagram to this path instead of returning it for stdout. */
  output?: string;
};

export type RunViewExportResult = ExportMindPlanViewResult & {
  /** Absolute or relative path written when `output` was set. */
  written_to?: string;
  /** Legacy territory files deleted while loading the graph for this export. */
  removed_legacy_files: RemovedLegacyFile[];
};

/**
 * CLI-facing view export: validates focus, builds the diagram, and either
 * writes a file or returns the diagram string for the CLI to print.
 */
export function runViewExport(opts: RunViewExportOptions): RunViewExportResult {
  try {
    const result = buildView({
      format: opts.format,
      focus: opts.focus,
      include_retired: opts.include_retired,
      decisions: opts.decisions,
    });
    const removed_legacy_files = drainRemovedLegacyFiles();
    if (opts.output) {
      fs.writeFileSync(opts.output, result.diagram, "utf-8");
      return { ...result, written_to: opts.output, removed_legacy_files };
    }
    return { ...result, removed_legacy_files };
  } catch (err) {
    const removed = drainRemovedLegacyFiles();
    if (removed.length === 0) throw err;
    const note = removed.map((entry) => `Removed ${entry.from} (kept ${entry.to})`).join("\n");
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message}\n${note}`);
  }
}
