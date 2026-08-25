import { describe, expect, it } from 'vitest';
import {
  formatAssTimestamp,
  formatDotTimestamp,
  formatSbvTimestamp,
  formatSrtTimestamp,
  parseAssTimestamp,
  parseTimestamp,
} from './cue';

describe('timestamp parsing', () => {
  it('parses SRT-style comma timestamps', () => {
    expect(parseTimestamp('00:00:01,000')).toBe(1000);
    expect(parseTimestamp('01:02:03,456')).toBe(3_723_456);
  });

  it('parses VTT-style dot timestamps', () => {
    expect(parseTimestamp('00:00:04.000')).toBe(4000);
  });

  it('parses ASS centisecond timestamps', () => {
    expect(parseAssTimestamp('0:00:01.50')).toBe(1500);
    expect(parseAssTimestamp('1:02:03.04')).toBe(3_723_040);
  });
});

describe('timestamp formatting', () => {
  it('formats SRT timestamps with comma milliseconds, zero-padded hour', () => {
    expect(formatSrtTimestamp(1000)).toBe('00:00:01,000');
    expect(formatSrtTimestamp(3_723_456)).toBe('01:02:03,456');
  });

  it('formats dot timestamps for VTT/TTML', () => {
    expect(formatDotTimestamp(4000)).toBe('00:00:04.000');
  });

  it('formats SBV timestamps with an unpadded hour', () => {
    expect(formatSbvTimestamp(4000)).toBe('0:00:04.000');
    expect(formatSbvTimestamp(3_723_456)).toBe('1:02:03.456');
  });

  it('formats ASS timestamps in centiseconds with an unpadded hour', () => {
    expect(formatAssTimestamp(1500)).toBe('0:00:01.50');
    expect(formatAssTimestamp(3_723_040)).toBe('1:02:03.04');
  });
});
