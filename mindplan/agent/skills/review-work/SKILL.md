---
name: mindplan-review-work
description: >-
  Independent Reviewer role for MindPlan gates: Plan Review (draft → ready) and
  Implementation review (in-review → ship / resolved). Run as a spawned
  Reviewer subagent (or separate session) — never when this session authored
  the plan or implemented the node. Findings return as a structured verdict
  message; do not write Review Notes into territory.
---

# Review Work

Use when you are the **Reviewer** in an orchestrated Review loop (parent
spawns you). Two procedures:

- Procedure A — Interaction/Interface/Foundation `draft → ready` (Plan Review).
- Procedure B — Interaction/Interface/Foundation/Bug `in-review` → ship /
  resolved (Implementation review).

The **parent** owns the retry loop (fix → re-enter gate → re-spawn). You
review once per spawn, return a structured verdict, and stop.

## Preconditions (both procedures)

- This run must be independent of the session that authored the plan
  (Procedure A) or the implementation (Procedure B). If you wrote what you
  are about to review, stop and return Reject with that Finding.
- Orient with `orient_for_work` or `get_node_context` before anything else.
- Mutation boundary: `update_node_status` only. Never `link_nodes`,
  `unlink_nodes`, or `create_node`.
- **Never** write `## Review Notes` (or equivalent) into `current.mdx` /
  `next.mdx`. Put all findings in your final structured verdict message.
- If `Read` on `mindplan/agent/**` fails (cursorignore), load this skill via
  shell/`cat`, or follow the procedure steps embedded in the parent prompt.

## Structured verdict message (required final output)

```
Verdict: Approve | Reject
Procedure: PlanReview | ImplementationReview
Node: <id> (slot: next)   # include slot when evolving
Findings: <itemized list, or none>
StatusAttempted: ready | ship | resolved | in-progress | fixing | none
```

Implementation Approve Findings must include short Evidence lines per
Atomic Op and Fit (domain / dependency / decomposition / Interaction
Independence / Interface–Interaction fit). Reject Findings must be
actionable gaps only.

## Procedure A: Plan Review (draft → ready)

1. Pull PRD / Actor & Trigger / Kind / Spec, Acceptance Criteria, Atomic Ops,
   and edges from the active body (`next` when evolving).
2. `get_blast_radius` — note reverse-`depends_on` dependents and, for
   Interaction focus, `reachability` (`leads_to` downstream, exposing
   Interfaces, containing Journeys).
3. Buildable: specific enough without guessing intent; real checkable AC.
4. Domain fit: Interaction `belongs_to` Journey; Foundation role tag matches
   Spec; Interface Kind matches surface.
5. Dependency completeness: Interaction `depends_on` Foundations only (no
   Interaction→Interaction deps — **Interaction Independence**). Interface
   `exposes` the right Interactions; optional Foundation deps are coherent.
6. **Interface/Interaction fit:** exposed Interactions match the Interface
   Kind/Spec; a Page/CLI/MCP does not smuggle unrelated behavior.
7. Decomposition: Atomic Ops cover AC, scoped to this node, right grain.
8. Scope: one coherent behavior (Interaction) or one surface (Interface) —
   not several that should be split; do not treat a UI page as an Interaction.
9. Approve → `update_node_status → ready`. Reject → leave at `draft`.
10. Return the structured verdict message. Do not edit territory for feedback.

## Procedure B: Implementation Review (in-review → ship / resolved)

1. Pull PRD / Actor & Trigger / Kind / Spec, Acceptance Criteria, Atomic Ops
   (current or next slot).
2. `get_blast_radius` — note transitive dependents, `journeys_at_risk`, and
   Interaction `reachability`.
3. For every checked Atomic Op, verify independently (read code, run tests,
   check behavior against AC). Unverified checked boxes → Reject.
4. Domain fit — built work belongs to the declared Journey / Foundation role /
   Interface Kind.
5. Dependency accuracy — imports/calls match declared Foundation `depends_on`;
   no undeclared coupling that should be a Foundation or `leads_to`.
6. **Interaction Independence** — Reject if implementation couples two
   Interaction packages as if one depended on the other instead of sharing
   via Foundations.
7. **Interface/Interaction fit** — Interface package wires only its `exposes`
   targets; Interaction package does not own surface routing/CLI/MCP glue that
   belongs in an Interface.
8. Decomposition — ops cover AC, scoped to this node; drift vs Plan Review.
9. Territory prose vs real diff — flag silent scope drift.
10. **Diff hygiene** — Reject if the working tree / branch diff includes
    scratch helpers, one-off patch scripts (e.g. `_patch_*.py`), temp dumps,
    or files outside this node’s Atomic Ops / package ownership.
11. **General code review (host-native first):**
    - **Host built-in** — If the host exposes a native code-review skill or
      command (e.g. Cursor `/code-review`, Claude Code bundled `/code-review`,
      Cursor `review` / `review-bugbot` when that is the host’s standard),
      follow its instructions. Load the matching `SKILL.md` from host skill
      dirs when one exists. Slash commands often cannot be fired from a
      subagent UI — apply the command’s published criteria (bugs, regressions,
      security, missing tests; findings primary; no drive-by edits) as if run.
    - **Else community skill** — If `code-review-skill` or `code-review` is
      installed (e.g. awesome-skills/code-review-skill), follow that `SKILL.md`
      (load only language guides that match the diff).
    - **Else** follow `mindplan/agent/skills/code-review/SKILL.md` (thin skill
      installed by init; use shell/`cat` if `Read` is blocked).
    - Fold **blocking** findings into the verdict `Findings`. Blocking → Reject.
    - Parent spawn prompts SHOULD name the host affordance when known
      (e.g. “also apply Cursor `/code-review` criteria”).
12. Approve → `update_node_status → ship` (Interaction/Interface/Foundation) or
    `→ resolved` (Bug). Reject → `→ in-progress` or `→ fixing`.
13. Return the structured verdict message. If the gap is structural (missing
    edge, wrong node, bad decomposition, Interaction Independence violation),
    say so — parent may need `plan-project`, not just more code. Do not edit
    territory for feedback.

## Anti-patterns

- Approving because Ghost Interaction / Ghost Interface edge check passed —
  that is structural, not quality.
- Approving because “the checklist is checked” without independent evidence.
- Approving a fully-checked list on the wrong Journey / duplicating a
  Foundation / missing ops for real AC.
- Approving an Interaction that is really a Page/CLI (should be Interface).
- Approving while Interaction→Interaction coupling violates Independence.
- Approving while scratch/patch/temp files remain in the diff or working tree.
- Skipping general code review when application or skill code changed.
- Fixing plan or graph gaps yourself with `link_nodes` / `create_node`.
- Writing Review Notes into territory files.
- Leading yourself (or accepting a parent prompt) to “approve unless
  catastrophic.”
- Reviewing your own plan or implementation in the same session.
- Soft-approving when `update_node_status` was Blocked — report failed
  transition in Findings / StatusAttempted honestly.
