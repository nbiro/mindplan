### d-transformers-optional-dependency

- Decision: @huggingface/transformers is an optionalDependency loaded with a dynamic import; when it is missing or fails to load, search stays keyword-only.
- Alternatives:
  - A regular dependency (its onnxruntime-node and sharp prebuilt binaries failing to install on one platform would fail the whole mindplan-mcp install)
- Why: Semantic search is an improvement, not a requirement; an install on a sandbox or an unsupported platform must still get a working server.
- Consequences: npm install --omit=optional gives a keyword-only server; the reason is logged once to stderr.
- Change: semantic-search
- Date: 2026-10-25
