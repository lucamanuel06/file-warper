import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversionInput, ConvertContext } from '@core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { htmlToRtfConverter } from './html-to-rtf';

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

/** No npm RTF parser is installed; verify well-formedness structurally. */
function assertBalancedRtf(rtf: string): void {
  expect(rtf.startsWith('{\\rtf1')).toBe(true);
  expect(rtf.endsWith('}')).toBe(true);
  let depth = 0;
  for (let i = 0; i < rtf.length; i++) {
    const ch = rtf[i];
    if (ch === '\\') {
      i++; // skip the escaped/control character following a backslash
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    expect(depth).toBeGreaterThanOrEqual(0);
  }
  expect(depth).toBe(0);
}

async function convertRtf(
  dir: string,
  html: string,
): Promise<{ rtf: string; warnings: string[] }> {
  const outputPath = join(dir, 'out.rtf');
  const result = await htmlToRtfConverter.convert(
    makeInput(join(dir, 'in.html'), html),
    { path: outputPath, format: 'rtf' },
    {},
    makeContext(dir),
  );
  const rtf = await readFile(outputPath, 'utf8');
  assertBalancedRtf(rtf);
  return { rtf, warnings: result.warnings ?? [] };
}

describe('html-to-rtf converter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fw-html-rtf-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('declares html -> rtf', async () => {
    expect(htmlToRtfConverter.inputs).toEqual(['html']);
    expect(htmlToRtfConverter.outputs).toEqual(['rtf']);
    expect(await htmlToRtfConverter.availability()).toEqual({ available: true });
  });

  const cases: { name: string; html: string; expectControlWords: string[] }[] = [
    { name: 'h1', html: '<h1>Title</h1>', expectControlWords: ['\\fs56', '\\b'] },
    { name: 'p', html: '<p>Hello world</p>', expectControlWords: ['\\pard'] },
    {
      name: 'strong',
      html: '<p><strong>bold</strong></p>',
      expectControlWords: ['\\b '],
    },
    { name: 'em', html: '<p><em>italic</em></p>', expectControlWords: ['\\i '] },
    { name: 'u', html: '<p><u>underline</u></p>', expectControlWords: ['\\ul '] },
    { name: 's', html: '<p><s>struck</s></p>', expectControlWords: ['\\strike'] },
    { name: 'code', html: '<p><code>x = 1</code></p>', expectControlWords: ['\\f1'] },
    {
      name: 'blockquote',
      html: '<blockquote>quoted</blockquote>',
      expectControlWords: ['\\li720'],
    },
    { name: 'hr', html: '<hr>', expectControlWords: ['\\brdrb'] },
  ];

  it.each(cases)(
    'maps <$name> to the expected RTF control words',
    async ({ html, expectControlWords }) => {
      const { rtf } = await convertRtf(dir, html);
      for (const word of expectControlWords) {
        expect(rtf).toContain(word);
      }
    },
  );

  it('maps unordered and ordered lists with markers per item', async () => {
    const html =
      '<ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>';
    const { rtf } = await convertRtf(dir, html);
    expect(rtf).toContain('\\bullet');
    expect(rtf).toContain('1.');
    expect(rtf).toContain('2.');
  });

  it('renders table rows as tab-separated cells', async () => {
    const html =
      '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>';
    const { rtf } = await convertRtf(dir, html);
    expect(rtf).toContain('A \\tab B');
    expect(rtf).toContain('1 \\tab 2');
  });

  it('turns an http(s) link into an RTF hyperlink field', async () => {
    const html = '<p><a href="https://example.com">Example</a></p>';
    const { rtf } = await convertRtf(dir, html);
    expect(rtf).toContain('HYPERLINK "https://example.com"');
    expect(rtf).toContain('Example');
  });

  it('drops images with a warning instead of embedding them', async () => {
    const html = '<p><img src="data:image/png;base64,AAAA"></p>';
    const { rtf, warnings } = await convertRtf(dir, html);
    expect(rtf).not.toContain('img');
    expect(warnings.some((w) => /image/i.test(w))).toBe(true);
  });

  it('drops unsupported tags but keeps their text, with a deduplicated warning', async () => {
    const html =
      '<figure><figcaption>caption one</figcaption></figure><figure><figcaption>caption two</figcaption></figure>';
    const { rtf, warnings } = await convertRtf(dir, html);
    expect(rtf).toContain('caption one');
    expect(rtf).toContain('caption two');
    const figureWarnings = warnings.filter((w) => w.includes('<figure>'));
    expect(figureWarnings).toHaveLength(1);
  });

  it('escapes RTF control characters and non-ASCII text safely', async () => {
    const html = '<p>Backslash \\ and braces { } and café €</p>';
    const { rtf } = await convertRtf(dir, html);
    expect(rtf).toContain('\\\\');
    expect(rtf).toContain('\\{');
    expect(rtf).toContain('\\{');
    expect(rtf).toContain('\\u233?'); // é
    expect(rtf).toContain('\\u8364?'); // €
  });

  it('surfaces a plain-English error for unparseable input', async () => {
    const input: ConversionInput = {
      path: join(dir, 'in.html'),
      format: 'html',
      size: 0,
      async readBuffer() {
        throw new Error('boom');
      },
      createReadStream() {
        throw new Error('not used in these tests');
      },
    };
    await expect(
      htmlToRtfConverter.convert(
        input,
        { path: join(dir, 'out.rtf'), format: 'rtf' },
        {},
        makeContext(dir),
      ),
    ).rejects.toMatchObject({ code: 'E_CORRUPT_INPUT' });
  });
});
