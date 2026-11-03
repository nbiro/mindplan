### d-repin-job-after-tag

- Decision: The Publish workflow repins the exact self devDependency in its own repin job right after a successful publish and tag: it opens a PR with GITHUB_TOKEN that bumps no version and dispatches CI on the branch.
- Alternatives:
  - Dependabot scoped to mindplan-mcp (no workflow code, but it checks on a schedule, at most daily, so the pin lags a release by up to a day)
  - Open the PR with a personal access token or GitHub App so pull_request CI runs by itself (a long-lived secret or an app to maintain, for one lockfile PR)
  - Repin by hand after each release (easy to forget; the rule alone did not do it for 0.2.1)
- Why: The workflow knows the exact moment a release succeeded, GITHUB_TOKEN with contents, pull-requests, and actions write can push, open the PR, and dispatch CI, and a separate job keeps a repin failure from marking the release failed.
- Consequences: The repository must allow GitHub Actions to create pull requests; ci.yml must keep its workflow_dispatch trigger; a publish job that fails after publishing skips the repin, which is then opened by hand.
- Change: npm-release
- Date: 2026-10-25
