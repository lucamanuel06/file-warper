import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversionInput, ConvertContext } from '@core/types';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { docxToHtml } from './docx-html';

async function buildFixtureDocx(): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: 'Hello Title', heading: HeadingLevel.HEADING_1 }),
          new Paragraph({
            children: [
              new TextRun({ text: 'Bold text', bold: true }),
              new TextRun(' normal text'),
            ],
          }),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

function makeInput(path: string, buffer: Buffer): ConversionInput {
  return {
    path,
    format: 'docx',
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

describe('docxToHtml', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'docx-html-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('converts a .docx file into well-formed, semantic HTML', async () => {
    const fixture = await buildFixtureDocx();
    const inputPath = join(dir, 'in.docx');
    await writeFile(inputPath, fixture);
    const outputPath = join(dir, 'out.html');

    const result = await docxToHtml.convert(
      makeInput(inputPath, fixture),
      { path: outputPath, format: 'html' },
      {},
      makeContext(),
    );

    expect(result.bytes).toBeGreaterThan(0);

    const html = await readFile(outputPath, 'utf8');
    const { document } = parseHTML(html);
    expect(document.querySelector('h1')?.textContent).toBe('Hello Title');
    const strong = document.querySelector('strong');
    expect(strong?.textContent).toBe('Bold text');
    expect(document.body.textContent).toContain('normal text');
  });

  it('surfaces a plain-English error for a corrupt .docx', async () => {
    const inputPath = join(dir, 'bad.docx');
    const bad = Buffer.from('not a real docx file');
    await writeFile(inputPath, bad);

    await expect(
      docxToHtml.convert(
        makeInput(inputPath, bad),
        { path: join(dir, 'out.html'), format: 'html' },
        {},
        makeContext(),
      ),
    ).rejects.toMatchObject({ code: 'E_CORRUPT_INPUT' });
  });

  it('reports availability as always true', async () => {
    await expect(docxToHtml.availability()).resolves.toEqual({ available: true });
  });
});
