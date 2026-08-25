import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversionInput, ConvertContext } from '@core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseHtml } from './dom';
import { xhtmlToHtml } from './xhtml-html';

const SAMPLE_XHTML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Sample</title></head>
<body><p>Hello<br/>world</p></body>
</html>
`;

function makeInput(path: string, xhtml: string): ConversionInput {
  const buf = Buffer.from(xhtml, 'utf8');
  return {
    path,
    format: 'xhtml',
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

describe('xhtml-to-html converter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fw-xhtml-html-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('declares xhtml -> html, lossless', async () => {
    expect(xhtmlToHtml.inputs).toEqual(['xhtml']);
    expect(xhtmlToHtml.outputs).toEqual(['html']);
    expect(xhtmlToHtml.cost('xhtml', 'html').retention).toBe(1.0);
    expect(await xhtmlToHtml.availability()).toEqual({ available: true });
  });

  it('produces valid, parseable HTML preserving content and structure', async () => {
    const input = makeInput(join(dir, 'in.xhtml'), SAMPLE_XHTML);
    const outputPath = join(dir, 'out.html');

    const result = await xhtmlToHtml.convert(
      input,
      { path: outputPath, format: 'html' },
      {},
      makeContext(dir),
    );

    const html = await readFile(outputPath, 'utf8');
    const document = parseHtml(html);
    expect(document.querySelector('title')?.textContent).toBe('Sample');
    const p = document.querySelector('p');
    expect(p?.textContent).toBe('Helloworld');
    expect(p?.innerHTML).toContain('<br>');
    expect(result.bytes).toBe(Buffer.byteLength(html, 'utf8'));
  });

  it('drops the XML prologue, which is not valid inside HTML output', async () => {
    const input = makeInput(join(dir, 'in.xhtml'), SAMPLE_XHTML);
    const outputPath = join(dir, 'out.html');

    await xhtmlToHtml.convert(
      input,
      { path: outputPath, format: 'html' },
      {},
      makeContext(dir),
    );

    const html = await readFile(outputPath, 'utf8');
    expect(html).not.toContain('<?xml');
  });

  it('surfaces a plain-English error for unreadable input', async () => {
    const input: ConversionInput = {
      path: join(dir, 'in.xhtml'),
      format: 'xhtml',
      size: 0,
      async readBuffer() {
        throw new Error('EACCES');
      },
      createReadStream() {
        throw new Error('not used in these tests');
      },
    };

    await expect(
      xhtmlToHtml.convert(
        input,
        { path: join(dir, 'out.html'), format: 'html' },
        {},
        makeContext(dir),
      ),
    ).rejects.toMatchObject({ code: 'E_CORRUPT_INPUT' });
  });
});
