### d-rule-text-once-per-session

- Decision: Rule blocks keep the distance rule (own and distance-1 text, one line beyond) and also leave out every source whose text at its current version already reached this session, as { node_id, version, unchanged: true }; resend_rules returns the text again, and config replies.legacy restores the 0.22 behavior.
- Alternatives:
  - Keep stateless replies (d-light-rules-by-distance): every orient, node context, and write result repeated the same rule text, which made most of a 62 KB section read
  - Rely on clients passing known_rules_versions (no client tracked versions in practice; the cost stayed on every reply)
- Why: Replies must stay under about 8 KB; the orientation gate already keeps per-session state, and it still Blocks a write when a version changed since it was sent, so leaving out known text cannot let an agent skip a changed rule. resend_rules covers a client that lost its context.
- Consequences: A client that drops context mid-session must pass resend_rules: true (or call get_rules for the project rules). Write results that orient implicitly carry rule text under the same rule.
- Supersedes: d-light-rules-by-distance
- Change: lighter-calls
- Date: 2026-11-08
- Nodes: f-orientation-ledger, f-plan-views, f-plan-writes, i-edit-brief
