import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversionInput, ConvertContext } from '@core/types';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mdToHtml } from './md-html';

const MARKDOWN = `# Title

Some **bold** and *italic* text.

- one
- two

| A | B |
|---|---|
| 1 | 2 |
`;

function makeInput(source: string): ConversionInput {
  const buffer = Buffer.from(source, 'utf8');
  return {
    path: '/virtual/input.md',
    format: 'md',
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

describe('mdToHtml', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'md-html-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('converts GFM markdown into well-formed HTML with expected structure', async () => {
    const outputPath = join(dir, 'out.html');
    const result = await mdToHtml.convert(
      makeInput(MARKDOWN),
      { path: outputPath, format: 'html' },
      {},
      makeContext(),
    );

    expect(result.bytes).toBeGreaterThan(0);

    const html = await readFile(outputPath, 'utf8');
    expect(html).toContain('<!doctype html>');

    const { document } = parseHTML(html);
    expect(document.querySelector('h1')?.textContent).toBe('Title');
    expect(document.querySelector('strong')?.textContent).toBe('bold');
    expect(document.querySelector('em')?.textContent).toBe('italic');
    expect(document.querySelectorAll('li')).toHaveLength(2);
    // GFM table support.
    expect(document.querySelector('table')).not.toBeNull();
    expect(document.querySelectorAll('td')).toHaveLength(2);
  });

  it('reports availability as always true (pure JS, no binaries)', async () => {
    await expect(mdToHtml.availability()).resolves.toEqual({ available: true });
  });

  it('declares a near-lossless cost', () => {
    const cost = mdToHtml.cost('md', 'html');
    expect(cost.retention).toBeGreaterThan(0.9);
  });
});
