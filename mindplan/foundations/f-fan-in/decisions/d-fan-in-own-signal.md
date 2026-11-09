### d-fan-in-own-signal

- Decision: Pre-ship Foundation concentration is a separate fan-in: warning in its own Foundation (f-fan-in), cleared only by a split or a keep_whole decision on the node, and the decision gate's blast-radius trigger skips pre-ship Foundations; f-compiler-rules and f-source-index are revised in place for one guard and one config key.
- Alternatives:
  - Keep the blast-radius trigger on pre-ship Foundations and only reword it — rejected: any decision would still satisfy the gate, so an unrelated stack decision would keep silencing a structural problem.
  - Require the gate's decision on a pre-ship Foundation to carry keep_whole — rejected: it would change the decision gate's meaning for every trigger and still Block in-review over what is a design smell, not a missing record.
  - Put the signal inside f-compiler-rules beside the hotspot code — rejected: f-compiler-rules is a hotspot; a new Foundation beside f-fan-out keeps this feature additive except for a one-line guard there.
  - A new Foundation for the fan_in config key instead of revising f-source-index — rejected: every config key lives in config.ts with one loader and writer; splitting one key out would fork config validation.
- Why: The warning must say structure, not documentation: the only fixes that should clear it are the ones that change the structure (a split) or state on the node itself that it stays whole.
- Consequences: A draft Foundation with many dependents no longer Blocks at in-review for want of a decision; it warns until split or kept whole. Exempt roles are configurable via fan_in.exempt_roles.
- Change: fan-in-signal
- Date: 2026-11-09
- Nodes: f-compiler-rules, f-source-index, i-check-integrity, i-orient-plan, i-edit-brief
