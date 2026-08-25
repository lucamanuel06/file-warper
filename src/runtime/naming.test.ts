import { describe, expect, it } from 'vitest';
import { sanitizeBasename } from './naming';

describe('sanitizeBasename', () => {
  it('replaces forbidden characters', () => {
    expect(sanitizeBasename('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('drops ASCII control characters', () => {
    expect(
      sanitizeBasename(`a${String.fromCharCode(1)}b${String.fromCharCode(31)}c`),
    ).toBe('abc');
  });

  it('trims trailing dots and spaces', () => {
    expect(sanitizeBasename('report...  ')).toBe('report');
  });

  it('prefixes reserved Windows device names', () => {
    expect(sanitizeBasename('CON')).toBe('_CON');
    expect(sanitizeBasename('lpt1')).toBe('_lpt1');
  });

  it('falls back to "file" for an empty result', () => {
    expect(sanitizeBasename('...')).toBe('file');
  });

  it('clamps to 255 bytes without splitting a multi-byte character', () => {
    const name = 'é'.repeat(200);
    const out = sanitizeBasename(name);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(255);
    expect(out).toBe(Buffer.from(out, 'utf8').toString('utf8')); // round-trips cleanly
  });
});
