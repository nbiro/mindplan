### d-capability-type-name

- Decision: The top-level node type is named Capability; Journey is no longer a type name.
- Alternatives:
  - Keep Journey: in UX a user journey is a sequence of steps, so agents and people model checkout steps as Journeys when the type is a permanent group of behaviors
  - Domain: in DDD the domain is the whole problem space, and it collides with this Foundation's own name
  - Area: already the tool word (list_areas, area), but it has no established architecture term behind it for agents to map onto
- Why: The type answers 'What does the product do?', which is what a business capability names; agents already know that term, so the name carries its meaning without a glossary.
- Consequences: Every existing graph needs upgrade_project (migration level 3) before any other tool works; tool inputs and outputs that said journey say capability; ids keep whatever prefix they were created with.
- Change: capability-type
- Date: 2026-11-01
