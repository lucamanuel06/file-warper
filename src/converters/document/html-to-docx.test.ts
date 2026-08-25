import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversionInput, ConvertContext } from '@core/types';
import * as fflate from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { htmlToDocxConverter } from './html-to-docx';

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

interface DocxResult {
  readonly entries: Record<string, Uint8Array>;
  readonly documentXml: string;
  readonly warnings: readonly string[] | undefined;
}

async function convertHtml(
  dir: string,
  html: string,
  name = 'in.html',
): Promise<DocxResult> {
  const outputPath = join(dir, `${name}.docx`);
  const result = await htmlToDocxConverter.convert(
    makeInput(join(dir, name), html),
    { path: outputPath, format: 'docx' },
    {},
    makeContext(dir),
  );
  const buf = await readFile(outputPath);
  const entries = fflate.unzipSync(new Uint8Array(buf));
  const documentXml = Buffer.from(
    entries['word/document.xml'] ?? new Uint8Array(),
  ).toString('utf8');
  return { entries, documentXml, warnings: result.warnings };
}

describe('html-to-docx converter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fw-html-docx-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is always available', async () => {
    expect(await htmlToDocxConverter.availability()).toEqual({ available: true });
  });

  it('produces a real docx zip with the required OOXML entries', async () => {
    const { entries } = await convertHtml(dir, '<p>Hello</p>');
    expect(Object.keys(entries)).toContain('[Content_Types].xml');
    expect(Object.keys(entries)).toContain('word/document.xml');
  });

  // Table-driven: one tiny HTML snippet per supported tag, asserting the
  // resulting docx is valid and contains the expected text.
  const TAG_CASES: {
    readonly name: string;
    readonly html: string;
    readonly expect: string;
  }[] = [
    { name: 'h1', html: '<h1>Heading One</h1>', expect: 'Heading One' },
    { name: 'h6', html: '<h6>Heading Six</h6>', expect: 'Heading Six' },
    { name: 'p', html: '<p>A paragraph.</p>', expect: 'A paragraph.' },
    { name: 'strong', html: '<p><strong>Bold text</strong></p>', expect: 'Bold text' },
    { name: 'em', html: '<p><em>Italic text</em></p>', expect: 'Italic text' },
    { name: 'u', html: '<p><u>Underlined text</u></p>', expect: 'Underlined text' },
    { name: 's', html: '<p><s>Struck text</s></p>', expect: 'Struck text' },
    { name: 'ul/li', html: '<ul><li>One</li><li>Two</li></ul>', expect: 'One' },
    { name: 'ol/li', html: '<ol><li>First</li><li>Second</li></ol>', expect: 'First' },
    {
      name: 'table/tr/td/th',
      html: '<table><tr><th>Head</th></tr><tr><td>Cell</td></tr></table>',
      expect: 'Cell',
    },
    {
      name: 'a',
      html: '<p><a href="https://example.com">Link text</a></p>',
      expect: 'Link text',
    },
    { name: 'code', html: '<p><code>const x = 1;</code></p>', expect: 'const x = 1;' },
    {
      name: 'blockquote',
      html: '<blockquote>Quoted wisdom.</blockquote>',
      expect: 'Quoted wisdom.',
    },
  ];

  for (const testCase of TAG_CASES) {
    it(`handles <${testCase.name}>`, async () => {
      const { documentXml } = await convertHtml(
        dir,
        testCase.html,
        testCase.name.replace(/\W/g, '_'),
      );
      expect(documentXml).toContain(testCase.expect);
    });
  }

  it('handles <hr> as a bordered paragraph without throwing', async () => {
    const { documentXml } = await convertHtml(dir, '<p>Before</p><hr><p>After</p>');
    expect(documentXml).toContain('Before');
    expect(documentXml).toContain('After');
    expect(documentXml).toContain('w:bottom');
  });

  it('produces genuine word/numbering.xml for ordered lists', async () => {
    const { entries, documentXml } = await convertHtml(
      dir,
      '<ol><li>First</li><li>Second</li></ol>',
    );
    expect(Object.keys(entries)).toContain('word/numbering.xml');
    expect(documentXml).toContain('First');
    expect(documentXml).toContain('Second');
  });

  it('embeds a data: URI image', async () => {
    const png1x1 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const { entries, warnings } = await convertHtml(
      dir,
      `<p><img src="data:image/png;base64,${png1x1}" width="10" height="10"></p>`,
    );
    const mediaFiles = Object.keys(entries).filter(
      (k) => k.startsWith('word/media/') && !k.endsWith('/'),
    );
    expect(mediaFiles.length).toBe(1);
    expect(warnings).toBeUndefined();
  });

  it('drops a remote http(s) image without fetching it, and warns', async () => {
    const { entries, warnings } = await convertHtml(
      dir,
      '<p><img src="https://example.com/pic.png"></p>',
    );
    const mediaFiles = Object.keys(entries).filter(
      (k) => k.startsWith('word/media/') && !k.endsWith('/'),
    );
    expect(mediaFiles.length).toBe(0);
    expect(warnings).toBeDefined();
    expect(warnings?.some((w) => w.toLowerCase().includes('remote image'))).toBe(true);
  });

  it('drops unsupported elements and records one deduplicated warning per tag', async () => {
    const { documentXml, warnings } = await convertHtml(
      dir,
      '<p>Keep me</p><figure><img src="https://x.com/a.png"><figcaption>Cap</figcaption></figure><figure><video src="a.mp4"></video></figure>',
    );
    expect(documentXml).toContain('Keep me');
    expect(documentXml).not.toContain('Cap');
    expect(warnings).toContain('Dropped unsupported element: <figure>');
    expect(
      warnings?.filter((w) => w === 'Dropped unsupported element: <figure>').length,
    ).toBe(1);
  });

  it('keeps text from an unknown inline tag but drops its formatting, with a warning', async () => {
    const { documentXml, warnings } = await convertHtml(
      dir,
      '<p><mark>highlighted</mark></p>',
    );
    expect(documentXml).toContain('highlighted');
    expect(warnings).toContain('Dropped unsupported element: <mark>');
  });

  it('treats div/span as transparent wrappers with no warning', async () => {
    const { documentXml, warnings } = await convertHtml(
      dir,
      '<div><span>Wrapped text</span></div>',
    );
    expect(documentXml).toContain('Wrapped text');
    expect(warnings).toBeUndefined();
  });

  it('silently ignores document metadata (head/title/meta/script/style)', async () => {
    const { documentXml, warnings } = await convertHtml(
      dir,
      '<html><head><title>Doc Title</title><meta charset="utf-8"><style>p{color:red}</style><script>var x=1;</script></head><body><p>Body text</p></body></html>',
    );
    expect(documentXml).toContain('Body text');
    expect(documentXml).not.toContain('Doc Title');
    expect(documentXml).not.toContain('color:red');
    expect(warnings).toBeUndefined();
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
      htmlToDocxConverter.convert(
        makeInput(join(dir, 'in.html'), '<p>x</p>'),
        { path: join(dir, 'out.docx'), format: 'docx' },
        {},
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'E_CANCELLED' });
  });

  it('never throws for an empty document', async () => {
    const { documentXml } = await convertHtml(dir, '');
    expect(typeof documentXml).toBe('string');
  });
});
