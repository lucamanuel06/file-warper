import { execa } from 'execa';
import { resolveFfmpegPath } from './binary';

/** A ~44-byte-header, tiny 50ms 440Hz PCM WAV — hand-built, zero dependencies. */
export function pcmWav(freqHz: number, durationSec: number, sampleRate = 8000): Buffer {
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.round(Math.sin(2 * Math.PI * freqHz * t) * 0.5 * 32767);
    buf.writeInt16LE(sample, 44 + i * 2);
  }

  return buf;
}

async function runFfmpegToBuffer(
  inputArgs: string[],
  outputExtraArgs: string[],
  outPath: string,
): Promise<void> {
  const bin = await resolveFfmpegPath();
  if (!bin) throw new Error('ffmpeg not available for fixture generation');
  await execa(bin, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    ...inputArgs,
    ...outputExtraArgs,
    outPath,
  ]);
}

/** Derives an audio fixture in `format` from a hand-built wav via ffmpeg. */
export async function ffmpegAudioFrom(
  wavPath: string,
  outPath: string,
  extraArgs: string[] = [],
): Promise<void> {
  await runFfmpegToBuffer(['-i', wavPath], extraArgs, outPath);
}

/** 16x16, video-only test clip — smallest thing every video codec accepts. */
export async function ffmpegLavfiVideo(
  outPath: string,
  extraArgs: string[] = [],
): Promise<void> {
  await runFfmpegToBuffer(
    ['-f', 'lavfi', '-i', 'testsrc=size=16x16:rate=3:duration=0.3'],
    extraArgs,
    outPath,
  );
}

/**
 * 16x16 video + a 440Hz tone, both clamped to the same duration via `-t`
 * (not `-shortest`, which can silently drop every video frame when the
 * audio track is shorter than one frame interval at a low fps).
 */
export async function ffmpegLavfiVideoWithAudio(
  outPath: string,
  extraArgs: string[] = [],
): Promise<void> {
  const bin = await resolveFfmpegPath();
  if (!bin) throw new Error('ffmpeg not available for fixture generation');
  await execa(bin, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=16x16:rate=3:duration=0.5',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=0.5',
    '-t',
    '0.5',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    ...extraArgs,
    outPath,
  ]);
}
