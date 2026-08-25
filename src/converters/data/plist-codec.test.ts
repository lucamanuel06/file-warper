import type { ConversionError } from '@core/types';
import { describe, expect, it } from 'vitest';
import { parsePlist, stringifyPlist } from './plist-codec';

const SAMPLE = {
  name: 'Ada',
  count: 5,
  ratio: 1.5,
  active: true,
  disabled: false,
  tags: ['a', 'b', 'c'],
  nested: { inner: 'value' },
};

describe('plist codec', () => {
  it('parses a hand-written Apple-shaped plist document', () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>name</key>',
      '  <string>Ada</string>',
      '  <key>count</key>',
      '  <integer>5</integer>',
      '  <key>active</key>',
      '  <true/>',
      '  <key>tags</key>',
      '  <array>',
      '    <string>a</string>',
      '    <string>b</string>',
      '  </array>',
      '</dict>',
      '</plist>',
    ].join('\n');

    expect(parsePlist(xml)).toEqual({
      name: 'Ada',
      count: 5,
      active: true,
      tags: ['a', 'b'],
    });
  });

  it('round-trips dict/array/typed values through stringify -> parse', () => {
    const text = stringifyPlist(SAMPLE);
    expect(text).toContain('<plist version="1.0">');
    expect(parsePlist(text)).toEqual(SAMPLE);
  });

  it('round-trips a top-level array', () => {
    const value = [{ a: 1 }, { a: 2 }];
    expect(parsePlist(stringifyPlist(value))).toEqual(value);
  });

  it('escapes special XML characters in strings and keys', () => {
    const value = { 'a & b': '<tag> & "quotes"' };
    const text = stringifyPlist(value);
    expect(text).toContain('&amp;');
    expect(parsePlist(text)).toEqual(value);
  });

  it('represents null/undefined as an empty string (documented limitation)', () => {
    const text = stringifyPlist({ maybe: null });
    expect(parsePlist(text)).toEqual({ maybe: '' });
  });

  it('throws E_CORRUPT_INPUT when the <plist> root element is missing', () => {
    try {
      parsePlist('<not-a-plist/>');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ConversionError).code).toBe('E_CORRUPT_INPUT');
    }
  });

  it('throws E_UNSUPPORTED_FEATURE for a value plist cannot represent', () => {
    try {
      stringifyPlist(() => {});
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ConversionError).code).toBe('E_UNSUPPORTED_FEATURE');
    }
  });
});
