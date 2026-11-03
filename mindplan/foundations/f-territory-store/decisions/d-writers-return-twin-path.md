### d-writers-return-twin-path

- Decision: Each store writer that re-syncs a mirror twin returns the twin path it wrote, and the tool handler adds it to changed_files.
- Alternatives:
  - Collect re-synced twins in a store-level log that the MCP wrapper drains into every result, as it does for removed legacy files
  - Have handlers infer the twin from node state (shipped, no open evolution) instead of the store reporting it
- Why: The store already reports what it wrote (writeMirrorTwin, writeNodeRules, appendDecision); a return value keeps the report beside the write and in the types, with no module state a failed call could leak into the next result, and inferring from state can list a twin no write touched.
- Consequences: A new live writer must hand its twin path to its caller; twins.test.mjs diffs every write against disk so a missed twin fails npm test.
- Date: 2026-10-20
