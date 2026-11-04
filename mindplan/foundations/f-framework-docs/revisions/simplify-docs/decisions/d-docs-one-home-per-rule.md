### d-docs-one-home-per-rule

- Decision: Each documented rule has one home section that states it in full; every other doc points to it, and SPEC, README, the playbook, and the skills describe current behavior only, with release history kept in CHANGELOG.md.
- Alternatives:
  - Keep restating rules where they are used, so a get_spec topic or a skill reads on its own: the copies drifted (README's rule list, define-entities' file-tools advice and gate facts, SPEC §11, Appendix B all contradicted the current rules)
  - Drop the unimplemented and rarely used parts (§6.4 MDX, §10 external UI sync, open–closed signals) while simplifying: the owner asked to simplify the text first and drop no feature yet
- Why: Agents follow whatever copy they read; one home per rule leaves nothing to drift, and history in the normative text made the current contract hard to find (SPEC was ~296 KB).
- Consequences: A section may say less on its own and point elsewhere; a behavior change edits the rule's home and adds a CHANGELOG entry, not every place that mentions it.
- Change: simplify-docs
- Date: 2026-11-04
