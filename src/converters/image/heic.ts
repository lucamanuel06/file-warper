import type { Converter } from '@core/types';
import { ConversionError } from '@core/types';
import decode from 'heic-decode';
import { sharp } from './sharp-init';

export const heicDecode: Converter = {
  id: 'heic-decode:png',
  name: 'HEIC/HEIF Decoder',
  engine: 'pure-js',
  inputs: ['heic', 'heif'],
  outputs: ['png'],

  cost() {
    return { retention: 1.0, effort: 4 };
  },

  async availability() {
    return { available: true };
  },

  async convert(input, output, _options, ctx) {
    ctx.onProgress({ ratio: -1 });

    const buffer = await input.readBuffer();
    let decoded: { width: number; height: number; data: Uint8ClampedArray };
    try {
      decoded = await decode({ buffer });
    } catch (err) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage:
          'This HEIC/HEIF file could not be read — it may be corrupt or use an unsupported variant.',
        detail: String(err),
        cause: err,
      });
    }

    const { width, height, data } = decoded;
    const info = await sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
      raw: { width, height, channels: 4 },
    })
      .png({ compressionLevel: 9 })
      .toFile(output.path);

    ctx.onProgress({ ratio: 1 });
    return { bytes: info.size, meta: { width: info.width, height: info.height } };
  },
};
