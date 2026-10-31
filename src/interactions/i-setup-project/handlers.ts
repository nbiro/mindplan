/**
 * Set up the project — owned by i-setup-project: setup_project creates the graph a repo does not
 * have yet (tree, default config, empty brief, stamp), writes the merge-gate workflow on request,
 * and returns the pointer text and the setup guide for the agent's judgment work. It writes
 * nothing else outside mindplan/ (decision d-setup-upgrade-mcp-tools).
 */

import * as fs from "fs";
import * as path from "path";
import { blocked } from "../../foundations/f-compiler-rules/rules.js";
import { writeFileRetry } from "../../foundations/f-source-index/io.js";
import { migrateImplementationPackages } from "../../foundations/f-graph-migrations/migrations.js";
import { graphStatus, stampGraph } from "../../foundations/f-graph-migrations/status.js";
import { changedSince, snapshotTree } from "../../foundations/f-graph-migrations/tree.js";
import { PROJECT_FILENAME } from "../../foundations/f-territory-store/project.js";
import { ensureDirectories, mindplanRoot } from "../../foundations/f-territory-store/store.js";
import { packageRoot, packageVersion } from "../../foundations/f-territory-store/version.js";
import { installMergeGateWorkflow } from "./workflow.js";

export type SetupCi = "github";

function readTemplate(...segments: string[]): string {
  const file = path.join(packageRoot(), "templates", ...segments);
  if (!fs.existsSync(file)) {
    throw blocked(`setup_project could not find templates/${segments.join("/")}. Reinstall mindplan-mcp.`);
  }
  return fs.readFileSync(file, "utf-8").replace(/\r\n/g, "\n");
}

export function setupProject(args: { ci?: SetupCi } = {}): Record<string, unknown> {
  const status = graphStatus();
  if (status.state === "server-behind" || status.state === "upgrade") {
    throw blocked(`setup_project: ${status.warning}`);
  }
  const before = snapshotTree();
  const created = status.state === "setup";
  ensureDirectories();
  migrateImplementationPackages();
  const brief = path.join(mindplanRoot(), PROJECT_FILENAME);
  if (!fs.existsSync(brief)) {
    writeFileRetry(brief, readTemplate("agent", "project.md"));
  }
  if (created) stampGraph();
  const changed_files = changedSince(before);
  const ci = args.ci === "github" ? installMergeGateWorkflow(packageRoot(), packageVersion()) : undefined;
  if (ci?.installed) changed_files.push(ci.path);
  return {
    created,
    changed_files,
    ...(ci ? { ci } : {}),
    pointer: readTemplate("agent", "agents-stub.md"),
    guide: readTemplate("agent", "setup-guide.md"),
  };
}
