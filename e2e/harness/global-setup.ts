/**
 * Runs `next build` when `out/index.html` is missing or stale, so
 * `npm run test:e2e` never silently tests a week-old export.
 *
 * Also isolates the app's persisted state for the whole run. Every spec
 * launches Electron with `{ ...process.env }`, so setting WARP_USER_DATA here
 * reaches all of them, and `src/main/index.ts` redirects `userData` to it.
 * Without this the suite is not hermetic: a test that asserts a setting's
 * DEFAULT passes on a fresh CI runner and fails on any machine where that
 * setting was ever changed — including by an earlier run of the suite itself.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const OUT_INDEX = path.join(PROJECT_ROOT, 'out', 'index.html');
const WATCHED_DIRS = ['src/app', 'src/ui', 'src/core', 'src/shared', 'next.config.ts'];

function newestMtimeMs(target: string): number {
  const stat = fs.statSync(target, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of fs.readdirSync(target)) {
    newest = Math.max(newest, newestMtimeMs(path.join(target, entry)));
  }
  return newest;
}

function isStale(): boolean {
  const outStat = fs.statSync(OUT_INDEX, { throwIfNoEntry: false });
  if (!outStat) return true;
  return WATCHED_DIRS.some(
    (rel) => newestMtimeMs(path.join(PROJECT_ROOT, rel)) > outStat.mtimeMs,
  );
}

export default function globalSetup(): void {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'warp-e2e-userdata-'));
  process.env.WARP_USER_DATA = userData;
  console.log(`[e2e/harness] isolated userData at ${userData}`);

  if (!isStale()) return;
  console.log('[e2e/harness] out/index.html missing or stale — running `next build`…');
  execFileSync('npx', ['next', 'build'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
}
