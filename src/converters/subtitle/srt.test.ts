import { describe, expect, it } from 'vitest';
import { parseSrt, serializeSrt } from './srt';

const SAMPLE_SRT = `1
00:00:01,000 --> 00:00:04,000
Hello there.

2
00:00:05,200 --> 00:00:07,800
Multi-line
subtitle text.
`;

describe('SRT parsing', () => {
  it('matches the NN / timestamp --> timestamp / text / blank shape', () => {
    const blockPattern =
      /^\d+\r?\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\r?\n(.+\r?\n?)+$/;
    const blocks = SAMPLE_SRT.trim().split(/\n{2,}/);
    for (const block of blocks) {
      expect(blockPattern.test(block)).toBe(true);
    }
  });

  it('parses cues with correct timings and text', () => {
    const cues = parseSrt(SAMPLE_SRT);
    expect(cues).toEqual([
      { start: 1000, end: 4000, text: 'Hello there.' },
      { start: 5200, end: 7800, text: 'Multi-line\nsubtitle text.' },
    ]);
  });

  it('tolerates a missing index line', () => {
    const cues = parseSrt('00:00:01,000 --> 00:00:02,000\nNo index.\n');
    expect(cues).toEqual([{ start: 1000, end: 2000, text: 'No index.' }]);
  });
});

describe('SRT serialization', () => {
  it('round-trips cues through parse(serialize(cues))', () => {
    const cues = parseSrt(SAMPLE_SRT);
    const reparsed = parseSrt(serializeSrt(cues));
    expect(reparsed).toEqual(cues);
  });

  it('produces the numbered index / arrow-timing shape', () => {
    const out = serializeSrt([{ start: 1000, end: 4000, text: 'Hi' }]);
    expect(out).toMatch(/^1\n00:00:01,000 --> 00:00:04,000\nHi\n$/);
  });
});
