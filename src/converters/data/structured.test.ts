import path from 'node:path';
import { ConversionError } from '@core/types';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { structuredDataConverter } from './structured';
import { makeCtx, makeInput, readOutput, withScratchDir } from './test-support';

const SAMPLE = { name: 'Ada Lovelace', born: 1815, tags: ['math', 'writing'] };

async function convertText(
  text: string,
  from: string,
  to: string,
): Promise<{ text: string; outputPath: string }> {
  return withScratchDir(async (dir) => {
    const input = makeInput(text, from, dir);
    const outputPath = path.join(dir, `out.${to}`);
    await structuredDataConverter.convert(
      input,
      { path: outputPath, format: to },
      {},
      makeCtx(),
    );
    return { text: await readOutput(outputPath), outputPath };
  });
}

describe('data:structured converter shape', () => {
  it('declares availability true and covers the documented formats', async () => {
    expect(await structuredDataConverter.availability()).toEqual({ available: true });
    for (const f of [
      'json',
      'json5',
      'jsonl',
      'yaml',
      'toml',
      'xml',
      'ini',
      'properties',
      'plist',
    ]) {
      expect(structuredDataConverter.inputs).toContain(f);
      expect(structuredDataConverter.outputs).toContain(f);
    }
  });

  it('gives the expressive cluster full retention and flat formats less', () => {
    const jsonToYaml = structuredDataConverter.cost('json', 'yaml');
    const jsonToIni = structuredDataConverter.cost('json', 'ini');
    expect(jsonToYaml.retention).toBe(1);
    expect(jsonToIni.retention).toBeLessThan(jsonToYaml.retention);
  });
});

describe('json <-> yaml', () => {
  it('converts json -> yaml producing text yaml.parse accepts, matching the source', async () => {
    const { text } = await convertText(JSON.stringify(SAMPLE), 'json', 'yaml');
    expect(parseYaml(text)).toEqual(SAMPLE);
  });

  it('round-trips json -> yaml -> json deep-equal', async () => {
    const { text: yamlText } = await convertText(JSON.stringify(SAMPLE), 'json', 'yaml');
    const { text: jsonText } = await convertText(yamlText, 'yaml', 'json');
    expect(JSON.parse(jsonText)).toEqual(SAMPLE);
  });
});

describe('json <-> toml', () => {
  it('converts json -> toml producing text smol-toml accepts, matching the source', async () => {
    const { text } = await convertText(JSON.stringify(SAMPLE), 'json', 'toml');
    expect(parseToml(text)).toEqual(SAMPLE);
  });

  it('round-trips json -> toml -> json deep-equal', async () => {
    const { text: tomlText } = await convertText(JSON.stringify(SAMPLE), 'json', 'toml');
    const { text: jsonText } = await convertText(tomlText, 'toml', 'json');
    expect(JSON.parse(jsonText)).toEqual(SAMPLE);
  });

  it('rejects a jsonl (array) source going to toml with a plain-sentence error', async () => {
    await expect(
      convertText('{"a":1}\n{"a":2}\n', 'jsonl', 'toml'),
    ).rejects.toMatchObject({
      code: 'E_UNSUPPORTED_FEATURE',
    });
  });
});

describe('json5 and jsonl', () => {
  it('converts json5 -> json, resolving comments/trailing commas', async () => {
    const json5Text = '{ name: "Ada", tags: [1, 2,], }';
    const { text } = await convertText(json5Text, 'json5', 'json');
    expect(JSON.parse(text)).toEqual({ name: 'Ada', tags: [1, 2] });
  });

  it('converts jsonl -> json as an array of the parsed lines', async () => {
    const { text } = await convertText('{"a":1}\n{"a":2}\n', 'jsonl', 'json');
    expect(JSON.parse(text)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('converts json -> jsonl one value per line', async () => {
    const { text } = await convertText(
      JSON.stringify([{ a: 1 }, { a: 2 }]),
      'json',
      'jsonl',
    );
    expect(
      text
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l)),
    ).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe('xml', () => {
  it('converts json -> xml -> json round trip', async () => {
    const { text: xmlText } = await convertText(JSON.stringify(SAMPLE), 'json', 'xml');
    const { text: jsonText } = await convertText(xmlText, 'xml', 'json');
    expect(JSON.parse(jsonText)).toEqual(SAMPLE);
  });
});

describe('plist', () => {
  it('converts json -> plist -> json round trip for plist-representable data', async () => {
    const value = { name: 'Ada', count: 5, active: true, tags: ['a', 'b'] };
    const { text: plistText } = await convertText(JSON.stringify(value), 'json', 'plist');
    expect(plistText).toContain('<plist version="1.0">');
    const { text: jsonText } = await convertText(plistText, 'plist', 'json');
    expect(JSON.parse(jsonText)).toEqual(value);
  });
});

describe('ini and properties', () => {
  it('converts json -> ini, flattening one level into a [section]', async () => {
    const { text } = await convertText(
      JSON.stringify({ debug: true, server: { host: 'localhost' } }),
      'json',
      'ini',
    );
    expect(text).toContain('[server]');
    expect(text).toContain('host = localhost');
  });

  it('converts ini -> json as strings (no type system in INI)', async () => {
    const { text } = await convertText('port = 8080\n', 'ini', 'json');
    expect(JSON.parse(text)).toEqual({ port: '8080' });
  });

  it('converts json -> properties as flattened dotted keys', async () => {
    const { text } = await convertText(
      JSON.stringify({ app: { name: 'File Warper', version: 1 } }),
      'json',
      'properties',
    );
    expect(text).toContain('app.name=File Warper');
    expect(text).toContain('app.version=1');
  });
});

describe('errors', () => {
  it('throws E_CORRUPT_INPUT with a plain-sentence userMessage for invalid JSON', async () => {
    await expect(convertText('{not valid json', 'json', 'yaml')).rejects.toMatchObject({
      code: 'E_CORRUPT_INPUT',
    });
    try {
      await convertText('{not valid json', 'json', 'yaml');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConversionError);
      expect((err as ConversionError).userMessage).not.toMatch(
        /SyntaxError|Unexpected token/i,
      );
    }
  });
});
