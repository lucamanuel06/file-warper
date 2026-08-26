import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rasterFixture } from './fixtures';
import { imageToPdf } from './image-to-pdf';
import { sharp } from './sharp-init';
import { cleanupDir, fakeContext, fakeInput, makeTempDir } from './test-helpers';

let dir: string;
let pngPath: string;
let jpegPath: string;

beforeAll(async () => {
  dir = await makeTempDir('image-to-pdf-');
  pngPath = path.join(dir, 'src.png');
  await writeFile(pngPath, await rasterFixture('png'));
  jpegPath = path.join(dir, 'src.jpeg');
  await writeFile(jpegPath, await rasterFixture('jpeg'));
});

afterAll(async () => {
  await cleanupDir(dir);
});

describe('pdf-lib:image-to-pdf', () => {
  it('declares png/jpeg -> pdf', () => {
    expect(imageToPdf.inputs).toEqual(['png', 'jpeg']);
    expect(imageToPdf.outputs).toEqual(['pdf']);
  });

  for (const format of ['png', 'jpeg'] as const) {
    it(`${format} -> pdf`, async () => {
      const srcPath = format === 'png' ? pngPath : jpegPath;
      const input = await fakeInput(srcPath, format);
      const outPath = path.join(dir, `out-${format}.pdf`);

      const result = await imageToPdf.convert(
        input,
        { path: outPath, format: 'pdf' },
        {},
        fakeContext(dir),
      );

      expect(result.bytes).toBeGreaterThan(0);
      const bytes = await readFile(outPath);
      expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(bytes.subarray(-6).toString('ascii').trim()).toBe('%%EOF');

      const doc = await PDFDocument.load(bytes);
      expect(doc.getPageCount()).toBe(1);
      const page = doc.getPage(0);
      const srcMeta = await sharp(srcPath).metadata();
      expect(page.getWidth()).toBe(srcMeta.width);
      expect(page.getHeight()).toBe(srcMeta.height);
    });
  }
});
