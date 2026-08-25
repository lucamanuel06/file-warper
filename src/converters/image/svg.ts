import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import type { Converter } from '@core/types';
import { ConversionError } from '@core/types';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const svgCompress: Converter = {
  id: 'zlib:svgz',
  name: 'SVG / SVGZ',
  engine: 'pure-js',
  inputs: ['svg', 'svgz'],
  outputs: ['svg', 'svgz'],

  supports(from, to) {
    return (from === 'svg' && to === 'svgz') || (from === 'svgz' && to === 'svg');
  },

  cost() {
    return { retention: 1.0, effort: 1 };
  },

  async availability() {
    return { available: true };
  },

  async convert(input, output, _options, ctx) {
    ctx.onProgress({ ratio: -1 });

    const buffer = await input.readBuffer();
    let result: Buffer;
    try {
      result =
        output.format === 'svgz' ? await gzipAsync(buffer) : await gunzipAsync(buffer);
    } catch (err) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage: 'This SVG/SVGZ file could not be read.',
        detail: String(err),
        cause: err,
      });
    }

    await writeFile(output.path, result);
    ctx.onProgress({ ratio: 1 });
    return { bytes: result.length };
  },
};
