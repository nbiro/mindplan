---
name: mindplan-review-work
description: >-
  MindPlan Review gate. Load when about to ship or resolve a revision. Review is
  proportional: the agent may ship its own work when the revision has no Foundation
  source and at most one source; otherwise it MUST spawn one independent Reviewer
  who judges source contracts and the diff together. Covers when the gate is due,
  check + typecheck before handoff, the revision snapshot, the Reviewer verdict,
  ship-deferral, and Reject → fix → resume the same Reviewer. Do not write Review Notes
  into territory.
---

# Review Work

This skill is the only place the review gate is described in procedural detail. The always-on playbook just points here.

## Is a Reviewer due?

Classify the revision by blast radius (`get_blast_radius`):

- **Source** — own contract changed (`open_next`, full successor).
- **Neighbor** — depends on / exposes / navigates to a source; owned files change, behavior does not. Edited **in place**: no `open_next`, no impact note. A neighbor whose `implements` must change is not a pure neighbor — treat it as a source.
- **Unaffected** — in the radius, nothing changes.

| Revision | Gate |
|---|---|
| No Foundation source, **at most one** source | **Self-ship allowed.** Run check + typecheck (below), then `ship` / `resolved` yourself. |
| Any Foundation source, **or** two or more sources | **Spawn one independent Reviewer** before `ship` / `resolved`. |

Self-ship is a judgment, not a loophole: if the single source is risky (security, data loss, wide neighbor fan-out), spawn a Reviewer anyway.

Self-`ready` (`draft` → `ready` in one ordered `revisions` call) never needs a Reviewer. Plan-only sessions stop at `ready`.

## Before any ship (self or Reviewer)

1. Default `mindplan-mcp check` exits `0` (ownership, import matrix, graph load). Fix every `Blocked:` first.
2. The project typecheck for the revision exits `0`. Check does not run it.
3. Every Atomic Op you are about to check is actually done. Completion Check blocks `ship` / `resolved` while any `[ ]` remains. Atomic Ops are the record checked before ship, not the plan and not progress narration.

Other nodes at `in-progress` / `in-review` / Bug `fixing` are mergeable. They never block your revision.

## Parent: when a Reviewer is due

1. Move the successor set (sources only, since neighbors have no `next`) to `in-review` in one ordered `revisions` call.
2. Freeze the revision snapshot:
   `{base_sha, head_sha, clean_tree, changed_files[], sources[], neighbors[], unaffected[]}`.
3. **Spawn** one Reviewer for the whole revision (not per node). Pass the snapshot and that check and typecheck are green. On Cursor, use the Task tool and point the subagent at `.cursor/skills/mindplan-review-work/`. Keep the Reviewer's agent id: you resume it after a Reject.
4. Wait for the verdict.
   - **Approve:** the Reviewer ships. Do not re-ship what it already shipped.
   - **Ship-deferred:** leave the node at `in-review`. When its Foundation deps become `stable`, `ship` it without a new Reviewer, unless HEAD or the tree changed.
   - **Reject:** fix the Findings, re-run check + typecheck, re-freeze the snapshot, and **resume the same Reviewer** (Cursor Task `resume` with its agent id). Hand it the new snapshot and one line per Finding saying how it was addressed. A resumed Reviewer keeps what it already read and verified, so a Reject round costs the delta, not a second full review. Spawn a fresh Reviewer only when resume is unavailable (the host has no resume, or the session is gone). A fresh one gets the previous Findings in its prompt. After about three Rejects, escalate to the human.
5. Done = Approve with every node shipped or explicitly ship-deferred, or human escalation. Ending the turn with "needs review" when a Reviewer is due and unspawned is not done.

## Reviewer (spawned subagent)

Run once per spawn or resume, return the verdict, stop.

**If resumed after a Reject.** You are still independent: the author's fixes and the parent's summary are claims, not evidence. Re-bind to the new snapshot. Confirm each of your previous Findings is actually resolved in the code. Review everything changed since your last `head_sha` in full, including any file that changed since you read it. Reuse your earlier evidence only for files and Atomic Ops the diff since then did not touch. Reject anything new you find, even if it was in scope last round. The verdict format and the single status call are unchanged.

**Preconditions**

- You are independent of the session that wrote the work. If you wrote it, Reject with that Finding.
- Parent has green check and typecheck. If default `check` would fail, Reject and do not advance status.
- Do not Reject because other nodes are in progress, or because Foundation dependencies are unfinished. Infrastructure First blocks `ship`, not the quality verdict.
- Orient with `orient_for_work` / `get_node_context` / `get_blast_radius`. Your only mutation is `update_node_status`. Never `link_nodes` / `create_node`.
- Never write `## Review Notes` into territory. Findings live in the verdict message.

**Bind the revision.** Reject a dirty tree (`clean_tree: false`) and undeclared changed files outside successor ownership. Map every changed file to its `implements` owner. A file owned outside the successor set needs justification, as does any new or changed `assembler` role. If HEAD or the tree changes after your verdict, approval is void.

**Review everything before any mutation. Read the diff once.**

1. **Sources.** Pull PRD / Kind / Spec / AC / Atomic Ops / edges from the active body (`next` when evolving; it must be a full successor, not a changelog). Verify each checked Atomic Op independently (read the code, run tests). Check domain fit, dependency accuracy, Interaction Independence, Interface/Interaction fit (no Interface-owned screen bodies), decomposition, and territory prose against the diff. Mechanical stubs are the compiler's job (Minimum Territory Shape); you judge semantic Territory Completeness.
2. **Neighbors.** Read their changed files in the diff. Confirm behavior did not change and the shipped contract still holds. Do not demand a rewritten contract or re-verify inherited Atomic Ops the diff does not touch.
3. **Unaffected.** Confirm the diff does not require them to move. If it does, Reject: they were misclassified.
4. **Hygiene.** No scratch, patch, temp, or unrelated files. Do a general code review once (host-native first, e.g. Cursor `/code-review`; else `mindplan/agent/skills/code-review/`). Blocking findings → Reject.

**Then one status call.** `update_node_status` once with `revisions`: `ship` for Foundations, Interactions, and Interfaces; `resolved` for Bugs whose targets are in the revision. The server orders Foundations → Interactions → Interfaces → Bugs and stops on the first `Blocked:`.

**Ship-deferral carve-out (Approve stands).** If `ship` returns `Blocked: Infrastructure First`, or Interface `ship` returns `Blocked: Behavior First` only because an exposed Interaction is Approve-but-ship-deferred, record **Approve + ship deferred**. Leave the node at `in-review`; defer later nodes waiting on the same dependency and say so. Do not flip to Reject.

**Any other `Blocked:`** (Completion Check, implements gate, Minimum Territory Shape, Ghost rules, wrong state, Behavior First after a Rejected Interaction): **stop**. Report what shipped, what failed, and why. Retreat Rejected members to `in-progress` / `fixing`.

Architecture fit does not replace AC verification, tests, security/regression review, or diff hygiene.

**Verdict message (required, Reviewer only).**

```
Verdict: Approve | Reject
Revision: { base_sha, head_sha, clean_tree, changed_files[], sources[], neighbors[], unaffected[] }
Nodes:
  - id: <id> (class: source|neighbor)  Verdict: Approve|Reject  Result: shipped | ship-deferred (<Blocked text>) | retreated
Unaffected:
  - id: <id>  Confirmed: yes|no
Findings: <itemized; per-Atomic-Op evidence for sources on Approve; actionable gaps only on Reject>
```

## Anti-patterns

- Spawning a Reviewer for a single non-Foundation source "just in case" with no risk, or self-shipping a Foundation or multi-source revision.
- Approving because Ghost / Minimum Territory Shape passed. That is structural, not quality.
- Approving checked boxes without independent evidence.
- Treating neighbors as brand-new contracts, or opening `next` on unaffected nodes.
- Spawning one Reviewer per node, or per Foundation then Interaction then Interface.
- Spawning a fresh Reviewer after a Reject when the previous one can be resumed.
- Soft-approving after a `Blocked:` that is not Infrastructure First or cascading Behavior First.
- Rejecting, or re-spawning a Reviewer, because Foundation deps are not `stable`.
- Reviewing your own work in the same session; writing Review Notes into territory.
- Parent: claiming done, or asking the human to review, without spawning when a Reviewer is due.
- Reviewer: Rejecting because unrelated nodes are mid-pipeline.
