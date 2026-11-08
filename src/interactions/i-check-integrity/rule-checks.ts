/**
 * Rule checks in run_check — owned by Interaction i-check-integrity. Evaluates the `check:` lines
 * of project rules (over the source universe) and node rules (over the owned files of every active
 * Foundation, Interaction, or Interface the rule reaches through `resolveNodeRules`). Each failed
 * check is one `Blocked: Rule: ` failure; command checks run only when `rule_checks.commands`
 * allows it, else one info line counts them. Rules without `check:` lines add nothing.
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { MindPlanGraph } from "../../foundations/f-domain-model/types.js";
import { isInactiveNode, isPipelineNodeType } from "../../foundations/f-domain-model/types.js";
import { resolveNodeRules } from "../../foundations/f-graph-search/rules.js";
import { parseRuleChecks, type RuleCheck } from "../../foundations/f-graph-search/rule-checks.js";
import { nodeOwnedFiles } from "../../foundations/f-source-index/ownership.js";
import { matchGlob } from "../../foundations/f-source-index/universe.js";
import { ruleChecksSettings, type MindPlanProjectConfig } from "../../foundations/f-source-index/config.js";

/** Matching lines (or files) listed per failure before `+N more`. */
const EVIDENCE_CAP = 5;
const LINE_CHARS = 160;
const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_TAIL_LINES = 20;
/** Files larger than this are not scanned (generated bundles, data dumps). */
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

/** One rule check to evaluate: its source (`project` or a node id), rule text, and files in scope. */
type Job = { source: string; rule: string; check: RuleCheck; files: Set<string> };

function readText(root: string, rel: string): string | null {
  try {
    const abs = path.join(root, rel);
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return null;
    const text = fs.readFileSync(abs, "utf-8");
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

function cut(line: string): string {
  const t = line.trim();
  return t.length > LINE_CHARS ? `${t.slice(0, LINE_CHARS - 1)}…` : t;
}

/** The regex a pattern check runs: global, `^`/`$` at line boundaries; a match may span lines. */
function patternRegex(pattern: string, flags: string): RegExp {
  return new RegExp(pattern, [...new Set(`${flags}gm`)].join(""));
}

/** 1-based line numbers where matches of `re` start in `text`, ascending and unique. */
function matchLines(text: string, re: RegExp): number[] {
  const lines = new Set<number>();
  re.lastIndex = 0;
  let line = 1;
  let scanned = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    for (; scanned < m.index; scanned++) if (text.charCodeAt(scanned) === 10) line++;
    lines.add(line);
    if (m[0].length === 0) re.lastIndex++;
  }
  return [...lines];
}

function evidence(items: string[]): string {
  const shown = items.slice(0, EVIDENCE_CAP).map((i) => `\n  ${i}`);
  const more = items.length > EVIDENCE_CAP ? `\n  +${items.length - EVIDENCE_CAP} more` : "";
  return shown.join("") + more;
}

function failureLine(job: Job, detail: string, items: string[]): string {
  return `Blocked: Rule: ${job.source} — "${job.rule}" check ${job.check.raw}: ${detail}${evidence(items)}`;
}

function evaluateFiles(job: Job, root: string): string | null {
  const check = job.check;
  const files = [...job.files].sort((a, b) => a.localeCompare(b));
  if (check.form === "forbid_path") {
    const hits = files.filter((f) => matchGlob(check.glob, f));
    return hits.length > 0 ? failureLine(job, `${hits.length} forbidden path(s)`, hits) : null;
  }
  if (check.form === "command") return null;
  const inScope = files.filter((f) => matchGlob(check.in, f));
  const re = patternRegex(check.pattern, check.flags);
  if (check.form === "forbid_pattern") {
    const hits: string[] = [];
    for (const file of inScope) {
      const text = readText(root, file);
      if (text === null) continue;
      const all = text.split(/\r?\n/);
      for (const n of matchLines(text, re)) hits.push(`${file}:${n}: ${cut(all[n - 1] ?? "")}`);
    }
    return hits.length > 0 ? failureLine(job, `${hits.length} matching line(s)`, hits) : null;
  }
  const lacking: string[] = [];
  for (const file of inScope) {
    const text = readText(root, file);
    if (text === null) continue;
    re.lastIndex = 0;
    if (!re.test(text)) lacking.push(file);
  }
  return lacking.length > 0 ? failureLine(job, `${lacking.length} file(s) lack a match`, lacking) : null;
}

function runCommand(job: Job, root: string): string | null {
  if (job.check.form !== "command") return null;
  const { command, expect_exit } = job.check;
  const res = spawnSync(command, {
    cwd: root,
    shell: true,
    encoding: "utf-8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.replace(/\s+$/, "");
  const tail = output === "" ? [] : output.split(/\r?\n/).slice(-COMMAND_TAIL_LINES);
  const timedOut = (res.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || res.signal === "SIGTERM";
  if (timedOut) return failureLine(job, `timed out after ${COMMAND_TIMEOUT_MS / 1000} s`, tail);
  if (res.error) return failureLine(job, `could not run (${res.error.message})`, tail);
  if (res.status === expect_exit) return null;
  const shown = tail.map((l) => `| ${l}`);
  return `Blocked: Rule: ${job.source} — "${job.rule}" check ${job.check.raw}: exit ${res.status ?? "none"}, expected ${expect_exit}` +
    (shown.length ? `\n  ${shown.join("\n  ")}` : "");
}

/** Whether command checks run now: `always`, or `local` outside CI. */
function commandsRun(mode: string): boolean {
  if (mode === "always") return true;
  return mode === "local" && !process.env.CI;
}

/**
 * Every rule-check failure and info line for the graph. `projectRules` is the project brief's rules
 * text; `universe` the configured source files. Empty when no rule carries a `check:` line.
 */
export function ruleCheckFindings(
  graph: MindPlanGraph,
  root: string,
  projectRules: string,
  universe: string[],
  config: MindPlanProjectConfig
): { failures: string[]; info: string[] } {
  const failures: string[] = [];
  const jobs = new Map<string, Job>();
  const addJobs = (source: string, text: string, files: string[]) => {
    const parsed = parseRuleChecks(text);
    for (const p of parsed.problems) {
      const line = `Blocked: Rule: ${source} — "${p.rule}" has an invalid check (${p.problem}): ${p.line}`;
      if (!failures.includes(line)) failures.push(line);
    }
    for (const { rule, checks } of parsed.rules) {
      for (const check of checks) {
        const key = JSON.stringify([source, rule, check.raw]);
        const job = jobs.get(key) ?? { source, rule, check, files: new Set<string>() };
        for (const f of files) job.files.add(f);
        jobs.set(key, job);
      }
    }
  };

  addJobs("project", projectRules, universe);
  for (const node of graph.nodes) {
    if (!isPipelineNodeType(node.type) || isInactiveNode(node)) continue;
    const entries = resolveNodeRules(graph, node.id).filter((e) => /^\s+check:/m.test(e.rules));
    if (entries.length === 0) continue;
    const owned = nodeOwnedFiles(node, root);
    const files = [
      ...owned.files,
      ...(owned.next_files ?? []),
      ...Object.values(owned.revision_files ?? {}).flat(),
    ];
    for (const entry of entries) addJobs(entry.node_id, entry.rules, files);
  }

  const mode = ruleChecksSettings(config).commands;
  let skipped = 0;
  for (const job of jobs.values()) {
    if (job.check.form === "command") {
      if (!commandsRun(mode)) {
        skipped++;
        continue;
      }
      const line = runCommand(job, root);
      if (line) failures.push(line);
      continue;
    }
    const line = evaluateFiles(job, root);
    if (line) failures.push(line);
  }
  const why = mode === "local" ? `"local" and CI is set` : `"${mode}"`;
  const info = skipped > 0 ? [`rule checks: ${skipped} command check(s) skipped (rule_checks.commands is ${why})`] : [];
  return { failures, info };
}
