# MindPlan Agent Playbook

**Always apply.** MindPlan keeps you on the **system** (anti-drift) and runs an **agent development process** so code reaches the human only after independent review.

Normative reference: `SPEC.md`. Skills (on demand): `define-entities`, `plan-project`, `review-work`.

## Systems dialect (every turn)

1. **Orient** — `orient_for_work` before substantial work. Do not invent architecture from chat or `src/` greps.
2. **Place work on the graph** — Journey / Interaction / Interface / Foundation / Bug. MCP writes structure (`state`, edges, timestamps); file tools write territory prose at `current_path` / `next_path`.
3. **`Blocked:` is hard** — classify the stated cause (structure, lifecycle, completion, confirmation, unstable dependency) and fix that cause before retrying. Do not retry blindly.
4. **Implement in claimed files** — declare ownership with `set_implementation_files` (`implements` on current/next). Do not invent tickets or ad-hoc ownership outside the graph.
5. **Shipped change** — `get_blast_radius`, then classify the revision. **Source** (contract changed): `open_next` and a full successor. **Neighbor** (depends on, exposes, or navigates to a source; files changed; behavior did not): `open_next`, keep the inherited contract, add a real `## Impact` note. **Unaffected** (in the radius, files unchanged): do not open `next`.
6. **Spawn the Reviewer before ship** — self-`ready` is allowed (`draft` → `ready` in one ordered `revisions` call). Do not spawn a separate Plan Reviewer before implementation. One Reviewer, at Implementation review, judges the plan (source contracts and neighbor impact notes) and the diff together. Do not `ship` / `resolved` your own work. Narrating “needs review” without spawning that Reviewer is **not** done.
7. **Check before review handoff** — before entering `in-review` / spawning the Reviewer, and before re-spawning after a Reject, run default `mindplan-mcp check` (ownership, import matrix) and the revision typecheck; both exit `0`. Fix every `Blocked:` first. Optional `--base` is local dirty-src hygiene only — not a substitute for this gate. Default check does not run the typechecker.

After a successful graph mutation, trust the response `anchor` (record + 1-hop neighborhood) and `changed_files`. Re-call `find_related_nodes` / `get_node_context` only on `Blocked:`, a new user ask, or before review.

Never hand-edit server-owned frontmatter (`state`, `updated_at`, `shipped_at`, edge arrays, `implements`, `role`). Never trust `mindplan/map.md` as graph authority.

## Taxonomy (agent-native architecture)

| Type | Purpose |
|------|---------|
| **Journey** | Domain capability the product is about (computed state) |
| **Foundation** | Shared substrate by role (Assembler / Infra / Design system / Adapter) |
| **Interaction** | Self-contained behavior; owns domain + exportable surface (view or handler) |
| **Interface** | Actor surface that `exposes` Interactions — mounts/wires only |
| **Bug** | Defect via `affects` |

**Edges:** `belongs_to` (Interaction→Journey), `depends_on` (substrate only — never Interaction→Interaction), `exposes` (Interface→Interaction), `leads_to` (navigation), `affects` (Bug→target).

**File ownership:** Interaction owns the body; Interface only mounts/wires. Declare files via `set_implementation_files`. One Interface per actor surface, not per screen.

## Agent SDLC (short)

```
orient → place on graph → draft/enrich territory → self-ready
→ in-progress → implement + check Atomic Ops → check → in-review
→ one Reviewer (plan + implementation) → ship
```

- **Validity (`mindplan-mcp check`):** mandatory before Implementation review (entering `in-review` / spawning the Reviewer) and before re-entering a Rejected gate, together with a green typecheck of the revision. Default mode = graph load + file ownership (exclusivity, coverage, presence, leftovers, import matrix). Do not hand off with failing `Blocked:` lines. Reviewers re-run **default** `check` only. Other nodes at `in-progress` / `in-review` / Bug `fixing` are mergeable — do **not** Reject the frozen set because of them.
- **Minimum Territory Shape** (compiler): leaving `draft`, `in-review`, and `ship` require real sections — not scaffold stubs. A present `## Impact` section must be real prose. Semantic **Territory Completeness** (sources) and impact-note truth (neighbors) stay Reviewer judgments, made in the same spawn as the diff review.
- **Self-ready:** the parent moves the successor set `draft` → `ready` in one ordered `revisions` call. No separate Plan Reviewer. Plan-only sessions stop at `ready`.
- **Implementation review:** parent implements at `in-progress`, then moves the successor set to `in-review` in one ordered call, freezes `{base_sha, head_sha, clean_tree, changed_files[], sources[], neighbors[], unaffected[]}`, then **spawns** one Reviewer. That Reviewer judges the plan (source contracts, neighbor impact notes, unaffected list) and reads the diff once, using the same split, then `ship` / `resolved` in one `revisions` call (Foundations, then Interactions, then Interfaces, then Bugs) and stops on the first `Blocked:`. `Blocked: Infrastructure First` (or Behavior First only because an exposed Interaction is Approve-but-ship-deferred) means **Approve + ship deferred** — leave at `in-review`; do not Reject for unfinished Foundations. Other `Blocked:` / quality Reject / dirty tree after verdict → void; fresh Reviewer on the new revision, still using the class split. See `review-work`. Task is not done until that spawn has run. Parent done includes nodes that are `stable`/`unstable` **or** explicitly ship-deferred.
- **Git:** land via feature branch + PR; never push to `main`/`master`. Automate branch setup; keep a deterministic diff for review.

## Request routing

| User wants… | Do |
|-------------|-----|
| Plan / model only | `plan-project` → self-`ready` → stop at `ready` (no Reviewer until implementation) |
| Implement / fix / ship code | Build pipeline on the owning node (`in-progress` first) |
| Evolve shipped node | `open_next` → plan or build against `next` |
| New entities | `define-entities` (Journey before Interaction) |

## Never do

- Invent tickets outside the graph
- Same-session self-`ship` / self-`resolved` (self-`ready` is allowed)
- Treat the task as done (or hand the human “please review”) without having **spawned** the Reviewer when a Review gate is due
- Interaction→Interaction `depends_on` or Interface-owned feature screen bodies
- Check Atomic Ops without doing the work
- Write `## Review Notes` into territory
- Substantial code under `draft`/`ready` without moving to `in-progress` (or Bug `fixing`)
- Hand off to Implementation review (or re-spawn a Reviewer) while `mindplan-mcp check` fails
- Write on `main`/`master`
