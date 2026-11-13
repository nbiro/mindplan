### d-change-on-preship-source-blocked

- Decision: link_nodes with a change other than the source's own on a never-shipped source is Blocked with both ways out; planned edges stay a shipped node's.
- Alternatives:
  - Write the live edge and ignore change, as before: the edge silently joined the node's own plan, so its change then waited on the other change's node
  - Plan the edge on the pre-ship node under the other change: nothing applies it while the node is unshipped (open_next needs a shipped node), so the builder of the later change would convert it by hand; worth adding once a registry planned ahead of several unshipped changes is a measured need
- Why: A silent live edge is the wrong plan with no signal. An explicit Block costs nothing and says what to do today: link it now and let the node wait, or plan it after the node ships.
- Change: planning-friction
- Date: 2026-11-12
