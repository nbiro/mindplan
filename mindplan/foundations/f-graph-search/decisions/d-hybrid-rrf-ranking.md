### d-hybrid-rrf-ranking

- Decision: Ranking is hybrid: keyword (FTS5 bm25, or token scoring as the fallback) and semantic (cosine) top lists merged with reciprocal rank fusion, score = sum of 1/(60 + rank), then a small bonus for nodes one link from the top 3; an exact id is always first.
- Alternatives:
  - Semantic only (exact ids and rare words rank worse than with keywords)
  - A weighted sum of raw bm25 and cosine scores (the two scales differ per query and need retuning per graph)
- Why: Rank fusion needs no score calibration between the two halves and keeps each half's strengths; the graph boost lifts the Interaction behind a matched Journey or Foundation without reordering a clear winner.
- Consequences: score in RankedMatch is the fused score, comparable only within one reply.
- Change: semantic-search
- Date: 2026-10-25
