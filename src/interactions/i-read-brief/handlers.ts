/**
 * Read the project brief — owned by i-read-brief: get_project (playbook, description, rules, check
 * sentence, version) and get_rules (versioned). get_spec is in spec.ts.
 */

import { loadProjectBrief } from "../../foundations/f-territory-store/project.js";
import { projectVersionStatus } from "../../foundations/f-territory-store/version.js";
import { blocked } from "../../foundations/f-compiler-rules/rules.js";
import { findPackageFile } from "./spec.js";
import * as fs from "fs";
import * as path from "path";
import {
  rulesVersion,
} from "../../foundations/f-plan-views/views.js";

/**
 * Resolve the bundled systems dialect at templates/agent/playbook.md.
 * Walks up from this module to the package root (same layout as the npm package).
 */
function loadBundledPlaybook(): string {
  const file = findPackageFile("templates", "agent", "playbook.md");
  if (!file) {
    throw blocked(
      "get_project could not find templates/agent/playbook.md. Reinstall mindplan-mcp so the systems dialect ships with the package."
    );
  }
  try {
    return fs.readFileSync(file, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw blocked(
      `get_project could not read the bundled playbook (${message}). Reinstall mindplan-mcp so templates/agent/playbook.md is present.`
    );
  }
}

/** Names the integrity check where an agent cannot miss it: get_project is read first. */
export const CHECK_HINT =
  "Run the check with the run_check tool (CLI: mindplan-mcp check) before self-ready, in-review, ship / resolved, " +
  "and before saying the work is done. It must pass; moves to in-review and ship also run its import and ownership rules on the node's files.";

/**
 * Project brief (description + rules) plus the bundled systems dialect (playbook).
 * `rules_version` tags the rules, so the first `get_rules` of a session can already pass it.
 * `version` is the stamp warning, present only when mindplan/version.json is not current.
 * Call before the first answer or code change; call again after description/rules change.
 */
export function getProject(): Record<string, unknown> {
  const brief = loadProjectBrief();
  const version = projectVersionStatus();
  return {
    path: brief.path,
    description: brief.description,
    rules: brief.rules,
    rules_version: rulesVersion(brief.rules),
    playbook: loadBundledPlaybook(),
    check: CHECK_HINT,
    ...(version.warning ? { version: version.warning } : {}),
  };
}

/**
 * Mandatory project rules only — call before each action, before orient_for_work.
 * `{ path, rules, rules_version }`; with a `known_version` equal to the current tag, the text is
 * left out: `{ path, rules_version, unchanged: true }`.
 */
export function getRules(args: { known_version?: string } = {}): Record<string, unknown> {
  const brief = loadProjectBrief();
  const rules_version = rulesVersion(brief.rules);
  if (args.known_version !== undefined && args.known_version === rules_version) {
    return { path: brief.path, rules_version, unchanged: true };
  }
  return {
    path: brief.path,
    rules: brief.rules,
    rules_version,
  };
}
