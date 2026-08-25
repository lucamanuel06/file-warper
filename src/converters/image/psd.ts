import type { Converter } from '@core/types';
import { ConversionError } from '@core/types';
import { readPsd } from 'ag-psd';
import sharp from 'sharp';
import { ensureCanvasShim } from './psd-canvas-shim';

export const psdDecode: Converter = {
  id: 'ag-psd:png',
  name: 'PSD Decoder',
  engine: 'pure-js',
  inputs: ['psd'],
  outputs: ['png'],

  cost() {
    return { retention: 1.0, effort: 3, structure: 0.4 };
  },

  async availability() {
    return { available: true };
  },

  async convert(input, output, _options, ctx) {
    ctx.onProgress({ ratio: -1 });
    ensureCanvasShim();

    const buffer = await input.readBuffer();
    let psd: ReturnType<typeof readPsd>;
    try {
      psd = readPsd(buffer, {
        skipLayerImageData: true,
        skipThumbnail: true,
        skipLinkedFilesData: true,
        useImageData: true,
      });
    } catch (err) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage: 'This PSD file could not be read.',
        detail: String(err),
        cause: err,
      });
    }

    const composite = psd.imageData;
    if (!composite) {
      throw new ConversionError({
        code: 'E_UNSUPPORTED_FEATURE',
        userMessage: 'This PSD has no flattened composite image to convert.',
      });
    }
    if (composite.data.BYTES_PER_ELEMENT !== 1) {
      throw new ConversionError({
        code: 'E_UNSUPPORTED_FEATURE',
        userMessage: 'This PSD uses a bit depth that is not supported.',
      });
    }

    const info = await sharp(
      Buffer.from(
        composite.data.buffer,
        composite.data.byteOffset,
        composite.data.byteLength,
      ),
      { raw: { width: composite.width, height: composite.height, channels: 4 } },
    )
      .png({ compressionLevel: 9 })
      .toFile(output.path);

    ctx.onProgress({ ratio: 1 });
    return { bytes: info.size, meta: { width: info.width, height: info.height } };
  },
};
