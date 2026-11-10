### d-compiler-rules-guard-pre-ship-blast-radius

- Decision: Revise f-compiler-rules in place for one guard: the decision gate's blast-radius trigger skips pre-ship Foundations, whose concentration the new f-fan-in signal now owns.
- Alternatives:
  - Split the decision gate out of f-compiler-rules first — rejected: a split for a one-line guard is a larger, riskier change than the feature; the fan-in logic itself already lives in the new f-fan-in node.
  - Leave the trigger and let both warnings show — rejected: any decision would still clear the decision: line, keeping the misleading 'record the choice' advice next to the structural one.
- Why: The trigger lives in decisions.ts; the only way to stop an unrelated decision from silencing a pre-ship Foundation's concentration is to take that case out of the gate.
- Change: fan-in-signal
- Date: 2026-11-09
