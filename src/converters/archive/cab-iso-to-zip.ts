/**
 * CAB and ISO are read-only in this app (see `formats.ts`). This converter
 * gives each a single outbound edge — extract via `7za` into the scratch
 * dir, then re-zip — reaching every other archive format through the zip
 * hub.
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
import { createFromDir, mkdtemp } from './repack';
import { assertAllSafe } from './safe-path';
import { sevenExtractFull, sevenList, sevenZipAvailability } from './seven-zip';

const SOURCE_FORMATS: readonly FormatId[] = ['cab', 'iso'];

export const cabIsoToZipConverter: Converter = {
  id: 'archive:cab-iso-to-zip',
  name: 'CAB / ISO extractor',
  engine: '7z',
  inputs: SOURCE_FORMATS,
  outputs: ['zip'],

  supports(from: FormatId, to: FormatId): boolean {
    return to === 'zip' && SOURCE_FORMATS.includes(from);
  },

  cost(): EdgeCost {
    return { retention: 1, effort: 4 };
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
    if (!SOURCE_FORMATS.includes(input.format) || output.format !== 'zip') {
      throw new ConversionError({
        code: 'E_UNSUPPORTED_FEATURE',
        userMessage: `Cannot convert between "${input.format}" and "${output.format}".`,
        retryable: false,
      });
    }

    const staging = await mkdtemp(ctx.scratchDir, 'cab-iso-extract-');
    ctx.onProgress({
      ratio: 0,
      message: `Reading ${input.format.toUpperCase()} archive`,
    });

    const names = await sevenList(input.path, ctx.signal);
    assertAllSafe(staging, names);
    await sevenExtractFull(input.path, staging, ctx.signal);

    ctx.onProgress({ ratio: 0.7, message: 'Writing ZIP archive' });
    await createFromDir('zip', staging, output.path, ctx);
    ctx.onProgress({ ratio: 1 });

    const stat = await fs.promises.stat(output.path);
    return { bytes: stat.size };
  },
};
