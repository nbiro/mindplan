#!/usr/bin/env node
/**
 * MindPlan plugin launcher (if-claude-plugin): runs a hook through the project's own mindplan-mcp,
 * so the lockfile, not the plugin, picks the version (decision d-plugin-runs-project-copy).
 *
 * The project is the nearest folder at or above the hook payload's `cwd` that holds `mindplan/`
 * (so a session working in a git worktree checks that worktree), else CLAUDE_PROJECT_DIR, else cwd.
 * The package is resolved from that project, else from CLAUDE_PROJECT_DIR, else cwd (a worktree
 * often has no node_modules of its own); it always runs in the project with MINDPLAN_ROOT set to it.
 * It prints nothing and exits 0 when that project has no mindplan-mcp installed, or when the
 * installed one is older than the first release that answers the hook asked for.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

/** The first mindplan-mcp release that answers each hook. */
const MIN_HOOK_VERSION = {
  "pre-tool-use": "0.23.0",
  "session-start": "0.27.0",
  stop: "0.27.0",
};

/** -1, 0, or 1 comparing the numeric x.y.z of two versions (pre-release tags ignored). */
function compareVersions(a, b) {
  const parse = (v) => String(v).split("-")[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

/** The nearest folder at or above `start` holding `mindplan/`, or null. */
function graphRootAbove(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "mindplan"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The project's installed mindplan-mcp: { version, bin } (absolute bin path), or null. */
function findInstalled(projectDir) {
  try {
    const require = createRequire(path.join(projectDir, "package.json"));
    const pkgPath = require.resolve("mindplan-mcp/package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["mindplan-mcp"];
    if (typeof pkg.version !== "string" || typeof bin !== "string") return null;
    return { version: pkg.version, bin: path.resolve(path.dirname(pkgPath), bin) };
  } catch {
    return null;
  }
}

function main(args) {
  let input = Buffer.alloc(0);
  try {
    input = fs.readFileSync(0);
  } catch {
    // no stdin: the handler sees empty input and prints nothing
  }
  let payloadCwd;
  try {
    const cwd = JSON.parse(input.toString("utf-8"))?.cwd;
    if (typeof cwd === "string" && cwd) payloadCwd = cwd;
  } catch {
    payloadCwd = undefined;
  }
  const projectDir =
    (payloadCwd && graphRootAbove(payloadCwd)) || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // A worktree often has no node_modules of its own: fall back to the session's project, then cwd.
  const installed =
    findInstalled(projectDir) ??
    (process.env.CLAUDE_PROJECT_DIR ? findInstalled(process.env.CLAUDE_PROJECT_DIR) : null) ??
    findInstalled(process.cwd());
  if (!installed) return 0;
  const minimum = args[0] === "hook" ? MIN_HOOK_VERSION[args[1]] : undefined;
  if (args[0] === "hook" && (!minimum || compareVersions(installed.version, minimum) < 0)) return 0;

  const child = spawnSync(process.execPath, [installed.bin, ...args], {
    cwd: projectDir,
    input,
    env: { ...process.env, MINDPLAN_ROOT: projectDir },
    stdio: ["pipe", "inherit", "inherit"],
  });
  return child.status ?? 0;
}

process.exit(main(process.argv.slice(2)));
