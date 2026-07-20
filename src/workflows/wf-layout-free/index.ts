/**
 * Layout-free adoption helpers / markers.
 * Orchestration lives in f-territory-store config, wf-project-init, and wf-integrity-check.
 * Coverage: wf-test-harness check.test.mjs + smoke.mjs.
 */
export const LAYOUT_FREE_CONFIG = {
  implementation_packages: "off",
} as const;
