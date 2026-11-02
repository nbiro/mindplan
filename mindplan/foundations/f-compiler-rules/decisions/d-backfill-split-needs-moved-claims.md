### d-backfill-split-needs-moved-claims

- Decision: init infers a past split only when a claim of the new Foundation was covered by the node's claims before that ship and is not after it (files moved), not merely when the node gained depends_on on a Foundation first shipped in the window.
- Alternatives:
  - Keep the depends_on-gain rule (on skyloom it inferred 10 splits, of which only f-payload's was real, e.g. f-site-domains -> f-languages)
  - Stop inferring splits from git altogether (the real f-payload split, the case the feature exists for, would be lost)
- Why: SPEC already says a revision that only starts using a new building block marks nothing; moved claims are the git-visible fact that separates an extraction from a new dependency.
- Consequences: An extraction that wrote the part into a fresh folder without the root ever claiming it (this repo's own past splits) is no longer inferred; the agent declares future splits with split_into, and a wrong record can be cleared with split_into: [].
- Change: split-by-claims
- Date: 2026-10-31
