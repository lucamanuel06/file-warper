import path from 'node:path';
import type { ConverterOptions } from '@core/types';
import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';
import { tabularDataConverter } from './tabular';
import { makeCtx, makeInput, readOutput, withScratchDir } from './test-support';

async function convertText(
  text: string,
  from: string,
  to: string,
  options: ConverterOptions = {},
): Promise<string> {
  return withScratchDir(async (dir) => {
    const input = makeInput(text, from, dir);
    const outputPath = path.join(dir, `out.${to}`);
    await tabularDataConverter.convert(
      input,
      { path: outputPath, format: to },
      options,
      makeCtx(),
    );
    return readOutput(outputPath);
  });
}

describe('data:tabular converter shape', () => {
  it('declares availability true', async () => {
    expect(await tabularDataConverter.availability()).toEqual({ available: true });
  });

  it('has an options schema exposing the flatten toggle', () => {
    expect(tabularDataConverter.optionsSchema).toEqual({
      fields: [
        { key: 'flatten', kind: 'toggle', label: 'Flatten nested keys', default: false },
      ],
    });
  });

  it('only supports pairs touching csv or tsv', () => {
    expect(tabularDataConverter.supports?.('csv', 'json')).toBe(true);
    expect(tabularDataConverter.supports?.('json', 'tsv')).toBe(true);
    expect(tabularDataConverter.supports?.('json', 'yaml')).toBe(false);
  });
});

describe('csv <-> json', () => {
  const csv = 'name,age\nAda,30\nGrace,85\n';

  it('converts csv -> json as an array of row objects keyed by the header', async () => {
    const text = await convertText(csv, 'csv', 'json');
    expect(JSON.parse(text)).toEqual([
      { name: 'Ada', age: 30 },
      { name: 'Grace', age: 85 },
    ]);
  });

  it('converts json -> csv for a flat array of flat objects, parseable by Papa.parse', async () => {
    const rows = [
      { name: 'Ada', age: 30 },
      { name: 'Grace', age: 85 },
    ];
    const text = await convertText(JSON.stringify(rows), 'json', 'csv');
    const parsed = Papa.parse<{ name: string; age: string }>(text, { header: true });
    expect(parsed.data).toEqual([
      { name: 'Ada', age: '30' },
      { name: 'Grace', age: '85' },
    ]);
  });

  it('round-trips csv -> json -> csv preserving rows', async () => {
    const jsonText = await convertText(csv, 'csv', 'json');
    const csvText = await convertText(jsonText, 'json', 'csv');
    const parsed = Papa.parse<Record<string, string>>(csvText, { header: true });
    expect(parsed.data).toEqual([
      { name: 'Ada', age: '30' },
      { name: 'Grace', age: '85' },
    ]);
  });
});

describe('csv <-> tsv', () => {
  it('converts csv -> tsv using a tab delimiter', async () => {
    const text = await convertText('a,b\n1,2\n', 'csv', 'tsv');
    expect(text).toContain('\t');
    const parsed = Papa.parse<Record<string, string>>(text, {
      header: true,
      delimiter: '\t',
    });
    expect(parsed.data).toEqual([{ a: '1', b: '2' }]);
  });
});

describe('flatten option', () => {
  const nested = JSON.stringify([{ a: 1, b: { c: 2 } }]);

  it('refuses to flatten nested data by default with the documented message', async () => {
    await expect(convertText(nested, 'json', 'csv')).rejects.toMatchObject({
      code: 'E_UNSUPPORTED_FEATURE',
      userMessage: expect.stringContaining('Flatten nested keys'),
    });
  });

  it('flattens nested keys with a dot when options.flatten is true', async () => {
    const text = await convertText(nested, 'json', 'csv', { flatten: true });
    const parsed = Papa.parse<Record<string, string>>(text, { header: true });
    expect(parsed.data).toEqual([{ a: '1', 'b.c': '2' }]);
  });

  it('refuses a non-array top-level value the same way', async () => {
    await expect(convertText('{"a":1}', 'json', 'csv')).rejects.toMatchObject({
      code: 'E_UNSUPPORTED_FEATURE',
    });
  });
});

describe('toml wrapping', () => {
  it('wraps rows as {rows: [...]} when the target is toml, and unwraps on the way back', async () => {
    const rows = [{ a: 1 }, { a: 2 }];
    const tomlText = await convertText(JSON.stringify(rows), 'json', 'toml');
    expect(tomlText).toContain('[[rows]]');
    const jsonText = await convertText(tomlText, 'toml', 'json');
    expect(JSON.parse(jsonText)).toEqual(rows);
  });
});
