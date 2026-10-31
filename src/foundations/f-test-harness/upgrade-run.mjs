/**
 * Test helper: runs the upgrade_project or setup_project handler from the built package in a child
 * process rooted at a fixture (the way the MCP server would, without a client). Returns
 * { status, result, stderr }: result is the handler's reply, or null when it threw (stderr then
 * holds the message).
 */
import { spawnSync } from "child_process";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const toolRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const modules = {
  upgrade: ["dist/interactions/i-upgrade-graph/handlers.js", "upgradeProject"],
  setup: ["dist/interactions/i-setup-project/handlers.js", "setupProject"],
};

export function runHandler(kind, root, { args = {}, env = {} } = {}) {
  const [rel, fn] = modules[kind];
  const url = pathToFileURL(path.join(toolRoot, rel)).href;
  const script =
    `import(${JSON.stringify(url)}).then((m) => { process.stdout.write(JSON.stringify(m.${fn}(${JSON.stringify(args)}))); })` +
    `.catch((err) => { process.stderr.write(err instanceof Error ? err.message : String(err)); process.exit(1); });`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf-8",
    env: { ...process.env, MINDPLAN_ROOT: root, ...env },
  });
  let result = null;
  if (res.status === 0) {
    try {
      result = JSON.parse(res.stdout);
    } catch {
      result = null;
    }
  }
  return { status: res.status, result, stderr: res.stderr ?? "" };
}

export const runUpgrade = (root, opts) => runHandler("upgrade", root, opts);
export const runSetup = (root, opts) => runHandler("setup", root, opts);
