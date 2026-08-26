import type { Converter, FormatId } from '@core/types';
import { ConversionError } from '@core/types';
import { sharp } from './sharp-init';

const INPUTS = ['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff', 'svg'] as const;
const OUTPUTS = ['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff'] as const;

function isSupportedOutput(f: FormatId): f is (typeof OUTPUTS)[number] {
  return (OUTPUTS as readonly string[]).includes(f);
}

const QUALITY_MAP: Record<string, number> = { smaller: 65, balanced: 82, best: 95 };
const LOSSLESS_TARGETS = new Set<FormatId>(['png', 'tiff']);
const ANIMATABLE = new Set<FormatId>(['gif', 'webp']);

function maxSizePx(value: unknown): number | undefined {
  if (typeof value !== 'string' || value === 'original') return undefined;
  const px = Number(value);
  return Number.isFinite(px) && px > 0 ? px : undefined;
}

export const sharpRaster: Converter = {
  id: 'sharp:raster',
  name: 'Raster Image',
  engine: 'sharp',
  inputs: INPUTS,
  outputs: OUTPUTS,

  supports(from, to) {
    return from !== to;
  },

  cost(_from, to) {
    return LOSSLESS_TARGETS.has(to)
      ? { retention: 1.0, effort: 2 }
      : { retention: 0.92, effort: 2 };
  },

  async availability() {
    return { available: true };
  },

  optionsSchema: {
    fields: [
      {
        key: 'quality',
        kind: 'segmented',
        label: 'Quality',
        choices: [
          { value: 'smaller', label: 'Smaller' },
          { value: 'balanced', label: 'Balanced' },
          { value: 'best', label: 'Best' },
        ],
        default: 'balanced',
      },
      {
        key: 'maxSize',
        kind: 'select',
        label: 'Max size',
        choices: [
          { value: 'original', label: 'Original' },
          { value: '4000', label: '4000 px' },
          { value: '2000', label: '2000 px' },
          { value: '1000', label: '1000 px' },
        ],
        default: 'original',
      },
    ],
  },
  defaultOptions: { quality: 'balanced', maxSize: 'original' },

  async convert(input, output, options, ctx) {
    ctx.onProgress({ ratio: -1 });

    const qualityTier =
      typeof options.quality === 'string' ? options.quality : 'balanced';
    const quality = QUALITY_MAP[qualityTier] ?? QUALITY_MAP.balanced;
    const best = qualityTier === 'best';
    const chromaSubsampling = best ? '4:4:4' : '4:2:0';
    const animated = ANIMATABLE.has(input.format) && ANIMATABLE.has(output.format);

    let pipeline = sharp(input.path, { animated }).rotate();

    const size = maxSizePx(options.maxSize);
    if (size !== undefined) {
      pipeline = pipeline.resize({
        width: size,
        height: size,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    pipeline = pipeline.toColorspace('srgb');

    if (!isSupportedOutput(output.format)) {
      throw new ConversionError({
        code: 'E_UNSUPPORTED_FEATURE',
        userMessage: `Cannot encode to ${output.format}.`,
      });
    }

    switch (output.format) {
      case 'jpeg':
        pipeline = pipeline.jpeg({ quality, chromaSubsampling, mozjpeg: true });
        break;
      case 'webp':
        pipeline = pipeline.webp({ quality });
        break;
      case 'avif':
        pipeline = pipeline.avif({ quality, chromaSubsampling });
        break;
      case 'png':
        pipeline = pipeline.png({ compressionLevel: 9 });
        break;
      case 'tiff':
        pipeline = pipeline.tiff({ compression: 'lzw' });
        break;
      case 'gif':
        pipeline = pipeline.gif();
        break;
    }

    const info = await pipeline.toFile(output.path);
    ctx.onProgress({ ratio: 1 });

    return {
      bytes: info.size,
      meta: { width: info.width, height: info.height },
    };
  },
};
