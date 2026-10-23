# npm registry adapter

Contract between this repository and the public npm registry. Owned by Foundation `f-npm-registry`.

## Package identity

- Package: `mindplan-mcp` (unscoped, public)
- Repository: `github.com/nbiro/mindplan`
- Contents: `dist/`, `templates/`, `README.md`, `SPEC.md`, `LICENSE` (`package.json` `files`); the publish script asserts this allowlist before every publish.

## Trusted Publishing (OIDC)

Routine releases publish from GitHub Actions with npm Trusted Publishing, so there is no `NPM_TOKEN` secret. A push to `main` publishes when `package.json`'s version is not on the registry yet, then tags it `vX.Y.Z`.

- Workflow: `.github/workflows/publish.yml` (owned by `i-npm-tag-publish`), GitHub Environment `npm-publish`.
- A publishing job requests `permissions: id-token: write` (plus `contents: write` to push the tag), sets `actions/setup-node` `registry-url: https://registry.npmjs.org`, and runs npm 11.5.1 or later (the job upgrades npm, because `setup-node` ships an older one).
- On npmjs.com, the package's Trusted Publisher is GitHub Actions → owner `nbiro`, repository `mindplan`, workflow `publish.yml`, environment `npm-publish`. This binding can only be made after the package exists, so it follows the first claim.
- npm attaches provenance to Trusted Publishing releases; no other attestation step.

## Manual publish (first claim, break-glass)

The first publish claims the name from a maintainer machine: `npm login` (with OTP), then `npm run publish:release` (`i-npm-publish`). The same path works if Trusted Publishing is broken; prefer fixing the binding to adding a token.
