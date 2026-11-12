### d-store-removes-unshipped-nodes

- Decision: The territory store itself gains removeNode for never-shipped nodes and the replace list, beside deleteRevisionFolder and replaceTextInBody, and is revised as it is.
- Alternatives:
  - A new Foundation for node removal that depends_on the store: it would delete node folders outside the only writer of node files, or need the store's write tracking and lock retries exported to it
  - Apply a replace list in i-edit-territory by calling the store once per entry: each call writes the file, so a failing entry would leave the earlier ones applied
  - Split the store first (the refactor its hotspot warning names): neither addition belongs to a part that could be cut out; both extend its existing folder-removal and body-patch code by a few lines
- Why: The store is the single write path to mindplan/, so a new kind of write lands here by design; removing a node folder anywhere else would break the rule that makes the graph cache and changed_files trustworthy.
- Consequences: removeNode does not check edges; i-discard-change is its only caller and checks them first.
- Change: planning-friction
- Date: 2026-11-12
- Nodes: i-discard-change, i-edit-territory
