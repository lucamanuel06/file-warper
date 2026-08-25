import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversionInput, ConvertContext } from '@core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { htmlToTxtConverter } from './html-to-txt';

function makeInput(path: string, html: string): ConversionInput {
  const buf = Buffer.from(html, 'utf8');
  return {
    path,
    format: 'html',
    size: buf.byteLength,
    async readBuffer() {
      return buf;
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

describe('html-to-txt converter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fw-html-txt-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is always available', async () => {
    expect(await htmlToTxtConverter.availability()).toEqual({ available: true });
  });

  it('strips markup and keeps the readable text', async () => {
    const html = '<html><body><h1>Title</h1><p>Hello <b>world</b>.</p></body></html>';
    const input = makeInput(join(dir, 'in.html'), html);
    const outputPath = join(dir, 'out.txt');

    const result = await htmlToTxtConverter.convert(
      input,
      { path: outputPath, format: 'txt' },
      {},
      makeContext(dir),
    );

    const text = await readFile(outputPath, 'utf8');
    expect(text).toMatch(/title/i);
    expect(text).toContain('Hello world.');
    expect(text).not.toContain('<');
    expect(text).not.toContain('>');
    expect(result.bytes).toBe(Buffer.byteLength(text, 'utf8'));
  });

  it('renders links with their href alongside the text', async () => {
    const html = '<a href="https://example.com">Example</a>';
    const input = makeInput(join(dir, 'in.html'), html);
    const outputPath = join(dir, 'out.txt');

    await htmlToTxtConverter.convert(
      input,
      { path: outputPath, format: 'txt' },
      {},
      makeContext(dir),
    );

    const text = await readFile(outputPath, 'utf8');
    expect(text).toContain('Example');
    expect(text).toContain('https://example.com');
  });

  it('throws a ConversionError when the conversion is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx: ConvertContext = {
      onProgress() {},
      signal: controller.signal,
      scratchDir: dir,
      log() {},
    };

    await expect(
      htmlToTxtConverter.convert(
        makeInput(join(dir, 'in.html'), '<p>x</p>'),
        { path: join(dir, 'out.txt'), format: 'txt' },
        {},
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'E_CANCELLED' });
  });
});
