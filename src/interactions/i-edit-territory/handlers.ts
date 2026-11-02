/**
 * Edit a node's territory — owned by i-edit-territory: patch_node_territory (body, section,
 * replace, checkboxes, title, description, role, change ids, aliases, declared splits),
 * patch_node_rules, and attachments.
 */

import { hotspotSettings } from "../../foundations/f-source-index/config.js";
import { nodeShipHistory, replayChurn, shipTimesOf } from "../../foundations/f-compiler-rules/ship-history.js";
import { splitLinkHint, splitPartLinked, splitPartProblem, splitPartType } from "../../foundations/f-compiler-rules/open-closed.js";
import {
  isFoundationRole,
  isInactiveNode,
  isShippedWithoutNext,
  isPipelineNodeType,
  type FoundationRole,
  type MindPlanGraph,
  type MindPlanNode,
} from "../../foundations/f-domain-model/types.js";
import {
  ATTACHMENTS_DIR,
  NEXT_ATTACHMENTS_DIR,
  attachmentsDir,
  entityRelativePath,
  loadGraph,
  nextAttachmentsDir,
  patchNodeTerritory as patchNodeTerritoryStore,
  writeNextSplitInto,
  readMarkdown,
  normalizeAliases,
  writeAliasesFrontmatter,
  splitContext,
  validateChangeInput,
  type CheckboxToggle,
  writeNodeRules,
  type TerritorySlot,
  loadProjectConfig,
  writeRevisionFields,
  nextFileExists,
  entityDir,
  projectRoot,
  hasNodeRulesHeading,
  hasNodeDecisionsHeading,
  normalizeHeadingName,
  replaceSectionInBody,
  replaceTextInBody,
  toggleCheckboxesInBody,
} from "../../foundations/f-territory-store/store.js";
import {
  readRevisions,
  revisionAttachmentsDir,
  revisionRelativeFilePath,
  writeRevisionBody,
  writeRevisionScalars,
  writeRevisionState,
} from "../../foundations/f-territory-store/revisions.js";
import { openChanges, resolveRevisionChange, revisionFor, withRevision } from "../../foundations/f-revision-model/index.js";
import { unlinkRetry, writeFileRetry } from "../../foundations/f-source-index/io.js";
import { assertPipelineTerritoryScalarsEditable, blocked, findNode, revisionGraph } from "../../foundations/f-compiler-rules/rules.js";
import { rulesImpact } from "../../foundations/f-graph-search/rules.js";
import { orientationGateEnabled, recordOriented } from "../../foundations/f-orientation-ledger/ledger.js";
import * as fs from "fs";
import * as path from "path";
import {
  READINESS_NOTE,
  changedFiles,
  gateWrite,
  mutationTail,
  readinessFields,
  readinessResult,
  refreshPersistedMap,
  territoryPath,
  shippedChangeBlocked,
  withChangeCleanup,
} from "../../foundations/f-plan-writes/writes.js";

/**
 * Accept empty payloads (empty files) and standard or unpadded base64.
 * Node's Buffer.from does not throw on invalid input, so charset/shape are checked here.
 */
function isBase64Payload(value: string): boolean {
  if (value.length === 0) return true;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(
    value
  );
}

function assertAttachmentBasename(filename: string, raw: string): void {
  if (
    !filename ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename === "." ||
    filename === ".." ||
    path.basename(filename) !== filename
  ) {
    throw blocked(`invalid attachment filename "${raw}".`);
  }
}

type PatchTerritoryArgs = {
  verbose?: boolean;
  node_id: string;
  title?: string;
  description?: string;
  role?: FoundationRole;
  body?: string;
  toggle_checkboxes?: CheckboxToggle[];
  section?: string;
  text?: string;
  replace?: { find: string; with: string; all?: boolean };
  change?: string;
  change_ref?: string;
  slot?: TerritorySlot;
  /** Replace the node's search aliases (slot-independent; never resets readiness). */
  aliases?: string[];
  /** Foundations this open revision splits out of the node (recorded when it ships). */
  split_into?: string[];
};

/**
 * Blocked unless `split_into` can be written: a node with an open revision, and each id a part of
 * the kind it splits into (`splitPartProblem`: a Foundation into Foundations, an Interaction or
 * Interface into Interactions).
 */
function validateSplitInto(graph: MindPlanGraph, node: MindPlanNode, ids: string[]): void {
  if (!splitPartType(node.type)) {
    throw blocked(`"${node.id}" is a ${node.type}; only a Foundation, Interaction, or Interface splits.`);
  }
  if (!node.next && ids.length === 0) {
    // Clearing a wrong split record on a shipped node.
    if (!node.split_into?.length && node.split_at === undefined) {
      throw blocked(`"${node.id}" has no split record to clear.`);
    }
    return;
  }
  if (!node.next) {
    throw blocked(`"${node.id}" has no open revision; split_into marks the revision that splits it. Call open_next first.`);
  }
  for (const id of ids) {
    const problem = splitPartProblem(graph, node, id);
    if (problem) throw blocked(problem);
  }
}

/**
 * Removes a wrong split record from a shipped node in place: `split_at` and `split_into` go, the
 * revision count stays, and the ship rate is replayed from the node file's git history without the
 * split's reset (kept as stored outside git). Returns the paths written and the new rate.
 */
function clearSplitRecord(node: MindPlanNode): { paths: string[]; churn: number | undefined } {
  const history = nodeShipHistory(node);
  const churn = history?.length
    ? replayChurn(shipTimesOf(node, history), new Set(), hotspotSettings(loadProjectConfig()).half_life_days)
    : node.churn;
  const changed = writeRevisionFields(node, {
    revisions: node.revisions ?? 1,
    ...(churn !== undefined ? { churn } : {}),
    split_into: [],
  });
  return { paths: changed ? [territoryPath(node, "current")] : [], churn };
}

export function patchNodeTerritory(args: PatchTerritoryArgs): Record<string, unknown> {
  gateWrite(null, [args.node_id], "patch_node_territory");
  const revision = targetRevision(findNode(loadGraph(), args.node_id), args.change, args.slot);
  if (revision !== null) return patchRevisionTerritory(args, revision);
  const { aliases, split_into, ...territory } = args;
  if (split_into !== undefined) {
    const graph = loadGraph();
    validateSplitInto(graph, findNode(graph, args.node_id), split_into);
  }
  if (aliases !== undefined) {
    // Validate the alias write in full before any territory write, so a Blocked writes nothing.
    normalizeAliases(args.node_id, aliases);
    const target = findNode(loadGraph(), args.node_id);
    if (isInactiveNode(target)) {
      throw blocked(`"${args.node_id}" is ${target.state}; aliases cannot be set on a retired or closed node.`);
    }
  }
  const territoryFields = Object.entries(territory).some(
    ([key, value]) =>
      value !== undefined &&
      !(Array.isArray(value) && value.length === 0) &&
      key !== "node_id" &&
      key !== "verbose" &&
      key !== "slot"
  );
  let result: Record<string, unknown> | null = null;
  if (territoryFields || (aliases === undefined && split_into === undefined)) {
    // A revision moved off (or cleared from) its change may leave that change with no revisions.
    result =
      territory.change === undefined
        ? writeNodeTerritory(territory)
        : withChangeCleanup(() => writeNodeTerritory(territory));
  }
  if (aliases === undefined && split_into === undefined) return result!;
  const fields: string[] = [];
  const paths: string[] = [];
  const extra: Record<string, unknown> = {};
  if (aliases !== undefined) {
    // Aliases are search words, not contract: written to live and an open next alike, on any node,
    // shipped ones included, without open_next or a readiness reset.
    const written = writeLiveAliases(findNode(loadGraph(), args.node_id), aliases);
    fields.push("aliases");
    paths.push(...written.paths);
    extra.aliases = written.aliases;
  }
  if (split_into !== undefined && split_into.length === 0 && !findNode(loadGraph(), args.node_id).next) {
    const written = clearSplitRecord(findNode(loadGraph(), args.node_id));
    fields.push("split_into");
    paths.push(...written.paths);
    extra.split_into = [];
    extra.churn = written.churn;
  } else if (split_into !== undefined) {
    // A record of the revision's shape, like a change id: it never resets readiness.
    const graph = loadGraph();
    const target = findNode(graph, args.node_id);
    const written = writeNextSplitInto(target, split_into);
    fields.push("split_into");
    paths.push(...written.paths);
    extra.split_into = written.split_into;
    const unlinked = split_into.filter((id) => !splitPartLinked(graph, target, id));
    if (unlinked.length > 0) {
      extra.warnings = [
        `split_into: "${args.node_id}" does not yet ${splitLinkHint(target)} for ` +
          `${unlinked.map((id) => `"${id}"`).join(", ")}; only linked parts are recorded as split out when the revision ships.`,
      ];
    }
  }
  if (paths.length > 0) refreshPersistedMap();
  if (result) {
    return {
      ...result,
      // The anchor reflects the node after every write.
      ...mutationTail(loadGraph(), args.node_id, args.verbose),
      patched_fields: [...((result.patched_fields as string[] | undefined) ?? []), ...fields],
      ...extra,
      changed_files: changedFiles([...((result.changed_files as string[]) ?? []), ...paths]),
    };
  }
  return {
    node_id: args.node_id,
    patched_fields: fields,
    ...extra,
    changed_files: changedFiles(paths),
    ...mutationTail(loadGraph(), args.node_id, args.verbose),
  };
}

/**
 * The open revision a write on `node` targets, or null for the live / legacy next slots: null when
 * the node has no open revision or `slot` is "current". `change` names the revision (Blocked when
 * the node has none of it: a revision's change is its folder name, so it is never patched); omitted,
 * the node's only open revision (several open: Blocked, naming them).
 */
function targetRevision(node: MindPlanNode, change: string | undefined, slot: TerritorySlot | undefined): string | null {
  if (!node.open_revisions?.length || slot === "current") return null;
  if (change !== undefined && !revisionFor(node, change)) {
    const open = openChanges(node).map((c) => `"${c}"`).join(", ");
    throw blocked(
      `"${node.id}" has no open revision of change "${change}"; open revisions: ${open}. ` +
        "A revision's change is its folder name: it cannot be patched (discard the revision and open_next under the other change)."
    );
  }
  return resolveRevisionChange(node, change);
}

/**
 * Writes aliases to live only when the node's open work is held in revision folders (aliases are
 * slot-independent search words); a legacy next file still takes them alongside live.
 */
function writeLiveAliases(node: MindPlanNode, aliases: string[]): ReturnType<typeof writeAliasesFrontmatter> {
  if (node.open_revisions?.length && !nextFileExists(node)) {
    const live: MindPlanNode = { ...node };
    delete live.next;
    const written = writeAliasesFrontmatter(live, aliases);
    if (live.aliases) node.aliases = live.aliases;
    else delete node.aliases;
    return written;
  }
  return writeAliasesFrontmatter(node, aliases);
}

function assertNoOwnedHeading(text: string, what: string): void {
  if (hasNodeRulesHeading(text)) {
    throw blocked(`${what} contains a "## Rules" heading. Node rules are written only by patch_node_rules; remove the section.`);
  }
  if (hasNodeDecisionsHeading(text)) {
    throw blocked(`${what} contains a "## Decisions" heading. Decisions are written only by record_decision; remove the section.`);
  }
}

/**
 * patch_node_territory on an open revision of a shipped node: body, section, replace, and
 * checkboxes edit the revision file's body; title, description, role, change_ref, and split_into
 * its scalars; aliases go to live. Every check runs before the first write. A contract write
 * (anything but change_ref, split_into, and aliases) to a ready revision sends it back to draft.
 */
function patchRevisionTerritory(args: PatchTerritoryArgs, change: string): Record<string, unknown> {
  const graph = loadGraph();
  const node = findNode(graph, args.node_id);
  const { title, description, role, body, toggle_checkboxes, aliases, split_into } = args;
  if ((args.section === undefined) !== (args.text === undefined)) {
    throw blocked('patch_node_territory section needs both section ("## Heading") and text.');
  }
  if (body !== undefined && (args.section !== undefined || args.replace !== undefined)) {
    throw blocked("patch_node_territory body replaces the whole body; do not combine it with section or replace.");
  }
  if (args.change_ref !== undefined) validateChangeInput({ change_ref: args.change_ref });
  if (aliases !== undefined) normalizeAliases(node.id, aliases);
  if (role !== undefined) {
    if (node.type !== "Foundation") throw blocked(`role only applies to Foundations; "${node.id}" is a ${node.type}.`);
    if (!isFoundationRole(role)) throw blocked(`invalid Foundation role "${role}".`);
  }
  const view = withRevision(node, change);
  if (split_into !== undefined) validateSplitInto(graph, view, split_into);
  const file = readRevisions(entityDir(node), node.id).find((r) => r.revision.change === change);
  if (!file) throw blocked(`revision file of "${node.id}" for change "${change}" is missing.`);

  const patched: string[] = [];
  let text = file.body;
  let toggled: string[] | undefined;
  if (body !== undefined) {
    assertNoOwnedHeading(body, "body");
    text = body.replace(/\r\n/g, "\n");
    patched.push("body");
  }
  if (args.section !== undefined) {
    const name = normalizeHeadingName(args.section).toLowerCase();
    if (name === "rules") throw blocked('"## Rules" is written only by patch_node_rules; it cannot be patched as a section.');
    if (name === "decisions") throw blocked('"## Decisions" is written only by record_decision; it cannot be patched as a section.');
    assertNoOwnedHeading(args.text!, "section text");
    text = replaceSectionInBody(text, args.section, args.text!);
    patched.push("section");
  }
  if (args.replace !== undefined) {
    assertNoOwnedHeading(args.replace.with, "replace.with");
    text = replaceTextInBody(text, args.replace.find, args.replace.with, args.replace.all);
    patched.push("replace");
  }
  if (toggle_checkboxes?.length) {
    const result = toggleCheckboxesInBody(text, toggle_checkboxes);
    text = result.body;
    toggled = result.toggled;
    patched.push("toggle_checkboxes");
  }
  const bodyWrite = patched.length > 0;
  const scalars: Parameters<typeof writeRevisionScalars>[2] = {};
  if (title !== undefined) {
    scalars.title = title;
    patched.push("title");
  }
  if (description !== undefined) {
    scalars.description = description;
    patched.push("description");
  }
  if (role !== undefined) {
    scalars.role = role;
    patched.push("role");
  }
  if (args.change_ref !== undefined) {
    scalars.change_ref = args.change_ref;
    patched.push("change_ref");
  }
  let splitList: string[] | undefined;
  if (split_into !== undefined) {
    splitList = [...new Set([...(node.split_into ?? []), ...split_into.map((id) => id.trim()).filter(Boolean)])];
    scalars.split_into = splitList;
    patched.push("split_into");
  }
  if (patched.length === 0 && aliases === undefined) {
    throw blocked(
      "patch_node_territory requires at least one of title, description, role, body, section, replace, toggle_checkboxes, change_ref, split_into, or aliases."
    );
  }

  const paths: string[] = [];
  if (bodyWrite) paths.push(...writeRevisionBody(node, change, text).changed_files);
  if (Object.keys(scalars).length > 0) paths.push(...writeRevisionScalars(node, change, scalars).changed_files);
  // A change ref and a split record describe the revision's shape, not its contract.
  const contractWrite = patched.some((f) => f !== "change_ref" && f !== "split_into");
  let reset: Record<string, unknown> | null = null;
  if (contractWrite && revisionFor(node, change)?.state === "ready") {
    paths.push(...writeRevisionState(node, change, "draft").changed_files);
    reset = { slot: "next", change, from: "ready", to: "draft", note: READINESS_NOTE };
  }
  const extra: Record<string, unknown> = {};
  if (aliases !== undefined) {
    const written = writeLiveAliases(node, aliases);
    patched.push("aliases");
    paths.push(...written.paths);
    extra.aliases = written.aliases;
  }
  if (splitList) {
    extra.split_into = splitList;
    const under = revisionGraph(loadGraph(), change);
    const revised = findNode(under, node.id);
    const unlinked = split_into!.filter((id) => !splitPartLinked(under, revised, id));
    if (unlinked.length > 0) {
      extra.warnings = [
        `split_into: "${node.id}" does not yet ${splitLinkHint(revised)} for ` +
          `${unlinked.map((id) => `"${id}"`).join(", ")}; only linked parts are recorded as split out when the revision ships.`,
      ];
    }
  }
  refreshPersistedMap();
  return {
    node_id: node.id,
    patched_fields: patched,
    slot: "next",
    change,
    path: revisionRelativeFilePath(node, change),
    ...(toggled ? { toggled } : {}),
    ...extra,
    ...(reset ? { readiness_reset: reset } : {}),
    changed_files: changedFiles(paths, true),
    ...mutationTail(loadGraph(), node.id, args.verbose),
  };
}

/** Repo-relative POSIX path of an absolute path under the project root. */
function repoRelative(abs: string): string {
  return path.relative(projectRoot(), abs).split(path.sep).join("/");
}

/**
 * Where an attachment call writes: the open revision's `attachments/` when it targets one (see
 * `targetRevision`), else the live `attachments/` or the legacy `next-attachments/`.
 */
function attachmentTarget(
  node: MindPlanNode,
  args: { change?: string; slot?: TerritorySlot },
  verb: "put" | "remove"
): { slot: TerritorySlot; dir: string; relDir: string; change?: string } {
  const change = targetRevision(node, args.change, args.slot);
  if (change !== null) {
    const dir = revisionAttachmentsDir(node, change);
    return { slot: "next", dir, relDir: repoRelative(dir), change };
  }
  if (args.change !== undefined) {
    throw blocked(`"${node.id}" has no open revision of change "${args.change}"; it has no open revision.`);
  }
  const slot: TerritorySlot = args.slot ?? (node.next && isPipelineNodeType(node.type) ? "next" : "current");
  if (slot === "next" && !node.next) {
    throw blocked(
      verb === "put"
        ? `cannot put attachment on next for "${node.id}" — no open evolution. Call open_next first.`
        : `cannot remove attachment on next for "${node.id}" — no open evolution.`
    );
  }
  return slot === "next"
    ? { slot, dir: nextAttachmentsDir(node), relDir: `${entityRelativePath(node)}/${NEXT_ATTACHMENTS_DIR}` }
    : { slot, dir: attachmentsDir(node), relDir: `${entityRelativePath(node)}/${ATTACHMENTS_DIR}` };
}

function writeNodeTerritory(args: PatchTerritoryArgs): Record<string, unknown> {
  const { node_id, title, description, role, body, toggle_checkboxes, slot } = args;
  validateChangeInput(args);
  if ((args.section === undefined) !== (args.text === undefined)) {
    throw blocked('patch_node_territory section needs both section ("## Heading") and text.');
  }
  if (body !== undefined && (args.section !== undefined || args.replace !== undefined)) {
    throw blocked("patch_node_territory body replaces the whole body; do not combine it with section or replace.");
  }
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  const resolvedSlot: TerritorySlot =
    slot ??
    (node.next &&
    isPipelineNodeType(node.type) &&
    (node.state === "stable" || node.state === "unstable")
      ? "next"
      : "current");
  if (title !== undefined) {
    assertPipelineTerritoryScalarsEditable(node, "title", resolvedSlot);
  }
  if (description !== undefined) {
    assertPipelineTerritoryScalarsEditable(node, "description", resolvedSlot);
  }
  if (role !== undefined) {
    if (!isFoundationRole(role)) {
      throw blocked(`invalid Foundation role "${role}".`);
    }
    assertPipelineTerritoryScalarsEditable(node, "role", resolvedSlot);
  }
  const changeWrite = args.change !== undefined || args.change_ref !== undefined;
  if (changeWrite) {
    if (!isPipelineNodeType(node.type)) {
      throw blocked(`change applies to Foundations, Interactions, and Interfaces; "${node_id}" is a ${node.type}.`);
    }
    // Only a revision carries a change id; a shipped node with no open next is edited in place.
    if (isShippedWithoutNext(node)) throw shippedChangeBlocked(node);
    if (resolvedSlot === "current" && node.shipped_at) {
      throw blocked(
        `"${node_id}" is shipped; a change id belongs to an open revision. Call open_next (it takes change) or patch the next slot.`
      );
    }
  }
  if (
    body !== undefined ||
    args.section !== undefined ||
    args.replace !== undefined ||
    (toggle_checkboxes?.length ?? 0) > 0
  ) {
    const raw = readMarkdown(node, resolvedSlot);
    if (!splitContext(raw)) {
      throw blocked(`${resolvedSlot} file for "${node_id}" has no YAML frontmatter.`);
    }
  }
  const result = patchNodeTerritoryStore(node, {
    title,
    description,
    role,
    body,
    toggle_checkboxes,
    section: args.section !== undefined ? { heading: args.section, text: args.text! } : undefined,
    replace: args.replace,
    change: args.change,
    change_ref: args.change_ref,
    slot: resolvedSlot,
  });
  const pathWritten = territoryPath(node, result.slot);
  const { readinessReset, ...written } = result;
  const readiness = readinessResult(node, result.slot, readinessReset);
  return {
    node_id,
    ...written,
    path: pathWritten,
    ...readinessFields(readiness.reset),
    changed_files: changedFiles(
      [pathWritten, ...readiness.files],
      readiness.reset !== null
    ),
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}

/**
 * Replace one node's `## Rules` section. Valid in any non-retired state; never changes state,
 * edges, or checkboxes and never needs open_next. Reports whose work the rules reach.
 */
export function patchNodeRules(args: {
  node_id: string;
  rules: string;
}): Record<string, unknown> {
  gateWrite(null, [args.node_id], "patch_node_rules");
  const { node_id, rules } = args;
  if (rules === undefined) {
    throw blocked("patch_node_rules requires rules.");
  }
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  const written = writeNodeRules(node, rules);
  // The author holds the rules it just wrote; its orientation stays current. Nodes that inherit
  // them now need a fresh orientation before their next write.
  if (orientationGateEnabled()) recordOriented(loadGraph(), [node_id]);
  return {
    node_id,
    rules: node.rules ?? "",
    slots: written.slots,
    rules_impact: rulesImpact(graph, node),
    changed_files: changedFiles(written.paths),
  };
}

export function putAttachment(args: {
  verbose?: boolean;
  node_id: string;
  filename: string;
  content_base64: string;
  slot?: TerritorySlot;
  change?: string;
}): Record<string, unknown> {
  const { node_id } = args;
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  gateWrite(graph, [node_id], "put_attachment");
  const filename = args.filename.trim();
  assertAttachmentBasename(filename, args.filename);
  const target = attachmentTarget(node, args, "put");
  if (!isBase64Payload(args.content_base64)) {
    throw blocked("content_base64 is not valid base64.");
  }
  const bytes = Buffer.from(args.content_base64, "base64");
  const dir = target.dir;
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, filename);
  if (path.resolve(abs) !== path.resolve(dir, filename)) {
    throw blocked(`invalid attachment filename "${args.filename}".`);
  }
  writeFileRetry(abs, bytes);
  const rel = `${target.relDir}/${filename}`;
  return {
    node_id,
    slot: target.slot,
    ...(target.change ? { change: target.change } : {}),
    path: rel,
    bytes: bytes.length,
    changed_files: changedFiles([rel]),
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}

export function removeAttachment(args: {
  verbose?: boolean;
  node_id: string;
  filename: string;
  slot?: TerritorySlot;
  change?: string;
}): Record<string, unknown> {
  const { node_id } = args;
  const graph = loadGraph();
  const node = findNode(graph, node_id);
  gateWrite(graph, [node_id], "remove_attachment");
  const filename = args.filename.trim();
  assertAttachmentBasename(filename, args.filename);
  const target = attachmentTarget(node, args, "remove");
  const dir = target.dir;
  const abs = path.join(dir, filename);
  if (path.resolve(abs) !== path.resolve(dir, filename)) {
    throw blocked(`invalid attachment filename "${args.filename}".`);
  }
  if (!fs.existsSync(abs)) {
    throw blocked(
      `attachment "${filename}" not found on ${target.change ? `revision "${target.change}"` : target.slot} for "${node_id}".`
    );
  }
  unlinkRetry(abs);
  const rel = `${target.relDir}/${filename}`;
  return {
    node_id,
    slot: target.slot,
    ...(target.change ? { change: target.change } : {}),
    path: rel,
    removed: true,
    changed_files: changedFiles([rel]),
    ...mutationTail(loadGraph(), node_id, args.verbose),
  };
}
