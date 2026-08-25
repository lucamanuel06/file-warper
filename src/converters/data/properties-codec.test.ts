import type { ConversionError } from '@core/types';
import { describe, expect, it } from 'vitest';
import { parseProperties, stringifyProperties } from './properties-codec';

describe('properties codec', () => {
  it('parses key=value and key: value forms', () => {
    const text = ['db.host=localhost', 'db.port: 5432', 'debug = true'].join('\n');
    expect(parseProperties(text)).toEqual({
      'db.host': 'localhost',
      'db.port': '5432',
      debug: 'true',
    });
  });

  it('ignores # and ! comments and blank lines', () => {
    const text = ['# a comment', '! also a comment', '', 'key=value'].join('\n');
    expect(parseProperties(text)).toEqual({ key: 'value' });
  });

  it('flattens a nested object with dot-joined keys', () => {
    const text = stringifyProperties({
      db: { host: 'localhost', port: 5432 },
      debug: true,
    });
    expect(parseProperties(text)).toEqual({
      'db.host': 'localhost',
      'db.port': '5432',
      debug: 'true',
    });
  });

  it('round-trips a flat map through stringify -> parse', () => {
    const original = { 'app.name': 'File Warper', 'app.version': '1', enabled: 'false' };
    const parsed = parseProperties(stringifyProperties(original));
    expect(parsed).toEqual(original);
  });

  it('escapes and unescapes keys containing = , : and spaces', () => {
    const original = { 'a key: with = specials': 'a value' };
    const text = stringifyProperties(original);
    expect(parseProperties(text)).toEqual(original);
  });

  it('throws E_UNSUPPORTED_FEATURE when serializing a non-object value', () => {
    try {
      stringifyProperties('not an object');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ConversionError).code).toBe('E_UNSUPPORTED_FEATURE');
    }
  });
});
