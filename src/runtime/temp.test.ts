import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let fakeTempRoot: string;

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'temp' ? fakeTempRoot : '/tmp'),
    on: () => {},
  },
}));

// `temp.ts` caches its session root in a module-level variable on first use,
// so each test needs a fresh module instance to get a fresh (and correctly
// cleaned-up) fake temp root.
async function freshTemp(): Promise<typeof import('./temp')> {
  vi.resetModules();
  return import('./temp');
}

describe('temp', () => {
  let temp: typeof import('./temp');

  beforeEach(async () => {
    fakeTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warp-temp-root-'));
    temp = await freshTemp();
  });

  afterEach(() => {
    fs.rmSync(fakeTempRoot, { recursive: true, force: true });
  });

  it('jobDir creates a per-job directory under the session root', async () => {
    const dir = await temp.jobDir('job-1');
    expect(fs.existsSync(dir)).toBe(true);
    expect(dir).toContain(`s-${process.pid}-`);
    expect(dir.endsWith('job-job-1')).toBe(true);
  });

  it('cleanupJobDir removes exactly that job’s directory', async () => {
    const jobA = await temp.jobDir('a');
    const jobB = await temp.jobDir('b');
    await temp.cleanupJobDir('a');
    expect(fs.existsSync(jobA)).toBe(false);
    expect(fs.existsSync(jobB)).toBe(true);
  });

  it('stagingPathBeside writes into the same directory as the final path', () => {
    const finalPath = '/some/output/dir/photo.png';
    const staged = temp.stagingPathBeside(finalPath);
    expect(path.dirname(staged)).toBe(path.dirname(finalPath));
    expect(path.basename(staged)).toMatch(/^\.filewarper-[0-9a-f]+\.png$/);
  });

  it('stagingPathBeside keeps the destination extension', () => {
    // ffmpeg picks its muxer from the output extension. A `.tmp` staging name
    // made every A/V conversion fail with "Unable to find a suitable output
    // format" once the scheduler (rather than a test) chose the path.
    expect(temp.stagingPathBeside('/out/song.mp3')).toMatch(/\.mp3$/);
    expect(temp.stagingPathBeside('/out/clip.mp4')).toMatch(/\.mp4$/);
    expect(temp.stagingPathBeside('/out/archive.tar.gz')).toMatch(/\.gz$/);
  });

  it('commitStaged renames the staged file onto the final path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warp-commit-'));
    try {
      const staged = path.join(dir, '.filewarper-abc123.tmp');
      const final = path.join(dir, 'out.png');
      await fsp.writeFile(staged, 'hello');
      await temp.commitStaged(staged, final);
      expect(fs.existsSync(staged)).toBe(false);
      expect(fs.readFileSync(final, 'utf8')).toBe('hello');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sweepStaleStaging removes orphaned .filewarper-*.tmp files but nothing else', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warp-sweep-'));
    try {
      const stale = path.join(dir, '.filewarper-deadbeef.tmp');
      const keep = path.join(dir, 'keep.png');
      await fsp.writeFile(stale, 'x');
      await fsp.writeFile(keep, 'x');
      await temp.sweepStaleStaging(dir);
      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(keep)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checkDiskSpace reports ok:false against an impossibly large requirement', async () => {
    const result = await temp.checkDiskSpace(os.tmpdir(), Number.MAX_SAFE_INTEGER);
    expect(result.ok).toBe(false);
  });

  it('checkDiskSpace reports ok:true against a trivially small requirement', async () => {
    const result = await temp.checkDiskSpace(os.tmpdir(), 1);
    expect(result.ok).toBe(true);
  });
});
