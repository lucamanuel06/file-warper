import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversionInput, ConvertContext } from '@core/types';
import {
  read as readWorkbookBuffer,
  write as writeWorkbookBuffer,
  utils as xlsxUtils,
} from '@e965/xlsx';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spreadsheetReadConverter, spreadsheetWriteConverter } from './spreadsheet';

function makeInput(
  path: string,
  format: string,
  content: Buffer | string,
): ConversionInput {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return {
    path,
    format,
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

function buildWorkbookBuffer(
  sheets: Record<string, (string | number)[][]>,
  bookType: 'xlsx' | 'biff8' | 'ods',
): Buffer {
  const wb = xlsxUtils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    xlsxUtils.book_append_sheet(wb, xlsxUtils.aoa_to_sheet(rows), name);
  }
  return writeWorkbookBuffer(wb, { type: 'buffer', bookType }) as Buffer;
}

describe('spreadsheet converters', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fw-spreadsheet-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('are always available', async () => {
    expect(await spreadsheetReadConverter.availability()).toEqual({ available: true });
    expect(await spreadsheetWriteConverter.availability()).toEqual({ available: true });
  });

  describe('read: xlsx/xls/ods -> csv/tsv/json/html', () => {
    it('converts a single-sheet xlsx to csv', async () => {
      const buf = buildWorkbookBuffer(
        {
          Sheet1: [
            ['Name', 'Score'],
            ['Alice', '42'],
          ],
        },
        'xlsx',
      );
      const outputPath = join(dir, 'out.csv');
      const result = await spreadsheetReadConverter.convert(
        makeInput(join(dir, 'in.xlsx'), 'xlsx', buf),
        { path: outputPath, format: 'csv' },
        {},
        makeContext(dir),
      );
      const csv = await readFile(outputPath, 'utf8');
      expect(csv).toContain('Name,Score');
      expect(csv).toContain('Alice,42');
      expect(result.warnings).toBeUndefined();
    });

    it('converts an xls (BIFF8) workbook to tsv', async () => {
      const buf = buildWorkbookBuffer(
        {
          Data: [
            ['a', 'b'],
            ['1', '2'],
          ],
        },
        'biff8',
      );
      const outputPath = join(dir, 'out.tsv');
      await spreadsheetReadConverter.convert(
        makeInput(join(dir, 'in.xls'), 'xls', buf),
        { path: outputPath, format: 'tsv' },
        {},
        makeContext(dir),
      );
      const tsv = await readFile(outputPath, 'utf8');
      expect(tsv).toContain('a\tb');
      expect(tsv).toContain('1\t2');
    });

    it('converts an ods workbook to csv', async () => {
      const buf = buildWorkbookBuffer(
        {
          Sheet1: [
            ['x', 'y'],
            ['3', '4'],
          ],
        },
        'ods',
      );
      const outputPath = join(dir, 'out.csv');
      await spreadsheetReadConverter.convert(
        makeInput(join(dir, 'in.ods'), 'ods', buf),
        { path: outputPath, format: 'csv' },
        {},
        makeContext(dir),
      );
      const csv = await readFile(outputPath, 'utf8');
      expect(csv).toContain('x,y');
      expect(csv).toContain('3,4');
    });

    it('warns and keeps only the first sheet for csv/tsv/json targets', async () => {
      const buf = buildWorkbookBuffer(
        { First: [['a'], ['1']], Second: [['b'], ['2']] },
        'xlsx',
      );
      const result = await spreadsheetReadConverter.convert(
        makeInput(join(dir, 'in.xlsx'), 'xlsx', buf),
        { path: join(dir, 'out.csv'), format: 'csv' },
        {},
        makeContext(dir),
      );
      expect(result.warnings).toEqual([
        'Only the first sheet ("First") was converted; 1 other sheet(s) were dropped.',
      ]);
    });

    it('renders every sheet as its own table for the html target', async () => {
      const buf = buildWorkbookBuffer(
        { First: [['a'], ['1']], Second: [['b'], ['2']] },
        'xlsx',
      );
      const outputPath = join(dir, 'out.html');
      const result = await spreadsheetReadConverter.convert(
        makeInput(join(dir, 'in.xlsx'), 'xlsx', buf),
        { path: outputPath, format: 'html' },
        {},
        makeContext(dir),
      );
      const html = await readFile(outputPath, 'utf8');
      expect(html).toContain('<h2>First</h2>');
      expect(html).toContain('<h2>Second</h2>');
      expect((html.match(/<table>/g) ?? []).length).toBe(2);
      expect(result.warnings).toBeUndefined();
    });

    it('renders the json target as an array of objects keyed by the header row', async () => {
      const buf = buildWorkbookBuffer(
        {
          Sheet1: [
            ['Name', 'Score'],
            ['Alice', '42'],
          ],
        },
        'xlsx',
      );
      const outputPath = join(dir, 'out.json');
      await spreadsheetReadConverter.convert(
        makeInput(join(dir, 'in.xlsx'), 'xlsx', buf),
        { path: outputPath, format: 'json' },
        {},
        makeContext(dir),
      );
      const parsed = JSON.parse(await readFile(outputPath, 'utf8'));
      expect(parsed).toEqual([{ Name: 'Alice', Score: '42' }]);
    });

    it('throws E_CORRUPT_INPUT for a corrupt zip container', async () => {
      // Valid zip local-file-header magic bytes followed by garbage — enough
      // to be recognised as an xlsx/ods container but fail to parse.
      const corrupt = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]);
      await expect(
        spreadsheetReadConverter.convert(
          makeInput(join(dir, 'in.xlsx'), 'xlsx', corrupt),
          { path: join(dir, 'out.csv'), format: 'csv' },
          {},
          makeContext(dir),
        ),
      ).rejects.toMatchObject({ code: 'E_CORRUPT_INPUT' });
    });
  });

  describe('write: csv/tsv/json/html -> xlsx', () => {
    async function readBackFirstSheet(xlsxPath: string): Promise<string[][]> {
      const buf = await readFile(xlsxPath);
      const wb = readWorkbookBuffer(buf, { type: 'buffer' });
      const name = wb.SheetNames[0];
      if (!name) return [];
      const sheet = wb.Sheets[name];
      if (!sheet) return [];
      return xlsxUtils.sheet_to_json(sheet, {
        header: 1,
        raw: false,
        defval: '',
      }) as string[][];
    }

    it('writes a real xlsx zip with the expected OOXML entries', async () => {
      const outputPath = join(dir, 'out.xlsx');
      await spreadsheetWriteConverter.convert(
        makeInput(join(dir, 'in.csv'), 'csv', 'a,b\n1,2\n'),
        { path: outputPath, format: 'xlsx' },
        {},
        makeContext(dir),
      );
      const buf = await readFile(outputPath);
      const fflate = await import('fflate');
      const entries = fflate.unzipSync(new Uint8Array(buf));
      expect(Object.keys(entries)).toContain('[Content_Types].xml');
      expect(Object.keys(entries).some((k) => k.startsWith('xl/worksheets/'))).toBe(true);
    });

    it('parses csv rows and round-trips cell values', async () => {
      const outputPath = join(dir, 'out.xlsx');
      await spreadsheetWriteConverter.convert(
        makeInput(join(dir, 'in.csv'), 'csv', 'a,b\n1,2\n3,4\n'),
        { path: outputPath, format: 'xlsx' },
        {},
        makeContext(dir),
      );
      expect(await readBackFirstSheet(outputPath)).toEqual([
        ['a', 'b'],
        ['1', '2'],
        ['3', '4'],
      ]);
    });

    it('parses tsv rows', async () => {
      const outputPath = join(dir, 'out.xlsx');
      await spreadsheetWriteConverter.convert(
        makeInput(join(dir, 'in.tsv'), 'tsv', 'a\tb\n1\t2\n'),
        { path: outputPath, format: 'xlsx' },
        {},
        makeContext(dir),
      );
      expect(await readBackFirstSheet(outputPath)).toEqual([
        ['a', 'b'],
        ['1', '2'],
      ]);
    });

    it('parses a JSON array of flat objects, deriving headers in first-seen order', async () => {
      const outputPath = join(dir, 'out.xlsx');
      const json = JSON.stringify([
        { Name: 'Alice', Score: 42 },
        { Name: 'Bob', Score: 7, Extra: 'x' },
      ]);
      await spreadsheetWriteConverter.convert(
        makeInput(join(dir, 'in.json'), 'json', json),
        { path: outputPath, format: 'xlsx' },
        {},
        makeContext(dir),
      );
      expect(await readBackFirstSheet(outputPath)).toEqual([
        ['Name', 'Score', 'Extra'],
        ['Alice', '42', ''],
        ['Bob', '7', 'x'],
      ]);
    });

    it('parses a JSON array of arrays verbatim', async () => {
      const outputPath = join(dir, 'out.xlsx');
      const json = JSON.stringify([
        ['a', 'b'],
        ['1', '2'],
      ]);
      await spreadsheetWriteConverter.convert(
        makeInput(join(dir, 'in.json'), 'json', json),
        { path: outputPath, format: 'xlsx' },
        {},
        makeContext(dir),
      );
      expect(await readBackFirstSheet(outputPath)).toEqual([
        ['a', 'b'],
        ['1', '2'],
      ]);
    });

    it('parses the first table found in an html file', async () => {
      const outputPath = join(dir, 'out.xlsx');
      const html =
        '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>';
      await spreadsheetWriteConverter.convert(
        makeInput(join(dir, 'in.html'), 'html', html),
        { path: outputPath, format: 'xlsx' },
        {},
        makeContext(dir),
      );
      expect(await readBackFirstSheet(outputPath)).toEqual([
        ['A', 'B'],
        ['1', '2'],
      ]);
    });

    it('throws E_CORRUPT_INPUT for malformed JSON', async () => {
      await expect(
        spreadsheetWriteConverter.convert(
          makeInput(join(dir, 'in.json'), 'json', '{not valid json'),
          { path: join(dir, 'out.xlsx'), format: 'xlsx' },
          {},
          makeContext(dir),
        ),
      ).rejects.toMatchObject({ code: 'E_CORRUPT_INPUT' });
    });

    it('throws E_CORRUPT_INPUT when the html file has no table', async () => {
      await expect(
        spreadsheetWriteConverter.convert(
          makeInput(join(dir, 'in.html'), 'html', '<p>no table here</p>'),
          { path: join(dir, 'out.xlsx'), format: 'xlsx' },
          {},
          makeContext(dir),
        ),
      ).rejects.toMatchObject({ code: 'E_CORRUPT_INPUT' });
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
        spreadsheetWriteConverter.convert(
          makeInput(join(dir, 'in.csv'), 'csv', 'a,b\n1,2\n'),
          { path: join(dir, 'out.xlsx'), format: 'xlsx' },
          {},
          ctx,
        ),
      ).rejects.toMatchObject({ code: 'E_CANCELLED' });
    });
  });

  describe('write: csv/tsv/json/html -> ods', () => {
    it('writes a real ods zip with a stored mimetype entry and content.xml', async () => {
      const outputPath = join(dir, 'out.ods');
      await spreadsheetWriteConverter.convert(
        makeInput(join(dir, 'in.csv'), 'csv', 'a,b\n1,2\n'),
        { path: outputPath, format: 'ods' },
        {},
        makeContext(dir),
      );
      const buf = await readFile(outputPath);
      const fflate = await import('fflate');
      const entries = fflate.unzipSync(new Uint8Array(buf));
      expect(Object.keys(entries)).toContain('mimetype');
      expect(Object.keys(entries)).toContain('content.xml');
      expect(Object.keys(entries)).toContain('META-INF/manifest.xml');
      expect(Object.keys(entries)).toContain('styles.xml');
      expect(Buffer.from(entries.mimetype ?? []).toString('utf8')).toBe(
        'application/vnd.oasis.opendocument.spreadsheet',
      );
      const contentXml = Buffer.from(entries['content.xml'] ?? []).toString('utf8');
      expect(contentXml).toContain('<office:spreadsheet>');
      expect(contentXml).toContain('<table:table');
    });

    it('round-trips cell values through the spreadsheet reader', async () => {
      const outputPath = join(dir, 'out.ods');
      await spreadsheetWriteConverter.convert(
        makeInput(join(dir, 'in.csv'), 'csv', 'a,b\n1,2\n3,4\n'),
        { path: outputPath, format: 'ods' },
        {},
        makeContext(dir),
      );

      const csvOutPath = join(dir, 'back.csv');
      await spreadsheetReadConverter.convert(
        makeInput(outputPath, 'ods', await readFile(outputPath)),
        { path: csvOutPath, format: 'csv' },
        {},
        makeContext(dir),
      );
      const csvBack = await readFile(csvOutPath, 'utf8');
      expect(csvBack.trim().replace(/\r\n/g, '\n')).toBe('a,b\n1,2\n3,4');
    });

    it('escapes XML-special characters in cell values without corrupting them', async () => {
      const outputPath = join(dir, 'out.ods');
      await spreadsheetWriteConverter.convert(
        makeInput(join(dir, 'in.csv'), 'csv', 'a\n<tag> & "quoted"\n'),
        { path: outputPath, format: 'ods' },
        {},
        makeContext(dir),
      );

      const jsonOutPath = join(dir, 'back.json');
      await spreadsheetReadConverter.convert(
        makeInput(outputPath, 'ods', await readFile(outputPath)),
        { path: jsonOutPath, format: 'json' },
        {},
        makeContext(dir),
      );
      const parsed = JSON.parse(await readFile(jsonOutPath, 'utf8'));
      expect(parsed).toEqual([{ a: '<tag> & "quoted"' }]);
    });
  });
});
