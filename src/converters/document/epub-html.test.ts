import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversionInput, ConvertContext } from '@core/types';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseHtml } from './dom';
import { epubToHtml } from './epub-html';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const CONTENT_OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">Test Book</dc:title></metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="img1" href="images/cover.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`;

const CH1_XHTML = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body><h1>Chapter One</h1><p>First chapter text.</p><img src="images/cover.png" alt="cover"/></body>
</html>`;

const CH2_XHTML = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body><h1>Chapter Two</h1><p>Second chapter text.</p></body>
</html>`;

function buildFixtureEpub(): Buffer {
  const zipBytes = zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(CONTAINER_XML),
    'OEBPS/content.opf': strToU8(CONTENT_OPF),
    'OEBPS/ch1.xhtml': strToU8(CH1_XHTML),
    'OEBPS/ch2.xhtml': strToU8(CH2_XHTML),
    'OEBPS/images/cover.png': new Uint8Array(TINY_PNG),
  });
  return Buffer.from(zipBytes);
}

function makeInput(buffer: Buffer): ConversionInput {
  return {
    path: '/virtual/input.epub',
    format: 'epub',
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

describe('epubToHtml', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'epub-html-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('concatenates chapters in spine order, inlining images', async () => {
    const outputPath = join(dir, 'out.html');
    const result = await epubToHtml.convert(
      makeInput(buildFixtureEpub()),
      { path: outputPath, format: 'html' },
      {},
      makeContext(),
    );
    expect(result.meta).toMatchObject({ chapterCount: 2 });

    const html = await readFile(outputPath, 'utf8');
    const document = parseHtml(html);
    const sections = [...document.querySelectorAll('section')];
    expect(sections).toHaveLength(2);
    expect(sections[0]?.querySelector('h1')?.textContent).toBe('Chapter One');
    expect(sections[1]?.querySelector('h1')?.textContent).toBe('Chapter Two');
    expect(html.indexOf('Chapter One')).toBeLessThan(html.indexOf('Chapter Two'));

    const img = sections[0]?.querySelector('img');
    expect(img?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  });

  it('rejects an EPUB missing META-INF/container.xml', async () => {
    const zipBytes = zipSync({ mimetype: strToU8('application/epub+zip') });
    await expect(
      epubToHtml.convert(
        makeInput(Buffer.from(zipBytes)),
        { path: join(dir, 'out.html'), format: 'html' },
        {},
        makeContext(),
      ),
    ).rejects.toMatchObject({ code: 'E_CORRUPT_INPUT' });
  });

  it('reports availability as always true', async () => {
    await expect(epubToHtml.availability()).resolves.toEqual({ available: true });
  });
});
