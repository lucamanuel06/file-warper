import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversionInput, ConvertContext } from '@core/types';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rtfToHtml } from './rtf-html';

const RTF = String.raw`{\rtf1\ansi\deff0
{\fonttbl{\f0\froman Times New Roman;}{\f1\fswiss Arial;}}
{\colortbl;\red0\green0\blue0;\red255\green0\blue0;}
{\*\generator Msftedit 5.41.15.1515;}
\viewkind4\uc1\pard\f0\fs24
Hello \b bold\b0  and \i italic\i0  and \ul underline\ulnone  text.\par
Second paragraph with an accent: caf\'e9.\par
}`;

function makeInput(source: string): ConversionInput {
  const buffer = Buffer.from(source, 'latin1');
  return {
    path: '/virtual/input.rtf',
    format: 'rtf',
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

describe('rtfToHtml', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rtf-html-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('converts paragraphs and basic character formatting, stripping table data', async () => {
    const outputPath = join(dir, 'out.html');
    const result = await rtfToHtml.convert(
      makeInput(RTF),
      { path: outputPath, format: 'html' },
      {},
      makeContext(),
    );

    expect(result.bytes).toBeGreaterThan(0);
    expect(result.warnings?.length).toBeGreaterThan(0);

    const html = await readFile(outputPath, 'utf8');
    const { document } = parseHTML(html);
    const paragraphs = [...document.querySelectorAll('p')];
    expect(paragraphs).toHaveLength(2);

    expect(document.querySelector('strong')?.textContent).toBe('bold');
    expect(document.querySelector('em')?.textContent).toBe('italic');
    expect(document.querySelector('u')?.textContent).toBe('underline');

    // Font table / color table / generator destination text must never leak.
    expect(html).not.toContain('Times New Roman');
    expect(html).not.toContain('Msftedit');

    // Hex escape decoded to the accented character.
    expect(document.body.textContent).toContain('café');
  });

  it('rejects input that is not RTF at all', async () => {
    await expect(
      rtfToHtml.convert(
        makeInput('this is plain text, not RTF'),
        { path: join(dir, 'out.html'), format: 'html' },
        {},
        makeContext(),
      ),
    ).rejects.toMatchObject({ code: 'E_CORRUPT_INPUT' });
  });

  it('reports availability as always true', async () => {
    await expect(rtfToHtml.availability()).resolves.toEqual({ available: true });
  });
});
