import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkExecutable,
  resetBinaryCacheForTests,
  resolveFfmpegPath,
  resolveFfprobePath,
} from './binary';

const originalEnv = { ...process.env };

beforeEach(() => {
  resetBinaryCacheForTests();
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetBinaryCacheForTests();
});

describe('binary resolution', () => {
  it('resolves ffmpeg via the npm-installed dev path', async () => {
    const p = await resolveFfmpegPath();
    expect(p).toBeTruthy();
    expect(typeof p).toBe('string');
  });

  it('resolves ffprobe via the npm-installed dev path', async () => {
    const p = await resolveFfprobePath();
    expect(p).toBeTruthy();
    expect(typeof p).toBe('string');
  });

  it('prefers WARP_FFMPEG_PATH when set', async () => {
    process.env.WARP_FFMPEG_PATH = '/custom/ffmpeg';
    resetBinaryCacheForTests();
    const p = await resolveFfmpegPath();
    expect(p).toBe('/custom/ffmpeg');
  });

  it('caches the resolved path across calls', async () => {
    const first = await resolveFfmpegPath();
    process.env.WARP_FFMPEG_PATH = '/should-not-be-used';
    const second = await resolveFfmpegPath();
    expect(second).toBe(first);
  });
});

describe('checkExecutable', () => {
  it('never throws and reports unavailable for a null path', async () => {
    const result = await checkExecutable(null, 'ffmpeg');
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toContain('ffmpeg');
      expect(result.remedy).toBeTruthy();
    }
  });

  it('never throws and reports unavailable for a missing path', async () => {
    const result = await checkExecutable('/does/not/exist/ffmpeg', 'ffmpeg');
    expect(result.available).toBe(false);
  });

  it('reports available for the real resolved binary', async () => {
    const p = await resolveFfmpegPath();
    const result = await checkExecutable(p, 'ffmpeg');
    expect(result.available).toBe(true);
  });
});
