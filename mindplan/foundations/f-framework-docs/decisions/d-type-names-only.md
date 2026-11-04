### d-type-names-only

- Decision: The type names (Journey, Interaction, Interface, Foundation, Bug) are the only vocabulary for node types, in docs, skills, warnings, and with the user; no plain-word synonyms.
- Alternatives:
  - Keep the plain-word glossary (area, action, entry point, building block) beside the type names: two names per type confused the owner and let agents drift between them
  - Rename list_areas and the area parameter to Journey wording too: a breaking tool-contract change, kept out of this release
- Why: One name per type is easier to follow than two layers, and the spec already fixes the type names.
- Consequences: Prose must say Journey, Interaction, Interface, Foundation, or Bug even where a plain word would read more naturally; list_areas and area keep their names until a tool-contract change renames them.
- Change: spec-type-names
- Date: 2026-10-31
