### d-node-is-retrieval-unit

- Decision: The unit of retrieval is a node: one embedding and one keyword row per node, built from its type, title, description, area, and section headings; bodies are never split into chunks.
- Alternatives:
  - Chunk bodies and rank chunks (results would be paragraphs, while every caller orients on nodes)
- Why: Orientation picks a node; a node's title, description, and headings say what it is, and chunks would add rows without changing what the caller receives.
- Consequences: Detail that lives only deep in a body paragraph is not searchable; descriptions and headings must name what a node does.
- Change: semantic-search
- Date: 2026-10-25
