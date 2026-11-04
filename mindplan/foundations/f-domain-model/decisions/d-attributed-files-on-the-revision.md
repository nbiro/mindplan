### d-attributed-files-on-the-revision

- Decision: A revision lists the files it adds in another node's claimed folder as attributed on its own slot (set_implementation_files attributed); ownership stays with the folder's claimant, the decision gate and the blast radius count the files for the revision, and ship drops the list.
- Alternatives:
  - A migration_owner config mapping a migration name prefix or change id to a node (global and indirect: nothing on the revision says which migration is its own, and a naming convention must exist first)
  - Let the schema node claim the single migration file inside the root's folder (two owners would share one folder, which exclusivity and folder dominance forbid)
- Why: Payload and similar frameworks keep one migrations folder owned by the composition root, so the file's owner and the revision that needs it differ; naming the file on the revision is the smallest fact that lets the gate connect them.
- Consequences: An agent has to attribute the migration explicitly; an unattributed migration in the root's folder still counts only for the root, as before.
- Change: agent-guidance
- Date: 2026-10-30
