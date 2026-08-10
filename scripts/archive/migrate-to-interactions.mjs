#!/usr/bin/env node
/**
 * One-off migration: Workflow-centric self-hosted graph → Interaction-centric.
 * See mindplan/workflows/wf-interaction-model/attachments/classification.md
 *
 * Run from repo root AFTER source code supports Interaction/Interface types:
 *   node scripts/archive/migrate-to-interactions.mjs
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const CLASSIFICATION = {
  foundations: {
    "wf-console-shell": "f-console-shell",
    "wf-test-harness": "f-test-harness",
    "wf-framework-docs": "f-framework-docs",
  },
  interactions: {
    "wf-query-graph": "i-orient-plan",
    "wf-mutate-graph": "i-steer-plan",
    "wf-export-views": "i-export-map",
    "wf-integrity-check": "i-check-integrity",
    "wf-project-init": "i-init-project",
    "wf-territory-viewer": "i-browse-territory",
    "wf-status-board": "i-view-status",
    "wf-graph-explore": "i-explore-graph",
    "wf-console-mutate": "i-mutate-plan",
    "wf-model-plan": "i-model-plan",
    "wf-npm-publish": "i-npm-publish",
    "wf-npm-tag-publish": "i-npm-tag-publish",
  },
  absorbed: {
    "wf-impl-packages": "f-territory-store",
    "wf-layout-free": "i-init-project",
    "wf-agent-integrations": "f-framework-docs",
  },
  /** Keep id; only change type Workflow → Interaction */
  mechanical: [
    "wf-export-views-v2",
    "wf-framework-docs-v3",
    "wf-project-init-v2",
    "wf-query-graph-v2",
    "wf-workflow-affected-files",
  ],
  interfaces: [
    { id: "if-mcp-tools", title: "MCP tools", description: "MCP tool Interface exposing orient, steer, and export Interactions.", exposes: ["i-orient-plan", "i-steer-plan", "i-export-map"], depends_on: ["f-mcp-runtime"] },
    { id: "if-cli", title: "CLI commands", description: "CLI Interface exposing init and integrity-check Interactions.", exposes: ["i-init-project", "i-check-integrity"], depends_on: ["f-mcp-runtime"] },
    { id: "if-console-territory", title: "Console territory page", description: "Console page Interface for browsing territory.", exposes: ["i-browse-territory"], depends_on: ["f-console-shell", "f-design-system"] },
    { id: "if-console-status", title: "Console status page", description: "Console page Interface for the status board.", exposes: ["i-view-status"], depends_on: ["f-console-shell", "f-design-system"] },
    { id: "if-console-graph", title: "Console graph page", description: "Console page Interface for graph explore.", exposes: ["i-explore-graph"], depends_on: ["f-console-shell", "f-xyflow"] },
    { id: "if-console-mutate", title: "Console mutate page", description: "Console page Interface for steering the plan.", exposes: ["i-mutate-plan"], depends_on: ["f-console-shell", "f-design-system"] },
    { id: "if-console-model", title: "Console model page", description: "Console page Interface for modeling the plan.", exposes: ["i-model-plan"], depends_on: ["f-console-shell", "f-design-system"] },
    { id: "if-publish-script", title: "Publish script", description: "Script/CLI Interface for npm publish.", exposes: ["i-npm-publish"], depends_on: ["f-npm-registry"] },
    { id: "if-release-tag", title: "Release tag trigger", description: "CI/tag webhook Interface for tag-driven publish.", exposes: ["i-npm-tag-publish"], depends_on: ["f-github-actions"] },
  ],
  leads_to: [
    ["i-orient-plan", "i-steer-plan"],
    ["i-steer-plan", "i-export-map"],
    ["i-init-project", "i-orient-plan"],
  ],
};

function idMap() {
  const map = new Map();
  for (const [oldId, newId] of Object.entries(CLASSIFICATION.foundations)) map.set(oldId, newId);
  for (const [oldId, newId] of Object.entries(CLASSIFICATION.interactions)) map.set(oldId, newId);
  for (const [oldId, newId] of Object.entries(CLASSIFICATION.absorbed)) map.set(oldId, newId);
  for (const id of CLASSIFICATION.mechanical) map.set(id, id);
  return map;
}

function rewriteIdsInText(text, map) {
  let out = text;
  // Longer ids first to avoid partial replaces
  const entries = [...map.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [oldId, newId] of entries) {
    if (oldId === newId) continue;
    out = out.split(oldId).join(newId);
  }
  return out;
}

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  return { fence: m[0], inner: m[1], body: raw.slice(m[0].length) };
}

function setScalar(inner, key, value) {
  const re = new RegExp(`^${key}:.*$`, "m");
  if (re.test(inner)) return inner.replace(re, `${key}: ${value}`);
  return `${inner}\n${key}: ${value}`;
}

function removeEdgeField(inner, field) {
  const lines = inner.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^${field}:\\s*$`).test(lines[i]) || new RegExp(`^${field}:\\s*\\[`).test(lines[i])) {
      if (/:\s*\[/.test(lines[i])) continue;
      i++;
      while (i < lines.length && /^\s+-\s+/.test(lines[i])) i++;
      i--;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

function setEdgeField(inner, field, ids) {
  let cleaned = removeEdgeField(inner, field);
  if (!ids || ids.length === 0) return cleaned;
  cleaned = cleaned.replace(/\n+$/, "");
  const lines = [`${field}:`, ...ids.map((id) => `  - ${id}`)];
  return `${cleaned}\n${lines.join("\n")}`;
}

function getEdgeIds(inner, field) {
  const lines = inner.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^${field}:\\s*$`).test(lines[i])) {
      const ids = [];
      i++;
      while (i < lines.length && /^\s+-\s+/.test(lines[i])) {
        ids.push(lines[i].replace(/^\s+-\s+/, "").trim());
        i++;
      }
      return ids;
    }
  }
  return [];
}

function moveDir(from, to) {
  if (!fs.existsSync(from)) {
    console.warn(`skip missing ${from}`);
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.existsSync(to)) {
    console.warn(`target exists, merging ${from} -> ${to}`);
    // copy contents
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) {
        fs.cpSync(src, dst, { recursive: true });
      } else {
        fs.copyFileSync(src, dst);
      }
    }
    fs.rmSync(from, { recursive: true, force: true });
  } else {
    fs.renameSync(from, to);
  }
}

function rewriteMdxFile(filePath, opts) {
  if (!fs.existsSync(filePath)) return;
  let raw = fs.readFileSync(filePath, "utf-8");
  const parsed = parseFrontmatter(raw);
  if (!parsed) return;
  let { inner, body } = parsed;
  const map = opts.map;

  if (opts.newType) {
    inner = setScalar(inner, "type", opts.newType);
  }
  if (opts.newId) {
    inner = setScalar(inner, "id", opts.newId);
  }

  // Remap edge targets
  for (const field of ["belongs_to", "depends_on", "affects", "exposes", "leads_to"]) {
    const ids = getEdgeIds(inner, field).map((id) => map.get(id) ?? id);
    // Filter depends_on: Interactions may only depend on Foundations
    let filtered = ids;
    if (field === "depends_on" && opts.newType === "Interaction") {
      filtered = ids.filter((id) => id.startsWith("f-"));
    }
    if (field === "depends_on" && opts.newType === "Foundation") {
      filtered = ids.filter((id) => id.startsWith("f-"));
    }
    if (field === "belongs_to" && opts.newType === "Foundation") {
      filtered = []; // Foundations cannot belongs_to
    }
    // Drop depends_on to absorbed/interaction ids that aren't foundations
    if (field === "depends_on") {
      filtered = filtered.filter((id) => !id.startsWith("i-") && !id.startsWith("wf-") && !id.startsWith("if-"));
    }
    inner = setEdgeField(inner, field, filtered);
  }

  if (opts.addLeadsTo?.length) {
    const existing = getEdgeIds(inner, "leads_to");
    const merged = [...new Set([...existing, ...opts.addLeadsTo])];
    inner = setEdgeField(inner, "leads_to", merged);
  }

  body = rewriteIdsInText(body, map);
  // Soft vocabulary in body
  body = body.replace(/Workflow/g, "Interaction").replace(/workflow/g, "interaction");

  const out = `---\n${inner.trim()}\n---${body}`;
  fs.writeFileSync(filePath, out, "utf-8");
}

function scaffoldInterface(iface) {
  const dir = path.join(ROOT, "mindplan", "interfaces", iface.id);
  fs.mkdirSync(path.join(dir, "attachments"), { recursive: true });
  fs.writeFileSync(path.join(dir, "attachments", ".gitkeep"), "");
  const now = new Date().toISOString();
  const lines = [
    "---",
    `id: ${iface.id}`,
    "type: Interface",
    `title: ${JSON.stringify(iface.title)}`,
    `description: ${JSON.stringify(iface.description)}`,
    "state: ready",
    `created_at: ${now}`,
    `updated_at: ${now}`,
    "exposes:",
    ...iface.exposes.map((id) => `  - ${id}`),
  ];
  if (iface.depends_on?.length) {
    lines.push("depends_on:");
    for (const id of iface.depends_on) lines.push(`  - ${id}`);
  }
  lines.push("---", "", `# ${iface.title}`, "", iface.description, "");
  fs.writeFileSync(path.join(dir, "current.mdx"), lines.join("\n"), "utf-8");
  const pkg = path.join(ROOT, "src", "interfaces", iface.id);
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, ".gitkeep"), "");
}

function main() {
  const map = idMap();
  const wfRoot = path.join(ROOT, "mindplan", "workflows");
  const srcWf = path.join(ROOT, "src", "workflows");

  // 1. Become Foundations
  for (const [oldId, newId] of Object.entries(CLASSIFICATION.foundations)) {
    const from = path.join(wfRoot, oldId);
    const to = path.join(ROOT, "mindplan", "foundations", newId);
    moveDir(from, to);
    rewriteMdxFile(path.join(to, "current.mdx"), { map, newType: "Foundation", newId });
    if (fs.existsSync(path.join(to, "next.mdx"))) {
      rewriteMdxFile(path.join(to, "next.mdx"), { map, newType: "Foundation", newId });
    }
    const srcFrom = path.join(srcWf, oldId);
    const srcTo = path.join(ROOT, "src", "foundations", newId);
    if (fs.existsSync(srcFrom)) moveDir(srcFrom, srcTo);
  }

  // 2. Become Interactions
  for (const [oldId, newId] of Object.entries(CLASSIFICATION.interactions)) {
    const from = path.join(wfRoot, oldId);
    const to = path.join(ROOT, "mindplan", "interactions", newId);
    moveDir(from, to);
    const leads = CLASSIFICATION.leads_to.filter(([a]) => a === newId).map(([, b]) => b);
    rewriteMdxFile(path.join(to, "current.mdx"), {
      map,
      newType: "Interaction",
      newId,
      addLeadsTo: leads,
    });
    if (fs.existsSync(path.join(to, "next.mdx"))) {
      rewriteMdxFile(path.join(to, "next.mdx"), { map, newType: "Interaction", newId });
    }
    const srcFrom = path.join(srcWf, oldId);
    const srcTo = path.join(ROOT, "src", "interactions", newId);
    if (fs.existsSync(srcFrom)) moveDir(srcFrom, srcTo);
  }

  // 3. Mechanical rename (type only, keep id)
  for (const id of CLASSIFICATION.mechanical) {
    const from = path.join(wfRoot, id);
    const to = path.join(ROOT, "mindplan", "interactions", id);
    if (!fs.existsSync(from)) continue;
    moveDir(from, to);
    rewriteMdxFile(path.join(to, "current.mdx"), { map, newType: "Interaction", newId: id });
    const srcFrom = path.join(srcWf, id);
    const srcTo = path.join(ROOT, "src", "interactions", id);
    if (fs.existsSync(srcFrom)) moveDir(srcFrom, srcTo);
  }

  // 4. Absorbed — remove territory (content conceptually folded)
  for (const oldId of Object.keys(CLASSIFICATION.absorbed)) {
    const from = path.join(wfRoot, oldId);
    if (fs.existsSync(from)) fs.rmSync(from, { recursive: true, force: true });
    const srcFrom = path.join(srcWf, oldId);
    if (fs.existsSync(srcFrom)) {
      // Keep layout-free code if any under foundations later; for now remove empty scaffolds
      fs.rmSync(srcFrom, { recursive: true, force: true });
    }
  }

  // 5. Bug affects retargeting
  const bugsDir = path.join(ROOT, "mindplan", "bugs");
  if (fs.existsSync(bugsDir)) {
    for (const entry of fs.readdirSync(bugsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      rewriteMdxFile(path.join(bugsDir, entry.name, "current.mdx"), { map });
    }
  }

  // 6. Rewrite remaining foundations (edge refs)
  const foundDir = path.join(ROOT, "mindplan", "foundations");
  for (const entry of fs.readdirSync(foundDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    rewriteMdxFile(path.join(foundDir, entry.name, "current.mdx"), { map });
    const next = path.join(foundDir, entry.name, "next.mdx");
    if (fs.existsSync(next)) rewriteMdxFile(next, { map });
  }

  // 7. Journeys soft rewrite
  const journeysDir = path.join(ROOT, "mindplan", "journeys");
  for (const entry of fs.readdirSync(journeysDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    rewriteMdxFile(path.join(journeysDir, entry.name, "current.mdx"), { map });
  }

  // 8. New Interfaces
  for (const iface of CLASSIFICATION.interfaces) {
    scaffoldInterface(iface);
  }

  // 9. Fix imports in moved TS packages
  function walkFixImports(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walkFixImports(p);
      else if (/\.(ts|mjs|js)$/.test(entry.name)) {
        let text = fs.readFileSync(p, "utf-8");
        const next = rewriteIdsInText(text, map)
          .replace(/workflows\/wf-/g, "interactions/i-")
          .replace(/\/workflows\//g, "/interactions/")
          .replace(/src\/workflows\//g, "src/interactions/");
        // Fix known foundation moves
        next.includes("wf-test-harness") ;
        let fixed = next
          .replace(/src\/interactions\/f-test-harness/g, "src/foundations/f-test-harness")
          .replace(/src\/interactions\/f-framework-docs/g, "src/foundations/f-framework-docs")
          .replace(/src\/interactions\/f-console-shell/g, "src/foundations/f-console-shell")
          .replace(/workflows\/wf-project-init/g, "interactions/i-init-project")
          .replace(/workflows\/wf-integrity-check/g, "interactions/i-check-integrity")
          .replace(/workflows\/wf-query-graph/g, "interactions/i-orient-plan")
          .replace(/workflows\/wf-mutate-graph/g, "interactions/i-steer-plan")
          .replace(/workflows\/wf-export-views/g, "interactions/i-export-map")
          .replace(/workflows\/wf-test-harness/g, "foundations/f-test-harness");
        // Remap import paths for renamed interaction packages
        for (const [oldId, newId] of Object.entries(CLASSIFICATION.interactions)) {
          fixed = fixed.split(oldId).join(newId);
        }
        for (const [oldId, newId] of Object.entries(CLASSIFICATION.foundations)) {
          fixed = fixed.split(oldId).join(newId);
        }
        if (fixed !== text) fs.writeFileSync(p, fixed, "utf-8");
      }
    }
  }
  walkFixImports(path.join(ROOT, "src"));

  // 10. Cancel / remove migration workflow if still present
  const mig = path.join(wfRoot, "wf-interaction-model");
  if (fs.existsSync(mig)) {
    // Keep temporarily as cancelled Interaction? Classification says cancel after verify.
    // Move to interactions and mark cancelled for now so graph loads with no Workflow type.
    const to = path.join(ROOT, "mindplan", "interactions", "wf-interaction-model");
    moveDir(mig, to);
    rewriteMdxFile(path.join(to, "current.mdx"), {
      map,
      newType: "Interaction",
      newId: "wf-interaction-model",
    });
    // Force cancelled state
    let raw = fs.readFileSync(path.join(to, "current.mdx"), "utf-8");
    raw = raw.replace(/^state:.*$/m, "state: cancelled");
    // Strip belongs_to/depends_on optional — cancelled is fine with edges
    fs.writeFileSync(path.join(to, "current.mdx"), raw, "utf-8");
    const srcMig = path.join(srcWf, "wf-interaction-model");
    if (fs.existsSync(srcMig)) {
      moveDir(srcMig, path.join(ROOT, "src", "interactions", "wf-interaction-model"));
    }
  }

  // 11. Clean empty workflows dirs
  if (fs.existsSync(wfRoot) && fs.readdirSync(wfRoot).length === 0) {
    fs.rmSync(wfRoot, { recursive: true, force: true });
  }
  if (fs.existsSync(srcWf) && fs.readdirSync(srcWf).length === 0) {
    fs.rmSync(srcWf, { recursive: true, force: true });
  }

  console.log("Migration complete.");
}

main();
