import { describe, expect, it } from 'vitest';
import { parseSbv, serializeSbv } from './sbv';

const SAMPLE_SBV = `0:00:01.000,0:00:04.000
Hello there.

0:00:05.200,0:00:07.800
Multi-line
subtitle text.
`;

describe('SBV parsing', () => {
  it('matches the comma-separated start,end shape with no --> and no header', () => {
    expect(SAMPLE_SBV.startsWith('WEBVTT')).toBe(false);
    const timingLine = SAMPLE_SBV.split('\n')[0] ?? '';
    expect(/^\d+:\d{2}:\d{2}\.\d{3},\d+:\d{2}:\d{2}\.\d{3}$/.test(timingLine)).toBe(true);
  });

  it('parses cues with correct timings and text', () => {
    const cues = parseSbv(SAMPLE_SBV);
    expect(cues).toEqual([
      { start: 1000, end: 4000, text: 'Hello there.' },
      { start: 5200, end: 7800, text: 'Multi-line\nsubtitle text.' },
    ]);
  });
});

describe('SBV serialization', () => {
  it('emits comma-separated timings with no arrow and no header', () => {
    const out = serializeSbv([{ start: 1000, end: 4000, text: 'Hi' }]);
    expect(out).toBe('0:00:01.000,0:00:04.000\nHi\n');
    expect(out).not.toContain('-->');
    expect(out).not.toContain('WEBVTT');
  });

  it('round-trips cues through parse(serialize(cues))', () => {
    const cues = parseSbv(SAMPLE_SBV);
    const reparsed = parseSbv(serializeSbv(cues));
    expect(reparsed).toEqual(cues);
  });
});
