/**
 * Edit the project brief and config — owned by i-edit-brief: patch_project_description,
 * patch_project_rules, and patch_config.
 */

import { loadProjectConfig, writeProjectConfig } from "../../foundations/f-territory-store/store.js";
import { PROJECT_RELATIVE_PATH, writeProjectBrief } from "../../foundations/f-territory-store/project.js";
import { blocked } from "../../foundations/f-compiler-rules/rules.js";
import * as path from "path";
import {
  changedFiles,
} from "../../foundations/f-plan-writes/writes.js";

export function patchProjectDescription(args: {
  description: string;
}): Record<string, unknown> {
  if (args.description === undefined) {
    throw blocked("patch_project_description requires description.");
  }
  const result = writeProjectBrief({ description: args.description });
  return {
    path: result.path,
    description: result.description,
    rules: result.rules,
    changed_files: changedFiles([PROJECT_RELATIVE_PATH]),
  };
}

export function patchProjectRules(args: { rules: string }): Record<string, unknown> {
  if (args.rules === undefined) {
    throw blocked("patch_project_rules requires rules.");
  }
  const result = writeProjectBrief({ rules: args.rules });
  return {
    path: result.path,
    description: result.description,
    rules: result.rules,
    changed_files: changedFiles([PROJECT_RELATIVE_PATH]),
  };
}

export function patchConfig(args: {
  sources?: string[];
  exclude?: string[];
  decisions?: { blast_radius?: number; schema_files?: string[] };
  hotspots?: { half_life_days?: number; outlier_ratio?: number; min_rate?: number };
  fan_out?: { warn_at?: number };
  search?: { enabled?: boolean; model?: string };
}): Record<string, unknown> {
  if (
    args.sources === undefined &&
    args.exclude === undefined &&
    args.decisions === undefined &&
    args.hotspots === undefined &&
    args.fan_out === undefined &&
    args.search === undefined
  ) {
    throw blocked("patch_config requires sources, exclude, decisions, hotspots, fan_out, and/or search.");
  }
  const current = loadProjectConfig();
  // A decision, hotspot, fan-out, or search setting that is not passed keeps its stored value.
  const merged = <T extends object>(stored: T | undefined, passedArgs: T | undefined): Partial<T> => ({
    ...(stored ?? {}),
    ...Object.fromEntries(Object.entries(passedArgs ?? {}).filter(([, v]) => v !== undefined)),
  });
  const decisions = merged(current.decisions, args.decisions);
  const hotspots = merged(current.hotspots, args.hotspots);
  const fanOut = merged(current.fan_out, args.fan_out);
  const search = merged(current.search, args.search);
  const next = {
    sources: args.sources ?? current.sources,
    exclude: args.exclude ?? current.exclude,
    ...(Object.keys(decisions).length > 0 ? { decisions } : {}),
    ...(Object.keys(hotspots).length > 0 ? { hotspots } : {}),
    ...(Object.keys(fanOut).length > 0 ? { fan_out: fanOut } : {}),
    ...(Object.keys(search).length > 0 ? { search } : {}),
  };
  const written = writeProjectConfig(next, { force: true });
  return {
    path: written.path,
    config: written.config,
    changed_files: changedFiles([written.path]),
  };
}
