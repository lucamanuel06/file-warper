import { rm } from 'node:fs/promises';
import type { ConvertContext } from '@core/types';
import { ConversionError } from '@core/types';
import { execa } from 'execa';
import { resolveFfmpegPath } from './binary';

const KILL_GRACE_MS = 3000;
const STDERR_TAIL_LINES = 10;

export interface RunFfmpegOptions {
  /** Known total duration of the output, for -progress based ratio math. */
  readonly durationSec?: number;
  /** Deleted (best-effort) if the run fails or is cancelled. */
  readonly outputPath?: string;
}

function parseProgressLines(
  text: string,
  durationSec: number | undefined,
  lastRatio: { value: number },
  onProgress: (ratio: number) => void,
) {
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    if (key === 'out_time_us' || key === 'out_time_ms') {
      if (!durationSec || durationSec <= 0) continue;
      const micros = Number(value);
      if (!Number.isFinite(micros)) continue;
      const ratio = Math.min(1, Math.max(0, micros / 1_000_000 / durationSec));
      if (ratio > lastRatio.value) {
        lastRatio.value = ratio;
        onProgress(ratio);
      }
    } else if (key === 'progress' && value === 'end') {
      lastRatio.value = 1;
      onProgress(1);
    }
  }
}

/** Splits a byte stream into complete lines, holding back any trailing partial line. */
function makeLineSplitter(onLines: (lines: string) => void) {
  let tail = '';
  return (chunk: Buffer) => {
    tail += chunk.toString('utf8');
    const lines = tail.split('\n');
    tail = lines.pop() ?? '';
    if (lines.length > 0) onLines(lines.join('\n'));
  };
}

export async function runFfmpeg(
  args: readonly string[],
  ctx: Pick<ConvertContext, 'signal' | 'onProgress' | 'log'>,
  opts: RunFfmpegOptions = {},
): Promise<void> {
  const bin = await resolveFfmpegPath();
  if (!bin) {
    throw new ConversionError({
      code: 'E_UNAVAILABLE',
      userMessage:
        'The bundled video/audio engine (ffmpeg) is missing. Reinstall File Warper.',
    });
  }

  const fullArgs = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostats',
    '-progress',
    'pipe:1',
    ...args,
  ];

  const subprocess = execa(bin, fullArgs, {
    cancelSignal: ctx.signal,
    forceKillAfterDelay: KILL_GRACE_MS,
    reject: false,
    stdin: 'ignore',
  });

  const lastRatio = { value: 0 };
  const onStdout = makeLineSplitter((lines) =>
    parseProgressLines(lines, opts.durationSec, lastRatio, (ratio) =>
      ctx.onProgress({ ratio }),
    ),
  );

  const stderrLines: string[] = [];
  const onStderr = makeLineSplitter((lines) => {
    for (const line of lines.split('\n')) {
      if (!line.trim()) continue;
      stderrLines.push(line);
      if (stderrLines.length > STDERR_TAIL_LINES) stderrLines.shift();
    }
  });

  subprocess.stdout?.on('data', onStdout);
  subprocess.stderr?.on('data', onStderr);

  const result = await subprocess;

  if (result.isCanceled) {
    if (opts.outputPath) await rm(opts.outputPath, { force: true });
    throw new ConversionError({
      code: 'E_CANCELLED',
      userMessage: 'Conversion was cancelled.',
    });
  }

  if (result.failed || (result.exitCode ?? 1) !== 0) {
    if (opts.outputPath) await rm(opts.outputPath, { force: true });
    throw new ConversionError({
      code: 'E_ENGINE',
      userMessage: 'ffmpeg could not convert this file.',
      detail: stderrLines.join('\n') || result.shortMessage,
    });
  }
}
