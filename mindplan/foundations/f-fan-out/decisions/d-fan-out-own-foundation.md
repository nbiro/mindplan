### d-fan-out-own-foundation

- Decision: The fan-out signal is its own Foundation (f-fan-out) that depends_on f-compiler-rules for keepsWhole, not another open–closed signal inside f-compiler-rules.
- Alternatives:
  - Add fanOut beside hotspotFor in f-compiler-rules/open-closed.ts (reopens a hotspot shipping at 13.7 against a median of 3.4)
- Why: f-compiler-rules is a hotspot; a new Foundation keeps this change additive there, and the check and orient only need two functions from it.
- Consequences: The check and orient gain a depends_on on f-fan-out; a later graph-fact signal can follow the same pattern.
- Change: graph-filters-fan-out
- Date: 2026-10-31
