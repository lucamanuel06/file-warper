import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversionInput, ConvertContext } from '@core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { docToText } from './doc-txt';

// Real, minimal legacy .doc fixtures borrowed from word-extractor's own
// (MIT-licensed) test suite: https://github.com/morungos/node-word-extractor
// — the smallest "simple" one (word97.doc, "test05.doc" upstream) and its
// smallest corrupt-header fixture (word97-corrupt.doc, "badfile-01" upstream).
// A legacy OLE compound binary can't be hand-built inline without a
// compound-file writer library, which this project doesn't ship.
const FIXTURES_DIR = join(__dirname, 'fixtures');

function makeInput(path: string, buffer: Buffer): ConversionInput {
  return {
    path,
    format: 'doc',
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

describe('docToText', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'doc-txt-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('extracts plain text from a legacy .doc file', async () => {
    const fixturePath = join(FIXTURES_DIR, 'word97.doc');
    const buffer = await readFile(fixturePath);
    const outputPath = join(dir, 'out.txt');

    const result = await docToText.convert(
      makeInput(fixturePath, buffer),
      { path: outputPath, format: 'txt' },
      {},
      makeContext(),
    );

    const text = await readFile(outputPath, 'utf8');
    expect(text).toContain('This is a simple file created with Word 97-SR2.');
    expect(result.warnings?.[0]).toMatch(/plain text only/i);
  });

  it('rejects a corrupt legacy .doc file with E_CORRUPT_INPUT', async () => {
    const fixturePath = join(FIXTURES_DIR, 'word97-corrupt.doc');
    const buffer = await readFile(fixturePath);

    await expect(
      docToText.convert(
        makeInput(fixturePath, buffer),
        { path: join(dir, 'out.txt'), format: 'txt' },
        {},
        makeContext(),
      ),
    ).rejects.toMatchObject({ code: 'E_CORRUPT_INPUT' });
  });

  it('reports availability as always true', async () => {
    await expect(docToText.availability()).resolves.toEqual({ available: true });
  });

  it('only ever declares txt as an output (doc is read-only)', () => {
    expect(docToText.outputs).toEqual(['txt']);
  });
});
