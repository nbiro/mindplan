### d-plan-io-retry-in-source-index

- Decision: The transient-lock retry for plan files is one module (`io.ts`) in f-source-index, used by the territory store, the graph cache, and attachment writes.
- Alternatives:
  - Keep it in f-territory-store (the graph cache, which the store depends on, could not use it without a cycle)
  - Copy a small retry loop into each Foundation that touches plan files
- Why: Every writer and reader of plan files already depends on f-source-index, so one module there covers all of them without a new edge or duplicated retry rules.
- Consequences: A new fs call on a file under mindplan/ should use these wrappers; directory removal passes RM_MAX_RETRIES to fs.rmSync.
- Change: merge-gate
- Date: 2026-10-28
