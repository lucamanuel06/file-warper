import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversionInput, ConvertContext } from '@core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { htmlToMdConverter } from './html-to-md';

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

async function run(dir: string, html: string): Promise<string> {
  const outputPath = join(dir, 'out.md');
  await htmlToMdConverter.convert(
    makeInput(join(dir, 'in.html'), html),
    { path: outputPath, format: 'md' },
    {},
    makeContext(dir),
  );
  return readFile(outputPath, 'utf8');
}

describe('html-to-md converter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fw-html-md-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is always available', async () => {
    expect(await htmlToMdConverter.availability()).toEqual({ available: true });
  });

  it('converts headings and emphasis', async () => {
    const md = await run(
      dir,
      '<h1>Title</h1><p><strong>Bold</strong> and <em>italic</em>.</p>',
    );
    expect(md).toContain('# Title');
    expect(md).toContain('**Bold**');
    expect(md).toContain('_italic_');
  });

  it('converts a GFM table via the gfm plugin', async () => {
    const md = await run(
      dir,
      '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>',
    );
    expect(md).toContain('| A | B |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| 1 | 2 |');
  });

  it('converts strikethrough via the gfm plugin', async () => {
    const md = await run(dir, '<p><del>gone</del></p>');
    expect(md).toContain('~gone~');
  });

  it('converts unordered lists', async () => {
    const md = await run(dir, '<ul><li>One</li><li>Two</li></ul>');
    expect(md).toMatch(/-\s+One/);
    expect(md).toMatch(/-\s+Two/);
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
      htmlToMdConverter.convert(
        makeInput(join(dir, 'in.html'), '<p>x</p>'),
        { path: join(dir, 'out.md'), format: 'md' },
        {},
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'E_CANCELLED' });
  });
});
