### d-domain-model-revise-for-open-revisions

- Decision: This revision reopens f-domain-model only to add the Revision types and open_revisions field; the behavior lives in the new f-revision-model.
- Alternatives:
  - Define the types in f-revision-model too (every reader of MindPlanNode would then depend on it to see a node's revisions)
- Why: MindPlanNode is defined here and every module reads it; the field must sit beside next, which it replaces.
- Change: multi-revisions
- Date: 2026-11-02
