/**
 * Temp file ownership. MAIN owns every temp directory — never a worker — so a
 * killed worker still leaves a path main can clean up.
 *
 * Layout: {app.getPath('temp')}/file-warper/s-{pid}-{startedAtMs}/job-{jobId}/
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

const ROOT_NAME = 'file-warper';
const SESSION_PREFIX = 's-';
const STALE_SESSION_MS = 24 * 60 * 60 * 1000;

const startedAt = Date.now();
let cachedRoot: string | null = null;

function tempRoot(): string {
  return path.join(app.getPath('temp'), ROOT_NAME);
}

/** `{tempRoot}/s-{pid}-{startedAt}` for this running app instance. */
export function sessionRoot(): string {
  if (!cachedRoot) {
    cachedRoot = path.join(tempRoot(), `${SESSION_PREFIX}${process.pid}-${startedAt}`);
  }
  return cachedRoot;
}

function ensureSessionRoot(): void {
  fs.mkdirSync(sessionRoot(), { recursive: true });
}

/** Allocates (and creates) the scratch/intermediate directory for one job. */
export async function jobDir(jobId: string): Promise<string> {
  ensureSessionRoot();
  const dir = path.join(sessionRoot(), `job-${jobId}`);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** Per-job cleanup. Callers MUST invoke this in a `finally`, win or lose. */
export async function cleanupJobDir(jobId: string): Promise<void> {
  const dir = path.join(sessionRoot(), `job-${jobId}`);
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

function parseSessionDirName(name: string): { pid: number; startedAt: number } | null {
  const m = /^s-(\d+)-(\d+)$/.exec(name);
  if (!m) return null;
  const pidStr = m[1];
  const startedStr = m[2];
  if (!pidStr || !startedStr) return null;
  return { pid: Number(pidStr), startedAt: Number(startedStr) };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH: no such process -> dead. Anything else (e.g. EPERM) -> assume alive.
    return code !== 'ESRCH';
  }
}

/**
 * Startup sweep: delete session directories left behind by a killed instance
 * (dead pid) or simply old (>24h). This is the cleanup guarantee that
 * actually matters — `will-quit`/`exit` handlers lose to SIGKILL.
 */
export async function sweepStaleSessions(): Promise<void> {
  const root = tempRoot();
  let entries: string[];
  try {
    entries = await fsp.readdir(root);
  } catch {
    return;
  }

  const now = Date.now();
  await Promise.all(
    entries.map(async (name) => {
      const parsed = parseSessionDirName(name);
      if (!parsed) return;
      const dead = !isPidAlive(parsed.pid);
      const stale = now - parsed.startedAt > STALE_SESSION_MS;
      if (dead || stale) {
        await fsp
          .rm(path.join(root, name), { recursive: true, force: true })
          .catch(() => {});
      }
    }),
  );
}

/** `will-quit` handler: remove this session's whole root. */
export async function removeSessionRoot(): Promise<void> {
  await fsp.rm(sessionRoot(), { recursive: true, force: true }).catch(() => {});
}

/** `process.on('exit')` handler. Must be sync — async work never runs there. */
export function removeSessionRootSync(): void {
  try {
    fs.rmSync(sessionRoot(), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/** Registers the two cleanup hooks that must live for the process lifetime. */
export function registerTempCleanupHooks(): void {
  app.on('will-quit', () => {
    void removeSessionRoot();
  });
  process.on('exit', () => {
    removeSessionRootSync();
  });
}

/**
 * The final hop writes here — same directory (and volume) as `finalPath` —
 * so the commit is a same-volume `rename`, which is atomic.
 */
export function stagingPathBeside(finalPath: string): string {
  const dir = path.dirname(finalPath);
  const rand = randomBytes(6).toString('hex');
  return path.join(dir, `.filewarper-${rand}.tmp`);
}

/** Atomic-as-possible commit of a staged file onto its final destination. */
export async function commitStaged(stagedPath: string, finalPath: string): Promise<void> {
  try {
    await fsp.rename(stagedPath, finalPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fsp.copyFile(stagedPath, finalPath);
    await fsp.unlink(stagedPath).catch(() => {});
  }
}

/** Cleans up a staged file that never got committed (cancel/failure path). */
export async function discardStaged(stagedPath: string): Promise<void> {
  await fsp.unlink(stagedPath).catch(() => {});
}

/** Sweeps orphaned `.filewarper-*.tmp` files left in a directory we wrote to. */
export async function sweepStaleStaging(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((name) => name.startsWith('.filewarper-') && name.endsWith('.tmp'))
      .map((name) => fsp.unlink(path.join(dir, name)).catch(() => {})),
  );
}

export interface DiskSpaceCheck {
  readonly ok: boolean;
  readonly availableBytes: number;
  readonly requiredBytes: number;
  readonly dir: string;
}

/** `1.5x` images, `3x` video transcode, `10x` raw/uncompressed targets — caller supplies the factor. */
export async function checkDiskSpace(
  dir: string,
  requiredBytes: number,
): Promise<DiskSpaceCheck> {
  try {
    const stats = await fsp.statfs(dir);
    const availableBytes = stats.bavail * stats.bsize;
    return { ok: availableBytes >= requiredBytes, availableBytes, requiredBytes, dir };
  } catch {
    // Volume stats unavailable (e.g. exotic filesystem) — don't block the batch on it.
    return { ok: true, availableBytes: Number.POSITIVE_INFINITY, requiredBytes, dir };
  }
}

/** Convenience: the OS temp root, exposed for the worker-side scratch dirs. */
export function osTempRoot(): string {
  return os.tmpdir();
}
