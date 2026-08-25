import { writeFile } from 'node:fs/promises';
import type {
  ConversionInput,
  ConversionOutput,
  ConvertContext,
  Converter,
  ConverterOptions,
  ConvertResult,
  EdgeCost,
  FormatId,
} from '@core/types';
import { ConversionError } from '@core/types';
import { parseAss, serializeAss } from './ass';
import type { Cue } from './cue';
import { parseSbv, serializeSbv } from './sbv';
import { parseSrt, serializeSrt } from './srt';
import { parseTtml, serializeTtml } from './ttml';
import { parseVtt, serializeVtt } from './vtt';

export type { Cue } from './cue';

const SUBTITLE_FORMATS: readonly FormatId[] = ['srt', 'vtt', 'ass', 'ttml', 'sbv'];

type Parser = (source: string) => Cue[];
type Serializer = (cues: readonly Cue[]) => string;

const PARSERS: Record<string, Parser> = {
  srt: parseSrt,
  vtt: parseVtt,
  sbv: parseSbv,
  ass: parseAss,
  ttml: parseTtml,
};

const SERIALIZERS: Record<string, Serializer> = {
  srt: serializeSrt,
  vtt: serializeVtt,
  sbv: serializeSbv,
  ass: serializeAss,
  ttml: serializeTtml,
};

function isSubtitleFormat(format: FormatId): boolean {
  return format in PARSERS;
}

/**
 * `ass` is the only format in this set that carries per-cue styling (the
 * `style` field plus inline `{...}` override tags). srt/vtt/sbv/ttml can only
 * hold plain timed text, so a hop *out of* `ass` into any of them is lossy —
 * we only keep the cue text, not the formatting. A hop *into* `ass` from a
 * plain-text format is lossless (there's simply no styling to add).
 */
function costFor(from: FormatId, to: FormatId): EdgeCost {
  if (from === 'ass' && to !== 'ass') {
    return { retention: 0.85, effort: 1, structure: 0.6 };
  }
  return { retention: 1, effort: 1, structure: 1 };
}

export const subtitleConverters: Converter[] = [
  {
    id: 'subtitle:cues',
    name: 'Subtitle Converter',
    engine: 'pure-js',
    residency: 'worker',
    inputs: SUBTITLE_FORMATS,
    outputs: SUBTITLE_FORMATS,

    supports(from: FormatId, to: FormatId): boolean {
      return from !== to && isSubtitleFormat(from) && isSubtitleFormat(to);
    },

    cost(from: FormatId, to: FormatId): EdgeCost {
      return costFor(from, to);
    },

    async availability() {
      // Pure JS, no external binary, no runtime dependency — always available.
      return { available: true };
    },

    async convert(
      input: ConversionInput,
      output: ConversionOutput,
      _options: ConverterOptions,
      ctx: ConvertContext,
    ): Promise<ConvertResult> {
      const parser = PARSERS[input.format];
      const serializer = SERIALIZERS[output.format];

      if (!parser) {
        throw new ConversionError({
          code: 'E_UNSUPPORTED_FEATURE',
          userMessage: `"${input.format}" is not a subtitle format this converter understands.`,
          retryable: false,
        });
      }
      if (!serializer) {
        throw new ConversionError({
          code: 'E_UNSUPPORTED_FEATURE',
          userMessage: `"${output.format}" is not a subtitle format this converter can write.`,
          retryable: false,
        });
      }

      ctx.onProgress({ ratio: 0, message: 'Reading subtitles' });

      let source: string;
      try {
        source = (await input.readBuffer()).toString('utf8');
      } catch (cause) {
        throw new ConversionError({
          code: 'E_CORRUPT_INPUT',
          userMessage: `Could not read the subtitle file "${input.path}".`,
          detail: cause instanceof Error ? cause.message : String(cause),
          retryable: false,
          cause,
        });
      }

      if (ctx.signal.aborted) {
        throw new ConversionError({
          code: 'E_CANCELLED',
          userMessage: 'The conversion was cancelled.',
          retryable: false,
        });
      }

      let cues: Cue[];
      try {
        cues = parser(source);
      } catch (cause) {
        throw new ConversionError({
          code: 'E_CORRUPT_INPUT',
          userMessage: `This ${input.format.toUpperCase()} file could not be parsed.`,
          detail: cause instanceof Error ? cause.message : String(cause),
          retryable: false,
          cause,
        });
      }

      if (cues.length === 0) {
        throw new ConversionError({
          code: 'E_CORRUPT_INPUT',
          userMessage: `No subtitle cues were found in "${input.path}".`,
          retryable: false,
        });
      }

      ctx.onProgress({ ratio: 0.5, message: 'Converting cues' });

      const warnings: string[] = [];
      if (input.format === 'ass' && output.format !== 'ass') {
        warnings.push('Dropped subtitle styling.');
      }

      const serialized = serializer(cues);

      try {
        await writeFile(output.path, serialized, 'utf8');
      } catch (cause) {
        throw new ConversionError({
          code: 'E_PERMISSION',
          userMessage: `Could not write the converted subtitle file to "${output.path}".`,
          detail: cause instanceof Error ? cause.message : String(cause),
          retryable: true,
          cause,
        });
      }

      ctx.onProgress({ ratio: 1, message: 'Done' });

      return {
        bytes: Buffer.byteLength(serialized, 'utf8'),
        warnings: warnings.length > 0 ? warnings : undefined,
        meta: { cueCount: cues.length },
      };
    },
  },
];
