/**
 * A copy of an installed package and its dependency closure in the user cache. Windows locks a
 * loaded native module (onnxruntime-node, sharp) for the life of the process; loading it from this
 * copy leaves a project's node_modules free for `npm ci` and `npm install` while the server runs.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Bump when the mirror layout changes, so an older copy is never reused. */
const MIRROR_FORMAT = 1;

/** Dependencies the Node build never imports: left out of the mirror (onnxruntime-web is 140 MB). */
const SKIPPED_PACKAGES = new Set(["onnxruntime-web"]);

/** Where mirrors live: once per machine, beside the downloaded models. */
export function runtimeCacheDir(): string {
  return path.join(os.homedir(), ".cache", "mindplan", "runtime");
}

interface InstalledPackage {
  name: string;
  version: string;
  /** Real path of the package folder. */
  dir: string;
}

function readManifest(dir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The folder of package `name` that holds `file`: the nearest ancestor whose package.json names it. */
function packageDirOf(file: string, name: string): string {
  let dir = path.dirname(file);
  for (;;) {
    if (readManifest(dir)?.name === name) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no package.json for ${name} above ${file}`);
    dir = parent;
  }
}

/** Node's lookup of a bare package from `fromDir`: each ancestor's node_modules, nearest first. */
function findInstalled(fromDir: string, name: string): string | null {
  let dir = fromDir;
  for (;;) {
    if (path.basename(dir) !== "node_modules") {
      const candidate = path.join(dir, "node_modules", name);
      if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync.native(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The package at `rootDir` and every installed dependency it reaches (optional ones when present). */
function dependencyClosure(rootDir: string): InstalledPackage[] {
  const seen = new Map<string, InstalledPackage>();
  const queue = [fs.realpathSync.native(rootDir)];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    if (seen.has(dir)) continue;
    const manifest = readManifest(dir);
    if (!manifest) throw new Error(`unreadable package.json in ${dir}`);
    seen.set(dir, { name: String(manifest.name), version: String(manifest.version), dir });
    const deps = {
      ...(manifest.dependencies as Record<string, string> | undefined),
      ...(manifest.optionalDependencies as Record<string, string> | undefined),
    };
    for (const name of Object.keys(deps)) {
      if (SKIPPED_PACKAGES.has(name)) continue;
      const found = findInstalled(dir, name);
      if (found) queue.push(found);
    }
  }
  return [...seen.values()];
}

const sameSegment = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** The folder above the outermost node_modules shared by every package: the install root. */
function installRoot(dirs: string[]): string {
  const split = dirs.map((d) => d.split(path.sep));
  const common: string[] = [];
  for (let i = 0; split.every((s) => i < s.length && sameSegment(s[i], split[0][i])); i++) common.push(split[0][i]);
  const nm = common.findIndex((s) => sameSegment(s, "node_modules"));
  if (nm < 0) throw new Error("the packages share no node_modules folder");
  return common.slice(0, nm).join(path.sep) || path.sep;
}

/** False for another platform's or architecture's prebuilt binaries (bin/napi-vN/<platform>/<arch>). */
function forThisPlatform(relInPackage: string): boolean {
  const segs = relInPackage.split(path.sep);
  const napi = segs.findIndex((s) => /^napi-v\d+$/.test(s));
  if (napi < 0) return true;
  const platform = segs[napi + 1];
  const arch = segs[napi + 2];
  if (platform !== undefined && platform !== process.platform) return false;
  if (arch !== undefined && arch !== process.arch) return false;
  return true;
}

/**
 * Mirror the package that owns `entryFile` (named `name`) into `cacheDir` and return the mirrored
 * entry file. The copy keeps the install's node_modules layout, so Node resolves inside it exactly as
 * in the original; a mirror for the same package versions and platform is reused. The copy lands in
 * a temporary folder renamed into place, so two servers mirroring at once never see a half copy.
 */
export async function mirrorPackage(
  entryFile: string,
  name: string,
  cacheDir: string,
  onCopy?: (target: string) => void
): Promise<string> {
  const entry = fs.realpathSync.native(entryFile);
  const packages = dependencyClosure(packageDirOf(entry, name));
  const root = installRoot(packages.map((p) => p.dir));
  const rel = (p: string) => path.relative(root, p);
  const key = crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        MIRROR_FORMAT,
        process.platform,
        process.arch,
        packages.map((p) => `${rel(p.dir).split(path.sep).join("/")}@${p.version}`).sort(),
      ])
    )
    .digest("hex")
    .slice(0, 16);
  const target = path.join(cacheDir, `${name.replace(/[@/]/g, "_").replace(/^_+/, "")}-${key}`);
  const mirroredEntry = path.join(target, rel(entry));
  if (fs.existsSync(target)) return mirroredEntry;

  onCopy?.(target);
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    for (const pkg of packages) {
      await fs.promises.cp(pkg.dir, path.join(tmp, rel(pkg.dir)), {
        recursive: true,
        filter: (src) => {
          const inPackage = path.relative(pkg.dir, src);
          // Nested node_modules hold other packages: those in the closure are copied on their own.
          if (inPackage.split(path.sep)[0] === "node_modules") return false;
          return forThisPlatform(inPackage);
        },
      });
    }
    try {
      fs.renameSync(tmp, target);
    } catch (err) {
      // Another server finished the same mirror first: use theirs.
      if (!fs.existsSync(target)) throw err;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return mirroredEntry;
}
