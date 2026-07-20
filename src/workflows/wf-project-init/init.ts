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
  projectRelativePath: string
): InstallAgentRuleResult {
  if (fs.existsSync(destPath)) {
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
  projectRelativePath: string
): InstallSkillResult {
  if (fs.existsSync(destDir)) {
    return { installed: false, path: projectRelativePath };
  }
  if (!fs.existsSync(templateDir)) {
    throw new Error(`Agent template not found at ${templateDir}`);
  }
  copyDirRecursive(templateDir, destDir);
  return { installed: true, path: projectRelativePath };
}

/** Copies the bundled playbook into mindplan/agent/playbook.md (idempotent). */
export function installAgentPlaybook(packageRoot: string): InstallAgentRuleResult {
  const root = agentTemplateRoot(packageRoot);
  const destPath = path.join(agentRoot(), "playbook.md");
  return installTemplateFile(
    path.join(root, "playbook.md"),
    destPath,
    path.posix.join(MINDPLAN_DIR, AGENT_DIR, "playbook.md")
  );
}

/** Copies the define-entities skill into mindplan/agent/skills/define-entities/ (idempotent). */
export function installDefineEntitiesSkill(packageRoot: string): InstallSkillResult {
  const root = agentTemplateRoot(packageRoot);
  const destDir = path.join(agentRoot(), "skills", "define-entities");
  return installTemplateDir(
    path.join(root, "skills", "define-entities"),
    destDir,
    path.posix.join(MINDPLAN_DIR, AGENT_DIR, "skills", "define-entities")
  );
}

/** Copies the plan-project skill into mindplan/agent/skills/plan-project/ (idempotent). */
export function installPlanProjectSkill(packageRoot: string): InstallSkillResult {
  const root = agentTemplateRoot(packageRoot);
  const destDir = path.join(agentRoot(), "skills", "plan-project");
  return installTemplateDir(
    path.join(root, "skills", "plan-project"),
    destDir,
    path.posix.join(MINDPLAN_DIR, AGENT_DIR, "skills", "plan-project")
  );
}

/** Copies MCP config example into mindplan/agent/mcp.json.example (idempotent). */
export function installMcpExample(packageRoot: string): InstallAgentRuleResult {
  const root = agentTemplateRoot(packageRoot);
  const destPath = path.join(agentRoot(), "mcp.json.example");
  return installTemplateFile(
    path.join(root, "mcp.json.example"),
    destPath,
    path.posix.join(MINDPLAN_DIR, AGENT_DIR, "mcp.json.example")
  );
}

/** Copies per-agent integration guides into mindplan/agent/integrations/ (idempotent). */
export function installAgentIntegrations(packageRoot: string): InstallSkillResult {
  const root = agentTemplateRoot(packageRoot);
  const destDir = path.join(agentRoot(), "integrations");
  return installTemplateDir(
    path.join(root, "integrations"),
    destDir,
    path.posix.join(MINDPLAN_DIR, AGENT_DIR, "integrations")
  );
}

/** Creates root AGENTS.md from the playbook when missing (idempotent). */
export function installRootAgentsMd(packageRoot: string): InstallAgentRuleResult {
  const templatePath = path.join(agentTemplateRoot(packageRoot), "playbook.md");
  const destPath = path.join(projectRoot(), "AGENTS.md");
  return installTemplateFile(templatePath, destPath, "AGENTS.md");
}

/** Installs `.cursorignore` at project root when missing (idempotent).
 * Template ignores `mindplan/map.md` + `mindplan/agent/**` only —
 * territory `current.mdx` / `next.mdx` stay editable via host file tools.
 */
export function installCursorIgnore(packageRoot: string): InstallAgentRuleResult {
  const templatePath = path.join(agentTemplateRoot(packageRoot), "cursorignore");
  const destPath = path.join(projectRoot(), ".cursorignore");
  return installTemplateFile(templatePath, destPath, ".cursorignore");
}

/** Installs `.cursor/permissions.json` when missing (idempotent).
 * Allowlists MindPlan MCP tools so Cursor Auto-review does not prompt on
 * playbook-required graph mutations (status transitions, create/link, etc.).
 */
export function installCursorPermissions(packageRoot: string): InstallAgentRuleResult {
  const templatePath = path.join(agentTemplateRoot(packageRoot), "permissions.json");
  const destPath = path.join(projectRoot(), ".cursor", "permissions.json");
  return installTemplateFile(templatePath, destPath, ".cursor/permissions.json");
}

/** Installs mindplan/config.json for prescribed or layout-free adoption.
 * Creates when missing. Overwrites only when `force` is true (explicit --layout).
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
