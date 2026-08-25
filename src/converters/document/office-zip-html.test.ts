import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversionInput, ConvertContext } from '@core/types';
import { strToU8, zipSync } from 'fflate';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { odpToHtml, odtToHtml, pptxToHtml } from './office-zip-html';

// A real 1x1 transparent PNG, used to exercise the data-URI image inlining
// path for ODT and PPTX without shipping a real binary fixture.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function makeInput(buffer: Buffer, format: string): ConversionInput {
  return {
    path: `/virtual/input.${format}`,
    format,
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

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'office-zip-html-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('odtToHtml', () => {
  it('converts headings, paragraphs, lists, and an inline image', async () => {
    const contentXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
    xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
    xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
    xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
    xmlns:xlink="http://www.w3.org/1999/xlink">
  <office:body>
    <office:text>
      <text:h text:outline-level="1">Title Heading</text:h>
      <text:p>Hello <text:span>world</text:span>.</text:p>
      <text:list>
        <text:list-item><text:p>Item one</text:p></text:list-item>
        <text:list-item><text:p>Item two</text:p></text:list-item>
      </text:list>
      <text:p><draw:frame><draw:image xlink:href="Pictures/dot.png"/></draw:frame></text:p>
    </office:text>
  </office:body>
</office:document-content>`;

    const zipBytes = zipSync({
      mimetype: strToU8('application/vnd.oasis.opendocument.text'),
      'content.xml': strToU8(contentXml),
      'Pictures/dot.png': new Uint8Array(TINY_PNG),
    });
    const input = makeInput(Buffer.from(zipBytes), 'odt');
    const outputPath = join(dir, 'out.html');

    const result = await odtToHtml.convert(
      input,
      { path: outputPath, format: 'html' },
      {},
      makeContext(),
    );
    expect(result.bytes).toBeGreaterThan(0);

    const { readFile } = await import('node:fs/promises');
    const html = await readFile(outputPath, 'utf8');
    const { document } = parseHTML(html);

    expect(document.querySelector('h1')?.textContent).toBe('Title Heading');
    expect(document.querySelector('p')?.textContent).toBe('Hello world.');
    expect(document.querySelectorAll('li')).toHaveLength(2);
    expect(document.querySelectorAll('li')[0]?.textContent).toBe('Item one');

    const img = document.querySelector('img');
    expect(img?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  });

  it('rejects an input that is not a valid zip', async () => {
    const bad = Buffer.from('not a zip file');
    await expect(
      odtToHtml.convert(
        makeInput(bad, 'odt'),
        { path: join(dir, 'out.html'), format: 'html' },
        {},
        makeContext(),
      ),
    ).rejects.toMatchObject({ code: 'E_CORRUPT_INPUT' });
  });

  it('reports availability as always true', async () => {
    await expect(odtToHtml.availability()).resolves.toEqual({ available: true });
  });
});

describe('odpToHtml', () => {
  it('renders each draw:page as an ordered <section>', async () => {
    const contentXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
    xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
    xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
    xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body>
    <office:presentation>
      <draw:page draw:name="page1">
        <draw:frame><draw:text-box><text:p>Slide one text</text:p></draw:text-box></draw:frame>
      </draw:page>
      <draw:page draw:name="page2">
        <draw:frame><draw:text-box><text:p>Slide two text</text:p></draw:text-box></draw:frame>
      </draw:page>
    </office:presentation>
  </office:body>
</office:document-content>`;

    const zipBytes = zipSync({
      mimetype: strToU8('application/vnd.oasis.opendocument.presentation'),
      'content.xml': strToU8(contentXml),
    });
    const outputPath = join(dir, 'out.html');

    const result = await odpToHtml.convert(
      makeInput(Buffer.from(zipBytes), 'odp'),
      { path: outputPath, format: 'html' },
      {},
      makeContext(),
    );
    expect(result.meta).toMatchObject({ slideCount: 2 });

    const { readFile } = await import('node:fs/promises');
    const html = await readFile(outputPath, 'utf8');
    const { document } = parseHTML(html);
    const sections = [...document.querySelectorAll('section')];
    expect(sections).toHaveLength(2);
    expect(sections[0]?.textContent).toContain('Slide one text');
    expect(sections[1]?.textContent).toContain('Slide two text');
  });

  it('reports availability as always true', async () => {
    await expect(odpToHtml.availability()).resolves.toEqual({ available: true });
  });
});

describe('pptxToHtml', () => {
  it('renders slides in numeric order with inlined images', async () => {
    function slideXml(text: string, withPic: boolean): string {
      const pic = withPic
        ? `<p:pic><p:blipFill><a:blip r:embed="rId1"/></p:blipFill></p:pic>`
        : '';
      return `<?xml version="1.0" encoding="UTF-8"?>
<p:sld
    xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
    xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
    xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld>
    <p:spTree>
      <p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>
      ${pic}
    </p:spTree>
  </p:cSld>
</p:sld>`;
    }

    const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
</Relationships>`;

    const zipBytes = zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'ppt/slides/slide1.xml': strToU8(slideXml('First slide', true)),
      'ppt/slides/slide2.xml': strToU8(slideXml('Second slide', false)),
      // Deliberately out of lexical order but in numeric order, to prove
      // sorting is numeric ("slide10" < "slide2" lexically).
      'ppt/slides/slide10.xml': strToU8(slideXml('Tenth slide', false)),
      'ppt/slides/_rels/slide1.xml.rels': strToU8(rels),
      'ppt/media/image1.png': new Uint8Array(TINY_PNG),
    });
    const outputPath = join(dir, 'out.html');

    const result = await pptxToHtml.convert(
      makeInput(Buffer.from(zipBytes), 'pptx'),
      { path: outputPath, format: 'html' },
      {},
      makeContext(),
    );
    expect(result.meta).toMatchObject({ slideCount: 3 });

    const { readFile } = await import('node:fs/promises');
    const html = await readFile(outputPath, 'utf8');
    const { document } = parseHTML(html);
    const sections = [...document.querySelectorAll('section')];
    expect(sections).toHaveLength(3);
    expect(sections[0]?.textContent).toContain('First slide');
    expect(sections[1]?.textContent).toContain('Second slide');
    expect(sections[2]?.textContent).toContain('Tenth slide');

    const img = sections[0]?.querySelector('img');
    expect(img?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  });

  it('reports availability as always true', async () => {
    await expect(pptxToHtml.availability()).resolves.toEqual({ available: true });
  });
});
