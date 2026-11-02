### d-bge-small-default-model

- Decision: The default model is Xenova/bge-small-en-v1.5 (q8, CLS pooling, with the bge query instruction), chosen over Xenova/all-MiniLM-L6-v2 on the search test set.
- Alternatives:
  - Xenova/all-MiniLM-L6-v2 (hybrid top-1 0.771 and MRR 0.842 against bge's 0.792 and 0.858 on the same run, top-5 equal)
- Why: It scored better on every metric that differed, at the same 384 dimensions and a similar download.
- Consequences: The committed fixture vectors are bge vectors; changing the default means rerunning search-eval.test.mjs --write-vectors and --write-metrics.
- Change: semantic-search
- Date: 2026-10-25
