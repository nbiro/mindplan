# MindPlan Entity Definition Examples

## Refused Workflow (no Journey)

**User request:** "Define a workflow for split & pay checkout."

**Agent action:** `get_mindplan_graph` → no Journeys in graph (or none matching "ordering"/"checkout" capability).

**Do not** call `create_node` for the Workflow. Respond:

> I cannot define this Workflow yet — every Workflow must belong to a Journey, and no matching Journey exists in the graph. Please define the Journey first (the macro user capability this feature belongs to). Once the Journey exists, I can create the Workflow and link it with `belongs_to`.

**Next step (after user agrees):** define Journey `j-ordering`, then proceed with the greenfield example below.

---

## Greenfield feature

**Goal:** Add a "Split & pay checkout" feature to an "Ordering" Journey.

### 1. Create entities

```
create_node({ id: "j-ordering", type: "Journey", title: "Ordering", description: "Diner orders and pays for food" })
create_node({ id: "f-db-core", type: "Foundation", title: "Database schema", description: "Core tables for orders and payments" })
create_node({ id: "wf-checkout-split", type: "Workflow", title: "Split & pay checkout", description: "Diner splits bill and pays" })
```

### 2. Link Workflow

```
link_nodes({ source_id: "wf-checkout-split", target_id: "j-ordering", edge_type: "belongs_to" })
link_nodes({ source_id: "wf-checkout-split", target_id: "f-db-core", edge_type: "depends_on" })
```

### 3. Enrich Foundation territory

In `mindplan/foundations/f-db-core/context.mdx` body:

```markdown
## Infrastructure Spec

- `orders` table: id, table_id, status, created_at
- `payments` table: id, order_id, amount_cents, method

## Checklist

- [ ] Spec written
- [ ] Migration created
- [ ] Verified in staging
```

### 4. Enrich Workflow territory

In `mindplan/workflows/wf-checkout-split/context.mdx` body:

```markdown
## Execution Logic

1. Diner selects split mode (even / by item / custom)
2. System calculates per-person totals
3. Each diner pays their share via configured PSP

## Checklist

- [ ] Requirements defined
- [ ] Split calculation implemented
- [ ] Payment flow integrated
- [ ] E2E tests passing
```

### 5. Advance states (after links + content)

```
update_node_status({ node_id: "wf-checkout-split", new_status: "ready" })
update_node_status({ node_id: "wf-checkout-split", new_status: "in-progress" })
```

---

## Layered Foundation

**Goal:** Auth service depends on a lower-level config Foundation.

```
create_node({ id: "f-config", type: "Foundation", title: "App config", description: "Environment and secrets loading" })
create_node({ id: "f-auth", type: "Foundation", title: "Authentication", description: "JWT issuance and validation" })
link_nodes({ source_id: "f-auth", target_id: "f-config", edge_type: "depends_on" })
```

Ship `f-config` before `f-auth`. Workflows depending on `f-auth` cannot ship until `f-auth` is `stable`.

---

## Workflow spanning multiple Journeys

**Goal:** A shared "User profile" Workflow belongs to both "Ordering" and "Loyalty" Journeys.

```
create_node({ id: "j-ordering", type: "Journey", title: "Ordering", description: "Diner orders food" })
create_node({ id: "j-loyalty", type: "Journey", title: "Loyalty", description: "Points and rewards" })
create_node({ id: "f-db-core", type: "Foundation", title: "Database schema", description: "Core tables" })
create_node({ id: "wf-user-profile", type: "Workflow", title: "User profile", description: "Shared profile across product surfaces" })
link_nodes({ source_id: "wf-user-profile", target_id: "j-ordering", edge_type: "belongs_to" })
link_nodes({ source_id: "wf-user-profile", target_id: "j-loyalty", edge_type: "belongs_to" })
link_nodes({ source_id: "wf-user-profile", target_id: "f-db-core", edge_type: "depends_on" })
```

One Workflow, two `belongs_to` edges — both Journeys recompute state from this Workflow independently.

---

## Workflow dependency and journey closure

**Goal:** Checkout depends on an Auth workflow; both must belong to the Ordering Journey.

```
create_node({ id: "wf-auth", type: "Workflow", title: "Authentication", description: "Login and session" })
create_node({ id: "wf-checkout-split", type: "Workflow", title: "Split & pay checkout", description: "Diner splits bill and pays" })
link_nodes({ source_id: "wf-checkout-split", target_id: "wf-auth", edge_type: "depends_on" })
link_nodes({ source_id: "wf-checkout-split", target_id: "f-db-core", edge_type: "depends_on" })
```

Linking checkout to the Journey without auth present is rejected:

```
link_nodes({ source_id: "wf-checkout-split", target_id: "j-ordering", edge_type: "belongs_to" })
→ Blocked: Dependency Closure. "wf-checkout-split" depends on workflow(s) not linked to journey "j-ordering": "wf-auth". Link them first, or retry with link_dependent: true.
```

Retry with cascade:

```
link_nodes({ source_id: "wf-checkout-split", target_id: "j-ordering", edge_type: "belongs_to", link_dependent: true })
→ ok; dependents_linked includes wf-auth -> j-ordering
```

Both Workflows must ship in dependency order: `wf-auth` must reach `stable` before `wf-checkout-split` can `ship`.

---

## Bug on shipped Workflow

**Goal:** Report a race condition affecting checkout.

```
create_node({ id: "bug-double-charge", type: "Bug", title: "Double charge on retry", description: "Payment retried after timeout causes duplicate charge" })
link_nodes({ source_id: "bug-double-charge", target_id: "wf-checkout-split", edge_type: "affects" })
```

Enrich `mindplan/bugs/bug-double-charge/context.mdx`:

```markdown
## Summary

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
- [ ] Regression test added
```

Then:

```
update_node_status({ node_id: "bug-double-charge", new_status: "triaged" })
```

`wf-checkout-split` flips to `unstable` when the `affects` link is created (if already shipped).

---

## Versioning a shipped Workflow

**Goal:** Replace shipped checkout with a v2 while the v1 keeps serving until cutover.

```
get_blast_radius({ node_id: "wf-checkout-split" })
→ { affected: [{ id: "wf-tips", type: "Workflow", distance: 1, ... }], journeys_at_risk: ["j-ordering"] }

create_node_version({
  previous_id: "wf-checkout-split",
  id: "wf-checkout-split-v2",
  title: "Split & pay checkout v2",
  description: "Revised split calculation"
})
→ predecessor stays stable; new node draft with inherited outgoing edges
→ dependents of wf-checkout-split gain depends_on → wf-checkout-split-v2 (old edge kept)

// After implementation and checklist complete:
update_node_status({ node_id: "wf-checkout-split-v2", new_status: "ship" })
→ predecessor auto-deprecates; response includes predecessor_deprecated
```
