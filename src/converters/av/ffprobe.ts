import { stat } from 'node:fs/promises';
import { ConversionError } from '@core/types';
import { execa } from 'execa';
import { resolveFfprobePath } from './binary';

export interface ProbeStream {
  readonly index: number;
  readonly codec_type?: string;
  readonly codec_name?: string;
  readonly width?: number;
  readonly height?: number;
  readonly sample_rate?: string;
  readonly sample_fmt?: string;
  readonly bits_per_raw_sample?: string;
  readonly channels?: number;
  readonly duration?: string;
  readonly tags?: Record<string, string>;
}

export interface ProbeFormat {
  readonly format_name?: string;
  readonly duration?: string;
  readonly tags?: Record<string, string>;
}

export interface ProbeResult {
  readonly format: ProbeFormat;
  readonly streams: readonly ProbeStream[];
  readonly durationSec: number;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
  readonly width?: number;
  readonly height?: number;
  readonly videoCodec?: string;
  readonly audioCodec?: string;
}

interface CacheEntry {
  readonly mtimeMs: number;
  readonly result: ProbeResult;
}

const cache = new Map<string, CacheEntry>();

export async function probeMedia(filePath: string): Promise<ProbeResult> {
  const st = await stat(filePath);
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.result;

  const bin = await resolveFfprobePath();
  if (!bin) {
    throw new ConversionError({
      code: 'E_UNAVAILABLE',
      userMessage:
        'The bundled media inspector (ffprobe) is missing. Reinstall File Warper.',
    });
  }

  const { stdout, exitCode, stderr } = await execa(
    bin,
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { reject: false },
  );

  if (exitCode !== 0) {
    throw new ConversionError({
      code: 'E_CORRUPT_INPUT',
      userMessage:
        'This file could not be inspected — it may be corrupt or an unsupported variant.',
      detail: stderr,
    });
  }

  const parsed = JSON.parse(stdout) as { format?: ProbeFormat; streams?: ProbeStream[] };
  const streams = parsed.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const durationSec =
    Number(
      parsed.format?.duration ?? videoStream?.duration ?? audioStream?.duration ?? 0,
    ) || 0;

  const result: ProbeResult = {
    format: parsed.format ?? {},
    streams,
    durationSec,
    hasVideo: !!videoStream,
    hasAudio: !!audioStream,
    width: videoStream?.width,
    height: videoStream?.height,
    videoCodec: videoStream?.codec_name,
    audioCodec: audioStream?.codec_name,
  };

  cache.set(filePath, { mtimeMs: st.mtimeMs, result });
  return result;
}

export function clearProbeCacheForTests(): void {
  cache.clear();
}
