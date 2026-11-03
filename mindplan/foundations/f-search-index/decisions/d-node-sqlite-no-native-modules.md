### d-node-sqlite-no-native-modules

- Decision: The cache uses Node's built-in node:sqlite (DatabaseSync) with vectors stored as Float32Array BLOBs and compared by brute force in JS; engines.node rises to >=22.13 and Node 18 and 20 are no longer supported.
- Alternatives:
  - better-sqlite3 (a native module that must compile or download a binary per platform)
  - sqlite-vec for vector search (native extension; brute force over 10k nodes x 384 dimensions is about 15 MB and a few milliseconds)
- Why: 22.13 is the first 22.x release where node:sqlite works without --experimental-sqlite, so the cache needs no native npm module; graphs are far from the size where brute force is slow.
- Consequences: node:sqlite may print an ExperimentalWarning to stderr; if node:sqlite or FTS5 is missing, search falls back to token scoring. sqlite-vec can come later behind the same interface if graphs reach six figures.
- Change: semantic-search
- Date: 2026-10-25
