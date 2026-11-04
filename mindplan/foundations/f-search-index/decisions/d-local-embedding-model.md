### d-local-embedding-model

- Decision: Embeddings come from a small local English model through transformers.js, downloaded once per machine into the user cache folder and warmed up in the background.
- Alternatives:
  - A hosted embeddings API (needs a key and the network, and sends plan text off the machine)
  - Keyword search only (misses synonyms: a query saying quote never finds a node saying enquiry)
- Why: It runs offline with no API key; a ~30 MB first download is acceptable, and a tool call never waits on it.
- Consequences: Until the model is ready, or when it cannot load, search is keyword-only and never errors; words in other languages reach search only through aliases.
- Change: semantic-search
- Date: 2026-10-25
