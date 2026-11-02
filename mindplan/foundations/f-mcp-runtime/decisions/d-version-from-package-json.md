### d-version-from-package-json

- Decision: The server version on initialize is read from package.json at boot, never typed into source.
- Alternatives:
  - Keep a literal in server.ts and bump both on release (already 0.1.0 in two places; the first bump that forgets one makes initialize name a release that does not exist)
  - Inject it at build time with a generated module (a build step for one string, and tsc has none)
- Why: There is one source of truth for the version and it is the file npm publishes.
- Consequences: The read is relative to the compiled module so it works from dist/ inside node_modules; an unreadable file falls back to 0.0.0 with a stderr note rather than failing boot.
- Change: mcp-audit-fixes
- Date: 2026-10-20
