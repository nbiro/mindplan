/**
 * Edit the project brief and config — owned by i-edit-brief: patch_project_description,
 * patch_project_rules, and patch_config.
 */

import { loadProjectConfig, writeProjectConfig } from "../../foundations/f-territory-store/store.js";
import { PROJECT_RELATIVE_PATH, loadProjectBrief, writeProjectBrief } from "../../foundations/f-territory-store/project.js";
import { blocked } from "../../foundations/f-compiler-rules/rules.js";
import { rulesVersion } from "../../foundations/f-plan-views/views.js";
import * as path from "path";
import {
  changedFiles,
  projectRulesPush,
} from "../../foundations/f-plan-writes/writes.js";

export function patchProjectDescription(args: {
  description: string;
}): Record<string, unknown> {
  if (args.description === undefined) {
    throw blocked("patch_project_description requires description.");
  }
  const result = writeProjectBrief({ description: args.description });
  // The caller wrote the description and holds the rules: neither is echoed back.
  return {
    path: result.path,
    changed_files: changedFiles([PROJECT_RELATIVE_PATH]),
  };
}

/** One rule: a top-level bullet with its continuation lines, or the loose text before the first bullet. */
function splitRules(text: string): string[][] {
  const entries: string[][] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (/^[-*] /.test(line) || entries.length === 0) entries.push([line]);
    else entries[entries.length - 1].push(line);
  }
  return entries.filter((e) => e.some((l) => l.trim() !== ""));
}

/** The text a rule is matched by: its lines joined, bullet marker dropped. */
function ruleKey(entry: string[]): string {
  return entry
    .map((l) => l.trim())
    .join(" ")
    .replace(/^[-*] /, "")
    .trim();
}

function ruleBullet(text: string): string[] {
  const [first, ...rest] = text.trim().replace(/^[-*] /, "").split("\n");
  return [`- ${first}`, ...rest.map((l) => (l.trim() === "" ? "" : `  ${l.trim()}`))];
}

export function patchProjectRules(args: {
  rules?: string;
  add?: string[];
  remove?: string[];
}): Record<string, unknown> {
  const { rules, add, remove } = args;
  if (rules === undefined && add === undefined && remove === undefined) {
    throw blocked("patch_project_rules requires rules (replaces the whole text), or add / remove (change single rules).");
  }
  if (rules !== undefined && (add !== undefined || remove !== undefined)) {
    throw blocked("patch_project_rules rules replaces the whole text; do not combine it with add or remove.");
  }
  let next = rules;
  const added: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];
  if (next === undefined) {
    let entries = splitRules(loadProjectBrief().rules);
    for (const raw of remove ?? []) {
      const want = ruleKey([raw]);
      if (want === "") throw blocked("patch_project_rules remove entries must not be empty.");
      const exact = entries.filter((e) => ruleKey(e) === want);
      const hits = exact.length > 0 ? exact : entries.filter((e) => ruleKey(e).includes(want));
      if (hits.length === 0) {
        throw blocked(`patch_project_rules remove: no rule matches "${want}". Current rules: call get_rules.`);
      }
      if (hits.length > 1) {
        throw blocked(`patch_project_rules remove: "${want}" matches ${hits.length} rules; pass the full rule text.`);
      }
      entries = entries.filter((e) => e !== hits[0]);
      removed.push(ruleKey(hits[0]));
    }
    const have = new Set(entries.map(ruleKey));
    for (const raw of add ?? []) {
      const key = ruleKey([raw]);
      if (key === "") throw blocked("patch_project_rules add entries must not be empty.");
      if (have.has(key)) {
        skipped.push(key);
        continue;
      }
      have.add(key);
      entries.push(ruleBullet(raw));
      added.push(key);
    }
    next = entries.map((e) => e.join("\n").replace(/\s+$/, "")).join("\n");
  }
  const result = writeProjectBrief({ rules: next });
  // The author holds the text it just wrote: count it as served, so its own next write is not Blocked: Rules.
  projectRulesPush();
  // A confirmation, not the brief: the caller holds what it sent; get_rules returns the whole text.
  return {
    path: result.path,
    rules_version: rulesVersion(result.rules),
    count: splitRules(result.rules).length,
    ...(rules === undefined ? { added, removed } : {}),
    ...(skipped.length > 0 ? { skipped } : {}),
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
