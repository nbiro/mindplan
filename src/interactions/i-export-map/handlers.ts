/**
 * Export map MCP handler + CLI-callable view export — owned by i-export-map.
 */

import * as fs from "fs";
import { loadGraph } from "../../foundations/f-territory-store/store.js";
import { findNode } from "../../foundations/f-compiler-rules/rules.js";
import {
  exportMindPlanView,
  type ExportMindPlanViewResult,
  type ViewFormat,
} from "../../foundations/f-view-projection/view.js";

export function exportMindPlanViewHandler(args: {
  format?: ViewFormat;
  focus?: string;
  include_retired?: boolean;
}): ExportMindPlanViewResult {
  const graph = loadGraph();
  if (args.focus) {
    findNode(graph, args.focus);
  }
  return exportMindPlanView(graph, {
    format: args.format ?? "mermaid",
    focus: args.focus,
    include_retired: args.include_retired ?? false,
  });
}

export type RunViewExportOptions = {
  format?: ViewFormat;
  focus?: string;
  include_retired?: boolean;
  /** When set, write the diagram to this path instead of returning it for stdout. */
  output?: string;
};

export type RunViewExportResult = ExportMindPlanViewResult & {
  /** Absolute or relative path written when `output` was set. */
  written_to?: string;
};

/**
 * CLI-facing view export: validates focus, builds the diagram, and either
 * writes a file or returns the diagram string for the CLI to print.
 */
export function runViewExport(opts: RunViewExportOptions): RunViewExportResult {
  const result = exportMindPlanViewHandler({
    format: opts.format,
    focus: opts.focus,
    include_retired: opts.include_retired,
  });
  if (opts.output) {
    fs.writeFileSync(opts.output, result.diagram, "utf-8");
    return { ...result, written_to: opts.output };
  }
  return result;
}
