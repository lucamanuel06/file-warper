import { stat } from 'node:fs/promises';
import { getFormat } from '@core/formats';
import type { Converter, FormatId } from '@core/types';
import { checkExecutable, resolveFfmpegPath, resolveFfprobePath } from './binary';
import { runFfmpeg } from './ffmpeg';
import { type ProbeResult, probeMedia } from './ffprobe';

// Every non-readOnly audio/video FormatId in @core/formats.ts. `wma`/`wmv`
// are readOnly there, so they're readable inputs but never write targets.
const AUDIO_IN = [
  'mp3',
  'wav',
  'flac',
  'aac',
  'm4a',
  'ogg',
  'opus',
  'spx',
  'aiff',
  'wma',
  'amr',
  'ac3',
  'caf',
  'au',
  'mka',
] as const;
// `amr` and `spx` are decode-only: this ffmpeg-static build has no AMR or
// Speex encoder compiled in (`ffmpeg -encoders` confirms neither exists).
const AUDIO_OUT = [
  'mp3',
  'wav',
  'flac',
  'aac',
  'm4a',
  'ogg',
  'opus',
  'aiff',
  'ac3',
  'caf',
  'au',
  'mka',
] as const;
const VIDEO_IN = [
  'mp4',
  'mov',
  'mkv',
  'webm',
  'avi',
  'm4v',
  '3gp',
  'flv',
  'wmv',
  'mpeg',
  'ts',
  'ogv',
  'y4m',
] as const;
const VIDEO_OUT = [
  'mp4',
  'mov',
  'mkv',
  'webm',
  'avi',
  'm4v',
  '3gp',
  'flv',
  'mpeg',
  'ts',
  'ogv',
  'y4m',
] as const;
const FRAME_OUT = ['gif', 'png'] as const;

const INPUTS: readonly FormatId[] = [...AUDIO_IN, ...VIDEO_IN];
const OUTPUTS: readonly FormatId[] = [...AUDIO_OUT, ...VIDEO_OUT, ...FRAME_OUT];

const AUDIO_IN_SET = new Set<FormatId>(AUDIO_IN);
const VIDEO_IN_SET = new Set<FormatId>(VIDEO_IN);
const AUDIO_OUT_SET = new Set<FormatId>(AUDIO_OUT);
const VIDEO_OUT_SET = new Set<FormatId>(VIDEO_OUT);

// Containers whose codecs are close enough that a container-only change is a
// plain remux, verified at runtime against the actual probed codec.
const ISOBMFF_REMUX_FAMILY = new Set(['mp4', 'mov', 'm4v', '3gp', 'ts']);
const AAC_REMUX_FAMILY = new Set(['aac', 'm4a']);
const MOVFLAGS_TARGETS = new Set(['mp4', 'mov', 'm4v']);

type Quality = 'smaller' | 'balanced' | 'best';

const VIDEO_CRF: Record<Quality, string> = { smaller: '28', balanced: '23', best: '18' };
const MP3_VBR: Record<Quality, string> = { smaller: '5', balanced: '2', best: '0' };
const AAC_BITRATE: Record<Quality, string> = {
  smaller: '96k',
  balanced: '160k',
  best: '256k',
};
const OPUS_BITRATE: Record<Quality, string> = {
  smaller: '64k',
  balanced: '128k',
  best: '192k',
};
const VORBIS_QSCALE: Record<Quality, string> = { smaller: '3', balanced: '6', best: '9' };
const THEORA_QSCALE: Record<Quality, string> = { smaller: '4', balanced: '6', best: '8' };
const MAX_SAMPLE_RATE = 48_000;

const RESOLUTION_HEIGHT: Record<string, number | undefined> = {
  original: undefined,
  '1080p': 1080,
  '720p': 720,
  '480p': 480,
};

function qualityOf(options: Record<string, unknown>): Quality {
  const q = options.quality;
  return q === 'smaller' || q === 'balanced' || q === 'best' ? q : 'balanced';
}

function isRemuxFamily(from: FormatId, to: FormatId): boolean {
  return (
    (ISOBMFF_REMUX_FAMILY.has(from) && ISOBMFF_REMUX_FAMILY.has(to)) ||
    (AAC_REMUX_FAMILY.has(from) && AAC_REMUX_FAMILY.has(to))
  );
}

function isRemuxCandidate(from: FormatId, to: FormatId, probe: ProbeResult): boolean {
  if (!isRemuxFamily(from, to)) return false;
  if (ISOBMFF_REMUX_FAMILY.has(from) && ISOBMFF_REMUX_FAMILY.has(to)) {
    const videoOk =
      !probe.hasVideo || probe.videoCodec === 'h264' || probe.videoCodec === 'hevc';
    const audioOk = !probe.hasAudio || probe.audioCodec === 'aac';
    return videoOk && audioOk;
  }
  return probe.audioCodec === 'aac';
}

function audioEncodeArgs(to: FormatId, quality: Quality): string[] {
  switch (to) {
    case 'mp3':
      return ['-c:a', 'libmp3lame', '-q:a', MP3_VBR[quality]];
    case 'aac':
    case 'm4a':
      return ['-c:a', 'aac', '-b:a', AAC_BITRATE[quality]];
    case 'opus':
      return ['-c:a', 'libopus', '-b:a', OPUS_BITRATE[quality]];
    case 'ogg':
      return ['-c:a', 'libvorbis', '-q:a', VORBIS_QSCALE[quality]];
    case 'flac':
      return ['-c:a', 'flac'];
    case 'wav':
      return ['-c:a', 'pcm_s16le'];
    case 'aiff':
    case 'au':
      return ['-c:a', 'pcm_s16be'];
    case 'caf':
      return ['-c:a', 'pcm_s16le'];
    case 'ac3':
      return ['-c:a', 'ac3', '-b:a', AAC_BITRATE[quality]];
    case 'mka':
      return ['-c:a', 'flac'];
    default:
      return ['-c:a', 'aac', '-b:a', AAC_BITRATE[quality]];
  }
}

/** Audio codec paired with a *video* container target; mpeg-ps can't hold aac. */
function videoAudioTrackArgs(to: FormatId, quality: Quality): string[] {
  switch (to) {
    case 'webm':
      return ['-c:a', 'libopus', '-b:a', OPUS_BITRATE[quality]];
    case 'ogv':
      return ['-c:a', 'libvorbis', '-q:a', VORBIS_QSCALE[quality]];
    case 'mpeg':
      return ['-c:a', 'mp2', '-b:a', '192k'];
    default:
      return ['-c:a', 'aac', '-b:a', AAC_BITRATE[quality]];
  }
}

function videoEncodeArgs(to: FormatId, quality: Quality): string[] {
  switch (to) {
    case 'webm':
      return ['-c:v', 'libvpx-vp9', '-crf', VIDEO_CRF[quality], '-b:v', '0'];
    case 'ogv':
      return ['-c:v', 'libtheora', '-q:v', THEORA_QSCALE[quality]];
    case 'y4m':
      // Raw uncompressed video — the yuv4mpegpipe muxer rejects any codec
      // (h264 included), so this must stay pixel-format-only.
      return ['-pix_fmt', 'yuv420p'];
    default:
      return [
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        VIDEO_CRF[quality],
        '-preset',
        'medium',
      ];
  }
}

function resolutionFilter(resolution: string, hasVideo: boolean): string[] {
  if (!hasVideo) return [];
  const height = RESOLUTION_HEIGHT[resolution];
  if (!height) return [];
  return ['-vf', `scale=-2:min(ih\\,${height})`];
}

function audioRateArgs(probe: ProbeResult, channels: string): string[] {
  const args: string[] = [];
  const sampleRate = Number(
    probe.streams.find((s) => s.codec_type === 'audio')?.sample_rate ?? 0,
  );
  if (sampleRate > MAX_SAMPLE_RATE) args.push('-ar', String(MAX_SAMPLE_RATE));
  if (channels === 'mono') args.push('-ac', '1');
  return args;
}

export interface BuildArgsResult {
  readonly args: readonly string[];
  readonly isRemux: boolean;
}

/**
 * FormatId -> ffmpeg muxer name.
 *
 * ffmpeg normally infers the container from the output file extension. We must
 * NOT rely on that: the scheduler writes every final hop to a staging file
 * (`.filewarper-<rand>.<ext>`) and renames it into place only on success, and
 * any engine that guesses from the path is one naming change away from
 * "Unable to find a suitable output format". Always pass `-f` explicitly.
 *
 * Every name below is verified present in the bundled ffmpeg's `-muxers` list.
 */
const FFMPEG_MUXER: Readonly<Record<string, string>> = {
  // audio
  mp3: 'mp3',
  wav: 'wav',
  flac: 'flac',
  aac: 'adts',
  m4a: 'ipod',
  ogg: 'ogg',
  opus: 'opus',
  aiff: 'aiff',
  ac3: 'ac3',
  caf: 'caf',
  au: 'au',
  mka: 'matroska',
  // video
  mp4: 'mp4',
  mov: 'mov',
  m4v: 'mp4',
  mkv: 'matroska',
  webm: 'webm',
  avi: 'avi',
  '3gp': '3gp',
  flv: 'flv',
  mpeg: 'mpeg',
  ts: 'mpegts',
  ogv: 'ogg',
  y4m: 'yuv4mpegpipe',
  // stills
  gif: 'gif',
  png: 'image2',
};

/** Appends `-f <muxer> <path>`. Use this instead of pushing the path directly. */
function pushOutput(args: string[], output: { path: string; format: FormatId }): void {
  const muxer = FFMPEG_MUXER[output.format];
  if (muxer) args.push('-f', muxer);
  args.push(output.path);
}

/**
 * Pure argv builder — no process spawning, no filesystem access. Kept
 * separate from `convert()` so the argv logic (where the real bugs live)
 * can be snapshot-tested without mocking `execa`.
 */
export function buildFfmpegArgs(
  input: { readonly path: string; readonly format: FormatId },
  output: { readonly path: string; readonly format: FormatId },
  options: Record<string, unknown>,
  probe: ProbeResult,
): BuildArgsResult {
  const quality = qualityOf(options);
  const resolution =
    typeof options.resolution === 'string' ? options.resolution : 'original';
  const channels = typeof options.channels === 'string' ? options.channels : 'keep';

  if (isRemuxCandidate(input.format, output.format, probe)) {
    const args = ['-i', input.path, '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy'];
    if (MOVFLAGS_TARGETS.has(output.format)) args.push('-movflags', '+faststart');
    pushOutput(args, output);
    return { args, isRemux: true };
  }

  if (output.format === 'gif') {
    const args = [
      '-i',
      input.path,
      '-filter_complex',
      'fps=12,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse',
    ];
    pushOutput(args, output);
    return { args, isRemux: false };
  }

  if (output.format === 'png') {
    const args = ['-i', input.path, '-frames:v', '1'];
    pushOutput(args, output);
    return { args, isRemux: false };
  }

  const isVideoTarget = VIDEO_OUT_SET.has(output.format);
  const args = ['-i', input.path, '-map_metadata', '0'];

  if (isVideoTarget) {
    args.push(...resolutionFilter(resolution, probe.hasVideo));
    args.push(...videoEncodeArgs(output.format, quality));
    if (output.format === 'y4m') {
      args.push('-an');
    } else if (probe.hasAudio) {
      args.push(...videoAudioTrackArgs(output.format, quality));
      args.push(...audioRateArgs(probe, channels));
    } else {
      args.push('-an');
    }
    if (MOVFLAGS_TARGETS.has(output.format)) args.push('-movflags', '+faststart');
  } else {
    args.push(...audioEncodeArgs(output.format, quality));
    args.push(...audioRateArgs(probe, channels));
  }

  pushOutput(args, output);
  return { args, isRemux: false };
}

export const avTranscode: Converter = {
  id: 'ffmpeg:av-transcode',
  name: 'Audio/Video (ffmpeg)',
  engine: 'ffmpeg',
  inputs: INPUTS,
  outputs: OUTPUTS,

  supports(from, to) {
    if (AUDIO_IN_SET.has(from)) return AUDIO_OUT_SET.has(to);
    if (VIDEO_IN_SET.has(from)) return true;
    return false;
  },

  cost(from, to) {
    if (isRemuxFamily(from, to)) return { retention: 1.0, effort: 1 };
    if (to === 'gif' || to === 'png') return { retention: 0.75, effort: 5 };
    const fmt = getFormat(to);
    const lossless = fmt ? !fmt.lossy : false;
    const isVideoTarget = VIDEO_OUT_SET.has(to);
    if (lossless) return { retention: 1.0, effort: isVideoTarget ? 6 : 2 };
    return { retention: isVideoTarget ? 0.85 : 0.9, effort: isVideoTarget ? 8 : 3 };
  },

  async availability() {
    const [ffmpegPath, ffprobePath] = await Promise.all([
      resolveFfmpegPath(),
      resolveFfprobePath(),
    ]);
    const ffmpegCheck = await checkExecutable(ffmpegPath, 'ffmpeg');
    if (!ffmpegCheck.available) return ffmpegCheck;
    return checkExecutable(ffprobePath, 'ffprobe');
  },

  optionsSchema: {
    fields: [
      {
        key: 'quality',
        kind: 'segmented',
        label: 'Quality',
        choices: [
          { value: 'smaller', label: 'Smaller' },
          { value: 'balanced', label: 'Balanced' },
          { value: 'best', label: 'Best' },
        ],
        default: 'balanced',
      },
      {
        key: 'resolution',
        kind: 'select',
        label: 'Resolution',
        choices: [
          { value: 'original', label: 'Original' },
          { value: '1080p', label: '1080p' },
          { value: '720p', label: '720p' },
          { value: '480p', label: '480p' },
        ],
        default: 'original',
      },
      {
        key: 'channels',
        kind: 'select',
        label: 'Channels',
        choices: [
          { value: 'keep', label: 'Keep' },
          { value: 'mono', label: 'Mono' },
        ],
        default: 'keep',
      },
    ],
  },
  defaultOptions: { quality: 'balanced', resolution: 'original', channels: 'keep' },

  async convert(input, output, options, ctx) {
    const probe = await probeMedia(input.path);
    ctx.onProgress({ ratio: -1 });

    const { args, isRemux } = buildFfmpegArgs(input, output, options, probe);
    const durationSec = output.format === 'png' ? undefined : probe.durationSec;

    await runFfmpeg(args, ctx, { durationSec, outputPath: output.path });
    const st = await stat(output.path);
    ctx.onProgress({ ratio: 1 });

    return isRemux
      ? {
          bytes: st.size,
          warnings: ['Remuxed without re-encoding (container change only).'],
        }
      : { bytes: st.size };
  },
};
