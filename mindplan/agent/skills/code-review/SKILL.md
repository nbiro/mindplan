---
name: mindplan-code-review
description: >-
  Thin portable code-review checklist for MindPlan Implementation review.
  Use when reviewing diffs for bugs, regressions, security, missing tests, and
  scratch/unrelated files. Prefer host-native code-review (built-in skill or
  command such as Cursor /code-review) when available; else community
  code-review-skill; otherwise follow this skill.
---

# Code Review (MindPlan thin)

Use during **Implementation review** (with `review-work` Procedure B), or when
asked to review a branch/diff. Keep findings actionable. Do not write review
feedback into MindPlan territory files — return findings to the caller (e.g.
structured verdict `Findings`).

## Discovery order (host-native first)

1. **Host built-in** — If the host exposes a native code-review skill or
   command (e.g. Cursor `/code-review`, Claude Code bundled `/code-review`,
   Cursor `review` / `review-bugbot` when that is the host’s standard):
   - Load the matching `SKILL.md` from host skill dirs when one exists and
     follow it.
   - Slash commands often cannot be invoked from a subagent UI — apply the
     command’s published criteria (bugs, regressions, security, missing tests;
     findings primary; no drive-by edits) as if that command were run.
2. **Else community skill** — If `code-review-skill` or `code-review` is
   installed (for example
   [awesome-skills/code-review-skill](https://github.com/awesome-skills/code-review-skill)):
   - Load that skill’s `SKILL.md` (and only the `reference/` guides that match
     languages in the diff).
   - Apply its process, then still apply the **MindPlan must-checks** below.
3. **Else this thin skill** — Apply the MindPlan must-checks below.

Blocking findings from any layer → treat as blocking for MindPlan ship.

Init does **not** vendor open-source trees — only this thin skill is guaranteed
via `mindplan-mcp init`.

## MindPlan must-checks (always)

1. **Scratch / unrelated files** — Reject if the working tree or branch diff
   includes one-off helpers, patch scripts (e.g. `_patch_*.py`), temp dumps, or
   files outside the owning node’s Atomic Ops / package. They must be deleted
   (or justified as in-scope) before Approve.
2. **Bugs & edge cases** — logic errors, null/empty paths, off-by-one, races.
3. **Behavioral regressions** — compare to Acceptance Criteria / prior behavior.
4. **Security** — injection, XSS, secrets in diff, unsafe authz, path traversal.
5. **Missing tests** — new behavior without coverage when the project normally
   tests this layer; note gaps as blocking or important.
6. **Fit with MindPlan** — no undeclared `src/` coupling outside `depends_on`;
   docs/skills stay in the owning Workflow’s surfaces.

## Severity

- **Blocking** — must fix before `ship` / `resolved` (scratch files, clear bugs,
  security holes, failed AC).
- **Important** — should fix; discuss if disagree.
- **Nit** — optional; never the sole reason to Reject.

## Output

Itemized findings with severity. When called from `review-work`, fold blocking
items into the structured verdict and Prefer Reject over ship.
