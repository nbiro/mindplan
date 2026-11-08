/**
 * Machine checks on rules — owned by Foundation f-graph-search. Pure parsing and validation, no
 * file I/O. A rule bullet (project rules or a node's `## Rules`) may carry indented continuation
 * lines `check: {json}`, each one check of exactly one form:
 *   { "forbid_path": glob }
 *   { "forbid_pattern": regex, "in": glob, "flags"?: "imsu" }
 *   { "require_pattern": regex, "in": glob, "flags"?: "imsu" }
 *   { "command": string, "expect_exit"?: integer (default 0) }
 * The `check:` lines stay in the rule text the agent reads; run_check evaluates them.
 */

export type RuleCheck =
  | { form: "forbid_path"; glob: string; raw: string }
  | { form: "forbid_pattern"; pattern: string; flags: string; in: string; raw: string }
  | { form: "require_pattern"; pattern: string; flags: string; in: string; raw: string }
  | { form: "command"; command: string; expect_exit: number; raw: string };

/** One rule bullet and its checks. `rule` is the bullet's first line without the marker. */
export type CheckedRule = { rule: string; checks: RuleCheck[] };

/** A `check:` line that does not parse: the rule it sits under and why. */
export type RuleCheckProblem = { rule: string; line: string; problem: string };

/** An indented continuation line `check: {…}`; prose such as `check: the docs` is not a check. */
const CHECK_LINE = /^\s+check:\s*(\{.*)$/;
const BULLET = /^[-*] /;
const FORMS = ["forbid_path", "forbid_pattern", "require_pattern", "command"] as const;
const ALLOWED_FLAGS = /^[imsu]*$/;

function str(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Parse one `check:` JSON body; a string is the problem. */
export function parseRuleCheck(body: string): RuleCheck | string {
  const raw = body.trim();
  if (raw === "") return "empty check (expected a JSON object after `check:`)";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return `not valid JSON (${err instanceof Error ? err.message : String(err)})`;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "a check must be a JSON object";
  const obj = parsed as Record<string, unknown>;
  const forms = FORMS.filter((f) => f in obj);
  if (forms.length === 0) {
    return `unknown check form (keys: ${Object.keys(obj).join(", ") || "none"}); use one of ${FORMS.join(", ")}`;
  }
  if (forms.length > 1) return `one form per check, got ${forms.join(" and ")}; put each on its own check: line`;
  const form = forms[0];
  const allowed: Record<(typeof FORMS)[number], string[]> = {
    forbid_path: ["forbid_path"],
    forbid_pattern: ["forbid_pattern", "in", "flags"],
    require_pattern: ["require_pattern", "in", "flags"],
    command: ["command", "expect_exit"],
  };
  const extra = Object.keys(obj).filter((k) => !allowed[form].includes(k));
  if (extra.length > 0) return `${form} does not take ${extra.map((k) => `"${k}"`).join(", ")} (allowed: ${allowed[form].join(", ")})`;

  if (form === "forbid_path") {
    if (!str(obj.forbid_path)) return "forbid_path must be a non-empty glob string";
    return { form, glob: obj.forbid_path.trim(), raw };
  }
  if (form === "command") {
    if (!str(obj.command)) return "command must be a non-empty string";
    const exit = obj.expect_exit ?? 0;
    if (typeof exit !== "number" || !Number.isInteger(exit)) return "expect_exit must be an integer";
    return { form, command: obj.command, expect_exit: exit, raw };
  }
  const pattern = obj[form];
  if (!str(pattern)) return `${form} must be a non-empty regex string`;
  if (!str(obj.in)) return `${form} needs "in": a glob naming the files it applies to`;
  const flags = obj.flags ?? "";
  if (typeof flags !== "string" || !ALLOWED_FLAGS.test(flags)) return 'flags must be a string of i, m, s, u (e.g. "i")';
  try {
    new RegExp(pattern, flags);
  } catch (err) {
    return `invalid regex (${err instanceof Error ? err.message : String(err)})`;
  }
  return { form, pattern, flags, in: obj.in.trim(), raw };
}

/**
 * Every rule bullet that carries `check:` lines, with its parsed checks, plus each line that does
 * not parse. A `check:` line before the first bullet is a problem (it belongs to no rule).
 */
export function parseRuleChecks(text: string): { rules: CheckedRule[]; problems: RuleCheckProblem[] } {
  const rules: CheckedRule[] = [];
  const problems: RuleCheckProblem[] = [];
  let current: CheckedRule | null = null;
  for (const line of (text ?? "").replace(/\r\n/g, "\n").split("\n")) {
    if (BULLET.test(line)) {
      current = { rule: line.slice(2).trim(), checks: [] };
      rules.push(current);
      continue;
    }
    const m = CHECK_LINE.exec(line);
    if (!m) continue;
    if (!current) {
      problems.push({ rule: "(none)", line: line.trim(), problem: "a check: line must sit under a rule bullet" });
      continue;
    }
    const parsed = parseRuleCheck(m[1]);
    if (typeof parsed === "string") problems.push({ rule: current.rule, line: line.trim(), problem: parsed });
    else current.checks.push(parsed);
  }
  return { rules: rules.filter((r) => r.checks.length > 0), problems };
}

/** One line per invalid `check:` line, naming its rule; empty when every check parses. */
export function ruleCheckProblems(text: string): string[] {
  return parseRuleChecks(text).problems.map((p) => `rule "${p.rule}": ${p.problem} — in \`${p.line}\``);
}
