/**
 * ZIP <-> TAR <-> TAR.GZ repackaging. Pure JS (`yauzl` + `archiver` + `tar`),
 * no native binary, always available. This is the top-priority archive edge
 * set — every pair is lossless (we move bytes, we don't re-encode payloads).
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

const FORMATS: readonly RepackFormat[] = ['zip', 'tar', 'tar.gz'];

function isSupported(f: FormatId): f is RepackFormat {
  return (FORMATS as readonly string[]).includes(f);
}

export const zipTarRepackConverter: Converter = {
  id: 'archive:zip-tar-repack',
  name: 'ZIP / TAR / TAR.GZ repackager',
  engine: 'pure-js',
  inputs: FORMATS,
  outputs: FORMATS,

  supports(from: FormatId, to: FormatId): boolean {
    return from !== to && isSupported(from) && isSupported(to);
  },

  cost(from: FormatId, to: FormatId): EdgeCost {
    const touchesGzip = from === 'tar.gz' || to === 'tar.gz';
    return { retention: 1, effort: touchesGzip ? 3 : 2 };
  },

  async availability(): Promise<Availability> {
    return { available: true };
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

    const staging = await mkdtemp(ctx.scratchDir, 'zip-tar-');
    ctx.onProgress({ ratio: 0, message: 'Reading archive' });
    await extractToDir(input.format, input.path, staging, ctx);
    ctx.onProgress({ ratio: 0.5, message: 'Writing archive' });
    await createFromDir(output.format, staging, output.path, ctx);
    ctx.onProgress({ ratio: 1 });

    const stat = await fs.promises.stat(output.path);
    return { bytes: stat.size };
  },
};
