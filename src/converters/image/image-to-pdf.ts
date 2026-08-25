import { writeFile } from 'node:fs/promises';
import { PDFDocument } from '@cantoo/pdf-lib';
import type { Converter } from '@core/types';
import { ConversionError } from '@core/types';

export const imageToPdf: Converter = {
  id: 'pdf-lib:image-to-pdf',
  name: 'Image to PDF',
  engine: 'pure-js',
  inputs: ['png', 'jpeg'],
  outputs: ['pdf'],

  cost() {
    return { retention: 1.0, effort: 2 };
  },

  async availability() {
    return { available: true };
  },

  async convert(input, output, options, ctx) {
    ctx.onProgress({ ratio: -1 });

    const bytes = await input.readBuffer();
    const doc = await PDFDocument.create();

    if (options.deterministic) {
      doc.setCreationDate(new Date(0));
      doc.setModificationDate(new Date(0));
      doc.setProducer('');
      doc.setCreator('');
    }

    let image: Awaited<ReturnType<typeof doc.embedPng>>;
    try {
      image =
        input.format === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    } catch (err) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage: 'This image could not be read.',
        detail: String(err),
        cause: err,
      });
    }

    const page = doc.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });

    const pdfBytes = await doc.save();
    await writeFile(output.path, pdfBytes);

    ctx.onProgress({ ratio: 1 });
    return { bytes: pdfBytes.length };
  },
};
