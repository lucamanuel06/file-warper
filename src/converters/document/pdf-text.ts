/**
 * `pdf -> txt` via `pdfjs-dist`'s `getTextContent()`.
 *
 * `pdfjs-dist` ships ESM-only builds (no `require` export condition), so the
 * legacy (non-browser) build is loaded with a dynamic `import()`. The legacy
 * build falls back to an in-process "fake worker" automatically when it
 * detects there's no `Worker` global (true in Node), but it still needs
 * `GlobalWorkerOptions.workerSrc` pointed at the worker module on disk so it
 * knows what to `import()` for that fake worker.
 *
 * Text layout is reconstructed heuristically: items are grouped into lines by
 * their y-coordinate (`transform[5]`), then ordered left-to-right within a
 * line by x-coordinate, inserting a space wherever the gap between two items
 * exceeds a fraction of the text height. This works well for single-column
 * prose and fails gracefully (readable, but out of order) for multi-column
 * layouts, tables, and floating text boxes — pdf.js has no layout model, so
 * there is no way to do better without a full page-layout reconstruction
 * pass, which is out of scope here.
 */

import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type {
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

interface TextItemLike {
  readonly str: string;
  readonly transform: readonly number[];
  readonly width: number;
  readonly height: number;
}

function isTextItem(item: unknown): item is TextItemLike {
  return (
    typeof item === 'object' &&
    item !== null &&
    typeof (item as { str?: unknown }).str === 'string' &&
    Array.isArray((item as { transform?: unknown }).transform)
  );
}

interface Placed {
  readonly x: number;
  readonly xEnd: number;
  readonly y: number;
  readonly height: number;
  readonly str: string;
}

/** Groups text items into visual lines by y-coordinate, tolerant of jitter. */
function groupIntoLines(items: readonly Placed[]): Placed[][] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Placed[][] = [];
  let current: Placed[] = [];
  let currentY: number | null = null;
  const TOLERANCE = 2.5;

  for (const item of sorted) {
    if (currentY === null || Math.abs(item.y - currentY) <= TOLERANCE) {
      current.push(item);
      currentY = currentY === null ? item.y : (currentY + item.y) / 2;
    } else {
      lines.push(current);
      current = [item];
      currentY = item.y;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

function renderLine(line: readonly Placed[]): string {
  const sorted = [...line].sort((a, b) => a.x - b.x);
  let out = '';
  let prevEnd: number | null = null;
  for (const item of sorted) {
    if (prevEnd !== null) {
      const gap = item.x - prevEnd;
      if (
        gap > Math.max(item.height, 1) * 0.3 &&
        !out.endsWith(' ') &&
        !item.str.startsWith(' ')
      ) {
        out += ' ';
      }
    }
    out += item.str;
    prevEnd = item.xEnd;
  }
  return out.trimEnd();
}

async function extractPageText(page: {
  getTextContent(): Promise<{ items: readonly unknown[] }>;
}): Promise<string> {
  const content = await page.getTextContent();
  const placed: Placed[] = [];
  for (const raw of content.items) {
    if (!isTextItem(raw)) continue;
    if (raw.str.length === 0) continue;
    const x = raw.transform[4] ?? 0;
    const y = raw.transform[5] ?? 0;
    placed.push({ x, xEnd: x + raw.width, y, height: raw.height, str: raw.str });
  }
  const lines = groupIntoLines(placed);
  return lines.map(renderLine).join('\n');
}

export const pdfToText: Converter = {
  id: 'doc:pdf-to-txt',
  name: 'PDF to Plain Text (pdfjs-dist)',
  engine: 'pure-js',
  inputs: ['pdf'],
  outputs: ['txt'],

  cost(_from: FormatId, _to: FormatId): EdgeCost {
    // Words are preserved faithfully but all layout, tables and images are
    // dropped, and multi-column reading order is only a heuristic.
    return { retention: 0.6, effort: 3, structure: 0.1 };
  },

  async availability() {
    return { available: true };
  },

  async convert(
    input: ConversionInput,
    output: ConversionOutput,
    _options: ConverterOptions,
    ctx: ConvertContext,
  ): Promise<ConvertResult> {
    if (ctx.signal.aborted) {
      throw new ConversionError({
        code: 'E_CANCELLED',
        userMessage: 'Conversion was cancelled.',
      });
    }

    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // No `require` export condition on this package's "exports" map, so a
    // subpath resolve for the worker module is unrestricted.
    const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;

    const buffer = await input.readBuffer();
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useWorkerFetch: false,
      verbosity: pdfjs.VerbosityLevel.ERRORS,
    });

    ctx.signal.addEventListener('abort', () => {
      loadingTask.destroy();
    });

    let doc: Awaited<typeof loadingTask.promise>;
    try {
      doc = await loadingTask.promise;
    } catch (err: unknown) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'PasswordException') {
        throw new ConversionError({
          code: 'E_UNSUPPORTED_FEATURE',
          userMessage: 'This PDF is password-protected.',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage: 'This PDF could not be read. It may be corrupted.',
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const pageTexts: string[] = [];
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
        if (ctx.signal.aborted) {
          throw new ConversionError({
            code: 'E_CANCELLED',
            userMessage: 'Conversion was cancelled.',
          });
        }
        const page = await doc.getPage(pageNumber);
        pageTexts.push(await extractPageText(page));
        ctx.onProgress({
          ratio: pageNumber / doc.numPages,
          message: `Page ${pageNumber}/${doc.numPages}`,
        });
      }

      const text = pageTexts.join('\n\n');
      await writeFile(output.path, text, 'utf8');

      return {
        bytes: Buffer.byteLength(text, 'utf8'),
        warnings: [
          'Text extraction follows a left-to-right, top-to-bottom heuristic. Multi-column layouts, tables, and text boxes may come out in the wrong reading order — this is a known limitation, not a bug.',
        ],
        meta: { pageCount: doc.numPages },
      };
    } finally {
      await loadingTask.destroy();
    }
  },
};
