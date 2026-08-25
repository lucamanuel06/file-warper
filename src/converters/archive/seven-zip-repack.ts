/**
 * The archive<->archive edges that require the bundled `7za` binary: 7z, and
 * the bzip2/xz legs of tar.bz2/tar.xz. Also covers zip/tar/tar.gz paired
 * against any of those three (e.g. `zip -> 7z`) — the pure-JS
 * `zip-tar-repack` converter only covers pairs fully inside
 * {zip, tar, tar.gz}, so there's no overlap between the two converters'
 * edges.
 */

import fs from 'node:fs';
import type {
  Availability,
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
import type { RepackFormat } from './repack';
import { createFromDir, extractToDir, mkdtemp } from './repack';
import { sevenZipAvailability } from './seven-zip';

const FORMATS: readonly RepackFormat[] = [
  'zip',
  'tar',
  'tar.gz',
  'tar.bz2',
  'tar.xz',
  '7z',
];
const PURE_JS_PAIR = new Set<string>(['zip', 'tar', 'tar.gz']);

function isSupported(f: FormatId): f is RepackFormat {
  return (FORMATS as readonly string[]).includes(f);
}

export const sevenZipRepackConverter: Converter = {
  id: 'archive:seven-zip-repack',
  name: '7-Zip archive repackager',
  engine: '7z',
  inputs: FORMATS,
  outputs: FORMATS,

  supports(from: FormatId, to: FormatId): boolean {
    if (from === to || !isSupported(from) || !isSupported(to)) return false;
    // zip<->tar<->tar.gz is handled entirely by the pure-JS converter.
    if (PURE_JS_PAIR.has(from) && PURE_JS_PAIR.has(to)) return false;
    return true;
  },

  cost(from: FormatId, to: FormatId): EdgeCost {
    const heavy = from === '7z' || to === '7z' || from === 'tar.xz' || to === 'tar.xz';
    return { retention: 1, effort: heavy ? 6 : 5 };
  },

  async availability(): Promise<Availability> {
    return sevenZipAvailability();
  },

  async convert(
    input: ConversionInput,
    output: ConversionOutput,
    _options: ConverterOptions,
    ctx: ConvertContext,
  ): Promise<ConvertResult> {
    if (!isSupported(input.format) || !isSupported(output.format)) {
      throw new ConversionError({
        code: 'E_UNSUPPORTED_FEATURE',
        userMessage: `Cannot convert between "${input.format}" and "${output.format}".`,
        retryable: false,
      });
    }

    const staging = await mkdtemp(ctx.scratchDir, '7z-repack-');
    ctx.onProgress({ ratio: 0, message: 'Reading archive' });
    await extractToDir(input.format, input.path, staging, ctx);
    ctx.onProgress({ ratio: 0.5, message: 'Writing archive' });
    await createFromDir(output.format, staging, output.path, ctx);
    ctx.onProgress({ ratio: 1 });

    const stat = await fs.promises.stat(output.path);
    return { bytes: stat.size };
  },
};
