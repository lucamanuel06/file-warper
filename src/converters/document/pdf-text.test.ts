import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import type { ConversionInput, ConvertContext } from '@core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pdfToText } from './pdf-text';

async function buildFixturePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const page1 = doc.addPage([300, 300]);
  page1.drawText('Hello PDF World', { x: 50, y: 250, size: 18, font });
  page1.drawText('A second line of text', { x: 50, y: 220, size: 14, font });

  const page2 = doc.addPage([300, 300]);
  page2.drawText('Second page content', { x: 50, y: 250, size: 14, font });

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

function makeInput(buffer: Buffer): ConversionInput {
  return {
    path: '/virtual/input.pdf',
    format: 'pdf',
    size: buffer.length,
    async readBuffer() {
      return buffer;
    },
    createReadStream() {
      throw new Error('not used in this test');
    },
  };
}

function makeContext(): ConvertContext {
  return {
    onProgress: () => {},
    signal: new AbortController().signal,
    scratchDir: tmpdir(),
    log: () => {},
  };
}

describe('pdfToText', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pdf-text-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('extracts text from every page, joined with a blank line', async () => {
    const fixture = await buildFixturePdf();
    const outputPath = join(dir, 'out.txt');

    const result = await pdfToText.convert(
      makeInput(fixture),
      { path: outputPath, format: 'txt' },
      {},
      makeContext(),
    );

    const text = await readFile(outputPath, 'utf8');
    expect(text).toContain('Hello PDF World');
    expect(text).toContain('A second line of text');
    expect(text).toContain('Second page content');
    expect(text.indexOf('Second page content')).toBeGreaterThan(
      text.indexOf('Hello PDF World'),
    );

    expect(result.meta).toMatchObject({ pageCount: 2 });
    expect(result.warnings?.[0]).toMatch(/reading order/i);
  });

  it('rejects with E_CORRUPT_INPUT on garbage input', async () => {
    const bad = Buffer.from('this is not a pdf file at all');
    await expect(
      pdfToText.convert(
        makeInput(bad),
        { path: join(dir, 'out.txt'), format: 'txt' },
        {},
        makeContext(),
      ),
    ).rejects.toMatchObject({ code: 'E_CORRUPT_INPUT' });
  });

  it('reports availability as always true', async () => {
    await expect(pdfToText.availability()).resolves.toEqual({ available: true });
  });
});
