# MindPlan — think in systems

MindPlan models this product as a graph. Plan and change code **through the graph**, not around it. Skills load on demand: `define-entities`, `plan-project`, `review-work`. Normative reference: `SPEC.md`.

## Dialect

1. **Orient.** Call `orient_for_work` before substantial work. Do not invent architecture from chat or `src/` greps. After a mutation, trust the response `anchor` and `changed_files`.
2. **Place work on the graph.** Every change belongs to a Journey, Interaction, Interface, Foundation, or Bug. MCP writes structure (`state`, edges, timestamps); file tools write territory prose at `current_path` / `next_path`. Never hand-edit server-owned frontmatter.
3. **`Blocked:` is hard.** Name the cause (structure, lifecycle, completion, confirmation, unstable dependency) and fix it before retrying.
4. **Claim files before writing them** with `set_implementation_files`.
5. **Changing shipped work is a blast-radius question.** `get_blast_radius`, then classify each node: **source** (its contract changes → `open_next`, full successor), **neighbor** (files change, behavior doesn't → edit in place), **unaffected** (leave alone).
6. **Review is proportional.** Shipping your own work is fine when the revision has no Foundation source and at most one source. A Foundation contract change or several sources needs an independent Reviewer first. Follow `review-work`; don't improvise the gate.

## Taxonomy

| Type | Purpose |
|---|---|
| **Journey** | Domain capability the product is about |
| **Foundation** | Shared substrate by role (Assembler / Infra / Design system / Adapter) |
| **Interaction** | Self-contained behavior; owns domain + exportable surface |
| **Interface** | Actor surface that `exposes` Interactions — mounts and wires only |
| **Bug** | Defect, via `affects` |

**Edges:** `belongs_to` (Interaction→Journey), `depends_on` (substrate only), `exposes` (Interface→Interaction), `leads_to` (navigation), `affects` (Bug→target). An Interaction owns its body; an Interface only mounts it. One Interface per actor surface, not per screen.

## Never

- Invent tickets outside the graph
- Add `depends_on` between Interactions, or put feature screen bodies in an Interface
- Write on `main` / `master`
- Ship your own work when `review-work` says a Reviewer is due
