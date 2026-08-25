/**
 * `html -> pdf` via W2's offscreen-BrowserWindow renderer (see `./pdf-render`).
 *
 * This converter never touches Electron directly — it only calls
 * `getPdfRenderer()`, which is why it must run with `residency: 'main'`
 * (the only place `webContents.printToPDF` exists).
 */

import { writeFile } from 'node:fs/promises';
import type {
  ConversionInput,
  ConversionOutput,
  ConvertContext,
  Converter,
  ConverterOptions,
  ConvertResult,
  EdgeCost,
} from '@core/types';
import { ConversionError } from '@core/types';
import type { PdfPageSize, PrintToPdfOptions } from './pdf-render';
import { getPdfRenderer } from './pdf-render';

const PAGE_SIZE_VALUES = ['auto', 'A4', 'letter'] as const;
type PageSizeOption = (typeof PAGE_SIZE_VALUES)[number];

function isPageSizeOption(value: unknown): value is PageSizeOption {
  return (
    typeof value === 'string' && (PAGE_SIZE_VALUES as readonly string[]).includes(value)
  );
}

function resolvePageSize(options: ConverterOptions): PdfPageSize | undefined {
  const raw = options.pageSize;
  const value: PageSizeOption = isPageSizeOption(raw) ? raw : 'auto';
  if (value === 'auto') {
    // Let the renderer/CSS @page rules decide.
    return undefined;
  }
  if (value === 'letter') {
    return { format: 'Letter' };
  }
  return { format: 'A4' };
}

export const htmlToPdfConverter: Converter = {
  id: 'doc:html-to-pdf',
  name: 'HTML to PDF',
  engine: 'chromium',
  residency: 'main',

  inputs: ['html'],
  outputs: ['pdf'],

  cost(): EdgeCost {
    // Real Chromium rendering; pagination is an approximation of the source
    // layout, but nothing is deliberately discarded.
    return { retention: 1.0, effort: 5, structure: 0.9 };
  },

  async availability() {
    try {
      getPdfRenderer();
      return { available: true };
    } catch (cause) {
      const reason =
        cause instanceof ConversionError
          ? cause.userMessage
          : 'PDF rendering is unavailable.';
      return { available: false, reason };
    }
  },

  optionsSchema: {
    fields: [
      {
        key: 'pageSize',
        kind: 'select',
        label: 'Page size',
        choices: [
          { value: 'auto', label: 'Auto' },
          { value: 'A4', label: 'A4' },
          { value: 'letter', label: 'Letter' },
        ],
        default: 'auto',
      },
    ],
  },
  defaultOptions: { pageSize: 'auto' },

  async convert(
    input: ConversionInput,
    output: ConversionOutput,
    options: ConverterOptions,
    ctx: ConvertContext,
  ): Promise<ConvertResult> {
    if (ctx.signal.aborted) {
      throw new ConversionError({
        code: 'E_CANCELLED',
        userMessage: 'The conversion was cancelled.',
        retryable: false,
      });
    }

    const renderer = getPdfRenderer();

    const printOptions: PrintToPdfOptions = {
      pageSize: resolvePageSize(options),
      printBackground: true,
      signal: ctx.signal,
    };

    ctx.onProgress({ ratio: 0, message: 'Rendering PDF' });

    let buffer: Buffer;
    try {
      buffer = await renderer.printToPdf(input.path, printOptions);
    } catch (cause) {
      if (cause instanceof ConversionError) {
        throw cause;
      }
      throw new ConversionError({
        code: 'E_ENGINE',
        userMessage: 'The PDF could not be rendered.',
        detail: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
        cause,
      });
    }

    ctx.onProgress({ ratio: 0.9, message: 'Writing PDF' });

    try {
      await writeFile(output.path, buffer);
    } catch (cause) {
      throw new ConversionError({
        code: 'E_PERMISSION',
        userMessage: `Could not write the PDF file to "${output.path}".`,
        detail: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
        cause,
      });
    }

    ctx.onProgress({ ratio: 1, message: 'Done' });

    return { bytes: buffer.byteLength };
  },
};
