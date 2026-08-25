/**
 * Runs `next build` when `out/index.html` is missing or stale, so
 * `npm run test:e2e` never silently tests a week-old export.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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
  if (!isStale()) return;
  console.log('[e2e/harness] out/index.html missing or stale — running `next build`…');
  execFileSync('npx', ['next', 'build'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
}
