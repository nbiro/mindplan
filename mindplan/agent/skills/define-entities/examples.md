# MindPlan Entity Definition Examples

## Refused Interaction (no Journey)

**User request:** "Define an interaction for split & pay checkout."

**Agent action:** `get_mindplan_graph` → no Journeys in graph (or none matching "ordering"/"checkout" capability).

**Do not** call `create_node` for the Interaction. Respond:

> I cannot define this Interaction yet — every Interaction must belong to a Journey, and no matching Journey exists in the graph. Please define the Journey first (the domain capability this behavior belongs to). Once the Journey exists, I can create the Interaction and link it with `belongs_to`.

**Next step (after user agrees):** define Journey `j-ordering`, then proceed with the greenfield example below.

---

## Greenfield feature

**Goal:** Add "Split & pay" behavior plus a checkout Page Interface to an "Ordering" Journey.
Behavior-first: draft the Interaction, then mint Interfaces and Foundations from what its PRD needs.

### 1. Create Journey, then draft Interaction

```
create_node({ id: "j-ordering", type: "Journey", title: "Ordering", description: "Diner orders and pays for food" })
create_node({ id: "i-checkout-split", type: "Interaction", title: "Split & pay", description: "Diner splits bill and pays" })
```

Interaction may sit at `draft` with no links yet while you sketch the behavior.

### 2. Enrich Interaction territory (derive substrate and surfaces)

Edit `mindplan/interactions/i-checkout-split/current.mdx` via file tools:

```
## Purpose

Let diners split a bill and complete payment for their share.

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

Optional fallback: `patch_node_territory({ node_id: "i-checkout-split", body: "…" })`.

From that PRD, shared needs are: order/payment tables, UI primitives, an app shell Assembler, and a **Page** Interface that exposes the Interaction.

### 3. Create Interface and Foundations

```
create_node({ id: "if-checkout-page", type: "Interface", title: "Checkout page", description: "Page — exposes split & pay in the ordering console" })
create_node({ id: "f-db-core", type: "Foundation", title: "Database schema", description: "Infra — core tables for orders and payments" })
create_node({ id: "f-design-system", type: "Foundation", title: "Design system", description: "Design system — shared UI primitives including primary button" })
create_node({ id: "f-nextjs", type: "Foundation", title: "Next.js app shell", description: "Assembler — Next.js App Router composing journeys, interactions, and interfaces" })
```

### 4. Link Interaction, Interface, Foundations

```
link_nodes({ source_id: "i-checkout-split", target_id: "j-ordering", edge_type: "belongs_to" })
link_nodes({ source_id: "i-checkout-split", target_id: "f-db-core", edge_type: "depends_on" })
link_nodes({ source_id: "i-checkout-split", target_id: "f-design-system", edge_type: "depends_on" })
link_nodes({ source_id: "if-checkout-page", target_id: "i-checkout-split", edge_type: "exposes" })
link_nodes({ source_id: "if-checkout-page", target_id: "f-nextjs", edge_type: "depends_on" })
link_nodes({ source_id: "if-checkout-page", target_id: "f-design-system", edge_type: "depends_on" })
```

Do **not** add Interaction → Interaction `depends_on`. Navigation to a follow-on tip Interaction would use `leads_to`.

### 5. Enrich Foundation and Interface territory

Prefer host file tools on `current_path` from `get_node_context` (body below `---`, plus title/description scalars). Example bodies:

**`mindplan/foundations/f-db-core/current.mdx` body:**

```
## Shared Substrate Spec

- `orders` table: id, table_id, status, created_at
- `payments` table: id, order_id, amount_cents, method

## Checklist

- [ ] Spec written
- [ ] Migration created
- [ ] Verified in staging
```

**`mindplan/interfaces/if-checkout-page/current.mdx` body:**

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

**`mindplan/foundations/f-nextjs/current.mdx` body:**

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

Optional fallback (automation / weak file tools): `patch_node_territory({ node_id, body: "…" })`.

### 6. Advance states (after links + content)

Plan Review Foundations first, then the Interaction, then the Interface (spawn Reviewer via `review-work` — do not self-`ready`):

```
# After Plan Review Approve on each Foundation:
# update_node_status({ node_id: "f-db-core", new_status: "ready" })  # Reviewer only
# …same for f-design-system, f-nextjs…
# After Plan Review Approve on the Interaction:
# update_node_status({ node_id: "i-checkout-split", new_status: "ready" })  # Reviewer only
# After Plan Review Approve on the Interface:
# update_node_status({ node_id: "if-checkout-page", new_status: "ready" })  # Reviewer only
# Later execution session:
update_node_status({ node_id: "i-checkout-split", new_status: "in-progress" })
```

---

## Design system Foundation (shared UI substrate)

**Goal:** Stop inventing a new primary button per Interface — one Foundation, many dependents.

```
create_node({ id: "f-design-system", type: "Foundation", title: "Design system", description: "Design system — shared UI primitives including primary button" })
link_nodes({ source_id: "if-checkout-page", target_id: "f-design-system", edge_type: "depends_on" })
link_nodes({ source_id: "if-ordering-console", target_id: "f-design-system", edge_type: "depends_on" })
```

Ship `f-design-system` to `stable` before dependent Interactions/Interfaces can ship (Infrastructure First).

---

## Shared Interaction + leads_to navigation (user picker)

**Goal:** Checkout flow navigates to a user-picker **behavior**; picker is an Interaction, not a Foundation. Expose it from the **same** ordering surface — do not mint `if-user-picker-page` as a second Interface for one screen.

```
create_node({ id: "i-user-picker", type: "Interaction", title: "User picker", description: "Search and select a user" })
create_node({ id: "i-checkout-split", type: "Interaction", title: "Split & pay", description: "Diner splits bill and pays" })
create_node({ id: "if-ordering-console", type: "Interface", title: "Ordering console", description: "Page — waiter/diner surface exposing checkout and picker" })
link_nodes({ source_id: "i-user-picker", target_id: "j-ordering", edge_type: "belongs_to" })
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

If the picker also serves Admin, add a second `belongs_to` to `j-admin` (membership reuse). Shared state goes through Foundations, not Interaction→Interaction deps.

---

## Layered Foundation

**Goal:** Auth service depends on a lower-level config Foundation.

```
create_node({ id: "f-config", type: "Foundation", title: "App config", description: "Infra — environment and secrets loading" })
create_node({ id: "f-auth", type: "Foundation", title: "Authentication", description: "Infra — JWT issuance and validation" })
link_nodes({ source_id: "f-auth", target_id: "f-config", edge_type: "depends_on" })
```

Ship `f-config` before `f-auth`. Interactions depending on `f-auth` cannot ship until `f-auth` is `stable`.

---

## Interaction spanning multiple Journeys

**Goal:** A shared "User profile" Interaction belongs to both "Ordering" and "Loyalty" Journeys.

```
create_node({ id: "j-ordering", type: "Journey", title: "Ordering", description: "Diner orders food" })
create_node({ id: "j-loyalty", type: "Journey", title: "Loyalty", description: "Points and rewards" })
create_node({ id: "f-db-core", type: "Foundation", title: "Database schema", description: "Infra — core tables" })
create_node({ id: "i-user-profile", type: "Interaction", title: "User profile", description: "Shared profile across domain capabilities" })
link_nodes({ source_id: "i-user-profile", target_id: "j-ordering", edge_type: "belongs_to" })
link_nodes({ source_id: "i-user-profile", target_id: "j-loyalty", edge_type: "belongs_to" })
link_nodes({ source_id: "i-user-profile", target_id: "f-db-core", edge_type: "depends_on" })
```

One Interaction, two `belongs_to` edges — membership reuse across Journeys.

---

## MCP Interface exposing multiple Interactions

**Goal:** One MCP toolset Interface exposes orient, steer, and export Behaviors.

```
create_node({ id: "if-mcp-tools", type: "Interface", title: "MCP tools", description: "MCP — exposes plan orient/steer/export interactions" })
link_nodes({ source_id: "if-mcp-tools", target_id: "i-orient-plan", edge_type: "exposes" })
link_nodes({ source_id: "if-mcp-tools", target_id: "i-steer-plan", edge_type: "exposes" })
link_nodes({ source_id: "if-mcp-tools", target_id: "i-export-map", edge_type: "exposes" })
link_nodes({ source_id: "i-orient-plan", target_id: "i-steer-plan", edge_type: "leads_to" })
link_nodes({ source_id: "i-steer-plan", target_id: "i-export-map", edge_type: "leads_to" })
```

Behavior First: `if-mcp-tools` cannot `ship` until `i-orient-plan`, `i-steer-plan`, and `i-export-map` are each `stable`.

---

## Bug on shipped Interaction

**Goal:** Report a race condition affecting checkout behavior.

```
create_node({ id: "bug-double-charge", type: "Bug", title: "Double charge on retry", description: "Payment retried after timeout causes duplicate charge" })
link_nodes({ source_id: "bug-double-charge", target_id: "i-checkout-split", edge_type: "affects" })

# Prefer file tools on bug current_path for Summary / Repro / Expected; optional fallback:
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

**Goal:** Revise shipped checkout's split calculation while v1 keeps serving until cutover. The Interaction keeps its id (`i-checkout-split`) throughout — there is no `-v2` node.

```
get_blast_radius({ node_id: "i-checkout-split" })
→ {
    affected: [{ id: "f-…", ... }],   // reverse depends_on if any
    journeys_at_risk: ["j-ordering"],
    reachability: {
      exposing_interfaces: ["if-checkout-page"],
      containing_journeys: ["j-ordering"],
      leads_to_downstream: ["i-tips"]
    }
  }

open_next({
  node_id: "i-checkout-split",
  description: "Revised split calculation"
})
→ live node stays stable, still serving under current.mdx
→ next.mdx created: { state: "draft", title, description, belongs_to, depends_on, leads_to } inherited from current

update_node_status({ node_id: "i-checkout-split", new_status: "ready" })
update_node_status({ node_id: "i-checkout-split", new_status: "in-progress" })
# Prefer file tools on next_path to toggle checkboxes / edit body; optional:
# patch_node_territory({ node_id: "i-checkout-split", toggle_checkboxes: [{ contains: "Split calculation implemented", checked: true }] })
→ status transitions apply to next.mdx automatically while it exists (record.next.state advances; live record.state is unchanged)

update_node_status({ node_id: "i-checkout-split", new_status: "in-review" })

// After external review approves:
update_node_status({ node_id: "i-checkout-split", new_status: "ship" })
→ ship is only legal from next in-review; re-checks Infrastructure First against next's depends_on
→ promotes next.mdx over current.mdx (title/description/body/edges); next.mdx is deleted
→ response: { promoted_next: true, new_state: "stable" | "unstable", next_state: null }
```

`discard_next({ node_id: "i-checkout-split" })` abandons the evolution at any point — deletes `next.mdx` and `next-attachments/`; `current.mdx` is untouched.
