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
  isProductionState,
  isShippedWithoutNext,
  isPipelineNodeType,
  type FoundationRole,
  type MindPlanGraph,
  type MindPlanNode,
} from "../../foundations/f-domain-model/types.js";
import {
  ATTACHMENTS_DIR,
  attachmentsDir,
  entityRelativePath,
  loadGraph,
  patchNodeTerritory as patchNodeTerritoryStore,
  writeNextSplitInto,
  normalizeAliases,
  writeAliasesFrontmatter,
  validateChangeInput,
  type CheckboxToggle,
  writeNodeRules,
  type TerritorySlot,
  loadProjectConfig,
  writeRevisionFields,
  hasNodeRulesHeading,
  hasNodeDecisionsHeading,
  normalizeHeadingName,
  replaceSectionInBody,
  replaceEachInBody,
  type ReplaceSpec,
  toggleCheckboxesInBody,
} from "../../foundations/f-territory-store/store.js";
import { appendChecklistItems, type NewChecklistItem } from "../../foundations/f-territory-store/checklist.js";
import {
  loadRevision,
  revisionAttachmentsDir,
  revisionRelativeFilePath,
  writeRevision,
  type RevisionScalarsPatch,
} from "../../foundations/f-territory-store/revisions.js";
import { openChanges, resolveRevisionChange, revisionFor, withRevision } from "../../foundations/f-revision-model/index.js";
import { unlinkRetry, writeFileRetry } from "../../foundations/f-source-index/io.js";
import { repoRelative } from "../../foundations/f-source-index/root-scope.js";
import {
  assertNoUntickUnderShippedDependents,
  assertPipelineTerritoryScalarsEditable,
  blocked,
  findNode,
  revisionGraph,
} from "../../foundations/f-compiler-rules/rules.js";
import { rulesImpact } from "../../foundations/f-graph-search/rules.js";
import { ruleCheckProblems } from "../../foundations/f-graph-search/rule-checks.js";
import { orientationGateEnabled, recordOriented } from "../../foundations/f-orientation-ledger/ledger.js";
import * as fs from "fs";
import * as path from "path";
import {
  changedFiles,
  gateWrite,
  gateWriteOrOrient,
  mutationTail,
  readinessFields,
  readinessResult,
  recordRulesWritten,
  refreshPersistedMap,
  revisionReadinessReset,
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
  /** Items appended unticked to the picked slot's Atomic Ops. */
  add_checklist_items?: NewChecklistItem[];
  section?: string;
  text?: string;
  replace?: ReplaceSpec | ReplaceSpec[];
  change?: string;
  change_ref?: string;
  slot?: TerritorySlot;
  /** Replace the node's search aliases (slot-independent; never resets readiness). */
  aliases?: string[];
  /** Foundations this open revision splits out of the node (recorded when it ships). */
  split_into?: string[];
  /** "text": a wording-only edit; on a shipped node it is written to live in place. */
  reason?: string;
};

/** The one reason patch_node_territory takes: a wording-only edit. */
export const TEXT_REASON = "text";

/** The fields a wording-only edit of a shipped node may carry. */
const TEXT_FIELDS = new Set(["node_id", "verbose", "slot", "title", "description", "body", "section", "text", "replace"]);

/** A body's `## ` headings and checklist items, in order: what a wording-only edit must leave as it was. */
function bodyStructure(body: string): { headings: string[]; items: string[] } {
  const headings: string[] = [];
  const items: string[] = [];
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    if (/^##\s/.test(line)) headings.push(line.trim());
    else if (/^\s*[-*+]\s+\[[ xX]\]/.test(line)) items.push(line.trim());
  }
  return { headings, items };
}

/** Blocked unless a wording-only edit left the body's sections and checklist items as they were. */
function assertWordingOnly(node: MindPlanNode, before: string, after: string): void {
  const was = bodyStructure(before);
  const is = bodyStructure(after);
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  const changed = [
    ...(same(was.headings, is.headings) ? [] : ["its ## sections"]),
    ...(same(was.items, is.items) ? [] : ["its checklist items"]),
  ];
  if (changed.length > 0) {
    throw blocked(
      `reason "text" writes wording only, and this edit changes ${changed.join(" and ")} on "${node.id}". ` +
        `Nothing was written. A contract change needs open_next({ node_id: "${node.id}", change, reason }).`
    );
  }
}

/**
 * patch_node_territory({ reason: "text" }) on a shipped node: a wording-only edit written to live
 * in place, whatever revisions are open (each is rebased onto the new live when it ships). It
 * takes title, description, body, section, and replace, and must leave the body's sections and
 * checklist items as they were. No revision opens, so no decision gate applies and the hotspot
 * rate does not move; the live file's `updated_at` and its git diff are the record.
 */
function patchShippedText(graph: MindPlanGraph, args: PatchTerritoryArgs): Record<string, unknown> {
  const extra = Object.entries(args)
    .filter(([key, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0) && !TEXT_FIELDS.has(key))
    .map(([key]) => key);
  if (extra.length > 0 || args.slot === "next") {
    const named = [...extra, ...(args.slot === "next" ? ['slot "next"'] : [])].join(", ");
    throw blocked(
      `reason "text" on shipped "${args.node_id}" writes wording to live in place: it takes title, description, ` +
        `body, section, and replace only. Drop ${named}, or drop reason to patch the open revision.`
    );
  }
  const result = writeNodeTerritory(graph, { ...args, slot: "current" }, true);
  if (args.title !== undefined) refreshPersistedMap();
  return { ...result, reason: TEXT_REASON, in_place: true };
}

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
 * The declared parts the split_into warning names: those live does not already record (the ship
 * records only new ones) whose linking edge is not yet in place.
 */
function unlinkedSplitParts(graph: MindPlanGraph, node: MindPlanNode, parts: string[]): string[] {
  const live = new Set(node.split_into ?? []);
  return parts.filter((id) => !live.has(id) && !splitPartLinked(graph, node, id));
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
  // One load for every check before the first write; replies after a write reload.
  const graph = loadGraph();
  // A node not yet oriented on is oriented by this write (its rules ride on the reply).
  const finish = gateWriteOrOrient(graph, [args.node_id], "patch_node_territory");
  const { reason, ...patch } = args;
  if (reason !== undefined && reason !== TEXT_REASON) {
    throw blocked(`patch_node_territory reason must be "${TEXT_REASON}" (a wording-only edit); any other edit takes no reason.`);
  }
  const subject = findNode(graph, args.node_id);
  // A wording-only edit of a shipped node goes to live in place; before first ship the node's own
  // file is the draft, so the reason changes nothing there.
  const inPlace = reason === TEXT_REASON && isPipelineNodeType(subject.type) && isProductionState(subject.state);
  return finish(inPlace ? patchShippedText(graph, patch) : patchTerritoryOn(graph, patch));
}

function patchTerritoryOn(graph: MindPlanGraph, args: PatchTerritoryArgs): Record<string, unknown> {
  const subject = findNode(graph, args.node_id);
  const revision = targetRevision(subject, args.change, args.slot);
  if (revision !== null) return patchRevisionTerritory(graph, args, revision);
  if (args.slot === "next" && isPipelineNodeType(subject.type) && subject.shipped_at) {
    // Slot "next" can only mean an open revision.
    throw blocked(
      `"${subject.id}" has no open revision; slot "next" writes to one. ` +
        `Open it with open_next({ node_id: "${subject.id}", change }), or patch the live slot (slot "current").`
    );
  }
  const { aliases, split_into, ...territory } = args;
  if (split_into !== undefined) validateSplitInto(graph, subject, split_into);
  if (aliases !== undefined) {
    // Validate the alias write in full before any territory write, so a Blocked writes nothing.
    normalizeAliases(args.node_id, aliases);
    if (isInactiveNode(subject)) {
      throw blocked(`"${args.node_id}" is ${subject.state}; aliases cannot be set on a retired or closed node.`);
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
        ? writeNodeTerritory(graph, territory)
        : withChangeCleanup(() => writeNodeTerritory(graph, territory));
  }
  if (aliases === undefined && split_into === undefined) return result!;
  const fields: string[] = [];
  const paths: string[] = [];
  const extra: Record<string, unknown> = {};
  if (aliases !== undefined) {
    // Aliases are search words, not contract: written to live and an open next alike, on any node,
    // shipped ones included, without open_next or a readiness reset.
    const written = writeAliasesFrontmatter(findNode(loadGraph(), args.node_id), aliases);
    fields.push("aliases");
    paths.push(...written.paths);
    extra.aliases = written.aliases;
  }
  // The split record goes on the node as the writes above left it.
  const fresh = split_into === undefined ? null : loadGraph();
  const target = fresh && findNode(fresh, args.node_id);
  if (split_into !== undefined && split_into.length === 0 && !target!.next) {
    const written = clearSplitRecord(target!);
    fields.push("split_into");
    paths.push(...written.paths);
    extra.split_into = [];
    extra.churn = written.churn;
  } else if (split_into !== undefined) {
    // A record of the revision's shape, like a change id: it never resets readiness.
    const written = writeNextSplitInto(target!, split_into);
    fields.push("split_into");
    paths.push(...written.paths);
    extra.split_into = written.split_into;
    const unlinked = unlinkedSplitParts(fresh!, target!, written.split_into);
    if (unlinked.length > 0) {
      extra.warnings = [
        `split_into: "${args.node_id}" does not yet ${splitLinkHint(target!)} for ` +
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
 * The open revision a write on `node` targets, or null for the live slot: null when
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
 * (anything but change_ref, split_into, aliases, and checkbox toggles) to a ready revision sends it
 * back to draft.
 */
function patchRevisionTerritory(graph: MindPlanGraph, args: PatchTerritoryArgs, change: string): Record<string, unknown> {
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
  const file = loadRevision(node, change);

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
    text = replaceEachInBody(text, args.replace, assertNoOwnedHeading);
    patched.push("replace");
  }
  if (args.add_checklist_items?.length) {
    text = appendChecklistItems(text, args.add_checklist_items).body;
    patched.push("add_checklist_items");
  }
  if (toggle_checkboxes?.length) {
    const result = toggleCheckboxesInBody(text, toggle_checkboxes);
    text = result.body;
    toggled = result.toggled;
    patched.push("toggle_checkboxes");
  }
  const bodyWrite = patched.length > 0;
  // Judged on the body every edit of the call leaves, whichever edit took a tick back.
  if (bodyWrite) assertNoUntickUnderShippedDependents(graph, node, revisionFor(node, change)?.state, file.body, text);
  const scalars: RevisionScalarsPatch = {};
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
    // The parts this revision declares, replacing what it declared before (live's record is not
    // copied in; the ship adds these to it). `[]` clears them.
    splitList = [...new Set(split_into.map((id) => id.trim()).filter(Boolean))];
    scalars.split_into = splitList;
    patched.push("split_into");
  }
  if (patched.length === 0 && aliases === undefined) {
    throw blocked(
      "patch_node_territory requires at least one of title, description, role, body, section, replace, add_checklist_items, toggle_checkboxes, change_ref, split_into, or aliases."
    );
  }

  const paths: string[] = [];
  // A change ref and a split record describe the revision's shape, not its contract, and a tick
  // on an existing item is evidence of work done.
  const contractWrite = patched.some((f) => f !== "change_ref" && f !== "split_into" && f !== "toggle_checkboxes");
  const reset = contractWrite && revisionFor(node, change)?.state === "ready" ? revisionReadinessReset(change) : null;
  const scalarWrite = Object.keys(scalars).length > 0;
  if (bodyWrite || scalarWrite || reset) {
    // Body, scalars, and the readiness reset land in one write of the revision file.
    const written = writeRevision(node, change, {
      ...(bodyWrite ? { body: text } : {}),
      ...(scalarWrite ? { scalars } : {}),
      ...(reset ? { state: "draft" as const } : {}),
    });
    paths.push(...written.changed_files);
  }
  const extra: Record<string, unknown> = {};
  if (aliases !== undefined) {
    const written = writeAliasesFrontmatter(node, aliases);
    patched.push("aliases");
    paths.push(...written.paths);
    extra.aliases = written.aliases;
  }
  if (splitList) {
    extra.split_into = splitList;
    const under = revisionGraph(loadGraph(), change);
    const revised = findNode(under, node.id);
    const unlinked = unlinkedSplitParts(under, revised, splitList);
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

/**
 * Where an attachment call writes: the open revision's `attachments/` when it targets one (see
 * `targetRevision`), else the live `attachments/`.
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
  if (args.slot === "next") {
    throw blocked(
      verb === "put"
        ? `cannot put attachment on next for "${node.id}" — no open revision. Call open_next first.`
        : `cannot remove attachment on next for "${node.id}" — no open revision.`
    );
  }
  return { slot: "current", dir: attachmentsDir(node), relDir: `${entityRelativePath(node)}/${ATTACHMENTS_DIR}` };
}

function writeNodeTerritory(graph: MindPlanGraph, args: PatchTerritoryArgs, wordingOnly = false): Record<string, unknown> {
  const { node_id, title, description, role, body, toggle_checkboxes, slot } = args;
  validateChangeInput(args);
  if ((args.section === undefined) !== (args.text === undefined)) {
    throw blocked('patch_node_territory section needs both section ("## Heading") and text.');
  }
  if (body !== undefined && (args.section !== undefined || args.replace !== undefined)) {
    throw blocked("patch_node_territory body replaces the whole body; do not combine it with section or replace.");
  }
  const node = findNode(graph, node_id);
  const resolvedSlot: TerritorySlot =
    slot ??
    (node.next &&
    isPipelineNodeType(node.type) &&
    (node.state === "stable" || node.state === "unstable")
      ? "next"
      : "current");
  // A wording-only edit may reword a shipped node's title and description in place.
  if (title !== undefined && !wordingOnly) {
    assertPipelineTerritoryScalarsEditable(node, "title", resolvedSlot);
  }
  if (description !== undefined && !wordingOnly) {
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
  const slotState = resolvedSlot === "next" ? node.next?.state : node.state;
  const result = patchNodeTerritoryStore(node, {
    // The store hands over the body every edit of the call leaves, before it writes anything.
    checkBody: (before, after) => {
      if (wordingOnly) assertWordingOnly(node, before, after);
      assertNoUntickUnderShippedDependents(graph, node, slotState, before, after);
    },
    title,
    description,
    role,
    body,
    toggle_checkboxes,
    add_checklist_items: args.add_checklist_items,
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
  const graph = loadGraph();
  gateWrite(graph, [args.node_id], "patch_node_rules");
  const { node_id, rules } = args;
  if (rules === undefined) {
    throw blocked("patch_node_rules requires rules.");
  }
  const problems = ruleCheckProblems(rules);
  if (problems.length > 0) {
    throw blocked(`patch_node_rules "${node_id}": invalid check: line(s), nothing written. ${problems.join("; ")}.`);
  }
  const node = findNode(graph, node_id);
  const written = writeNodeRules(node, rules);
  // The author holds the rules it just wrote; its orientation stays current. Nodes that inherit
  // them now need a fresh orientation before their next write.
  if (orientationGateEnabled()) {
    const after = loadGraph();
    recordOriented(after, [node_id]);
    // The text as the graph reads it back, so its tag matches what reaches the dependents.
    recordRulesWritten(node_id, after.nodes.find((n) => n.id === node_id)?.rules ?? "");
  }
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
