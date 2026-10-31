/**
 * Upgrade the graph — owned by i-upgrade-graph: upgrade_project runs every migration
 * (f-graph-migrations), stamps the server's migration level, and names the agent files the retired
 * init left outside mindplan/, which the server reports but never deletes.
 */

import * as fs from "fs";
import * as path from "path";
import { blocked } from "../../foundations/f-compiler-rules/rules.js";
import {
  LegacyTerritoryMigrationError,
  MIGRATION_LEVEL,
  runMigrations,
} from "../../foundations/f-graph-migrations/migrations.js";
import { graphStatus, stampGraph } from "../../foundations/f-graph-migrations/status.js";
import { changedSince, snapshotTree } from "../../foundations/f-graph-migrations/tree.js";
import { mindplanRoot, projectRoot } from "../../foundations/f-territory-store/store.js";
import { packageRoot } from "../../foundations/f-territory-store/version.js";

/** What the retired init installed outside mindplan/; the upgrade guide tells the agent to delete them. */
export const RETIRED_HOST_COPIES = [
  ".claude/skills/mindplan-define-entities/",
  ".claude/skills/mindplan-plan-project/",
  ".cursor/skills/mindplan-define-entities/",
  ".cursor/skills/mindplan-plan-project/",
  ".cursor/rules/mindplan.mdc",
];

/** A line only the retired AGENTS.md stub carried: it pointed at the init-installed host copies. */
const RETIRED_STUB_MARKER = "use the init-installed host copies";

function readTemplate(...segments: string[]): string {
  const file = path.join(packageRoot(), "templates", ...segments);
  if (!fs.existsSync(file)) {
    throw blocked(`upgrade_project could not find templates/${segments.join("/")}. Reinstall mindplan-mcp.`);
  }
  return fs.readFileSync(file, "utf-8").replace(/\r\n/g, "\n");
}

function readText(rel: string): string | null {
  const abs = path.join(projectRoot(), rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8").replace(/\r\n/g, "\n") : null;
}

/** True when MINDPLAN.md is missing or stale, or an agent file still holds the retired stub. */
function pointerOutdated(pointer: string): boolean {
  const current = readText("MINDPLAN.md");
  if (current === null || current.trim() !== pointer.trim()) return true;
  return ["AGENTS.md", "CLAUDE.md"].some((f) => readText(f)?.includes(RETIRED_STUB_MARKER) ?? false);
}

export function upgradeProject(): Record<string, unknown> {
  const status = graphStatus();
  // A folder with no stamp and no node also reads as setup; migrating it is still safe.
  if ((status.state === "setup" && !fs.existsSync(mindplanRoot())) || status.state === "server-behind") {
    throw blocked(`upgrade_project: ${status.warning}`);
  }
  const before = snapshotTree();
  let migrations;
  try {
    migrations = runMigrations();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const applied =
      err instanceof LegacyTerritoryMigrationError && err.applied.length > 0
        ? ` Already applied: ${err.applied.map((r) => `${r.from} → ${r.to} (${r.action})`).join("; ")}.`
        : "";
    throw new Error(`${message}${applied}`);
  }
  stampGraph();
  const pointer = readTemplate("agent", "agents-stub.md");
  return {
    from_level: status.level,
    to_level: MIGRATION_LEVEL,
    changed_files: changedSince(before),
    migrations,
    leftovers: RETIRED_HOST_COPIES.filter((rel) => fs.existsSync(path.join(projectRoot(), rel))),
    pointer_outdated: pointerOutdated(pointer),
    pointer,
    guide: readTemplate("agent", "upgrade-guide.md"),
  };
}
