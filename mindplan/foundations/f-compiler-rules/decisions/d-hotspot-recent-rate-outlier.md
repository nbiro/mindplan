### d-hotspot-recent-rate-outlier

- Decision: A hotspot is a shipped node whose recent ship rate (a stored, exponentially decayed ship count) is an outlier against the graph's own median rate; fan-in only ranks hotspots, and an active keep_whole decision exempts a node. The revision count and split record stay as facts; a split resets the rate.
- Alternatives:
  - Fixed thresholds on revisions since the split and on direct fan-in (on a long project most nodes ship more than a handful of times, and a widely used node such as auth is depended on by everything without being a problem)
  - Count revisions in a time window (needs per-ship dates on the node, which is history; the decayed count gives recency with one number)
  - A hotspots.ignore list in config.json (the reason for keeping a node whole would live nowhere; a decision records it on the node and can be superseded)
  - Detect slot contention now (needs a graph concept for planned changes; deferred)
- Why: The owner's point: change frequency is only a smell relative to the project's own pace, and a node depended on by everything is normal. An outlier against the median adapts to project age and speed, decay lets old busy periods fade, and the opt-out keeps a deliberate design from being nagged.
- Consequences: A fourth server-owned field (churn) written at every ship; hotspot output depends on the date the check runs; record_decision gains keep_whole.
- Supersedes: d-churn-from-revision-count
- Change: open-closed
- Date: 2026-10-31
