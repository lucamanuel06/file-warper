import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversionInput, ConvertContext } from '@core/types';
import * as fflate from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { htmlToEpubConverter } from './html-to-epub';

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

describe('html-to-epub converter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fw-html-epub-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is always available', async () => {
    expect(await htmlToEpubConverter.availability()).toEqual({ available: true });
  });

  it('produces a valid EPUB zip: mimetype first and uncompressed, plus container.xml', async () => {
    const outputPath = join(dir, 'out.epub');
    await htmlToEpubConverter.convert(
      makeInput(
        join(dir, 'in.html'),
        '<html><head><title>My Book</title></head><body><p>Hello world</p></body></html>',
      ),
      { path: outputPath, format: 'epub' },
      {},
      makeContext(dir),
    );

    const buf = await readFile(outputPath);
    const entries = fflate.unzipSync(new Uint8Array(buf));
    const names = Object.keys(entries);

    expect(names[0]).toBe('mimetype');
    expect(Buffer.from(entries.mimetype ?? new Uint8Array()).toString('utf8')).toBe(
      'application/epub+zip',
    );
    expect(names).toContain('META-INF/container.xml');
  });

  it('embeds the chapter text', async () => {
    const outputPath = join(dir, 'out.epub');
    await htmlToEpubConverter.convert(
      makeInput(join(dir, 'in.html'), '<p>A unique sentence for testing.</p>'),
      { path: outputPath, format: 'epub' },
      {},
      makeContext(dir),
    );

    const buf = await readFile(outputPath);
    const entries = fflate.unzipSync(new Uint8Array(buf));
    const chapterKey = Object.keys(entries).find(
      (k) => k.startsWith('OEBPS/') && k.endsWith('.xhtml') && !k.includes('toc'),
    );
    expect(chapterKey).toBeDefined();
    const chapterHtml = Buffer.from(
      entries[chapterKey as string] ?? new Uint8Array(),
    ).toString('utf8');
    expect(chapterHtml).toContain('A unique sentence for testing.');
  });

  it('passes data: URI images through untouched, with no warning', async () => {
    const png1x1 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const outputPath = join(dir, 'out.epub');
    const result = await htmlToEpubConverter.convert(
      makeInput(
        join(dir, 'in.html'),
        `<p>Pic</p><img src="data:image/png;base64,${png1x1}">`,
      ),
      { path: outputPath, format: 'epub' },
      {},
      makeContext(dir),
    );

    const buf = await readFile(outputPath);
    const entries = fflate.unzipSync(new Uint8Array(buf));
    const chapterKey = Object.keys(entries).find(
      (k) => k.startsWith('OEBPS/') && k.endsWith('.xhtml') && !k.includes('toc'),
    );
    const chapterHtml = Buffer.from(
      entries[chapterKey as string] ?? new Uint8Array(),
    ).toString('utf8');
    expect(chapterHtml).toContain('data:image/png;base64');
    expect(result.warnings).toBeUndefined();
  });

  it('strips remote http(s) images before handing HTML to the library, and warns', async () => {
    const outputPath = join(dir, 'out.epub');
    const result = await htmlToEpubConverter.convert(
      makeInput(
        join(dir, 'in.html'),
        '<p>Text</p><img src="https://example.com/pic.png"><img src="http://example.com/pic2.png">',
      ),
      { path: outputPath, format: 'epub' },
      {},
      makeContext(dir),
    );

    const buf = await readFile(outputPath);
    const entries = fflate.unzipSync(new Uint8Array(buf));
    const chapterKey = Object.keys(entries).find(
      (k) => k.startsWith('OEBPS/') && k.endsWith('.xhtml') && !k.includes('toc'),
    );
    const chapterHtml = Buffer.from(
      entries[chapterKey as string] ?? new Uint8Array(),
    ).toString('utf8');
    expect(chapterHtml).not.toContain('example.com');
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.some((w) => w.includes('Removed 2 remote image'))).toBe(true);
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
      htmlToEpubConverter.convert(
        makeInput(join(dir, 'in.html'), '<p>x</p>'),
        { path: join(dir, 'out.epub'), format: 'epub' },
        {},
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'E_CANCELLED' });
  });
});
