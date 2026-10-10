# MindPlan — think in systems

MindPlan models this product as a graph. Plan and change code **through the graph**, not around it. Skills load on demand: `define-entities`, `plan-project`, `review-work`. Normative reference: `SPEC.md`.

## Dialect

1. **Orient.** Call `orient_for_work` before substantial work. Do not invent architecture from chat or `src/` greps. After a mutation, trust the response `anchor` and `changed_files`.
2. **Place work on the graph.** Every change belongs to a Journey, Interaction, Interface, Foundation, or Bug. MCP writes structure (`state`, edges, timestamps); file tools write territory prose at `current_path` / `next_path`. Never hand-edit server-owned frontmatter.
3. **`Blocked:` is hard.** Name the cause (structure, lifecycle, completion, confirmation, unstable dependency) and fix it before retrying.
4. **Claim files before writing them** with `set_implementation_files`.
5. **Changing shipped work is a blast-radius question.** `get_blast_radius`, then classify each node: **source** (its contract changes → `open_next`, full successor), **neighbor** (files change, behavior doesn't → edit in place), **unaffected** (leave alone).
6. **Review is proportional.** Shipping your own work is fine when the revision has no Foundation source and at most one source. A Foundation contract change or several sources needs an independent Reviewer first. Follow `review-work`; don't improvise the gate.
7. **Check at every handoff.** Default check MUST exit 0 before self-`ready`, `in-review` / spawning a Reviewer, `ship` / Bug `resolved`, or claiming the session is done. Fix every `Blocked:` first. Do not wait until `ship`. The host typecheck is not a MindPlan gate.
8. **Project brief.** Agents receive this dialect as `get_project.playbook`. Follow `description` and `rules` from the same response. Edit `mindplan/project.md`; call `get_project` again to re-read.

## Taxonomy

Each type answers one question (plain words from SPEC §2.0.0; type names stay for tools):

| Type | Plain word | Question |
|---|---|---|
| **Journey** | area | What does the product do? |
| **Interaction** | action | What can someone do? |
| **Interface** | entry point | Where do they do it? (one per app or channel, not per page) |
| **Foundation** | building block | What does it all run on? (role: Assembler / Infra / Design system / Adapter) |
| **Bug** | bug | What's broken? |

**Edges:** `belongs_to` (is part of), `depends_on` (needs — substrate only), `exposes` (shows), `leads_to` (then goes to), `affects` (breaks). An Interaction owns its body; an Interface only mounts it. One Interface per actor surface, not per screen.

## Breaking down work

1. Rewrite the ask as: *"<who> can <verb> <object> in <area>, from <entry point>, using <building blocks>."*
2. Each distinct verb + object is one Interaction candidate (size: one behavior).
3. **Reuse before create** — `find_related_nodes` for each piece. Same action from a new entry point → new `exposes`, not a new Interaction.
4. Titles are stable names; descriptions say what the node does *now*; revision notes stay in `next.mdx` body.
5. Then create what's missing via `define-entities` / `plan-project`.

## Talking to the user

Use the plain words (area, action, entry point, building block, bug) with the user. Keep type names and ids for tool calls and graph talk with other agents. Translate every `Blocked:` into one plain sentence plus the next step. Example: "I'll add *split the check* as a new action in the Billing area and show it on the checkout page."

## Never

- Invent tickets outside the graph
- Add `depends_on` between Interactions, or put feature screen bodies in an Interface
- Hand off work (ready, in-review, ship, or "done") while default check fails
- Ship your own work when `review-work` says a Reviewer is due
