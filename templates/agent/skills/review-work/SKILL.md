---
name: mindplan-review-work
description: >-
  MindPlan Review gate: parent self-readies (draft → ready), then MUST spawn
  one independent Reviewer before ship / resolved. That Reviewer judges the
  plan (source contracts and neighbor impact notes) and the implementation
  diff together. Narration is not a substitute. One spawn covers the whole
  revision. Reviewer runs this skill once per spawn and returns a structured
  verdict; do not write Review Notes into territory. Also covers parent
  freeze / check / retry-loop duties.
---

# Review Work

Two audiences:

- **Parent (implementing / planning agent)** — owns the Review loop: freeze, **spawn**, fix, re-spawn. Read **Parent obligations** below, then spawn a Reviewer; do not self-review.
- **Reviewer (spawned subagent)** — follow Procedure A or B once per spawn, return a structured verdict, stop.

One procedure, one revision. The parent self-readies. The Reviewer spawn is
Implementation review, and it includes the plan:

- Plan half — source contracts and neighbor impact notes (the old Procedure A checks).
- Diff half — the immutable change-set → `ship` / `resolved`.

The **parent** owns the retry loop (fix → re-enter gate → re-spawn a **fresh**
Reviewer). You (Reviewer) review once per spawn, return a structured verdict, and stop.

One approval gate per **immutable revision** — one Reviewer, one spawn, for the
whole revision. Not one spawn per node, and not one Reviewer invocation forever.
Reject, or any change of HEAD/tree after the verdict, voids approval.
`Blocked: Infrastructure First` (or Behavior First that only cascades from an
Approve-but-ship-deferred Interaction) does **not** void Approve — see Procedure B.

A wording Reject on a neighbor impact note voids the revision, same as any
Reject. The fresh spawn still uses the class split below. It does not treat
neighbors as brand-new contracts, and it does not re-verify inherited Atomic
Ops the diff does not touch.

## Revision classes

Same rule for every node type. No new node type.

Classify from blast radius and the diff. A node is **pulled in** when it
`depends_on` a source (transitive reverse `depends_on`), `exposes` a source,
or `leads_to` a source (navigates to it).

| Class | Membership | Review |
|---|---|---|
| **Source** | Own contract changed. In the successor set. | Full successor contract. Every Atomic Op. The diff. |
| **Neighbor** | Pulled in, owned files changed, own behavior did not. In the successor set. | Real `## Impact` note against the diff: what it adapted so the already-shipped contract still holds. Inherited Atomic Ops stay checked from the live contract. Re-check one only when the diff touches it. |
| **Unaffected** | Pulled in, owned files did not change. **Not** in the successor set. Do not `open_next`. | Shown so you can confirm the change does not require them to move. |

Examples: a visual-system change is a Foundation source with page neighbors. An enquiry behavior change is an Interaction source; the Interface that mounts it is the neighbor. A Bug that crosses several nodes uses the same split — full review where the contract changed, an impact note everywhere else. The Bug’s fix checklist is reviewed in full.

Nothing in the successor set ships while a node the revision touches is broken.

Neighbor `## Impact` must be a real section. Empty or scaffold text is `Blocked: Minimum Territory Shape` when the heading is present. A neighbor with no `## Impact` heading is a Reject. Do not accept a neighbor body that deletes the inherited spec and leaves only the note (`ship` promotes wholesale).

## Parent obligations (spawn before done)

The parent self-readies when the contracts are written: one `update_node_status` `revisions` call to `ready`. Do not spawn a Reviewer for that step. Plan-only sessions stop there.

When Implementation review is due, the parent MUST:

1. Run default `mindplan-mcp check` (ownership, import matrix, graph load) and the revision typecheck; both exit `0`. Fix every `Blocked:` first. Default check does not run the typechecker.
2. Enter the gate: `update_node_status` → `in-review` for the successor set (and Bug review). Use one `revisions` call, ordered by the server (Foundations, Interactions, Interfaces, Bugs).
3. Freeze the revision:
   `{base_sha, head_sha, clean_tree, changed_files[], sources[], neighbors[], unaffected[]}`.
   Successor `node_ids` = sources + neighbors. Plan Review may omit SHAs when there is no code.
4. **Spawn** one independent Reviewer for that frozen revision — pass classes, unaffected list, and that check and typecheck are green. The Reviewer judges the plan and the diff in this same spawn. On Cursor: use the Task / subagent tool pointed at `.cursor/skills/mindplan-review-work/`.
5. Wait for the structured verdict. On Reject: fix Findings, re-check, re-enter the gate, re-spawn a **fresh** Reviewer (do not resume the same Reviewer for a new verdict). After ~3 Rejects, escalate to the human.
6. On Approve: trust the Reviewer’s status transitions (`ready` / `ship` / `resolved`) and any **ship-deferred** Results. Do not re-`ship` nodes the Reviewer already shipped. When Foundations later become `stable`, the parent (or a later session) MAY call `ship` on deferred nodes without a new Reviewer unless HEAD/tree changed (void rule).

**Done** = Reviewer returned Approve and every approved node is either advanced (`ready` / `stable`/`unstable` / `resolved`) **or** explicitly ship-deferred with an Infrastructure First (or cascading Behavior First) reason — **or** human escalation after exhausted Rejects.

**Not done** = ending the turn with “this wasn’t reviewed,” “needs a Reviewer,” or “please review this” without having spawned one while nodes sit at `draft` / `in-review`.

## Preconditions (both procedures) — Reviewer

- Independent of the session that authored the plan (A) or implementation (B).
  If you wrote what you are about to review, Reject with that Finding.
- **Parent MUST have a green default `mindplan-mcp check` and a green typecheck**
  before spawning you (Implementation review, or re-spawn after Reject).
  Self-ready does not require you.
  If **default** check would fail, Reject with that Finding and do not advance status.
- **Do not Reject because other nodes are in progress.** Graph-wide
  `in-progress` / `in-review` / `draft` / `ready`, or Bug `fixing` / `in-review`,
  outside the frozen membership or revision is allowed and mergeable.
  Scope the verdict to the frozen set only.
- **Do not Reject because Foundation deps are unfinished.** Infrastructure First
  blocks MindPlan `ship`, not the quality verdict. Unfinished Foundation deps are
  not a Reject reason.
- Orient with `orient_for_work` / `get_node_context` / `get_blast_radius` before judging.
- Mutation boundary: `update_node_status` only. Never `link_nodes` / `create_node`.
- **Never** write `## Review Notes` into territory. Findings stay in the verdict message.
- If `Read` on `mindplan/agent/**` fails, load this skill via shell/`cat`.

## Structured verdict message (required)

```
Verdict: Approve | Reject
Procedure: PlanReview | ImplementationReview
Revision: { base_sha, head_sha, clean_tree, changed_files[], sources[], neighbors[], unaffected[] }
Nodes:
  - id: <id> (class: source|neighbor) (slot: next?)  Verdict: Approve|Reject  StatusAttempted: ...  Result: ...
Unaffected:
  - id: <id>  Confirmed: yes|no  Note: ...
Findings: <itemized; per-node evidence on Approve>
StatusAttempted: summary
```

Implementation Approve Findings for a **source** must include Evidence lines per Atomic Op and Fit
(domain / dependency / decomposition / Interaction Independence /
Interface–Interaction fit) **plus** general code-review / tests / diff hygiene.
For a **neighbor**, Evidence is the impact note against the diff, plus any Atomic Op the diff touches.
Reject Findings must be actionable gaps only.

## Plan half (inside the same spawn — not a separate gate)

The parent has already self-readied. You still judge the contracts before you ship.
A later-added or materially changed member invalidates approval.

1. Parent freezes **sources** and **neighbors** and lists **unaffected** blast-radius
   nodes. You review that revision only.
2. **Sources:** pull PRD / Kind / Spec / AC / Atomic Ops / edges from the active
   body (`next` when evolving). The body is a full successor, not a changelog.
3. **Neighbors:** read `## Impact`. It must say what was adapted so the shipped
   contract still holds. Spec sections stay the inherited contract. Do not demand
   a rewritten contract. Inherited Atomic Ops stay the live checklist.
4. `get_blast_radius` on source members. Confirm unaffected nodes are the pulled-in
   nodes whose files did not change, and that they do not need to move.
5. Checks (same substance as before), **on sources**: buildable AC; domain fit;
   dependency completeness (Foundations only for Interactions — **Interaction
   Independence**); Interface/Interaction fit (no Interface-owned screen bodies;
   Kind-gated mount/view or handler); decomposition; scope (one behavior / one
   surface). On neighbors, check the impact note and that fit still holds — not
   a second full contract review.
6. Mechanical stub detection is **Minimum Territory Shape** (compiler), including
   a present `## Impact` section — you judge semantic Territory Completeness for
   sources, and whether the impact note is real, not missing headings alone.
7. Do not move status here. Status moves once, after the diff half, in **one**
   `revisions` call. Reject on the plan half means do not ship. Leave nodes at
   `in-review` only if you are returning a quality Reject — then the parent
   retreats them. Report per-node Results in the one verdict.
8. Continue to the diff half in this same spawn. Do not edit territory for feedback.

## Procedure B: Implementation Review (revision / change-set → ship)

### Bind the revision

Require from parent (or compute yourself):

```
revision = {
  base_sha, head_sha, clean_tree: true, changed_files[],
  sources[], neighbors[], unaffected[]
}
```

Successor `node_ids` = sources + neighbors.

- Reject undeclared changed files outside successor ownership / Atomic Ops.
- **Owner mapping:** map each changed file to its `implements` owner (`get_node_implementation` path lookup). A file owned by a node **outside** the frozen successor is a finding that needs justifying. A new or changed `assembler` role is likewise a finding that needs justifying.
- Reject dirty tree (`clean_tree: false`).
- If HEAD or the working tree changes after your verdict, approval is void.
- Read the diff **once**. Apply the class split to that diff. Do not re-review each node as a separate full contract.

### Review everything before any mutation

1. Orient + `get_blast_radius` on source nodes. Confirm the unaffected list.
2. **Sources** — for each source and the parts of the diff it owns:
   - Verify each checked Atomic Op independently (read code, run tests/CI vs AC).
   - Domain fit, dependency accuracy, Interaction Independence, Interface/Interaction fit
     (Kind-gated mount/view or handler).
   - Decomposition drift; territory prose vs real diff.
   - **Semantic Territory Completeness** — `next.mdx` is a full successor, not a changelog (SPEC §3.6).
3. **Neighbors** — for each neighbor:
   - `## Impact` matches the diff: what was adapted so the already-shipped contract still holds.
   - Inherited Atomic Ops stay checked. Re-verify an Atomic Op only when the diff touches it.
   - Do not Require a rewritten PRD/spec.
4. **Unaffected** — confirm the diff does not require them to move. If it does, Reject: they were misclassified.
5. Diff hygiene — no scratch/patch/temp/unrelated files. General code review once
   (host-native first, e.g. Cursor `/code-review`; else community skill; else
   `mindplan/agent/skills/code-review/`). Blocking findings → Reject.
6. Produce **per-node** verdicts with evidence. Do **not** call `ship` until the whole
   set is reviewed.

### Then one status call

Call `update_node_status` **once** with `revisions` for the successor set:

- Foundations, Interactions, Interfaces: `ship` (from `in-review`)
- Bugs: `resolved` when their targets are in the revision as applicable

The server applies Foundations, then Interactions, then Interfaces, then Bugs, and
stops on the first `Blocked:`. Do not issue one call per node. Do not continue
past a `Blocked:`.

**Ship-deferral carve-out (Approve stands):**

- If Interaction/Interface `ship` returns `Blocked: Infrastructure First`, record
  **Approve + ship deferred**. Leave the node at `in-review`. Do **not** flip to
  Reject. Do **not** retreat to `in-progress`. The call has stopped; later nodes
  in the list were not written — defer those the same way when they are waiting
  on that same dependency, and say so.
- If Interface `ship` returns `Blocked: Behavior First` **only** because an exposed
  Interaction was Approve-but-ship-deferred (or is not yet `stable` for that same
  dependency wait), defer that Interface the same way.
- Report per-node Results: shipped vs ship-deferred (with the `Blocked:` text).
  Set-level Verdict may still be **Approve** when every member is Approve and each
  is either shipped/`resolved` or ship-deferred under this carve-out.

**Other `Blocked:`** (Completion Check, implements gate, Minimum Territory Shape,
Ghost rules, wrong state, Behavior First after a Rejected Interaction, etc.):
**stop**. Do not soft-approve. Do not claim the set approved. Report what shipped,
what failed, and why. Retreat Rejected members to `in-progress` / `fixing` as needed.

Reject (before any ship, for quality Findings) → retreat nodes to `in-progress` /
`fixing` as needed.

Re-spawning a Reviewer solely because ship was Infrastructure-First-blocked is an
anti-pattern. When deps become `stable`, the parent (or later session) calls `ship`
on deferred nodes — no new Reviewer — unless HEAD/tree changed after the verdict.

### Fit is not enough

Architecture Fit checks do **not** replace AC verification, tests, security/regression
review, or diff hygiene. On neighbors, fit does not replace the impact note.

## Anti-patterns

- Approving because Ghost / Minimum Territory Shape passed — that is structural, not quality.
- Approving checked boxes without independent evidence on **sources**, or on a neighbor Atomic Op the diff touches.
- Treating every touched node as a brand-new contract. Neighbors get an impact note, not a full rewrite.
- Opening `next` on unaffected blast-radius nodes, or hiding them from the Reviewer.
- Approving an empty or stub `## Impact`, or a neighbor with no impact section.
- Re-verifying every inherited Atomic Op on a neighbor the diff does not touch.
- Spawning one Reviewer per node, or per Foundation then Interaction then Interface.
- Claiming set approval after a partial ship caused by a **non**-Infrastructure-First
  (and non-cascading-Behavior-First) failure.
- Soft-approving when `update_node_status` was Blocked for any reason other than
  Infrastructure First or cascading Behavior First ship-deferral.
- Rejecting, or re-spawning a Reviewer, because Foundation deps are not `stable`.
- Skipping general code review when application code changed.
- Writing Review Notes into territory.
- Reviewing your own plan or implementation in the same session.
- Treating “once per change-set” as “never re-review after fixes.”
- **Parent:** claiming the task done, or asking the human to review, without spawning a Reviewer when a gate is due.
- **Parent:** spawning a separate Plan Reviewer before implementation, or blocking implementation on that spawn.
- **Parent:** calling `ship` on own work **before** a Reviewer Approve (self-`ready` is allowed; deferred `ship` **after** Approve is allowed).
- **Parent:** advancing the set one node at a time when one `revisions` call can order them.
- **Reviewer:** Rejecting because other nodes are `in-progress` / `in-review` / Bug `fixing`. Unfinished work elsewhere is mergeable.
