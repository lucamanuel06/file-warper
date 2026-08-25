import type { ConversionError } from '@core/types';
import { describe, expect, it } from 'vitest';
import { parseIni, stringifyIni } from './ini-codec';

describe('ini codec', () => {
  it('parses top-level keys and one level of [section] nesting', () => {
    const text = [
      '; a comment',
      'debug = true',
      '',
      '[server]',
      'host = localhost',
      'port = 8080',
      '',
      '; a section name can itself contain a dot — it is a literal name, not further nesting',
      '[server.tls]',
      'enabled = false',
    ].join('\n');

    expect(parseIni(text)).toEqual({
      debug: 'true',
      server: { host: 'localhost', port: '8080' },
      'server.tls': { enabled: 'false' },
    });
  });

  it('strips matching quotes from values', () => {
    expect(parseIni('key = "hello world"')).toEqual({ key: 'hello world' });
    expect(parseIni("key = 'hello world'")).toEqual({ key: 'hello world' });
  });

  it('ignores comments and blank lines', () => {
    expect(parseIni('# comment\n\n; also a comment\nkey=value\n')).toEqual({
      key: 'value',
    });
  });

  it('serializes a one-level-nested object into [section] blocks', () => {
    const text = stringifyIni({ debug: true, server: { host: 'localhost', port: 8080 } });
    expect(parseIni(text)).toEqual({
      debug: 'true',
      server: { host: 'localhost', port: '8080' },
    });
  });

  it('flattens nesting deeper than one level with dot-joined keys', () => {
    const text = stringifyIni({ a: { b: { c: 1 } } });
    expect(parseIni(text)).toEqual({ a: { 'b.c': '1' } });
  });

  it('throws E_UNSUPPORTED_FEATURE when serializing a non-object value', () => {
    try {
      stringifyIni([1, 2, 3]);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ConversionError).code).toBe('E_UNSUPPORTED_FEATURE');
    }
  });
});
