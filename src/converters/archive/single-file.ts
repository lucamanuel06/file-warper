/**
 * gz <-> bz2 <-> xz: recompressing a single opaque byte stream from one
 * codec to another. `gz` uses `node:zlib` directly; `bz2`/`xz` go through
 * the bundled `7za` binary (single-stream compressors are exactly what 7za
 * calls an "archive" containing one file).
 */

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
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
import { mkdtemp } from './repack';
import { sevenAdd, sevenExtractFull, sevenZipAvailability } from './seven-zip';

type SingleFileFormat = 'gz' | 'bz2' | 'xz';
const FORMATS: readonly SingleFileFormat[] = ['gz', 'bz2', 'xz'];

function isSupported(f: FormatId): f is SingleFileFormat {
  return (FORMATS as readonly string[]).includes(f);
}

async function decompressToFile(
  format: SingleFileFormat,
  srcPath: string,
  destPath: string,
  ctx: ConvertContext,
): Promise<void> {
  if (format === 'gz') {
    await pipeline(
      fs.createReadStream(srcPath),
      zlib.createGunzip(),
      fs.createWriteStream(destPath),
    );
    return;
  }
  const tempDir = await mkdtemp(ctx.scratchDir, 'single-decompress-');
  await sevenExtractFull(srcPath, tempDir, ctx.signal);
  const files = await fs.promises.readdir(tempDir);
  if (files.length !== 1) {
    throw new ConversionError({
      code: 'E_CORRUPT_INPUT',
      userMessage: `This ${format} file does not contain a single compressed stream.`,
      retryable: false,
    });
  }
  await fs.promises.rename(path.join(tempDir, files[0] as string), destPath);
}

async function compressFromFile(
  format: SingleFileFormat,
  srcPath: string,
  destPath: string,
  ctx: ConvertContext,
): Promise<void> {
  if (format === 'gz') {
    await pipeline(
      fs.createReadStream(srcPath),
      zlib.createGzip(),
      fs.createWriteStream(destPath),
    );
    return;
  }
  const codec = format === 'bz2' ? 'bzip2' : 'xz';
  await sevenAdd(destPath, srcPath, codec, ctx.signal);
}

export const singleFileRecompressConverter: Converter = {
  id: 'archive:single-file-recompress',
  name: 'Gzip / Bzip2 / XZ recompressor',
  engine: '7z',
  inputs: FORMATS,
  outputs: FORMATS,

  supports(from: FormatId, to: FormatId): boolean {
    return from !== to && isSupported(from) && isSupported(to);
  },

  cost(from: FormatId, to: FormatId): EdgeCost {
    const heavy = from === 'xz' || to === 'xz';
    return { retention: 1, effort: heavy ? 4 : 3 };
  },

  async availability(): Promise<Availability> {
    // Every supported pair touches bz2 or xz (gz<->gz is excluded by
    // `supports`), so this always needs the 7za binary.
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

    const staging = await mkdtemp(ctx.scratchDir, 'single-file-');
    const raw = path.join(staging, 'payload');
    ctx.onProgress({ ratio: 0, message: 'Decompressing' });
    await decompressToFile(input.format, input.path, raw, ctx);
    ctx.onProgress({ ratio: 0.5, message: 'Compressing' });
    await compressFromFile(output.format, raw, output.path, ctx);
    ctx.onProgress({ ratio: 1 });

    const stat = await fs.promises.stat(output.path);
    return { bytes: stat.size };
  },
};
