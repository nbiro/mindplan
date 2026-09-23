/**
 * Consumer project init — scaffolds mindplan/ and installs agent assets.
 * Migrates legacy implementation_packages → { sources, exclude } and seeds implements/role.
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
import {
  AGENT_DIR,
  MINDPLAN_DIR,
  agentRoot,
  ensureDirectories,
  implementationDir,
  implementationRelativePath,
  loadGraph,
  mindplanRoot,
  projectRoot,
  writeImplementsFrontmatter,
  writeRoleFrontmatter,
} from "../../foundations/f-territory-store/store.js";

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

export function installReviewWorkSkill(
  packageRoot: string,
  options: InstallOptions = {}
): InstallSkillResult {
  const root = agentTemplateRoot(packageRoot);
  const destDir = path.join(agentRoot(), "skills", "review-work");
  return installTemplateDir(
    path.join(root, "skills", "review-work"),
    destDir,
    path.posix.join(MINDPLAN_DIR, AGENT_DIR, "skills", "review-work"),
    options
  );
}

export function installCodeReviewSkill(
  packageRoot: string,
  options: InstallOptions = {}
): InstallSkillResult {
  const root = agentTemplateRoot(packageRoot);
  const destDir = path.join(agentRoot(), "skills", "code-review");
  return installTemplateDir(
    path.join(root, "skills", "code-review"),
    destDir,
    path.posix.join(MINDPLAN_DIR, AGENT_DIR, "skills", "code-review"),
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
  const templatePath = path.join(agentTemplateRoot(packageRoot), "playbook.md");
  const destPath = path.join(projectRoot(), "AGENTS.md");
  return installTemplateFile(templatePath, destPath, "AGENTS.md", options);
}

export function installCursorIgnore(
  packageRoot: string,
  options: InstallOptions = {}
): InstallAgentRuleResult {
  const templatePath = path.join(agentTemplateRoot(packageRoot), "cursorignore");
  const destPath = path.join(projectRoot(), ".cursorignore");
  return installTemplateFile(templatePath, destPath, ".cursorignore", options);
}

const CURSOR_SKILL_COPIES = [
  { template: "define-entities", dest: "mindplan-define-entities" },
  { template: "plan-project", dest: "mindplan-plan-project" },
  { template: "review-work", dest: "mindplan-review-work" },
  { template: "code-review", dest: "mindplan-code-review" },
] as const;

export function installCursorSkills(
  packageRoot: string,
  options: InstallOptions = {}
): InstallSkillResult[] {
  const root = agentTemplateRoot(packageRoot);
  return CURSOR_SKILL_COPIES.map(({ template, dest }) =>
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
  "description: MindPlan SDLC execution process — always-on development workflow, MCP mutations, compiler rules\n" +
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
  const templatePath = path.join(agentTemplateRoot(packageRoot), "playbook.md");
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

export type RunInitOptions = {
  force: boolean;
  packageRoot: string;
};

export type RunInitReport = {
  root: string;
  created: boolean;
  projectConfig: InstallProjectConfigResult;
  playbook: InstallAgentRuleResult;
  skill: InstallSkillResult;
  planSkill: InstallSkillResult;
  reviewSkill: InstallSkillResult;
  codeReviewSkill: InstallSkillResult;
  mcpExample: InstallAgentRuleResult;
  integrations: InstallSkillResult;
  agentsMd: InstallAgentRuleResult;
  cursorIgnore: InstallAgentRuleResult;
  cursorSkills: InstallSkillResult[];
  cursorRule: InstallAgentRuleResult;
  cursorPermissions: InstallAgentRuleResult;
};

/**
 * Runs all consumer installers and returns a structured report.
 * CLI owns console output / exit codes — this package does not print or exit.
 */
export function runInit(opts: RunInitOptions): RunInitReport {
  const installOpts = { force: opts.force };
  const { root, created } = initProject();
  const projectConfig = installProjectConfig();
  const playbook = installAgentPlaybook(opts.packageRoot, installOpts);
  const skill = installDefineEntitiesSkill(opts.packageRoot, installOpts);
  const planSkill = installPlanProjectSkill(opts.packageRoot, installOpts);
  const reviewSkill = installReviewWorkSkill(opts.packageRoot, installOpts);
  const codeReviewSkill = installCodeReviewSkill(opts.packageRoot, installOpts);
  const mcpExample = installMcpExample(opts.packageRoot, installOpts);
  const integrations = installAgentIntegrations(opts.packageRoot, installOpts);
  const agentsMd = installRootAgentsMd(opts.packageRoot, installOpts);
  const cursorIgnore = installCursorIgnore(opts.packageRoot, installOpts);
  const cursorSkills = installCursorSkills(opts.packageRoot, installOpts);
  const cursorRule = installCursorRule(opts.packageRoot, installOpts);
  const cursorPermissions = installCursorPermissions(opts.packageRoot, installOpts);

  return {
    root,
    created,
    projectConfig,
    playbook,
    skill,
    planSkill,
    reviewSkill,
    codeReviewSkill,
    mcpExample,
    integrations,
    agentsMd,
    cursorIgnore,
    cursorSkills,
    cursorRule,
    cursorPermissions,
  };
}
