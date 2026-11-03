### d-fan-out-config-nested

- Decision: The fan-out threshold is stored as fan_out: { warn_at } in mindplan/config.json, default 3, validated like decisions and hotspots.
- Alternatives:
  - A top-level fanOutWarnAt key (the only camelCase top-level key; the owner chose the nested form)
- Why: Every config setting is a nested snake_case object that patch_config merges by key; one more object keeps the shape and the unknown-key rule uniform.
- Change: graph-filters-fan-out
- Date: 2026-10-31
