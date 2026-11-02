### d-repin-merges-from-dispatched-ci

- Decision: The repin PR is merged by a merge-repin job in ci.yml that runs after the test matrix passes on the CI run the repin job dispatched, merging with GITHUB_TOKEN pinned to the tested head commit.
- Alternatives:
  - GitHub auto-merge (gh pr merge --auto) from the repin job: main has no required status checks, so it merges at once without waiting for CI; making it wait means adding required checks for every PR, and the PR's pull_request run waits for approval
  - Repin job in publish.yml waits for the dispatched run (gh run watch) and then merges: polling, and it holds the publish concurrency group for the whole CI run, queueing the next release behind it
  - Run the tests inside the repin job and merge there: duplicates the CI matrix and check in a second workflow
- Why: The CI run that tests the branch is the one that knows when it is green, so a dependent job merges with no polling and no hold on the publish queue, and --match-head-commit ties the merge to the tested commit.
- Consequences: ci.yml carries a job that writes to the repository, scoped by event and branch prefix and limited to package.json and package-lock.json changes. The merge by GITHUB_TOKEN starts no CI or Publish run on main.
- Change: repin-auto-merge
- Date: 2026-10-25
