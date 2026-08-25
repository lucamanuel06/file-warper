import sharp from 'sharp';

const RAW_2X2 = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);

export type RasterFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'gif' | 'tiff';

export async function rasterFixture(format: RasterFormat): Promise<Buffer> {
  const pipeline = sharp(RAW_2X2, { raw: { width: 2, height: 2, channels: 3 } });
  switch (format) {
    case 'jpeg':
      return pipeline.jpeg().toBuffer();
    case 'png':
      return pipeline.png().toBuffer();
    case 'webp':
      return pipeline.webp().toBuffer();
    case 'avif':
      return pipeline.avif().toBuffer();
    case 'gif':
      return pipeline.gif().toBuffer();
    case 'tiff':
      return pipeline.tiff().toBuffer();
  }
}

export const SVG_FIXTURE = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#ff0000"/></svg>',
);

/** Two 2x2 frames stacked into one tall raw buffer; sharp slices them via `pageHeight`. */
export async function animatedFixture(format: 'gif' | 'webp'): Promise<Buffer> {
  const frame1 = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
  const frame2 = Buffer.from([0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 255]);
  const tall = Buffer.concat([frame1, frame2]);
  const pipeline = sharp(tall, {
    raw: { width: 2, height: 4, channels: 3, pageHeight: 2 },
    animated: true,
  });
  return format === 'gif'
    ? pipeline.gif({ delay: [100, 100], loop: 0 }).toBuffer()
    : pipeline.webp({ delay: [100, 100], loop: 0 }).toBuffer();
}

export async function rotatedJpegFixture(): Promise<Buffer> {
  // 3x2 raw image with EXIF orientation = 6 (rotate 90 CW) so the decoded,
  // auto-oriented result is 2x3.
  const wide = Buffer.from([
    255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0, 0, 255, 255, 255, 0, 255,
  ]);
  return sharp(wide, { raw: { width: 3, height: 2, channels: 3 } })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
}
