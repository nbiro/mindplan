### d-revisions-per-change-folder

- Decision: A shipped node holds one open revision per change id, each in its own folder <node>/revisions/<change>/ with its <id>.mdx, attachments/, and decisions/; ship or discard deletes the folder.
- Alternatives:
  - Flat <id>.next.<change>.mdx files beside live (crowds the node folder and needs a parallel naming scheme for attachments)
  - Keep one next slot and queue features (the SkyLoom session reopened f-static-build six times in sequence)
- Why: The user chose the folder layout: two branches working on different changes of one node never touch the same path, so git merges them cleanly.
- Change: multi-revisions
- Date: 2026-11-02
