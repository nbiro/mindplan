---
name: mindplan-review-work
description: >-
  Independent Reviewer role for MindPlan gates: Plan Review (draft → ready,
  subgraph-scoped) and Implementation review (change-set / revision-bound
  in-review → ship / resolved). Run as a spawned Reviewer subagent — never when
  this session authored the plan or implementation. Findings return as a
  structured verdict message; do not write Review Notes into territory.
---

# Review Work

Use when you are the **Reviewer** in an orchestrated Review loop (parent
spawns you). Two procedures:

- Procedure A — Plan Review for a **frozen subgraph** of draft nodes → `ready`.
- Procedure B — Implementation review for an **immutable revision** /
  change-set → `ship` / `resolved`.

The **parent** owns the retry loop (fix → re-enter gate → re-spawn a **fresh**
Reviewer). You review once per spawn, return a structured verdict, and stop.

One approval gate per **immutable revision** — not one Reviewer invocation forever.
Reject, blocked transition, or any change after the verdict voids approval.

## Preconditions (both procedures)

- Independent of the session that authored the plan (A) or implementation (B).
  If you wrote what you are about to review, Reject with that Finding.
- Orient with `orient_for_work` / `get_node_context` / `get_blast_radius` before judging.
- Mutation boundary: `update_node_status` only. Never `link_nodes` / `create_node`.
- **Never** write `## Review Notes` into territory. Findings stay in the verdict message.
- If `Read` on `mindplan/agent/**` fails, load this skill via shell/`cat`.

## Structured verdict message (required)

```
Verdict: Approve | Reject
Procedure: PlanReview | ImplementationReview
Revision: { base_sha, head_sha, clean_tree, changed_files[], node_ids[] }
  # Plan Review may omit SHAs if no code; still freeze node_ids membership
Nodes:
  - id: <id> (slot: next?)  Verdict: Approve|Reject  StatusAttempted: ...  Result: ...
Findings: <itemized; per-node evidence on Approve>
StatusAttempted: summary
```

Implementation Approve Findings must include Evidence lines per Atomic Op and Fit
(domain / dependency / decomposition / Interaction Independence /
Interface–Interaction fit) **plus** general code-review / tests / diff hygiene.
Reject Findings must be actionable gaps only.

## Procedure A: Plan Review (subgraph → ready)

1. Parent freezes **membership** = nodes created/materially changed in this planning
   revision. You review that list only; a later-added or materially changed member
   invalidates the subgraph approval.
2. For each member: pull PRD / Kind / Spec / AC / Atomic Ops / edges from the active
   body (`next` when evolving).
3. `get_blast_radius` on focus members.
4. Checks (same substance as before): buildable AC; domain fit; dependency
   completeness (Foundations only for Interactions — **Interaction Independence**);
   Interface/Interaction fit (no Interface-owned screen bodies; Kind-gated
   mount/view or handler); decomposition; scope (one behavior / one surface).
5. Mechanical stub detection is **Minimum Territory Shape** (compiler) — you judge
   semantic Territory Completeness and decomposition, not missing headings alone.
6. Approve → `update_node_status → ready` **per approved member**. Reject → leave
   remaining at `draft`. Report per-node Results.
7. Return the structured verdict. Do not edit territory for feedback.

## Procedure B: Implementation Review (revision / change-set → ship)

### Bind the revision

Require from parent (or compute yourself):

```
revision = { base_sha, head_sha, clean_tree: true, changed_files[], node_ids[] }
```

- Reject undeclared changed files outside `node_ids` ownership / Atomic Ops.
- Reject dirty tree (`clean_tree: false`).
- If HEAD or the working tree changes after your verdict, approval is void.

### Review everything before any mutation

1. Orient + `get_blast_radius` on focus nodes.
2. For **every** node in `node_ids` and the **entire** diff:
   - Verify each checked Atomic Op independently (read code, run tests/CI vs AC).
   - Domain fit, dependency accuracy, Interaction Independence, Interface/Interaction fit
     (Kind-gated mount/view or handler).
   - Decomposition drift; territory prose vs real diff.
   - **Semantic Territory Completeness** — especially `next.mdx` is a full successor,
     not a changelog (SPEC §3.6).
   - Diff hygiene — no scratch/patch/temp/unrelated files.
   - General code review (host-native first, e.g. Cursor `/code-review`; else community
     skill; else `mindplan/agent/skills/code-review/`). Blocking findings → Reject.
3. Produce **per-node** verdicts with evidence. Do **not** call `ship` until the whole
   set is reviewed.

### Then transition in order (non-atomic today)

MCP `update_node_status` is single-node. Infrastructure First / Behavior First force:

1. Foundations → `ship`
2. Interactions → `ship`
3. Interfaces → `ship`
4. Bugs → `resolved` with their targets as applicable

After each transition: re-read MCP state. If any transition fails or is `Blocked:`,
**stop**. Do not claim the set approved. Report what shipped, what did not, and why.

Reject (before any ship) → retreat nodes to `in-progress` / `fixing` as needed.

### Fit is not enough

Architecture Fit checks do **not** replace AC verification, tests, security/regression
review, or diff hygiene.

## Anti-patterns

- Approving because Ghost / Minimum Territory Shape passed — that is structural, not quality.
- Approving checked boxes without independent evidence.
- Claiming set approval after a partial ship / failed later transition.
- Soft-approving when `update_node_status` was Blocked.
- Skipping general code review when application code changed.
- Writing Review Notes into territory.
- Reviewing your own plan or implementation in the same session.
- Treating “once per change-set” as “never re-review after fixes.”
