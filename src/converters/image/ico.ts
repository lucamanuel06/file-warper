import type { Converter } from '@core/types';
import { ConversionError } from '@core/types';
import { decode, sharpsToIco } from 'sharp-ico';
import { sharp } from './sharp-init';

const ICO_SIZES = [16, 32, 48, 128, 256];

export const ico: Converter = {
  id: 'sharp-ico:favicon',
  name: 'Windows Icon',
  engine: 'sharp',
  inputs: ['png', 'jpeg', 'ico'],
  outputs: ['ico', 'png'],

  supports(from, to) {
    return (
      (from === 'png' && to === 'ico') ||
      (from === 'jpeg' && to === 'ico') ||
      (from === 'ico' && to === 'png')
    );
  },

  cost(from, to) {
    if (from === 'ico' && to === 'png') return { retention: 1.0, effort: 2 };
    return { retention: 0.9, effort: 3, structure: 0.8 };
  },

  async availability() {
    return { available: true };
  },

  async convert(input, output, _options, ctx) {
    ctx.onProgress({ ratio: -1 });

    if (output.format === 'ico') {
      const source = sharp(input.path);
      const info = await sharpsToIco([source], output.path, {
        sizes: ICO_SIZES,
        resizeOptions: {},
      });
      ctx.onProgress({ ratio: 1 });
      return { bytes: info.size, meta: { width: info.width, height: info.height } };
    }

    const buffer = await input.readBuffer();
    let icons: ReturnType<typeof decode>;
    try {
      icons = decode(buffer);
    } catch (err) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage: 'This ICO file could not be read.',
        detail: String(err),
        cause: err,
      });
    }
    if (icons.length === 0) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage: 'This ICO file has no frames.',
      });
    }

    const largest = icons.reduce((a, b) =>
      a.width * a.height >= b.width * b.height ? a : b,
    );
    const frame =
      largest.type === 'png'
        ? sharp(Buffer.from(largest.data))
        : sharp(Buffer.from(largest.data), {
            raw: { width: largest.width, height: largest.height, channels: 4 },
          });

    const info = await frame.png({ compressionLevel: 9 }).toFile(output.path);
    ctx.onProgress({ ratio: 1 });
    return { bytes: info.size, meta: { width: info.width, height: info.height } };
  },
};
