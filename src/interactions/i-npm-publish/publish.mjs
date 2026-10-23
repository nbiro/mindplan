#!/usr/bin/env node
/**
 * Publish mindplan-mcp to npm: preflight → test → tarball allowlist → publish → verify.
 * One script for both paths (owned by Interaction i-npm-publish):
 *
 *   npm run publish:release              maintainer mode (first claim, break-glass; npm login + OTP)
 *   npm run publish:release -- --ci      CI mode (i-npm-tag-publish; OIDC Trusted Publishing, no login)
 *   add --dry-run to either              run everything but `npm publish --dry-run` and skip verify
 *
 * CI mode runs only on refs/heads/main and exits 0 without publishing when the registry
 * already lists package.json's version, so every merge to main can call it.
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const PACKAGE_NAME = "mindplan-mcp";
const ALLOWED_PREFIXES = ["dist/", "templates/"];
const ALLOWED_FILES = new Set(["package.json", "README.md", "SPEC.md", "LICENSE"]);
const REQUIRED_FILES = ["dist/index.js", "templates/agent/playbook.md", "README.md", "LICENSE"];

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const args = new Set(process.argv.slice(2));
const ci = args.has("--ci");
const dryRun = args.has("--dry-run");
for (const arg of args) {
  if (arg !== "--ci" && arg !== "--dry-run") fail(`unknown option "${arg}". Use --ci and/or --dry-run.`);
}

function fail(message) {
  console.error(`publish: ${message}`);
  process.exit(1);
}

function step(title) {
  console.log(`\n== ${title}`);
}

/** Runs a command in the repo root; exits on failure unless `allowFailure`. */
function run(cmd, cmdArgs, { capture = false, cwd = repoRoot, allowFailure = false } = {}) {
  const res = spawnSync(cmd, cmdArgs, {
    cwd,
    encoding: "utf-8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    shell: process.platform === "win32",
  });
  if (res.status !== 0 && !allowFailure) {
    fail(`\`${cmd} ${cmdArgs.join(" ")}\` exited with ${res.status ?? res.signal}`);
  }
  return res;
}

/** The version the registry lists for package.json's version, or "" when it has none (incl. E404). */
function registryVersion() {
  const res = run("npm", ["view", `${PACKAGE_NAME}@${readManifest().version}`, "version"], {
    capture: true,
    allowFailure: true,
  });
  return res.status === 0 ? res.stdout.trim() : "";
}

function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
}

// --- 1. Preflight ---
step(`Preflight (${ci ? "CI" : "maintainer"} mode${dryRun ? ", dry run" : ""})`);
const manifest = readManifest();
if (manifest.name !== PACKAGE_NAME) fail(`package.json name is ${manifest.name}, expected ${PACKAGE_NAME}.`);
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")) {
  fail(`package.json version "${manifest.version}" is not SemVer.`);
}
if (manifest.bin?.[PACKAGE_NAME] !== "dist/index.js") fail(`package.json bin must map ${PACKAGE_NAME} to dist/index.js.`);
for (const entry of ["dist", "templates"]) {
  if (!manifest.files?.includes(entry)) fail(`package.json files must include "${entry}".`);
}
const version = manifest.version;
if (ci) {
  if (process.env.GITHUB_REF !== "refs/heads/main") {
    fail(`CI mode runs only on refs/heads/main (got ${process.env.GITHUB_REF ?? "no GITHUB_REF"}).`);
  }
  if (registryVersion() === version) {
    console.log(`${PACKAGE_NAME}@${version} is already on npm; nothing to publish. Bump package.json to release.`);
    process.exit(0);
  }
}
const status = run("git", ["status", "--porcelain"], { capture: true }).stdout.trim();
if (status) fail(`the working tree is not clean:\n${status}\nCommit or stash first.`);
console.log(`${PACKAGE_NAME}@${version}, clean tree`);

// --- 2. Test (builds dist/) ---
step("npm test");
run("npm", ["test"]);

// --- 3. Tarball allowlist ---
step("Tarball contents");
const packed = JSON.parse(run("npm", ["pack", "--dry-run", "--json"], { capture: true }).stdout);
const files = (packed[0]?.files ?? []).map((f) => f.path.split(path.sep).join("/"));
const stray = files.filter(
  (f) => !ALLOWED_FILES.has(f) && !ALLOWED_PREFIXES.some((prefix) => f.startsWith(prefix))
);
if (stray.length > 0) fail(`tarball contains files outside the allowlist:\n  ${stray.join("\n  ")}`);
const tests = files.filter((f) => /\.test\.|(^|\/)smoke\.mjs$/.test(f));
if (tests.length > 0) fail(`tarball contains test files:\n  ${tests.join("\n  ")}`);
const missing = REQUIRED_FILES.filter((f) => !files.includes(f));
if (missing.length > 0) fail(`tarball is missing ${missing.join(", ")}.`);
console.log(`${files.length} files, all inside the allowlist`);

// --- 4. Publish ---
step(dryRun ? "npm publish --dry-run" : "npm publish");
const publishArgs = ["publish", "--access", "public"];
if (dryRun) publishArgs.push("--dry-run");
if (!ci && !dryRun) {
  const who = run("npm", ["whoami"], { capture: true, allowFailure: true });
  if (who.status !== 0) fail("not logged in to npm. Run `npm login`, then rerun.");
  console.log(`publishing as ${who.stdout.trim()}`);
}
run("npm", publishArgs);
if (dryRun) {
  console.log("\nDry run complete: nothing was published.");
  process.exit(0);
}

// --- 5. Verify ---
step("Verify");
let seen = "";
for (let attempt = 1; attempt <= 6 && seen !== version; attempt++) {
  seen = registryVersion();
  if (seen !== version) {
    console.log(`registry does not list ${version} yet (attempt ${attempt}); waiting 10s`);
    spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]);
  }
}
if (seen !== version) fail(`the registry does not list ${PACKAGE_NAME}@${version}.`);
console.log(`registry lists ${PACKAGE_NAME}@${version}`);

if (!ci) {
  // A fresh project, as a consumer would see it.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mindplan-publish-verify-"));
  try {
    run("npx", ["-y", `${PACKAGE_NAME}@${version}`, "help"], { cwd: sandbox });
    run("npx", ["-y", `${PACKAGE_NAME}@${version}`, "init", "--host", "all"], { cwd: sandbox });
    const stamp = JSON.parse(fs.readFileSync(path.join(sandbox, "mindplan", "version.json"), "utf-8"));
    if (stamp.package !== version) fail(`init in a fresh project stamped ${stamp.package}, expected ${version}.`);
    console.log("fresh-install help + init passed");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}
console.log(`\nPublished ${PACKAGE_NAME}@${version}.`);
