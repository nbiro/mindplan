### d-churn-from-revision-count

- Decision: Hotspot churn is the node's server-written `revisions` count since its last split (`split_at`), with decision change ids only as the fallback for a node init has not backfilled; decisions still supply the reasons the warning groups.
- Alternatives:
  - Keep counting distinct decision change ids (a revision that recorded no decision is invisible, so churn is only a lower bound)
  - Store a per-revision log on the node (change, date, files): the owner's rule is current state on the node, history in git
  - Count recent revisions in a time window (old churn fades even when nothing was split, and a split node stays flagged until it ages out)
  - Let the agent mark a split with a flag on record_decision (easy to forget or misuse; the depends_on gained on new parts is a graph fact the server can see)
- Why: A counter is a fact about the node now, like shipped_at, and is exact; the split record lets a root that already split its parts out stop being flagged for revisions it had before the split, which is the fix the warning asks for.
- Consequences: Three server-owned frontmatter fields (revisions, split_at, split_into); one more changed line per ship; init backfills them from git, and nodes outside git start at 1.
- Supersedes: d-churn-from-decision-changes
- Change: open-closed
- Date: 2026-10-31
