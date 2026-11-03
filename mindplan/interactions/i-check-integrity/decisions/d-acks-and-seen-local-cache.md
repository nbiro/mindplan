### d-acks-and-seen-local-cache

- Decision: Acknowledged warnings and the previous check's warnings are kept per checkout in .mindplan-cache/ (acks.json, check-seen.json), keyed by a warning id that hashes its text.
- Alternatives:
  - Store acknowledgements in mindplan/ (shared, but every parallel branch would conflict on the file)
- Why: Acknowledging is a reviewer's local triage; a text-hash id brings the warning back when the text changes, which is the behavior asked for.
- Change: compact-check
- Date: 2026-11-03
