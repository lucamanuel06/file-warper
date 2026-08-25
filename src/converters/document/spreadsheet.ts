/**
 * Spreadsheet model shared by both directions of the spreadsheet hop:
 *
 *   read:  xlsx / xls / ods -> csv / tsv / json / html   (`@e965/xlsx`)
 *   write: csv / tsv / json / html -> xlsx / ods         (`exceljs`, hand-rolled ODS)
 *
 * Both directions funnel through `SpreadsheetData` so the shape of "a
 * spreadsheet" stays identical no matter which library produced or consumes
 * it. Every cell is a plain string — this is a lossy, text-only model by
 * design (no formulas, no styles, no cell types); see the cost() functions
 * below for what that costs each pair.
 *
 * `@e965/xlsx` (SheetJS Community Edition) reads ODS but does not write it,
 * so `-> ods` is hand-rolled ZIP+XML, the same pattern already used for
 * odt/odp/pptx/epub parsing elsewhere in this directory: a `mimetype` entry
 * (stored, uncompressed, per the ODF convention), a manifest, and a
 * `content.xml` in the OpenDocument spreadsheet schema. Round-tripped
 * against this file's own `spreadsheetReadConverter` in tests.
 */

import { writeFile } from 'node:fs/promises';
import type {
  ConversionInput,
  ConversionOutput,
  ConvertContext,
  Converter,
  ConverterOptions,
  ConvertResult,
  EdgeCost,
  FormatId,
} from '@core/types';
import { ConversionError } from '@core/types';
import { read as readWorkbookBuffer, utils as xlsxUtils } from '@e965/xlsx';
import { Workbook } from 'exceljs';
import { zipSync } from 'fflate';
import Papa from 'papaparse';
import { parseHtml } from './dom';

export interface SpreadsheetSheet {
  readonly name: string;
  readonly rows: readonly (readonly string[])[];
}

export interface SpreadsheetData {
  readonly sheets: readonly SpreadsheetSheet[];
}

const READ_SOURCE_FORMATS: readonly FormatId[] = ['xlsx', 'xls', 'ods'];
const READ_TARGET_FORMATS: readonly FormatId[] = ['csv', 'tsv', 'json', 'html'];
const WRITE_SOURCE_FORMATS: readonly FormatId[] = ['csv', 'tsv', 'json', 'html'];

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

// ---------------------------------------------------------------------------
// Read side: xlsx / xls / ods -> SpreadsheetData
// ---------------------------------------------------------------------------

function parseWorkbookBuffer(buffer: Buffer, inputPath: string): SpreadsheetData {
  let workbook: ReturnType<typeof readWorkbookBuffer>;
  try {
    workbook = readWorkbookBuffer(buffer, { type: 'buffer' });
  } catch (cause) {
    throw new ConversionError({
      code: 'E_CORRUPT_INPUT',
      userMessage: `"${inputPath}" could not be read as a spreadsheet.`,
      detail: cause instanceof Error ? cause.message : String(cause),
      retryable: false,
      cause,
    });
  }

  if (workbook.SheetNames.length === 0) {
    throw new ConversionError({
      code: 'E_CORRUPT_INPUT',
      userMessage: `"${inputPath}" does not contain any sheets.`,
      retryable: false,
    });
  }

  const sheets: SpreadsheetSheet[] = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const rawRows = sheet
      ? (xlsxUtils.sheet_to_json(sheet, {
          header: 1,
          raw: false,
          defval: '',
        }) as unknown[][])
      : [];
    const rows = rawRows.map((row) => row.map(cellToString));
    return { name, rows };
  });

  return { sheets };
}

/** csv/tsv only have one grid — pick the first sheet and warn about the rest. */
function firstSheetWithWarning(data: SpreadsheetData): {
  readonly sheet: SpreadsheetSheet;
  readonly warnings: string[];
} {
  const [sheet, ...rest] = data.sheets;
  if (!sheet) {
    return { sheet: { name: 'Sheet1', rows: [] }, warnings: [] };
  }
  const warnings: string[] = [];
  if (rest.length > 0) {
    warnings.push(
      `Only the first sheet ("${sheet.name}") was converted; ${rest.length} other sheet(s) were dropped.`,
    );
  }
  return { sheet, warnings };
}

function renderDelimited(sheet: SpreadsheetSheet, delimiter: string): string {
  return Papa.unparse(sheet.rows as string[][], { delimiter });
}

/** First row becomes object keys; remaining rows become one object each. */
function renderJson(sheet: SpreadsheetSheet): string {
  const [header, ...dataRows] = sheet.rows;
  if (!header) {
    return JSON.stringify([], null, 2);
  }
  const objects = dataRows.map((row) => {
    const obj: Record<string, string> = {};
    header.forEach((key, i) => {
      obj[key || `col${i + 1}`] = row[i] ?? '';
    });
    return obj;
  });
  return JSON.stringify(objects, null, 2);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Every sheet is rendered — no data loss for the html target. */
function renderHtml(data: SpreadsheetData): string {
  const sections = data.sheets.map((sheet) => {
    const rowsHtml = sheet.rows
      .map(
        (row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`,
      )
      .join('\n');
    return `<h2>${escapeHtml(sheet.name)}</h2>\n<table>\n${rowsHtml}\n</table>`;
  });
  return `<!doctype html>\n<html><head><meta charset="utf-8"></head><body>\n${sections.join('\n')}\n</body></html>\n`;
}

// ---------------------------------------------------------------------------
// Write side: csv / tsv / json / html -> SpreadsheetData -> xlsx
// ---------------------------------------------------------------------------

function parseDelimited(text: string, delimiter: string): SpreadsheetSheet {
  const result = Papa.parse<string[]>(text, { delimiter, skipEmptyLines: false });
  const rows = result.data
    .filter((row) => !(row.length === 1 && row[0] === ''))
    .map((row) => row.map(cellToString));
  return { name: 'Sheet1', rows };
}

function parseJsonSpreadsheet(text: string): SpreadsheetSheet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ConversionError({
      code: 'E_CORRUPT_INPUT',
      userMessage: 'This JSON file is not valid JSON.',
      detail: cause instanceof Error ? cause.message : String(cause),
      retryable: false,
      cause,
    });
  }

  if (!Array.isArray(parsed)) {
    throw new ConversionError({
      code: 'E_UNSUPPORTED_FEATURE',
      userMessage: 'This JSON file must contain an array of rows or an array of objects.',
      retryable: false,
    });
  }
  if (parsed.length === 0) {
    return { name: 'Sheet1', rows: [] };
  }

  if (Array.isArray(parsed[0])) {
    // Array of arrays: rows, verbatim.
    const rows = (parsed as unknown[][]).map((row) => row.map(cellToString));
    return { name: 'Sheet1', rows };
  }

  // Array of flat objects: derive a header row from the union of keys, in
  // first-seen order, then one data row per object.
  const header: string[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new ConversionError({
        code: 'E_UNSUPPORTED_FEATURE',
        userMessage:
          'This JSON file must contain an array of rows or an array of objects.',
        retryable: false,
      });
    }
    for (const key of Object.keys(item as Record<string, unknown>)) {
      if (!seen.has(key)) {
        seen.add(key);
        header.push(key);
      }
    }
  }
  const rows: string[][] = [
    header,
    ...(parsed as Record<string, unknown>[]).map((obj) =>
      header.map((key) => cellToString(obj[key])),
    ),
  ];
  return { name: 'Sheet1', rows };
}

function parseHtmlSpreadsheet(html: string, inputPath: string): SpreadsheetSheet {
  const document = parseHtml(html);
  const table = document.querySelector('table');
  if (!table) {
    throw new ConversionError({
      code: 'E_CORRUPT_INPUT',
      userMessage: `No table was found in "${inputPath}".`,
      retryable: false,
    });
  }
  const rows = [...table.querySelectorAll('tr')].map((tr) =>
    [...tr.querySelectorAll('th,td')].map((cell) => (cell.textContent ?? '').trim()),
  );
  return { name: 'Sheet1', rows };
}

async function writeXlsxFile(data: SpreadsheetData, outputPath: string): Promise<void> {
  const workbook = new Workbook();
  for (const sheet of data.sheets) {
    const worksheet = workbook.addWorksheet(sheet.name);
    if (sheet.rows.length > 0) {
      worksheet.addRows(sheet.rows.map((row) => [...row]));
    }
  }
  await workbook.xlsx.writeFile(outputPath);
}

const ODS_MIME = 'application/vnd.oasis.opendocument.spreadsheet';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildOdsContentXml(data: SpreadsheetData): string {
  const tables = data.sheets
    .map((sheet) => {
      const rows = sheet.rows
        .map((row) => {
          const cells = row
            .map(
              (cell) =>
                `<table:table-cell office:value-type="string"><text:p>${escapeXml(cell)}</text:p></table:table-cell>`,
            )
            .join('');
          return `<table:table-row>${cells}</table:table-row>`;
        })
        .join('');
      return `<table:table table:name="${escapeXml(sheet.name)}">${rows}</table:table>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<office:document-content ' +
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
    'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
    'office:version="1.2">' +
    `<office:body><office:spreadsheet>${tables}</office:spreadsheet></office:body>` +
    '</office:document-content>'
  );
}

function buildOdsManifestXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<manifest:manifest ' +
    'xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" ' +
    'manifest:version="1.2">' +
    `<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="${ODS_MIME}"/>` +
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
    '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>' +
    '</manifest:manifest>'
  );
}

/**
 * No custom styles to declare — but `styles.xml` isn't truly optional in
 * practice: `@e965/xlsx`'s ODS reader (and other real-world readers) expect
 * the entry to exist even when it's empty.
 */
function buildOdsStylesXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<office:document-styles ' +
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
    'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
    'office:version="1.2">' +
    '<office:styles/>' +
    '</office:document-styles>'
  );
}

async function writeOdsFile(data: SpreadsheetData, outputPath: string): Promise<void> {
  const encoder = new TextEncoder();
  const zipped = zipSync({
    // Stored, not deflated, and the first entry — the ODF-convention way to
    // let readers sniff the container's exact type from its first bytes.
    mimetype: [encoder.encode(ODS_MIME), { level: 0 }],
    'META-INF/manifest.xml': encoder.encode(buildOdsManifestXml()),
    'content.xml': encoder.encode(buildOdsContentXml(data)),
    'styles.xml': encoder.encode(buildOdsStylesXml()),
  });
  await writeFile(outputPath, zipped);
}

// ---------------------------------------------------------------------------
// Cost functions
// ---------------------------------------------------------------------------

function readCost(_from: FormatId, to: FormatId): EdgeCost {
  if (to === 'html') {
    // Every sheet is preserved as its own table — no sheet gets dropped.
    return { retention: 0.9, effort: 2, structure: 0.85 };
  }
  // csv/tsv/json: single sheet only, and formulas/formatting are gone.
  return { retention: 0.6, effort: 2, structure: 0.3 };
}

function writeCost(): EdgeCost {
  // The literal cell text is captured faithfully; there was nothing more
  // (no formulas/styles) in the source formats to begin with.
  return { retention: 1.0, effort: 2, structure: 0.8 };
}

// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------

export const spreadsheetReadConverter: Converter = {
  id: 'doc:spreadsheet-read',
  name: 'Spreadsheet Reader',
  engine: 'pure-js',
  residency: 'worker',

  inputs: READ_SOURCE_FORMATS,
  outputs: READ_TARGET_FORMATS,

  cost(from: FormatId, to: FormatId): EdgeCost {
    return readCost(from, to);
  },

  async availability() {
    return { available: true };
  },

  async convert(
    input: ConversionInput,
    output: ConversionOutput,
    _options: ConverterOptions,
    ctx: ConvertContext,
  ): Promise<ConvertResult> {
    if (ctx.signal.aborted) {
      throw new ConversionError({
        code: 'E_CANCELLED',
        userMessage: 'The conversion was cancelled.',
        retryable: false,
      });
    }

    ctx.onProgress({ ratio: 0, message: 'Reading spreadsheet' });

    let buffer: Buffer;
    try {
      buffer = await input.readBuffer();
    } catch (cause) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage: `Could not read "${input.path}".`,
        detail: cause instanceof Error ? cause.message : String(cause),
        retryable: false,
        cause,
      });
    }

    const data = parseWorkbookBuffer(buffer, input.path);

    ctx.onProgress({ ratio: 0.6, message: 'Converting' });

    let text: string;
    let warnings: string[] = [];

    switch (output.format) {
      case 'csv': {
        const { sheet, warnings: w } = firstSheetWithWarning(data);
        text = renderDelimited(sheet, ',');
        warnings = w;
        break;
      }
      case 'tsv': {
        const { sheet, warnings: w } = firstSheetWithWarning(data);
        text = renderDelimited(sheet, '\t');
        warnings = w;
        break;
      }
      case 'json': {
        const { sheet, warnings: w } = firstSheetWithWarning(data);
        text = renderJson(sheet);
        warnings = w;
        break;
      }
      case 'html':
        text = renderHtml(data);
        break;
      default:
        throw new ConversionError({
          code: 'E_UNSUPPORTED_FEATURE',
          userMessage: `"${output.format}" is not a spreadsheet export format this converter supports.`,
          retryable: false,
        });
    }

    try {
      await writeFile(output.path, text, 'utf8');
    } catch (cause) {
      throw new ConversionError({
        code: 'E_PERMISSION',
        userMessage: `Could not write the converted file to "${output.path}".`,
        detail: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
        cause,
      });
    }

    ctx.onProgress({ ratio: 1, message: 'Done' });

    return {
      bytes: Buffer.byteLength(text, 'utf8'),
      warnings: warnings.length > 0 ? warnings : undefined,
      meta: { sheetCount: data.sheets.length },
    };
  },
};

export const spreadsheetWriteConverter: Converter = {
  id: 'doc:spreadsheet-write',
  name: 'Spreadsheet Writer',
  engine: 'pure-js',
  residency: 'worker',

  inputs: WRITE_SOURCE_FORMATS,
  outputs: ['xlsx', 'ods'],

  cost(): EdgeCost {
    return writeCost();
  },

  async availability() {
    return { available: true };
  },

  async convert(
    input: ConversionInput,
    output: ConversionOutput,
    _options: ConverterOptions,
    ctx: ConvertContext,
  ): Promise<ConvertResult> {
    if (ctx.signal.aborted) {
      throw new ConversionError({
        code: 'E_CANCELLED',
        userMessage: 'The conversion was cancelled.',
        retryable: false,
      });
    }

    ctx.onProgress({ ratio: 0, message: 'Reading input' });

    let text: string;
    try {
      text = (await input.readBuffer()).toString('utf8');
    } catch (cause) {
      throw new ConversionError({
        code: 'E_CORRUPT_INPUT',
        userMessage: `Could not read "${input.path}".`,
        detail: cause instanceof Error ? cause.message : String(cause),
        retryable: false,
        cause,
      });
    }

    ctx.onProgress({ ratio: 0.4, message: 'Parsing' });

    let sheet: SpreadsheetSheet;
    switch (input.format) {
      case 'csv':
        sheet = parseDelimited(text, ',');
        break;
      case 'tsv':
        sheet = parseDelimited(text, '\t');
        break;
      case 'json':
        sheet = parseJsonSpreadsheet(text);
        break;
      case 'html':
        sheet = parseHtmlSpreadsheet(text, input.path);
        break;
      default:
        throw new ConversionError({
          code: 'E_UNSUPPORTED_FEATURE',
          userMessage: `"${input.format}" is not a format this converter can read.`,
          retryable: false,
        });
    }

    const data: SpreadsheetData = { sheets: [sheet] };

    ctx.onProgress({ ratio: 0.7, message: 'Writing workbook' });

    try {
      if (output.format === 'ods') {
        await writeOdsFile(data, output.path);
      } else {
        await writeXlsxFile(data, output.path);
      }
    } catch (cause) {
      if (cause instanceof ConversionError) throw cause;
      throw new ConversionError({
        code: 'E_ENGINE',
        userMessage: `The ${output.format === 'ods' ? 'OpenDocument spreadsheet' : 'Excel workbook'} could not be written.`,
        detail: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
        cause,
      });
    }

    ctx.onProgress({ ratio: 1, message: 'Done' });

    return { meta: { rowCount: sheet.rows.length } };
  },
};

export const spreadsheetConverters: readonly Converter[] = [
  spreadsheetReadConverter,
  spreadsheetWriteConverter,
];
