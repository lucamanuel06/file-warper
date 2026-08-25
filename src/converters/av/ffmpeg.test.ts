import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runFfmpeg } from './ffmpeg';
import { ffmpegLavfiVideoWithAudio } from './fixtures';
import { cleanupDir, fakeContext, makeTempDir } from './test-helpers';

let dir: string;
let videoPath: string;

beforeAll(async () => {
  dir = await makeTempDir('ffmpeg-');
  videoPath = path.join(dir, 'src.mp4');
  await ffmpegLavfiVideoWithAudio(videoPath);
}, 20_000);

afterAll(async () => {
  await cleanupDir(dir);
});

describe('runFfmpeg', () => {
  it('runs a real conversion and produces the output file', async () => {
    const outPath = path.join(dir, 'out.mp3');
    await runFfmpeg(
      ['-i', videoPath, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', outPath],
      fakeContext(dir),
    );
    expect(existsSync(outPath)).toBe(true);
  });

  it('reports real determinate progress via -progress pipe:1', async () => {
    const outPath = path.join(dir, 'out-progress.mp3');
    const ratios: number[] = [];
    const ctx = fakeContext(dir);
    await runFfmpeg(
      ['-i', videoPath, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', outPath],
      {
        ...ctx,
        onProgress: (e) => ratios.push(e.ratio),
      },
    );
    expect(ratios.length).toBeGreaterThan(0);
    expect(ratios[ratios.length - 1]).toBe(1);
    expect(ratios.every((r) => r === -1 || (r >= 0 && r <= 1))).toBe(true);
  });

  it('surfaces the last stderr lines as `detail` on failure', async () => {
    const outPath = path.join(dir, 'bad-out.mp4');
    await expect(
      runFfmpeg(
        ['-i', videoPath, '-c:v', 'this-codec-does-not-exist', outPath],
        fakeContext(dir),
      ),
    ).rejects.toMatchObject({ code: 'E_ENGINE' });
  });

  it('cancellation kills the child and leaves no output file', async () => {
    const outPath = path.join(dir, 'cancelled.mp4');
    const controller = new AbortController();
    const ctx = fakeContext(dir, controller.signal);

    const run = runFfmpeg(
      [
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=640x480:rate=30:duration=30',
        '-pix_fmt',
        'yuv420p',
        '-c:v',
        'libx264',
        outPath,
      ],
      ctx,
      { outputPath: outPath },
    );

    setTimeout(() => controller.abort(), 150);

    await expect(run).rejects.toMatchObject({ code: 'E_CANCELLED' });
    expect(existsSync(outPath)).toBe(false);
  });
});
