import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeFile } from '@core/detect';
import { getFormat } from '@core/formats';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GENERATED_FORMATS, getFixturePath } from '../fixtures/generators';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'warp-detect-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('probeFile — every generated fixture detects back to its own format', () => {
  for (const formatId of GENERATED_FORMATS) {
    it(`detects ${formatId}`, async () => {
      const fixturePath = await getFixturePath(formatId);
      const result = await probeFile(fixturePath);
      expect(result.format).toBe(formatId);
      expect(result.category).toBe(getFormat(formatId)?.category ?? null);
      expect(['magic', 'extension', 'sniff']).toContain(result.confidence);
    }, 30_000);
  }
});

describe('probeFile — magic bytes trusted over a lying extension', () => {
  it('flags a PNG saved with a .jpg extension and still identifies it correctly', async () => {
    const pngPath = await getFixturePath('png');
    const misnamed = join(dir, 'photo.jpg');
    writeFileSync(misnamed, readFileSync(pngPath));

    const result = await probeFile(misnamed);
    expect(result.format).toBe('png');
    expect(result.confidence).toBe('magic');
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe('probeFile — three-stage fallback', () => {
  it('falls back to extension when there is no magic signature', async () => {
    const p = join(dir, 'notes.md');
    writeFileSync(p, '# only extension, no magic, no obvious sniff shape\n');
    const result = await probeFile(p);
    expect(result.format).toBe('md');
    expect(result.confidence).toBe('extension');
  });

  it('sniffs JSON content with an unknown extension', async () => {
    const p = join(dir, 'data.unknownext');
    writeFileSync(p, '{"a": 1, "b": [1, 2, 3]}\n');
    const result = await probeFile(p);
    expect(result.format).toBe('json');
    expect(result.confidence).toBe('sniff');
  });

  it('sniffs YAML only when it looks structural, not for plain scalar text', async () => {
    const plain = join(dir, 'plain.unknownext');
    writeFileSync(plain, 'just a normal sentence with no structure at all\n');
    const plainResult = await probeFile(plain);
    expect(plainResult.format).toBe('txt');

    const yamlLike = join(dir, 'struct.unknownext');
    writeFileSync(yamlLike, 'a: 1\nb: 2\nc:\n  - 1\n  - 2\n');
    const yamlResult = await probeFile(yamlLike);
    expect(yamlResult.format).toBe('yaml');
  });

  it('sniffs CSV by consistent delimiter counts', async () => {
    const p = join(dir, 'sheet.unknownext');
    writeFileSync(p, 'a,b,c\n1,2,3\n4,5,6\n');
    const result = await probeFile(p);
    expect(result.format).toBe('csv');
    expect(result.confidence).toBe('sniff');
  });

  it('sniffs NDJSON as distinct from a single JSON document', async () => {
    const p = join(dir, 'log.unknownext');
    writeFileSync(p, '{"a":1}\n{"a":2}\n{"a":3}\n');
    const result = await probeFile(p);
    expect(result.format).toBe('jsonl');
  });

  it('falls back to txt for unrecognisable content with an unknown extension', async () => {
    const p = join(dir, 'mystery.unknownext');
    writeFileSync(p, 'hello there, this is just prose.\n');
    const result = await probeFile(p);
    expect(result.format).toBe('txt');
    expect(result.confidence).toBe('sniff');
  });

  it('reports null format for genuinely unidentifiable binary garbage', async () => {
    const p = join(dir, 'mystery.bin');
    writeFileSync(p, Buffer.from([0x01, 0x02, 0x00, 0x03, 0xff, 0x10, 0x00, 0x00, 0x9a]));
    const result = await probeFile(p);
    expect(result.format).toBeNull();
    expect(result.confidence).toBe('none');
  });
});

describe('probeFile — zip-family disambiguation', () => {
  it('tells a real docx apart from a plain zip', async () => {
    const docxPath = await getFixturePath('docx');
    const result = await probeFile(docxPath);
    expect(result.format).toBe('docx');
  });

  it('tells a real xlsx apart from a plain zip', async () => {
    const xlsxPath = await getFixturePath('xlsx');
    const result = await probeFile(xlsxPath);
    expect(result.format).toBe('xlsx');
  });

  it('a plain zip with no office markers stays "zip"', async () => {
    const zipPath = await getFixturePath('zip');
    const result = await probeFile(zipPath);
    expect(result.format).toBe('zip');
  });
});

describe('probeFile — ambiguous same-specificity magic groups resolve via extension', () => {
  it('mkv and webm share EBML magic but resolve via extension', async () => {
    const mkvResult = await probeFile(await getFixturePath('mkv'));
    const webmResult = await probeFile(await getFixturePath('webm'));
    expect(mkvResult.format).toBe('mkv');
    expect(webmResult.format).toBe('webm');
  });

  it('legacy OLE doc/xls/ppt share identical magic but resolve via extension', async () => {
    const doc = await probeFile(await getFixturePath('doc'));
    const xls = await probeFile(await getFixturePath('xls'));
    const ppt = await probeFile(await getFixturePath('ppt'));
    expect(doc.format).toBe('doc');
    expect(xls.format).toBe('xls');
    expect(ppt.format).toBe('ppt');
  });
});
