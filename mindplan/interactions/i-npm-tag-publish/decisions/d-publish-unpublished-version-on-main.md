### d-publish-unpublished-version-on-main

- Decision: Every push to main publishes package.json's version when npm does not list it yet, and tags it afterward; the version bump in the merged PR is the release signal.
- Alternatives:
  - Publish on a pushed vX.Y.Z tag (the maintainer wants merging to be the only release step)
  - Bump the version automatically on every merge (semantic-release / changesets: CI writes commits to main, and every merge becomes a release whether or not it should ship)
  - Publish when a commit message says release (a typo silently skips or double-releases)
- Why: The registry is the source of truth for what is already released, so the check is idempotent across re-runs and queued pushes, and a merge that should not ship simply does not bump the version.
- Consequences: A PR that should release must bump package.json; forgetting it publishes nothing. The first publish stays manual because Trusted Publishing is bound to an existing package.
- Change: npm-release
- Date: 2026-10-23
