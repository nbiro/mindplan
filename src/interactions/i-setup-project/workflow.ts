/**
 * The GitHub merge-gate workflow setup_project writes on request. Owned by Interaction
 * i-setup-project.
 */

import * as fs from "fs";
import * as path from "path";
import { repoPrefix, repoTop } from "../../foundations/f-source-index/git.js";
import { projectRoot } from "../../foundations/f-territory-store/store.js";

/** Where the merge-gate workflow goes, relative to the repository top (repo-owned: never overwritten). */
export const MERGE_GATE_WORKFLOW = ".github/workflows/mindplan-merge-gate.yml";

/**
 * Install the GitHub Actions merge gate: `check --merge` on pull requests to the default branch.
 * GitHub reads workflows only from the repository top, so the file goes there and its steps run in
 * the project root (`{{MINDPLAN_DIR}}`: `.` when the project is the repository top); outside git
 * it goes under the project root. `{{MINDPLAN_VERSION}}` becomes the running package's
 * major.minor, so `npx` resolves a release that has the flag. An existing workflow is kept. The
 * returned path is relative to the project root.
 */
export function installMergeGateWorkflow(
  packageRoot: string,
  packageVersion: string
): { installed: boolean; path: string } {
  const root = projectRoot();
  const top = repoTop(root) ?? root;
  const dir = (repoPrefix(root) ?? "").replace(/\/$/, "") || ".";
  const destPath = path.join(top, ...MERGE_GATE_WORKFLOW.split("/"));
  const shown = path.relative(root, destPath).split(path.sep).join("/");
  if (fs.existsSync(destPath)) {
    return { installed: false, path: shown };
  }
  const templatePath = path.join(packageRoot, "templates", "ci", "github", "mindplan-merge-gate.yml");
  if (!fs.existsSync(templatePath)) {
    throw new Error(`CI template not found at ${templatePath}`);
  }
  const minor = packageVersion.split(".").slice(0, 2).join(".");
  const text = fs
    .readFileSync(templatePath, "utf-8")
    .replaceAll("{{MINDPLAN_VERSION}}", minor)
    .replaceAll("{{MINDPLAN_DIR}}", dir);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, text, "utf-8");
  return { installed: true, path: shown };
}
