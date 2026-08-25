import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearProbeCacheForTests, probeMedia } from './ffprobe';
import { ffmpegLavfiVideoWithAudio, pcmWav } from './fixtures';
import { cleanupDir, makeTempDir } from './test-helpers';

let dir: string;
let wavPath: string;
let videoPath: string;

beforeAll(async () => {
  dir = await makeTempDir('ffprobe-');
  wavPath = path.join(dir, 'tone.wav');
  await writeFile(wavPath, pcmWav(440, 0.05));
  videoPath = path.join(dir, 'clip.mp4');
  await ffmpegLavfiVideoWithAudio(videoPath);
}, 20_000);

afterAll(async () => {
  await cleanupDir(dir);
});

describe('probeMedia', () => {
  it('reports audio-only files correctly', async () => {
    const result = await probeMedia(wavPath);
    expect(result.hasAudio).toBe(true);
    expect(result.hasVideo).toBe(false);
    expect(result.durationSec).toBeCloseTo(0.05, 1);
  });

  it('reports video+audio files correctly', async () => {
    const result = await probeMedia(videoPath);
    expect(result.hasVideo).toBe(true);
    expect(result.hasAudio).toBe(true);
    expect(result.videoCodec).toBe('h264');
    expect(result.audioCodec).toBe('aac');
    expect(result.width).toBe(16);
    expect(result.height).toBe(16);
    expect(result.durationSec).toBeGreaterThan(0);
  });

  it('caches by path+mtime', async () => {
    clearProbeCacheForTests();
    const first = await probeMedia(wavPath);
    const second = await probeMedia(wavPath);
    expect(second).toBe(first); // same object reference -> served from cache
  });

  it('throws a structured ConversionError on corrupt input', async () => {
    const badPath = path.join(dir, 'bad.mp4');
    await writeFile(badPath, Buffer.from('not a real media file'));
    await expect(probeMedia(badPath)).rejects.toMatchObject({ code: 'E_CORRUPT_INPUT' });
  });
});
