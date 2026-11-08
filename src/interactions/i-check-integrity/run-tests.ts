/**
 * Linked-test runs — owned by i-check-integrity: `run_check({ run_tests: true })` runs the linked
 * tests of the nodes in scope (a change's members, or `nodes`) with config `tests.command`, and
 * records the result for each node, so a node whose tests passed has its default `verify` item
 * closed by the server (f-compiler-rules auto-items). A failing run is a check failure.
 */

import { spawnSync } from "child_process";
import { isPipelineNodeType, type MindPlanNode } from "../../foundations/f-domain-model/types.js";
import { loadGraph, projectRoot } from "../../foundations/f-territory-store/store.js";
import { loadProjectConfig } from "../../foundations/f-source-index/config.js";
import { expandClaims } from "../../foundations/f-source-index/claims.js";
import { blocked, findNode, revisionGraph } from "../../foundations/f-compiler-rules/rules.js";
import { changeMembership } from "../../foundations/f-compiler-rules/planned.js";
import { recordTestRun } from "../../foundations/f-compiler-rules/auto-items.js";

/** How long one test command may run. */
const TEST_TIMEOUT_MS = 10 * 60 * 1000;

/** Output lines a reply keeps from the end of the run. */
const TAIL_LINES = 30;

export type TestRun = {
  command: string;
  nodes: string[];
  files: string[];
  exit_code: number | null;
  passed: boolean;
  /** Nodes in scope that link no test (their verify item stays manual). */
  without_tests?: string[];
  output_tail?: string[];
};

/** A node's linked test claims: live plus every open revision's added ones. */
function linkedTests(node: MindPlanNode): string[] {
  return [...(node.tests ?? []), ...(node.open_revisions ?? []).flatMap((r) => r.tests?.add ?? [])];
}

const quote = (p: string) => (/^[\w./@-]+$/.test(p) ? p : `"${p.replace(/"/g, '\\"')}"`);

/**
 * Run the linked tests of `change`'s members or of `nodes`. Blocked without a scope, without
 * `tests.command` in config.json, or when no node in scope links a test.
 */
export function runLinkedTests(args: { change?: string; nodes?: string[] }): TestRun {
  const root = projectRoot();
  const command = loadProjectConfig(root).tests?.command;
  if (!command) {
    throw blocked(
      'run_tests needs config.json tests.command, a command with {files}: patch_config({ tests: { command: "npm run test:files -- {files}" } }).'
    );
  }
  let graph = loadGraph();
  let scope: MindPlanNode[];
  if (args.nodes?.length) scope = args.nodes.map((id) => findNode(graph, id));
  else if (args.change !== undefined) {
    graph = revisionGraph(graph, args.change);
    const { revisions, planned } = changeMembership(graph, args.change);
    scope = [...revisions, ...planned];
  } else throw blocked("run_tests needs change or nodes: the nodes whose linked tests to run.");
  scope = scope.filter((n) => isPipelineNodeType(n.type));
  const byNode = scope.map((n) => ({ id: n.id, files: expandClaims(linkedTests(n), root) }));
  const files = [...new Set(byNode.flatMap((n) => n.files))].sort((a, b) => a.localeCompare(b));
  const tested = byNode.filter((n) => n.files.length > 0).map((n) => n.id);
  const without = byNode.filter((n) => n.files.length === 0).map((n) => n.id);
  if (files.length === 0) {
    throw blocked(`no node in scope links a test (${without.join(", ") || "none"}); link them with set_test_files.`);
  }
  const line = command.replace("{files}", files.map(quote).join(" "));
  const res = spawnSync(line, { cwd: root, shell: true, encoding: "utf-8", timeout: TEST_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  const passed = res.status === 0 && !res.error;
  recordTestRun(tested, passed);
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.replace(/\r\n/g, "\n").trimEnd().split("\n");
  return {
    command: line,
    nodes: tested,
    files,
    exit_code: res.status,
    passed,
    ...(without.length ? { without_tests: without } : {}),
    ...(passed ? {} : { output_tail: output.slice(-TAIL_LINES) }),
  };
}

/** The check failure line for a failed run. */
export function testFailureLine(run: TestRun): string {
  const why = run.exit_code === null ? "did not finish (timeout or signal)" : `exited ${run.exit_code}`;
  return `Blocked: Tests: the linked tests of ${run.nodes.map((n) => `"${n}"`).join(", ")} failed: \`${run.command}\` ${why}. Fix them and run run_check({ run_tests: true }) again; verify closes when they pass.`;
}
