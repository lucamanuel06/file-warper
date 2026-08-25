import { ConversionError } from '@core/types';
import { describe, expect, it } from 'vitest';
import { assertAllSafe, assertSafeEntryPath } from './safe-path';

describe('assertSafeEntryPath', () => {
  it('accepts a plain relative entry', () => {
    expect(() => assertSafeEntryPath('/dest', 'a/b.txt')).not.toThrow();
  });

  it('accepts a relative entry that traverses but stays inside destDir', () => {
    // resolves to /dest/b.txt — still inside destDir, so this is legitimate.
    expect(() => assertSafeEntryPath('/dest', 'a/../b.txt')).not.toThrow();
  });

  it('rejects an entry that escapes destDir with ../', () => {
    expect(() => assertSafeEntryPath('/dest', '../evil.txt')).toThrow(ConversionError);
    expect(() => assertSafeEntryPath('/dest', '../../evil.txt')).toThrow(ConversionError);
  });

  it('rejects an absolute path entry that points elsewhere', () => {
    expect(() => assertSafeEntryPath('/dest', '/etc/passwd')).toThrow(ConversionError);
  });

  it('throws with code E_CORRUPT_INPUT and a plain-English userMessage', () => {
    try {
      assertSafeEntryPath('/dest', '../evil.txt');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConversionError);
      const ce = err as ConversionError;
      expect(ce.code).toBe('E_CORRUPT_INPUT');
      expect(ce.userMessage).toMatch(/unsafe file path/i);
    }
  });

  it('assertAllSafe throws on the first unsafe name among many safe ones', () => {
    expect(() => assertAllSafe('/dest', ['a.txt', 'dir/b.txt', '../evil.txt'])).toThrow(
      ConversionError,
    );
  });

  it('assertAllSafe does not throw when every name is safe', () => {
    expect(() =>
      assertAllSafe('/dest', ['a.txt', 'dir/b.txt', 'dir/sub/c.txt']),
    ).not.toThrow();
  });
});
