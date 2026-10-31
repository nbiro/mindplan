/**
 * Graph migrations — the ordered, idempotent passes that bring a mindplan/ tree to the server's
 * migration level: legacy territory filenames, legacy config, shipped Atomic Ops, mirror twins,
 * revision backfill from git, and the agent files the retired init installed under mindplan/agent/.
 * upgrade_project runs them; setup_project writes the default config through
 * migrateImplementationPackages. Owned by Foundation f-graph-migrations.
 */

import * as fs from "fs";
import * as path from "path";
import {
  isPipelineNodeType,
  type FoundationRole,
} from "../f-domain-model/types.js";
import {
  hotspotSettings,
  loadProjectConfig as loadSourceConfig,
  writeProjectConfig,
  type MindPlanProjectConfig,
} from "../f-source-index/config.js";
import { RM_MAX_RETRIES } from "../f-source-index/io.js";
import {
  inferredSplits,
  nodeShipHistory,
  replayChurn,
  shipTimesOf,
  type ShipRecord,
} from "../f-compiler-rules/ship-history.js";
import {
  AGENT_DIR,
  MINDPLAN_DIR,
  agentRoot,
  implementationDir,
  implementationRelativePath,
  drainRemovedLegacyFiles,
  liveMdxFilename,
  loadGraph,
  mindplanRoot,
  nextMdxFilename,
  projectRoot,
  removeLegacyIfIdNamedExists,
  removeLegacyMirror,
  writeImplementsFrontmatter,
  stripLiveAtomicOps,
  writeRevisionFields,
  writeRoleFrontmatter,
} from "../f-territory-store/store.js";

function roleFromDescription(description: string): FoundationRole {
  if (/^Assembler\b/i.test(description)) return "assembler";
  if (/^Design system\b/i.test(description)) return "design-system";
  if (/^Adapter\b/i.test(description)) return "adapter";
  if (/^Infra\b/i.test(description)) return "infra";
  return "infra";
}

function collectPackageFiles(absDir: string, relDir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) return out;
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const rel = `${relDir}/${entry.name}`;
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectPackageFiles(abs, rel));
    } else if (entry.isFile() && entry.name !== ".gitkeep") {
      out.push(rel.split(path.sep).join("/"));
    }
  }
  return out;
}

/**
 * Migrate legacy implementation_packages config and seed implements/role.
 * One-time server-side write — works on shipped nodes without open_next.
 */
export function migrateImplementationPackages(): {
  migrated: boolean;
  config: MindPlanProjectConfig;
  seeded_implements: number;
  seeded_roles: number;
} {
  const configPath = path.join(projectRoot(), MINDPLAN_DIR, "config.json");
  let legacyMode: "required" | "off" | null = null;

  if (fs.existsSync(configPath)) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Blocked: invalid mindplan/config.json: could not parse JSON (${detail}). Fix or delete the file.`
      );
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      if ("implementation_packages" in obj) {
        const mode = obj.implementation_packages;
        if (mode !== "required" && mode !== "off") {
          throw new Error(
            `Blocked: invalid mindplan/config.json: "implementation_packages" must be "required" or "off" (got ${JSON.stringify(mode)}).`
          );
        }
        legacyMode = mode;
      } else if ("sources" in obj && "exclude" in obj) {
        // Already migrated
        return {
          migrated: false,
          config: {
            sources: Array.isArray(obj.sources) ? (obj.sources as string[]) : ["src/**"],
            exclude: Array.isArray(obj.exclude) ? (obj.exclude as string[]) : [],
          },
          seeded_implements: 0,
          seeded_roles: 0,
        };
      }
    }
  }

  const config: MindPlanProjectConfig =
    legacyMode === "off"
      ? { sources: [], exclude: [] }
      : { sources: ["src/**"], exclude: [] };

  const force = legacyMode !== null || !fs.existsSync(configPath);
  writeProjectConfig(config, { force });

  let seeded_implements = 0;
  let seeded_roles = 0;

  // Only seed from packages when migrating legacy configs (or first-time write with no prior sources).
  const shouldSeed = legacyMode !== null;

  if (shouldSeed) {
    let graph;
    try {
      graph = loadGraph();
    } catch {
      return { migrated: true, config, seeded_implements, seeded_roles };
    }

    const seedPackages = legacyMode === "required";
    const emptyImplements = legacyMode === "off";

    for (const node of graph.nodes) {
      if (!isPipelineNodeType(node.type)) continue;

      if (node.type === "Foundation" && !node.role) {
        const role = roleFromDescription(node.description);
        writeRoleFrontmatter(node, role, "current");
        seeded_roles++;
        if (node.next && !node.next.role) {
          writeRoleFrontmatter(node, role, "next");
        }
      }

      if (emptyImplements) {
        if (!node.implements) {
          writeImplementsFrontmatter(node, [], "current");
        }
        continue;
      }

      if (!seedPackages) continue;

      const relRoot = implementationRelativePath(node);
      const absRoot = implementationDir(node);
      if (!relRoot || !absRoot) continue;

      const files =
        fs.existsSync(absRoot) && fs.statSync(absRoot).isDirectory()
          ? collectPackageFiles(absRoot, relRoot)
          : [];

      const claim = files.length > 0 ? [`${relRoot}/`] : [];

      if (claim.length > 0 && !(node.implements && node.implements.length > 0)) {
        writeImplementsFrontmatter(node, claim, "current");
        seeded_implements++;
      }
      if (
        node.next &&
        claim.length > 0 &&
        !(node.next.implements && node.next.implements.length > 0)
      ) {
        writeImplementsFrontmatter(node, claim, "next");
      }
    }
  }

  return {
    migrated: legacyMode !== null,
    config,
    seeded_implements,
    seeded_roles,
  };
}

const LEGACY_LIVE_FILENAME = "current.mdx";
const LEGACY_NEXT_FILENAME = "next.mdx";

/** Type folders that may hold an evolution file. Journeys and Bugs must not. */
const EVOLUTION_TYPE_DIRS = new Set(["foundations", "interactions", "interfaces"]);

const TERRITORY_TYPE_DIRS = [
  "journeys",
  "foundations",
  "interactions",
  "interfaces",
  "bugs",
] as const;

export type LegacyTerritoryRename = {
  from: string;
  to: string;
  action: "renamed" | "removed";
};

/** Init stopped after zero or more territory renames. `applied` already happened on disk. */
export class LegacyTerritoryMigrationError extends Error {
  readonly applied: LegacyTerritoryRename[];
  constructor(message: string, applied: LegacyTerritoryRename[]) {
    super(message);
    this.name = "LegacyTerritoryMigrationError";
    this.applied = applied;
  }
}

function territoryFileRel(dirName: string, id: string, filename: string): string {
  return path.posix.join(MINDPLAN_DIR, dirName, id, filename);
}

function manualRenameFailure(fromRel: string, toRel: string, err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err);
  return new Error(
    `Blocked: could not rename ${fromRel} to ${toRel} (${detail}). Fix ${fromRel} by hand, then call upgrade_project again.`
  );
}

function renameLegacyTerritoryFile(
  folder: string,
  dirName: string,
  id: string,
  fromName: string,
  toName: string,
  slot: "current" | "next"
): LegacyTerritoryRename | null {
  const fromAbs = path.join(folder, fromName);
  const toAbs = path.join(folder, toName);
  const fromRel = territoryFileRel(dirName, id, fromName);
  const toRel = territoryFileRel(dirName, id, toName);
  if (fromName === toName) return null;
  const folderRel = path.posix.join(MINDPLAN_DIR, dirName, id);
  if (removeLegacyIfIdNamedExists(folder, id, slot, folderRel)) {
    return { from: fromRel, to: toRel, action: "removed" };
  }
  if (!fs.existsSync(fromAbs)) return null;
  if (fs.existsSync(toAbs)) {
    try {
      if (fs.realpathSync.native(fromAbs) === fs.realpathSync.native(toAbs)) return null;
    } catch {
      // Distinct paths that cannot be resolved still go through rename and surface a manual fix.
    }
  }
  try {
    fs.renameSync(fromAbs, toAbs);
  } catch (err) {
    throw manualRenameFailure(fromRel, toRel, err);
  }
  return { from: fromRel, to: toRel, action: "renamed" };
}

function directoryEntries(typePath: string): fs.Dirent[] {
  return fs
    .readdirSync(typePath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Evolution filenames under journeys/bugs. The live file is skipped when its name
 * collides with `next.mdx` (id `next`).
 */
function illegalEvolutionRels(folder: string, dirName: string, id: string): string[] {
  if (EVOLUTION_TYPE_DIRS.has(dirName)) return [];
  const live = liveMdxFilename(id).toLowerCase();
  const next = nextMdxFilename(id).toLowerCase();
  const rels: string[] = [];
  for (const name of fs.readdirSync(folder)) {
    const lower = name.toLowerCase();
    if (lower === live) continue;
    if (lower !== LEGACY_NEXT_FILENAME && lower !== next) continue;
    const abs = path.join(folder, name);
    if (!fs.statSync(abs).isFile()) continue;
    rels.push(territoryFileRel(dirName, id, name));
  }
  return rels;
}

/**
 * Renames legacy `current.mdx` / `next.mdx` to `<id>.mdx` / `<id>.next.mdx`.
 * Idempotent when files are already id-named. Runs before graph load.
 * Illegal evolution files are refused before any rename. A later filesystem failure
 * throws LegacyTerritoryMigrationError carrying the renames already applied.
 */
export function migrateLegacyTerritoryFilenames(): LegacyTerritoryRename[] {
  const root = mindplanRoot();
  if (!fs.existsSync(root)) return [];
  const renamed: LegacyTerritoryRename[] = [];
  try {
    const illegal: string[] = [];
    for (const dirName of TERRITORY_TYPE_DIRS) {
      const typePath = path.join(root, dirName);
      if (!fs.existsSync(typePath)) continue;
      for (const entry of directoryEntries(typePath)) {
        illegal.push(...illegalEvolutionRels(path.join(typePath, entry.name), dirName, entry.name));
      }
    }
    if (illegal.length > 0) {
      const listed = [...illegal].sort().join(", ");
      const fix = illegal.length === 1 ? illegal[0] : "these files";
      throw new LegacyTerritoryMigrationError(
        `Blocked: cannot rename ${listed}. Evolution files are not allowed under journeys or bugs. Fix ${fix} by hand, then call upgrade_project again.`,
        []
      );
    }

    for (const dirName of TERRITORY_TYPE_DIRS) {
      const typePath = path.join(root, dirName);
      if (!fs.existsSync(typePath)) continue;
      for (const entry of directoryEntries(typePath)) {
        const id = entry.name;
        const folder = path.join(typePath, id);
        try {
          const live = renameLegacyTerritoryFile(
            folder,
            dirName,
            id,
            LEGACY_LIVE_FILENAME,
            liveMdxFilename(id),
            "current"
          );
          if (live) renamed.push(live);
          if (!EVOLUTION_TYPE_DIRS.has(dirName)) continue;
          const next = renameLegacyTerritoryFile(
            folder,
            dirName,
            id,
            LEGACY_NEXT_FILENAME,
            nextMdxFilename(id),
            "next"
          );
          if (next) renamed.push(next);
        } catch (err) {
          if (err instanceof LegacyTerritoryMigrationError) throw err;
          const message = err instanceof Error ? err.message : String(err);
          throw new LegacyTerritoryMigrationError(message, [...renamed]);
        }
      }
    }
    return renamed;
  } finally {
    drainRemovedLegacyFiles();
  }
}

export type MirrorRemovalSkip = {
  node_id: string;
  reason: string;
};

export type MirrorRemovalResult = {
  /** Repo-relative paths deleted (each next file, and an emptied `next-attachments/`). */
  removed: string[];
  skipped: MirrorRemovalSkip[];
};


/**
 * Removes the Atomic Ops a release before 0.7.0 left on shipped Foundations, Interactions, and
 * Interfaces, so each shows its current state; an open next file keeps its own list. Returns the ids it changed, or none
 * when the graph cannot load.
 */
export function dropShippedAtomicOps(): string[] {
  let graph;
  try {
    graph = loadGraph();
  } catch {
    return [];
  }
  const dropped: string[] = [];
  for (const node of graph.nodes) {
    if (!isPipelineNodeType(node.type) || !node.shipped_at || node.state === "cancelled") continue;
    try {
      if (stripLiveAtomicOps(node)) dropped.push(node.id);
    } catch {
      // An unreadable live file fails the check; there is nothing to strip there.
    }
  }
  return dropped;
}

/**
 * Deletes the `state: mirror` next files releases before 0.8.0 kept beside shipped nodes (a node
 * now has a next file only while a revision is open). An open revision is never touched. Returns
 * nothing when the graph cannot load (e.g. mid-migration incomplete fixtures).
 */
export function removeLegacyMirrorTwins(): MirrorRemovalResult {
  let graph;
  try {
    graph = loadGraph();
  } catch {
    return { removed: [], skipped: [] };
  }
  const removed: string[] = [];
  const skipped: MirrorRemovalSkip[] = [];
  for (const node of graph.nodes) {
    if (!isPipelineNodeType(node.type) || node.next) continue;
    try {
      removed.push(...removeLegacyMirror(node));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      skipped.push({ node_id: node.id, reason });
    }
  }
  return { removed, skipped };
}

type Backfill = { revisionsBackfilled: string[]; splitsFound: Record<string, string[]> };

/**
 * Writes `revisions` and `churn` (and `split_at` / `split_into`) on every shipped Foundation,
 * Interaction, and Interface that lacks them, from the git history of its live file (`shipHistory`,
 * f-compiler-rules): each distinct `shipped_at` is a ship (plus one when the working tree holds a
 * ship not yet committed). A split is inferred only for a Foundation whose claimed files moved to a
 * newly shipped Foundation it then depends_on (`inferredSplits`); a new dependency alone is not one.
 * Outside git a node gets `revisions: 1`; a file git has not seen at its path waits for a later
 * upgrade. Nodes that already carry both fields are left alone, so a second run writes nothing.
 */
export function backfillRevisions(): Backfill {
  const result: Backfill = { revisionsBackfilled: [], splitsFound: {} };
  let graph;
  try {
    graph = loadGraph();
  } catch {
    return result;
  }
  const shipped = graph.nodes.filter(
    (n) => isPipelineNodeType(n.type) && n.shipped_at && n.state !== "cancelled"
  );
  const todo = shipped.filter((n) => n.revisions === undefined || n.churn === undefined);
  if (todo.length === 0) return result;
  const halfLife = hotspotSettings(loadSourceConfig()).half_life_days;
  // History is needed for the nodes to write, plus every Foundation when one of them is a Foundation
  // (a split's parts are Foundations, and their first ship and claims date and confirm the split).
  const needed = new Set(todo.map((n) => n.id));
  if (todo.some((n) => n.type === "Foundation")) for (const n of shipped) if (n.type === "Foundation") needed.add(n.id);
  const histories = new Map<string, ShipRecord[] | null>();
  for (const node of shipped) {
    if (needed.has(node.id)) histories.set(node.id, nodeShipHistory(node));
  }
  for (const node of todo) {
    const history = histories.get(node.id);
    // In git but never committed at this path (a rename this upgrade just made): wait for the commit,
    // so a later upgrade counts the real history instead of stamping 1 for good.
    if (history !== null && history !== undefined && history.length === 0) continue;
    const ships = history ?? [];
    const shipTimes = shipTimesOf(node, ships);
    const splits = inferredSplits(graph, node, ships, histories);
    const splitShips = new Set(splits.keys());
    const lastSplit = Math.max(-1, ...splitShips);
    const parts = [...new Set([...splits.values()].flat())].sort();
    const churn = replayChurn(shipTimes, splitShips, halfLife);
    let wrote: boolean;
    try {
      wrote = writeRevisionFields(node, {
        revisions: node.revisions ?? Math.max(1, shipTimes.length),
        churn,
        ...(lastSplit >= 0 ? { split_at: lastSplit + 1, split_into: parts } : {}),
      });
    } catch {
      continue; // An unreadable live file fails the check; there is nothing to stamp.
    }
    if (!wrote) continue;
    result.revisionsBackfilled.push(node.id);
    if (lastSplit >= 0) result.splitsFound[node.id] = parts;
  }
  return result;
}

/**
 * Deletes mindplan/agent/, the playbook, skills, integrations, and MCP example the retired init
 * copied there; the server now serves the playbook and skills itself. Returns the repo-relative
 * paths of the files it deleted (none when the folder is absent).
 */
export function removeRetiredAgentFiles(): string[] {
  const root = agentRoot();
  if (!fs.existsSync(root)) return [];
  const removed: string[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else removed.push(childRel);
    }
  };
  walk(root, path.posix.join(MINDPLAN_DIR, AGENT_DIR));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: RM_MAX_RETRIES });
  return removed.sort();
}

/**
 * The level a graph reaches after runMigrations. Raise it by one in the release that adds a
 * migration to runMigrations; a release that adds none leaves it, so projects need no upgrade.
 */
export const MIGRATION_LEVEL = 1;

export type MigrationReport = {
  territoryFilenames: LegacyTerritoryRename[];
  config: { migrated: boolean; sources: string[]; seeded_implements: number; seeded_roles: number };
  atomicOpsDropped: string[];
  mirrorTwinsRemoved: string[];
  mirrorTwinSkips: MirrorRemovalSkip[];
  revisionsBackfilled: string[];
  splitsFound: Record<string, string[]>;
  agentFilesRemoved: string[];
};

/**
 * Runs every migration in order. Each is idempotent, so a graph already at MIGRATION_LEVEL is left
 * as it is, and a node a stale branch merged in an old format is brought up to date. Throws
 * LegacyTerritoryMigrationError when a rename fails after others were applied.
 */
export function runMigrations(): MigrationReport {
  const territoryFilenames = migrateLegacyTerritoryFilenames();
  const config = migrateImplementationPackages();
  const atomicOpsDropped = dropShippedAtomicOps();
  const mirrorRemoval = removeLegacyMirrorTwins();
  const backfill = backfillRevisions();
  const agentFilesRemoved = removeRetiredAgentFiles();
  drainRemovedLegacyFiles();
  return {
    territoryFilenames,
    config: {
      migrated: config.migrated,
      sources: config.config.sources,
      seeded_implements: config.seeded_implements,
      seeded_roles: config.seeded_roles,
    },
    atomicOpsDropped,
    mirrorTwinsRemoved: mirrorRemoval.removed,
    mirrorTwinSkips: mirrorRemoval.skipped,
    revisionsBackfilled: backfill.revisionsBackfilled,
    splitsFound: backfill.splitsFound,
    agentFilesRemoved,
  };
}
