/**
 * RAR is extract-only (its license forbids us from ever writing one). This
 * converter gives RAR a single outbound edge — extract into the scratch
 * dir, then re-zip — which is enough to reach every other archive format
 * through the zip hub.
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
import { createExtractorFromFile } from 'node-unrar-js';
import { createFromDir, mkdtemp } from './repack';
import { assertAllSafe } from './safe-path';

export const rarToZipConverter: Converter = {
  id: 'archive:rar-to-zip',
  name: 'RAR extractor',
  engine: 'pure-js',
  inputs: ['rar'],
  outputs: ['zip'],

  supports(from: FormatId, to: FormatId): boolean {
    return from === 'rar' && to === 'zip';
  },

  cost(): EdgeCost {
    return { retention: 1, effort: 4 };
  },

  async availability(): Promise<Availability> {
    // node-unrar-js is a self-contained WASM build — no external binary.
    return { available: true };
  },

  async convert(
    input: ConversionInput,
    output: ConversionOutput,
    _options: ConverterOptions,
    ctx: ConvertContext,
  ): Promise<ConvertResult> {
    if (input.format !== 'rar' || output.format !== 'zip') {
      throw new ConversionError({
        code: 'E_UNSUPPORTED_FEATURE',
        userMessage: `Cannot convert between "${input.format}" and "${output.format}".`,
        retryable: false,
      });
    }

    const staging = await mkdtemp(ctx.scratchDir, 'rar-extract-');
    ctx.onProgress({ ratio: 0, message: 'Reading RAR archive' });

    let extractor: Awaited<ReturnType<typeof createExtractorFromFile>>;
    try {
      extractor = await createExtractorFromFile({
        filepath: input.path,
        targetPath: staging,
      });
    } catch (err) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage:
          'This RAR archive could not be opened; it may be corrupt or password-protected.',
        detail: err instanceof Error ? err.message : String(err),
        retryable: false,
        cause: err,
      });
    }

    const names: string[] = [];
    try {
      for (const header of extractor.getFileList().fileHeaders) {
        names.push(header.name);
      }
    } catch (err) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage:
          'This RAR archive could not be read; it may be corrupt or password-protected.',
        detail: err instanceof Error ? err.message : String(err),
        retryable: false,
        cause: err,
      });
    }
    assertAllSafe(staging, names);

    if (ctx.signal.aborted) {
      throw new ConversionError({
        code: 'E_CANCELLED',
        userMessage: 'The conversion was cancelled.',
        retryable: false,
      });
    }

    try {
      const result = extractor.extract();
      // The returned generator must be fully drained or the underlying
      // WASM archive object leaks (per node-unrar-js's own docs).
      for (const _file of result.files) {
        // side effect (disk write) already happened inside the extractor
      }
    } catch (err) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage:
          'This RAR archive could not be extracted; it may be corrupt or password-protected.',
        detail: err instanceof Error ? err.message : String(err),
        retryable: false,
        cause: err,
      });
    }

    ctx.onProgress({ ratio: 0.7, message: 'Writing ZIP archive' });
    await createFromDir('zip', staging, output.path, ctx);
    ctx.onProgress({ ratio: 1 });

    const stat = await fs.promises.stat(output.path);
    return { bytes: stat.size };
  },
};
