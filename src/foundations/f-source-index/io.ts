/**
 * Plan-file I/O that waits out a brief lock. On Windows, another process (antivirus, the search
 * indexer, an editor's file watcher) often opens a file for a moment right after it is created or
 * changed; opening it then fails with EBUSY / EPERM / EACCES / UNKNOWN. These wrappers retry such a
 * failure a few times with a short synchronous back-off, so the handlers stay synchronous and no
 * tool call can interleave with another while it waits. Any other error is thrown at once. Every
 * read, write, copy, and removal of a file under mindplan/ goes through here (directory removal
 * uses fs.rmSync's own maxRetries).
 */
import * as fs from "fs";

/** Codes a short-lived lock produces everywhere. */
const TRANSIENT_CODES = new Set(["EBUSY", "UNKNOWN"]);

/** Codes that mean a short-lived lock only on Windows; elsewhere they are a real permission error. */
const WINDOWS_LOCK_CODES = new Set(["EPERM", "EACCES"]);

/** Waits between attempts, in milliseconds: five retries, about 0.3 s in all. */
const BACKOFF_MS = [10, 20, 40, 80, 160];

/** Retries fs.rmSync makes on a busy directory entry (same budget as BACKOFF_MS). */
export const RM_MAX_RETRIES = BACKOFF_MS.length;

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

export function isTransientFsError(err: unknown, platform: NodeJS.Platform = process.platform): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (typeof code !== "string") return false;
  return TRANSIENT_CODES.has(code) || (platform === "win32" && WINDOWS_LOCK_CODES.has(code));
}

/** Runs `op`, retrying it while it fails with a transient lock error; the last error is thrown. */
export function withTransientRetry<T>(
  op: () => T,
  backoff: readonly number[] = BACKOFF_MS,
  platform: NodeJS.Platform = process.platform
): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return op();
    } catch (err) {
      if (attempt >= backoff.length || !isTransientFsError(err, platform)) throw err;
      sleepSync(backoff[attempt]!);
    }
  }
}

export function readFileRetry(file: string): string {
  return withTransientRetry(() => fs.readFileSync(file, "utf-8"));
}

export function readBytesRetry(file: string): Buffer {
  return withTransientRetry(() => fs.readFileSync(file));
}

export function writeFileRetry(file: string, data: string | Uint8Array): void {
  withTransientRetry(() =>
    typeof data === "string" ? fs.writeFileSync(file, data, "utf-8") : fs.writeFileSync(file, data)
  );
}

export function copyFileRetry(from: string, to: string): void {
  withTransientRetry(() => fs.copyFileSync(from, to));
}

export function unlinkRetry(file: string): void {
  withTransientRetry(() => fs.unlinkSync(file));
}
