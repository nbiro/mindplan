/**
 * Graph status and the version gate — compares mindplan/version.json with the server's migration
 * level and graph format, and Blocks every gated tool (and the check) until the graph is set up or
 * upgraded. Owned by Foundation f-graph-migrations (decision d-block-on-pending-migration).
 */

import * as fs from "fs";
import * as path from "path";
import { GRAPH_VERSION, isMirrorState, isPipelineNodeType } from "../f-domain-model/types.js";
import { listNodeFolders, liveMdxFilename, mindplanRoot, parseFrontmatter, projectRoot } from "../f-territory-store/store.js";
import {
  VERSION_RELATIVE_PATH,
  packageVersion,
  readProjectVersion,
  writeProjectVersion,
} from "../f-territory-store/version.js";
import { legacyNextFile, legacyNextFilename } from "./legacy-next.js";
import { LEGACY_CAPABILITY_DIR, MIGRATION_LEVEL, hasLegacyCapabilityFolders } from "./migrations.js";

export type GraphState = "setup" | "upgrade" | "server-behind" | "current";

export type GraphStatus = {
  state: GraphState;
  /** The stamp's migration level (0 when missing, unreadable, or written before levels). */
  level: number;
  /** The level this server migrates to. */
  required: number;
  /** One sentence naming the fix; absent when current. */
  warning?: string;
  /** The MCP tool that fixes it, when one does. */
  call?: "setup_project" | "upgrade_project";
};

/** Writes the stamp for a graph at this server's level and returns its repo-relative path. */
export function stampGraph(): string {
  return writeProjectVersion({ package: packageVersion(), graph: GRAPH_VERSION, migrations: MIGRATION_LEVEL });
}

/** True when mindplan/ holds no node folder at all, whatever its files are named (journeys/ included). */
function graphIsEmpty(): boolean {
  try {
    if (listNodeFolders(projectRoot()).length > 0) return false;
    const legacy = path.join(mindplanRoot(), LEGACY_CAPABILITY_DIR);
    return !fs.existsSync(legacy) || !fs.readdirSync(legacy, { withFileTypes: true }).some((e) => e.isDirectory());
  } catch {
    return false;
  }
}

/**
 * Repo-relative path of the first legacy `<id>.next.mdx` evolution beside a Foundation,
 * Interaction, or Interface live file (the files the level-4 `moveNextToRevisions` moves into
 * `revisions/<change>/`), or null. A `state: mirror` leftover is no evolution and is skipped (the
 * mirror migration removes it, and the store never read it). Never throws.
 */
function firstLegacyNextFile(): string | null {
  try {
    for (const folder of listNodeFolders(projectRoot())) {
      if (!isPipelineNodeType(folder.type)) continue;
      if (!fs.existsSync(path.join(folder.abs, liveMdxFilename(folder.id)))) continue;
      const nextFile = legacyNextFile(folder.abs, folder.id);
      if (!fs.existsSync(nextFile) || !fs.statSync(nextFile).isFile()) continue;
      const state = parseFrontmatter(fs.readFileSync(nextFile, "utf-8"))?.scalars.state;
      if (state !== undefined && isMirrorState(state)) continue;
      return `${folder.rel}/${legacyNextFilename(folder.id)}`;
    }
  } catch {
    return null;
  }
  return null;
}

/** Where this project's graph stands against the running server. Never throws. */
export function graphStatus(): GraphStatus {
  const required = MIGRATION_LEVEL;
  const setup: GraphStatus = {
    state: "setup",
    level: 0,
    required,
    call: "setup_project",
    warning:
      "This project has no MindPlan graph (mindplan/). Call setup_project to create it, then follow the guide it returns.",
  };
  if (!fs.existsSync(mindplanRoot())) return setup;
  let stamp: ReturnType<typeof readProjectVersion>;
  try {
    stamp = readProjectVersion();
  } catch {
    stamp = "invalid";
  }
  // No stamp and no node yet: the empty folders a 0.12 server created at boot, or a setup that
  // stopped before its stamp. Setting up again keeps what is there and writes the rest.
  if (stamp === null && graphIsEmpty()) return setup;
  if (stamp !== null && stamp !== "invalid" && (stamp.graph > GRAPH_VERSION || stamp.migrations > required)) {
    return {
      state: "server-behind",
      level: stamp.migrations,
      required,
      warning:
        `This graph was upgraded by mindplan-mcp ${stamp.package} (migration level ${stamp.migrations}), newer than this server ` +
        `${packageVersion()} (level ${required}). Upgrade mindplan-mcp (npm install -D mindplan-mcp@${stamp.package}, or point npx at it) before using the graph.`,
    };
  }
  const level = stamp !== null && stamp !== "invalid" ? stamp.migrations : 0;
  const stampCurrent = stamp !== null && stamp !== "invalid" && stamp.graph >= GRAPH_VERSION && level >= required;
  // A branch from before level 3 can merge a node into journeys/ after the stamp says 3.
  if (stampCurrent && hasLegacyCapabilityFolders()) {
    return {
      state: "upgrade",
      level,
      required,
      call: "upgrade_project",
      warning: `This graph needs an upgrade: mindplan/${LEGACY_CAPABILITY_DIR}/ still holds a node folder, and mindplan-mcp ${packageVersion()} reads Capabilities only from mindplan/capabilities/. Call upgrade_project, then commit the upgrade on its own.`,
    };
  }
  // A branch from before level 4 can merge a legacy next file in after the stamp says 4.
  const legacyNext = stampCurrent ? firstLegacyNextFile() : null;
  if (legacyNext !== null) {
    return {
      state: "upgrade",
      level,
      required,
      call: "upgrade_project",
      warning: `This graph needs an upgrade: ${legacyNext} is an evolution file from before revisions/<change>/, and mindplan-mcp ${packageVersion()} reads open revisions only from revisions/. Call upgrade_project to move it, then commit the upgrade on its own.`,
    };
  }
  if (stamp === null || stamp === "invalid" || stamp.graph < GRAPH_VERSION || level < required) {
    const why =
      stamp === null
        ? `${VERSION_RELATIVE_PATH} is missing`
        : stamp === "invalid"
          ? `${VERSION_RELATIVE_PATH} is unreadable`
          : `the graph is at migration level ${level}`;
    return {
      state: "upgrade",
      level,
      required,
      call: "upgrade_project",
      warning: `This graph needs an upgrade: ${why}, and mindplan-mcp ${packageVersion()} needs level ${required}. Call upgrade_project, then commit the upgrade on its own.`,
    };
  }
  return { state: "current", level, required };
}

/**
 * Throws `Blocked: Version — …` unless the graph is current. Off with MINDPLAN_VERSION_GATE=off
 * (test fixtures that build a graph without a stamp), like MINDPLAN_ORIENT_GATE.
 */
export function versionGate(): void {
  if (process.env.MINDPLAN_VERSION_GATE === "off") return;
  const status = graphStatus();
  if (status.state !== "current") throw new Error(`Blocked: Version — ${status.warning}`);
}
