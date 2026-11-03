### d-doctor-ungated-tool

- Decision: Server health is a separate ungated read tool (doctor) plus fatal-error logging at boot, not extra fields on get_project.
- Alternatives:
  - Add version, root, and load time to get_project (it is gated when the graph needs setup or an upgrade, exactly when the diagnosis is needed)
- Why: The failure being diagnosed is an attach or startup problem; the tool must answer before and regardless of the graph's state.
- Change: doctor
- Date: 2026-11-03
