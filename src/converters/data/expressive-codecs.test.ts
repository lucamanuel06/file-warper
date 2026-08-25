import { ConversionError } from '@core/types';
import { XMLParser } from 'fast-xml-parser';
import JSON5 from 'json5';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { parse as rawParseYaml } from 'yaml';
import {
  parseToml as codecParseToml,
  parseYaml as codecParseYaml,
  parseJson,
  parseJson5,
  parseJsonl,
  parseXml,
  stringifyJson,
  stringifyJson5,
  stringifyJsonl,
  stringifyToml,
  stringifyXml,
  stringifyYaml,
} from './expressive-codecs';

const SAMPLE = {
  name: 'Ada Lovelace',
  born: 1815,
  active: true,
  tags: ['mathematician', 'writer'],
  address: { city: 'London', zip: null },
};

describe('json codec', () => {
  it('parses valid JSON', () => {
    expect(parseJson('{"a":1,"b":[1,2,3]}')).toEqual({ a: 1, b: [1, 2, 3] });
  });

  it('produces JSON that JSON.parse accepts back, round-tripping deep-equal', () => {
    const text = stringifyJson(SAMPLE);
    expect(JSON.parse(text)).toEqual(SAMPLE);
  });

  it('throws a ConversionError with E_CORRUPT_INPUT on invalid JSON', () => {
    expect(() => parseJson('{not valid')).toThrow(ConversionError);
    try {
      parseJson('{not valid');
    } catch (err) {
      expect((err as ConversionError).code).toBe('E_CORRUPT_INPUT');
      expect((err as ConversionError).userMessage).toMatch(/valid json/i);
    }
  });
});

describe('json5 codec', () => {
  it('parses JSON5 with comments, trailing commas and unquoted keys', () => {
    const text = `{
      // a comment
      name: 'Ada',
      born: 1815,
      tags: [1, 2, 3,],
    }`;
    expect(parseJson5(text)).toEqual({ name: 'Ada', born: 1815, tags: [1, 2, 3] });
  });

  it('round-trips through the real json5 parser, deep-equal', () => {
    const text = stringifyJson5(SAMPLE);
    expect(JSON5.parse(text)).toEqual(SAMPLE);
  });
});

describe('yaml codec', () => {
  it('parses YAML into the expected plain value', () => {
    expect(codecParseYaml('a: 1\nb:\n  - x\n  - y\n')).toEqual({ a: 1, b: ['x', 'y'] });
  });

  it('round-trips json -> yaml -> json deep-equal', () => {
    const yamlText = stringifyYaml(SAMPLE);
    const parsedByRealYaml = rawParseYaml(yamlText);
    expect(parsedByRealYaml).toEqual(SAMPLE);
    // and back through our own codec
    expect(codecParseYaml(stringifyYaml(SAMPLE))).toEqual(SAMPLE);
  });

  it('throws E_CORRUPT_INPUT on unparsable YAML', () => {
    expect(() => codecParseYaml(': : : not yaml : : :\n\t- broken indent')).toThrow(
      ConversionError,
    );
  });
});

describe('toml codec', () => {
  const TOML_SAMPLE = { name: 'Ada', born: 1815, active: true, tags: ['a', 'b'] };

  it('parses TOML into the expected plain value', () => {
    expect(codecParseToml('a = 1\nb = "x"\n')).toEqual({ a: 1, b: 'x' });
  });

  it('round-trips json -> toml -> json deep-equal (object at top level)', () => {
    const tomlText = stringifyToml(TOML_SAMPLE);
    expect(parseToml(tomlText)).toEqual(TOML_SAMPLE);
    expect(codecParseToml(stringifyToml(TOML_SAMPLE))).toEqual(TOML_SAMPLE);
  });

  it('throws E_UNSUPPORTED_FEATURE for a top-level array or primitive', () => {
    expect(() => stringifyToml([1, 2, 3])).toThrow(ConversionError);
    try {
      stringifyToml('just a string');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ConversionError).code).toBe('E_UNSUPPORTED_FEATURE');
    }
  });
});

describe('jsonl codec', () => {
  it('parses non-empty lines as individual JSON values', () => {
    const text = '{"a":1}\n\n{"a":2}\n{"a":3}\n';
    expect(parseJsonl(text)).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('stringifies an array as one JSON value per line', () => {
    const text = stringifyJsonl([{ a: 1 }, { a: 2 }]);
    expect(text.split('\n')).toEqual(['{"a":1}', '{"a":2}']);
    expect(parseJsonl(text)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('throws E_UNSUPPORTED_FEATURE for a non-array value', () => {
    try {
      stringifyJsonl({ a: 1 });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ConversionError).code).toBe('E_UNSUPPORTED_FEATURE');
    }
  });
});

describe('xml codec', () => {
  it('round-trips an object through the wrap/unwrap convention', () => {
    const value = {
      name: 'Ada Lovelace',
      born: 1815,
      active: true,
      tags: ['mathematician', 'writer'],
      address: { city: 'London', zip: 'SW1A 1AA' },
    };
    const xmlText = stringifyXml(value);
    expect(parseXml(xmlText)).toEqual(value);
  });

  it('represents null as an empty string (documented limitation: XML has no null)', () => {
    expect(parseXml(stringifyXml({ zip: null }))).toEqual({ zip: '' });
  });

  it('round-trips a top-level array', () => {
    const value = [1, 2, 3];
    expect(parseXml(stringifyXml(value))).toEqual(value);
  });

  it('round-trips a top-level primitive', () => {
    expect(parseXml(stringifyXml('hello'))).toBe('hello');
    expect(parseXml(stringifyXml(42))).toBe(42);
  });

  it('produces well-formed XML a real parser accepts, with values escaped', () => {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const text = stringifyXml({ note: 'A & B <are> friends' });
    expect(text).toContain('&amp;');
    expect(() => parser.parse(text)).not.toThrow();
  });

  it('reads arbitrary real-world XML (not produced by us) into its children', () => {
    const xml = '<config><setting>1</setting><name>demo</name></config>';
    expect(parseXml(xml)).toEqual({ setting: 1, name: 'demo' });
  });

  it('throws E_CORRUPT_INPUT on an empty document with no root element', () => {
    expect(() => parseXml('')).toThrow(ConversionError);
    try {
      parseXml('');
    } catch (err) {
      expect((err as ConversionError).code).toBe('E_CORRUPT_INPUT');
    }
  });
});
