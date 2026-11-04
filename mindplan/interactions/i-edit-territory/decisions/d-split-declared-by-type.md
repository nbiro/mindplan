### d-split-declared-by-type

- Decision: A split is declared on the node's open revision with patch_node_territory split_into and recorded when it ships, for every node type: a Foundation's parts are Foundations it depends_on, an Interaction's are Interactions sharing one of its Journeys, an Interface's are Interactions it exposes. Live ships never infer one; only init infers past Foundation splits from git.
- Alternatives:
  - Foundations only, as in 0.10.0 (an Interaction or Interface whose behavior moved into new actions kept its hotspot rate even though the split was the fix)
  - Deprecate the old action instead (works when every behavior leaves, as with i-steer-plan; not when the root keeps a core, as with i-orient-plan)
  - Infer a split from new edges (a new dependency and an extracted part look the same; a false split silences a real hotspot)
- Why: Only the agent knows a part was extracted; the edge each type needs keeps the import rules intact (a root imports its Foundation parts, sibling actions share an area, an entry point mounts the actions it exposes). Supersedes the Foundation-only rule carried in d-split-declared-on-revision on the deprecated i-steer-plan.
- Change: hotspot-splits
- Date: 2026-10-31
