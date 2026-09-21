# MindPlan Agent Playbook

**Always apply.** MindPlan keeps you on the **system** (anti-drift) and runs an **agent development process** so code reaches the human only after independent review.

Normative reference: `SPEC.md`. Skills (on demand): `define-entities`, `plan-project`, `review-work`.

## Systems dialect (every turn)

1. **Orient** — `orient_for_work` before substantial work. Do not invent architecture from chat or `src/` greps.
2. **Place work on the graph** — Journey / Interaction / Interface / Foundation / Bug. MCP writes structure (`state`, edges, timestamps); file tools write territory prose at `current_path` / `next_path`.
3. **`Blocked:` is hard** — classify the stated cause (structure, lifecycle, completion, confirmation, unstable dependency) and fix that cause before retrying. Do not retry blindly.
4. **Implement in the owning package** when `implementation_packages` is `required` (`src/interactions|interfaces|foundations/<id>/`). Layout-free (`off`): same logical ownership in the existing app layout.
5. **Shipped change** — `get_blast_radius`, then `open_next`; edit the `next` slot into a full successor contract (not a changelog).
6. **Do not `ship` / `resolved` your own work** — freeze a revision and spawn one independent Reviewer for the change-set (`review-work`).
7. **Check before review handoff** — before Plan Review, before Implementation review (entering `in-review` / spawning the Reviewer), and before re-spawning after a Reject, run default `mindplan-mcp check` and get exit `0`. Fix every `Blocked:` first. Optional `--base` / `--for-main` are local hygiene only — not substitutes for this gate.

After a successful graph mutation, trust the response `anchor` (record + 1-hop neighborhood) and `changed_files`. Re-call `find_related_nodes` / `get_node_context` only on `Blocked:`, a new user ask, or before review.

Never hand-edit server-owned frontmatter (`state`, `updated_at`, `shipped_at`, edge arrays). Never trust `mindplan/map.md` as graph authority.

## Taxonomy (agent-native architecture)

| Type | Purpose |
|------|---------|
| **Journey** | Domain capability the product is about (computed state) |
| **Foundation** | Shared substrate by role (Assembler / Infra / Design system / Adapter) |
| **Interaction** | Self-contained behavior; owns domain + exportable surface (view or handler) |
| **Interface** | Actor surface that `exposes` Interactions — mounts/wires only |
| **Bug** | Defect via `affects` |

**Edges:** `belongs_to` (Interaction→Journey), `depends_on` (substrate only — never Interaction→Interaction), `exposes` (Interface→Interaction), `leads_to` (navigation), `affects` (Bug→target).

**Package ownership:** Interaction owns the body; Interface only mounts/wires. One Interface per actor surface, not per screen.

## Agent SDLC (short)

```
orient → place on graph → draft/enrich territory → check → Plan Review → ready
→ in-progress → implement + check Atomic Ops → check → in-review → Implementation review → ship
```

- **Validity (`mindplan-mcp check`):** mandatory before every Reviewer handoff (Plan Review and Implementation review) and before re-entering a Rejected gate. Default mode = graph load + packages when `required`. Do not hand off with failing `Blocked:` lines.
- **Minimum Territory Shape** (compiler): leaving `draft`, `in-review`, and `ship` require real sections — not scaffold stubs. Semantic **Territory Completeness** stays a Reviewer judgment.
- **Plan Review:** one Reviewer pass over the frozen subgraph of new/changed nodes (not one spawn per Foundation then Interaction then Interface). See `review-work` Procedure A.
- **Implementation review:** one approval gate per **immutable revision** `{base_sha, head_sha, clean_tree, changed_files[], node_ids[]}`. Review the whole set before any `ship`; then transition Foundations → Interactions → Interfaces with re-read after each. Reject or dirty tree after verdict → void; fresh Reviewer on the new revision. See `review-work` Procedure B.
- **Git:** land via feature branch + PR; never push to `main`/`master`. Automate branch setup; keep a deterministic diff for review.

## Request routing

| User wants… | Do |
|-------------|-----|
| Plan / model only | `plan-project` → `mindplan-mcp check` → subgraph Plan Review → stop at `ready` |
| Implement / fix / ship code | Build pipeline on the owning node (`in-progress` first) |
| Evolve shipped node | `open_next` → plan or build against `next` |
| New entities | `define-entities` (Journey before Interaction) |

## Never do

- Invent tickets outside the graph
- Same-session self-`ready` / self-`ship` / self-`resolved`
- Interaction→Interaction `depends_on` or Interface-owned feature screen bodies
- Check Atomic Ops without doing the work
- Write `## Review Notes` into territory
- Substantial code under `draft`/`ready` without moving to `in-progress` (or Bug `fixing`)
- Hand off to Plan Review or Implementation review (or re-spawn a Reviewer) while `mindplan-mcp check` fails
- Write on `main`/`master`
