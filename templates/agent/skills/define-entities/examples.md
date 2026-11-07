# MindPlan Entity Definition Examples

## Refused Interaction (no Capability)

**User request:** "Define an interaction for split & pay checkout."

**Agent action:** `get_mindplan_graph` → no Capabilities in graph (or none matching "ordering"/"checkout" capability).

**Do not** call `create_node` for the Interaction. Respond:

> This needs a **Capability** first — every Interaction belongs to one. Is it part of an existing Capability (e.g. Billing / Ordering), or something new? Once the Capability exists, I can create the Interaction and link it with `belongs_to`.

**Next step (after user agrees):** define Capability `c-ordering`, then proceed with the greenfield example below.

---

## Change request on an existing graph (reuse)

**User request:** "Let managers split the check from the back-office app too."

**Breakdown:**

> Managers can **split the check** in the **Ordering** Capability, from the **back-office** Interface, using existing Foundations (`f-db-core`, …).

**Reuse before create:**

```
find_related_nodes({ query: "split check checkout" })
→ i-checkout-split already exists (Interaction)
find_related_nodes({ query: "back office manager console" })
→ no back-office Interface yet
```

**Confirm with the user:** "I'll expose the existing *split the check* Interaction from a new *back-office* Interface — no second Interaction."

**Do not** create `i-checkout-split-backoffice` or a second Interaction. Link:

```
create_node({
  id: "if-back-office",
  type: "Interface",
  title: "Back office",
  description: "Page — manager back-office app exposing checkout and related Interactions"
})
link_nodes({ source_id: "if-back-office", target_id: "i-checkout-split", edge_type: "exposes" })
# optional Foundation deps for the Assembler / shell the back-office runs on:
link_nodes({ source_id: "if-back-office", target_id: "f-nextjs", edge_type: "depends_on" })
```

Same Interaction, new Interface = new `exposes` (+ mount/wire), not a new Interaction. One Interface for the back-office **app**, not one Interface per back-office page.

---

## Greenfield feature

**Goal:** Add "Split & pay" behavior plus a checkout Page Interface to an "Ordering" Capability.
Behavior-first: draft the Interaction, then mint Interfaces and Foundations from what its PRD needs.

### 1. Create Capability, then draft Interaction

```
create_node({ id: "c-ordering", type: "Capability", title: "Ordering", description: "Diner orders and pays for food" })
create_node({ id: "i-checkout-split", type: "Interaction", title: "Split & pay", description: "Diner splits bill and pays" })
```

Interaction may sit at `draft` with no links yet while you sketch the behavior.

### 2. Enrich Interaction territory (derive substrate and surfaces)

Write the body with `patch_node_territory` (the whole `body`, or one `section` at a time):

```
## Purpose

Let diners split a bill (even, by item, or custom) and pay their own share, without collapsing those modes into a single even split.

## Actor & Trigger

Diner starts split after items are confirmed on the table order.

## Inputs & Outputs

- In: order id, split mode, payment method
- Out: per-person totals, payment confirmation

## PRD / Execution Logic

1. Diner selects split mode (even / by item / custom)
2. System calculates per-person totals
3. Each diner pays their share via configured PSP

Mountable view: `src/interactions/i-checkout-split/checkout-split-view.tsx` (accepts shell/nav callbacks; does not import Interface packages).

## Checklist

- [ ] Domain API against Foundations (no Interaction→Interaction `depends_on`)
- [ ] Mountable view exported from package
- [ ] View accepts shell/nav as props/callbacks — does not import Interface packages
```

`patch_node_territory({ node_id: "i-checkout-split", body: "…" })`.

From that PRD, shared needs are: order/payment tables, UI primitives, an app shell Assembler, and a **Page** Interface that exposes the Interaction.

### 3. Create Interface and Foundations

```
create_node({ id: "if-checkout-page", type: "Interface", title: "Checkout page", description: "Page — exposes split & pay in the ordering console" })
create_node({ id: "f-db-core", type: "Foundation", role: "infra", title: "Database schema", description: "Infra — core tables for orders and payments" })
create_node({ id: "f-design-system", type: "Foundation", role: "design-system", title: "Design system", description: "Design system — shared UI primitives including primary button" })
create_node({ id: "f-nextjs", type: "Foundation", role: "assembler", title: "Next.js app shell", description: "Assembler — Next.js App Router composing capabilities, interactions, and interfaces" })
```

### 4. Link Interaction, Interface, Foundations

```
link_nodes({ source_id: "i-checkout-split", target_id: "c-ordering", edge_type: "belongs_to" })
link_nodes({ source_id: "i-checkout-split", target_id: "f-db-core", edge_type: "depends_on" })
link_nodes({ source_id: "i-checkout-split", target_id: "f-design-system", edge_type: "depends_on" })
link_nodes({ source_id: "if-checkout-page", target_id: "i-checkout-split", edge_type: "exposes" })
link_nodes({ source_id: "if-checkout-page", target_id: "f-nextjs", edge_type: "depends_on" })
link_nodes({ source_id: "if-checkout-page", target_id: "f-design-system", edge_type: "depends_on" })
```

Do **not** add Interaction → Interaction `depends_on`. Navigation to a follow-on tip Interaction would use `leads_to`.

### 5. Enrich Foundation and Interface territory

Write each body with `patch_node_territory`, as in step 2. Example bodies:

**`f-db-core` body:**

```
## Shared Substrate Spec

- `orders` table: id, table_id, status, created_at
- `payments` table: id, order_id, amount_cents, method

## Checklist

- [ ] Spec written
- [ ] Migration created
- [ ] Verified in staging
```

**`if-checkout-page` body:**

```
## Kind

Page

## Exposed Interactions

- `i-checkout-split` via `/orders/[id]/checkout`

## Spec

App Router (or CLI/MCP) mounts Interaction packages; Interface does not own core domain logic or screen bodies.

- Route `/orders/[id]/checkout` mounts `CheckoutSplitView` from the Interaction package
- Auth: signed-in diner for the table
- Shell chrome (header, table chip) under `src/interfaces/if-checkout-page/ui/` only

## Checklist

- [ ] Thin mount for `i-checkout-split` (screen file wires Shell + guards + nav only)
- [ ] No duplicated domain logic / behavior UI that belongs in an exposed Interaction
- [ ] Shell chrome under `ui/` only
```

Thin mount (Page) — this is “Interaction mounted,” not only “route wired”:

```tsx
// src/interfaces/if-checkout-page/screens/checkout.tsx
import { CheckoutSplitView } from "../../../interactions/i-checkout-split/checkout-split-view";
import { OrderingShell } from "../ui/OrderingShell";

export default function CheckoutScreen({ orderId }: { orderId: string }) {
  return (
    <OrderingShell>
      <CheckoutSplitView
        orderId={orderId}
        onPaid={() => router.push(`/orders/${orderId}`)}
      />
    </OrderingShell>
  );
}
```

**`f-nextjs` body:**

```
## Shared Substrate Spec

- App Router `app/` layout and providers
- How Interface packages under `src/interfaces/` mount Interaction views from `src/interactions/` (chrome and routing only — not screen bodies)
- Env and deploy constraints Interfaces must respect

## Checklist

- [ ] Spec written
- [ ] App shell wiring complete
- [ ] Documented for consumers
```

`patch_node_territory({ node_id, body: "…" })`.

### 6. Advance states (after links + content)

Self-ready Foundations, then the Interaction, then the Interface (one `revisions` call):

```
# Parent self-ready, one call (server orders Foundations, then Interactions, then Interfaces):
# update_node_status({ revisions: [
#   { node_id: "f-db-core", new_status: "ready" },
#   { node_id: "f-design-system", new_status: "ready" },
#   { node_id: "f-nextjs", new_status: "ready" },
#   { node_id: "i-checkout-split", new_status: "ready" },
#   { node_id: "if-checkout-page", new_status: "ready" },
# ] })
# Later execution session:
update_node_status({ node_id: "i-checkout-split", new_status: "in-progress" })
```

---

## Design system Foundation (shared UI substrate)

**Goal:** Stop inventing a new primary button per Interface — one Foundation, many dependents.

```
create_node({ id: "f-design-system", type: "Foundation", role: "design-system", title: "Design system", description: "Design system — shared UI primitives including primary button" })
link_nodes({ source_id: "if-checkout-page", target_id: "f-design-system", edge_type: "depends_on" })
link_nodes({ source_id: "if-ordering-console", target_id: "f-design-system", edge_type: "depends_on" })
```

Its dependents ship only once `f-design-system` is ready for dependents (Infrastructure First; Gate facts in SKILL.md).

---

## Shared Interaction + leads_to navigation (user picker)

**Goal:** Checkout flow navigates to a user-picker **behavior**; picker is an Interaction, not a Foundation. Expose it from the **same** ordering surface — do not mint `if-user-picker-page` as a second Interface for one screen.

```
create_node({ id: "i-user-picker", type: "Interaction", title: "User picker", description: "Search and select a user" })
create_node({ id: "i-checkout-split", type: "Interaction", title: "Split & pay", description: "Diner splits bill and pays" })
create_node({ id: "if-ordering-console", type: "Interface", title: "Ordering console", description: "Page — waiter/diner surface exposing checkout and picker" })
link_nodes({ source_id: "i-user-picker", target_id: "c-ordering", edge_type: "belongs_to" })
link_nodes({ source_id: "i-user-picker", target_id: "f-design-system", edge_type: "depends_on" })
link_nodes({ source_id: "if-ordering-console", target_id: "i-user-picker", edge_type: "exposes" })
link_nodes({ source_id: "if-ordering-console", target_id: "i-checkout-split", edge_type: "exposes" })
link_nodes({ source_id: "i-checkout-split", target_id: "i-user-picker", edge_type: "leads_to" })
```

Illegal (rejected by Interaction Independence):

```
link_nodes({ source_id: "i-checkout-split", target_id: "i-user-picker", edge_type: "depends_on" })
→ Blocked: Interaction Independence
```

If the picker also serves Admin, add a second `belongs_to` to `c-admin` (membership reuse). Shared state goes through Foundations, not Interaction→Interaction deps.

---

## Layered Foundation

**Goal:** Auth service depends on a lower-level config Foundation.

```
create_node({ id: "f-config", type: "Foundation", role: "infra", title: "App config", description: "Infra — environment and secrets loading" })
create_node({ id: "f-auth", type: "Foundation", role: "infra", title: "Authentication", description: "Infra — JWT issuance and validation" })
link_nodes({ source_id: "f-auth", target_id: "f-config", edge_type: "depends_on" })
```

Ship `f-config` before `f-auth`. `f-auth` counts as ready for its dependents only once `f-config` does (Gate facts in SKILL.md).

---

## Interaction spanning multiple Capabilities

**Goal:** A shared "User profile" Interaction belongs to both "Ordering" and "Loyalty" Capabilities.

```
create_node({ id: "c-ordering", type: "Capability", title: "Ordering", description: "Diner orders food" })
create_node({ id: "c-loyalty", type: "Capability", title: "Loyalty", description: "Points and rewards" })
create_node({ id: "f-db-core", type: "Foundation", role: "infra", title: "Database schema", description: "Infra — core tables" })
create_node({ id: "i-user-profile", type: "Interaction", title: "User profile", description: "Shared profile across domain capabilities" })
link_nodes({ source_id: "i-user-profile", target_id: "c-ordering", edge_type: "belongs_to" })
link_nodes({ source_id: "i-user-profile", target_id: "c-loyalty", edge_type: "belongs_to" })
link_nodes({ source_id: "i-user-profile", target_id: "f-db-core", edge_type: "depends_on" })
```

One Interaction, two `belongs_to` edges — membership reuse across Capabilities.

---

## MCP Interface exposing multiple Interactions

**Goal:** One MCP toolset Interface exposes the orient, steer, and export Interactions.

```
create_node({ id: "if-mcp-tools", type: "Interface", title: "MCP tools", description: "MCP — exposes plan orient/steer/export interactions" })
link_nodes({ source_id: "if-mcp-tools", target_id: "i-orient-plan", edge_type: "exposes" })
link_nodes({ source_id: "if-mcp-tools", target_id: "i-steer-plan", edge_type: "exposes" })
link_nodes({ source_id: "if-mcp-tools", target_id: "i-export-map", edge_type: "exposes" })
link_nodes({ source_id: "i-orient-plan", target_id: "i-steer-plan", edge_type: "leads_to" })
link_nodes({ source_id: "i-steer-plan", target_id: "i-export-map", edge_type: "leads_to" })
```

Behavior First: `if-mcp-tools` ships only once `i-orient-plan`, `i-steer-plan`, and `i-export-map` are each ready for dependents (Gate facts in SKILL.md).

---

## Bug on shipped Interaction

**Goal:** Report a race condition affecting checkout behavior.

```
create_node({ id: "bug-double-charge", type: "Bug", title: "Double charge on retry", description: "Payment retried after timeout causes duplicate charge" })
link_nodes({ source_id: "bug-double-charge", target_id: "i-checkout-split", edge_type: "affects" })

# Write Summary / Repro Steps / Expected / Fix Checklist with patch_node_territory:
patch_node_territory({
  node_id: "bug-double-charge",
  body: `## Summary

Retrying payment after network timeout creates a second charge.

## Repro Steps

1. Start checkout with card payment
2. Simulate 30s network timeout after auth
3. Click "Retry payment"
4. Observe two charges on statement

## Expected / Actual

**Expected:** Single charge; idempotent retry

**Actual:** Two charges for the same order

## Fix Checklist

- [ ] Root cause identified
- [ ] Idempotency key added to payment API
- [ ] Regression test added`
})
```

Then:

```
update_node_status({ node_id: "bug-double-charge", new_status: "triaged" })
```

`i-checkout-split` flips to `unstable` when the `affects` link is created (if already shipped).

---

## Evolving a shipped Interaction

**Goal:** Revise shipped checkout's split calculation while the live version keeps serving until the revision ships. The Interaction keeps its id (`i-checkout-split`) throughout — there is no `-v2` node.

```
get_blast_radius({ node_id: "i-checkout-split" })
→ {
    affected: [{ id: "f-…", ... }],   // reverse depends_on if any
    capabilities_at_risk: ["c-ordering"],
    reachability: {
      exposing_interfaces: ["if-checkout-page"],
      containing_capabilities: ["c-ordering"],
      leads_to_downstream: ["i-tips"]
    }
  }

open_next({
  node_id: "i-checkout-split",
  change: "split-calc",
  reason: "behavior",
  description: "Revised split calculation"
})
→ live node stays stable, still serving under <id>.mdx
→ revisions/split-calc/<id>.mdx created in draft: title and description its own, edges/claims/tests as empty deltas against live
→ revisions: [{ change: "split-calc", state: "draft" }]   // plus any other change's open revision of this node

set_implementation_files({ node_id: "i-checkout-split", change: "split-calc", add: ["src/interactions/i-checkout-split/rounding.ts"] })
→ stored on the revision as implements_add; live claims unchanged until ship

update_node_status({ node_id: "i-checkout-split", change: "split-calc", new_status: "ready" })
update_node_status({ node_id: "i-checkout-split", change: "split-calc", new_status: "in-progress" })
patch_node_territory({ node_id: "i-checkout-split", change: "split-calc", toggle_checkboxes: [{ contains: "Split calculation implemented", checked: true }] })
→ status moves apply to that revision (revision_state advances; live state is unchanged)
# change may be omitted while this is the node's only open revision; with several it is required

update_node_status({ node_id: "i-checkout-split", change: "split-calc", new_status: "in-review" })

// After external review approves:
update_node_status({ node_id: "i-checkout-split", change: "split-calc", new_status: "ship" })
→ ship is only legal from the revision's in-review; gates judge live plus this change only
→ writes live ⊕ revision onto <id>.mdx (title/description/body, deltas applied); revisions/split-calc/ is deleted
→ response: { promoted_next: true, new_state: "stable" | "unstable", rebased?: [{ change: "tips", conflicts: ["section:## PRD"] }] }

// A sibling revision left with a conflict:
resolve_conflict({ node_id: "i-checkout-split", change: "tips", section: "## PRD", take: "text", text: "<both changes merged>" })
→ conflicts: []   // tips may now move to in-review
```

`discard_next({ node_id: "i-checkout-split", change: "split-calc" })` abandons that revision at any point — deletes `revisions/split-calc/` (its file, attachments, and decisions); `<id>.mdx` and other revisions are untouched.

One decision that shapes several nodes is recorded once:

```
record_decision({ node_id: "i-checkout-split", nodes: ["i-checkout-split", "if-checkout-page"], change: "split-calc",
  decision: "Round each share down and give the remainder to the payer.",
  alternatives: ["Round half-even per share (shares no longer sum to the bill)"],
  why: "Shares must always sum to the bill total." })
→ decisions/d-round-each-share-down.md in revisions/split-calc/; clears the decision gate of both nodes' revisions of split-calc
```

## Example — multi-template platform with a composition root

A platform serves two site templates. Each template is its own Interface over the shared Interactions; one module registers both.

```
create_node({ id: "f-template-registry", type: "Foundation", role: "infra",
  title: "Template registry", description: "Infra — imports every template Interface for the route dispatcher and redirect list" })
set_implementation_files({ node_id: "f-template-registry", add: ["src/foundations/f-template-registry/"] })
→ import_violations: [
    { file: ".../registry.ts", imports: "src/interfaces/if-template-a/index.ts",
      fix: { tool: "link_nodes", args: { source_id: "f-template-registry", target_id: "if-template-a", edge_type: "mounts" } } },
    { file: ".../registry.ts", imports: "src/interfaces/if-template-b/index.ts",
      fix: { tool: "link_nodes", args: { source_id: "f-template-registry", target_id: "if-template-b", edge_type: "mounts" } } } ]
link_nodes({ source_id: "f-template-registry", target_id: "if-template-a", edge_type: "mounts" })
link_nodes({ source_id: "f-template-registry", target_id: "if-template-b", edge_type: "mounts" })
run_check({})  → ok
```

Without the two `mounts` edges the same imports fail `run_check` and the move to `in-review`.
