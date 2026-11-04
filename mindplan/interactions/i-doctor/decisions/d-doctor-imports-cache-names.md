### d-doctor-imports-cache-names

- Decision: doctor imports the cache folder and file names from the Foundations that own those caches instead of repeating the strings, so a renamed cache can never make it report a present cache as missing.
- Alternatives:
  - Keep local copies of the names (the review found four copies that could drift)
- Why: A health tool that misreports cache state misdiagnoses exactly the slow-attach case it exists for.
- Change: review-fixes
- Date: 2026-11-03
