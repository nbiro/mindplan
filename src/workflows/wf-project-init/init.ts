/**
 * Consumer project init — scaffolds mindplan/ and installs agent assets.
 * Owned by Workflow wf-project-init.
 */

import * as fs from "fs";
import * as path from "path";
import {
  AGENT_DIR,
  MINDPLAN_DIR,
  agentRoot,
  ensureDirectories,
  mindplanRoot,
  projectRoot,
  writeProjectConfig,
  type ImplementationPackagesMode,
  type MindPlanProjectConfig,
} from "../../foundations/f-territory-store/store.js";

export type InitLayout = "free" | "prescribed";

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

/** Copies the define-entities skill into mindplan/agent/skills/define-entities/ (idempotent unless force). */
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

/** Copies the plan-project skill into mindplan/agent/skills/plan-project/ (idempotent unless force). */
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

/** Copies the review-work skill into mindplan/agent/skills/review-work/ (idempotent unless force). */
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

/** Copies the thin code-review skill into mindplan/agent/skills/code-review/ (idempotent unless force). */
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

/** Copies MCP config example into mindplan/agent/mcp.json.example (idempotent unless force). */
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

/** Copies per-agent integration guides into mindplan/agent/integrations/ (idempotent unless force). */
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

/** Creates root AGENTS.md from the playbook when missing (idempotent unless force). */
export function installRootAgentsMd(
  packageRoot: string,
  options: InstallOptions = {}
): InstallAgentRuleResult {
  const templatePath = path.join(agentTemplateRoot(packageRoot), "playbook.md");
  const destPath = path.join(projectRoot(), "AGENTS.md");
  return installTemplateFile(templatePath, destPath, "AGENTS.md", options);
}

/** Installs `.cursorignore` at project root when missing (idempotent unless force).
 * Template ignores `mindplan/map.md` + `mindplan/agent/**` only —
 * territory `current.mdx` / `next.mdx` stay editable via host file tools.
 */
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

/** Copies skills into `.cursor/skills/mindplan-*` for Cursor discovery (idempotent unless force).
 * Sources `templates/agent/skills/…` — not the on-disk `mindplan/agent` copy.
 */
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

/** Writes `.cursor/rules/mindplan.mdc` (alwaysApply frontmatter + playbook body) when missing (or force). */
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

/** Installs `.cursor/permissions.json` when missing (idempotent unless force).
 * Allowlists MindPlan MCP tools so Cursor Auto-review does not prompt on
 * playbook-required graph mutations (status transitions, create/link, etc.).
 */
export function installCursorPermissions(
  packageRoot: string,
  options: InstallOptions = {}
): InstallAgentRuleResult {
  const templatePath = path.join(agentTemplateRoot(packageRoot), "permissions.json");
  const destPath = path.join(projectRoot(), ".cursor", "permissions.json");
  return installTemplateFile(templatePath, destPath, ".cursor/permissions.json", options);
}

/** Installs mindplan/config.json for prescribed or layout-free adoption.
 * Creates when missing. Overwrites only when `force` is true (explicit --layout).
 * Agent-asset `-f` does not control this helper.
 */
export function installProjectConfig(
  layout: InitLayout = "prescribed",
  options: { force?: boolean } = {}
): InstallProjectConfigResult {
  const mode: ImplementationPackagesMode = layout === "free" ? "off" : "required";
  const result = writeProjectConfig(mode, { force: options.force === true });
  return {
    installed: result.written,
    path: result.path,
    config: result.config,
  };
}

/** Scaffolds an empty mindplan/ tree in the consumer project (idempotent). */
export function initProject(): InitResult {
  const root = mindplanRoot();
  const existed = fs.existsSync(root);
  ensureDirectories();
  return { root, created: !existed };
}
