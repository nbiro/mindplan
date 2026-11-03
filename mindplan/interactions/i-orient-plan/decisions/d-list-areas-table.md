### d-list-areas-table

- Decision: list_areas returns one compact table, { columns, rows }, a row per Journey: [id, title, description cut to 60 characters, interactions, interfaces, foundations, open_bugs], not an object per Journey.
- Alternatives:
  - An object per Journey with a counts object (the keys alone take about 95 bytes per area, so 30 areas cannot stay under the 4 KB budget)
  - Drop descriptions (a title alone often does not say what an area covers)
- Why: The tool exists to be cheap enough to call before orienting; a table keeps 30 areas under 4 KB with the description that makes the pick possible.
- Consequences: Clients read a row by its column index; the full description comes from orient_for_work on the Journey.
- Change: list-areas
- Date: 2026-10-25
