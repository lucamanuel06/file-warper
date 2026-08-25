import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversionInput, ConvertContext } from '@core/types';
import iconv from 'iconv-lite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseHtml } from './dom';
import { txtToHtml } from './txt-html';

function makeInput(path: string, buffer: Buffer): ConversionInput {
  return {
    path,
    format: 'txt',
    size: buffer.byteLength,
    async readBuffer() {
      return buffer;
    },
    createReadStream() {
      throw new Error('not used in these tests');
    },
  };
}

function makeContext(scratchDir: string): ConvertContext {
  return {
    onProgress() {},
    signal: new AbortController().signal,
    scratchDir,
    log() {},
  };
}

describe('txt-to-html converter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fw-txt-html-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('declares txt -> html, lossless', async () => {
    expect(txtToHtml.inputs).toEqual(['txt']);
    expect(txtToHtml.outputs).toEqual(['html']);
    expect(txtToHtml.cost('txt', 'html').retention).toBe(1.0);
    expect(await txtToHtml.availability()).toEqual({ available: true });
  });

  it('turns blank-line-separated blocks into paragraphs and single newlines into <br>', async () => {
    const text = 'First paragraph,\nstill first line.\n\nSecond paragraph.';
    const input = makeInput(join(dir, 'in.txt'), Buffer.from(text, 'utf8'));
    const outputPath = join(dir, 'out.html');

    const result = await txtToHtml.convert(
      input,
      { path: outputPath, format: 'html' },
      {},
      makeContext(dir),
    );

    const html = await readFile(outputPath, 'utf8');
    const document = parseHtml(html);
    const paragraphs = [...document.querySelectorAll('p')];
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.innerHTML).toContain('First paragraph,<br>');
    expect(paragraphs[0]?.textContent).toContain('still first line.');
    expect(paragraphs[1]?.textContent).toBe('Second paragraph.');
    expect(result.bytes).toBe(Buffer.byteLength(html, 'utf8'));
  });

  it('HTML-escapes special characters so they render as literal text', async () => {
    const text = 'if (a < b && b > c) { return "<script>"; }';
    const input = makeInput(join(dir, 'in.txt'), Buffer.from(text, 'utf8'));
    const outputPath = join(dir, 'out.html');

    await txtToHtml.convert(
      input,
      { path: outputPath, format: 'html' },
      {},
      makeContext(dir),
    );

    const html = await readFile(outputPath, 'utf8');
    const document = parseHtml(html);
    // Re-parsed back to a real DOM: the original text survives verbatim,
    // and it never became a real (dangerous) <script> element.
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('p')?.textContent).toBe(text);
  });

  it('detects a non-UTF-8 encoding and decodes it correctly instead of producing mojibake', async () => {
    const text =
      "Le café est prêt. Voici la note : 100€ pour l'addition. Ça sent très bon ce matin déjà, vraiment.";
    const cp1252 = iconv.encode(text, 'windows-1252');
    const input = makeInput(join(dir, 'in.txt'), cp1252);
    const outputPath = join(dir, 'out.html');

    await txtToHtml.convert(
      input,
      { path: outputPath, format: 'html' },
      {},
      makeContext(dir),
    );

    const html = await readFile(outputPath, 'utf8');
    expect(html).toContain('café');
    expect(html).toContain('€');
    expect(html).not.toContain('�'); // no replacement-character mojibake
  });

  it('drops empty leading/trailing blocks and produces valid, parseable HTML', async () => {
    const input = makeInput(
      join(dir, 'in.txt'),
      Buffer.from('\n\n\nhello\n\n\n', 'utf8'),
    );
    const outputPath = join(dir, 'out.html');

    await txtToHtml.convert(
      input,
      { path: outputPath, format: 'html' },
      {},
      makeContext(dir),
    );

    const html = await readFile(outputPath, 'utf8');
    const document = parseHtml(html);
    const paragraphs = [...document.querySelectorAll('p')];
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]?.textContent).toBe('hello');
  });
});
