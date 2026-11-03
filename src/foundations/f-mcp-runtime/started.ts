/**
 * When this server process started — recorded by f-mcp-runtime at boot, read by doctor.
 * No other state: importing it has no side effect beyond taking the time.
 */

let startedAt = new Date();

/** Called by the runtime as the server boots; the module's load time stands in until then. */
export function markServerStarted(): void {
  startedAt = new Date();
}

/** The time the server booted. */
export function serverStartedAt(): Date {
  return startedAt;
}
