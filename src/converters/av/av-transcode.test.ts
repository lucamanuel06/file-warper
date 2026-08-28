import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { avTranscode, buildFfmpegArgs } from './av-transcode';
import { resolveFfmpegPath, resolveFfprobePath } from './binary';
import type { ProbeResult } from './ffprobe';
import { probeMedia } from './ffprobe';
import { ffmpegLavfiVideoWithAudio, pcmWav } from './fixtures';
import { cleanupDir, fakeContext, fakeInput, makeTempDir } from './test-helpers';

function fakeProbe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    format: {},
    streams: [],
    durationSec: 1,
    hasVideo: false,
    hasAudio: false,
    ...overrides,
  };
}

const AUDIO_PROBE = fakeProbe({
  hasAudio: true,
  audioCodec: 'pcm_s16le',
  streams: [
    { index: 0, codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '44100' },
  ],
});

const VIDEO_PROBE = fakeProbe({
  hasVideo: true,
  hasAudio: true,
  videoCodec: 'h264',
  audioCodec: 'aac',
  width: 1920,
  height: 1080,
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '44100' },
  ],
});

const HIGH_RATE_AUDIO_PROBE = fakeProbe({
  hasAudio: true,
  audioCodec: 'pcm_s16le',
  streams: [
    { index: 0, codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '96000' },
  ],
});

describe('supports()', () => {
  it('rejects audio -> video', () => {
    expect(avTranscode.supports?.('wav', 'mp4')).toBe(false);
    expect(avTranscode.supports?.('mp3', 'webm')).toBe(false);
  });

  it('rejects audio -> gif/png', () => {
    expect(avTranscode.supports?.('wav', 'gif')).toBe(false);
    expect(avTranscode.supports?.('mp3', 'png')).toBe(false);
  });

  it('allows audio -> audio', () => {
    expect(avTranscode.supports?.('wav', 'mp3')).toBe(true);
    expect(avTranscode.supports?.('flac', 'aac')).toBe(true);
  });

  it('allows video -> video, video -> audio, video -> gif/png', () => {
    expect(avTranscode.supports?.('mp4', 'webm')).toBe(true);
    expect(avTranscode.supports?.('mp4', 'mp3')).toBe(true);
    expect(avTranscode.supports?.('mp4', 'gif')).toBe(true);
    expect(avTranscode.supports?.('mp4', 'png')).toBe(true);
  });

  it('never declares amr/spx as write targets (no encoder in this ffmpeg build)', () => {
    expect(avTranscode.outputs).not.toContain('amr');
    expect(avTranscode.outputs).not.toContain('spx');
    expect(avTranscode.inputs).toContain('amr');
    expect(avTranscode.inputs).toContain('spx');
  });
});

describe('cost()', () => {
  it('is lossless-cheap for the remux family', () => {
    expect(avTranscode.cost('mp4', 'mov')).toEqual({ retention: 1.0, effort: 1 });
    expect(avTranscode.cost('aac', 'm4a')).toEqual({ retention: 1.0, effort: 1 });
  });

  it('is lossless for lossless-target audio formats', () => {
    expect(avTranscode.cost('mp3', 'flac').retention).toBe(1.0);
    expect(avTranscode.cost('mp3', 'wav').retention).toBe(1.0);
  });

  it('is lossy for lossy targets', () => {
    expect(avTranscode.cost('wav', 'mp3').retention).toBeLessThan(1.0);
    expect(avTranscode.cost('mkv', 'webm').retention).toBeLessThan(1.0);
  });
});

describe('buildFfmpegArgs (pure, snapshot)', () => {
  it('remux: mp4 -> mov produces -c copy', () => {
    const result = buildFfmpegArgs(
      { path: '/in.mp4', format: 'mp4' },
      { path: '/out.mov', format: 'mov' },
      {},
      VIDEO_PROBE,
    );
    expect(result.isRemux).toBe(true);
    expect(result.args).toContain('-c');
    expect(result.args).toContain('copy');
    expect(result.args).not.toContain('-c:v');
    expect(result.args).toMatchSnapshot();
  });

  it('remux family but incompatible codec falls back to transcode', () => {
    const vp9Probe = fakeProbe({ hasVideo: true, videoCodec: 'vp9', hasAudio: false });
    const result = buildFfmpegArgs(
      { path: '/in.mp4', format: 'mp4' },
      { path: '/out.mov', format: 'mov' },
      {},
      vp9Probe,
    );
    expect(result.isRemux).toBe(false);
    expect(result.args).toContain('-c:v');
    expect(result.args).toContain('libx264');
  });

  it('mp4 -> webm (vp9 + opus)', () => {
    const result = buildFfmpegArgs(
      { path: '/in.mp4', format: 'mp4' },
      { path: '/out.webm', format: 'webm' },
      { quality: 'balanced' },
      VIDEO_PROBE,
    );
    expect(result.args).toMatchSnapshot();
  });

  it('mp4 -> ogv (theora + vorbis)', () => {
    const result = buildFfmpegArgs(
      { path: '/in.mp4', format: 'mp4' },
      { path: '/out.ogv', format: 'ogv' },
      { quality: 'best' },
      VIDEO_PROBE,
    );
    expect(result.args).toMatchSnapshot();
  });

  it('mp4 -> mpg uses mp2 audio (mpeg-ps cannot hold aac)', () => {
    const result = buildFfmpegArgs(
      { path: '/in.mp4', format: 'mp4' },
      { path: '/out.mpg', format: 'mpeg' },
      {},
      VIDEO_PROBE,
    );
    expect(result.args).toContain('mp2');
    expect(result.args).not.toContain('aac');
  });

  it('mp4 -> y4m drops audio and uses no encoder flags', () => {
    const result = buildFfmpegArgs(
      { path: '/in.mp4', format: 'mp4' },
      { path: '/out.y4m', format: 'y4m' },
      {},
      VIDEO_PROBE,
    );
    expect(result.args).toContain('-an');
    expect(result.args).toMatchSnapshot();
  });

  it('mp4 -> gif builds a single-pass palettegen/paletteuse filter', () => {
    const result = buildFfmpegArgs(
      { path: '/in.mp4', format: 'mp4' },
      { path: '/out.gif', format: 'gif' },
      {},
      VIDEO_PROBE,
    );
    expect(result.args).toContain('-filter_complex');
    const filterIdx = result.args.indexOf('-filter_complex');
    expect(result.args[filterIdx + 1]).toContain('fps=12');
    expect(result.args[filterIdx + 1]).toContain('scale=480');
    expect(result.args).toMatchSnapshot();
  });

  it('mp4 -> png extracts a single frame', () => {
    const result = buildFfmpegArgs(
      { path: '/in.mp4', format: 'mp4' },
      { path: '/out.png', format: 'png' },
      {},
      VIDEO_PROBE,
    );
    // `-f image2` is not optional: the scheduler stages output under a name it
    // chooses, so the muxer must never be inferred from the path.
    expect(result.args).toEqual([
      '-i',
      '/in.mp4',
      '-frames:v',
      '1',
      '-f',
      'image2',
      '/out.png',
    ]);
  });

  it('resolution=720p never upscales a smaller source', () => {
    const smallProbe = fakeProbe({
      hasVideo: true,
      hasAudio: false,
      width: 320,
      height: 240,
    });
    const result = buildFfmpegArgs(
      { path: '/in.mp4', format: 'mp4' },
      { path: '/out.mp4', format: 'mp4' },
      { resolution: '720p' },
      smallProbe,
    );
    const vfIdx = result.args.indexOf('-vf');
    expect(vfIdx).toBeGreaterThan(-1);
    expect(result.args[vfIdx + 1]).toBe('scale=-2:min(ih\\,720)');
  });

  it('resolution=original adds no scale filter', () => {
    const result = buildFfmpegArgs(
      { path: '/in.mp4', format: 'mp4' },
      { path: '/out.webm', format: 'webm' },
      { resolution: 'original' },
      VIDEO_PROBE,
    );
    expect(result.args).not.toContain('-vf');
  });

  it('wav -> mp3 uses libmp3lame VBR tiers', () => {
    const smaller = buildFfmpegArgs(
      { path: '/in.wav', format: 'wav' },
      { path: '/out.mp3', format: 'mp3' },
      { quality: 'smaller' },
      AUDIO_PROBE,
    );
    expect(smaller.args).toEqual(
      expect.arrayContaining(['-c:a', 'libmp3lame', '-q:a', '5']),
    );

    const best = buildFfmpegArgs(
      { path: '/in.wav', format: 'wav' },
      { path: '/out.mp3', format: 'mp3' },
      { quality: 'best' },
      AUDIO_PROBE,
    );
    expect(best.args).toEqual(
      expect.arrayContaining(['-c:a', 'libmp3lame', '-q:a', '0']),
    );
  });

  it('channels=mono adds -ac 1', () => {
    const result = buildFfmpegArgs(
      { path: '/in.wav', format: 'wav' },
      { path: '/out.mp3', format: 'mp3' },
      { channels: 'mono' },
      AUDIO_PROBE,
    );
    expect(result.args).toEqual(expect.arrayContaining(['-ac', '1']));
  });

  it('never clamps the sample rate for a lossless target', () => {
    for (const format of ['flac', 'wav', 'aiff', 'au', 'caf', 'mka'] as const) {
      const result = buildFfmpegArgs(
        { path: '/in.wav', format: 'wav' },
        { path: `/out.${format}`, format },
        {},
        HIGH_RATE_AUDIO_PROBE,
      );
      expect(result.args).not.toContain('-ar');
    }
  });

  it('clamps sample rate to 48kHz for a lossy target above it', () => {
    const result = buildFfmpegArgs(
      { path: '/in.wav', format: 'wav' },
      { path: '/out.mp3', format: 'mp3' },
      {},
      HIGH_RATE_AUDIO_PROBE,
    );
    expect(result.args).toEqual(expect.arrayContaining(['-ar', '48000']));
  });

  it('keeps 24-bit depth into wav/aiff instead of truncating to 16', () => {
    const probe24 = fakeProbe({
      hasAudio: true,
      audioCodec: 'pcm_s24le',
      streams: [
        {
          index: 0,
          codec_type: 'audio',
          codec_name: 'pcm_s24le',
          sample_rate: '96000',
          sample_fmt: 's32',
          bits_per_raw_sample: '24',
        },
      ],
    });
    const wav = buildFfmpegArgs(
      { path: '/in.flac', format: 'flac' },
      { path: '/out.wav', format: 'wav' },
      {},
      probe24,
    );
    expect(wav.args).toEqual(expect.arrayContaining(['-c:a', 'pcm_s24le']));
    const aiff = buildFfmpegArgs(
      { path: '/in.flac', format: 'flac' },
      { path: '/out.aiff', format: 'aiff' },
      {},
      probe24,
    );
    expect(aiff.args).toEqual(expect.arrayContaining(['-c:a', 'pcm_s24be']));
    const flac = buildFfmpegArgs(
      { path: '/in.wav', format: 'wav' },
      { path: '/out.flac', format: 'flac' },
      {},
      probe24,
    );
    expect(flac.args).toEqual(expect.arrayContaining(['-sample_fmt', 's32']));
  });

  it('stays 16-bit when the source is 16-bit', () => {
    const wav = buildFfmpegArgs(
      { path: '/in.flac', format: 'flac' },
      { path: '/out.wav', format: 'wav' },
      {},
      fakeProbe({
        hasAudio: true,
        audioCodec: 'flac',
        streams: [
          {
            index: 0,
            codec_type: 'audio',
            codec_name: 'flac',
            sample_rate: '44100',
            sample_fmt: 's16',
          },
        ],
      }),
    );
    expect(wav.args).toEqual(expect.arrayContaining(['-c:a', 'pcm_s16le']));
  });

  it('ac3 uses the ac3 bitrate ladder, not the aac one', () => {
    const result = buildFfmpegArgs(
      { path: '/in.wav', format: 'wav' },
      { path: '/out.ac3', format: 'ac3' },
      { quality: 'best' },
      AUDIO_PROBE,
    );
    expect(result.args).toEqual(expect.arrayContaining(['-b:a', '640k']));
  });

  it('does not force a sample rate when the source is already <= 48kHz', () => {
    const result = buildFfmpegArgs(
      { path: '/in.wav', format: 'wav' },
      { path: '/out.flac', format: 'flac' },
      {},
      AUDIO_PROBE,
    );
    expect(result.args).not.toContain('-ar');
  });
});

describe('availability()', () => {
  it('never throws and reports the real bundled binaries as available', async () => {
    const result = await avTranscode.availability();
    expect(result.available).toBe(true);
  });
});

describe('convert() integration', () => {
  let dir: string;
  let wavPath: string;
  let videoPath: string;
  let ffprobeBin: string;

  beforeAll(async () => {
    dir = await makeTempDir('av-transcode-');
    wavPath = path.join(dir, 'tone.wav');
    await writeFile(wavPath, pcmWav(440, 0.2, 44100));
    videoPath = path.join(dir, 'clip.mp4');
    await ffmpegLavfiVideoWithAudio(videoPath);
    ffprobeBin = (await resolveFfprobePath()) as string;
  }, 20_000);

  afterAll(async () => {
    await cleanupDir(dir);
  });

  async function probeOut(outPath: string) {
    const { stdout } = await execa(ffprobeBin, [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      outPath,
    ]);
    return JSON.parse(stdout) as {
      format: { format_name?: string };
      streams: Array<{ codec_type?: string; codec_name?: string }>;
    };
  }

  it('wav -> mp3', async () => {
    const input = await fakeInput(wavPath, 'wav');
    const outPath = path.join(dir, 'out.mp3');
    const result = await avTranscode.convert(
      input,
      { path: outPath, format: 'mp3' },
      { quality: 'balanced' },
      fakeContext(dir),
    );
    expect(result.bytes).toBeGreaterThan(0);
    const probed = await probeOut(outPath);
    expect(probed.streams[0]?.codec_name).toBe('mp3');
  });

  it('wav -> flac (lossless)', async () => {
    const input = await fakeInput(wavPath, 'wav');
    const outPath = path.join(dir, 'out.flac');
    await avTranscode.convert(
      input,
      { path: outPath, format: 'flac' },
      {},
      fakeContext(dir),
    );
    const probed = await probeOut(outPath);
    expect(probed.streams[0]?.codec_name).toBe('flac');
  });

  it('mp4 -> webm (vp9 + opus)', async () => {
    const input = await fakeInput(videoPath, 'mp4');
    const outPath = path.join(dir, 'out.webm');
    const result = await avTranscode.convert(
      input,
      { path: outPath, format: 'webm' },
      {},
      fakeContext(dir),
    );
    expect(result.bytes).toBeGreaterThan(0);
    const probed = await probeOut(outPath);
    const video = probed.streams.find((s) => s.codec_type === 'video');
    const audio = probed.streams.find((s) => s.codec_type === 'audio');
    expect(video?.codec_name).toBe('vp9');
    expect(audio?.codec_name).toBe('opus');
  }, 15_000);

  it('mp4 -> mov uses the remux fast path (-c copy)', async () => {
    const input = await fakeInput(videoPath, 'mp4');
    const outPath = path.join(dir, 'out.mov');
    const result = await avTranscode.convert(
      input,
      { path: outPath, format: 'mov' },
      {},
      fakeContext(dir),
    );
    expect(result.warnings).toContain(
      'Remuxed without re-encoding (container change only).',
    );
    const probed = await probeOut(outPath);
    const video = probed.streams.find((s) => s.codec_type === 'video');
    expect(video?.codec_name).toBe('h264'); // unchanged codec, just a new container
  });

  it('mp4 -> mp3 extracts the audio track', async () => {
    const input = await fakeInput(videoPath, 'mp4');
    const outPath = path.join(dir, 'extracted.mp3');
    await avTranscode.convert(
      input,
      { path: outPath, format: 'mp3' },
      {},
      fakeContext(dir),
    );
    const probed = await probeOut(outPath);
    expect(probed.streams).toHaveLength(1);
    expect(probed.streams[0]?.codec_type).toBe('audio');
  });

  it('mp4 -> gif produces an animated palette-optimized gif', async () => {
    const input = await fakeInput(videoPath, 'mp4');
    const outPath = path.join(dir, 'out.gif');
    const result = await avTranscode.convert(
      input,
      { path: outPath, format: 'gif' },
      {},
      fakeContext(dir),
    );
    expect(result.bytes).toBeGreaterThan(0);
    const bytes = await import('node:fs/promises').then((m) => m.readFile(outPath));
    expect(bytes.subarray(0, 6).toString('ascii')).toBe('GIF89a');
  }, 15_000);

  it('mp4 -> png extracts a poster frame', async () => {
    const input = await fakeInput(videoPath, 'mp4');
    const outPath = path.join(dir, 'poster.png');
    const result = await avTranscode.convert(
      input,
      { path: outPath, format: 'png' },
      {},
      fakeContext(dir),
    );
    expect(result.bytes).toBeGreaterThan(0);
    const bytes = await import('node:fs/promises').then((m) => m.readFile(outPath));
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('mp4 -> y4m produces raw yuv4mpeg2 output (not h264-encoded)', async () => {
    const input = await fakeInput(videoPath, 'mp4');
    const outPath = path.join(dir, 'out.y4m');
    const result = await avTranscode.convert(
      input,
      { path: outPath, format: 'y4m' },
      {},
      fakeContext(dir),
    );
    expect(result.bytes).toBeGreaterThan(0);
    const bytes = await import('node:fs/promises').then((m) => m.readFile(outPath));
    expect(bytes.subarray(0, 9).toString('ascii')).toBe('YUV4MPEG2');
  });

  it('probes real media through the pure-argv path identically to buildFfmpegArgs', async () => {
    const probe = await probeMedia(videoPath);
    const built = buildFfmpegArgs(
      { path: videoPath, format: 'mp4' },
      { path: path.join(dir, 'x.webm'), format: 'webm' },
      {},
      probe,
    );
    expect(built.args).toContain('libvpx-vp9');
  });

  it('cancellation kills the child and leaves no output file', async () => {
    // A big, slow-to-transcode source, so the abort reliably lands mid-encode
    // rather than racing a conversion that finishes before it fires.
    const bigPath = path.join(dir, 'big.mp4');
    const ffmpegBin = (await resolveFfmpegPath()) as string;
    await execa(ffmpegBin, [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=640x480:rate=30:duration=20',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      bigPath,
    ]);

    const input = await fakeInput(bigPath, 'mp4');
    const outPath = path.join(dir, 'cancelled.webm');
    const controller = new AbortController();
    const ctx = fakeContext(dir, controller.signal);

    const run = avTranscode.convert(
      input,
      { path: outPath, format: 'webm' },
      { quality: 'best' },
      ctx,
    );
    setTimeout(() => controller.abort(), 150);

    await expect(run).rejects.toMatchObject({ code: 'E_CANCELLED' });
    expect(existsSync(outPath)).toBe(false);
  }, 15_000);
});
