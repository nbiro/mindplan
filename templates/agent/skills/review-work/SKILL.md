---
name: mindplan-review-work
description: >-
  MindPlan Review gate. Load when about to ship or resolve a revision. Review is
  proportional: the agent may ship its own work when the revision has no Foundation
  source and at most one source; otherwise it MUST spawn one independent Reviewer
  who judges source contracts and the diff together. Default mindplan-mcp check
  MUST be green at every handoff. Bind the verdict to files, owners, and
  blast-radius class — not git SHAs. Do not write Review Notes into territory.
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
| No Foundation source, **at most one** source | **Self-ship allowed.** Green `mindplan-mcp check`, then `ship` / `resolved` yourself. |
| Any Foundation source, **or** two or more sources | **Spawn one independent Reviewer** before `ship` / `resolved`. |

Self-ship is a judgment, not a loophole: if the single source is risky (security, data loss, wide neighbor fan-out), spawn a Reviewer anyway.

Self-`ready` (`draft` → `ready` in one ordered `revisions` call) never needs a Reviewer. It still needs a green `mindplan-mcp check`. Plan-only sessions stop at `ready`.

## Check at every handoff

Default `mindplan-mcp check` MUST exit `0` (ownership, import matrix, graph load) before:

- self-`ready`
- `in-review` / spawning a Reviewer
- `ship` / Bug `resolved`
- claiming the session is done

Fix every `Blocked:` first. The host typecheck is not a MindPlan gate. Check does not run it.

Every Atomic Op you are about to check must actually be done. Completion Check blocks `ship` / `resolved` while any `[ ]` remains. Atomic Ops are the record checked before ship, not the plan and not progress narration.

Other nodes at `in-progress` / `in-review` / Bug `fixing` are mergeable. They never block your revision.

## Parent: when a Reviewer is due

1. Green `mindplan-mcp check`.
2. Move the successor set (sources only, since neighbors have no `next`) to `in-review` in one ordered `revisions` call.
3. Bind the revision: `{changed_files[], sources[], neighbors[], unaffected[]}`. Map every changed file to its `implements` owner.
4. **Spawn** one Reviewer for the whole revision (not per node). Pass the file/owner/class list and that check is green.
5. Wait for the verdict.
   - **Approve:** the Reviewer ships. Do not re-ship what it already shipped.
   - **Ship-deferred:** leave the node at `in-review`. When its Foundation deps become `stable`, `ship` it without a new Reviewer, unless the files in the revision changed.
   - **Reject:** fix the Findings, re-run check, re-bind the files, and spawn a Reviewer again (the same session if the host can resume it). Treat the author's fixes as claims.
6. Done = Approve with every node shipped or explicitly ship-deferred, or human escalation. Ending the turn with "needs review" when a Reviewer is due and unspawned is not done.

## Reviewer (spawned subagent)

Judge the active contract against the diff, then stop.

**Preconditions**

- You are independent of the session that wrote the work. If you wrote it, Reject with that Finding.
- Parent has green `mindplan-mcp check`. If default `check` would fail, Reject and do not advance status.
- Do not Reject because other nodes are in progress, or because Foundation dependencies are unfinished. Infrastructure First blocks `ship`, not the quality verdict.
- Orient with `orient_for_work` / `get_node_context` / `get_blast_radius`. Your only mutation is `update_node_status`. Never `link_nodes` / `create_node`.
- Never write `## Review Notes` into territory. Findings live in the verdict message.

**Bind the revision.** Map every changed file to its `implements` owner and class (source / neighbor / unaffected). Reject undeclared files outside successor ownership. A file owned outside the successor set needs justification, as does any new or changed `assembler` role. Do not Reject because the tree is dirty. Do not bind the verdict to git SHAs. If files in the revision change after you read them, re-read those files before `ship`.

**Review everything before any mutation. Read the diff once.**

1. **Sources.** Pull PRD / Kind / Spec / AC / Atomic Ops / edges from the active body (`next` when evolving; it must be a full successor, not a changelog). Verify each checked Atomic Op independently (read the code, run tests). Check domain fit, dependency accuracy, Interaction Independence, Interface/Interaction fit (no Interface-owned screen bodies), decomposition, and territory prose against the diff. Mechanical stubs are the compiler's job (Minimum Territory Shape); you judge semantic Territory Completeness.
2. **Neighbors.** Read their changed files in the diff. Confirm behavior did not change and the shipped contract still holds. Do not demand a rewritten contract or re-verify inherited Atomic Ops the diff does not touch.
3. **Unaffected.** Confirm the diff does not require them to move. If it does, Reject: they were misclassified.

**Then one status call.** `update_node_status` once with `revisions`: `ship` for Foundations, Interactions, and Interfaces; `resolved` for Bugs whose targets are in the revision. The server orders Foundations → Interactions → Interfaces → Bugs and stops on the first `Blocked:`.

**Ship-deferral carve-out (Approve stands).** If `ship` returns `Blocked: Infrastructure First`, or Interface `ship` returns `Blocked: Behavior First` only because an exposed Interaction is Approve-but-ship-deferred, record **Approve + ship deferred**. Leave the node at `in-review`; defer later nodes waiting on the same dependency and say so. Do not flip to Reject.

**Any other `Blocked:`** (Completion Check, implements gate, Minimum Territory Shape, Ghost rules, wrong state, Behavior First after a Rejected Interaction): **stop**. Report what shipped, what failed, and why. Retreat Rejected members to `in-progress` / `fixing`.

Say Approve or Reject, the revision binding, what shipped or deferred, and Findings (per-Atomic-Op evidence on Approve; actionable gaps on Reject).

## Anti-patterns

- Spawning a Reviewer for a single non-Foundation source "just in case" with no risk, or self-shipping a Foundation or multi-source revision.
- Approving because Ghost / Minimum Territory Shape passed. That is structural, not quality.
- Approving checked boxes without independent evidence.
- Treating neighbors as brand-new contracts, or opening `next` on unaffected nodes.
- Spawning one Reviewer per node, or per Foundation then Interaction then Interface.
- Soft-approving after a `Blocked:` that is not Infrastructure First or cascading Behavior First.
- Rejecting because Foundation deps are not `stable`.
- Reviewing your own work in the same session; writing Review Notes into territory.
- Parent: claiming done, or asking the human to review, without spawning when a Reviewer is due — or handing off while `mindplan-mcp check` fails.
- Reviewer: Rejecting because unrelated nodes are mid-pipeline.
