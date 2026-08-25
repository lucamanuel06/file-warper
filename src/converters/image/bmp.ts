import { stat } from 'node:fs/promises';
import type { Converter } from '@core/types';
import { ConversionError } from '@core/types';
import { Jimp } from 'jimp';

export const bmp: Converter = {
  id: 'jimp:bmp',
  name: 'Bitmap (BMP)',
  engine: 'pure-js',
  inputs: ['bmp', 'png'],
  outputs: ['bmp', 'png'],

  supports(from, to) {
    return from !== to;
  },

  cost() {
    return { retention: 1.0, effort: 2 };
  },

  async availability() {
    return { available: true };
  },

  async convert(input, output, _options, ctx) {
    ctx.onProgress({ ratio: -1 });

    let image: Awaited<ReturnType<typeof Jimp.read>>;
    try {
      image = await Jimp.read(input.path);
    } catch (err) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage: 'This BMP file could not be read.',
        detail: String(err),
        cause: err,
      });
    }

    if (output.format === 'bmp') {
      await image.write(output.path as `${string}.bmp`);
    } else {
      await image.write(output.path as `${string}.png`);
    }

    ctx.onProgress({ ratio: 1 });
    const st = await stat(output.path);
    return { bytes: st.size, meta: { width: image.width, height: image.height } };
  },
};
