---
name: mindplan-review-work
description: >-
  Independent Reviewer gates for MindPlan: Plan Review (draft → ready) and
  Implementation review (in-review → ship / resolved). Use when a separate
  session must approve a plan or ship/resolve work — never when this session
  authored the plan or implemented the node.
---

# Review Work

Use for two distinct gates, both run by an independent Reviewer session:

- Procedure A — a Workflow or Foundation needs a `draft → ready` decision
  (Plan Review).
- Procedure B — a Workflow/Foundation/Bug `in-review` node needs a
  ship / resolved decision (Implementation review).

## Preconditions (both procedures)
- This session must be independent of the session that authored the plan
  (Procedure A) or the implementation (Procedure B) for this node. If you
  wrote what you're about to review, stop.
- Orient with `orient_for_work` or `get_node_context` before doing anything
  else.
- Mutation boundary: you may call `update_node_status` only. Never
  `link_nodes`, `unlink_nodes`, or `create_node` — fixing the plan or the
  graph to make your own approval work is not review.

## Procedure A: Plan Review (draft → ready)
1. Pull the node's PRD / Execution Logic, Acceptance Criteria, Atomic Ops,
   and current edges from the body.
2. `get_blast_radius` — note anything that already depends on this node.
3. Check the plan is buildable: specific enough to build from without
   guessing intent, with real checkable Acceptance Criteria.
4. Check domain fit: does `belongs_to` (Journey) or the Foundation's role
   tag actually match what the PRD describes?
5. Check dependency completeness: do the declared `depends_on` edges cover
   what the plan will need, and nothing it won't?
6. Check decomposition quality: do the Atomic Ops fully cover the
   Acceptance Criteria, each one scoped to this node, at the right grain?
7. Check scope: is this one coherent use case, or several that should be
   split into separate nodes before implementation starts?
8. Write a `## Review Notes` section into `current.mdx` (or `next.mdx` if
   evolving) via file tools: date, verdict, findings.
9. Approve → `update_node_status → ready`.
   Reject → leave at `draft`, citing the Review Notes section.

## Procedure B: Implementation Review (in-review → ship / resolved)
1. Pull the node's PRD / Execution Logic, Acceptance Criteria, and Atomic
   Ops from the body (current or next slot).
2. `get_blast_radius` — note transitive dependents and `journeys_at_risk`.
3. For every checked Atomic Op, verify independently:
   - Code exists and does what the item claims — read it.
   - Tests exist and pass — run them, don't assume.
   - Behavior matches Acceptance Criteria — check actual output, not the
     description of it.
4. Check domain fit. Read the Journey(s) this node belongs_to (or the
   Foundation's role tag). Confirm what got built actually belongs to that
   domain, not to a different Journey, Workflow, or Foundation.
5. Check dependency accuracy. Compare the diff's real imports/calls against
   the node's declared `depends_on` edges. Flag any undeclared coupling —
   the graph is only honest if this matches.
6. Check decomposition quality. Confirm the Atomic Ops fully cover the
   Acceptance Criteria, each op is scoped to this node only, and no op
   secretly describes work that belongs to a different node. If this node
   passed Plan Review already, this is mainly a drift check against what
   was approved there.
7. Compare territory prose to the real diff. Flag any silent scope drift.
8. Write a `## Review Notes` section into the active file (current.mdx, or
   next.mdx if a next slot is open) via file tools: date, verdict, an
   Evidence subsection (per-item verification) and a Fit subsection
   (domain, dependency, decomposition findings).
9. Approve → `update_node_status → ship` (Workflow/Foundation) or
   `→ resolved` (Bug).
   Reject → `update_node_status → in-progress` or `→ fixing`, citing the
   Review Notes section. If the gap is structural (missing edge, wrong
   node, bad decomposition), say so explicitly — the fix may need a
   `plan-project` pass, not just more code.

## Anti-patterns (both procedures)
- Approving a plan to `ready` because Ghost Workflow's edge check passed —
  that's a structural check, not a quality one.
- Approving because "the checklist is checked" without independently
  verifying every checked item — skimming the diff is not review.
- Approving a fully-checked list that's covering the wrong Journey,
  duplicating a Foundation's job, or missing ops for real Acceptance
  Criteria.
- Fixing a plan or graph gap yourself with `link_nodes` or `create_node`
  instead of rejecting it for the author to fix.
- Leaving verbal-only feedback in chat instead of writing it into the file.
- Reviewing your own plan or implementation in the same session.
