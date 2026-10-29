/**
 * Consumer project init — scaffolds mindplan/ and installs agent assets.
 * Stamps mindplan/version.json; a missing or older stamp refreshes the package-owned agent files.
 * Migrates legacy implementation_packages → { sources, exclude } and seeds implements/role.
 * Renames legacy current.mdx / next.mdx to <id>.mdx / <id>.next.mdx before graph load.
 * Owned by Interaction i-init-project.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  isPipelineNodeType,
  type FoundationRole,
} from "../../foundations/f-domain-model/types.js";
import {
  writeProjectConfig,
  type MindPlanProjectConfig,
} from "../../foundations/f-source-index/config.js";
import { repoPrefix, repoTop } from "../../foundations/f-source-index/git.js";
import {
  PROJECT_FILENAME,
  PROJECT_RELATIVE_PATH,
} from "../../foundations/f-territory-store/project.js";
import {
  AGENT_DIR,
  MINDPLAN_DIR,
  agentRoot,
  ensureDirectories,
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
  writeRoleFrontmatter,
} from "../../foundations/f-territory-store/store.js";
import {
  projectVersionStatus,
  writeProjectVersion,
} from "../../foundations/f-territory-store/version.js";

export type InitResult = {
  root: string;
  created: boolean;
};

export type InstallOptions = {
  /** When true, overwrite existing agent assets from templates. */
  force?: boolean;
};

export type InstallAgentRuleResult = {
  installed: boolean;
  path: string;
};

export type InstallSkillResult = {
  installed: boolean;
  path: string;
};

export type InstallProjectConfigResult = {
  installed: boolean;
  path: string;
  config: MindPlanProjectConfig;
  migrated?: boolean;
  seeded_implements?: number;
  seeded_roles?: number;
};

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function agentTemplateRoot(packageRoot: string): string {
  return path.join(packageRoot, "templates", "agent");
}

function installTemplateFile(
  templatePath: string,
  destPath: string,
  projectRelativePath: string,
  options: InstallOptions = {}
): InstallAgentRuleResult {
  const force = options.force === true;
  if (fs.existsSync(destPath) && !force) {
    return { installed: false, path: projectRelativePath };
  }
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Agent template not found at ${templatePath}`);
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(templatePath, destPath);
  return { installed: true, path: projectRelativePath };
}

function installTemplateDir(
  templateDir: string,
  destDir: string,
  projectRelativePath: string,
  options: InstallOptions = {}
): InstallSkillResult {
  const force = options.force === true;
  if (fs.existsSync(destDir) && !force) {
    return { installed: false, path: projectRelativePath };
  }
  if (!fs.existsSync(templateDir)) {
    throw new Error(`Agent template not found at ${templateDir}`);
  }
  if (fs.existsSync(destDir) && force) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  copyDirRecursive(templateDir, destDir);
  return { installed: true, path: projectRelativePath };
}

/** Copies the bundled playbook into mindplan/agent/playbook.md (idempotent unless force). */
export function installAgentPlaybook(
  packageRoot: string,
  options: InstallOptions = {}
): InstallAgentRuleResult {
  const root = agentTemplateRoot(packageRoot);
  const destPath = path.join(agentRoot(), "playbook.md");
  return installTemplateFile(
    path.join(root, "playbook.md"),
    destPath,
    path.posix.join(MINDPLAN_DIR, AGENT_DIR, "playbook.md"),
    options
  );
}

export function installDefineEntitiesSkill(
  packageRoot: string,
  options: InstallOptions = {}
): InstallSkillResult {
  const root = agentTemplateRoot(packageRoot);
  const destDir = path.join(agentRoot(), "skills", "define-entities");
  return installTemplateDir(
    path.join(root, "skills", "define-entities"),
    destDir,
    path.posix.join(MINDPLAN_DIR, AGENT_DIR, "skills", "define-entities"),
    options
  );
}

export function installPlanProjectSkill(
  packageRoot: string,
  options: InstallOptions = {}
): InstallSkillResult {
  const root = agentTemplateRoot(packageRoot);
  const destDir = path.join(agentRoot(), "skills", "plan-project");
  return installTemplateDir(
    path.join(root, "skills", "plan-project"),
    destDir,
    path.posix.join(MINDPLAN_DIR, AGENT_DIR, "skills", "plan-project"),
    options
  );
}

export function installMcpExample(
  packageRoot: string,
  options: InstallOptions = {}
): InstallAgentRuleResult {
  const root = agentTemplateRoot(packageRoot);
  const destPath = path.join(agentRoot(), "mcp.json.example");
  return installTemplateFile(
    path.join(root, "mcp.json.example"),
    destPath,
    path.posix.join(MINDPLAN_DIR, AGENT_DIR, "mcp.json.example"),
    options
  );
}

export function installAgentIntegrations(
  packageRoot: string,
  options: InstallOptions = {}
): InstallSkillResult {
  const root = agentTemplateRoot(packageRoot);
  const destDir = path.join(agentRoot(), "integrations");
  return installTemplateDir(
    path.join(root, "integrations"),
    destDir,
    path.posix.join(MINDPLAN_DIR, AGENT_DIR, "integrations"),
    options
  );
}

export function installRootAgentsMd(
  packageRoot: string,
  options: InstallOptions = {}
): InstallAgentRuleResult {
  const templatePath = path.join(agentTemplateRoot(packageRoot), "agents-stub.md");
  const destPath = path.join(projectRoot(), "AGENTS.md");
  return installTemplateFile(templatePath, destPath, "AGENTS.md", options);
}

/** The search cache directory init keeps out of git (`.mindplan-cache/`, f-search-index). */
export const SEARCH_CACHE_IGNORE = ".mindplan-cache/";

/**
 * Add `.mindplan-cache/` to the host repo's `.gitignore` (created when missing), once. The cache
 * also carries its own `.gitignore`; the root entry keeps it out of tools that do not read nested
 * ignore files. `installed` is false when the entry was already there.
 */
export function installSearchCacheIgnore(): InstallAgentRuleResult {
  const destPath = path.join(projectRoot(), ".gitignore");
  const existing = fs.existsSync(destPath) ? fs.readFileSync(destPath, "utf-8") : "";
  const present = existing
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^\//, "").replace(/\/$/, ""))
    .includes(".mindplan-cache");
  if (present) return { installed: false, path: ".gitignore" };
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : eol;
  fs.writeFileSync(
    destPath,
    `${existing}${sep}# MindPlan search cache (derived; safe to delete)${eol}${SEARCH_CACHE_IGNORE}${eol}`,
    "utf-8"
  );
  return { installed: true, path: ".gitignore" };
}

export function installCursorIgnore(
  packageRoot: string,
  options: InstallOptions = {}
): InstallAgentRuleResult {
  const templatePath = path.join(agentTemplateRoot(packageRoot), "cursorignore");
  const destPath = path.join(projectRoot(), ".cursorignore");
  return installTemplateFile(templatePath, destPath, ".cursorignore", options);
}

const HOST_SKILL_COPIES = [
  { template: "define-entities", dest: "mindplan-define-entities" },
  { template: "plan-project", dest: "mindplan-plan-project" },
] as const;

export function installCursorSkills(
  packageRoot: string,
  options: InstallOptions = {}
): InstallSkillResult[] {
  const root = agentTemplateRoot(packageRoot);
  return HOST_SKILL_COPIES.map(({ template, dest }) =>
    installTemplateDir(
      path.join(root, "skills", template),
      path.join(projectRoot(), ".cursor", "skills", dest),
      path.posix.join(".cursor", "skills", dest),
      options
    )
  );
}

const CURSOR_RULE_FRONTMATTER =
  "---\n" +
  "description: MindPlan — orient on the product graph before planning or changing code\n" +
  "alwaysApply: true\n" +
  "---\n\n";

export function installCursorRule(
  packageRoot: string,
  options: InstallOptions = {}
): InstallAgentRuleResult {
  const destPath = path.join(projectRoot(), ".cursor", "rules", "mindplan.mdc");
  const projectRelativePath = ".cursor/rules/mindplan.mdc";
  const force = options.force === true;
  if (fs.existsSync(destPath) && !force) {
    return { installed: false, path: projectRelativePath };
  }
  const templatePath = path.join(agentTemplateRoot(packageRoot), "agents-stub.md");
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Agent template not found at ${templatePath}`);
  }
  const body = fs.readFileSync(templatePath, "utf-8");
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, CURSOR_RULE_FRONTMATTER + body, "utf-8");
  return { installed: true, path: projectRelativePath };
}

export function installCursorPermissions(
  packageRoot: string,
  options: InstallOptions = {}
): InstallAgentRuleResult {
  const templatePath = path.join(agentTemplateRoot(packageRoot), "permissions.json");
  const destPath = path.join(projectRoot(), ".cursor", "permissions.json");
  return installTemplateFile(templatePath, destPath, ".cursor/permissions.json", options);
}

export type InitCi = "github";

/** CI integrations `init --ci` can install. */
export const INIT_CI: readonly InitCi[] = ["github"];

/** Where `init --ci github` writes the merge-gate workflow (repo-owned: kept unless force). */
export const MERGE_GATE_WORKFLOW = ".github/workflows/mindplan-merge-gate.yml";

/**
 * Install the GitHub Actions merge gate: `check --merge` on pull requests to the default branch.
 * GitHub reads workflows only from the repository top, so the file goes there and its steps run in
 * the project root (`{{MINDPLAN_DIR}}`: `.` when the project is the repository top); outside git
 * it goes under the project root. `{{MINDPLAN_VERSION}}` becomes the running package's
 * major.minor, so `npx` resolves a release that has the flag. An existing workflow is kept unless
 * force. The returned path is relative to the project root.
 */
export function installMergeGateWorkflow(
  packageRoot: string,
  packageVersion: string,
  options: InstallOptions = {}
): InstallAgentRuleResult {
  const root = projectRoot();
  const top = repoTop(root) ?? root;
  const dir = (repoPrefix(root) ?? "").replace(/\/$/, "") || ".";
  const destPath = path.join(top, ...MERGE_GATE_WORKFLOW.split("/"));
  const shown = path.relative(root, destPath).split(path.sep).join("/");
  if (fs.existsSync(destPath) && options.force !== true) {
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

export type InitHost = "cursor" | "claude";

export const INIT_HOSTS: readonly InitHost[] = ["cursor", "claude"];

/** CLAUDE.md imports the shared AGENTS.md stub, because Claude Code reads CLAUDE.md, not AGENTS.md. */
const CLAUDE_MD_BODY = "@AGENTS.md\n";

export function installClaudeMd(options: InstallOptions = {}): InstallAgentRuleResult {
  const destPath = path.join(projectRoot(), "CLAUDE.md");
  if (fs.existsSync(destPath) && options.force !== true) {
    return { installed: false, path: "CLAUDE.md" };
  }
  fs.writeFileSync(destPath, CLAUDE_MD_BODY, "utf-8");
  return { installed: true, path: "CLAUDE.md" };
}

export function installClaudeSkills(
  packageRoot: string,
  options: InstallOptions = {}
): InstallSkillResult[] {
  const root = agentTemplateRoot(packageRoot);
  return HOST_SKILL_COPIES.map(({ template, dest }) =>
    installTemplateDir(
      path.join(root, "skills", template),
      path.join(projectRoot(), ".claude", "skills", dest),
      path.posix.join(".claude", "skills", dest),
      options
    )
  );
}

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

/** Installs or migrates mindplan/config.json to { sources, exclude }. */
export function installProjectConfig(): InstallProjectConfigResult {
  const beforeExists = fs.existsSync(path.join(projectRoot(), MINDPLAN_DIR, "config.json"));
  const result = migrateImplementationPackages();
  return {
    installed: result.migrated || !beforeExists,
    path: path.posix.join(MINDPLAN_DIR, "config.json"),
    config: result.config,
    migrated: result.migrated,
    seeded_implements: result.seeded_implements,
    seeded_roles: result.seeded_roles,
  };
}

/** Scaffolds an empty mindplan/ tree in the consumer project (idempotent). */
export function initProject(): InitResult {
  const root = mindplanRoot();
  const existed = fs.existsSync(root);
  ensureDirectories();
  return { root, created: !existed };
}

/**
 * Writes mindplan/project.md when missing.
 * Never overwrites — force does not apply (product text is owned by the repo).
 */
export function installProjectBrief(packageRoot: string): InstallAgentRuleResult {
  const destPath = path.join(mindplanRoot(), PROJECT_FILENAME);
  if (fs.existsSync(destPath)) {
    return { installed: false, path: PROJECT_RELATIVE_PATH };
  }
  const templatePath = path.join(agentTemplateRoot(packageRoot), "project.md");
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Agent template not found at ${templatePath}`);
  }
  fs.mkdirSync(mindplanRoot(), { recursive: true });
  fs.copyFileSync(templatePath, destPath);
  return { installed: true, path: PROJECT_RELATIVE_PATH };
}

/** Walk up from this module until templates/agent exists (works from nested dist/...). */
export function resolvePackageRoot(moduleUrl: string): string {
  let dir = path.dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "templates", "agent"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not locate MindPlan package root (templates/agent missing). " +
      "Run mindplan-mcp from an installed package that includes templates/."
  );
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
    `Blocked: could not rename ${fromRel} to ${toRel} (${detail}). Fix ${fromRel} by hand, then run mindplan-mcp init again.`
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
        `Blocked: cannot rename ${listed}. Evolution files are not allowed under journeys or bugs. Fix ${fix} by hand, then run mindplan-mcp init again.`,
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

export type RunInitOptions = {
  force: boolean;
  packageRoot: string;
  /** Host copies to install. Defaults to ["cursor"]. */
  hosts?: readonly InitHost[];
  /** CI integration to install (the merge-gate workflow). None by default. */
  ci?: InitCi;
};

export type MirrorRemovalSkip = {
  node_id: string;
  reason: string;
};

export type MirrorRemovalResult = {
  /** Repo-relative paths deleted (each next file, and an emptied `next-attachments/`). */
  removed: string[];
  skipped: MirrorRemovalSkip[];
};

export type RunInitReport = {
  root: string;
  created: boolean;
  territoryFilenames: LegacyTerritoryRename[];
  projectConfig: InstallProjectConfigResult;
  projectBrief: InstallAgentRuleResult;
  playbook: InstallAgentRuleResult;
  skill: InstallSkillResult;
  planSkill: InstallSkillResult;
  mcpExample: InstallAgentRuleResult;
  integrations: InstallSkillResult;
  agentsMd: InstallAgentRuleResult;
  /** The `.mindplan-cache/` entry in the repo's `.gitignore`. */
  searchCacheIgnore: InstallAgentRuleResult;
  /** Cursor host copies; present only when the cursor host was selected. */
  cursor?: {
    ignore: InstallAgentRuleResult;
    skills: InstallSkillResult[];
    rule: InstallAgentRuleResult;
    permissions: InstallAgentRuleResult;
  };
  /** Claude Code host copies; present only when the claude host was selected. */
  claude?: {
    claudeMd: InstallAgentRuleResult;
    skills: InstallSkillResult[];
  };
  /** The merge-gate workflow; present only when `ci` was requested. */
  ci?: InstallAgentRuleResult;
  /** The stamp before (null when absent or unreadable) and after this run; refreshed when package-owned files were rewritten. */
  version: { from: string | null; to: string; refreshed: boolean };
  /** Shipped nodes whose live Atomic Ops init removed (a release before 0.7.0 kept shipped ledgers). */
  atomicOpsDropped: string[];
  /** Paths of the `state: mirror` twins (and their emptied `next-attachments/`) init deleted. */
  mirrorTwinsRemoved: string[];
  /** Nodes whose leftover twin could not be deleted. */
  mirrorTwinSkips: MirrorRemovalSkip[];
  /** Legacy files deleted by a graph load after the rename walk (the walk itself is in territoryFilenames). */
  removedLegacyFiles: { from: string; to: string }[];
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
      // An unreadable live file fails the check; init has nothing to strip there.
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

/**
 * Runs all consumer installers and returns a structured report.
 * CLI owns console output / exit codes — this package does not print or exit.
 */
export function runInit(opts: RunInitOptions): RunInitReport {
  const installOpts = { force: opts.force };
  const status = projectVersionStatus();
  if (status.state === "ahead" && !opts.force) {
    throw new Error(
      `Blocked: ${status.warning} Or pass --force to rewrite this project with ${status.running.package}.`
    );
  }
  // Package-owned files follow the package: rewrite them when the stamp is not current.
  // Repo-owned files (AGENTS.md, CLAUDE.md, .cursorignore, permissions, project.md) keep installOpts.
  const refreshed = opts.force || status.state !== "current";
  const packageOpts = { force: refreshed };
  try {
  const territoryFilenames = migrateLegacyTerritoryFilenames();
  const { root, created } = initProject();
  const projectConfig = installProjectConfig();
  const projectBrief = installProjectBrief(opts.packageRoot);
  const playbook = installAgentPlaybook(opts.packageRoot, packageOpts);
  const skill = installDefineEntitiesSkill(opts.packageRoot, packageOpts);
  const planSkill = installPlanProjectSkill(opts.packageRoot, packageOpts);
  const mcpExample = installMcpExample(opts.packageRoot, packageOpts);
  const integrations = installAgentIntegrations(opts.packageRoot, packageOpts);
  const agentsMd = installRootAgentsMd(opts.packageRoot, installOpts);
  const searchCacheIgnore = installSearchCacheIgnore();
  const hosts = opts.hosts ?? ["cursor"];
  const cursor = hosts.includes("cursor")
    ? {
        ignore: installCursorIgnore(opts.packageRoot, installOpts),
        skills: installCursorSkills(opts.packageRoot, packageOpts),
        rule: installCursorRule(opts.packageRoot, packageOpts),
        permissions: installCursorPermissions(opts.packageRoot, installOpts),
      }
    : undefined;
  const claude = hosts.includes("claude")
    ? {
        claudeMd: installClaudeMd(installOpts),
        skills: installClaudeSkills(opts.packageRoot, packageOpts),
      }
    : undefined;
  const ci =
    opts.ci === "github"
      ? installMergeGateWorkflow(opts.packageRoot, status.running.package, installOpts)
      : undefined;
  const atomicOpsDropped = dropShippedAtomicOps();
  const mirrorRemoval = removeLegacyMirrorTwins();
  writeProjectVersion(status.running);

  return {
    root,
    created,
    territoryFilenames,
    projectConfig,
    projectBrief,
    playbook,
    skill,
    planSkill,
    mcpExample,
    integrations,
    agentsMd,
    searchCacheIgnore,
    cursor,
    claude,
    ...(ci ? { ci } : {}),
    version: {
      from: status.project?.package ?? null,
      to: status.running.package,
      refreshed,
    },
    atomicOpsDropped,
    mirrorTwinsRemoved: mirrorRemoval.removed,
    mirrorTwinSkips: mirrorRemoval.skipped,
    removedLegacyFiles: drainRemovedLegacyFiles(),
  };
  } catch (err) {
    const removed = drainRemovedLegacyFiles();
    if (removed.length === 0 || err instanceof LegacyTerritoryMigrationError) throw err;
    const note = removed.map((entry) => `Removed ${entry.from} (kept ${entry.to})`).join("\n");
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message}\n${note}`);
  }
}
