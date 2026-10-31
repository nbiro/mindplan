/**
 * Runs only some of the suites `npm test` runs, for development: `npm run test:files -- <paths>`.
 * Paths are the linked tests get_blast_radius lists for a change (files, directories, or globs).
 * Each path is matched against the suites in package.json's `test` script, which run in that
 * script's order; anything else (fixtures, helpers) is skipped and named. The full `npm test`
 * stays the handoff check, and CI runs it.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(toolRoot, "package.json"), "utf-8"));
const suites = [...pkg.scripts.test.matchAll(/node (\S+\.mjs)/g)].map((m) => m[1]);

const posix = (p) => p.split(path.sep).join("/").replace(/^\.\//, "");
const globToRegExp = (glob) =>
  new RegExp(
    "^" +
      glob
        .split("**")
        .map((part) => part.split("*").map((s) => s.replace(/[.+^${}()|[\]\\?]/g, "\\$&")).join("[^/]*"))
        .join(".*") +
      "$"
  );

const args = process.argv.slice(2).map(posix);
if (args.length === 0) {
  console.log("Usage: npm run test:files -- <test file | directory/ | glob> ...");
  console.log(`Suites: ${suites.join(", ")}`);
  process.exit(1);
}

const selected = new Set();
const skipped = [];
for (const arg of args) {
  const matches = suites.filter((s) =>
    /[*?]/.test(arg) ? globToRegExp(arg).test(s) : arg.endsWith("/") ? s.startsWith(arg) : s === arg
  );
  if (matches.length === 0) skipped.push(arg);
  for (const m of matches) selected.add(m);
}
if (skipped.length > 0) console.log(`Not a suite of npm test, skipped: ${skipped.join(", ")}`);
const run = suites.filter((s) => selected.has(s));
if (run.length === 0) {
  console.log("No suite to run.");
  process.exit(1);
}

const failed = [];
for (const suite of run) {
  console.log(`\n=== ${suite}`);
  const res = spawnSync(process.execPath, [suite], { cwd: toolRoot, stdio: "inherit" });
  if (res.status !== 0) failed.push(suite);
}
console.log(`\n${run.length - failed.length}/${run.length} suite(s) passed${failed.length ? `; failed: ${failed.join(", ")}` : ""}.`);
console.log("Run the full npm test before handoff.");
process.exit(failed.length ? 1 : 0);
