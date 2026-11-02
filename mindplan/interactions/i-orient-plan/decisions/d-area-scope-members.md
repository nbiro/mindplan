### d-area-scope-members

- Decision: An area (a Journey id) scopes search to the Journey itself, the Interactions that belong to it, the Interfaces that expose them, and the Foundations they depend on transitively (live and proposed edges); Bugs are outside it.
- Alternatives:
  - Only the Interactions (the Interface and Foundation an agent changes for that area would never rank)
  - Everything one link away (pulls in unrelated Journeys' Interactions through shared Interfaces)
- Why: That set is where work for the area lands; a Bug is found by what it affects, or by searching without an area.
- Consequences: A shared Foundation appears in every area that uses it; a cross-cutting question searches without area.
- Change: list-areas
- Date: 2026-10-25
