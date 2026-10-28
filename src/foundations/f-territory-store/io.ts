/**
 * Node-file I/O that waits out a brief lock. On Windows, another process (antivirus, the search
 * indexer, an editor's file watcher) often opens a file for a moment right after it is created or
 * changed; opening it then fails with EBUSY / EPERM / EACCES / UNKNOWN. These wrappers retry such a
 * failure a few times with a short synchronous back-off, so the handlers stay synchronous and no
 * tool call can interleave with another while it waits. Any other error is thrown at once.
 */
import * as fs from "fs";

/** Error codes a short-lived lock held by another process produces. */
const TRANSIENT_CODES = new Set(["EBUSY", "EPERM", "EACCES", "UNKNOWN"]);

/** Waits between attempts, in milliseconds: five retries, about 0.3 s in all. */
const BACKOFF_MS = [10, 20, 40, 80, 160];

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

export function isTransientFsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && TRANSIENT_CODES.has(code);
}

/** Runs `op`, retrying it while it fails with a transient lock error; the last error is thrown. */
export function withTransientRetry<T>(op: () => T, backoff: readonly number[] = BACKOFF_MS): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return op();
    } catch (err) {
      if (attempt >= backoff.length || !isTransientFsError(err)) throw err;
      sleepSync(backoff[attempt]!);
    }
  }
}

export function readFileRetry(file: string): string {
  return withTransientRetry(() => fs.readFileSync(file, "utf-8"));
}

export function writeFileRetry(file: string, data: string): void {
  withTransientRetry(() => fs.writeFileSync(file, data, "utf-8"));
}

export function unlinkRetry(file: string): void {
  withTransientRetry(() => fs.unlinkSync(file));
}
