### d-fan-in-config-in-source-index

- Decision: Store fan_in.exempt_roles beside the other config keys in f-source-index's config.ts.
- Alternatives:
  - Give the fan_in key its own config module in f-fan-in — rejected: config.json has one loader and one writer that validate every key; a second reader would fork validation and let writeProjectConfig drop the key.
- Why: Every config key is validated and written in one place, so a new key is one more parse/write pair there.
- Change: fan-in-signal
- Date: 2026-11-09
